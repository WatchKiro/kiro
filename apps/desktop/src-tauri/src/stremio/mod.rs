//! Importing a Stremio account: its addons, library and watch progress.
//!
//! Two steps, so the user can choose what to bring over:
//!
//! 1. [`StremioImport::fetch`] signs in, reads the addon collection and the
//!    library, and returns a preview with counts. The sign-in is used for
//!    those two reads only: a session Kiro started (email and password) is
//!    signed out straight away, and the credentials are dropped. Neither is
//!    ever written anywhere or logged. What was read stays in memory, mapped
//!    to Kiro's types, until step 2 or [`StremioImport::discard`].
//! 2. [`StremioImport::apply_library`] merges the chosen parts into the
//!    library. Addons are installed by the renderer through the usual install
//!    path (fetch the manifest, validate it with `@kiro/addon-sdk`), in
//!    Stremio's order, so they land after Kiro's defaults.
//!
//! - [`api`]  — the Stremio API calls
//! - [`data`] — reading Stremio's data and mapping it to Kiro's

pub mod api;
pub mod data;

use std::sync::Mutex;

use serde::{Deserialize, Serialize};

pub use api::{SignIn, StremioApi, StremioError};
pub use data::{AddonStatus, StremioAddon};

use crate::addons::registry::InstalledAddon;
use crate::core::error::{Error, Result};
use crate::library::{ImportCounts, ProfileLibrary};
use data::LibraryImport;

/// What a Stremio account holds, as Kiro would import it.
///
/// Mirrored by `StremioImportPreview` in `apps/desktop/src/services/native.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    /// Every addon in the collection, in Stremio's order.
    pub addons: Vec<StremioAddon>,
    /// Titles saved in the Stremio library (Kiro's watchlist).
    pub library_items: u32,
    /// Titles with watch progress (Kiro's history).
    pub watched: u32,
    /// Of those, the ones "Continue watching" will offer to resume.
    pub in_progress: u32,
    /// Library items Kiro could not read or has no use for.
    pub skipped: u32,
}

/// Which parts of the library to import.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryChoice {
    #[serde(default)]
    pub library_items: bool,
    #[serde(default)]
    pub progress: bool,
}

/// What the library import did; `None` for a part that wasn't chosen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryImportSummary {
    pub library_items: Option<ImportCounts>,
    pub progress: Option<ImportCounts>,
}

/// The import in progress: what was fetched, waiting for the user to choose.
#[derive(Debug, Default)]
pub struct StremioImport {
    pending: Mutex<Option<LibraryImport>>,
}

impl StremioImport {
    /// Signs in with `sign_in`, reads the account and returns what it holds.
    /// `installed` marks addons Kiro already has; `completed_fraction` is the
    /// "Mark as watched at" setting. Replaces any earlier fetch.
    pub async fn fetch(
        &self,
        api: &StremioApi,
        sign_in: SignIn,
        installed: &[InstalledAddon],
        completed_fraction: f64,
    ) -> Result<ImportPreview, StremioError> {
        sign_in.validate()?;
        let (auth_key, signed_in_here) = match sign_in {
            SignIn::AuthKey { auth_key } => (auth_key, false),
            SignIn::Password { email, password } => {
                (api.login(email.trim(), &password).await?, true)
            }
        };
        let fetched = async {
            let addons = api.addon_collection(&auth_key).await?;
            let library = api.library_items(&auth_key).await?;
            Ok::<_, StremioError>((addons, library))
        }
        .await;
        // A pasted key is the user's own session (their browser's): leave it.
        if signed_in_here {
            api.logout(&auth_key).await;
        }
        drop(auth_key);
        let (addons, library) = fetched?;

        let addons = data::read_addons(&addons, installed);
        let library = data::read_library(&library, completed_fraction);
        let preview = ImportPreview {
            addons,
            library_items: count(library.watchlist.len()),
            watched: count(library.progress.len()),
            in_progress: count(library.in_progress()),
            skipped: library.skipped,
        };
        *self.pending.lock().unwrap_or_else(|e| e.into_inner()) = Some(library);
        Ok(preview)
    }

