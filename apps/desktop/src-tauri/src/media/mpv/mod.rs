//! libmpv playback backend (macOS, Windows, Linux).
//!
//! mpv decodes and draws the video on a native surface *below* the webview,
//! which is transparent while the player is open, so the HTML controls are
//! composited on top of the video by the system. Each platform has its own
//! surface (see `docs/playback.md`):
//!
//! - macOS ([`macos`]): mpv's OpenGL render API into a `CAOpenGLLayer`
//!   beneath the WKWebView.
//! - Windows ([`win32`]): mpv's own window (`wid`) inside a child window at
//!   the bottom of WebView2's host window, under the browser's window.
//! - Linux ([`linux`]): mpv's OpenGL render API into a `GtkGLArea` beneath
//!   the WebKitGTK webview, in a `GtkOverlay`. Works on X11 and Wayland.
//!
//! Every surface module has the same shape: `VideoSurface::prepare` runs
//! before mpv exists (Windows needs its window handle for `wid`), the
//! returned `Prepared::configure` sets mpv's video output options, and
//! `VideoSurface::attach` / `detach` / `release_renderer` follow.
//!
//! Ownership: [`MpvPlayer`] owns the mpv core through an `Arc<Mpv>` shared
//! with its event thread and (while it renders) the video surface. Dropping
//! the player stops the event thread and frees the render context with its GL
//! context current; the core is destroyed when the last `Arc` goes, which is
//! the player's own. [`MpvPlayer::detach`] additionally removes the video
//! surface from the window, which has to happen on the main thread.

mod client;
mod events;
mod ffi;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
pub mod preview;
mod preview_reader;
// The OpenGL render API (macOS, Linux); on Windows mpv draws into its own window.
#[cfg(not(target_os = "windows"))]
mod render;
#[cfg(not(target_os = "windows"))]
mod wakelock;
#[cfg(target_os = "windows")]
mod win32;

#[cfg(target_os = "linux")]
use linux as surface;
#[cfg(target_os = "macos")]
use macos as surface;
#[cfg(target_os = "windows")]
use win32 as surface;

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;

use serde::{Deserialize, Serialize};
use tauri::{Runtime, WebviewWindow};

use super::keep_awake::{KeepAwake, Transition};
use super::model::{
    MAX_VOLUME, MediaTrack, PlaybackState, PlayerEvent, PlayerModel, PlayerSnapshot, TrackKind,
};
use super::passthrough::{Spdif, audio_mode};
use super::{ExternalSubtitle, MediaSource, PlaybackBackend, PlaybackError, SubtitleStyle};
use crate::presence::{PlayerView, Presence};
use client::Mpv;
use ffi::error as mpv_error;
use preview::{BufferState, Outcome, Previewer};

/// Keeps the display awake while playing. mpv can't when it renders through
/// the render API (`vo=libmpv`): its `stop-screensaver` needs its own window.
#[cfg(not(target_os = "windows"))]
type PlatformWakelock = wakelock::SystemWakelock;
/// mpv owns the video window on Windows and stops the screensaver itself.
#[cfg(target_os = "windows")]
type PlatformWakelock = super::keep_awake::NoWakelock;

/// Receives the player's events (a Tauri channel to the attached webview).
pub type EventSink = Box<dyn Fn(PlayerEvent) + Send + Sync>;

/// Dev instrumentation: `KIRO_SPIKE_LOG=1` logs every player event, mpv stats
/// every 2 s, and early frames' GL state to stderr.
pub(crate) fn debug_log_enabled() -> bool {
    std::env::var_os("KIRO_SPIKE_LOG").is_some()
}

