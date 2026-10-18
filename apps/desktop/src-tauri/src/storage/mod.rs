//! Local persistence. Kiro's core features (library, history, settings, caches)
//! are stored on-device so the app works without the cloud API.
//!
//! - [`database`] — the SQLite database behind the library and watch history

pub mod database;

use std::path::PathBuf;

use tauri::{AppHandle, Manager, Runtime};

use crate::core::error::Result;

/// Per-user directories owned by Kiro.
///
/// Resolved at startup but created lazily by the subsystem that first writes to
/// them, so launching a fresh install does not touch the filesystem. These
/// paths are never sent to the renderer.
#[derive(Debug, Clone)]
pub struct StoragePaths {
    /// Durable user data (library database, watch history).
    pub data_dir: PathBuf,
    /// Disposable data (artwork, metadata responses). Safe to delete.
    pub cache_dir: PathBuf,
    /// User preferences.
    pub config_dir: PathBuf,
}

impl StoragePaths {
    pub fn resolve<R: Runtime>(app: &AppHandle<R>) -> Result<Self> {
        let paths = app.path();
        Ok(Self {
            data_dir: paths.app_data_dir()?,
            cache_dir: paths.app_cache_dir()?,
            config_dir: paths.app_config_dir()?,
        })
    }
}
