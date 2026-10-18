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
//! - [`settings`] — user preferences
//! - [`skip_times`] — intro and credits times looked up online (SkipDB)
//! - [`storage`]  — local persistence locations and the SQLite database
//! - [`stremio`]  — importing a Stremio account (addons, library, progress)

pub mod addons;
mod commands;
pub mod core;
pub mod library;
pub mod media;
pub mod presence;
pub mod settings;
pub mod skip_times;
pub mod storage;
pub mod stremio;

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
    let builder = builder.setup(crate::core::lifecycle::setup);

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
            commands::settings::settings_get,
            commands::settings::settings_set,
            commands::skip_times::skip_times_lookup,
            commands::stremio::stremio_import_fetch,
            commands::stremio::stremio_import_library,
            commands::stremio::stremio_import_discard,
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
        commands::settings::settings_get,
        commands::settings::settings_set,
        commands::skip_times::skip_times_lookup,
        commands::stremio::stremio_import_fetch,
        commands::stremio::stremio_import_library,
        commands::stremio::stremio_import_discard,
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

        // Valid arguments, but nothing is attached (the mock runtime has no video surface).
        assert_eq!(code("player_stats", json!({})), "PLAYER_NOT_ATTACHED");
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
                "keepScreenOn": true,
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
        settings["subtitles"]["edge"] = json!("background");
        settings["streams"]["maxResolution"] = json!(1080);
        settings["streams"]["avoidCodecs"] = json!(["av1"]);
        settings["streams"]["excludedKeywords"] = json!(["YIFY"]);
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
    fn core_apis_not_granted_by_a_capability_are_denied() {
        let app = TestApp::new("denied");
        for cmd in ["plugin:app|version", "plugin:path|resolve_directory"] {
            let error = app.invoke(cmd, json!({})).unwrap_err();
            assert!(is_permission_error(&error), "{cmd}: {error}");
        }
    }
}
