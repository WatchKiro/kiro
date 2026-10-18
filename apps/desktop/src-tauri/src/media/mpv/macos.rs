//! macOS video surface for libmpv.
//!
//! mpv 0.37+ cannot embed into an existing NSView via `--wid` on macOS, so we
//! use the render API instead (the approach IINA and mpv's own cocoa-cb take):
//!
//! ```text
//! NSWindow.contentView (wry's WebView parent)
//! ├── KiroVideoView  ← layer-hosting view, backed by KiroVideoLayer (CAOpenGLLayer)
//! └── WKWebView      ← transparent background, HTML controls on top
//! ```
//!
//! The layer runs asynchronously: Core Animation asks `canDrawInCGLContext`
//! at display rate on its own thread, and we answer "yes" only when mpv's
//! update callback reported a new frame (or the size changed). All
//! `mpv_render_*` calls happen inside `drawInCGLContext`, with the layer's
//! CGL context current, serialised by the [`RenderSlot`] mutex — as
//! `render.h` requires.
//!
//! Teardown ([`VideoSurface::release_renderer`]) empties the slot, so no
//! further draw renders, then frees mpv's render context with the GL context
//! it was created in made current. Lock order is always CGL context lock →
//! slot mutex (Core Animation holds the former around draws), so teardown
//! never holds the slot while it takes the CGL lock.

// Apple deprecated OpenGL (and CAOpenGLLayer) in macOS 10.14, but it still
// ships and is what libmpv's render API offers today (no Metal backend yet).
#![allow(deprecated)]

use std::ffi::{c_char, c_void};
use std::ptr::{self, NonNull};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{AnyThread, DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send};
use objc2_app_kit::{NSAutoresizingMaskOptions, NSResponder, NSView, NSWindowOrderingMode};
use objc2_core_foundation::{CFTimeInterval, CGRect};
use objc2_core_video::CVTimeStamp;
use objc2_foundation::{NSNumber, NSObject, NSObjectNSKeyValueCoding, ns_string};
use objc2_open_gl::{
    CGLChoosePixelFormat, CGLContextObj, CGLGetCurrentContext, CGLLockContext, CGLOpenGLProfile,
    CGLPixelFormatAttribute, CGLPixelFormatObj, CGLReleaseContext, CGLRetainContext,
    CGLSetCurrentContext, CGLUnlockContext,
};
use objc2_quartz_core::{CALayer, CAOpenGLLayer};
use tauri::{Runtime, WebviewWindow};

use super::client::{self, Initializer, Mpv};
use super::render::RenderContext;
use super::{RenderStats, debug_log_enabled};
use crate::media::PlaybackError;

type GLint = i32;

const GL_VIEWPORT: u32 = 0x0BA2;
const GL_DRAW_FRAMEBUFFER_BINDING: u32 = 0x8CA6;
const GL_READ_FRAMEBUFFER: u32 = 0x8CA8;
const GL_READ_FRAMEBUFFER_BINDING: u32 = 0x8CAA;
const GL_RGBA: u32 = 0x1908;
const GL_UNSIGNED_BYTE: u32 = 0x1401;
/// Read back sample pixels every N frames (debug stats).
const SAMPLE_EVERY: u64 = 60;
/// `RTLD_DEFAULT` on Apple platforms.
const RTLD_DEFAULT: *mut c_void = -2isize as *mut c_void;

#[link(name = "OpenGL", kind = "framework")]
unsafe extern "C" {
    fn glGetIntegerv(pname: u32, data: *mut GLint);
    fn glReadPixels(
        x: GLint,
        y: GLint,
        w: GLint,
        h: GLint,
        format: u32,
        kind: u32,
        data: *mut c_void,
    );
    fn glGetError() -> u32;
    fn glBindFramebuffer(target: u32, framebuffer: u32);
}

