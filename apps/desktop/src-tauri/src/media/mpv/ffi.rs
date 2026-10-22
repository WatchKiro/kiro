//! Raw declarations for the parts of libmpv's C API that Kiro uses.
//!
//! Hand-written from mpv's `client.h`, `render.h`, `render_gl.h` and
//! `stream_cb.h` (client
//! API 2.5, mpv 0.41), which carry this notice:
//!
//! > Copyright (C) 2017, 2018 the mpv developers
//! >
//! > Permission to use, copy, modify, and/or distribute this software for any
//! > purpose with or without fee is hereby granted, provided that the above
//! > copyright notice and this permission notice appear in all copies.
//! >
//! > THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
//! > WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
//! > MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
//! > ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
//! > WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
//! > ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
//! > OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
//!
//! Only what the wrapper in [`client`](super::client) and
//! [`render`](super::render) needs is declared. `build.rs` links `-lmpv`
//! (macOS, Linux); Windows imports `libmpv-2.dll` directly (`raw-dylib`).
//! C enums are `int`-sized on every platform mpv supports.

// The render API is unused on Windows, where mpv draws into its own window.
#![cfg_attr(target_os = "windows", allow(dead_code))]
#![allow(non_camel_case_types)]

use std::ffi::{c_char, c_int, c_ulong, c_void};

/// Opaque `mpv_handle`.
#[repr(C)]
pub struct mpv_handle {
    _private: [u8; 0],
}

/// Opaque `mpv_render_context`.
#[repr(C)]
pub struct mpv_render_context {
    _private: [u8; 0],
}

/// `mpv_error` (negative values are errors).
pub mod error {
    use std::ffi::c_int;

    pub const OPTION_NOT_FOUND: c_int = -5;
    pub const PROPERTY_NOT_FOUND: c_int = -8;
    pub const PROPERTY_UNAVAILABLE: c_int = -10;
    pub const LOADING_FAILED: c_int = -13;
    pub const AO_INIT_FAILED: c_int = -14;
    pub const VO_INIT_FAILED: c_int = -15;
    pub const NOTHING_TO_PLAY: c_int = -16;
    pub const UNKNOWN_FORMAT: c_int = -17;
    pub const UNSUPPORTED: c_int = -18;
    pub const NOT_IMPLEMENTED: c_int = -19;
    pub const GENERIC: c_int = -20;
}

/// `mpv_format`.
pub type mpv_format = c_int;
pub const MPV_FORMAT_NONE: mpv_format = 0;
pub const MPV_FORMAT_STRING: mpv_format = 1;
pub const MPV_FORMAT_FLAG: mpv_format = 3;
pub const MPV_FORMAT_INT64: mpv_format = 4;
pub const MPV_FORMAT_DOUBLE: mpv_format = 5;

/// `mpv_event_id`.
pub type mpv_event_id = c_int;
pub const MPV_EVENT_NONE: mpv_event_id = 0;
pub const MPV_EVENT_SHUTDOWN: mpv_event_id = 1;
pub const MPV_EVENT_LOG_MESSAGE: mpv_event_id = 2;
pub const MPV_EVENT_START_FILE: mpv_event_id = 6;
pub const MPV_EVENT_END_FILE: mpv_event_id = 7;
pub const MPV_EVENT_FILE_LOADED: mpv_event_id = 8;
pub const MPV_EVENT_PLAYBACK_RESTART: mpv_event_id = 21;
pub const MPV_EVENT_PROPERTY_CHANGE: mpv_event_id = 22;

#[repr(C)]
pub struct mpv_event {
    pub event_id: mpv_event_id,
    pub error: c_int,
    pub reply_userdata: u64,
    pub data: *mut c_void,
}

#[repr(C)]
pub struct mpv_event_property {
    pub name: *const c_char,
    pub format: mpv_format,
    pub data: *mut c_void,
}

#[repr(C)]
pub struct mpv_event_log_message {
    /// The module, e.g. `cplayer` or `ao/coreaudio`.
    pub prefix: *const c_char,
    pub level: *const c_char,
    pub text: *const c_char,
    /// `mpv_log_level`.
    pub log_level: c_int,
}

#[repr(C)]
pub struct mpv_event_end_file {
    /// `mpv_end_file_reason`.
    pub reason: c_int,
    pub error: c_int,
    pub playlist_entry_id: i64,
    pub playlist_insert_id: i64,
    pub playlist_insert_num_entries: c_int,
}

/// `mpv_render_param_type`.
pub type mpv_render_param_type = c_int;
pub const MPV_RENDER_PARAM_INVALID: mpv_render_param_type = 0;
pub const MPV_RENDER_PARAM_API_TYPE: mpv_render_param_type = 1;
pub const MPV_RENDER_PARAM_OPENGL_INIT_PARAMS: mpv_render_param_type = 2;
pub const MPV_RENDER_PARAM_OPENGL_FBO: mpv_render_param_type = 3;
pub const MPV_RENDER_PARAM_FLIP_Y: mpv_render_param_type = 4;
/// `Display*`: the host's X11 display, for hardware decoding.
pub const MPV_RENDER_PARAM_X11_DISPLAY: mpv_render_param_type = 8;
/// `struct wl_display*`: the host's Wayland display, for hardware decoding.
pub const MPV_RENDER_PARAM_WL_DISPLAY: mpv_render_param_type = 9;

/// `MPV_RENDER_API_TYPE_OPENGL`.
pub const MPV_RENDER_API_TYPE_OPENGL: &std::ffi::CStr = c"opengl";

#[repr(C)]
pub struct mpv_render_param {
    pub kind: mpv_render_param_type,
    pub data: *mut c_void,
}

