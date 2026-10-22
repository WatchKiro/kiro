//! Playback commands backed by libmpv (`libmpv` feature, macOS).
//!
//! Lifecycle: `player_attach` creates the player and its video surface and
//! returns a state snapshot; events then stream over the `onEvent` channel.
//! `player_detach` tears everything down. Both are idempotent and serialised,
//! so React StrictMode's mount → unmount → mount ends attached. The renderer
//! (`NativePlayer`) additionally issues them in order.

use std::sync::{Arc, PoisonError, RwLock};
use std::time::Duration;

use tauri::async_runtime::{Mutex, spawn_blocking};
use tauri::ipc::Channel;
use tauri::{Runtime, State, WebviewWindow};

use crate::core::error::{Error, Result};
use crate::core::state::AppState;
use crate::media::model::{MediaTrack, PlayerEvent, PlayerSnapshot};
use crate::media::mpv::{
    DebugStats, EventSink, MpvPlayer, PreviewKind, PreviewResult, debug_log_enabled,
};
use crate::media::{
    ExternalSubtitle, MediaSource, PlaybackBackend, PlaybackError, SubtitleStyle, audio_delay,
    parse_stream_url, parse_track_id, playback_speed, subtitle_delay,
};
use crate::presence::{NowPlaying, Presence, PresenceOptions};

/// How long quitting waits for Discord to clear the activity.
const PRESENCE_QUIT_TIMEOUT: Duration = Duration::from_millis(500);

/// The attached player, if any.
pub struct PlayerState {
    player: RwLock<Option<Arc<MpvPlayer>>>,
    /// Serialises attach and detach.
    lifecycle: Mutex<()>,
    /// Discord Rich Presence, following whichever player is attached.
    presence: Arc<Presence>,
}

impl Default for PlayerState {
    fn default() -> Self {
        Self {
            player: RwLock::default(),
            lifecycle: Mutex::default(),
            presence: Arc::new(Presence::discord()),
        }
    }
}

impl PlayerState {
    /// The attached player. Commands hold their own reference, so a detach
    /// running concurrently cannot free the player underneath them.
    fn get(&self) -> Result<Arc<MpvPlayer>> {
        self.player
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
            .ok_or(Error::Playback(PlaybackError::NotAttached))
    }

    fn set(&self, player: Option<Arc<MpvPlayer>>) -> Option<Arc<MpvPlayer>> {
        std::mem::replace(
            &mut *self.player.write().unwrap_or_else(PoisonError::into_inner),
            player,
        )
    }

    /// Applies Settings → Playback → "Keep the screen on while playing" to
    /// the attached player, if any.
    pub fn set_keep_screen_on(&self, on: bool) {
        if let Ok(player) = self.get() {
            player.set_keep_screen_on(on);
        }
    }

    /// Applies Settings → Playback → "Audio passthrough" (mpv's
    /// `audio-spdif`) to the attached player, if any.
    pub fn set_audio_spdif(&self, codecs: &str) {
        if let Ok(player) = self.get() {
            player.set_audio_spdif(codecs);
        }
    }

    /// Applies Settings → General → "Show what I'm watching on Discord" and
    /// its options.
    pub fn set_presence_options(&self, options: PresenceOptions) {
        self.presence.set_options(options);
    }

    /// Switching profiles: stop what's playing (its progress belongs to the
    /// profile being left) and clear what Discord shows. The renderer leaves
    /// the player page, which detaches it.
    pub fn close_for_profile_switch(&self) {
        if let Ok(player) = self.get() {
            let _ = player.stop();
        }
        self.presence.set_media(None);
    }

    /// The app is quitting: give the display assertion back and clear what
    /// Discord shows now, rather than leave it to the process exiting.
    pub fn release_on_exit(&self) {
        if let Ok(player) = self.get() {
            player.release_keep_awake();
        }
        self.presence.shutdown(PRESENCE_QUIT_TIMEOUT);
    }
}

/// Settings → General → Discord (off if the settings can't be read).
fn presence_options(app: &AppState) -> PresenceOptions {
    app.settings()
        .and_then(|settings| settings.get())
        .map(|settings| PresenceOptions::from(&settings.general))
        .unwrap_or_default()
}

/// Settings → Playback → "Audio passthrough", as mpv's `audio-spdif` (off,
/// decoding everything, if the settings can't be read).
fn audio_spdif(app: &AppState) -> String {
    app.settings()
        .and_then(|settings| settings.get())
        .map(|settings| settings.playback.audio_spdif())
        .unwrap_or_default()
}