/// Brightest of five sample points (centre and quarter points) of `fbo`,
/// packed `0xRRGGBB`. A non-black value proves mpv drew image data into the layer.
fn sample_brightest(fbo: GLint, width: GLint, height: GLint) -> u32 {
    // CAOpenGLLayer draws into its own FBO; the read binding must match.
    let mut previous_read: GLint = 0;
    unsafe {
        glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &mut previous_read);
        glBindFramebuffer(GL_READ_FRAMEBUFFER, fbo as u32);
    }
    let points = [
        (width / 2, height / 2),
        (width / 4, height / 4),
        (3 * width / 4, height / 4),
        (width / 4, 3 * height / 4),
        (3 * width / 4, 3 * height / 4),
    ];
    let mut best = (0u32, 0u32);
    for (x, y) in points {
        let mut rgba = [0u8; 4];
        unsafe {
            glReadPixels(
                x,
                y,
                1,
                1,
                GL_RGBA,
                GL_UNSIGNED_BYTE,
                rgba.as_mut_ptr().cast(),
            );
        }
        let luma = u32::from(rgba[0]) + u32::from(rgba[1]) + u32::from(rgba[2]);
        if luma >= best.0 {
            best = (luma, u32::from_be_bytes([0, rgba[0], rgba[1], rgba[2]]));
        }
    }
    unsafe { glBindFramebuffer(GL_READ_FRAMEBUFFER, previous_read as u32) };
    best.1
}

unsafe extern "C" {
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
}

/// mpv resolves GL entry points through this. On macOS every GL function is
/// exported by OpenGL.framework, which is linked above.
unsafe extern "C" fn get_proc_address(_ctx: *mut c_void, name: *const c_char) -> *mut c_void {
    // SAFETY: mpv passes a NUL-terminated function name.
    unsafe { dlsym(RTLD_DEFAULT, name) }
}

/// A retained CGL context.
struct GlContext(CGLContextObj);

impl GlContext {
    fn retain(ctx: CGLContextObj) -> Self {
        Self(unsafe { CGLRetainContext(ctx) })
    }

    /// Runs `f` with this context locked and current on the calling thread,
    /// restoring whatever was current before.
    fn with_current<T>(&self, f: impl FnOnce() -> T) -> T {
        unsafe {
            CGLLockContext(self.0);
            let previous = CGLGetCurrentContext();
            CGLSetCurrentContext(self.0);
            let result = f();
            CGLSetCurrentContext(previous);
            CGLUnlockContext(self.0);
            result
        }
    }
}

impl Drop for GlContext {
    fn drop(&mut self) {
        unsafe { CGLReleaseContext(self.0) };
    }
}

/// mpv's GL renderer, bound to the CGL context it was created in.
struct GlRenderer {
    /// Always `Some` until dropped. Holds the core, which it must not outlive.
    render: Option<RenderContext>,
    gl: GlContext,
}

// SAFETY: mpv's render API is not tied to a thread; it requires that calls
// are not concurrent and that the right GL context is current. Calls are
// serialised by the `RenderSlot` mutex, and happen either inside
// `drawInCGLContext` (context current) or in `Drop` (made current there).
// The CGL context is reference-counted and thread-safe to retain/release.
unsafe impl Send for GlRenderer {}

impl GlRenderer {
    fn create(mpv: Arc<Mpv>, ctx: CGLContextObj, pending: Arc<AtomicBool>) -> Option<Self> {
        // mpv's update callback just flags the next vsync in `pending`.
        let context = match RenderContext::new_opengl(mpv, get_proc_address, pending, None, None) {
            Ok(context) => context,
            Err(error) => {
                eprintln!("[kiro] mpv render context failed: {error}");
                return None;
            }
        };
        Some(Self {
            render: Some(context),
            gl: GlContext::retain(ctx),
        })
    }

    fn context(&self) -> &RenderContext {
        self.render
            .as_ref()
            .expect("render context is present until drop")
    }
}