/// Human-readable message for an mpv error, for the renderer.
fn mpv_error_message(error: &client::Error) -> &'static str {
    match error {
        client::Error::Raw(code) => match *code {
            mpv_error::LOADING_FAILED => "The media could not be opened",
            mpv_error::UNKNOWN_FORMAT => "The media format is not supported",
            mpv_error::NOTHING_TO_PLAY => "The media has no playable audio or video",
            mpv_error::AO_INIT_FAILED => "No audio output is available",
            mpv_error::VO_INIT_FAILED => "The video output could not be started",
            mpv_error::PROPERTY_UNAVAILABLE => "Nothing is loaded",
            mpv_error::UNSUPPORTED | mpv_error::NOT_IMPLEMENTED => "Not supported by this player",
            _ => "The player reported an error",
        },
        client::Error::Create => "The player could not be created",
        client::Error::Nul => "Text contains a NUL character",
        client::Error::InvalidUtf8 => "The player returned invalid text",
        client::Error::VersionMismatch { .. } => "The installed libmpv is incompatible",
    }
}

fn backend_error(error: client::Error) -> PlaybackError {
    if debug_log_enabled() {
        eprintln!("[kiro-player] mpv error: {error:?}");
    }
    PlaybackError::Backend(mpv_error_message(&error).to_owned())
}

/// Counters written by the surface and read by commands. On Windows mpv draws
/// into its own window, so only the scale is known there.
#[derive(Default)]
pub struct RenderStats {
    pub frames_rendered: AtomicU64,
    /// Brightest of five sampled pixels, packed `0xRRGGBB`.
    pub sample_pixel: AtomicU32,
    /// The surface's pixels per point at the last draw, as `f64` bits.
    pub contents_scale: AtomicU64,
}

/// Decoder and renderer details for the player's stats overlay and logs.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugStats {
    width: Option<i64>,
    height: Option<i64>,
    video_codec: Option<String>,
    /// Active hardware decoder (e.g. `videotoolbox`, `d3d11va`, `vaapi`), or
    /// `no` for software.
    hwdec: Option<String>,
    /// Colour primaries / transfer, e.g. `bt.2020` / `pq` for HDR10.
    primaries: Option<String>,
    gamma: Option<String>,
    fps: Option<f64>,
    dropped_frames: i64,
    /// Seconds of media buffered ahead of the playback position.
    cache_seconds: Option<f64>,
    /// The audio track's codec, e.g. `eac3`.
    audio_codec: Option<String>,
    /// `passthrough eac3` (sent to the receiver untouched) or `decoded`
    /// (`media::passthrough::audio_mode`); `None` without audio.
    audio_mode: Option<String>,
    /// mpv's audio output, e.g. `coreaudio`, `coreaudio_exclusive`, `wasapi`.
    audio_output: Option<String>,
    /// Frames drawn into the surface since attach: proves the render loop
    /// runs (macOS and Linux; mpv's own window on Windows isn't counted).
    frames_rendered: u64,
    /// Brightest of five pixels read back from a recent frame, as `#rrggbb`:
    /// proves mpv drew real image data into the layer.
    sample_pixel: String,
    /// The surface's pixels per point (2 on Retina and 200 % displays).
    contents_scale: f64,
}

/// State shared between the player, its event thread and the commands.
pub(crate) struct Shared {
    model: Mutex<PlayerModel>,
    sink: Mutex<Option<EventSink>>,
    keep_awake: Mutex<KeepAwake<PlatformWakelock>>,
    /// Discord Rich Presence, told about every change (it sends nothing
    /// unless the setting is on).
    presence: Mutex<Option<Arc<Presence>>>,
    /// Audio passthrough: what mpv's `audio-spdif` should be.
    spdif: Mutex<Spdif>,
}

impl Shared {
    fn new(sink: EventSink) -> Self {
        Self {
            model: Mutex::new(PlayerModel::default()),
            sink: Mutex::new(Some(sink)),
            keep_awake: Mutex::new(KeepAwake::new(PlatformWakelock {})),
            presence: Mutex::new(None),
            spdif: Mutex::new(Spdif::default()),
        }
    }

