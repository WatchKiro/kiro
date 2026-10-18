//! Linux video surface: mpv's OpenGL render API into a `GtkGLArea` beneath
//! the transparent WebKitGTK webview.
//!
//! ```text
//! GtkApplicationWindow
//! └── GtkBox (Tauri's default_vbox)
//!     └── GtkOverlay "kiro-video-overlay"   ← put where the webview was, once
//!         ├── GtkBox (main child)
//!         │   └── GtkGLArea                 ← mpv renders here while attached
//!         └── WebKitWebView (overlay)       ← transparent background while attached
//! ```
//!
//! mpv's window embedding (`wid`) only works on X11 and would cover the
//! GTK-drawn webview, and Wayland has no embedding at all. Rendering into a
//! `GtkGLArea` that GTK composites under the webview works on both, which is
//! how GTK mpv front ends (Celluloid) do it.
//!
//! The overlay is installed the first time the player attaches and kept: the
//! webview is moved into it only once. Each attach adds a `GtkGLArea`; each
//! detach removes it and restores the webview's background.
//!
//! All GTK and GL work happens on the main thread. mpv's render context is
//! created when the area is realized (its GL context current), rendered in
//! the area's `render` signal, and freed with the context current again.
//! mpv's update callback (on its render thread) wakes the main loop, which
//! calls `queue_render`; at most one wake-up is in flight. (Not the frame
//! clock: whether it ticks depends on the window manager and compositor.)

use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::{CStr, c_char, c_int, c_void};
use std::mem::ManuallyDrop;
use std::ptr::NonNull;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, PoisonError, mpsc};
use std::thread::{self, ThreadId};

use gtk::glib::translate::ToGlibPtr;
use gtk::prelude::*;
use gtk::{gdk, glib};
use tauri::{Runtime, WebviewWindow};
use webkit2gtk::WebViewExt;

use super::client::{self, Initializer, Mpv};
use super::render::{NativeDisplay, RenderContext, UpdateWaker};
use super::{RenderStats, debug_log_enabled};
use crate::media::PlaybackError;

const OVERLAY_NAME: &str = "kiro-video-overlay";

// --- OpenGL entry points ----------------------------------------------------

const RTLD_NOW: c_int = 2;

unsafe extern "C" {
    fn dlopen(filename: *const c_char, flags: c_int) -> *mut c_void;
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
}

type ProcLoader = unsafe extern "C" fn(name: *const c_char) -> *mut c_void;

/// How GL functions are looked up: EGL on Wayland (and as a fallback), GLX on
/// X11. Chosen once, from GDK's display, when the first area is realized.
static PROC_LOADER: OnceLock<Option<ProcLoader>> = OnceLock::new();

fn find_loader(wayland: bool) -> Option<ProcLoader> {
    let egl = (c"libEGL.so.1", c"eglGetProcAddress");
    let glx = (c"libGL.so.1", c"glXGetProcAddressARB");
    let candidates = if wayland { vec![egl] } else { vec![glx, egl] };
    candidates
        .into_iter()
        .find_map(|(library, symbol): (&CStr, &CStr)| {
            // SAFETY: valid C strings; the library stays loaded (never closed).
            let pointer = unsafe {
                let handle = dlopen(library.as_ptr(), RTLD_NOW);
                if handle.is_null() {
                    return None;
                }
                dlsym(handle, symbol.as_ptr())
            };
            // SAFETY: both symbols have this signature.
            (!pointer.is_null())
                .then(|| unsafe { std::mem::transmute::<*mut c_void, ProcLoader>(pointer) })
        })
}