impl Drop for GlRenderer {
    fn drop(&mut self) {
        let Some(render) = self.render.take() else {
            return;
        };
        // Clears the update callback, then frees the render context, with
        // the GL context it was created in current.
        self.gl.with_current(|| drop(render));
        if debug_log_enabled() {
            eprintln!("[kiro-player] render context freed");
        }
    }
}

/// The renderer state behind the layer, guarded by one mutex.
#[derive(Default)]
struct RenderSlot {
    /// The core to render; `None` once the surface was released.
    mpv: Option<Arc<Mpv>>,
    /// Created on the first draw, when the layer's GL context is current.
    renderer: Option<GlRenderer>,
}

/// State shared by the layer (Core Animation's thread) and the player.
pub struct LayerShared {
    slot: Mutex<RenderSlot>,
    /// Set by mpv's update callback (any thread), consumed by `canDraw`.
    frame_pending: Arc<AtomicBool>,
    /// Pixel size of the last frame drawn, to redraw after a resize.
    last_size: Mutex<(i64, i64)>,
    stats: Arc<RenderStats>,
}

impl LayerShared {
    fn slot(&self) -> MutexGuard<'_, RenderSlot> {
        self.slot.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

define_class!(
    // SAFETY: CAOpenGLLayer has no subclassing requirements beyond overriding
    // its documented hooks, and `VideoLayer` does not implement `Drop`.
    #[unsafe(super(CAOpenGLLayer, CALayer, NSObject))]
    #[name = "KiroVideoLayer"]
    #[ivars = Arc<LayerShared>]
    struct VideoLayer;

    impl VideoLayer {
        /// Request an accelerated OpenGL 3.2 core profile (mpv needs GL ≥ 3.2 core or 2.1 legacy).
        #[unsafe(method(copyCGLPixelFormatForDisplayMask:))]
        fn copy_pixel_format(&self, mask: u32) -> CGLPixelFormatObj {
            let attributes = [
                CGLPixelFormatAttribute::CGLPFAOpenGLProfile,
                CGLPixelFormatAttribute(CGLOpenGLProfile::CGLOGLPVersion_3_2_Core.0),
                CGLPixelFormatAttribute::CGLPFAAccelerated,
                CGLPixelFormatAttribute::CGLPFADoubleBuffer,
                CGLPixelFormatAttribute::CGLPFAAllowOfflineRenderers,
                CGLPixelFormatAttribute(0),
            ];
            let mut pixel_format: CGLPixelFormatObj = ptr::null_mut();
            let mut count: GLint = 0;
            unsafe {
                CGLChoosePixelFormat(
                    NonNull::new_unchecked(attributes.as_ptr().cast_mut()),
                    NonNull::from(&mut pixel_format),
                    NonNull::from(&mut count),
                );
            }
            if pixel_format.is_null() {
                // Fall back to the default (legacy GL 2.1) format.
                return unsafe { msg_send![super(self), copyCGLPixelFormatForDisplayMask: mask] };
            }
            pixel_format
        }

        #[unsafe(method(canDrawInCGLContext:pixelFormat:forLayerTime:displayTime:))]
        fn can_draw(
            &self,
            _ctx: CGLContextObj,
            _pf: CGLPixelFormatObj,
            _t: CFTimeInterval,
            _ts: *const CVTimeStamp,
        ) -> bool {
            let shared = self.ivars();
            let (attached, first_draw) = {
                let slot = shared.slot();
                (slot.mpv.is_some(), slot.renderer.is_none())
            };
            let resized = *shared.last_size.lock().unwrap_or_else(PoisonError::into_inner)
                != self.pixel_size();
            attached && (shared.frame_pending.swap(false, Ordering::AcqRel) || first_draw || resized)
        }

        #[unsafe(method(drawInCGLContext:pixelFormat:forLayerTime:displayTime:))]
        fn draw(
            &self,
            ctx: CGLContextObj,
            pf: CGLPixelFormatObj,
            t: CFTimeInterval,
            ts: *const CVTimeStamp,
        ) {
            let shared = self.ivars();
            let mut slot = shared.slot();

            if let Some(mpv) = slot.mpv.clone() {
                // Core Animation can replace the layer's GL context (e.g. on
                // a GPU switch). The renderer belongs to the old one: free it
                // there and start again in this one.
                if slot.renderer.as_ref().is_some_and(|r| r.gl.0 != ctx) {
                    slot.renderer = None;
                }
                if slot.renderer.is_none() {
                    // The layer's GL context is current: this is where mpv's
                    // GL renderer must be created.
                    slot.renderer = GlRenderer::create(mpv, ctx, shared.frame_pending.clone());
                }
            }

            if let Some(renderer) = slot.renderer.as_ref() {
                self.render_frame(renderer.context(), shared);
            }

            // The superclass implementation flushes the context to the layer.
            unsafe {
                let _: () = msg_send![
                    super(self),
                    drawInCGLContext: ctx,
                    pixelFormat: pf,
                    forLayerTime: t,
                    displayTime: ts
                ];
            }
            if let Some(renderer) = slot.renderer.as_ref() {
                renderer.context().report_swap();
            }
        }
    }
);

impl VideoLayer {
    fn new(shared: Arc<LayerShared>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(shared);
        unsafe { msg_send![super(this), init] }
    }

