//! Kiro updating itself, through Tauri's updater plugin.
//!
//! Release builds check at launch and then once a day. A newer version is
//! downloaded in the background and its signature checked against the public
//! key in `tauri.conf.json`; the renderer then offers "Restart to update".
//! Installs that can't replace themselves (the Linux .deb) are told about the
//! new version and pointed at its download page instead. Development builds
//! never check.
//!
//! Builds whose version is a pre-release (`0.2.0-beta.1`) follow the beta
//! feed, which the release workflow moves to every published release, betas
//! included. Other builds follow GitHub's latest stable release. See
//! docs/releasing.md, Auto-update.

use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tauri::utils::config::BundleType;
use tauri::utils::platform::bundle_type;
use tauri::{AppHandle, Manager, Runtime, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::core::error::{Error, Result};

/// The newest stable release's update manifest (GitHub's "latest" skips pre-releases).
const STABLE_FEED: &str = "https://github.com/WatchKiro/kiro/releases/latest/download/latest.json";
/// The newest release of any kind, kept on the `updater` release by
/// `.github/workflows/update-feed.yml`.
const BETA_FEED: &str = "https://github.com/WatchKiro/kiro/releases/download/updater/beta.json";
const RELEASES_PAGE: &str = "https://github.com/WatchKiro/kiro/releases";

/// How often a running Kiro looks for a new version.
const CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
/// How often the background task wakes to see whether a check is due. The
/// interval is measured on the wall clock, so a computer that slept through
/// the night checks soon after waking.
const WAKE_INTERVAL: Duration = Duration::from_secs(60 * 60);
/// Waits after launch before the first check, so it doesn't compete with startup.
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(5);

/// Where updating stands. Mirrored by `UpdateStatus` in
/// `apps/desktop/src/services/native.ts`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum UpdateStatus {
    /// A development build: it never checks.
    Disabled,
    /// Not checked yet.
    Idle,
    Checking,
    UpToDate,
    /// A newer version is being downloaded.
    Downloading {
        version: String,
    },
    /// Downloaded and verified: restarting installs it.
    Ready {
        version: String,
    },
    /// A newer version this install can't apply itself (the .deb): download it.
    Available {
        version: String,
    },
    /// Checking or downloading failed. `message` is written for the user.
    Failed {
        message: String,
    },
}

/// The updater's state, managed by Tauri for the commands.
pub struct Updates {
    inner: Mutex<Inner>,
}

struct Inner {
    status: UpdateStatus,
    /// The verified download, once `status` is `Ready`.
    downloaded: Option<(Update, Vec<u8>)>,
    last_check: Option<SystemTime>,
}

impl Default for Updates {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner {
                status: if enabled() {
                    UpdateStatus::Idle
                } else {
                    UpdateStatus::Disabled
                },
                downloaded: None,
                last_check: None,
            }),
        }
    }
}

/// Whether this build updates itself: release builds only.
pub fn enabled() -> bool {
    !cfg!(debug_assertions)
}

/// Whether this install can replace itself with a downloaded update: the
/// macOS app, the Windows (NSIS) install and the AppImage. Not the .deb,
/// whose files belong to the package manager.
pub fn can_install() -> bool {
    can_install_bundle(bundle_type())
}

fn can_install_bundle(bundle: Option<BundleType>) -> bool {
    matches!(
        bundle,
        Some(BundleType::App | BundleType::Nsis | BundleType::AppImage)
    )
}

/// The update manifest this build follows: `KIRO_UPDATE_FEED` if set (for
/// testing; release builds still only accept https, unless built with
/// `dangerousInsecureTransportProtocol`, and a correctly signed update),
/// otherwise the beta feed for pre-release versions and the stable one for
/// the rest.
fn feed_url(version: &semver::Version) -> Result<Url> {
    let url = match std::env::var("KIRO_UPDATE_FEED") {
        Ok(url) if !url.is_empty() => url,
        _ if !version.pre.is_empty() => BETA_FEED.to_owned(),
        _ => STABLE_FEED.to_owned(),
    };
    url.parse()
        .map_err(|_| Error::Internal("invalid update feed URL".into()))
}