/// GDK's X11 or Wayland display, which mpv's VA-API hardware decoding uses.
///
/// - **Wayland:** mpv opens VA-API on the compositor's connection and imports
///   decoded frames into the area's (EGL) GL context as dmabufs: zero-copy.
/// - **X11:** GTK 3 renders GL areas with GLX, which can't import dmabufs,
///   and the LGPL libmpv has no X11 VA-API display (mpv's X11 code is GPL).
///   mpv then decodes with `vaapi-copy` through the DRM render node instead.
///   The display is still passed, as mpv's render API recommends.
///
/// Looked up at run time, so a GTK built without one of the backends still
/// works.
fn native_display(display: &gdk::Display) -> Option<NativeDisplay> {
    type GetDisplay = unsafe extern "C" fn(display: *mut c_void) -> *mut c_void;
    let (symbol, wrap): (&CStr, fn(NonNull<c_void>) -> NativeDisplay) = match display.type_().name()
    {
        "GdkWaylandDisplay" => (
            c"gdk_wayland_display_get_wl_display",
            NativeDisplay::Wayland,
        ),
        "GdkX11Display" => (c"gdk_x11_display_get_xdisplay", NativeDisplay::X11),
        _ => return None,
    };
    // SAFETY: looks a GDK function up in the process (RTLD_DEFAULT); it has
    // the `GetDisplay` signature.
    let get: GetDisplay = unsafe {
        let pointer = dlsym(std::ptr::null_mut(), symbol.as_ptr());
        if pointer.is_null() {
            return None;
        }
        std::mem::transmute::<*mut c_void, GetDisplay>(pointer)
    };
    let gdk_display: *mut gdk::ffi::GdkDisplay = display.to_glib_none().0;
    // SAFETY: `gdk_display` is a live display of the matching backend.
    NonNull::new(unsafe { get(gdk_display.cast()) }).map(wrap)
}

unsafe extern "C" fn get_proc_address(_ctx: *mut c_void, name: *const c_char) -> *mut c_void {
    match PROC_LOADER.get().copied().flatten() {
        // SAFETY: `name` is a C string from mpv.
        Some(load) => unsafe { load(name) },
        None => std::ptr::null_mut(),
    }
}

type GlGetIntegerv = unsafe extern "C" fn(pname: u32, data: *mut c_int);
type GlReadPixels = unsafe extern "C" fn(
    x: c_int,
    y: c_int,
    width: c_int,
    height: c_int,
    format: u32,
    kind: u32,
    data: *mut c_void,
);
const GL_FRAMEBUFFER_BINDING: u32 = 0x8CA6;
const GL_RGBA: u32 = 0x1908;
const GL_UNSIGNED_BYTE: u32 = 0x1401;
/// Debug logs: every frame is sampled; the first EARLY_FRAMES and every
/// SAMPLE_EVERY-th are logged.
const SAMPLE_EVERY: u64 = 60;
const EARLY_FRAMES: u64 = 3;

/// Debug logs: when the first video area was installed.
fn started() -> std::time::Instant {
    static STARTED: OnceLock<std::time::Instant> = OnceLock::new();
    *STARTED.get_or_init(std::time::Instant::now)
}

/// A GL function, looked up once (with a GL context current, in `render`).
fn gl_function<F: Copy>(cache: &'static OnceLock<Option<F>>, name: &CStr) -> Option<F> {
    *cache.get_or_init(|| {
        // SAFETY: `name` is a C string; a GL context is current.
        let pointer = unsafe { get_proc_address(std::ptr::null_mut(), name.as_ptr()) };
        // SAFETY: the caller names a function of type `F` (a fn pointer).
        (!pointer.is_null())
            .then(|| unsafe { std::mem::transmute_copy::<*mut c_void, F>(&pointer) })
    })
}

fn gl_get_integerv() -> Option<GlGetIntegerv> {
    static FUNCTION: OnceLock<Option<GlGetIntegerv>> = OnceLock::new();
    gl_function(&FUNCTION, c"glGetIntegerv")
}

fn gl_read_pixels() -> Option<GlReadPixels> {
    static FUNCTION: OnceLock<Option<GlReadPixels>> = OnceLock::new();
    gl_function(&FUNCTION, c"glReadPixels")
}

type GlGetString = unsafe extern "C" fn(name: u32) -> *const c_char;
const GL_RENDERER: u32 = 0x1F01;