    fn pixel_size(&self) -> (i64, i64) {
        let bounds = self.bounds();
        let scale = self.contentsScale();
        (
            (bounds.size.width * scale).round() as i64,
            (bounds.size.height * scale).round() as i64,
        )
    }

    /// Renders mpv's current frame into the layer's framebuffer. Called from
    /// `drawInCGLContext` with the slot locked.
    fn render_frame(&self, context: &RenderContext, shared: &LayerShared) {
        let mut fbo: GLint = 0;
        let mut viewport: [GLint; 4] = [0; 4];
        unsafe {
            glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &mut fbo);
            glGetIntegerv(GL_VIEWPORT, viewport.as_mut_ptr());
        }
        context.update();
        let (width, height) = (viewport[2], viewport[3]);
        let log = debug_log_enabled();
        let error_before = if log { unsafe { glGetError() } } else { 0 };
        if context.render(fbo, width, height, true).is_ok() {
            let error_render = if log { unsafe { glGetError() } } else { 0 };
            let stats = &shared.stats;
            let frame = stats.frames_rendered.fetch_add(1, Ordering::Relaxed);
            if frame.is_multiple_of(SAMPLE_EVERY) {
                let pixel = sample_brightest(fbo, width, height);
                stats.sample_pixel.store(pixel, Ordering::Relaxed);
                if log && frame < SAMPLE_EVERY * 3 {
                    let error_read = unsafe { glGetError() };
                    eprintln!(
                        "[kiro-player] frame {frame}: fbo={fbo} viewport={viewport:?} \
                         gl_error before={error_before:#x} render={error_render:#x} \
                         read={error_read:#x} pixel=#{pixel:06x}"
                    );
                }
            }
        }
        let scale = self.contentsScale();
        shared
            .stats
            .contents_scale
            .store(scale.to_bits(), Ordering::Relaxed);
        let size = self.pixel_size();
        let previous = std::mem::replace(
            &mut *shared
                .last_size
                .lock()
                .unwrap_or_else(PoisonError::into_inner),
            size,
        );
        // Window resizes and fullscreen changes resize the layer (autoresizing
        // view); the next draw renders at the new size.
        if log && previous != size && previous != (0, 0) {
            eprintln!(
                "[kiro-player] resized {}x{} -> {}x{} (viewport {width}x{height})",
                previous.0, previous.1, size.0, size.1
            );
        }
    }
}