/// Settings → Playback → "Keep the screen on while playing" (on if the
/// settings can't be read).
fn keep_screen_on(app: &AppState) -> bool {
    app.settings()
        .and_then(|settings| settings.get())
        .map_or(true, |settings| settings.playback.keep_screen_on)
}

fn sink(channel: Channel<PlayerEvent>) -> EventSink {
    Box::new(move |event| {
        // The webview may have gone away; the next attach replaces the sink.
        let _ = channel.send(event);
    })
}

/// `KIRO_SPIKE_LOG`: logs a command, its arguments and its outcome, so the
/// player can be exercised and checked from the terminal.
fn logged<T: std::fmt::Debug>(
    command: &str,
    args: std::fmt::Arguments<'_>,
    result: Result<T>,
) -> Result<T> {
    if debug_log_enabled() {
        match &result {
            Ok(value) => eprintln!("[kiro-player] {command}({args}) -> {value:?}"),
            Err(error) => eprintln!(
                "[kiro-player] {command}({args}) -> {} {error}",
                error.code()
            ),
        }
    }
    result
}

/// Runs blocking player work (waiting on the main thread, network fetches)
/// off the async runtime's workers.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    spawn_blocking(work)
        .await
        .map_err(|_| Error::Internal("player task failed".into()))?
}

/// Creates the player and its video surface, or reconnects to the existing
/// one (e.g. after a webview reload). `async` so it runs off the main thread:
/// attaching waits for work scheduled *on* the main thread.
#[tauri::command]
pub async fn player_attach<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, PlayerState>,
    app: State<'_, AppState>,
    on_event: Channel<PlayerEvent>,
) -> Result<PlayerSnapshot> {
    let _guard = state.lifecycle.lock().await;
    let keep_screen_on = keep_screen_on(&app);
    let audio_spdif = audio_spdif(&app);
    state.presence.set_options(presence_options(&app));
    if let Ok(player) = state.get() {
        player.set_sink(sink(on_event));
        player.set_keep_screen_on(keep_screen_on);
        player.set_audio_spdif(&audio_spdif);
        return logged(
            "player_attach",
            format_args!("reconnect"),
            Ok(player.snapshot()),
        );
    }
    let player = blocking(move || Ok(MpvPlayer::attach(&window, sink(on_event))?)).await;
    let player = Arc::new(match player {
        Ok(player) => player,
        Err(error) => return logged("player_attach", format_args!("new"), Err(error)),
    });
    player.set_keep_screen_on(keep_screen_on);
    player.set_audio_spdif(&audio_spdif);
    player.set_presence(state.presence.clone());
    let snapshot = logged("player_attach", format_args!("new"), Ok(player.snapshot()))?;
    state.set(Some(player));
    Ok(snapshot)
}

/// Stops playback, removes the video surface and releases mpv.
#[tauri::command]
pub async fn player_detach<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, PlayerState>,
) -> Result<()> {
    let _guard = state.lifecycle.lock().await;
    state.presence.set_media(None);
    let Some(player) = state.set(None) else {
        return logged("player_detach", format_args!("not attached"), Ok(()));
    };
    let result = blocking(move || {
        let result = player.detach(&window);
        // Usually the last reference: releases mpv on this blocking thread.
        drop(player);
        Ok(result?)
    })
    .await;
    logged("player_detach", format_args!(""), result)
}

/// Loads an http(s) stream, optionally starting `startPosition` seconds in.
#[tauri::command]
pub fn player_load(
    url: String,
    start_position: Option<f64>,
    state: State<'_, PlayerState>,
) -> Result<()> {
    let result = (|| -> Result<()> {
        // Debug builds only: mpv's lavfi test patterns, e.g.
        // `av://lavfi:testsrc2=size=1920x1080:rate=60`, to verify rendering
        // with known colours. Not a URL, so it bypasses the http(s) check.
        #[cfg(debug_assertions)]
        if url.starts_with("av://lavfi:") {
            state.get()?.load_raw(&url)?;
            return Ok(());
        }
        let url = parse_stream_url(&url).map_err(Error::invalid_argument)?;
        if let Some(start) = start_position
            && !(start.is_finite() && start >= 0.0)
        {
            return Err(Error::invalid_argument(
                "Start position must be a non-negative number",
            ));
        }
        let source = MediaSource::Network {
            url,
            headers: Vec::new(),
        };
        state.get()?.load(&source, start_position)?;
        Ok(())
    })();
    logged(
        "player_load",
        format_args!("{url:?}, {start_position:?}"),
        result,
    )
}

