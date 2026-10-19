//! Updating Kiro itself (`crate::updates`): where it stands, checking now,
//! and installing a downloaded update.

use tauri::{AppHandle, Runtime, State};

use crate::core::error::Result;
use crate::updates::{UpdateStatus, Updates};

/// Where updating stands. Cheap: the renderer polls it.
#[tauri::command]
pub fn app_update_status(updates: State<'_, Updates>) -> UpdateStatus {
    updates.status()
}

/// Checks for a newer version now (Settings → Check for updates) and
/// downloads it if this install can apply it. Does nothing in development
/// builds.
#[tauri::command]
pub async fn app_update_check<R: Runtime>(
    app: AppHandle<R>,
    updates: State<'_, Updates>,
) -> Result<UpdateStatus> {
    Ok(updates.check(&app).await)
}

/// Installs the downloaded update and restarts into it.
#[tauri::command]
pub fn app_update_install<R: Runtime>(
    app: AppHandle<R>,
    updates: State<'_, Updates>,
) -> Result<()> {
    updates.install_and_restart(&app)
}

/// Opens the release page of `version` in the browser, for installs that
/// can't update themselves (the Linux .deb). Only GitHub release pages of
/// Kiro can be opened.
#[tauri::command]
pub fn app_update_open_download(version: String) -> Result<()> {
    crate::updates::open_in_browser(&crate::updates::release_page(&version)?)
}
