//! A small safe wrapper over libmpv's client API ([`ffi`](super::ffi)):
//! creating and configuring a core, properties, commands and the event queue.
//!
//! Only the calls the player needs are wrapped. All of them are thread-safe
//! in libmpv except `mpv_wait_event`, which [`Mpv::wait_event`] serialises.

use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::fmt;
use std::ptr::{self, NonNull};
use std::sync::{Mutex, PoisonError};

use super::ffi;

/// The client API major version Kiro is written against. A different major
/// version changes the ABI; any minor version of it has what we use.
const CLIENT_API_MAJOR: std::ffi::c_ulong = 2;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    /// An `mpv_error` code (negative).
    Raw(c_int),
    /// `mpv_create` failed (out of memory).
    Create,
    /// A string passed to mpv contained a NUL byte.
    Nul,
    /// mpv returned text that is not UTF-8.
    InvalidUtf8,
    /// The loaded libmpv has a client API major version other than ours.
    VersionMismatch { loaded: std::ffi::c_ulong },
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Raw(code) => write!(f, "mpv error {code}"),
            Self::Create => f.write_str("mpv_create failed"),
            Self::Nul => f.write_str("string contains a NUL byte"),
            Self::InvalidUtf8 => f.write_str("mpv returned invalid UTF-8"),
            Self::VersionMismatch { loaded } => write!(
                f,
                "libmpv client API {}.{}, expected {CLIENT_API_MAJOR}.x",
                loaded >> 16,
                loaded & 0xffff
            ),
        }
    }
}

fn check(code: c_int) -> Result<()> {
    if code < 0 {
        Err(Error::Raw(code))
    } else {
        Ok(())
    }
}

fn cstring(text: &str) -> Result<CString> {
    CString::new(text).map_err(|_| Error::Nul)
}

/// A value that can be written to an option or property.
pub trait SetValue {
    /// Calls `f` with the value's `mpv_format` and a pointer to its C form.
    fn with_raw<T>(&self, f: impl FnOnce(ffi::mpv_format, *mut c_void) -> Result<T>) -> Result<T>;
}

impl SetValue for &str {
    fn with_raw<T>(&self, f: impl FnOnce(ffi::mpv_format, *mut c_void) -> Result<T>) -> Result<T> {
        let text = cstring(self)?;
        let mut ptr = text.as_ptr();
        f(ffi::MPV_FORMAT_STRING, (&raw mut ptr).cast())
    }
}

impl SetValue for bool {
    fn with_raw<T>(&self, f: impl FnOnce(ffi::mpv_format, *mut c_void) -> Result<T>) -> Result<T> {
        let mut flag = c_int::from(*self);
        f(ffi::MPV_FORMAT_FLAG, (&raw mut flag).cast())
    }
}

impl SetValue for i64 {
    fn with_raw<T>(&self, f: impl FnOnce(ffi::mpv_format, *mut c_void) -> Result<T>) -> Result<T> {
        let mut value = *self;
        f(ffi::MPV_FORMAT_INT64, (&raw mut value).cast())
    }
}

impl SetValue for f64 {
    fn with_raw<T>(&self, f: impl FnOnce(ffi::mpv_format, *mut c_void) -> Result<T>) -> Result<T> {
        let mut value = *self;
        f(ffi::MPV_FORMAT_DOUBLE, (&raw mut value).cast())
    }
}

/// A value that can be read from a property.
pub trait GetValue: Sized {
    /// Calls `get` with the type's `mpv_format` and a buffer for mpv to fill.
    fn get(get: impl FnOnce(ffi::mpv_format, *mut c_void) -> Result<()>) -> Result<Self>;
}

impl GetValue for String {
    fn get(get: impl FnOnce(ffi::mpv_format, *mut c_void) -> Result<()>) -> Result<Self> {
        let mut ptr: *mut c_char = ptr::null_mut();
        get(ffi::MPV_FORMAT_STRING, (&raw mut ptr).cast())?;
        // SAFETY: on success mpv stored a NUL-terminated string it allocated.
        let text = unsafe { CStr::from_ptr(ptr) }.to_str().map(str::to_owned);
        // SAFETY: the string is ours to free, and is not used after this.
        unsafe { ffi::mpv_free(ptr.cast()) };
        text.map_err(|_| Error::InvalidUtf8)
    }
}

impl GetValue for bool {
    fn get(get: impl FnOnce(ffi::mpv_format, *mut c_void) -> Result<()>) -> Result<Self> {
        let mut flag: c_int = 0;
        get(ffi::MPV_FORMAT_FLAG, (&raw mut flag).cast())?;
        Ok(flag != 0)
    }
}