pub type mpv_render_update_fn = Option<unsafe extern "C" fn(cb_ctx: *mut c_void)>;

/// Resolves an OpenGL function by name (`get_proc_address`).
pub type GetProcAddressFn =
    unsafe extern "C" fn(ctx: *mut c_void, name: *const c_char) -> *mut c_void;

#[repr(C)]
pub struct mpv_opengl_init_params {
    pub get_proc_address: Option<GetProcAddressFn>,
    pub get_proc_address_ctx: *mut c_void,
}

#[repr(C)]
pub struct mpv_opengl_fbo {
    pub fbo: c_int,
    pub w: c_int,
    pub h: c_int,
    /// 0 means "unknown" (mpv assumes an 8-bit format).
    pub internal_format: c_int,
}

// Windows imports from the DLL directly (no import library needed); macOS and
// Linux link `-lmpv` (build.rs).
// stream_cb.h: a protocol whose bytes the client supplies (seek-bar
// previews read streams in bounded pieces through it, `preview_reader.rs`).
// mpv calls these on its own threads; `read_fn` may block.

/// Reads up to `nbytes` into `buf`: the number read, 0 at the end, -1 on error.
pub type mpv_stream_cb_read_fn =
    Option<unsafe extern "C" fn(cookie: *mut c_void, buf: *mut c_char, nbytes: u64) -> i64>;
/// Moves to `offset`: the new offset, or a negative `mpv_error`.
pub type mpv_stream_cb_seek_fn =
    Option<unsafe extern "C" fn(cookie: *mut c_void, offset: i64) -> i64>;
/// The total size, or `MPV_ERROR_UNSUPPORTED`.
pub type mpv_stream_cb_size_fn = Option<unsafe extern "C" fn(cookie: *mut c_void) -> i64>;
pub type mpv_stream_cb_close_fn = Option<unsafe extern "C" fn(cookie: *mut c_void)>;
/// Asks a blocked `read_fn` to return soon (client API 1.106 and later).
pub type mpv_stream_cb_cancel_fn = Option<unsafe extern "C" fn(cookie: *mut c_void)>;

#[repr(C)]
pub struct mpv_stream_cb_info {
    pub cookie: *mut c_void,
    pub read_fn: mpv_stream_cb_read_fn,
    pub seek_fn: mpv_stream_cb_seek_fn,
    pub size_fn: mpv_stream_cb_size_fn,
    pub close_fn: mpv_stream_cb_close_fn,
    pub cancel_fn: mpv_stream_cb_cancel_fn,
}

/// Opens `uri` (`protocol://...`): fills `info` and returns 0, or a negative
/// `mpv_error`.
pub type mpv_stream_cb_open_ro_fn = Option<
    unsafe extern "C" fn(
        user_data: *mut c_void,
        uri: *mut c_char,
        info: *mut mpv_stream_cb_info,
    ) -> c_int,
>;

#[cfg_attr(windows, link(name = "libmpv-2", kind = "raw-dylib"))]
unsafe extern "C" {
    // client.h
    pub fn mpv_client_api_version() -> c_ulong;
    pub fn mpv_free(data: *mut c_void);
    pub fn mpv_create() -> *mut mpv_handle;
    pub fn mpv_initialize(ctx: *mut mpv_handle) -> c_int;
    pub fn mpv_terminate_destroy(ctx: *mut mpv_handle);
    pub fn mpv_set_option(
        ctx: *mut mpv_handle,
        name: *const c_char,
        format: mpv_format,
        data: *mut c_void,
    ) -> c_int;
    pub fn mpv_command(ctx: *mut mpv_handle, args: *mut *const c_char) -> c_int;
    pub fn mpv_set_property(
        ctx: *mut mpv_handle,
        name: *const c_char,
        format: mpv_format,
        data: *mut c_void,
    ) -> c_int;
    pub fn mpv_get_property(
        ctx: *mut mpv_handle,
        name: *const c_char,
        format: mpv_format,
        data: *mut c_void,
    ) -> c_int;
    pub fn mpv_observe_property(
        mpv: *mut mpv_handle,
        reply_userdata: u64,
        name: *const c_char,
        format: mpv_format,
    ) -> c_int;
    pub fn mpv_wait_event(ctx: *mut mpv_handle, timeout: f64) -> *mut mpv_event;
    pub fn mpv_request_log_messages(ctx: *mut mpv_handle, min_level: *const c_char) -> c_int;
    pub fn mpv_wakeup(ctx: *mut mpv_handle);

    // stream_cb.h
    pub fn mpv_stream_cb_add_ro(
        ctx: *mut mpv_handle,
        protocol: *const c_char,
        user_data: *mut c_void,
        open_fn: mpv_stream_cb_open_ro_fn,
    ) -> c_int;

    // render.h
    pub fn mpv_render_context_create(
        res: *mut *mut mpv_render_context,
        mpv: *mut mpv_handle,
        params: *mut mpv_render_param,
    ) -> c_int;
    pub fn mpv_render_context_set_update_callback(
        ctx: *mut mpv_render_context,
        callback: mpv_render_update_fn,
        callback_ctx: *mut c_void,
    );
    pub fn mpv_render_context_update(ctx: *mut mpv_render_context) -> u64;
    pub fn mpv_render_context_render(
        ctx: *mut mpv_render_context,
        params: *mut mpv_render_param,
    ) -> c_int;
    pub fn mpv_render_context_report_swap(ctx: *mut mpv_render_context);
    pub fn mpv_render_context_free(ctx: *mut mpv_render_context);
}