impl Updates {
    pub fn status(&self) -> UpdateStatus {
        self.lock().status.clone()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn set_status(&self, status: UpdateStatus) {
        self.lock().status = status;
    }

    /// Checks for a newer version now and, if there is one this install can
    /// apply, downloads it before returning. A check already under way, or
    /// a download, is left to finish and its status returned.
    pub async fn check<R: Runtime>(&self, app: &AppHandle<R>) -> UpdateStatus {
        {
            let mut inner = self.lock();
            match inner.status {
                UpdateStatus::Disabled
                | UpdateStatus::Checking
                | UpdateStatus::Downloading { .. } => return inner.status.clone(),
                // Keep offering a downloaded update while looking for a newer one.
                UpdateStatus::Ready { .. } => {}
                _ => inner.status = UpdateStatus::Checking,
            }
            inner.last_check = Some(SystemTime::now());
        }

        let update = match find_update(app).await {
            Ok(update) => update,
            Err(error) => {
                eprintln!("[kiro-updates] check failed: {error}");
                return self.finish_check(UpdateStatus::Failed {
                    message: "Couldn’t check for updates. Check your connection and try again."
                        .into(),
                });
            }
        };
        let Some(update) = update else {
            return self.finish_check(UpdateStatus::UpToDate);
        };
        let version = update.version.clone();
        if !can_install() {
            return self.finish_check(UpdateStatus::Available { version });
        }
        if matches!(&self.status(), UpdateStatus::Ready { version: ready } if *ready == version) {
            return self.status();
        }

        // A newer version replaces one downloaded earlier.
        self.lock().status = UpdateStatus::Downloading {
            version: version.clone(),
        };
        match update.download(|_, _| {}, || {}).await {
            Ok(bytes) => {
                let mut inner = self.lock();
                inner.downloaded = Some((update, bytes));
                inner.status = UpdateStatus::Ready { version };
                inner.status.clone()
            }
            Err(error) => {
                eprintln!("[kiro-updates] download of {version} failed: {error}");
                let mut inner = self.lock();
                inner.status = match &inner.downloaded {
                    Some((ready, _)) => UpdateStatus::Ready {
                        version: ready.version.clone(),
                    },
                    None => UpdateStatus::Failed {
                        message: format!("Couldn’t download Kiro {version}. Try again later."),
                    },
                };
                inner.status.clone()
            }
        }
    }

    /// Ends a check that downloads nothing, without hiding a download that's ready.
    fn finish_check(&self, status: UpdateStatus) -> UpdateStatus {
        let mut inner = self.lock();
        if !matches!(inner.status, UpdateStatus::Ready { .. }) {
            inner.status = status;
        }
        inner.status.clone()
    }

    /// Whether the daily check is due.
    fn check_due(&self) -> bool {
        // A clock that went backwards (an error here) makes it due, rather
        // than waiting for the clock to catch up.
        self.lock().last_check.is_none_or(|last| {
            !matches!(SystemTime::now().duration_since(last), Ok(elapsed) if elapsed < CHECK_INTERVAL)
        })
    }

    /// Installs the downloaded update and restarts Kiro into it. On Windows
    /// the installer takes over and Kiro quits straight away.
    pub fn install_and_restart<R: Runtime>(&self, app: &AppHandle<R>) -> Result<()> {
        let Some((update, bytes)) = self.lock().downloaded.take() else {
            return Err(Error::invalid_argument("no update has been downloaded"));
        };
        if let Err(error) = update.install(&bytes) {
            eprintln!(
                "[kiro-updates] install of {} failed: {error}",
                update.version
            );
            self.set_status(UpdateStatus::Failed {
                message: format!(
                    "Couldn’t install Kiro {}. Download it from the Kiro website instead.",
                    update.version
                ),
            });
            return Err(Error::Internal("the update could not be installed".into()));
        }
        app.restart()
    }
}

/// Testing the updater end to end (docs/releasing.md, Auto-update): with
/// `KIRO_UPDATE_AUTO_INSTALL=1` as well as a `KIRO_UPDATE_FEED`, an update is
/// installed, and Kiro restarted, as soon as it's downloaded and verified,
/// instead of waiting for Restart to update. Ignored without a test feed.
fn install_without_asking() -> bool {
    std::env::var_os("KIRO_UPDATE_FEED").is_some_and(|feed| !feed.is_empty())
        && std::env::var_os("KIRO_UPDATE_AUTO_INSTALL").is_some_and(|value| value == "1")
}

/// Asks the feed whether there's a newer version. A feed that isn't there
/// yet (nothing published to it) means there's nothing to update to.
async fn find_update<R: Runtime>(app: &AppHandle<R>) -> Result<Option<Update>, String> {
    let url = feed_url(&app.package_info().version).map_err(|error| error.to_string())?;
    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .and_then(|builder| builder.timeout(Duration::from_secs(60)).build())
        .map_err(|error| error.to_string())?;
    match updater.check().await {
        Ok(update) => Ok(update),
        Err(tauri_plugin_updater::Error::ReleaseNotFound) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

/// Starts the launch and daily checks, in release builds.
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    if !enabled() {
        return;
    }
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("kiro-updates".into())
        .spawn(move || {
            std::thread::sleep(FIRST_CHECK_DELAY);
            loop {
                let updates = app.state::<Updates>();
                if updates.check_due() {
                    let status = tauri::async_runtime::block_on(updates.check(&app));
                    if matches!(status, UpdateStatus::Ready { .. }) && install_without_asking() {
                        eprintln!(
                            "[kiro-updates] installing without asking (KIRO_UPDATE_AUTO_INSTALL)"
                        );
                        let _ = updates.install_and_restart(&app);
                    }
                }
                std::thread::sleep(WAKE_INTERVAL);
            }
        });
    if let Err(error) = spawned {
        eprintln!("[kiro-updates] could not start: {error}");
    }
}

/// The release page of `version`, for installs that can't update themselves.
pub fn release_page(version: &str) -> Result<Url> {
    let version = semver::Version::parse(version)
        .map_err(|_| Error::invalid_argument("not a version number"))?;
    format!("{RELEASES_PAGE}/tag/v{version}")
        .parse()
        .map_err(|_| Error::invalid_argument("not a version number"))
}

/// Opens `url` in the default browser.
pub fn open_in_browser(url: &Url) -> Result<()> {
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut command = std::process::Command::new("explorer");
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut command = std::process::Command::new("xdg-open");
    command.arg(url.as_str()).spawn()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_bundles_that_replace_themselves_install_updates() {
        assert!(can_install_bundle(Some(BundleType::App)));
        assert!(can_install_bundle(Some(BundleType::Nsis)));
        assert!(can_install_bundle(Some(BundleType::AppImage)));
        assert!(!can_install_bundle(Some(BundleType::Deb)));
        assert!(!can_install_bundle(Some(BundleType::Rpm)));
        assert!(!can_install_bundle(None));
    }

    #[test]
    fn betas_follow_the_beta_feed() {
        let beta = semver::Version::parse("0.2.0-beta.1").unwrap();
        let stable = semver::Version::parse("0.2.0").unwrap();
        assert_eq!(feed_url(&beta).unwrap().as_str(), BETA_FEED);
        assert_eq!(feed_url(&stable).unwrap().as_str(), STABLE_FEED);
    }

    #[test]
    fn release_pages_take_only_version_numbers() {
        assert_eq!(
            release_page("0.2.0-beta.1").unwrap().as_str(),
            "https://github.com/WatchKiro/kiro/releases/tag/v0.2.0-beta.1"
        );
        for bad in ["", "../../evil", "1.0.0/../../x", "1.0.0?x=1"] {
            assert!(release_page(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn status_serializes_for_the_renderer() {
        assert_eq!(
            serde_json::to_value(UpdateStatus::Ready {
                version: "0.2.0".into()
            })
            .unwrap(),
            serde_json::json!({ "state": "ready", "version": "0.2.0" })
        );
        assert_eq!(
            serde_json::to_value(UpdateStatus::UpToDate).unwrap(),
            serde_json::json!({ "state": "upToDate" })
        );
    }

    #[test]
    fn development_builds_never_check() {
        let expected = if cfg!(debug_assertions) {
            UpdateStatus::Disabled
        } else {
            UpdateStatus::Idle
        };
        assert_eq!(Updates::default().status(), expected);
    }
}