define_class!(
    // SAFETY: a plain NSView subclass that only overrides notification hooks,
    // calling `super` first; it has no ivars and does not implement `Drop`.
    #[unsafe(super(NSView, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "KiroVideoView"]
    struct VideoView;

    impl VideoView {
        /// The window moved to a display with a different scale factor (or
        /// the display's resolution changed).
        #[unsafe(method(viewDidChangeBackingProperties))]
        fn did_change_backing_properties(&self) {
            let _: () = unsafe { msg_send![super(self), viewDidChangeBackingProperties] };
            self.sync_contents_scale();
        }

        #[unsafe(method(viewDidMoveToWindow))]
        fn did_move_to_window(&self) {
            let _: () = unsafe { msg_send![super(self), viewDidMoveToWindow] };
            self.sync_contents_scale();
        }
    }
);

impl VideoView {
    fn new(mtm: MainThreadMarker, frame: CGRect) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(());
        unsafe { msg_send![super(this), initWithFrame: frame] }
    }

    /// Layer-*hosting* views do not update their layer's `contentsScale`, so
    /// match it to the window's backing scale; the next draw then renders at
    /// the new pixel size.
    fn sync_contents_scale(&self) {
        let (Some(window), Some(layer)) = (self.window(), self.layer()) else {
            return;
        };
        let scale = window.backingScaleFactor();
        if layer.contentsScale() != scale {
            if debug_log_enabled() {
                eprintln!(
                    "[kiro-player] contentsScale {} -> {scale}",
                    layer.contentsScale()
                );
            }
            layer.setContentsScale(scale);
            layer.setNeedsDisplay();
        }
    }
}

/// A value that may only be used, and dropped, on the main thread, but can
/// be moved between threads in the meantime.
struct MainThreadCell<T>(Option<T>);

// SAFETY: the inner value is only reachable through `take`, which requires a
// `MainThreadMarker`; off the main thread `Drop` leaks it instead.
unsafe impl<T> Send for MainThreadCell<T> {}
unsafe impl<T> Sync for MainThreadCell<T> {}

impl<T> MainThreadCell<T> {
    fn new(value: T, _mtm: MainThreadMarker) -> Self {
        Self(Some(value))
    }

    fn take(mut self, _mtm: MainThreadMarker) -> Option<T> {
        self.0.take()
    }
}

impl<T> Drop for MainThreadCell<T> {
    fn drop(&mut self) {
        if let Some(value) = self.0.take()
            && MainThreadMarker::new().is_none()
        {
            // Releasing AppKit objects off the main thread is unsafe; this
            // only happens when the window is already gone, so leak instead.
            std::mem::forget(value);
        }
    }
}

/// The video view inserted under a window's webview, and its renderer state.
#[derive(Default)]
pub struct VideoSurface {
    shared: Option<Arc<LayerShared>>,
    view: Mutex<Option<MainThreadCell<Retained<VideoView>>>>,
}

/// Nothing is needed before mpv exists on macOS.
pub struct Prepared;

impl Prepared {
    /// Renders through the client render API rather than mpv's own window
    /// (mpv 0.37+ cannot embed into an existing NSView with `wid`).
    pub fn configure(&self, init: &Initializer) -> client::Result<()> {
        init.set_option("vo", "libmpv")
    }
}

impl VideoSurface {
    pub fn prepare<R: Runtime>(_window: &WebviewWindow<R>) -> Result<Prepared, PlaybackError> {
        Ok(Prepared)
    }