    fn spdif(&self) -> MutexGuard<'_, Spdif> {
        self.spdif.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Sets mpv's `audio-spdif` to what [`Spdif`] says, if it differs: mpv
    /// re-creates the audio decoder when it changes. While anything is
    /// passed through, the event thread reads mpv's log to notice a format
    /// the audio output refused (`passthrough::FALLBACK_MESSAGE`).
    fn apply_spdif(&self, mpv: &Mpv) -> client::Result<String> {
        let (codecs, on) = {
            let spdif = self.spdif();
            (spdif.codecs(), spdif.is_on())
        };
        mpv.request_log_messages(if on { "v" } else { "no" })?;
        if mpv.get_property::<String>("audio-spdif").as_deref() != Ok(codecs.as_str()) {
            mpv.set_property("audio-spdif", codecs.as_str())?;
        }
        Ok(codecs)
    }

    fn presence(&self) -> Option<Arc<Presence>> {
        self.presence
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Tells Discord Rich Presence what the player is doing. Called by the
    /// event thread after every change, like [`Self::sync_keep_awake`]; it
    /// only hands the state over, never waiting on Discord.
    fn sync_presence(&self) {
        let Some(presence) = self.presence() else {
            return;
        };
        let view = {
            let model = self.model();
            let (position, duration) = model.timeline();
            PlayerView {
                state: model.state(),
                position,
                duration,
            }
        };
        presence.sync_player(view);
    }

    fn model(&self) -> MutexGuard<'_, PlayerModel> {
        self.model.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn keep_awake(&self) -> MutexGuard<'_, KeepAwake<PlatformWakelock>> {
        self.keep_awake
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Holds or releases the display assertion to match the player's state.
    /// Called by the event thread after every change, so it follows exactly
    /// what the renderer is told.
    fn sync_keep_awake(&self) {
        let state = self.model().state();
        let transition = self.keep_awake().sync(state);
        log_keep_awake(transition, state);
    }

    fn emit(&self, events: Vec<PlayerEvent>) {
        if events.is_empty() {
            return;
        }
        let sink = self.sink.lock().unwrap_or_else(PoisonError::into_inner);
        for event in events {
            if debug_log_enabled() && !matches!(event, PlayerEvent::TimeUpdate { .. }) {
                eprintln!(
                    "[kiro-player] event {}",
                    serde_json::to_string(&event).unwrap_or_default()
                );
            }
            if let Some(sink) = sink.as_ref() {
                sink(event);
            }
        }
    }
}

fn log_keep_awake(transition: Option<Transition>, state: PlaybackState) {
    match transition {
        Some(Transition::Failed(error)) => {
            eprintln!("[kiro-player] could not keep the display awake: {error}");
        }
        Some(transition) if debug_log_enabled() => {
            eprintln!("[kiro-player] keep awake: {transition:?} ({state:?})");
        }
        _ => {}
    }
}

/// A libmpv instance whose video is drawn under one window's webview.
pub struct MpvPlayer {
    mpv: Arc<Mpv>,
    shared: Arc<Shared>,
    stats: Arc<RenderStats>,
    surface: surface::VideoSurface,
    stop_events: Arc<AtomicBool>,
    event_thread: Option<JoinHandle<()>>,
    /// Seek-bar previews, from a second core opened on demand.
    previewer: Previewer,
}

/// A seek-bar preview, or why there isn't one. Mirrors `PlayerPreview` in
/// `apps/desktop/src/services/player.ts`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum PreviewResult {
    /// `image` is a `data:image/jpeg;base64,…` URL; `position` is the
    /// keyframe shown, at or before the position asked for.
    Frame { position: f64, image: String },
    /// Not now: the player is short of buffered video. Ask again later.
    Busy,
    /// A newer request replaced this one.
    Superseded,
    /// Nothing can be previewed for this stream.
    Unavailable,
    /// The stream is being opened in the preview core ([`PreviewKind::Warm`]).
    Warming,
}

