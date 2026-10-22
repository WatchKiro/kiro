//! Kiro desktop native core.
//!
//! The React renderer talks to this crate only through the commands registered
//! in [`app_builder`], and each command must also be granted to a window by a
//! capability in `capabilities/`. Everything else stays native.
//!
//! - [`commands`] — Tauri command handlers (the renderer-facing surface)
//! - [`core`]     — lifecycle, shared state and error types
//! - [`media`]    — native playback (libmpv backend behind the `libmpv` feature)
//! - [`addons`]   — addon endpoint policy, HTTP transport and installed addons
//! - [`library`]  — watchlist and watch history
//! - [`presence`] — Discord Rich Presence while a video plays (off unless chosen)
//! - [`profiles`] — profiles: whose library and settings the app shows
//! - [`settings`] — user preferences
//! - [`skip_times`] — intro and credits times looked up online (SkipDB)
//! - [`storage`]  — local persistence locations and the SQLite database
//! - [`stremio`]  — importing a Stremio account (addons, library, progress)
//! - [`updates`]  — Kiro updating itself (release builds)

pub mod addons;
mod commands;
pub mod core;
pub mod library;
pub mod media;
pub mod presence;
pub mod profiles;
pub mod settings;
pub mod skip_times;
pub mod storage;
pub mod stremio;
pub mod updates;

use tauri::{Builder, Runtime};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    app_builder(Builder::default())
        .build(context())
        .expect("failed to build the Kiro desktop application")
        .run(|_app, _event| {
            // Quitting: release the display assertion the player may hold.
            #[cfg(native_player)]
            if let tauri::RunEvent::Exit = _event {
                use tauri::Manager;
                if let Some(player) = _app.try_state::<commands::player::PlayerState>() {
                    player.release_on_exit();
                }
            }
        });
}

/// The compiled-in configuration (`tauri.conf.json`, capabilities, assets).
/// `generate_context!` may only be expanded once per crate.
fn context<R: Runtime>() -> tauri::Context<R> {
    tauri::generate_context!()
}

