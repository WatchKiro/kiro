//! Settings commands: the user's preferences (`crate::settings`).
//!
//! `async` so file I/O runs off the main thread.

use tauri::{AppHandle, Runtime, State};

use crate::core::error::Result;
use crate::core::state::AppState;
use crate::settings::Settings;

/// The stored settings (defaults for anything not saved yet).
#[tauri::command]
pub async fn settings_get(state: State<'_, AppState>) -> Result<Settings> {
    state.settings().get()
}

/// Replaces the settings and returns what was stored. Settings the core
/// applies itself take effect straight away.
#[tauri::command]
pub async fn settings_set<R: Runtime>(
    settings: Settings,
    app: AppHandle<R>,
    state: State<'_, AppState>,
) -> Result<Settings> {
    let stored = state.settings().set(settings)?;
    #[cfg(native_player)]
    if let Some(player) = tauri::Manager::try_state::<crate::commands::player::PlayerState>(&app) {
        player.set_keep_screen_on(stored.playback.keep_screen_on);
        player.set_presence_options((&stored.general).into());
    }
    #[cfg(not(native_player))]
    let _ = app;
    Ok(stored)
}