/// What a preview is asked for. Mirrors `PreviewKind` in
/// `apps/desktop/src/services/player.ts`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PreviewKind {
    /// The pointer is on it: made as soon as the player has a little buffered.
    #[default]
    Hover,
    /// Next to where the pointer rests, for when it moves on: only while the
    /// player has plenty buffered.
    Prefetch,
    /// One of a few spread over the video, made as it loads, to stand in
    /// anywhere on the bar: only while the player has plenty buffered.
    Storyboard,
    /// No frame: open the stream in the preview core, for the first hover.
    Warm,
}

impl MpvPlayer {
    /// Creates mpv, starts its event thread and attaches the video surface
    /// below the window's webview. Must not be called on the main thread: attaching
    /// waits for work scheduled there.
    pub fn attach<R: Runtime>(
        window: &WebviewWindow<R>,
        sink: EventSink,
    ) -> Result<Self, PlaybackError> {
        // Anything the surface needs before mpv exists (Windows: the window
        // mpv draws into).
        let prepared = surface::VideoSurface::prepare(window)?;
        let mpv = Mpv::with_initializer(|init| {
            // The video output: the render API, or mpv's own window (`wid`).
            prepared.configure(init)?;
            init.set_option("hwdec", "auto-safe")?;
            // Deterministic, embedded behaviour: ignore the user's mpv.conf,
            // scripts and key bindings, and never spawn yt-dlp.
            init.set_option("config", "no")?;
            init.set_option("input-default-bindings", "no")?;
            init.set_option("input-vo-keyboard", "no")?;
            // Scripts, and the built-in Lua ones (on-screen controller,
            // yt-dlp hook). These options exist only when mpv is built with a
            // scripting backend (`osc` and `ytdl`: Lua), which the bundled
            // release builds aren't (docs/releasing.md): nothing to turn off.
            for name in ["load-scripts", "osc", "ytdl"] {
                match init.set_option(name, "no") {
                    Ok(()) | Err(client::Error::Raw(mpv_error::OPTION_NOT_FOUND)) => {}
                    Err(error) => return Err(error),
                }
            }
            if debug_log_enabled() {
                // mpv's own warnings, what the video output does, and which
                // hardware decoders the decoder tries.
                init.set_option("terminal", "yes")?;
                init.set_option("msg-level", "all=warn,vo=v,libmpv_render=v,vd=v,ad=v,ao=v")?;
            } else {
                init.set_option("terminal", "no")?;
            }
            init.set_option("idle", "yes")?;
            // Stay on the last frame at the end instead of unloading, so the
            // renderer sees `eof-reached` and can offer to seek back.
            init.set_option("keep-open", "yes")?;
            init.set_option("volume-max", (MAX_VOLUME * 100.0).round() as i64)?;
            // Never pick up subtitle files next to local media on its own.
            init.set_option("sub-auto", "no")?;
            init.set_option("audio-client-name", "Kiro")?;
            // Dev instrumentation: `KIRO_MPV_OPTIONS='name=value ...'` (with
            // `KIRO_SPIKE_LOG`) sets extra mpv options, to try settings
            // without a rebuild.
            if debug_log_enabled()
                && let Ok(options) = std::env::var("KIRO_MPV_OPTIONS")
            {
                for option in options.split_whitespace() {
                    let (name, value) = option.split_once('=').unwrap_or((option, "yes"));
                    init.set_option(name, value)?;
                }
            }
            Ok(())
        })
        .map_err(backend_error)?;
        let mpv = Arc::new(mpv);
        events::observe(&mpv).map_err(backend_error)?;

        let shared = Arc::new(Shared::new(sink));
        let stats = Arc::new(RenderStats::default());
        let stop_events = Arc::new(AtomicBool::new(false));
        let event_thread = events::spawn(
            mpv.clone(),
            shared.clone(),
            stats.clone(),
            stop_events.clone(),
        )
        .map_err(|_| PlaybackError::Backend("Could not start the player".into()))?;

        let previewer = Previewer::new()
            .map_err(|_| PlaybackError::Backend("Could not start the player".into()))?;

        // From here on, dropping `player` tears everything down again.
        let mut player = Self {
            mpv: mpv.clone(),
            shared,
            stats: stats.clone(),
            surface: surface::VideoSurface::default(),
            stop_events,
            event_thread: Some(event_thread),
            previewer,
        };
        player.surface = surface::VideoSurface::attach(prepared, window, mpv, stats)?;
        Ok(player)
    }