/// The current context's renderer, if it is a software rasteriser (Mesa's
/// llvmpipe, softpipe or swrast): no GPU, as in VMs, CI and machines without
/// a working driver.
///
/// There, mpv's single-pass renderer (`gpu-dumb-mode`) is used. It is much
/// cheaper on the CPU, and mpv's full multi-pass renderer intermittently
/// draws only black on llvmpipe: about half of CI's runs, with Ubuntu's
/// libmpv as well as the bundled one. The single-pass renderer, or limiting
/// Mesa to OpenGL 3.3, never did, which points at an OpenGL 4 feature mpv
/// uses; the exact cause isn't pinned down.
fn software_renderer() -> Option<String> {
    static FUNCTION: OnceLock<Option<GlGetString>> = OnceLock::new();
    let get = gl_function(&FUNCTION, c"glGetString")?;
    // SAFETY: a GL context is current; the string is static or null.
    let name = unsafe { get(GL_RENDERER) };
    if name.is_null() {
        return None;
    }
    // SAFETY: a NUL-terminated string owned by the GL implementation.
    let name = unsafe { CStr::from_ptr(name) }
        .to_string_lossy()
        .into_owned();
    let lower = name.to_lowercase();
    ["llvmpipe", "softpipe", "swrast"]
        .iter()
        .any(|software| lower.contains(software))
        .then_some(name)
}

type GlBindFramebuffer = unsafe extern "C" fn(target: u32, framebuffer: u32);
const GL_FRAMEBUFFER: u32 = 0x8D40;
const GL_READ_FRAMEBUFFER: u32 = 0x8CA8;

fn gl_bind_framebuffer() -> Option<GlBindFramebuffer> {
    static FUNCTION: OnceLock<Option<GlBindFramebuffer>> = OnceLock::new();
    gl_function(&FUNCTION, c"glBindFramebuffer")
}

/// A pixel of framebuffer `fbo`, packed `0xRRGGBB` (GL coordinates: y up).
fn sample(fbo: c_int, x: c_int, y: c_int) -> Option<u32> {
    let (read, bind) = (gl_read_pixels()?, gl_bind_framebuffer()?);
    let mut pixel = [0u8; 4];
    // SAFETY: a GL context is current; the buffer holds one RGBA pixel.
    unsafe {
        bind(GL_READ_FRAMEBUFFER, fbo as u32);
        read(
            x,
            y,
            1,
            1,
            GL_RGBA,
            GL_UNSIGNED_BYTE,
            pixel.as_mut_ptr().cast(),
        );
    }
    Some(u32::from(pixel[0]) << 16 | u32::from(pixel[1]) << 8 | u32::from(pixel[2]))
}

// --- Redraws ---------------------------------------------------------------

thread_local! {
    /// The areas mpv draws into, by id, for wake-ups from mpv's render
    /// thread (which can't hold GTK objects). Main thread only.
    static AREAS: RefCell<HashMap<u64, glib::WeakRef<gtk::GLArea>>> = RefCell::default();
}
static NEXT_AREA: AtomicU64 = AtomicU64::new(1);

/// mpv's update callback for area `id`: asks the main thread to redraw it,
/// with at most one request in flight.
fn redraw_waker(id: u64) -> UpdateWaker {
    let scheduled = Arc::new(AtomicBool::new(false));
    Box::new(move || {
        if scheduled.swap(true, Ordering::AcqRel) {
            return;
        }
        let scheduled = scheduled.clone();
        glib::MainContext::default().invoke(move || {
            // Updates that arrive from here on ask again.
            scheduled.store(false, Ordering::Release);
            let area = AREAS.with(|areas| areas.borrow().get(&id).and_then(|area| area.upgrade()));
            if let Some(area) = area {
                area.queue_render();
            }
        });
    })
}

// --- Main-thread state -----------------------------------------------------

/// A value that may only be used, and dropped, on the thread that created it
/// (GTK's main thread), but is held by thread-safe types. Dropped anywhere
/// else, it is leaked rather than dropped on the wrong thread.
struct MainThreadCell<T> {
    value: ManuallyDrop<T>,
    thread: ThreadId,
}

// SAFETY: the value is only reached through `get_mut`/`into_inner`, which
// check the thread, and is never dropped on another thread.
unsafe impl<T> Send for MainThreadCell<T> {}
unsafe impl<T> Sync for MainThreadCell<T> {}

impl<T> MainThreadCell<T> {
    fn new(value: T) -> Self {
        Self {
            value: ManuallyDrop::new(value),
            thread: thread::current().id(),
        }
    }

    fn on_its_thread(&self) -> bool {
        thread::current().id() == self.thread
    }