    /// Merges the chosen parts of the fetched library, then forgets it.
    pub fn apply_library(
        &self,
        library: &ProfileLibrary<'_>,
        choice: LibraryChoice,
    ) -> Result<LibraryImportSummary> {
        let pending = self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
            .ok_or_else(|| Error::invalid_argument("Sign in to Stremio again to import."))?;
        Ok(LibraryImportSummary {
            library_items: choice
                .library_items
                .then(|| library.import_watchlist(&pending.watchlist))
                .transpose()?,
            progress: choice
                .progress
                .then(|| library.import_history(&pending.progress))
                .transpose()?,
        })
    }

    /// Forgets a fetched account without importing it.
    pub fn discard(&self) {
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
    }
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};
    use std::thread;

    use serde_json::{Value, json};

    use super::*;
    use crate::addons::AddonUrl;
    use crate::addons::defaults::default_addons;
    use crate::addons::registry::AddonRegistry;
    use crate::library::{COMPLETED_FRACTION, Library};
    use crate::profiles::FIRST_PROFILE;
    use crate::settings::SettingsStore;
    use crate::storage::database::Database;
    use crate::storage::database::tests::temp_dir;

    const KEY: &str = "FIXTURE-SESSION-KEY-0000000000000000000000000000";
    const PASTED_KEY: &str = "PASTED-BROWSER-KEY-1111111111111111";
    const PASSWORD: &str = "correct-horse-FIXTURE-password";

    /// A request the fake Stremio received: path and JSON body.
    type Seen = Arc<Mutex<Vec<(String, Value)>>>;

    /// A fake Stremio API on a loopback port, answering from the fixtures.
    /// It accepts [`KEY`] (from logging in with [`PASSWORD`]) and
    /// [`PASTED_KEY`].
    fn fake_stremio() -> (StremioApi, Seen) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen: Seen = Arc::default();
        let log = seen.clone();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { break };
                respond(stream, &log);
            }
        });
        let base = AddonUrl::parse(&format!("http://127.0.0.1:{port}/api/")).unwrap();
        (StremioApi::with_base(base).unwrap(), seen)
    }

    fn respond(mut stream: TcpStream, seen: &Seen) {
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut request_line = String::new();
        reader.read_line(&mut request_line).unwrap();
        let path = request_line
            .split_whitespace()
            .nth(1)
            .unwrap_or_default()
            .to_owned();
        let mut length = 0;
        loop {
            let mut header = String::new();
            reader.read_line(&mut header).unwrap();
            if header.trim().is_empty() {
                break;
            }
            if let Some((name, value)) = header.split_once(':')
                && name.eq_ignore_ascii_case("content-length")
            {
                length = value.trim().parse().unwrap();
            }
        }
        let mut body = vec![0; length];
        reader.read_exact(&mut body).unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        seen.lock().unwrap().push((path.clone(), body.clone()));

        let session = body["authKey"].as_str();
        let valid_session = matches!(session, Some(KEY | PASTED_KEY));
        let no_session = r#"{"error":{"code":1,"message":"Session does not exist"}}"#;
        let response = match path.as_str() {
            "/api/login" if body["password"] == PASSWORD => {
                include_str!("fixtures/login.json")
            }
            "/api/login" => r#"{"error":{"code":3,"message":"Wrong passphrase"}}"#,
            "/api/logout" => r#"{"result":{"success":true}}"#,
            "/api/addonCollectionGet" if valid_session => {
                include_str!("fixtures/addon-collection.json")
            }
            "/api/datastoreGet" if valid_session && body["collection"] == "libraryItem" => {
                include_str!("fixtures/library.json")
            }
            _ => no_session,
        };
        let _ = write!(
            stream,
            "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{response}",
            response.len()
        );
    }

    fn paths(seen: &Seen) -> Vec<String> {
        seen.lock()
            .unwrap()
            .iter()
            .map(|(path, _)| path.clone())
            .collect()
    }

    fn sign_in(value: Value) -> SignIn {
        serde_json::from_value(value).unwrap()
    }

    fn password_sign_in(password: &str) -> SignIn {
        sign_in(
            json!({ "method": "password", "email": " someone@example.com ", "password": password }),
        )
    }

    fn block_on<T>(future: impl Future<Output = T>) -> T {
        tauri::async_runtime::block_on(future)
    }

    #[test]
    fn imports_an_account_signed_in_with_a_password_then_signs_out() {
        let (api, seen) = fake_stremio();
        let import = StremioImport::default();
        let preview = block_on(import.fetch(
            &api,
            password_sign_in(PASSWORD),
            &default_addons(),
            COMPLETED_FRACTION,
        ))
        .unwrap();

        assert_eq!(
            paths(&seen),
            [
                "/api/login",
                "/api/addonCollectionGet",
                "/api/datastoreGet",
                "/api/logout"
            ]
        );
        let requests = seen.lock().unwrap().clone();
        assert_eq!(requests[0].1["email"], "someone@example.com");
        // The session Kiro started is the one signed out.
        assert_eq!(requests[3].1["authKey"], KEY);

        let new: Vec<_> = preview
            .addons
            .iter()
            .filter(|addon| addon.status == AddonStatus::New)
            .map(|addon| addon.name.as_str())
            .collect();
        assert_eq!(new, ["WatchHub", "Example Streams", "org.example.unnamed"]);
        assert_eq!(
            (
                preview.library_items,
                preview.watched,
                preview.in_progress,
                preview.skipped
            ),
            (5, 5, 3, 5)
        );
    }

    #[test]
    fn a_pasted_key_is_used_but_its_session_left_alone() {
        let (api, seen) = fake_stremio();
        let import = StremioImport::default();
        block_on(import.fetch(
            &api,
            sign_in(json!({ "method": "authKey", "authKey": PASTED_KEY })),
            &[],
            COMPLETED_FRACTION,
        ))
        .unwrap();
        assert_eq!(
            paths(&seen),
            ["/api/addonCollectionGet", "/api/datastoreGet"]
        );
    }

    #[test]
    fn reports_rejected_credentials() {
        let (api, seen) = fake_stremio();
        let import = StremioImport::default();
        assert_eq!(
            block_on(import.fetch(&api, password_sign_in("wrong"), &[], 0.9)),
            Err(StremioError::WrongPassword)
        );
        assert_eq!(paths(&seen), ["/api/login"]);

        let stale = sign_in(json!({ "method": "authKey", "authKey": "EXPIRED" }));
        assert_eq!(
            block_on(import.fetch(&api, stale, &[], 0.9)),
            Err(StremioError::InvalidSession)
        );
        // Nothing was fetched, so there is nothing to import.
        let dir = temp_dir("stremio-nothing");
        let all = Library::new(Arc::new(Database::new(&dir)));
        let library = all.profile(FIRST_PROFILE);
        assert!(
            import
                .apply_library(&library, LibraryChoice::default())
                .is_err()
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn signs_out_even_when_reading_the_account_fails() {
        // A server that accepts the login but fails everything else.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen: Seen = Arc::default();
        let log = seen.clone();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut request = [0; 8192];
                let read = stream.read(&mut request).unwrap_or(0);
                let text = String::from_utf8_lossy(&request[..read]).into_owned();
                let path = text
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or_default()
                    .to_owned();
                log.lock().unwrap().push((path.clone(), Value::Null));
                let response: &str = if path == "/api/login" {
                    include_str!("fixtures/login.json")
                } else {
                    "<html>"
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{response}",
                    response.len()
                );
            }
        });
        let api = StremioApi::with_base(
            AddonUrl::parse(&format!("http://127.0.0.1:{port}/api/")).unwrap(),
        )
        .unwrap();
        let result =
            block_on(StremioImport::default().fetch(&api, password_sign_in(PASSWORD), &[], 0.9));
        assert_eq!(result, Err(StremioError::UnexpectedResponse));
        assert_eq!(
            paths(&seen),
            ["/api/login", "/api/addonCollectionGet", "/api/logout"]
        );
    }

    #[test]
    fn rejects_bad_sign_ins_before_sending_anything() {
        let (api, seen) = fake_stremio();
        let result = block_on(StremioImport::default().fetch(
            &api,
            sign_in(json!({ "method": "authKey", "authKey": "two words" })),
            &[],
            0.9,
        ));
        assert_eq!(result, Err(StremioError::InvalidSignIn));
        assert!(paths(&seen).is_empty());
    }

    #[test]
    fn applies_only_the_chosen_parts_once() {
        let (api, _) = fake_stremio();
        let dir = temp_dir("stremio-apply");
        let all = Library::new(Arc::new(Database::new(&dir)));
        let library = all.profile(FIRST_PROFILE);
        let import = StremioImport::default();
        let fetch = || {
            block_on(import.fetch(
                &api,
                sign_in(json!({ "method": "authKey", "authKey": PASTED_KEY })),
                &[],
                COMPLETED_FRACTION,
            ))
            .unwrap()
        };

        fetch();
        let summary = import
            .apply_library(
                &library,
                LibraryChoice {
                    library_items: false,
                    progress: true,
                },
            )
            .unwrap();
        assert_eq!(summary.library_items, None);
        assert_eq!(summary.progress.unwrap().added, 5);
        assert!(library.watchlist().unwrap().is_empty());
        let resume = library.continue_watching(None).unwrap();
        // Unfinished films and episodes, newest first; finished films are
        // history only.
        let ids: Vec<_> = resume.iter().map(|entry| entry.title.id.as_str()).collect();
        assert_eq!(ids, ["tt0000001", "tt0000002", "tt0000005"]);
        // Applied once: the fetched data is gone.
        assert!(
            import
                .apply_library(&library, LibraryChoice::default())
                .is_err()
        );

        // Fetching again and importing everything only adds what's new.
        fetch();
        let summary = import
            .apply_library(
                &library,
                LibraryChoice {
                    library_items: true,
                    progress: true,
                },
            )
            .unwrap();
        assert_eq!(summary.library_items.unwrap().added, 5);
        let progress = summary.progress.unwrap();
        assert_eq!((progress.added, progress.skipped), (0, 5));

        fetch();
        import.discard();
        assert!(
            import
                .apply_library(&library, LibraryChoice::default())
                .is_err()
        );
        let _ = fs::remove_dir_all(dir);
    }

    /// Every file under `dir`, read as bytes.
    fn files(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        let mut found = Vec::new();
        let Ok(entries) = fs::read_dir(dir) else {
            return found;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                found.extend(files(&path));
            } else if let Ok(bytes) = fs::read(&path) {
                found.push((path, bytes));
            }
        }
        found
    }

    fn contains(haystack: &[u8], needle: &str) -> bool {
        haystack
            .windows(needle.len())
            .any(|window| window == needle.as_bytes())
    }

    #[test]
    fn credentials_are_never_persisted() {
        let (api, _) = fake_stremio();
        let dir = temp_dir("stremio-secrets");
        // The app's real stores, in one directory: addons, settings, library.
        let registry = AddonRegistry::new(&dir).with_defaults(default_addons());
        let settings = SettingsStore::new(&dir);
        let all = Library::new(Arc::new(Database::new(&dir)));
        let library = all.profile(FIRST_PROFILE);
        let import = StremioImport::default();

        for sign_in_with in [
            password_sign_in(PASSWORD),
            sign_in(json!({ "method": "authKey", "authKey": PASTED_KEY })),
        ] {
            let threshold = settings.get().unwrap().playback.completed_fraction();
            let preview =
                block_on(import.fetch(&api, sign_in_with, &registry.list().unwrap(), threshold))
                    .unwrap();
            // Nothing the renderer receives carries a credential either.
            let json = serde_json::to_string(&preview).unwrap();
            for secret in [KEY, PASTED_KEY, PASSWORD] {
                assert!(!json.contains(secret));
            }
            import
                .apply_library(
                    &library,
                    LibraryChoice {
                        library_items: true,
                        progress: true,
                    },
                )
                .unwrap();
        }
        assert!(!library.watchlist().unwrap().is_empty());

        let stored = files(&dir);
        assert!(!stored.is_empty());
        for (path, bytes) in stored {
            for secret in [KEY, PASTED_KEY, PASSWORD, "someone@example.com"] {
                assert!(
                    !contains(&bytes, secret),
                    "{} contains a credential",
                    path.display()
                );
            }
        }
        let _ = fs::remove_dir_all(dir);
    }
}