    /// Routes events to a new sink, e.g. after the webview reloaded.
    pub fn set_sink(&self, sink: EventSink) {
        *self
            .shared
            .sink
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(sink);
    }

    pub fn snapshot(&self) -> PlayerSnapshot {
        self.shared.model().snapshot()
    }

    /// Settings → Playback → "Keep the screen on while playing". The event
    /// thread takes or releases the assertion; mpv's own `stop-screensaver`
    /// covers the platforms where it owns the video window.
    pub fn set_keep_screen_on(&self, on: bool) {
        self.shared.keep_awake().set_enabled(on);
        // A choice (`yes`, `no`, `always`), not a flag.
        let _ = self
            .mpv
            .set_property("stop-screensaver", if on { "yes" } else { "no" });
        if debug_log_enabled() {
            let mpv_value = self
                .mpv
                .get_property::<String>("stop-screensaver")
                .unwrap_or_default();
            eprintln!("[kiro-player] keep screen on: {on} (stop-screensaver = {mpv_value})");
        }
        events::wake(&self.mpv);
    }

    /// Settings → Playback → "Audio passthrough": mpv's `audio-spdif`, the
    /// codecs sent to the receiver untouched (empty: decode everything). mpv
    /// re-creates the audio decoder when it changes, so an unchanged choice
    /// changes nothing (settings are saved mid-playback, e.g. the volume).
    /// The output goes exclusive only for a passthrough track; a format it
    /// refuses is decoded instead (`events`, [`Spdif::refuse`]).
    pub fn set_audio_spdif(&self, codecs: &str) {
        if !self.shared.spdif().choose(codecs) && !codecs.is_empty() {
            return;
        }
        let result = self.shared.apply_spdif(&self.mpv);
        if debug_log_enabled() {
            match result {
                Ok(codecs) if codecs.is_empty() => {
                    eprintln!("[kiro-player] audio passthrough: off")
                }
                Ok(codecs) => eprintln!("[kiro-player] audio passthrough: {codecs}"),
                Err(error) => eprintln!("[kiro-player] audio passthrough failed: {error:?}"),
            }
        }
    }

    /// Reports this player's state changes to Discord Rich Presence.
    pub fn set_presence(&self, presence: Arc<Presence>) {
        *self
            .shared
            .presence
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(presence);
        events::wake(&self.mpv);
    }

    /// Releases the display assertion for good, e.g. when the app quits.
    pub fn release_keep_awake(&self) {
        let transition = self.shared.keep_awake().stop();
        log_keep_awake(transition, self.shared.model().state());
    }

    /// Removes the video view from the window (on the main thread) and frees
    /// the renderer. The rest is released when the player is dropped. Must not
    /// be called on the main thread.
    pub fn detach<R: Runtime>(&self, window: &WebviewWindow<R>) -> Result<(), PlaybackError> {
        *self
            .shared
            .sink
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = None;
        // Silence audio straight away, even if a command still holds the player.
        let _ = self.mpv.command("stop", &[]);
        self.previewer.set_source(None);
        let result = self.surface.detach(window);
        self.surface.release_renderer();
        result
    }

    /// Debug builds: load an mpv-specific target such as a lavfi test pattern.
    #[cfg(debug_assertions)]
    pub fn load_raw(&self, target: &str) -> Result<(), PlaybackError> {
        // Test patterns can't be seeked: nothing to preview.
        self.previewer.set_source(None);
        self.mpv
            .command("loadfile", &[target, "replace"])
            .map_err(backend_error)
    }

