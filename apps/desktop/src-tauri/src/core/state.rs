use std::sync::OnceLock;

use crate::addons::defaults::default_addons;
use crate::addons::registry::AddonRegistry;
use crate::addons::requests::InflightRequests;
use crate::addons::transport::HttpTransport;
use crate::core::error::Result;
use crate::library::Library;
use crate::settings::SettingsStore;
use crate::skip_times::SkipTimesService;
use crate::storage::StoragePaths;
use crate::storage::database::Database;
use crate::stremio::StremioImport;

/// Process-wide state, registered once during setup and available to commands
/// as `tauri::State<'_, AppState>`.
///
/// Subsystems add their own fields here as they are built (player sessions,
/// addon registry, database handle, ...). Anything mutable must use interior
/// mutability (`Mutex`, `RwLock`, channels) because commands run concurrently.
#[derive(Debug)]
pub struct AppState {
    storage: StoragePaths,
    addons: AddonRegistry,
    /// Opens its database on first use.
    library: Library,
    /// Created on first use, keeping TLS setup out of startup.
    addon_transport: OnceLock<HttpTransport>,
    /// Addon requests the renderer can cancel.
    addon_requests: InflightRequests,
    settings: SettingsStore,
    /// Intro and credits times looked up online, cached for the session.
    skip_times: SkipTimesService,
    /// A Stremio account read for importing (never its credentials).
    stremio_import: StremioImport,
}

impl AppState {
    pub fn new(storage: StoragePaths) -> Self {
        Self {
            addons: AddonRegistry::new(&storage.config_dir).with_defaults(default_addons()),
            library: Library::new(Database::new(&storage.data_dir)),
            settings: SettingsStore::new(&storage.config_dir),
            storage,
            addon_transport: OnceLock::new(),
            addon_requests: InflightRequests::default(),
            skip_times: SkipTimesService::default(),
            stremio_import: StremioImport::default(),
        }
    }

    pub fn storage(&self) -> &StoragePaths {
        &self.storage
    }

    pub fn addons(&self) -> &AddonRegistry {
        &self.addons
    }

    pub fn library(&self) -> &Library {
        &self.library
    }

    pub fn settings(&self) -> &SettingsStore {
        &self.settings
    }

    pub fn skip_times(&self) -> &SkipTimesService {
        &self.skip_times
    }

    pub fn stremio_import(&self) -> &StremioImport {
        &self.stremio_import
    }

    pub fn addon_requests(&self) -> &InflightRequests {
        &self.addon_requests
    }

    pub fn addon_transport(&self) -> Result<&HttpTransport> {
        if let Some(transport) = self.addon_transport.get() {
            return Ok(transport);
        }
        let transport = HttpTransport::new()?;
        Ok(self.addon_transport.get_or_init(|| transport))
    }
}