impl GetValue for i64 {
    fn get(get: impl FnOnce(ffi::mpv_format, *mut c_void) -> Result<()>) -> Result<Self> {
        let mut value: i64 = 0;
        get(ffi::MPV_FORMAT_INT64, (&raw mut value).cast())?;
        Ok(value)
    }
}

impl GetValue for f64 {
    fn get(get: impl FnOnce(ffi::mpv_format, *mut c_void) -> Result<()>) -> Result<Self> {
        let mut value: f64 = 0.0;
        get(ffi::MPV_FORMAT_DOUBLE, (&raw mut value).cast())?;
        Ok(value)
    }
}

/// Formats a property can be observed in.
#[derive(Debug, Clone, Copy)]
pub enum Format {
    String,
    Flag,
    Int64,
    Double,
}

impl Format {
    fn raw(self) -> ffi::mpv_format {
        match self {
            Self::String => ffi::MPV_FORMAT_STRING,
            Self::Flag => ffi::MPV_FORMAT_FLAG,
            Self::Int64 => ffi::MPV_FORMAT_INT64,
            Self::Double => ffi::MPV_FORMAT_DOUBLE,
        }
    }
}

/// The new value of an observed property.
#[derive(Debug, Clone, PartialEq)]
pub enum PropertyData {
    Str(String),
    Flag(bool),
    Int64(i64),
    Double(f64),
}

impl PropertyData {
    /// # Safety
    ///
    /// `data` must point to a value of `format`, as in `mpv_event_property`.
    unsafe fn from_raw(format: ffi::mpv_format, data: *mut c_void) -> Option<Result<Self>> {
        // SAFETY (all arms): the caller guarantees `data` matches `format`.
        Some(Ok(match format {
            ffi::MPV_FORMAT_STRING => {
                let text = unsafe { CStr::from_ptr(*data.cast::<*const c_char>()) };
                match text.to_str() {
                    Ok(text) => Self::Str(text.to_owned()),
                    Err(_) => return Some(Err(Error::InvalidUtf8)),
                }
            }
            ffi::MPV_FORMAT_FLAG => Self::Flag(unsafe { *data.cast::<c_int>() } != 0),
            ffi::MPV_FORMAT_INT64 => Self::Int64(unsafe { *data.cast::<i64>() }),
            ffi::MPV_FORMAT_DOUBLE => Self::Double(unsafe { *data.cast::<f64>() }),
            _ => return None,
        }))
    }
}

/// An event from [`Mpv::wait_event`]. Events the player does not use are
/// [`Event::Other`].
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Shutdown,
    StartFile,
    /// A file stopped without an error (end, stop, replace).
    EndFile,
    FileLoaded,
    PlaybackRestart,
    /// An observed property changed; `id` is the one passed to
    /// [`Mpv::observe_property`].
    PropertyChange {
        id: u64,
        data: PropertyData,
    },
    Other,
}

/// Sets options before the core is initialised; see [`Mpv::with_initializer`].
pub struct Initializer {
    ctx: NonNull<ffi::mpv_handle>,
}

impl Initializer {
    pub fn set_option(&self, name: &str, value: impl SetValue) -> Result<()> {
        let c_name = cstring(name)?;
        let result = value.with_raw(|format, data| {
            // SAFETY: the handle is live and not yet initialised; `data`
            // points to a value of `format` for the duration of the call.
            check(unsafe { ffi::mpv_set_option(self.ctx.as_ptr(), c_name.as_ptr(), format, data) })
        });
        if let Err(error) = &result
            && super::debug_log_enabled()
        {
            eprintln!("[kiro-player] mpv option {name}: {error:?}");
        }
        result
    }
}

/// An initialised mpv core and its client handle. Destroyed (and playback
/// stopped) on drop.
pub struct Mpv {
    ctx: NonNull<ffi::mpv_handle>,
    /// `mpv_wait_event` must not run on two threads at once.
    wait: Mutex<()>,
}

// SAFETY: libmpv's client API may be called from any thread, concurrently,
// except `mpv_wait_event`, which takes `wait`.
unsafe impl Send for Mpv {}
unsafe impl Sync for Mpv {}