/// What is playing, for Discord Rich Presence. Mirrors `NowPlaying` in
/// `apps/desktop/src/services/player.ts`.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NowPlayingArgs {
    title: String,
    season: Option<u32>,
    episode: Option<u32>,
    /// Used only when https.
    poster: Option<String>,
}

/// Tells Discord Rich Presence what is playing (`null`: nothing it may
/// know about). Shown only while the setting is on; the title, episode and
/// poster are all it gets.
#[tauri::command]
pub fn player_set_now_playing(
    now_playing: Option<NowPlayingArgs>,
    state: State<'_, PlayerState>,
) -> Result<()> {
    let media = now_playing
        .map(|args| {
            NowPlaying::new(
                &args.title,
                args.season,
                args.episode,
                args.poster.as_deref(),
            )
            .map_err(Error::invalid_argument)
        })
        .transpose()?;
    let known = media.is_some();
    state.presence.set_media(media);
    logged("player_set_now_playing", format_args!("{known}"), Ok(()))
}

#[tauri::command]
pub fn player_set_paused(paused: bool, state: State<'_, PlayerState>) -> Result<()> {
    let result = (|| -> Result<()> {
        let player = state.get()?;
        if paused {
            player.pause()?
        } else {
            player.play()?
        }
        Ok(())
    })();
    logged("player_set_paused", format_args!("{paused}"), result)
}

#[tauri::command]
pub fn player_seek(seconds: f64, state: State<'_, PlayerState>) -> Result<()> {
    let result = (|| -> Result<()> {
        if !seconds.is_finite() || seconds < 0.0 {
            return Err(Error::invalid_argument(
                "Seek position must be a non-negative number",
            ));
        }
        state.get()?.seek(seconds)?;
        Ok(())
    })();
    logged("player_seek", format_args!("{seconds}"), result)
}

/// Volume from 0 to the snapshot's `maxVolume`; out-of-range values are clamped.
#[tauri::command]
pub fn player_set_volume(volume: f64, state: State<'_, PlayerState>) -> Result<()> {
    let result = (|| -> Result<()> {
        if !volume.is_finite() {
            return Err(Error::invalid_argument("Volume must be a number"));
        }
        state.get()?.set_volume(volume)?;
        Ok(())
    })();
    logged("player_set_volume", format_args!("{volume}"), result)
}

#[tauri::command]
pub fn player_set_muted(muted: bool, state: State<'_, PlayerState>) -> Result<()> {
    let result = (|| -> Result<()> {
        state.get()?.set_muted(muted)?;
        Ok(())
    })();
    logged("player_set_muted", format_args!("{muted}"), result)
}

#[tauri::command]
pub fn player_stop(state: State<'_, PlayerState>) -> Result<()> {
    let result = (|| -> Result<()> {
        state.get()?.stop()?;
        Ok(())
    })();
    logged("player_stop", format_args!(""), result)
}

#[tauri::command]
pub fn player_select_audio_track(id: String, state: State<'_, PlayerState>) -> Result<()> {
    let result = (|| -> Result<()> {
        let id = parse_track_id(&id).map_err(Error::invalid_argument)?;
        state.get()?.select_audio_track(id)?;
        Ok(())
    })();
    logged("player_select_audio_track", format_args!("{id:?}"), result)
}

/// Selects a subtitle track, or disables subtitles when `id` is `null`.
#[tauri::command]
pub fn player_select_subtitle_track(
    id: Option<String>,
    state: State<'_, PlayerState>,
) -> Result<()> {
    let result = (|| -> Result<()> {
        let id = id
            .as_deref()
            .map(parse_track_id)
            .transpose()
            .map_err(Error::invalid_argument)?;
        state.get()?.select_subtitle_track(id)?;
        Ok(())
    })();
    logged(
        "player_select_subtitle_track",
        format_args!("{id:?}"),
        result,
    )
}

/// Loads an https subtitle file into the current media and selects it.
/// `async`: mpv downloads the file before returning.
#[tauri::command]
pub async fn player_add_subtitle(
    url: String,
    label: Option<String>,
    language: Option<String>,
    state: State<'_, PlayerState>,
) -> Result<MediaTrack> {
    let result = match ExternalSubtitle::parse(&url, label, language) {
        Err(message) => Err(Error::invalid_argument(message)),
        Ok(subtitle) => match state.get() {
            Err(error) => Err(error),
            Ok(player) => blocking(move || Ok(player.add_external_subtitle(&subtitle)?)).await,
        },
    };
    logged("player_add_subtitle", format_args!("{url:?}"), result)
}

