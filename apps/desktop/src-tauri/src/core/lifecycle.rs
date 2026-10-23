use tauri::{App, Manager, Runtime};

use crate::core::state::AppState;
use crate::storage::StoragePaths;

/// Runs once before the main window is shown. Keep this fast: anything slow
/// (indexing, network, migrations) belongs on a background task so startup
/// stays instant.
pub fn setup<R: Runtime>(app: &mut App<R>) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "android")]
    crate::android::init_tls_verifier()?;
    let storage = StoragePaths::resolve(app.handle())?;
    app.manage(AppState::new(storage));
    crate::updates::start(app.handle());
    Ok(())
}