impl Mpv {
    /// Creates a core, lets `init` set options on it, and initialises it.
    /// Fails with [`Error::VersionMismatch`] if the loaded libmpv has an
    /// incompatible client API.
    pub fn with_initializer(init: impl FnOnce(&Initializer) -> Result<()>) -> Result<Self> {
        // SAFETY: no preconditions.
        let loaded = unsafe { ffi::mpv_client_api_version() };
        if loaded >> 16 != CLIENT_API_MAJOR {
            return Err(Error::VersionMismatch { loaded });
        }
        // SAFETY: no preconditions; null on failure.
        let ctx = NonNull::new(unsafe { ffi::mpv_create() }).ok_or(Error::Create)?;
        // From here on, dropping `mpv` destroys the handle.
        let mpv = Self {
            ctx,
            wait: Mutex::new(()),
        };
        init(&Initializer { ctx })?;
        // SAFETY: the handle is live and was not initialised yet.
        check(unsafe { ffi::mpv_initialize(ctx.as_ptr()) }).inspect_err(|error| {
            if super::debug_log_enabled() {
                eprintln!("[kiro-player] mpv_initialize: {error:?}");
            }
        })?;
        Ok(mpv)
    }

    pub fn set_property(&self, name: &str, value: impl SetValue) -> Result<()> {
        let name = cstring(name)?;
        value.with_raw(|format, data| {
            // SAFETY: the handle is live; `data` points to a value of `format`
            // for the duration of the call (mpv copies it).
            check(unsafe { ffi::mpv_set_property(self.ctx.as_ptr(), name.as_ptr(), format, data) })
        })
    }

    pub fn get_property<T: GetValue>(&self, name: &str) -> Result<T> {
        let name = cstring(name)?;
        T::get(|format, data| {
            // SAFETY: the handle is live; `data` is a buffer for `format`.
            check(unsafe { ffi::mpv_get_property(self.ctx.as_ptr(), name.as_ptr(), format, data) })
        })
    }

    /// Runs `name` with `args`, synchronously. Arguments are passed as an
    /// array, never parsed, so they cannot inject further commands.
    pub fn command(&self, name: &str, args: &[&str]) -> Result<()> {
        let strings = std::iter::once(name)
            .chain(args.iter().copied())
            .map(cstring)
            .collect::<Result<Vec<_>>>()?;
        let mut argv: Vec<*const c_char> = strings.iter().map(|arg| arg.as_ptr()).collect();
        argv.push(ptr::null());
        // SAFETY: the handle is live; `argv` is a NULL-terminated array of
        // strings that outlive the call.
        check(unsafe { ffi::mpv_command(self.ctx.as_ptr(), argv.as_mut_ptr()) })
    }

    /// Reports changes of `name` as [`Event::PropertyChange`] with `id`.
    pub fn observe_property(&self, name: &str, format: Format, id: u64) -> Result<()> {
        let name = cstring(name)?;
        // SAFETY: the handle is live; mpv copies the name.
        check(unsafe {
            ffi::mpv_observe_property(self.ctx.as_ptr(), id, name.as_ptr(), format.raw())
        })
    }

    /// Waits up to `timeout` seconds (negative: forever) for the next event.
    ///
    /// `None` on a timeout, a [`wakeup`](Self::wakeup), or a property that
    /// became unavailable. A file that ended with an error, or any event that
    /// carries one, is `Err`.
    pub fn wait_event(&self, timeout: f64) -> Option<Result<Event>> {
        let _wait = self.wait.lock().unwrap_or_else(PoisonError::into_inner);
        // SAFETY: the handle is live and no other thread is waiting (`_wait`).
        // The event and its data stay valid until the next `mpv_wait_event`,
        // which `_wait` also holds off until we are done reading.
        let event = unsafe { &*ffi::mpv_wait_event(self.ctx.as_ptr(), timeout) };
        if event.event_id == ffi::MPV_EVENT_NONE {
            return None;
        }
        if event.error < 0 {
            return Some(Err(Error::Raw(event.error)));
        }
        Some(Ok(match event.event_id {
            ffi::MPV_EVENT_SHUTDOWN => Event::Shutdown,
            ffi::MPV_EVENT_START_FILE => Event::StartFile,
            ffi::MPV_EVENT_END_FILE => {
                // SAFETY: END_FILE events carry an `mpv_event_end_file`.
                let end = unsafe { &*event.data.cast::<ffi::mpv_event_end_file>() };
                if end.error < 0 {
                    return Some(Err(Error::Raw(end.error)));
                }
                Event::EndFile
            }
            ffi::MPV_EVENT_FILE_LOADED => Event::FileLoaded,
            ffi::MPV_EVENT_PLAYBACK_RESTART => Event::PlaybackRestart,
            ffi::MPV_EVENT_PROPERTY_CHANGE => {
                // SAFETY: PROPERTY_CHANGE events carry an `mpv_event_property`,
                // whose `data` matches its `format`.
                let property = unsafe { &*event.data.cast::<ffi::mpv_event_property>() };
                if property.format == ffi::MPV_FORMAT_NONE {
                    return None;
                }
                let data = unsafe { PropertyData::from_raw(property.format, property.data) }?;
                return Some(data.map(|data| Event::PropertyChange {
                    id: event.reply_userdata,
                    data,
                }));
            }
            _ => Event::Other,
        }))
    }