/// Changes how subtitles look (Settings → Subtitles). Kept by mpv for the
/// media loaded afterwards too.
#[tauri::command]
pub fn player_set_subtitle_style(
    style: SubtitleStyle,
    state: State<'_, PlayerState>,
) -> Result<()> {
    let result = (|| -> Result<()> {
        style.validate().map_err(Error::invalid_argument)?;
        state.get()?.set_subtitle_style(&style)?;
        Ok(())
    })();
    logged(
        "player_set_subtitle_style",
        format_args!("{style:?}"),
        result,
    )
}

/// Shows subtitles `seconds` later (earlier when negative), to fix
/// subtitles that are out of sync. Clamped to ±60 s; mpv keeps it for the
/// media loaded afterwards too, so the renderer sets it for each stream.
#[tauri::command]
pub fn player_set_subtitle_delay(seconds: f64, state: State<'_, PlayerState>) -> Result<()> {
    let result = (|| -> Result<()> {
        let seconds = subtitle_delay(seconds).map_err(Error::invalid_argument)?;
        state.get()?.set_subtitle_delay(seconds)?;
        Ok(())
    })();
    logged(
        "player_set_subtitle_delay",
        format_args!("{seconds}"),
        result,
    )
}

/// Plays the audio `seconds` later (earlier when negative). Clamped to ±10 s;
/// kept by mpv like the subtitle delay.
#[tauri::command]
pub fn player_set_audio_delay(seconds: f64, state: State<'_, PlayerState>) -> Result<()> {
    let result = (|| -> Result<()> {
        let seconds = audio_delay(seconds).map_err(Error::invalid_argument)?;
        state.get()?.set_audio_delay(seconds)?;
        Ok(())
    })();
    logged("player_set_audio_delay", format_args!("{seconds}"), result)
}

/// Playback speed, where 1 is normal, clamped to 0.25–4. Kept by mpv for the
/// media loaded afterwards too.
#[tauri::command]
pub fn player_set_speed(speed: f64, state: State<'_, PlayerState>) -> Result<()> {
    let result = (|| -> Result<()> {
        let speed = playback_speed(speed).map_err(Error::invalid_argument)?;
        state.get()?.set_speed(speed)?;
        Ok(())
    })();
    logged("player_set_speed", format_args!("{speed}"), result)
}

/// Settings → Playback → "Seek bar previews" (on if the settings can't be
/// read).
fn seek_previews(app: &AppState) -> bool {
    app.settings()
        .and_then(|settings| settings.get())
        .map_or(true, |settings| settings.playback.seek_previews)
}

/// A frame of the stream at `position` seconds, for the seek bar
/// (`media::mpv::preview`); `kind` (default `hover`) says how urgent it is,
/// or (`warm`) only to get the preview core ready. `unavailable` while the
/// setting is off. `async`: making a frame reads part of the stream.
#[tauri::command]
pub async fn player_preview(
    position: f64,
    kind: Option<PreviewKind>,
    state: State<'_, PlayerState>,
    app: State<'_, AppState>,
) -> Result<PreviewResult> {
    if !position.is_finite() || position < 0.0 {
        return Err(Error::invalid_argument(
            "Preview position must be a non-negative number",
        ));
    }
    if !seek_previews(&app) {
        return Ok(PreviewResult::Unavailable);
    }
    let kind = kind.unwrap_or_default();
    let player = state.get()?;
    let result = blocking(move || Ok(player.preview(position, kind))).await;
    if debug_log_enabled()
        && let Ok(result) = &result
    {
        let status = match result {
            PreviewResult::Frame { position, image } => {
                format!("frame at {position:.1}s, {} chars", image.len())
            }
            other => format!("{other:?}"),
        };
        eprintln!("[kiro-player] player_preview({position:.1}, {kind:?}) -> {status}");
    }
    result
}

/// Decoder and renderer details for the stats overlay. Not part of the event
/// stream: only read while the overlay is open.
#[tauri::command]
pub fn player_stats(state: State<'_, PlayerState>) -> Result<DebugStats> {
    Ok(state.get()?.stats())
}
