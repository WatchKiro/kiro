// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    avoid_blank_window_on_nvidia();
    kiro_lib::run();
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