    fn into_inner(self) -> Option<T> {
        if !self.on_its_thread() {
            return None; // Dropped below: leaked.
        }
        let mut this = ManuallyDrop::new(self);
        // SAFETY: taken once; `this` is never dropped.
        Some(unsafe { ManuallyDrop::take(&mut this.value) })
    }
}

impl<T> Drop for MainThreadCell<T> {
    fn drop(&mut self) {
        if self.on_its_thread() {
            // SAFETY: dropped once, on its thread.
            unsafe { ManuallyDrop::drop(&mut self.value) };
        }
    }
}

/// mpv's render context, created and freed with the area's GL context current.
#[derive(Default)]
struct RenderSlot {
    mpv: Option<Arc<Mpv>>,
    renderer: Option<RenderContext>,
}

/// One attachment: the area mpv renders into, under the webview.
struct Video {
    area: gtk::GLArea,
    /// Its key in [`AREAS`].
    id: u64,
    slot: Rc<RefCell<RenderSlot>>,
    webview: webkit2gtk::WebView,
    /// The webview's own background, restored on detach.
    background: gdk::RGBA,
}

impl Video {
    /// Frees mpv's render context with its GL context current, and lets go
    /// of mpv.
    fn release_renderer(&self) {
        let mut slot = self.slot.borrow_mut();
        if slot.renderer.is_some() {
            self.area.make_current();
            slot.renderer = None;
        }
        slot.mpv = None;
    }

    /// Removes the area and restores the webview's background.
    fn remove(self) {
        AREAS.with(|areas| areas.borrow_mut().remove(&self.id));
        self.release_renderer();
        if let Some(parent) = self
            .area
            .parent()
            .and_then(|p| p.downcast::<gtk::Container>().ok())
        {
            parent.remove(&self.area);
        }
        self.webview.set_background_color(&self.background);
    }
}

/// Runs a closure on the main thread.
type Dispatch = Arc<dyn Fn(Box<dyn FnOnce() + Send>) -> bool + Send + Sync>;

#[derive(Default)]
pub struct VideoSurface {
    video: Mutex<Option<MainThreadCell<Video>>>,
    dispatch: Option<Dispatch>,
}

/// Nothing is needed before mpv exists on Linux.
pub struct Prepared;

impl Prepared {
    /// Renders through the client render API (into the `GtkGLArea`).
    pub fn configure(&self, init: &Initializer) -> client::Result<()> {
        init.set_option("vo", "libmpv")
    }
}

impl VideoSurface {
    pub fn prepare<R: Runtime>(_window: &WebviewWindow<R>) -> Result<Prepared, PlaybackError> {
        Ok(Prepared)
    }

    /// Puts a `GtkGLArea` for mpv beneath the window's webview and makes the
    /// webview's background transparent so the video shows through.
    pub fn attach<R: Runtime>(
        _prepared: Prepared,
        window: &WebviewWindow<R>,
        mpv: Arc<Mpv>,
        stats: Arc<RenderStats>,
    ) -> Result<Self, PlaybackError> {
        let (done_tx, done_rx) = mpsc::channel();
        window
            .with_webview(move |platform| {
                let result = install(platform.inner(), mpv, stats).map(MainThreadCell::new);
                let _ = done_tx.send(result);
            })
            .map_err(|error| PlaybackError::Backend(error.to_string()))?;
        let video = done_rx
            .recv()
            .map_err(|_| PlaybackError::Backend("main thread did not respond".into()))?
            .map_err(|error| PlaybackError::Backend(error.into()))?;

        let window = window.clone();
        let dispatch: Dispatch = Arc::new(move |task| window.run_on_main_thread(task).is_ok());
        Ok(Self {
            video: Mutex::new(Some(video)),
            dispatch: Some(dispatch),
        })
    }

    /// Removes the area and restores the webview's background. Waits for the
    /// main thread, so must not be called on it. Idempotent.
    pub fn detach<R: Runtime>(&self, window: &WebviewWindow<R>) -> Result<(), PlaybackError> {
        let Some(video) = self.take() else {
            return Ok(());
        };
        let (done_tx, done_rx) = mpsc::channel();
        window
            .with_webview(move |_| {
                if let Some(video) = video.into_inner() {
                    video.remove();
                }
                let _ = done_tx.send(());
            })
            .map_err(|error| PlaybackError::Backend(error.to_string()))?;
        done_rx
            .recv()
            .map_err(|_| PlaybackError::Backend("main thread did not respond".into()))
    }

