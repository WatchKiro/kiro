//! Playback commands on Android, backed by Media3 (ExoPlayer) in the app's
//! Kotlin `PlayerPlugin` (`gen/android/app/src/main/java/app/kiro/tv/`).
//!
//! The commands have the names and arguments of the libmpv ones in
//! `player.rs`, so the renderer's `NativePlayer` drives either. Kotlin sends
//! events straight to the renderer's `onEvent` channel, shaped like
//! `media::model::PlayerEvent`.
//!
//! Spike: seek previews, subtitle styling, delays and Discord presence answer
//! as if unavailable.

use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tauri::ipc::Channel;
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{AppHandle, Manager, Runtime};

use crate::core::error::{Error, Result};
use crate::media::{PlaybackError, parse_stream_url};

struct AndroidPlayer<R: Runtime>(PluginHandle<R>);

/// Registers the Kotlin player with Tauri.
pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("kiro-player")
        .setup(|app, api| {
            let handle = api.register_android_plugin("app.kiro.tv", "PlayerPlugin")?;
            app.manage(AndroidPlayer(handle));
            Ok(())
        })
        .build()
}

/// Runs a Kotlin command. `run_mobile_plugin` waits for the answer, which
/// Kotlin gives on the main thread, so it must not wait on a runtime thread.
async fn call<R: Runtime, T: DeserializeOwned + Send + 'static>(
    app: &AppHandle<R>,
    command: &'static str,
    args: Value,
) -> Result<T> {
    let handle = app.state::<AndroidPlayer<R>>().0.clone();
    tauri::async_runtime::spawn_blocking(move || handle.run_mobile_plugin::<T>(command, args))
        .await
        .map_err(|error| Error::Internal(error.to_string()))?
        .map_err(|error| Error::Internal(error.to_string()))
}

async fn run<R: Runtime>(app: &AppHandle<R>, command: &'static str, args: Value) -> Result<()> {
    call::<R, Value>(app, command, args).await.map(drop)
}

#[tauri::command]
pub async fn player_attach<R: Runtime>(
    app: AppHandle<R>,
    on_event: Channel<Value>,
) -> Result<Value> {
    call(&app, "attach", json!({ "onEvent": on_event })).await
}

#[tauri::command]
pub async fn player_detach<R: Runtime>(app: AppHandle<R>) -> Result<()> {
    run(&app, "detach", json!({})).await
}

#[tauri::command]
pub async fn player_load<R: Runtime>(
    app: AppHandle<R>,
    url: String,
    start_position: Option<f64>,
) -> Result<()> {
    let url = parse_stream_url(&url)
        .map_err(|reason| PlaybackError::UnsupportedSource(reason.to_owned()))?;
    let start_position = start_position.filter(|seconds| seconds.is_finite() && *seconds > 0.0);
    run(
        &app,
        "load",
        json!({ "url": url.as_str(), "startPosition": start_position }),
    )
    .await
}

/// Discord Rich Presence is desktop-only.
#[tauri::command]
pub fn player_set_now_playing(_now_playing: Option<Value>) {}

#[tauri::command]
pub async fn player_set_paused<R: Runtime>(app: AppHandle<R>, paused: bool) -> Result<()> {
    run(&app, "setPaused", json!({ "paused": paused })).await
}

#[tauri::command]
pub async fn player_seek<R: Runtime>(app: AppHandle<R>, seconds: f64) -> Result<()> {
    if !seconds.is_finite() {
        return Err(Error::InvalidArgument("seconds must be finite".into()));
    }
    run(&app, "seek", json!({ "seconds": seconds.max(0.0) })).await
}

#[tauri::command]
pub async fn player_set_volume<R: Runtime>(app: AppHandle<R>, volume: f64) -> Result<()> {
    // Media3 doesn't amplify: 1 is the most.
    let volume = if volume.is_finite() {
        volume.clamp(0.0, 1.0)
    } else {
        1.0
    };
    run(&app, "setVolume", json!({ "volume": volume })).await
}

#[tauri::command]
pub async fn player_set_muted<R: Runtime>(app: AppHandle<R>, muted: bool) -> Result<()> {
    run(&app, "setMuted", json!({ "muted": muted })).await
}

#[tauri::command]
pub async fn player_stop<R: Runtime>(app: AppHandle<R>) -> Result<()> {
    run(&app, "stop", json!({})).await
}

#[tauri::command]
pub async fn player_select_audio_track<R: Runtime>(app: AppHandle<R>, id: String) -> Result<()> {
    run(&app, "selectAudioTrack", json!({ "id": id })).await
}

#[tauri::command]
pub async fn player_select_subtitle_track<R: Runtime>(
    app: AppHandle<R>,
    id: Option<String>,
) -> Result<()> {
    run(&app, "selectSubtitleTrack", json!({ "id": id })).await
}

/// Spike: external subtitles need the media item rebuilt (Media3's
/// `SubtitleConfiguration`), which isn't done yet.
#[tauri::command]
pub fn player_add_subtitle(
    _url: String,
    _label: Option<String>,
    _language: Option<String>,
) -> Result<Value> {
    Err(PlaybackError::UnsupportedSource("External subtitles aren't supported yet".into()).into())
}

#[tauri::command]
pub fn player_set_subtitle_style(_style: Value) {}

#[tauri::command]
pub fn player_set_subtitle_delay(_seconds: f64) {}

#[tauri::command]
pub fn player_set_audio_delay(_seconds: f64) {}

#[tauri::command]
pub async fn player_set_speed<R: Runtime>(app: AppHandle<R>, speed: f64) -> Result<()> {
    let speed = if speed.is_finite() {
        speed.clamp(0.25, 4.0)
    } else {
        1.0
    };
    run(&app, "setSpeed", json!({ "speed": speed })).await
}

#[tauri::command]
pub async fn player_stats<R: Runtime>(app: AppHandle<R>) -> Result<Value> {
    call(&app, "stats", json!({})).await
}

#[tauri::command]
pub fn player_preview(_position: f64, _kind: Value) -> Value {
    json!({ "status": "unavailable" })
}
