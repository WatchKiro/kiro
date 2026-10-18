//! Importing a Stremio account (`crate::stremio`): sign in and preview, then
//! import the chosen parts of the library. Addons are installed by the
//! renderer through the usual install commands.

use tauri::State;

use crate::core::error::Result;
use crate::core::state::AppState;
use crate::library::COMPLETED_FRACTION;
use crate::stremio::{ImportPreview, LibraryChoice, LibraryImportSummary, SignIn, StremioApi};

/// Signs in to Stremio, reads the account's addons and library, and returns
/// what an import would bring over. The sign-in is used for this call only:
/// it is never stored or logged, and a session Kiro started is signed out
/// before this returns.
#[tauri::command]
pub async fn stremio_import_fetch(
    sign_in: SignIn,
    state: State<'_, AppState>,
) -> Result<ImportPreview> {
    let installed = state.addons().list()?;
    let threshold = state
        .settings()
        .get()
        .map(|settings| settings.playback.completed_fraction())
        .unwrap_or(COMPLETED_FRACTION);
    let api = StremioApi::new()?;
    Ok(state
        .stremio_import()
        .fetch(&api, sign_in, &installed, threshold)
        .await?)
}

/// Imports the chosen parts of the fetched library, merging with Kiro's
/// (newer Kiro progress wins), and forgets the fetched account.
#[tauri::command]
pub async fn stremio_import_library(
    choice: LibraryChoice,
    state: State<'_, AppState>,
) -> Result<LibraryImportSummary> {
    state
        .stremio_import()
        .apply_library(state.library(), choice)
}

/// Forgets a fetched account without importing it.
#[tauri::command]
pub fn stremio_import_discard(state: State<'_, AppState>) {
    state.stremio_import().discard();
}