    /// Frees mpv's render context (with its GL context current, on the main
    /// thread) and lets go of mpv, if `detach` hasn't. Waits for the main
    /// thread unless called on it.
    pub fn release_renderer(&self) {
        let Some(video) = self.take() else {
            return;
        };
        if video.on_its_thread() {
            if let Some(video) = video.into_inner() {
                video.remove();
            }
            return;
        }
        let Some(dispatch) = &self.dispatch else {
            return;
        };
        let (done_tx, done_rx) = mpsc::channel();
        let sent = dispatch(Box::new(move || {
            if let Some(video) = video.into_inner() {
                video.remove();
            }
            let _ = done_tx.send(());
        }));
        if sent {
            let _ = done_rx.recv();
        }
    }

    fn take(&self) -> Option<MainThreadCell<Video>> {
        self.video
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
    }
}

/// The box under the webview that holds the area: installs the overlay the
/// first time, moving the webview into it in the same place.
fn video_holder(webview: &webkit2gtk::WebView) -> Result<gtk::Box, &'static str> {
    let parent = webview.parent().ok_or("webview has no parent")?;
    if let Ok(overlay) = parent.clone().downcast::<gtk::Overlay>()
        && overlay.widget_name() == OVERLAY_NAME
    {
        return overlay
            .child()
            .and_then(|child| child.downcast::<gtk::Box>().ok())
            .ok_or("video overlay has no holder");
    }

    let container = parent
        .downcast::<gtk::Box>()
        .map_err(|_| "webview is not in a GtkBox")?;
    let (expand, fill, padding, pack_type) = container.query_child_packing(webview);
    let position: i32 = container.child_property(webview, "position");

    let holder = gtk::Box::new(gtk::Orientation::Vertical, 0);
    let overlay = gtk::Overlay::new();
    overlay.set_widget_name(OVERLAY_NAME);
    overlay.add(&holder);
    // `webview` keeps it alive while it has no parent.
    container.remove(webview);
    overlay.add_overlay(webview);
    container.pack_start(&overlay, expand, fill, padding);
    container.set_child_packing(&overlay, expand, fill, padding, pack_type);
    container.reorder_child(&overlay, position);
    overlay.show_all();
    webview.grab_focus();
    Ok(holder)
}