    pub fn stop(&self) -> Result<(), PlaybackError> {
        self.previewer.set_source(None);
        self.mpv.command("stop", &[]).map_err(backend_error)
    }

    /// A seek-bar preview at `position` seconds of the stream that is
    /// playing. Refused ([`PreviewResult::Busy`]) while that could hold up
    /// playback ([`preview::could_stall_playback`]; a prefetch needs more
    /// buffered). Blocks while the frame is made: call it off the async
    /// runtime. [`PreviewKind::Warm`] only opens the stream, and returns at
    /// once.
    pub fn preview(&self, position: f64, kind: PreviewKind) -> PreviewResult {
        let demand = match kind {
            PreviewKind::Hover | PreviewKind::Warm => preview::HOVER,
            PreviewKind::Prefetch | PreviewKind::Storyboard => preview::BACKGROUND,
        };
        let buffer = self.buffer_state();
        if preview::could_stall_playback(&buffer, demand) {
            if debug_log_enabled() {
                eprintln!(
                    "[kiro-preview] busy: {:.1} s buffered, {} KB/s in, {} KB/s played",
                    buffer.cached_seconds.unwrap_or(0.0),
                    buffer.input_rate.map_or(0.0, |rate| rate / 1024.0).round(),
                    buffer.bitrate.map_or(0.0, |rate| rate / 1024.0).round(),
                );
            }
            return PreviewResult::Busy;
        }
        if kind == PreviewKind::Warm {
            self.previewer.warm();
            return PreviewResult::Warming;
        }
        match self.previewer.request(position) {
            Outcome::Frame(frame) => {
                use base64::Engine as _;
                let data = base64::engine::general_purpose::STANDARD.encode(&frame.jpeg);
                PreviewResult::Frame {
                    position: frame.position,
                    image: format!("data:image/jpeg;base64,{data}"),
                }
            }
            Outcome::Superseded => PreviewResult::Superseded,
            Outcome::Unavailable => PreviewResult::Unavailable,
        }
    }

    fn buffer_state(&self) -> BufferState {
        let (position, duration) = self.shared.model().timeline();
        // Bytes per second the stream plays at: the file's size over its
        // length (not known for a live or chunked stream).
        let bitrate = match (self.mpv.get_property::<f64>("file-size").ok(), duration) {
            (Some(size), Some(duration)) if duration > 0.0 => Some(size / duration),
            _ => None,
        };
        BufferState {
            buffering: self.mpv.get_property("paused-for-cache").unwrap_or(false),
            via_network: self.mpv.get_property("demuxer-via-network").unwrap_or(true),
            cached_seconds: self.mpv.get_property("demuxer-cache-duration").ok(),
            position,
            duration,
            input_rate: self.mpv.get_property::<f64>("cache-speed").ok(),
            bitrate,
        }
    }

    pub fn has_track(&self, kind: TrackKind, id: &str) -> bool {
        self.shared.model().has_track(kind, id)
    }

    pub fn stats(&self) -> DebugStats {
        debug_stats(&self.mpv, &self.stats)
    }
}

impl Drop for MpvPlayer {
    fn drop(&mut self) {
        // 1. Free the render context with its GL context current. It must go
        //    before the core (render.h).
        self.surface.release_renderer();
        // 2. Stop the event thread, which holds the other reference to mpv.
        self.stop_events.store(true, Ordering::Release);
        events::wake(&self.mpv);
        if let Some(thread) = self.event_thread.take() {
            let _ = thread.join();
        }
        // 3. Nothing can take the display assertion any more: give it back,
        //    and clear what Discord shows.
        self.release_keep_awake();
        if let Some(presence) = self.shared.presence() {
            presence.sync_player(PlayerView::IDLE);
        }
        // 4. `self.mpv` is now the last reference: dropping it destroys the core.
        debug_assert_eq!(Arc::strong_count(&self.mpv), 1);
        if debug_log_enabled() {
            eprintln!("[kiro-player] player released");
        }
    }
}

