//! Windows video surface: mpv's own window inside WebView2's host window,
//! beneath the (transparent) browser window.
//!
//! ```text
//! Tauri window
//! └── WRY_WEBVIEW              ← wry's host window for the WebView2 controller
//!     ├── Chrome_WidgetWin_*   ← the browser, transparent while the player is open
//!     └── KiroVideo            ← ours, at the bottom; disabled, so it never takes input
//!         └── mpv's window     ← created by mpv (`wid`), drawn with D3D11
//! ```
//!
//! This is the arrangement Stremio's Windows shell uses: mpv draws into a
//! window that is a sibling of WebView2's below it, and WebView2's background
//! is made fully transparent (`DefaultBackgroundColor` with alpha 0), so the
//! system compositor shows the video wherever the page is transparent.
//!
//! Unlike macOS and Linux this uses mpv's window embedding rather than the
//! render API, so mpv owns its GPU context, presentation and hardware
//! decoding (D3D11). `KiroVideo` follows the host's size through a window
//! subclass, and mpv follows `KiroVideo`.
//!
//! Window calls are made on the main thread (the one that owns these
//! windows). Tearing down from another thread posts a private message to the
//! host, which our subclass handles on the main thread.

use std::ffi::c_void;
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use tauri::{Runtime, WebviewWindow};
use webview2_com::Microsoft::Web::WebView2::Win32::{COREWEBVIEW2_COLOR, ICoreWebView2Controller2};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{BLACK_BRUSH, GetStockObject, HBRUSH};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    CS_HREDRAW, CS_VREDRAW, CreateWindowExW, DefWindowProcW, DestroyWindow, GetClassNameW,
    GetClientRect, GetParent, HCURSOR, HICON, HWND_BOTTOM, MoveWindow, PostMessageW,
    RegisterClassExW, RegisterWindowMessageW, SW_HIDE, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    SetWindowPos, ShowWindow, WM_SIZE, WNDCLASSEXW, WS_CHILD, WS_CLIPCHILDREN, WS_DISABLED,
    WS_EX_NOPARENTNOTIFY, WS_VISIBLE,
};
use windows::core::{Interface, PCWSTR, w};

use super::client::{self, Initializer, Mpv};
use super::{RenderStats, debug_log_enabled};
use crate::media::PlaybackError;

/// Identifies our subclass of the host window.
const SUBCLASS_ID: usize = 0x4b69_726f; // "Kiro"

/// A window handle that can cross threads. Only ever used on the main thread
/// or with thread-safe calls (`PostMessageW`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Handle(isize);

impl Handle {
    fn new(hwnd: HWND) -> Self {
        Self(hwnd.0 as isize)
    }

    fn hwnd(self) -> HWND {
        HWND(self.0 as *mut c_void)
    }
}

/// `KiroVideo` and the host it lives in. Dropping it destroys the window (on
/// the main thread, through the host's message queue) and removes the
/// subclass. mpv must be gone by then: its window is inside.
struct Container {
    host: Handle,
    window: Handle,
}

impl Drop for Container {
    fn drop(&mut self) {
        // SAFETY: posting a message is thread-safe; if the host is already
        // gone (the app is closing) this fails harmlessly.
        let _ = unsafe {
            PostMessageW(
                Some(self.host.hwnd()),
                release_message(),
                WPARAM(self.window.0 as usize),
                LPARAM(0),
            )
        };
    }
}

/// A message private to this process: "destroy `KiroVideo` (wparam) and stop
/// subclassing". Handled in [`host_proc`].
fn release_message() -> u32 {
    static MESSAGE: OnceLock<u32> = OnceLock::new();
    // SAFETY: a constant, NUL-terminated name.
    *MESSAGE.get_or_init(|| unsafe { RegisterWindowMessageW(w!("KiroVideoRelease")) })
}

