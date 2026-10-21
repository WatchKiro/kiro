// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "macos")]
    restore_temp_dir();
    #[cfg(target_os = "linux")]
    avoid_blank_window_on_nvidia();
    kiro_lib::run();
}

/// macOS gives each user a private temporary folder, named in `TMPDIR`. It's
/// where Discord puts its IPC socket, so Discord Rich Presence looks there.
/// Some launchers start Kiro without `TMPDIR` (Turborepo's task runner strips
/// it from `pnpm dev`), and then Kiro can't find a running Discord. Ask macOS
/// for the folder instead.
///
/// Runs first thing, before any thread reads the environment.
#[cfg(target_os = "macos")]
fn restore_temp_dir() {
    use std::os::unix::ffi::OsStringExt;

    if std::env::var_os("TMPDIR").is_some() {
        return;
    }
    let mut path = vec![0u8; 1024];
    // SAFETY: `path` is a writable buffer of the length passed.
    let len = unsafe {
        libc::confstr(
            libc::_CS_DARWIN_USER_TEMP_DIR,
            path.as_mut_ptr().cast(),
            path.len(),
        )
    };
    // 0 is a failure; a length beyond the buffer means it didn't fit.
    if len == 0 || len > path.len() {
        return;
    }
    path.truncate(len - 1); // The length includes the closing NUL.
    // SAFETY: no other threads exist yet; nothing reads the environment
    // concurrently.
    unsafe { std::env::set_var("TMPDIR", std::ffi::OsString::from_vec(path)) };
}

/// WebKitGTK's DMA-BUF renderer (2.42 and later) hands the page to the UI
/// process in GPU buffers allocated through GBM, in formats NVIDIA's
/// proprietary driver doesn't provide: the window stays blank or white.
///
/// The usual workaround, `WEBKIT_DISABLE_DMABUF_RENDERER=1`, falls back to
/// WebKit's older renderer, which doesn't draw the page over the video area
/// beneath the webview (the player's controls disappear). Instead keep the
/// DMA-BUF renderer and make it pass the page through shared memory: the
/// same path WebKit takes on machines without a DRM device, which CI
/// exercises. It costs a copy per frame, so it's only done when NVIDIA's
/// driver is loaded, and never over the user's own WebKit settings. See
/// docs/releasing.md (NVIDIA).
///
/// WebKit reads these once, when it starts, so this runs first thing.
#[cfg(target_os = "linux")]
fn avoid_blank_window_on_nvidia() {
    const FORCE_SHM: &str = "WEBKIT_DMABUF_RENDERER_FORCE_SHM";
    const DISABLE: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
    // Present while NVIDIA's kernel driver (proprietary or open) is loaded,
    // not with nouveau.
    let nvidia = std::path::Path::new("/proc/driver/nvidia/version").exists();
    if nvidia && std::env::var_os(FORCE_SHM).is_none() && std::env::var_os(DISABLE).is_none() {
        // SAFETY: no other threads exist yet; nothing reads the environment
        // concurrently.
        unsafe { std::env::set_var(FORCE_SHM, "1") };
    }
}