    /// Inserts the mpv video view beneath the window's WKWebView and makes the
    /// webview's background transparent so the video shows through.
    pub fn attach<R: Runtime>(
        _prepared: Prepared,
        window: &WebviewWindow<R>,
        mpv: Arc<Mpv>,
        stats: Arc<RenderStats>,
    ) -> Result<Self, PlaybackError> {
        let shared = Arc::new(LayerShared {
            slot: Mutex::new(RenderSlot {
                mpv: Some(mpv),
                renderer: None,
            }),
            frame_pending: Arc::new(AtomicBool::new(true)),
            last_size: Mutex::new((0, 0)),
            stats,
        });
        let layer_shared = shared.clone();
        let (done_tx, done_rx) = std::sync::mpsc::channel();

        window
            .with_webview(move |platform| {
                let result = (|| {
                    let mtm = MainThreadMarker::new().ok_or("not on the main thread")?;
                    // SAFETY: on macOS `inner()` is the WKWebView, an NSView subclass.
                    let webview: &NSView = unsafe { &*platform.inner().cast::<NSView>() };
                    let parent =
                        unsafe { webview.superview() }.ok_or("webview has no superview")?;

                    set_draws_background(webview, false);

                    let layer = VideoLayer::new(layer_shared);
                    layer.setAsynchronous(true);
                    layer.setNeedsDisplayOnBoundsChange(true);

                    let view = VideoView::new(mtm, parent.bounds());
                    // Layer-hosting view: assign the layer before enabling wantsLayer.
                    view.setLayer(Some(&layer));
                    view.setWantsLayer(true);
                    view.setAutoresizingMask(
                        NSAutoresizingMaskOptions::ViewWidthSizable
                            | NSAutoresizingMaskOptions::ViewHeightSizable,
                    );
                    // Sets the layer's contentsScale (`viewDidMoveToWindow`).
                    parent.addSubview_positioned_relativeTo(
                        &view,
                        NSWindowOrderingMode::Below,
                        Some(webview),
                    );
                    Ok::<_, &'static str>(MainThreadCell::new(view, mtm))
                })();
                let _ = done_tx.send(result);
            })
            .map_err(|error| PlaybackError::Backend(error.to_string()))?;

        let view = done_rx
            .recv()
            .map_err(|_| PlaybackError::Backend("main thread did not respond".into()))?
            .map_err(|error| PlaybackError::Backend(error.into()))?;
        Ok(Self {
            shared: Some(shared),
            view: Mutex::new(Some(view)),
        })
    }

    /// Removes the video view and restores the webview's opaque background.
    /// Waits for the main thread, so must not be called on it. Idempotent.
    pub fn detach<R: Runtime>(&self, window: &WebviewWindow<R>) -> Result<(), PlaybackError> {
        let Some(view) = self
            .view
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
        else {
            return Ok(());
        };
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        window
            .with_webview(move |platform| {
                if let Some(mtm) = MainThreadMarker::new() {
                    if let Some(view) = view.take(mtm) {
                        view.removeFromSuperview();
                    }
                    // SAFETY: on macOS `inner()` is the WKWebView.
                    let webview: &NSView = unsafe { &*platform.inner().cast::<NSView>() };
                    set_draws_background(webview, true);
                }
                let _ = done_tx.send(());
            })
            .map_err(|error| PlaybackError::Backend(error.to_string()))?;
        done_rx
            .recv()
            .map_err(|_| PlaybackError::Backend("main thread did not respond".into()))
    }

    /// Stops rendering and frees mpv's render context with its GL context
    /// current. Safe to call from any thread except while holding a CGL lock,
    /// and more than once.
    pub fn release_renderer(&self) {
        let Some(shared) = &self.shared else {
            return;
        };
        let (renderer, mpv) = {
            let mut slot = shared.slot();
            (slot.renderer.take(), slot.mpv.take())
        };
        // The slot is unlocked: dropping the renderer takes the CGL lock.
        drop(renderer);
        drop(mpv);
    }
}

/// Toggles WKWebView's background through the private KVC key wry also uses
/// for transparent webviews.
fn set_draws_background(webview: &NSView, draws: bool) {
    unsafe {
        let value = NSNumber::new_bool(draws);
        let value: &AnyObject = value.as_ref();
        webview.setValue_forKey(Some(value), ns_string!("drawsBackground"));
    }
}