/// The host window's subclass procedure: keeps `KiroVideo` (`container`) the
/// host's size, and tears it down on [`release_message`].
unsafe extern "system" fn host_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    container: usize,
) -> LRESULT {
    let video = HWND(container as *mut c_void);
    if msg == WM_SIZE {
        let width = (lparam.0 & 0xffff) as i32;
        let height = ((lparam.0 >> 16) & 0xffff) as i32;
        // SAFETY: `video` is our child window, on this thread.
        let _ = unsafe { MoveWindow(video, 0, 0, width, height, false) };
    } else if msg == release_message() {
        // The window named may be an earlier one, released after a new attach
        // took over the subclass. Registered messages are system-wide, so
        // only ever destroy our own child.
        let target = HWND(wparam.0 as *mut c_void);
        // SAFETY: on the thread that owns `hwnd` and its children.
        unsafe {
            if is_video_window(target, hwnd) {
                let _ = DestroyWindow(target);
            }
            if wparam.0 == container {
                let _ = RemoveWindowSubclass(hwnd, Some(host_proc), SUBCLASS_ID);
            }
        }
        return LRESULT(0);
    }
    // SAFETY: forwarding to the next procedure in the chain.
    unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
}

/// Whether `window` is a `KiroVideo` window inside `host`.
unsafe fn is_video_window(window: HWND, host: HWND) -> bool {
    // SAFETY: both calls tolerate invalid handles; the buffer is valid.
    unsafe {
        if !GetParent(window).is_ok_and(|parent| parent == host) {
            return false;
        }
        let mut class = [0u16; 16];
        let length = GetClassNameW(window, &mut class).max(0) as usize;
        class[..length] == *"KiroVideo".encode_utf16().collect::<Vec<_>>()
    }
}

unsafe extern "system" fn container_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    // SAFETY: the default procedure, for our own window.
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

/// Creates `KiroVideo` at the bottom of `host` and subclasses `host`. Main
/// thread only.
fn create_container(host: HWND) -> windows::core::Result<Container> {
    let class_name = w!("KiroVideo");
    // SAFETY: plain Win32 calls with valid arguments, on the thread that
    // owns `host`.
    unsafe {
        let instance = GetModuleHandleW(PCWSTR::null())?;
        let class = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(container_proc),
            hInstance: instance.into(),
            hIcon: HICON::default(),
            hCursor: HCURSOR::default(),
            // Black until mpv's first frame (the page covers it until then).
            hbrBackground: HBRUSH(GetStockObject(BLACK_BRUSH).0),
            lpszClassName: class_name,
            ..Default::default()
        };
        // Fails harmlessly when the class already exists (a second attach).
        RegisterClassExW(&class);

        let mut bounds = RECT::default();
        GetClientRect(host, &mut bounds)?;
        let window = CreateWindowExW(
            WS_EX_NOPARENTNOTIFY,
            class_name,
            PCWSTR::null(),
            // Disabled: clicks and focus belong to the webview above.
            WS_CHILD | WS_VISIBLE | WS_DISABLED | WS_CLIPCHILDREN,
            0,
            0,
            bounds.right - bounds.left,
            bounds.bottom - bounds.top,
            Some(host),
            None,
            Some(instance.into()),
            None,
        )?;
        // Below the browser's window, which wry created first.
        let placed = SetWindowPos(
            window,
            Some(HWND_BOTTOM),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
        if placed.is_err()
            || !SetWindowSubclass(host, Some(host_proc), SUBCLASS_ID, window.0 as usize).as_bool()
        {
            let _ = DestroyWindow(window);
            return Err(windows::core::Error::from_thread());
        }
        Ok(Container {
            host: Handle::new(host),
            window: Handle::new(window),
        })
    }
}

/// Runs `f` on the main thread with the window's WebView2 controller, and
/// waits for its result. Must not be called on the main thread.
fn with_controller<R: Runtime, T: Send + 'static>(
    window: &WebviewWindow<R>,
    f: impl FnOnce(&ICoreWebView2Controller2) -> windows::core::Result<T> + Send + 'static,
) -> Result<T, PlaybackError> {
    let (done_tx, done_rx) = mpsc::channel();
    window
        .with_webview(move |platform| {
            let result = platform
                .controller()
                .cast::<ICoreWebView2Controller2>()
                .and_then(|controller| f(&controller))
                .map_err(|error| error.message());
            let _ = done_tx.send(result);
        })
        .map_err(|error| PlaybackError::Backend(error.to_string()))?;
    done_rx
        .recv()
        .map_err(|_| PlaybackError::Backend("main thread did not respond".into()))?
        .map_err(PlaybackError::Backend)
}

/// `KiroVideo`, created before mpv so its handle can be passed as `wid`.
pub struct Prepared {
    container: Container,
}