/// Subtitle properties mpv 0.38 renamed, by their name before then.
fn legacy_subtitle_property(name: &str) -> Option<&'static str> {
    match name {
        "sub-outline-size" => Some("sub-border-size"),
        "sub-outline-color" => Some("sub-border-color"),
        _ => None,
    }
}

fn debug_stats(mpv: &Mpv, stats: &RenderStats) -> DebugStats {
    let f64_prop = |name| mpv.get_property::<f64>(name).ok();
    let str_prop = |name| mpv.get_property::<String>(name).ok();
    let i64_prop = |name| mpv.get_property::<i64>(name).ok();

    DebugStats {
        width: i64_prop("width"),
        height: i64_prop("height"),
        video_codec: str_prop("video-codec"),
        hwdec: str_prop("hwdec-current"),
        primaries: str_prop("video-params/primaries"),
        gamma: str_prop("video-params/gamma"),
        fps: f64_prop("estimated-vf-fps"),
        dropped_frames: i64_prop("frame-drop-count").unwrap_or(0)
            + i64_prop("decoder-frame-drop-count").unwrap_or(0),
        cache_seconds: f64_prop("demuxer-cache-duration"),
        audio_codec: str_prop("audio-codec-name"),
        audio_mode: audio_mode(str_prop("audio-out-params/format").as_deref()),
        audio_output: str_prop("current-ao"),
        frames_rendered: stats.frames_rendered.load(Ordering::Relaxed),
        sample_pixel: format!("#{:06x}", stats.sample_pixel.load(Ordering::Relaxed)),
        contents_scale: f64::from_bits(stats.contents_scale.load(Ordering::Relaxed)),
    }
}

impl PlaybackBackend for MpvPlayer {
    fn load(&self, source: &MediaSource, start_position: Option<f64>) -> Result<(), PlaybackError> {
        let target = match source {
            MediaSource::Network { url, headers } => {
                if !headers.is_empty() {
                    return Err(PlaybackError::UnsupportedSource(
                        "custom headers are not supported yet".into(),
                    ));
                }
                url.as_str().to_owned()
            }
            MediaSource::Local { .. } => {
                return Err(PlaybackError::UnsupportedSource(
                    "local files are not supported yet".into(),
                ));
            }
        };
        // `loadfile <url> <flags> <index> <options>`: -1 appends (mpv ≥ 0.38).
        let options = start_position.map(|start| format!("start={start}"));
        let mut args = vec![target.as_str(), "replace"];
        if let Some(options) = options.as_deref() {
            args.extend(["-1", options]);
        }
        self.mpv.command("loadfile", &args).map_err(backend_error)?;
        self.previewer.set_source(Some(target));
        self.mpv.set_property("pause", false).map_err(backend_error)
    }

    fn play(&self) -> Result<(), PlaybackError> {
        self.mpv.set_property("pause", false).map_err(backend_error)
    }

    fn pause(&self) -> Result<(), PlaybackError> {
        self.mpv.set_property("pause", true).map_err(backend_error)
    }

    fn seek(&self, seconds: f64) -> Result<(), PlaybackError> {
        self.mpv
            .command("seek", &[&seconds.to_string(), "absolute"])
            .map_err(backend_error)
    }

    fn set_volume(&self, volume: f64) -> Result<(), PlaybackError> {
        let volume = volume.clamp(0.0, MAX_VOLUME);
        self.mpv
            .set_property("volume", volume * 100.0)
            .map_err(backend_error)
    }

    fn set_muted(&self, muted: bool) -> Result<(), PlaybackError> {
        self.mpv.set_property("mute", muted).map_err(backend_error)
    }

    fn position(&self) -> Result<f64, PlaybackError> {
        self.mpv
            .get_property("time-pos")
            .map_err(|_| PlaybackError::NotLoaded)
    }

