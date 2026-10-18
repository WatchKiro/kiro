//! A safe wrapper over libmpv's OpenGL render API ([`ffi`](super::ffi)).
//!
//! `render.h` rules this wrapper relies on its caller for: calls on one
//! render context must not run concurrently, and the GL context it was
//! created in must be current for [`RenderContext::new_opengl`],
//! [`RenderContext::render`] and the drop. The video surfaces meet both
//! (`macos.rs`, `linux.rs`). [`RenderContext`] is neither `Send` nor `Sync`
//! on its own.

use std::ffi::{c_int, c_void};
use std::ptr::{self, NonNull};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use super::client::{Error, Mpv, Result};
use super::ffi;

pub use super::ffi::GetProcAddressFn;

/// Called (on mpv's render thread) whenever a new frame is due, after the
/// update flag is set. Must not call mpv; it can wake the thread that renders.
pub type UpdateWaker = Box<dyn Fn() + Send + Sync>;

/// The host's windowing-system connection, which mpv uses to open VA-API
/// for hardware decoding with zero-copy interop (Linux). It must outlive the
/// render context; GDK's display lives as long as the process.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
#[derive(Clone, Copy, Debug)]
pub enum NativeDisplay {
    /// An X11 `Display*`.
    X11(NonNull<c_void>),
    /// A Wayland `struct wl_display*`.
    Wayland(NonNull<c_void>),
}

/// What mpv's update callback reaches.
struct UpdateTarget {
    flag: Arc<AtomicBool>,
    wake: Option<UpdateWaker>,
}

/// mpv's renderer for one core, drawing with OpenGL.
pub struct RenderContext {
    ctx: NonNull<ffi::mpv_render_context>,
    /// What the update callback reaches: a `Box::into_raw`, released on drop
    /// once mpv can no longer call the callback.
    update_target: *mut UpdateTarget,
    /// The render context must be freed before its core (render.h).
    _mpv: Arc<Mpv>,
}

/// mpv's update callback: must not call mpv, so it only raises the flag and
/// wakes the renderer.
unsafe extern "C" fn on_update(target: *mut c_void) {
    // SAFETY: `target` is the `update_target` of a live `RenderContext`; the
    // callback is unregistered before that is released.
    let target = unsafe { &*target.cast::<UpdateTarget>() };
    target.flag.store(true, Ordering::Release);
    if let Some(wake) = &target.wake {
        wake();
    }
}

impl RenderContext {
    /// Creates mpv's OpenGL renderer for `mpv` in the current GL context.
    /// mpv resolves GL functions with `get_proc_address` while it is created.
    /// Whenever a new frame is due (from any thread), `update_flag` is set
    /// and `wake`, if any, is called. `display` is the host's X11 or Wayland
    /// display, if any.
    pub fn new_opengl(
        mpv: Arc<Mpv>,
        get_proc_address: GetProcAddressFn,
        update_flag: Arc<AtomicBool>,
        wake: Option<UpdateWaker>,
        display: Option<NativeDisplay>,
    ) -> Result<Self> {
        let mut init = ffi::mpv_opengl_init_params {
            get_proc_address: Some(get_proc_address),
            get_proc_address_ctx: ptr::null_mut(),
        };
        // An unset display is passed as an invalid (terminating) entry.
        let display = match display {
            Some(NativeDisplay::X11(display)) => ffi::mpv_render_param {
                kind: ffi::MPV_RENDER_PARAM_X11_DISPLAY,
                data: display.as_ptr(),
            },
            Some(NativeDisplay::Wayland(display)) => ffi::mpv_render_param {
                kind: ffi::MPV_RENDER_PARAM_WL_DISPLAY,
                data: display.as_ptr(),
            },
            None => ffi::mpv_render_param {
                kind: ffi::MPV_RENDER_PARAM_INVALID,
                data: ptr::null_mut(),
            },
        };
        let mut params = [
            ffi::mpv_render_param {
                kind: ffi::MPV_RENDER_PARAM_API_TYPE,
                data: ffi::MPV_RENDER_API_TYPE_OPENGL.as_ptr().cast_mut().cast(),
            },
            ffi::mpv_render_param {
                kind: ffi::MPV_RENDER_PARAM_OPENGL_INIT_PARAMS,
                data: (&raw mut init).cast(),
            },
            display,
            ffi::mpv_render_param {
                kind: ffi::MPV_RENDER_PARAM_INVALID,
                data: ptr::null_mut(),
            },
        ];
        let mut ctx = ptr::null_mut();
        // SAFETY: the core is live (held by `mpv`); `params` is terminated and
        // its data outlives the call (mpv copies what it keeps, and the display
        // outlives the context, as `NativeDisplay` requires).
        let code =
            unsafe { ffi::mpv_render_context_create(&mut ctx, mpv.handle(), params.as_mut_ptr()) };
        if code < 0 {
            return Err(Error::Raw(code));
        }
        let ctx = NonNull::new(ctx).ok_or(Error::Raw(code))?;
        let update_target = Box::into_raw(Box::new(UpdateTarget {
            flag: update_flag,
            wake,
        }));
        // SAFETY: `ctx` is live; `update_target` stays valid until the
        // callback is unregistered in `drop`.
        unsafe {
            ffi::mpv_render_context_set_update_callback(
                ctx.as_ptr(),
                Some(on_update),
                update_target.cast(),
            );
        }
        Ok(Self {
            ctx,
            update_target,
            _mpv: mpv,
        })
    }