impl Prepared {
    /// mpv's own video output in `KiroVideo`. It sits under the webview, so
    /// it gets no input and mustn't act on the cursor.
    pub fn configure(&self, init: &Initializer) -> client::Result<()> {
        init.set_option("wid", self.container.window.0 as i64)?;
        // libplacebo's renderer, falling back to the older one.
        init.set_option("vo", "gpu-next,gpu")?;
        init.set_option("force-window", "no")?;
        init.set_option("input-cursor", "no")?;
        init.set_option("cursor-autohide", "no")?;
        Ok(())
    }
}

/// The webview background colour to restore on detach, as `(A, R, G, B)`.
type Color = (u8, u8, u8, u8);

#[derive(Default)]
pub struct VideoSurface {
    container: Mutex<Option<Container>>,
    background: Mutex<Option<Color>>,
}

impl VideoSurface {
    /// Creates `KiroVideo` at the bottom of WebView2's host window.
    pub fn prepare<R: Runtime>(window: &WebviewWindow<R>) -> Result<Prepared, PlaybackError> {
        let (done_tx, done_rx) = mpsc::channel();
        window
            .with_webview(move |platform| {
                let result = (|| {
                    let mut host = HWND::default();
                    // SAFETY: a valid out pointer.
                    unsafe { platform.controller().ParentWindow(&mut host)? };
                    create_container(host)
                })()
                .map_err(|error| error.message());
                let _ = done_tx.send(result);
            })
            .map_err(|error| PlaybackError::Backend(error.to_string()))?;
        let container = done_rx
            .recv()
            .map_err(|_| PlaybackError::Backend("main thread did not respond".into()))?
            .map_err(PlaybackError::Backend)?;
        if debug_log_enabled() {
            eprintln!(
                "[kiro-player] video window {:#x} in host {:#x}",
                container.window.0, container.host.0
            );
        }
        Ok(Prepared { container })
    }

    /// Makes the webview transparent over `KiroVideo`, where mpv now draws.
    pub fn attach<R: Runtime>(
        prepared: Prepared,
        window: &WebviewWindow<R>,
        _mpv: Arc<Mpv>,
        stats: Arc<RenderStats>,
    ) -> Result<Self, PlaybackError> {
        let video = prepared.container.window;
        let (background, scale) = with_controller(window, move |controller| {
            let mut previous = COREWEBVIEW2_COLOR::default();
            // SAFETY: valid pointer; called on the main thread.
            unsafe {
                controller.DefaultBackgroundColor(&mut previous)?;
                controller.SetDefaultBackgroundColor(COREWEBVIEW2_COLOR {
                    A: 0,
                    R: 0,
                    G: 0,
                    B: 0,
                })?;
            }
            // SAFETY: our window, on its thread.
            let dpi = unsafe { GetDpiForWindow(video.hwnd()) };
            Ok((
                (previous.A, previous.R, previous.G, previous.B),
                f64::from(dpi.max(96)) / 96.0,
            ))
        })?;
        stats
            .contents_scale
            .store(scale.to_bits(), std::sync::atomic::Ordering::Relaxed);
        Ok(Self {
            container: Mutex::new(Some(prepared.container)),
            background: Mutex::new(Some(background)),
        })
    }

    /// Hides the video and restores the webview's opaque background. The
    /// window itself goes when the surface is dropped, after mpv. Waits for
    /// the main thread, so must not be called on it. Idempotent.
    pub fn detach<R: Runtime>(&self, window: &WebviewWindow<R>) -> Result<(), PlaybackError> {
        let Some((a, r, g, b)) = self
            .background
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
        else {
            return Ok(());
        };
        let video = self
            .container
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .map(|container| container.window);
        with_controller(window, move |controller| {
            // SAFETY: called on the main thread, which owns the windows.
            unsafe {
                if let Some(video) = video {
                    let _ = ShowWindow(video.hwnd(), SW_HIDE);
                }
                controller.SetDefaultBackgroundColor(COREWEBVIEW2_COLOR {
                    A: a,
                    R: r,
                    G: g,
                    B: b,
                })
            }
        })
    }

    /// mpv renders on its own and frees its renderer with the core.
    pub fn release_renderer(&self) {}
}