    fn tracks(&self) -> Vec<MediaTrack> {
        self.shared.model().tracks().to_vec()
    }

    fn select_audio_track(&self, id: &str) -> Result<(), PlaybackError> {
        if !self.has_track(TrackKind::Audio, id) {
            return Err(PlaybackError::TrackNotFound);
        }
        self.mpv.set_property("aid", id).map_err(backend_error)
    }

    fn select_subtitle_track(&self, id: Option<&str>) -> Result<(), PlaybackError> {
        if let Some(id) = id
            && !self.has_track(TrackKind::Subtitle, id)
        {
            return Err(PlaybackError::TrackNotFound);
        }
        self.mpv
            .set_property("sid", id.unwrap_or("no"))
            .map_err(backend_error)
    }

    fn add_external_subtitle(
        &self,
        subtitle: &ExternalSubtitle,
    ) -> Result<MediaTrack, PlaybackError> {
        if self.shared.model().state() == super::model::PlaybackState::Idle {
            return Err(PlaybackError::NotLoaded);
        }
        let url = subtitle.url.as_str();
        // `sub-add <url> <flags> <title> <lang>`; mpv fetches the file before
        // returning. Arguments go through `mpv_command` as an array, so the
        // URL and title cannot inject further commands.
        self.mpv
            .command(
                "sub-add",
                &[
                    url,
                    "select",
                    subtitle.label.as_deref().unwrap_or(""),
                    subtitle.language.as_deref().unwrap_or(""),
                ],
            )
            .map_err(|_| PlaybackError::Backend("The subtitle file could not be loaded".into()))?;

        // The event thread updates the model asynchronously; read the
        // authoritative list to find the track just added.
        let json: String = self.mpv.get_property("track-list").map_err(backend_error)?;
        super::model::parse_track_list(&json)
            .into_iter()
            .filter(|t| t.kind == TrackKind::Subtitle && t.external_url.as_deref() == Some(url))
            .max_by_key(|t| t.id.parse::<i64>().unwrap_or(0))
            .ok_or_else(|| PlaybackError::Backend("The subtitle file could not be loaded".into()))
    }

    fn set_subtitle_style(&self, style: &SubtitleStyle) -> Result<(), PlaybackError> {
        for (name, value) in style.mpv_properties() {
            let name = match self.mpv.set_property(name, value.as_str()) {
                Ok(()) => name,
                // Older libmpv (Linux distributions ship 0.35 to 0.37).
                Err(client::Error::Raw(mpv_error::PROPERTY_NOT_FOUND)) => {
                    match legacy_subtitle_property(name) {
                        Some(legacy) => {
                            self.mpv
                                .set_property(legacy, value.as_str())
                                .map_err(backend_error)?;
                            legacy
                        }
                        // Nothing like it: keep mpv's default (an outline).
                        None if name == "sub-border-style" => continue,
                        None => {
                            return Err(backend_error(client::Error::Raw(
                                mpv_error::PROPERTY_NOT_FOUND,
                            )));
                        }
                    }
                }
                Err(error) => return Err(backend_error(error)),
            };
            if debug_log_enabled() {
                // Read back what mpv now holds, to check it took the value.
                let applied = self.mpv.get_property::<String>(name).unwrap_or_default();
                eprintln!("[kiro-player] {name} = {applied} (set {value})");
            }
        }
        Ok(())
    }

    fn set_subtitle_delay(&self, seconds: f64) -> Result<(), PlaybackError> {
        self.mpv
            .set_property("sub-delay", seconds)
            .map_err(backend_error)
    }

    fn set_audio_delay(&self, seconds: f64) -> Result<(), PlaybackError> {
        self.mpv
            .set_property("audio-delay", seconds)
            .map_err(backend_error)
    }

    fn set_speed(&self, speed: f64) -> Result<(), PlaybackError> {
        self.mpv.set_property("speed", speed).map_err(backend_error)
    }
}
