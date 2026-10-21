//! Settings commands: the user's preferences (`crate::settings`).
//!
//! `async` so file I/O runs off the main thread.

use tauri::{AppHandle, Runtime, State};

use crate::core::error::Result;
use crate::core::state::AppState;
use crate::settings::Settings;

/// The active profile's settings (defaults for anything not saved yet).
#[tauri::command]
pub async fn settings_get(state: State<'_, AppState>) -> Result<Settings> {
    state.settings()?.get()
}

/// Replaces the active profile's settings and returns what was stored.
/// Settings the core applies itself take effect straight away.
#[tauri::command]
pub async fn settings_set<R: Runtime>(
    settings: Settings,
    app: AppHandle<R>,
    state: State<'_, AppState>,
) -> Result<Settings> {
    let stored = state.settings()?.set(settings)?;
    apply(&app, &stored);
    Ok(stored)
}

/// Applies the settings the core uses itself: keeping the screen on, audio
/// passthrough and Discord. Also after switching profiles.
pub(crate) fn apply<R: Runtime>(app: &AppHandle<R>, settings: &Settings) {
    #[cfg(native_player)]
    if let Some(player) = tauri::Manager::try_state::<crate::commands::player::PlayerState>(app) {
        player.set_keep_screen_on(settings.playback.keep_screen_on);
        player.set_audio_spdif(&settings.playback.audio_spdif());
        player.set_presence_options((&settings.general).into());
    }
    #[cfg(not(native_player))]
    let _ = (app, settings);
}