/// Configures the application. Generic over the runtime so the IPC tests can
/// exercise the real command and permission setup on Tauri's mock runtime.
fn app_builder<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    let builder = builder
        .setup(crate::core::lifecycle::setup)
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(updates::Updates::default());

    // The libmpv player is only compiled in with `--features libmpv` on macOS,
    // Windows and Linux (`native_player`, set by build.rs).
    #[cfg(native_player)]
    let builder = builder
        .manage(commands::player::PlayerState::default())
        .invoke_handler(tauri::generate_handler![
            commands::app::app_info,
            commands::addons::addon_fetch_manifest,
            commands::addons::addon_fetch_resource,
            commands::addons::addon_cancel_request,
            commands::addons::addon_list,
            commands::addons::addon_install,
            commands::addons::addon_uninstall,
            commands::addons::addon_set_enabled,
            commands::addons::addon_move,
            commands::addons::addon_defaults,
            commands::addons::addon_restore_defaults,
            commands::library::library_watchlist,
            commands::library::library_watchlist_add,
            commands::library::library_watchlist_remove,
            commands::library::library_record_progress,
            commands::library::library_history,
            commands::library::library_continue_watching,
            commands::library::library_title_state,
            commands::library::library_history_remove,
            commands::library::library_history_clear,
            commands::library::library_continue_dismiss,
            commands::library::library_continue_restore,
            commands::library::library_mark_watched,
            commands::library::library_mark_unwatched,
            commands::library::library_watched_titles,
            commands::settings::settings_get,
            commands::settings::settings_set,
            commands::profiles::profile_list,
            commands::profiles::profile_create,
            commands::profiles::profile_rename,
            commands::profiles::profile_set_avatar,
            commands::profiles::profile_set_pin,
            commands::profiles::profile_delete,
            commands::profiles::profile_switch,
            commands::profiles::profile_set_show_picker,
            commands::profiles::profile_finish_first_run,
            commands::skip_times::skip_times_lookup,
            commands::stremio::stremio_import_fetch,
            commands::stremio::stremio_import_library,
            commands::stremio::stremio_import_discard,
            commands::updates::app_update_status,
            commands::updates::app_update_check,
            commands::updates::app_update_install,
            commands::updates::app_update_open_download,
            commands::player::player_attach,
            commands::player::player_detach,
            commands::player::player_load,
            commands::player::player_set_now_playing,
            commands::player::player_set_paused,
            commands::player::player_seek,
            commands::player::player_set_volume,
            commands::player::player_set_muted,
            commands::player::player_stop,
            commands::player::player_select_audio_track,
            commands::player::player_select_subtitle_track,
            commands::player::player_add_subtitle,
            commands::player::player_set_subtitle_style,
            commands::player::player_set_subtitle_delay,
            commands::player::player_set_audio_delay,
            commands::player::player_set_speed,
            commands::player::player_stats,
            commands::player::player_preview,
        ]);

    #[cfg(not(native_player))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::app::app_info,
        commands::addons::addon_fetch_manifest,
        commands::addons::addon_fetch_resource,
        commands::addons::addon_cancel_request,
        commands::addons::addon_list,
        commands::addons::addon_install,
        commands::addons::addon_uninstall,
        commands::addons::addon_set_enabled,
        commands::addons::addon_move,
        commands::addons::addon_defaults,
        commands::addons::addon_restore_defaults,
        commands::library::library_watchlist,
        commands::library::library_watchlist_add,
        commands::library::library_watchlist_remove,
        commands::library::library_record_progress,
        commands::library::library_history,
        commands::library::library_continue_watching,
        commands::library::library_title_state,
        commands::library::library_history_remove,
        commands::library::library_history_clear,
        commands::library::library_continue_dismiss,
        commands::library::library_continue_restore,
        commands::library::library_mark_watched,
        commands::library::library_mark_unwatched,
        commands::library::library_watched_titles,
        commands::settings::settings_get,
        commands::settings::settings_set,
        commands::profiles::profile_list,
        commands::profiles::profile_create,
        commands::profiles::profile_rename,
        commands::profiles::profile_set_avatar,
        commands::profiles::profile_set_pin,
        commands::profiles::profile_delete,
        commands::profiles::profile_switch,
        commands::profiles::profile_set_show_picker,
        commands::profiles::profile_finish_first_run,
        commands::skip_times::skip_times_lookup,
        commands::stremio::stremio_import_fetch,
        commands::stremio::stremio_import_library,
        commands::stremio::stremio_import_discard,
        commands::updates::app_update_status,
        commands::updates::app_update_check,
        commands::updates::app_update_install,
        commands::updates::app_update_open_download,
    ]);

    builder
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    use serde_json::{Value, json};
    use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
    use tauri::test::{INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder};
    use tauri::webview::InvokeRequest;
    use tauri::{Manager, WebviewWindow};

    use crate::core::state::AppState;
    use crate::storage::StoragePaths;

    /// The real command and permission setup on the mock runtime, with storage
    /// in a fresh temporary directory instead of the user's real one.
    struct TestApp {
        window: WebviewWindow<MockRuntime>,
        dir: PathBuf,
    }

    impl TestApp {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("kiro-ipc-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);

            let app = super::app_builder(mock_builder())
                .build(super::context())
                .expect("failed to build app");
            app.manage(AppState::new(StoragePaths {
                data_dir: dir.join("data"),
                cache_dir: dir.join("cache"),
                config_dir: dir.join("config"),
            }));
            let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
                .build()
                .expect("failed to create main window");
            Self { window, dir }
        }

        /// Invokes `cmd` from the main window, as the renderer would.
        fn invoke(&self, cmd: &str, args: Value) -> Result<InvokeResponseBody, Value> {
            get_ipc_response(
                &self.window,
                InvokeRequest {
                    cmd: cmd.into(),
                    callback: CallbackFn(0),
                    error: CallbackFn(1),
                    url: "http://localhost:5173".parse().unwrap(),
                    body: InvokeBody::Json(args),
                    headers: Default::default(),
                    invoke_key: INVOKE_KEY.into(),
                },
            )
        }
    }

    impl Drop for TestApp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// Whether an error came from the ACL rather than from the command itself.
    fn is_permission_error(error: &Value) -> bool {
        error
            .as_str()
            .is_some_and(|message| message.contains("not allowed"))
    }

    #[test]
    fn app_info_is_allowed_for_the_main_window() {
        let info: Value = TestApp::new("app-info")
            .invoke("app_info", json!({}))
            .expect("app_info should be permitted by the default capability")
            .deserialize()
            .unwrap();

        assert_eq!(info["name"], "Kiro");
        assert_eq!(info["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(info["os"], std::env::consts::OS);
        assert_eq!(info["tauriVersion"], tauri::VERSION);
        assert_eq!(info["nativePlayer"], cfg!(native_player));
    }

    #[test]
    fn addon_registry_commands_round_trip() {
        let app = TestApp::new("registry");
        let url = "https://addon.example.com/manifest.json";
        let list = |app: &TestApp| -> Value {
            app.invoke("addon_list", json!({}))
                .expect("addon_list should be permitted")
                .deserialize()
                .unwrap()
        };

        // A new profile starts with the default addons; removing them sticks.
        let defaults = list(&app);
        let default_urls: Vec<_> = defaults
            .as_array()
            .unwrap()
            .iter()
            .map(|addon| addon["transportUrl"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(
            default_urls,
            [
                "https://v3-cinemeta.strem.io/manifest.json",
                "https://opensubtitles-v3.strem.io/manifest.json",
            ]
        );
        let listed: Value = app
            .invoke("addon_defaults", json!({}))
            .expect("addon_defaults should be permitted")
            .deserialize()
            .unwrap();
        assert_eq!(listed, defaults);
        for default in &default_urls {
            app.invoke("addon_uninstall", json!({ "url": default }))
                .expect("addon_uninstall should be permitted");
        }
        assert_eq!(list(&app), json!([]));

        let installed: Value = app
            .invoke(
                "addon_install",
                json!({ "addon": { "transportUrl": url, "manifest": { "id": "org.example" } } }),
            )
            .expect("addon_install should be permitted")
            .deserialize()
            .unwrap();
        assert_eq!(installed[0]["transportUrl"], url);
        assert_eq!(list(&app), installed);

        let second = "https://second.example.com/manifest.json";
        app.invoke(
            "addon_install",
            json!({ "addon": { "transportUrl": second, "manifest": { "id": "org.second" } } }),
        )
        .expect("addon_install should be permitted");
        let disabled: Value = app
            .invoke("addon_set_enabled", json!({ "url": url, "enabled": false }))
            .expect("addon_set_enabled should be permitted")
            .deserialize()
            .unwrap();
        assert_eq!(disabled[0]["enabled"], false);
        assert_eq!(disabled[1]["enabled"], true);
        let moved: Value = app
            .invoke("addon_move", json!({ "url": second, "index": 0 }))
            .expect("addon_move should be permitted")
            .deserialize()
            .unwrap();
        assert_eq!(moved[0]["transportUrl"], second);
        assert_eq!(list(&app), moved);
        let error = app
            .invoke(
                "addon_move",
                json!({ "url": "http://x.example/manifest.json", "index": 0 }),
            )
            .unwrap_err();
        assert!(!is_permission_error(&error), "{error}");
        app.invoke("addon_uninstall", json!({ "url": second }))
            .expect("addon_uninstall should be permitted");

        let remaining: Value = app
            .invoke("addon_uninstall", json!({ "url": url }))
            .expect("addon_uninstall should be permitted")
            .deserialize()
            .unwrap();
        assert_eq!(remaining, json!([]));

        let restored: Value = app
            .invoke("addon_restore_defaults", json!({}))
            .expect("addon_restore_defaults should be permitted")
            .deserialize()
            .unwrap();
        assert_eq!(restored, defaults);
    }

    #[test]
    fn stremio_import_commands_are_allowed_and_validate_their_arguments() {
        let app = TestApp::new("stremio-import");

        // A malformed key is refused before anything is sent to Stremio.
        let error = app
            .invoke(
                "stremio_import_fetch",
                json!({ "signIn": { "method": "authKey", "authKey": "not a key" } }),
            )
            .unwrap_err();
        assert!(!is_permission_error(&error), "{error}");
        assert_eq!(error["code"], "STREMIO_ERROR", "{error}");
        assert!(!error.to_string().contains("not a key"), "{error}");

        // Nothing was fetched, so there is nothing to import.
        let error = app
            .invoke(
                "stremio_import_library",
                json!({ "choice": { "libraryItems": true, "progress": true } }),
            )
            .unwrap_err();
        assert!(!is_permission_error(&error), "{error}");
        assert_eq!(error["code"], "INVALID_ARGUMENT", "{error}");

        app.invoke("stremio_import_discard", json!({}))
            .expect("stremio_import_discard should be permitted");
    }

    #[test]
    fn addon_fetch_commands_are_allowed_and_validate_their_arguments() {
        let app = TestApp::new("fetch");

        // Rejected arguments keep the test off the network; the error must
        // come from validation, not the ACL.
        let error = app
            .invoke(
                "addon_fetch_manifest",
                json!({ "url": "http://addon.example.com/manifest.json" }),
            )
            .unwrap_err();
        assert!(!is_permission_error(&error), "{error}");
        assert!(error.to_string().contains("https"), "{error}");

        let error = app
            .invoke(
                "addon_fetch_resource",
                json!({
                    "url": "https://addon.example.com/manifest.json",
                    "resource": "catalog",
                    "type": "..",
                    "id": "top",
                }),
            )
            .unwrap_err();
        assert_eq!(error["code"], "INVALID_ARGUMENT", "{error}");

        let error = app
            .invoke(
                "addon_fetch_resource",
                json!({
                    "url": "https://addon.example.com/manifest.json",
                    "resource": "catalog",
                    "type": "movie",
                    "id": "top",
                    "requestId": "../1",
                }),
            )
            .unwrap_err();
        assert!(!is_permission_error(&error), "{error}");
        assert!(error.to_string().contains("request id"), "{error}");

        let error = app
            .invoke("addon_cancel_request", json!({ "requestId": "" }))
            .unwrap_err();
        assert!(!is_permission_error(&error), "{error}");
        let cancelled: bool = app
            .invoke(
                "addon_cancel_request",
                json!({ "requestId": "not-in-flight" }),
            )
            .expect("addon_cancel_request should be permitted")
            .deserialize()
            .unwrap();
        assert!(!cancelled);

        let error = app
            .invoke(
                "addon_install",
                json!({
                    "addon": {
                        "transportUrl": "https://addon.example.com/manifest.json",
                        "manifest": "not an object",
                    }
                }),
            )
            .unwrap_err();
        assert_eq!(error["code"], "INVALID_ARGUMENT", "{error}");
    }

    #[test]
    fn addon_fetch_resource_can_be_cancelled_by_request_id() {
        let app = TestApp::new("cancel");
        // A loopback "addon" that accepts connections (through the listen
        // backlog) but never responds, so the fetch stays in flight.
        let silent = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/manifest.json", silent.local_addr().unwrap());
        let started = Instant::now();

        let error = std::thread::scope(|scope| {
            let fetch = scope.spawn(|| {
                app.invoke(
                    "addon_fetch_resource",
                    json!({
                        "url": url,
                        "resource": "catalog",
                        "type": "movie",
                        "id": "top",
                        "extra": { "search": "alien" },
                        "requestId": "search-1",
                    }),
                )
            });
            // Retry until the fetch has registered its id.
            let cancel = || -> bool {
                app.invoke("addon_cancel_request", json!({ "requestId": "search-1" }))
                    .expect("addon_cancel_request should be permitted")
                    .deserialize()
                    .unwrap()
            };
            while !cancel() {
                assert!(
                    started.elapsed() < Duration::from_secs(5),
                    "fetch never started"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
            fetch.join().unwrap().unwrap_err()
        });

        assert_eq!(error["code"], "CANCELLED", "{error}");
        // Well inside the transport's 20 s timeout.
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn skip_times_lookup_is_allowed_only_when_turned_on() {
        let app = TestApp::new("skip-times");
        let lookup = |args: Value| -> Value {
            let error = app.invoke("skip_times_lookup", args).unwrap_err();
            assert!(!is_permission_error(&error), "{error}");
            error
        };
        let episode = json!({ "imdbId": "tt0903747", "season": 2, "episode": 4, "duration": 2853 });

        // Off by default: refused before anything is sent.
        let error = lookup(episode.clone());
        assert_eq!(error["code"], "INVALID_ARGUMENT", "{error}");
        assert!(error["message"].as_str().unwrap().contains("turned off"));

        let mut settings: Value = app
            .invoke("settings_get", json!({}))
            .unwrap()
            .deserialize()
            .unwrap();
        settings["playback"]["onlineSkipTimes"] = json!(true);
        app.invoke("settings_set", json!({ "settings": settings }))
            .unwrap();

        // Arguments are validated before any request.
        for (key, value) in [
            ("imdbId", json!("https://evil.example/")),
            ("season", json!(0)),
            ("duration", json!(-1)),
        ] {
            let mut args = episode.clone();
            args[key] = value;
            let error = lookup(args);
            assert_eq!(error["code"], "INVALID_ARGUMENT", "{key}: {error}");
        }
        let mut negative = episode.clone();
        negative["episode"] = json!(-4);
        let error = lookup(negative);
        assert!(error.to_string().contains("invalid args"), "{error}");
    }

    #[cfg(native_player)]
    #[test]
    fn player_commands_are_allowed_and_validate_their_arguments() {
        let app = TestApp::new("player");
        let code = |cmd: &str, args: Value| -> Value {
            let error = app.invoke(cmd, args).unwrap_err();
            assert!(!is_permission_error(&error), "{cmd}: {error}");
            error["code"].clone()
        };

        // Validation comes first, so these never need a player.
        assert_eq!(
            code("player_load", json!({ "url": "file:///etc/passwd" })),
            "INVALID_ARGUMENT"
        );
        assert_eq!(
            code(
                "player_load",
                json!({ "url": "https://cdn.example/a.mkv", "startPosition": -1 })
            ),
            "INVALID_ARGUMENT"
        );
        assert_eq!(
            code("player_select_audio_track", json!({ "id": "auto" })),
            "INVALID_ARGUMENT"
        );
        assert_eq!(
            code("player_select_subtitle_track", json!({ "id": "0" })),
            "INVALID_ARGUMENT"
        );
        assert_eq!(
            code(
                "player_add_subtitle",
                json!({ "url": "http://subs.example/a.srt" })
            ),
            "INVALID_ARGUMENT"
        );
        assert_eq!(
            code("player_seek", json!({ "seconds": -5 })),
            "INVALID_ARGUMENT"
        );
        let style = json!({ "size": 100, "color": "#ffffff", "edge": "outline", "offset": 0 });
        let mut too_big = style.clone();
        too_big["size"] = json!(500);
        assert_eq!(
            code("player_set_subtitle_style", json!({ "style": too_big })),
            "INVALID_ARGUMENT"
        );

        for (cmd, args) in [
            ("player_set_subtitle_delay", json!({ "seconds": "0.3" })),
            ("player_set_subtitle_delay", json!({ "seconds": null })),
            ("player_set_audio_delay", json!({})),
            ("player_set_speed", json!({ "speed": "fast" })),
        ] {
            let error = app.invoke(cmd, args).unwrap_err();
            assert!(!is_permission_error(&error), "{cmd}: {error}");
            assert!(error.to_string().contains("invalid args"), "{cmd}: {error}");
        }

        // Discord Rich Presence gets a title, episode numbers and a poster,
        // and nothing else.
        assert_eq!(
            code(
                "player_set_now_playing",
                json!({ "nowPlaying": { "title": " ", "season": 1, "episode": 2 } })
            ),
            "INVALID_ARGUMENT"
        );
        let error = app
            .invoke(
                "player_set_now_playing",
                json!({ "nowPlaying": { "title": "Show", "url": "https://cdn.example/a.mkv" } }),
            )
            .unwrap_err();
        assert!(error.to_string().contains("invalid args"), "{error}");
        for now_playing in [
            json!({ "title": "Show", "season": 2, "episode": 4, "poster": "https://img.example/p.jpg" }),
            json!({ "title": "Film", "season": null, "episode": null, "poster": "http://img.example/p.jpg" }),
            Value::Null,
        ] {
            app.invoke(
                "player_set_now_playing",
                json!({ "nowPlaying": now_playing }),
            )
            .expect("player_set_now_playing should be permitted");
        }

        // A preview position must be a non-negative number, and its kind one
        // of the known ones.
        for position in [json!(-1), json!(-0.5)] {
            assert_eq!(
                code("player_preview", json!({ "position": position })),
                "INVALID_ARGUMENT"
            );
        }
        let error = app
            .invoke(
                "player_preview",
                json!({ "position": 12.5, "kind": "urgent" }),
            )
            .unwrap_err();
        assert!(error.to_string().contains("invalid args"), "{error}");

        // Valid arguments, but nothing is attached (the mock runtime has no video surface).
        assert_eq!(code("player_stats", json!({})), "PLAYER_NOT_ATTACHED");
        for kind in [
            json!(null),
            json!("hover"),
            json!("prefetch"),
            json!("storyboard"),
            json!("warm"),
        ] {
            assert_eq!(
                code("player_preview", json!({ "position": 12.5, "kind": kind })),
                "PLAYER_NOT_ATTACHED"
            );
        }
        assert_eq!(
            code("player_set_paused", json!({ "paused": true })),
            "PLAYER_NOT_ATTACHED"
        );
        assert_eq!(
            code("player_select_subtitle_track", json!({ "id": null })),
            "PLAYER_NOT_ATTACHED"
        );
        assert_eq!(
            code("player_set_subtitle_style", json!({ "style": style })),
            "PLAYER_NOT_ATTACHED"
        );
        // Out-of-range delays and speeds are clamped, not refused.
        for (cmd, args) in [
            ("player_set_subtitle_delay", json!({ "seconds": 0.3 })),
            ("player_set_subtitle_delay", json!({ "seconds": -600 })),
            ("player_set_audio_delay", json!({ "seconds": 25 })),
            ("player_set_speed", json!({ "speed": 1.5 })),
            ("player_set_speed", json!({ "speed": 0 })),
        ] {
            assert_eq!(code(cmd, args), "PLAYER_NOT_ATTACHED", "{cmd}");
        }

        // Detaching when nothing is attached is a no-op.
        app.invoke("player_detach", json!({}))
            .expect("player_detach should be permitted and idempotent");
    }

    #[test]
    fn library_commands_round_trip() {
        let app = TestApp::new("library");
        let call = |cmd: &str, args: Value| -> Value {
            app.invoke(cmd, args)
                .unwrap_or_else(|error| panic!("{cmd} should be permitted: {error}"))
                .deserialize()
                .unwrap()
        };
        let title = json!({ "type": "series", "id": "tt2", "name": "Show", "poster": null });

        assert_eq!(call("library_watchlist", json!({})), json!([]));
        let item = call("library_watchlist_add", json!({ "title": title }));
        assert_eq!(item["title"], title);
        assert_eq!(call("library_watchlist", json!({}))[0], item);

        let entry = call(
            "library_record_progress",
            json!({ "progress": {
                "title": title,
                "video": { "id": "tt2:1:3", "season": 1, "episode": 3 },
                "position": 120,
                "duration": 1500,
            }}),
        );
        assert_eq!(entry["completed"], false);
        let mut history_title = entry.clone();
        history_title["playedVideos"] = json!(1);
        assert_eq!(call("library_history", json!({}))[0], history_title);
        assert_eq!(
            call("library_continue_watching", json!({ "limit": 5 }))[0],
            entry
        );

        let state = call(
            "library_title_state",
            json!({ "type": "series", "id": "tt2" }),
        );
        assert_eq!(state, json!({ "inWatchlist": true, "progress": [entry] }));

        call(
            "library_watchlist_remove",
            json!({ "type": "series", "id": "tt2" }),
        );
        call(
            "library_history_remove",
            json!({ "type": "series", "id": "tt2" }),
        );
        let state = call(
            "library_title_state",
            json!({ "type": "series", "id": "tt2" }),
        );
        assert_eq!(state, json!({ "inWatchlist": false, "progress": [] }));

        call("library_history_clear", json!({}));
        assert_eq!(call("library_history", json!({})), json!([]));
    }

    #[test]
    fn watch_marks_and_continue_watching_commands_round_trip() {
        let app = TestApp::new("marks");
        let call = |cmd: &str, args: Value| -> Value {
            app.invoke(cmd, args)
                .unwrap_or_else(|error| panic!("{cmd} should be permitted: {error}"))
                .deserialize()
                .unwrap()
        };
        let show = json!({ "type": "series", "id": "tt2", "name": "Show", "poster": null });
        let film = json!({ "type": "movie", "id": "tt1", "name": "Film", "poster": null });
        call(
            "library_record_progress",
            json!({ "progress": {
                "title": film,
                "video": { "id": "tt1", "season": null, "episode": null },
                "position": 300,
                "duration": 1500,
            }}),
        );
        let ids = |list: &Value| -> Vec<Value> {
            list.as_array()
                .unwrap()
                .iter()
                .map(|entry| entry["video"]["id"].clone())
                .collect()
        };
        // Continue watching, in id order (saves within the same millisecond tie).
        let continuing = || -> Vec<String> {
            let mut found: Vec<_> = ids(&call("library_continue_watching", json!({})))
                .into_iter()
                .map(|id| id.as_str().unwrap().to_owned())
                .collect();
            found.sort();
            found
        };

        // Marking episodes returns the title's state, latest first.
        let state = call(
            "library_mark_watched",
            json!({ "title": show, "videos": [
                { "id": "tt2:1:1", "season": 1, "episode": 1, "name": "Pilot" },
                { "id": "tt2:1:2", "season": 1, "episode": 2, "name": null },
            ]}),
        );
        assert_eq!(
            ids(&state["progress"]),
            [json!("tt2:1:2"), json!("tt2:1:1")]
        );
        assert_eq!(state["progress"][1]["video"]["name"], "Pilot");
        assert_eq!(state["progress"][0]["completed"], true);
        assert_eq!(continuing(), ["tt1", "tt2:1:2"]);

        call(
            "library_continue_dismiss",
            json!({ "type": "series", "id": "tt2" }),
        );
        assert_eq!(continuing(), ["tt1"]);
        call(
            "library_continue_restore",
            json!({ "type": "series", "id": "tt2" }),
        );
        assert_eq!(continuing(), ["tt1", "tt2:1:2"]);

        call(
            "library_mark_watched",
            json!({ "title": film, "videos": [{ "id": "tt1" }] }),
        );
        assert_eq!(
            call("library_watched_titles", json!({})),
            json!([{ "type": "movie", "id": "tt1" }])
        );
        let state = call(
            "library_mark_unwatched",
            json!({ "type": "series", "id": "tt2", "videos": ["tt2:1:2"] }),
        );
        assert_eq!(ids(&state["progress"]), [json!("tt2:1:1")]);
        let state = call(
            "library_mark_unwatched",
            json!({ "type": "movie", "id": "tt1", "videos": ["tt1"] }),
        );
        assert_eq!(state, json!({ "inWatchlist": false, "progress": [] }));
        assert_eq!(call("library_watched_titles", json!({})), json!([]));
    }

    #[test]
    fn library_commands_validate_their_arguments() {
        let app = TestApp::new("library-invalid");
        let invalid = [
            (
                "library_watchlist_add",
                json!({ "title": { "type": "movie", "id": "tt1", "name": "M", "poster": "http://x/p.jpg" } }),
            ),
            (
                "library_watchlist_remove",
                json!({ "type": "..", "id": "tt1" }),
            ),
            (
                "library_record_progress",
                json!({ "progress": {
                    "title": { "type": "movie", "id": "tt1", "name": "M" },
                    "video": { "id": "tt1" },
                    "position": -5,
                    "duration": 100,
                }}),
            ),
            ("library_title_state", json!({ "type": "movie", "id": "" })),
            (
                "library_continue_dismiss",
                json!({ "type": "a/b", "id": "tt1" }),
            ),
            ("library_continue_restore", json!({ "type": "movie" })),
            (
                "library_mark_watched",
                json!({ "title": { "type": "movie", "id": "tt1", "name": "M" }, "videos": [] }),
            ),
            (
                "library_mark_watched",
                json!({ "title": { "type": "movie", "id": "tt1", "name": "M" },
                        "videos": [{ "id": "tt1" }, { "id": "tt1" }] }),
            ),
            (
                "library_mark_watched",
                json!({ "title": { "type": "movie", "id": "tt1", "name": " " },
                        "videos": [{ "id": "tt1" }] }),
            ),
            (
                "library_mark_unwatched",
                json!({ "type": "movie", "id": "tt1", "videos": [""] }),
            ),
            (
                "library_mark_unwatched",
                json!({ "type": "movie", "id": "tt1", "videos": "tt1" }),
            ),
        ];
        for (cmd, args) in invalid {
            let error = app.invoke(cmd, args).unwrap_err();
            assert!(!is_permission_error(&error), "{cmd}: {error}");
            assert!(
                error.to_string().contains("invalid args") || error["code"] == "INVALID_ARGUMENT",
                "{cmd}: {error}"
            );
        }
        // Nothing invalid reached the database.
        let watchlist: Value = app
            .invoke("library_watchlist", json!({}))
            .unwrap()
            .deserialize()
            .unwrap();
        assert_eq!(watchlist, json!([]));
        let history: Value = app
            .invoke("library_history", json!({}))
            .unwrap()
            .deserialize()
            .unwrap();
        assert_eq!(history, json!([]));
    }

    #[test]
    fn settings_commands_round_trip_and_validate() {
        let app = TestApp::new("settings");
        let get = |app: &TestApp| -> Value {
            app.invoke("settings_get", json!({}))
                .expect("settings_get should be permitted")
                .deserialize()
                .unwrap()
        };
        let defaults = json!({
            "general": {
                "discordPresence": false, "discordShowTitle": true, "discordShowEpisode": true,
            },
            "playback": {
                "audioLanguages": [], "subtitleLanguages": [], "subtitlesOff": false,
                "skipIntros": false, "onlineSkipTimes": false,
                "autoplayNext": true, "upNextSeconds": 10, "seekSeconds": 10, "resume": "always",
                "rememberVolume": true, "volume": 100, "markWatchedPercent": 90,
                "keepScreenOn": true, "seekPreviews": true, "audioPassthrough": false, "passthroughFormats": ["ac3", "dts"],
            },
            "subtitles": {
                "size": 100, "color": "#ffffff", "edge": "outline", "offset": 0,
                "preferredType": "regular",
            },
            "streams": {
                "maxResolution": 2160, "preferHdr": true, "preferCached": true,
                "excludeCam": false, "maxSizeGb": null, "avoidCodecs": [], "excludedKeywords": [],
            },
            "rows": { "discover": null, "movies": null, "tvShows": null },
        });
        assert_eq!(get(&app), defaults);

        let mut settings = defaults.clone();
        settings["playback"]["audioLanguages"] = json!(["ja", "en"]);
        settings["playback"]["resume"] = json!("ask");
        settings["playback"]["skipIntros"] = json!(true);
        settings["playback"]["onlineSkipTimes"] = json!(true);
        settings["general"]["discordPresence"] = json!(true);
        settings["general"]["discordShowEpisode"] = json!(false);
        settings["playback"]["audioPassthrough"] = json!(true);
        settings["playback"]["passthroughFormats"] = json!(["dts"]);
        settings["subtitles"]["edge"] = json!("background");
        settings["streams"]["maxResolution"] = json!(1080);
        settings["streams"]["avoidCodecs"] = json!(["av1"]);
        settings["streams"]["excludedKeywords"] = json!(["GROUP"]);
        settings["rows"]["discover"] = json!([
            { "addon": "community.anime.kitsu", "type": "anime", "catalog": "kitsu-anime-airing", "hidden": true },
        ]);
        let stored: Value = app
            .invoke("settings_set", json!({ "settings": settings }))
            .expect("settings_set should be permitted")
            .deserialize()
            .unwrap();
        assert_eq!(stored, settings);
        assert_eq!(get(&app), settings);

        let error = app
            .invoke(
                "settings_set",
                json!({ "settings": { "playback": {
                    "audioLanguages": ["../etc"], "subtitleLanguages": [], "subtitlesOff": false,
                }}}),
            )
            .unwrap_err();
        assert!(!is_permission_error(&error), "{error}");
        assert_eq!(error["code"], "INVALID_ARGUMENT", "{error}");
        assert_eq!(get(&app), settings);

        for (section, key, value) in [
            ("streams", "maxResolution", json!(4320)),
            ("playback", "markWatchedPercent", json!(99)),
            ("playback", "resume", json!("sometimes")),
            ("playback", "passthroughFormats", json!(["mp3"])),
            ("playback", "passthroughFormats", json!(["ac3", "ac3"])),
            ("playback", "passthroughFormats", json!(["dtsHd"])),
            ("subtitles", "color", json!("url(x)")),
            ("streams", "excludedKeywords", json!(["ok", "OK"])),
            (
                "rows",
                "movies",
                json!([{ "addon": "a b", "type": "movie", "catalog": "top" }]),
            ),
        ] {
            let mut unsupported = settings.clone();
            unsupported[section][key] = value;
            let error = app
                .invoke("settings_set", json!({ "settings": unsupported }))
                .unwrap_err();
            assert!(!is_permission_error(&error), "{key}: {error}");
            assert!(
                error.to_string().contains("invalid args") || error["code"] == "INVALID_ARGUMENT",
                "{key}: {error}"
            );
        }
        assert_eq!(get(&app), settings);
    }

    #[test]
    fn progress_is_marked_watched_at_the_chosen_threshold() {
        let app = TestApp::new("watched");
        let call = |cmd: &str, args: Value| -> Value {
            app.invoke(cmd, args)
                .unwrap_or_else(|error| panic!("{cmd} should be permitted: {error}"))
                .deserialize()
                .unwrap()
        };
        let record = |video: &str| {
            call(
                "library_record_progress",
                json!({ "progress": {
                    "title": { "type": "movie", "id": "tt1", "name": "Film", "poster": null },
                    "video": { "id": video, "season": null, "episode": null },
                    "position": 1250,
                    "duration": 1500,
                }}),
            )
        };
        // 83% watched: not finished at the default 90%.
        assert_eq!(record("tt1")["completed"], false);

        let mut settings = call("settings_get", json!({}));
        settings["playback"]["markWatchedPercent"] = json!(80);
        call("settings_set", json!({ "settings": settings }));
        assert_eq!(record("tt1")["completed"], true);
    }

    #[test]
    fn profile_commands_are_allowed_validate_and_keep_profiles_apart() {
        let app = TestApp::new("profiles");
        let call = |cmd: &str, args: Value| -> Value {
            app.invoke(cmd, args)
                .unwrap_or_else(|error| panic!("{cmd} should be permitted: {error}"))
                .deserialize()
                .unwrap()
        };
        let fails = |cmd: &str, args: Value| -> Value {
            let error = app.invoke(cmd, args).unwrap_err();
            assert!(!is_permission_error(&error), "{cmd}: {error}");
            error
        };

        let overview = call("profile_list", json!({}));
        assert_eq!(overview["active"], 1);
        assert_eq!(overview["profiles"][0]["name"], "Me");
        assert_eq!(overview["showPicker"], true);

        // Arguments are validated at the boundary.
        for (cmd, args) in [
            ("profile_create", json!({ "name": "", "avatar": "teal" })),
            (
                "profile_create",
                json!({ "name": "A\u{7}b", "avatar": "teal" }),
            ),
            (
                "profile_create",
                json!({ "name": "x".repeat(21), "avatar": "teal" }),
            ),
            (
                "profile_create",
                json!({ "name": "Sam", "avatar": "file:///etc/passwd" }),
            ),
            (
                "profile_create",
                json!({ "name": "Sam", "avatar": "teal", "pin": "12345" }),
            ),
            (
                "profile_create",
                json!({ "name": "Sam", "avatar": "teal", "pin": 1234 }),
            ),
            ("profile_rename", json!({ "id": 0, "name": "Sam" })),
            ("profile_switch", json!({ "id": "1" })),
            ("profile_switch", json!({ "id": 42 })),
            ("profile_delete", json!({ "id": 1 })),
            ("profile_set_show_picker", json!({ "show": "yes" })),
            ("profile_finish_first_run", json!({ "outcome": "pending" })),
            ("profile_finish_first_run", json!({})),
        ] {
            fails(cmd, args);
        }

        let overview = call(
            "profile_create",
            json!({ "name": "  Sam ", "avatar": "teal", "pin": "2468" }),
        );
        let sam = &overview["profiles"][1];
        assert_eq!(sam["name"], "Sam");
        assert_eq!(sam["hasPin"], true);
        assert!(sam.get("pinHash").is_none());
        let sam = sam["id"].clone();

        // The first profile's library and settings.
        let title = json!({ "type": "movie", "id": "tt1", "name": "Film", "poster": null });
        call("library_watchlist_add", json!({ "title": title }));
        call(
            "library_record_progress",
            json!({ "progress": {
                "title": title,
                "video": { "id": "tt1", "season": null, "episode": null },
                "position": 300,
                "duration": 1500,
            }}),
        );
        let mut settings = call("settings_get", json!({}));
        settings["playback"]["volume"] = json!(40);
        call("settings_set", json!({ "settings": settings }));

        // Sam's PIN is needed to switch, and a wrong one changes nothing.
        assert_eq!(
            fails("profile_switch", json!({ "id": sam }))["code"],
            "PIN_REQUIRED"
        );
        assert_eq!(
            fails("profile_switch", json!({ "id": sam, "pin": "1111" }))["code"],
            "WRONG_PIN"
        );
        assert_eq!(call("profile_list", json!({}))["active"], 1);
        let overview = call("profile_switch", json!({ "id": sam, "pin": "2468" }));
        assert_eq!(overview["active"], sam);

        // Sam sees none of it.
        assert_eq!(call("library_watchlist", json!({})), json!([]));
        assert_eq!(call("library_history", json!({})), json!([]));
        assert_eq!(call("library_continue_watching", json!({})), json!([]));
        assert_eq!(
            call(
                "library_title_state",
                json!({ "type": "movie", "id": "tt1" })
            ),
            json!({ "inWatchlist": false, "progress": [] })
        );
        assert_eq!(call("settings_get", json!({}))["playback"]["volume"], 100);
        call("library_history_clear", json!({}));

        // Not the active profile.
        fails("profile_delete", json!({ "id": sam }));

        call("profile_switch", json!({ "id": 1 }));
        assert_eq!(call("library_watchlist", json!({}))[0]["title"], title);
        assert_eq!(call("library_history", json!({}))[0]["title"], title);
        assert_eq!(call("settings_get", json!({}))["playback"]["volume"], 40);

        // Changing Sam from here needs Sam's PIN.
        assert_eq!(
            fails("profile_rename", json!({ "id": sam, "name": "Samuel" }))["code"],
            "PIN_REQUIRED"
        );
        let overview = call(
            "profile_rename",
            json!({ "id": sam, "name": "Samuel", "pin": "2468" }),
        );
        assert_eq!(overview["profiles"][1]["name"], "Samuel");
        call("profile_set_avatar", json!({ "id": 1, "avatar": "amber" }));
        call("profile_set_pin", json!({ "id": 1, "newPin": "0000" }));
        let overview = call("profile_set_show_picker", json!({ "show": false }));
        assert_eq!(overview["showPicker"], false);

        // The first-run setup is recorded for the active profile only.
        assert_eq!(overview["profiles"][0]["firstRun"], "pending");
        let overview = call("profile_finish_first_run", json!({ "outcome": "skipped" }));
        assert_eq!(overview["profiles"][0]["firstRun"], "skipped");
        assert_eq!(overview["profiles"][1]["firstRun"], "pending");
        assert_eq!(overview["profiles"][0]["avatar"], "amber");
        assert_eq!(overview["profiles"][0]["hasPin"], true);

        // Deleting needs no PIN (a forgotten one can't lock a profile in forever).
        let overview = call("profile_delete", json!({ "id": sam }));
        assert_eq!(overview["profiles"].as_array().unwrap().len(), 1);
        // Never the last one.
        fails("profile_delete", json!({ "id": 1 }));
    }

    #[test]
    fn only_the_fullscreen_window_apis_are_granted() {
        let app = TestApp::new("window");
        let label = json!({ "label": "main" });
        app.invoke("plugin:window|is_fullscreen", label.clone())
            .expect("is_fullscreen should be permitted");
        app.invoke(
            "plugin:window|set_fullscreen",
            json!({ "label": "main", "value": false }),
        )
        .expect("set_fullscreen should be permitted");

        for cmd in [
            "plugin:window|set_title",
            "plugin:window|close",
            "plugin:window|set_simple_fullscreen",
            "plugin:window|set_size",
            "plugin:event|listen",
        ] {
            let error = app.invoke(cmd, label.clone()).unwrap_err();
            assert!(is_permission_error(&error), "{cmd}: {error}");
        }
    }

    #[test]
    fn update_commands_are_allowed_and_off_in_development_builds() {
        let app = TestApp::new("updates");
        let call = |cmd: &str| -> Value {
            app.invoke(cmd, json!({}))
                .unwrap_or_else(|error| panic!("{cmd} should be permitted: {error}"))
                .deserialize()
                .unwrap()
        };
        assert_eq!(call("app_update_status"), json!({ "state": "disabled" }));
        assert_eq!(call("app_update_check"), json!({ "state": "disabled" }));

        let error = app.invoke("app_update_install", json!({})).unwrap_err();
        assert!(!is_permission_error(&error), "{error}");
        assert_eq!(error["code"], "INVALID_ARGUMENT", "{error}");
        // Only a version number, never a URL, reaches the browser.
        let error = app
            .invoke(
                "app_update_open_download",
                json!({ "version": "https://evil.example/" }),
            )
            .unwrap_err();
        assert!(!is_permission_error(&error), "{error}");
        assert_eq!(error["code"], "INVALID_ARGUMENT", "{error}");

        // The updater plugin's own commands stay with the core.
        for cmd in [
            "plugin:updater|check",
            "plugin:updater|download_and_install",
        ] {
            let error = app.invoke(cmd, json!({})).unwrap_err();
            assert!(is_permission_error(&error), "{cmd}: {error}");
        }
    }

    #[test]
    fn core_apis_not_granted_by_a_capability_are_denied() {
        let app = TestApp::new("denied");
        for cmd in ["plugin:app|version", "plugin:path|resolve_directory"] {
            let error = app.invoke(cmd, json!({})).unwrap_err();
            assert!(is_permission_error(&error), "{cmd}: {error}");
        }
    }
}