    /// Makes a blocked [`wait_event`](Self::wait_event) return. Thread-safe.
    pub fn wakeup(&self) {
        // SAFETY: the handle is live; `mpv_wakeup` may be called from any thread.
        unsafe { ffi::mpv_wakeup(self.ctx.as_ptr()) };
    }

    #[cfg(not(target_os = "windows"))] // For the render API only.
    pub(super) fn handle(&self) -> *mut ffi::mpv_handle {
        self.ctx.as_ptr()
    }
}

impl Drop for Mpv {
    fn drop(&mut self) {
        // SAFETY: the handle is live and no longer used after this. Render
        // contexts hold an `Arc<Mpv>`, so none outlives the core.
        unsafe { ffi::mpv_terminate_destroy(self.ctx.as_ptr()) };
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::*;

    fn headless() -> Mpv {
        Mpv::with_initializer(|init| {
            init.set_option("vo", "null")?;
            init.set_option("ao", "null")?;
            init.set_option("idle", "yes")?;
            init.set_option("volume-max", 200_i64)?;
            Ok(())
        })
        .expect("mpv should initialise")
    }

    /// Waits for the first event `pick` accepts, failing after 15 s.
    fn wait_for<T>(mpv: &Mpv, mut pick: impl FnMut(Option<Result<Event>>) -> Option<T>) -> T {
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            if let Some(found) = pick(mpv.wait_event(0.5)) {
                return found;
            }
        }
        panic!("timed out waiting for an event");
    }

    #[test]
    fn options_report_unknown_names() {
        let result = Mpv::with_initializer(|init| init.set_option("no-such-option", "no"));
        assert!(matches!(
            result,
            Err(Error::Raw(ffi::error::OPTION_NOT_FOUND))
        ));
    }

    #[test]
    fn properties_round_trip_in_every_format() {
        let mpv = headless();
        mpv.set_property("pause", true).unwrap();
        assert!(mpv.get_property::<bool>("pause").unwrap());
        mpv.set_property("volume", 150.5).unwrap();
        assert_eq!(mpv.get_property::<f64>("volume").unwrap(), 150.5);
        mpv.set_property("sub-margin-y", 40_i64).unwrap();
        assert_eq!(mpv.get_property::<i64>("sub-margin-y").unwrap(), 40);
        mpv.set_property("sub-color", "#ffcc00").unwrap();
        assert_eq!(
            mpv.get_property::<String>("sub-color").unwrap(),
            "#FFFFCC00"
        );
        assert_eq!(mpv.get_property::<String>("track-list").unwrap(), "[]");
        assert!(matches!(
            mpv.get_property::<f64>("time-pos"),
            Err(Error::Raw(ffi::error::PROPERTY_UNAVAILABLE))
        ));
        assert_eq!(mpv.set_property("pause", "a\0b"), Err(Error::Nul));
    }

    #[test]
    fn commands_fail_with_mpv_error_codes() {
        let mpv = headless();
        assert!(matches!(
            mpv.command("no-such-command", &[]),
            Err(Error::Raw(_))
        ));
        assert_eq!(mpv.command("seek", &["1\0"]), Err(Error::Nul));
    }

    #[test]
    fn failed_loads_end_with_an_error_event() {
        let mpv = headless();
        mpv.command("loadfile", &["/nonexistent/kiro-test.mkv", "replace"])
            .unwrap();
        let error = wait_for(&mpv, |event| match event {
            Some(Err(error)) => Some(error),
            _ => None,
        });
        assert_eq!(error, Error::Raw(ffi::error::LOADING_FAILED));
    }

    #[test]
    fn observed_properties_arrive_with_their_id() {
        let mpv = headless();
        mpv.observe_property("pause", Format::Flag, 7).unwrap();
        mpv.set_property("pause", true).unwrap();
        wait_for(&mpv, |event| match event {
            Some(Ok(Event::PropertyChange {
                id: 7,
                data: PropertyData::Flag(true),
            })) => Some(()),
            _ => None,
        });
    }

    #[test]
    fn wakeup_interrupts_a_blocking_wait() {
        let mpv = std::sync::Arc::new(headless());
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let waiter = {
            let mpv = mpv.clone();
            std::thread::spawn(move || {
                // Real events return too; only a wakeup returns `None`.
                while mpv.wait_event(-1.0).is_some() {}
                let _ = done_tx.send(());
            })
        };
        std::thread::sleep(Duration::from_millis(200));
        mpv.wakeup();
        done_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the wait should return after a wakeup");
        waiter.join().unwrap();
    }
}