/// Creates the area for mpv beneath the webview. Main thread.
fn install(
    webview: webkit2gtk::WebView,
    mpv: Arc<Mpv>,
    stats: Arc<RenderStats>,
) -> Result<Video, &'static str> {
    let holder = video_holder(&webview)?;
    started();
    let area = gtk::GLArea::new();
    area.set_auto_render(false);
    area.set_has_alpha(false);
    area.set_can_focus(false);

    let slot = Rc::new(RefCell::new(RenderSlot {
        mpv: Some(mpv),
        renderer: None,
    }));
    let id = NEXT_AREA.fetch_add(1, Ordering::Relaxed);
    AREAS.with(|areas| areas.borrow_mut().insert(id, area.downgrade()));

    // mpv's renderer is created in the area's GL context, once it has one.
    area.connect_realize({
        let slot = slot.clone();
        move |area| {
            area.make_current();
            if let Some(error) = area.error() {
                eprintln!("[kiro-player] no OpenGL context for the video: {error}");
                return;
            }
            let gdk_display = area.display();
            let wayland = gdk_display.type_().name() == "GdkWaylandDisplay";
            PROC_LOADER.get_or_init(|| find_loader(wayland));
            let display = native_display(&gdk_display);
            let mut slot = slot.borrow_mut();
            let Some(mpv) = slot.mpv.clone() else { return };
            if let Some(renderer) = software_renderer() {
                // See `software_renderer`.
                if let Err(error) = mpv.set_property("gpu-dumb-mode", "yes") {
                    eprintln!("[kiro-player] could not simplify rendering for {renderer}: {error}");
                } else if debug_log_enabled() {
                    eprintln!(
                        "[kiro-player] software OpenGL ({renderer}): mpv's single-pass renderer"
                    );
                }
            }
            let pending = Arc::new(AtomicBool::new(false));
            let waker = Some(redraw_waker(id));
            match RenderContext::new_opengl(mpv, get_proc_address, pending, waker, display) {
                Ok(renderer) => slot.renderer = Some(renderer),
                Err(error) => eprintln!("[kiro-player] mpv render context failed: {error}"),
            }
            if debug_log_enabled() {
                eprintln!(
                    "[kiro-player] GL area realized ({}; display for hwdec: {display:?})",
                    if wayland { "Wayland, EGL" } else { "X11" }
                );
            }
        }
    });
    area.connect_unrealize({
        let slot = slot.clone();
        move |area| {
            let mut slot = slot.borrow_mut();
            if slot.renderer.is_some() {
                area.make_current();
                slot.renderer = None;
            }
        }
    });
    area.connect_render({
        let slot = slot.clone();
        move |area, _context| {
            if let Some(renderer) = slot.borrow().renderer.as_ref() {
                render_frame(area, renderer, &stats);
            }
            glib::Propagation::Stop
        }
    });
    holder.pack_start(&area, true, true, 0);
    area.show();

    let background = webview.background_color();
    webview.set_background_color(&gdk::RGBA::new(0.0, 0.0, 0.0, 0.0));
    if debug_log_enabled() {
        let chain: Vec<String> = std::iter::successors(webview.parent(), |widget| widget.parent())
            .map(|widget| format!("{}({})", widget.type_().name(), widget.widget_name()))
            .collect();
        let depth = |widget: &gtk::Widget| {
            widget
                .window()
                .map(|window| {
                    format!(
                        "depth {} native {}",
                        window.visual().depth(),
                        window.has_native()
                    )
                })
                .unwrap_or_else(|| "no window".into())
        };
        eprintln!(
            "[kiro-player] video area under the webview ({}x{}, realized {}, {}); toplevel {}; parents: {}",
            webview.allocated_width(),
            webview.allocated_height(),
            webview.is_realized(),
            depth(webview.upcast_ref()),
            webview
                .toplevel()
                .map(|top| depth(&top))
                .unwrap_or_default(),
            chain.join(" < ")
        );
    }
    Ok(Video {
        area,
        id,
        slot,
        webview,
        background,
    })
}

/// Draws mpv's current frame into the area's framebuffer (bound by GTK).
fn render_frame(area: &gtk::GLArea, renderer: &RenderContext, stats: &RenderStats) {
    let Some(get_integerv) = gl_get_integerv() else {
        return;
    };
    let mut fbo: c_int = 0;
    // SAFETY: the area's GL context is current during `render`.
    unsafe { get_integerv(GL_FRAMEBUFFER_BINDING, &mut fbo) };
    let scale = area.scale_factor();
    let (width, height) = (
        area.allocated_width() * scale,
        area.allocated_height() * scale,
    );

    let flags = renderer.update();
    // GTK composites the area's framebuffer with y up, like a window's.
    let rendered = renderer.render(fbo, width, height, true).is_ok();
    // mpv leaves its own framebuffer bound for reading. GTK reads the area's
    // pixels back from whatever is bound (to composite them without GL), so
    // bind the area's again for both.
    if let Some(bind) = gl_bind_framebuffer() {
        // SAFETY: the area's GL context is current; `fbo` is its framebuffer.
        unsafe { bind(GL_FRAMEBUFFER, fbo as u32) };
    }
    if rendered {
        let frame = stats.frames_rendered.fetch_add(1, Ordering::Relaxed);
        // Debug logs: the stats' sample is the latest frame's.
        if debug_log_enabled() {
            let centre = sample(fbo, width / 2, height / 2);
            if let Some(centre) = centre {
                stats.sample_pixel.store(centre, Ordering::Relaxed);
            }
            if frame < EARLY_FRAMES || frame.is_multiple_of(SAMPLE_EVERY) {
                let top = sample(fbo, width / 2, height - 60);
                eprintln!(
                    "[kiro-player] frame {frame} at {} ms: fbo {fbo}, {width}x{height}, update {flags:#x}, centre #{:06x}, near top #{:06x}",
                    started().elapsed().as_millis(),
                    centre.unwrap_or_default(),
                    top.unwrap_or_default()
                );
            }
        }
    }
    stats
        .contents_scale
        .store(f64::from(scale).to_bits(), Ordering::Relaxed);
    renderer.report_swap();
}
