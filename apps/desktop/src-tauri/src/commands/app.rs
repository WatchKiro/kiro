use serde::Serialize;
use tauri::{AppHandle, Runtime};

/// Mirrored by `AppInfo` in `apps/desktop/src/services/native.ts`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    name: String,
    version: String,
    tauri_version: &'static str,
    os: &'static str,
    arch: &'static str,
    /// Whether this build includes the native player (`--features libmpv` on
    /// macOS, Windows or Linux).
    native_player: bool,
    /// Whether Discord Rich Presence can work: the native player, and a
    /// Discord application ID set when building (`presence::APPLICATION_ID`).
    discord_presence: bool,
    /// `KIRO_SMOKE_TEST_URL`: the renderer opens the player on this URL and
    /// pauses once it plays, so CI can check playback in an installed release
    /// build (`scripts/playback-smoke.mjs --app`).
    smoke_test_url: Option<String>,
}

/// Application metadata. Infallible and side-effect free.
#[tauri::command]
pub fn app_info<R: Runtime>(app: AppHandle<R>) -> AppInfo {
    let package = app.package_info();
    AppInfo {
        name: package.name.clone(),
        version: package.version.to_string(),
        tauri_version: tauri::VERSION,
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        native_player: cfg!(native_player),
        discord_presence: cfg!(native_player) && crate::presence::is_configured(),
        smoke_test_url: std::env::var("KIRO_SMOKE_TEST_URL")
            .ok()
            .filter(|url| !url.is_empty()),
    }
}