    /// Lets mpv process pending render state; call when the update flag was
    /// set, before rendering. Returns `mpv_render_update_flag` bits.
    pub fn update(&self) -> u64 {
        // SAFETY: `ctx` is live.
        unsafe { ffi::mpv_render_context_update(self.ctx.as_ptr()) }
    }

    /// Renders the current video frame into framebuffer `fbo` (0 for the
    /// default one) of `width` × `height` pixels, flipped vertically if
    /// `flip_y`.
    pub fn render(&self, fbo: i32, width: i32, height: i32, flip_y: bool) -> Result<()> {
        let mut target = ffi::mpv_opengl_fbo {
            fbo,
            w: width,
            h: height,
            internal_format: 0,
        };
        let mut flip = c_int::from(flip_y);
        let mut params = [
            ffi::mpv_render_param {
                kind: ffi::MPV_RENDER_PARAM_OPENGL_FBO,
                data: (&raw mut target).cast(),
            },
            ffi::mpv_render_param {
                kind: ffi::MPV_RENDER_PARAM_FLIP_Y,
                data: (&raw mut flip).cast(),
            },
            ffi::mpv_render_param {
                kind: ffi::MPV_RENDER_PARAM_INVALID,
                data: ptr::null_mut(),
            },
        ];
        // SAFETY: `ctx` is live; `params` is terminated and outlives the call.
        let code =
            unsafe { ffi::mpv_render_context_render(self.ctx.as_ptr(), params.as_mut_ptr()) };
        if code < 0 {
            Err(Error::Raw(code))
        } else {
            Ok(())
        }
    }

    /// Tells mpv the rendered frame was presented (for its frame timing).
    pub fn report_swap(&self) {
        // SAFETY: `ctx` is live.
        unsafe { ffi::mpv_render_context_report_swap(self.ctx.as_ptr()) };
    }
}

impl Drop for RenderContext {
    fn drop(&mut self) {
        // SAFETY: `ctx` is live. Clearing the update callback first means mpv
        // cannot call it once `update_target` is released: libmpv takes the
        // callback lock both here and around each call. The render context
        // is then freed before the core, which `_mpv` keeps alive until after.
        unsafe {
            ffi::mpv_render_context_set_update_callback(self.ctx.as_ptr(), None, ptr::null_mut());
            ffi::mpv_render_context_free(self.ctx.as_ptr());
            drop(Box::from_raw(self.update_target));
        }
    }
}
