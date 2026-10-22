fn main() {
    // `native_player`: the libmpv player is compiled in. That needs the
    // `libmpv` feature and a platform with a video surface
    // (src/media/mpv/{macos,win32,linux}.rs). Everything player-related is
    // gated on this one cfg.
    println!("cargo::rustc-check-cfg=cfg(native_player)");
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let libmpv = std::env::var_os("CARGO_FEATURE_LIBMPV").is_some();
    if libmpv && matches!(target_os.as_str(), "macos" | "windows" | "linux") {
        println!("cargo::rustc-cfg=native_player");
    }

    // Link against libmpv, for the FFI declarations in src/media/mpv/ffi.rs.
    //
    // - macOS and Linux link `-lmpv`. With `KIRO_LIBMPV_DIR` set (release
    //   builds, scripts/build-macos.sh and build-linux.sh) that is the LGPL
    //   build from scripts/build-libmpv.sh (loaded from
    //   `Contents/Frameworks`, already on the rpath) or build-libmpv-linux.sh
    //   (rpath below); otherwise the system libmpv (Homebrew's, or the
    //   distribution's `libmpv-dev`, found with pkg-config).
    // - Windows imports `libmpv-2.dll` with `raw-dylib` (ffi.rs), so no
    //   import library is needed. The DLL is copied next to the executable
    //   from `KIRO_LIBMPV_DIR` (e.g. an extracted mpv-dev package).
    println!("cargo:rerun-if-env-changed=KIRO_LIBMPV_DIR");
    if libmpv && target_os == "windows" {
        if let Ok(dir) = std::env::var("KIRO_LIBMPV_DIR") {
            copy_dll_next_to_executable(std::path::Path::new(&dir).join("libmpv-2.dll"));
        }
    } else if libmpv {
        let lib_dir = match std::env::var("KIRO_LIBMPV_DIR") {
            Ok(dir) => dir,
            Err(_) => std::process::Command::new("pkg-config")
                .args(["--variable=libdir", "mpv"])
                .output()
                .ok()
                .filter(|output| output.status.success())
                .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
                .unwrap_or_else(|| {
                    if target_os == "macos" {
                        "/opt/homebrew/lib"
                    } else {
                        "/usr/lib"
                    }
                    .to_owned()
                }),
        };
        println!("cargo:rustc-link-search=native={lib_dir}");
        println!("cargo:rustc-link-lib=dylib=mpv");
        // Linux release builds (scripts/build-linux.sh) ship the LGPL build
        // from scripts/build-libmpv-linux.sh beside the app: the .deb in
        // /usr/lib/kiro/ (the binary is /usr/bin/kiro-desktop). The AppImage's
        // bundler sets its own rpath, to its usr/lib/.
        if target_os == "linux" && std::env::var_os("KIRO_LIBMPV_DIR").is_some() {
            println!("cargo:rustc-link-arg-bins=-Wl,-rpath,$ORIGIN/../lib/kiro");
        }
    }

    // Declaring the app's commands makes Tauri generate `allow-*` / `deny-*`
    // permissions for them. A command is then callable from a window only if a
    // capability in `capabilities/` grants it — nothing is exposed by default.
    // Windows: Common Controls 6 (which wry and the video surface's window
    // subclassing need) is only loaded with an application manifest.
    // tauri-build embeds one in the app executable alone; embedding it through
    // the linker instead covers every binary, so `cargo test` starts too.
    let mut attributes = tauri_build::Attributes::new();
    if target_os == "windows"
        && std::env::var("CARGO_CFG_TARGET_ENV").is_ok_and(|env| env == "msvc")
    {
        let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap())
            .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    }

    tauri_build::try_build(
        attributes.app_manifest(tauri_build::AppManifest::new().commands(&[
            "app_info",
            "addon_fetch_manifest",
            "addon_fetch_resource",
            "addon_cancel_request",
            "addon_list",
            "addon_install",
            "addon_uninstall",
            "addon_set_enabled",
            "addon_move",
            "addon_defaults",
            "addon_restore_defaults",
            "library_watchlist",
            "library_watchlist_add",
            "library_watchlist_remove",
            "library_record_progress",
            "library_history",
            "library_continue_watching",
            "library_title_state",
            "library_history_remove",
            "library_history_clear",
            "library_continue_dismiss",
            "library_continue_restore",
            "library_mark_watched",
            "library_mark_unwatched",
            "library_watched_titles",
            "settings_get",
            "settings_set",
            "profile_list",
            "profile_create",
            "profile_rename",
            "profile_set_avatar",
            "profile_set_pin",
            "profile_delete",
            "profile_switch",
            "profile_set_show_picker",
            "profile_finish_first_run",
            "skip_times_lookup",
            "stremio_import_fetch",
            "stremio_import_library",
            "stremio_import_discard",
            "app_update_status",
            "app_update_check",
            "app_update_install",
            "app_update_open_download",
            // libmpv player (only registered with `--features libmpv`).
            "player_attach",
            "player_detach",
            "player_load",
            "player_set_now_playing",
            "player_set_paused",
            "player_seek",
            "player_set_volume",
            "player_set_muted",
            "player_stop",
            "player_select_audio_track",
            "player_select_subtitle_track",
            "player_add_subtitle",
            "player_set_subtitle_style",
            "player_set_subtitle_delay",
            "player_set_audio_delay",
            "player_set_speed",
            "player_stats",
            "player_preview",
        ])),
    )
    .expect("failed to run tauri-build");
}

/// Windows development builds: puts `libmpv-2.dll` beside the executable
/// (`target/<profile>/`), where Windows looks first when loading it.
fn copy_dll_next_to_executable(dll: std::path::PathBuf) {
    println!("cargo:rerun-if-changed={}", dll.display());
    let out_dir = std::path::PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR is set"));
    // OUT_DIR is target/<profile>/build/<crate>-<hash>/out.
    let Some(profile_dir) = out_dir.ancestors().nth(3) else {
        return;
    };
    if let Err(error) = std::fs::copy(&dll, profile_dir.join("libmpv-2.dll")) {
        println!("cargo:warning=could not copy {}: {error}", dll.display());
    }
}
