//! Seek-bar previews: a frame of the video at the position under the pointer.
//!
//! A second, hidden mpv core opens the same stream as the player, paused and
//! without audio, subtitles or a video output, seeks to the keyframe before
//! the position asked for and saves a small JPEG of it. Measured against
//! realistic streams (docs/playback.md, "Seek-bar previews"), each preview
//! costs little CPU (software decoding, so the GPU decoder stays with the
//! player) and 0.25 to 1 MB of the stream (read in bounded ranges,
//! `preview_reader.rs`), so previews are only made on
//! demand, one at a time, and [`MpvPlayer::preview`](super::MpvPlayer::preview)
//! refuses while the player is short of buffered video.
//!
//! The core lives on its own thread, created on the first request (or on
//! [`Previewer::warm`], when the pointer reaches the seek bar, so the first
//! frame comes sooner) and freed after [`IDLE_RELEASE`] without one, so its
//! memory (150 to 250 MB for a 4K stream) is only held while someone is
//! scrubbing. A request that arrives while another waits replaces it
//! ([`Outcome::Superseded`]): only the position under the pointer matters.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use super::client::{self, Event, Mpv};
use super::debug_log_enabled;
use super::ffi::error as mpv_error;
use super::preview_reader::{self, OpeningCache, ReaderContext};

/// Frees the preview core after this long without a request.
const IDLE_RELEASE: Duration = Duration::from_secs(60);
/// Opening the stream: connecting, reading its index, decoding a frame.
const OPEN_TIMEOUT: Duration = Duration::from_secs(20);
/// One preview: a seek and a decoded keyframe.
const SEEK_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a request waits for its answer, including the one in progress.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Previews in a row that may fail before the stream is given up on.
const MAX_FAILURES: u32 = 2;
/// How often waiting checks whether the previewer is being shut down.
const POLL: Duration = Duration::from_millis(250);
/// Width of a preview in pixels (the height follows the video).
pub const PREVIEW_WIDTH: u32 = 320;

/// A preview image.
#[derive(Debug, Clone, PartialEq)]
pub struct Frame {
    /// Where the frame is, in seconds: the keyframe at or before the
    /// position asked for.
    pub position: f64,
    pub jpeg: Vec<u8>,
}

/// The answer to a [`Previewer::request`].
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Frame(Frame),
    /// A newer request took its place before it started.
    Superseded,
    /// [`Previewer::warm`]: the stream was open already (or is being opened
    /// by a newer warm), so there is nothing to show for it.
    Warm,
    /// Nothing to preview: no stream, one that can't be opened, or a seek
    /// that failed.
    Unavailable,
}

struct Pending {
    position: f64,
    reply: mpsc::Sender<Outcome>,
}

#[derive(Default)]
struct Queue {
    /// The stream the player has loaded, if previews can be made of it.
    source: Option<String>,
    pending: Option<Pending>,
    /// Open the stream now, ahead of a request, at this position.
    warm: Option<Pending>,
}

impl Queue {
    /// Puts `pending` next in line, answering the request it replaces.
    fn push(&mut self, pending: Pending) {
        if let Some(older) = self.pending.replace(pending) {
            let _ = older.reply.send(Outcome::Superseded);
        }
    }

    /// The next thing to do, a request first.
    fn take(&mut self) -> Option<Job> {
        if let Some(pending) = self.pending.take() {
            return Some(Job::Preview(pending));
        }
        self.warm.take().map(Job::Warm)
    }
}

/// What the worker thread does next.
enum Job {
    Preview(Pending),
    Warm(Pending),
}

struct Shared {
    queue: Mutex<Queue>,
    wake: Condvar,
    stop: AtomicBool,
}

impl Shared {
    fn queue(&self) -> MutexGuard<'_, Queue> {
        self.queue.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Makes previews for one player. Dropping it stops its thread and frees
/// the preview core.
pub struct Previewer {
    shared: Arc<Shared>,
    thread: Option<JoinHandle<()>>,
}

impl Previewer {
    pub fn new() -> std::io::Result<Self> {
        let shared = Arc::new(Shared {
            queue: Mutex::default(),
            wake: Condvar::new(),
            stop: AtomicBool::new(false),
        });
        let worker = shared.clone();
        let thread = std::thread::Builder::new()
            .name("kiro-mpv-preview".into())
            .spawn(move || Worker::new(worker).run())?;
        Ok(Self {
            shared,
            thread: Some(thread),
        })
    }

    /// The stream the player loaded (`None`: nothing to preview, e.g. a test
    /// pattern or nothing loaded).
    pub fn set_source(&self, source: Option<String>) {
        self.shared.queue().source = source;
        self.shared.wake.notify_one();
    }

    /// Opens the stream in the preview core now, if it isn't open, at
    /// `position`, so the first preview asked for doesn't wait for that, and
    /// returns the frame there (the opening reads it anyway). Blocks while
    /// the stream opens; [`Outcome::Warm`] when it was open already.
    pub fn warm(&self, position: f64) -> Outcome {
        let (reply, answer) = mpsc::channel();
        {
            let mut queue = self.shared.queue();
            if let Some(older) = queue.warm.replace(Pending { position, reply }) {
                let _ = older.reply.send(Outcome::Warm);
            }
        }
        self.shared.wake.notify_one();
        answer
            .recv_timeout(REQUEST_TIMEOUT)
            .unwrap_or(Outcome::Warm)
    }

    /// A preview at `position` seconds. Blocks until it is made, replaced by
    /// a newer request, or found unavailable.
    pub fn request(&self, position: f64) -> Outcome {
        let (reply, answer) = mpsc::channel();
        self.shared.queue().push(Pending { position, reply });
        self.shared.wake.notify_one();
        answer
            .recv_timeout(REQUEST_TIMEOUT)
            .unwrap_or(Outcome::Unavailable)
    }
}

impl Drop for Previewer {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::Release);
        self.shared.wake.notify_one();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// The preview core and the stream it has open.
struct Core {
    /// Declared first, so it is freed before the reader context it uses.
    mpv: Mpv,
    source: String,
    /// The bounded reader's client and byte count (`preview_reader.rs`), or
    /// `None` when mpv reads the stream itself.
    reader: Option<Arc<ReaderContext>>,
}

struct Worker {
    shared: Arc<Shared>,
    core: Option<Core>,
    /// A stream that could not be opened, or kept failing: not tried again
    /// until it changes.
    failed: Option<String>,
    /// Previews in a row that failed for the open stream.
    failures: u32,
    /// Where frames are written by mpv and read back.
    dir: Option<PathBuf>,
    /// The stream's opening bytes, kept across cores (`preview_reader.rs`).
    opening: Arc<Mutex<OpeningCache>>,
}

impl Worker {
    fn new(shared: Arc<Shared>) -> Self {
        Self {
            shared,
            core: None,
            failed: None,
            failures: 0,
            dir: None,
            opening: Arc::default(),
        }
    }

    fn run(mut self) {
        loop {
            let (job, source) = {
                let mut queue = self.shared.queue();
                let idle_since = Instant::now();
                while queue.pending.is_none()
                    && queue.warm.is_none()
                    && !self.shared.stop.load(Ordering::Acquire)
                {
                    let waited = idle_since.elapsed();
                    if waited >= IDLE_RELEASE {
                        if let Some(core) = self.core.take() {
                            if debug_log_enabled() {
                                eprintln!("[kiro-preview] idle: preview core released");
                            }
                            // Freed outside the lock.
                            drop(queue);
                            drop(core);
                            queue = self.shared.queue();
                        }
                        let (next, _) = self
                            .shared
                            .wake
                            .wait_timeout(queue, IDLE_RELEASE)
                            .unwrap_or_else(PoisonError::into_inner);
                        queue = next;
                        continue;
                    }
                    let (next, _) = self
                        .shared
                        .wake
                        .wait_timeout(queue, IDLE_RELEASE - waited)
                        .unwrap_or_else(PoisonError::into_inner);
                    queue = next;
                }
                if self.shared.stop.load(Ordering::Acquire) {
                    break;
                }
                let Some(job) = queue.take() else {
                    continue;
                };
                (job, queue.source.clone())
            };
            match job {
                Job::Preview(pending) => {
                    let outcome = match source {
                        Some(source) => self.preview(&source, pending.position),
                        None => Outcome::Unavailable,
                    };
                    let _ = pending.reply.send(outcome);
                }
                Job::Warm(pending) => {
                    let outcome = match source {
                        Some(source) => self.warm(&source, pending.position),
                        None => Outcome::Unavailable,
                    };
                    let _ = pending.reply.send(outcome);
                }
            }
        }
        // Answer anything still waiting, then free the core.
        let mut queue = self.shared.queue();
        if let Some(pending) = queue.pending.take() {
            let _ = pending.reply.send(Outcome::Unavailable);
        }
        if let Some(pending) = queue.warm.take() {
            let _ = pending.reply.send(Outcome::Warm);
        }
        drop(queue);
        self.core = None;
        if let Some(dir) = self.dir.take() {
            let _ = fs::remove_dir_all(dir);
        }
    }

    /// Opens `source` at `position` if it isn't open, and previews there;
    /// nothing to show if it was open already.
    fn warm(&mut self, source: &str, position: f64) -> Outcome {
        if self.core.as_ref().is_some_and(|core| core.source == source) {
            return Outcome::Warm;
        }
        if !self.ensure_open(source, Some(position)) {
            return Outcome::Unavailable;
        }
        self.preview(source, position)
    }

    /// Has `source` open in the core (from `start`, if given), unless it has
    /// failed before. Returns whether it is.
    fn ensure_open(&mut self, source: &str, start: Option<f64>) -> bool {
        if self.failed.as_deref() == Some(source) {
            return false;
        }
        if self.core.as_ref().is_some_and(|core| core.source == source) {
            return true;
        }
        let started = Instant::now();
        match self.open(source, start) {
            Ok(core) => {
                self.failed = None;
                self.failures = 0;
                if debug_log_enabled() {
                    eprintln!("[kiro-preview] opened in {:?}", started.elapsed());
                }
                self.core = Some(core);
                true
            }
            Err(error) => {
                eprintln!("[kiro-preview] could not open the stream: {error}");
                self.core = None;
                self.failed = Some(source.to_owned());
                false
            }
        }
    }

    fn preview(&mut self, source: &str, position: f64) -> Outcome {
        if !self.ensure_open(source, None) {
            return Outcome::Unavailable;
        }
        let Some(dir) = self.frames_dir() else {
            return Outcome::Unavailable;
        };
        let Some(core) = self.core.as_ref() else {
            return Outcome::Unavailable;
        };
        let asked = Instant::now();
        let read_before = core.reader.as_ref().map(|reader| reader.bytes_read());
        match capture(
            &core.mpv,
            position,
            &dir.join("frame.jpg"),
            &self.shared.stop,
            core.reader.as_deref(),
        ) {
            Ok((frame, needed)) => {
                self.failures = 0;
                if let (Some(reader), Some(needed)) = (&core.reader, needed) {
                    reader.learn(needed);
                }
                if debug_log_enabled() {
                    let read = match (&core.reader, read_before, needed) {
                        (Some(reader), Some(before), Some(needed)) => format!(
                            "{} KB read ({} KB taken for the frame, next first read {} KB)",
                            (reader.bytes_read() - before) / 1024,
                            needed / 1024,
                            reader.first_read() / 1024
                        ),
                        _ => "read by mpv".into(),
                    };
                    eprintln!(
                        "[kiro-preview] frame at {:.1}s (asked {position:.1}s) in {:?}, {} byte JPEG, {read}",
                        frame.position,
                        asked.elapsed(),
                        frame.jpeg.len()
                    );
                }
                Outcome::Frame(frame)
            }
            Err(error) => {
                eprintln!("[kiro-preview] no frame at {position:.1}s: {error}");
                // An event may still be on its way; start afresh next time,
                // but not over and over.
                self.core = None;
                self.failures += 1;
                if self.failures >= MAX_FAILURES {
                    self.failed = Some(source.to_owned());
                }
                Outcome::Unavailable
            }
        }
    }

    /// Opens `source` (from `start` seconds, if given: its first keyframe is
    /// then one wanted) through the bounded reader, or, if the host doesn't
    /// serve ranges, with mpv's own reading.
    fn open(&self, source: &str, start: Option<f64>) -> Result<Core, Failure> {
        // Debug builds: `KIRO_PREVIEW_READER=mpv` skips the bounded reader,
        // to compare what each downloads.
        let bounded = !(cfg!(debug_assertions)
            && std::env::var("KIRO_PREVIEW_READER").as_deref() == Ok("mpv"));
        if bounded {
            match self.open_with(source, true, start) {
                Ok(core) => return Ok(core),
                Err(error @ (Failure::Stopped | Failure::NoRanges)) => return Err(error),
                Err(error) => {
                    eprintln!(
                        "[kiro-preview] bounded reads failed ({error}): mpv reads the stream"
                    );
                }
            }
        }
        self.open_with(source, false, start)
    }

    fn open_with(&self, source: &str, bounded: bool, start: Option<f64>) -> Result<Core, Failure> {
        let mpv = create_core()?;
        if let Some(start) = start {
            mpv.set_property("start", format!("{start:.3}").as_str())?;
        }
        let reader = if bounded {
            let context = ReaderContext::new(self.opening.clone()).map_err(|_| Failure::Reader)?;
            preview_reader::register(&mpv, &context)?;
            Some(context)
        } else {
            None
        };
        let target = if bounded {
            preview_reader::wrap(source)
        } else {
            source.to_owned()
        };
        mpv.command("loadfile", &[&target, "replace"])?;
        let opened = wait_for(&mpv, OPEN_TIMEOUT, &self.shared.stop, |event| {
            matches!(event, Event::PlaybackRestart)
        });
        if opened.is_err()
            && reader
                .as_ref()
                .is_some_and(|reader| reader.ranges_refused())
        {
            return Err(Failure::NoRanges);
        }
        opened?;
        if let Some(reader) = &reader {
            reader.opened();
            if debug_log_enabled() {
                eprintln!(
                    "[kiro-preview] opening read {} KB ({} KB kept for next time)",
                    reader.bytes_read() / 1024,
                    self.opening
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .bytes()
                        / 1024
                );
            }
        }
        Ok(Core {
            mpv,
            source: source.to_owned(),
            reader,
        })
    }

    /// A folder for frames, private to this previewer (and user, on Unix).
    fn frames_dir(&mut self) -> Option<PathBuf> {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        if self.dir.is_none() {
            let id = NEXT.fetch_add(1, Ordering::Relaxed);
            let dir =
                std::env::temp_dir().join(format!("kiro-previews-{}-{id}", std::process::id()));
            if let Err(error) = create_private_dir(&dir) {
                eprintln!("[kiro-preview] no folder for frames: {error}");
                return None;
            }
            self.dir = Some(dir);
        }
        self.dir.clone()
    }
}

fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Why a preview could not be made, for the log.
#[derive(Debug)]
enum Failure {
    Mpv(client::Error),
    Timeout,
    Stopped,
    Ended,
    Io(std::io::Error),
    /// The bounded reader's HTTP client could not be created.
    Reader,
    /// The host doesn't serve ranges, so previews would read the stream
    /// from the start.
    NoRanges,
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Mpv(error) => write!(f, "{error}"),
            Self::Timeout => f.write_str("timed out"),
            Self::Stopped => f.write_str("stopped"),
            Self::Ended => f.write_str("the stream ended"),
            Self::Io(error) => write!(f, "{error}"),
            Self::Reader => f.write_str("no HTTP client"),
            Self::NoRanges => f.write_str("the host doesn't serve ranges"),
        }
    }
}

impl From<client::Error> for Failure {
    fn from(error: client::Error) -> Self {
        Self::Mpv(error)
    }
}

/// The preview core: no output, audio or subtitles, and only as much of the
/// stream as one keyframe needs (the options measured in docs/playback.md).
fn create_core() -> client::Result<Mpv> {
    Mpv::with_initializer(|init| {
        init.set_option("config", "no")?;
        for name in ["load-scripts", "osc", "ytdl"] {
            match init.set_option(name, "no") {
                Ok(()) | Err(client::Error::Raw(mpv_error::OPTION_NOT_FOUND)) => {}
                Err(error) => return Err(error),
            }
        }
        init.set_option("terminal", "no")?;
        init.set_option("idle", "yes")?;
        init.set_option("pause", true)?;
        // Seeking near the end must not unload the stream.
        init.set_option("keep-open", "yes")?;
        init.set_option("vo", "null")?;
        init.set_option("aid", "no")?;
        init.set_option("sid", "no")?;
        // Software decoding, made cheap: one keyframe at a time doesn't need
        // the GPU decoder, which stays with the player.
        init.set_option("hwdec", "no")?;
        init.set_option("vd-lavc-threads", 2_i64)?;
        init.set_option("vd-lavc-skiploopfilter", "all")?;
        init.set_option("vd-lavc-fast", true)?;
        // The keyframe before each position, and as little reading ahead as
        // mpv allows: the demuxer stops once it holds this much, which one
        // keyframe packet exceeds, so a preview reads about one keyframe
        // (measured in docs/playback.md) rather than filling a queue.
        init.set_option("hr-seek", "no")?;
        init.set_option("cache", "no")?;
        init.set_option("demuxer-readahead-secs", 0.0_f64)?;
        init.set_option("demuxer-max-bytes", "64KiB")?;
        init.set_option("demuxer-max-back-bytes", 0_i64)?;
        let scale = format!("scale={PREVIEW_WIDTH}:-2");
        init.set_option("vf", scale.as_str())?;
        init.set_option("screenshot-format", "jpg")?;
        init.set_option("screenshot-jpeg-quality", 75_i64)?;
        Ok(())
    })
}

/// Seeks `mpv` to the keyframe before `position` and saves it to `file`.
/// With a bounded `reader`, also returns what mpv took from it before the
/// frame was there, for sizing the next seek's first read.
fn capture(
    mpv: &Mpv,
    position: f64,
    file: &Path,
    stop: &AtomicBool,
    reader: Option<&ReaderContext>,
) -> Result<(Frame, Option<u64>), Failure> {
    let before = reader.map(|reader| reader.bytes_taken());
    let target = format!("{position:.3}");
    mpv.command("seek", &[&target, "absolute+keyframes"])?;
    wait_for(mpv, SEEK_TIMEOUT, stop, |event| {
        matches!(event, Event::PlaybackRestart)
    })?;
    let needed = reader
        .zip(before)
        .map(|(reader, before)| reader.bytes_taken() - before);
    let at = mpv.get_property::<f64>("time-pos").unwrap_or(position);
    let path = file.to_string_lossy();
    mpv.command("screenshot-to-file", &[&path, "video"])?;
    let jpeg = fs::read(file).map_err(Failure::Io)?;
    let _ = fs::remove_file(file);
    Ok((
        Frame {
            position: at.max(0.0),
            jpeg,
        },
        needed,
    ))
}

/// Waits for an event `done` accepts, failing on an error, the end of the
/// stream, `timeout` or `stop`.
fn wait_for(
    mpv: &Mpv,
    timeout: Duration,
    stop: &AtomicBool,
    done: impl Fn(&Event) -> bool,
) -> Result<(), Failure> {
    let deadline = Instant::now() + timeout;
    loop {
        if stop.load(Ordering::Acquire) {
            return Err(Failure::Stopped);
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(Failure::Timeout);
        }
        match mpv.wait_event(left.min(POLL).as_secs_f64()) {
            None => {}
            Some(Err(error)) => return Err(Failure::Mpv(error)),
            Some(Ok(Event::EndFile | Event::Shutdown)) => return Err(Failure::Ended),
            Some(Ok(event)) if done(&event) => return Ok(()),
            Some(Ok(_)) => {}
        }
    }
}

/// Whether making a preview now could hold up playback. Previews download
/// part of the stream, so they wait while the player is buffering, or has
/// less of a network stream buffered than `demand` asks (or less than what's
/// left of it, near the end). A link with headroom to spare, bringing video
/// in faster than it plays by `demand.headroom` or more, needs only
/// [`HEADROOM_MIN_BUFFER_SECONDS`]: the player won't be short of it.
pub fn could_stall_playback(buffer: &BufferState, demand: Demand) -> bool {
    if buffer.buffering {
        return true;
    }
    if !buffer.via_network {
        return false;
    }
    let left = match (buffer.position, buffer.duration) {
        (Some(position), Some(duration)) => (duration - position - 1.0).max(0.0),
        _ => f64::INFINITY,
    };
    let cached = buffer.cached_seconds.unwrap_or(0.0);
    if cached >= demand.min_buffer.min(left) {
        return false;
    }
    let fast = match (buffer.input_rate, buffer.bitrate) {
        (Some(rate), Some(bitrate)) if bitrate > 0.0 => rate >= demand.headroom * bitrate,
        _ => false,
    };
    !(fast && cached >= HEADROOM_MIN_BUFFER_SECONDS.min(left))
}

/// What the player must have buffered before a preview is made.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Demand {
    /// Seconds of a network stream buffered.
    pub min_buffer: f64,
    /// Or, with [`HEADROOM_MIN_BUFFER_SECONDS`] buffered, the link bringing
    /// video in this many times faster than it plays.
    pub headroom: f64,
}

/// For a preview the pointer is waiting for.
pub const HOVER: Demand = Demand {
    min_buffer: 10.0,
    headroom: 2.0,
};
/// For one made ahead of the pointer (a prefetch, the storyboard), which can
/// wait.
pub const BACKGROUND: Demand = Demand {
    min_buffer: 20.0,
    headroom: 3.0,
};
/// Buffered video a fast link must still have before a preview is made: the
/// first moments after a load or a seek are the player's.
pub const HEADROOM_MIN_BUFFER_SECONDS: f64 = 3.0;

/// The player's buffer, for [`could_stall_playback`].
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct BufferState {
    /// Paused to buffer (`paused-for-cache`).
    pub buffering: bool,
    /// Read over the network (`demuxer-via-network`).
    pub via_network: bool,
    /// Seconds buffered ahead (`demuxer-cache-duration`).
    pub cached_seconds: Option<f64>,
    pub position: Option<f64>,
    pub duration: Option<f64>,
    /// Bytes per second arriving over the last second (`cache-speed`).
    pub input_rate: Option<f64>,
    /// Bytes per second the stream plays at (`file-size` over `duration`).
    pub bitrate: Option<f64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn network(cached: f64, position: f64, duration: f64) -> BufferState {
        BufferState {
            buffering: false,
            via_network: true,
            cached_seconds: Some(cached),
            position: Some(position),
            duration: Some(duration),
            input_rate: None,
            bitrate: None,
        }
    }

    fn stalls(buffer: &BufferState) -> bool {
        could_stall_playback(buffer, HOVER)
    }

    #[test]
    fn previews_wait_for_a_buffer() {
        assert!(!stalls(&network(12.0, 100.0, 2800.0)));
        assert!(stalls(&network(4.0, 100.0, 2800.0)));
        assert!(stalls(&BufferState {
            buffering: true,
            ..network(30.0, 100.0, 2800.0)
        }));
        // Nothing known about the buffer yet.
        assert!(stalls(&BufferState {
            via_network: true,
            ..BufferState::default()
        }));
    }

    #[test]
    fn background_previews_wait_for_more() {
        let buffer = network(15.0, 100.0, 2800.0);
        assert!(!could_stall_playback(&buffer, HOVER));
        assert!(could_stall_playback(&buffer, BACKGROUND));
        assert!(!could_stall_playback(
            &network(25.0, 100.0, 2800.0),
            BACKGROUND
        ));
    }

    #[test]
    fn a_fast_link_needs_only_a_little_buffered() {
        // A 4 MB/s stream arriving at 10 MB/s: 2.5 times faster than it plays.
        let fast = BufferState {
            input_rate: Some(10e6),
            bitrate: Some(4e6),
            ..network(4.0, 100.0, 2800.0)
        };
        assert!(!could_stall_playback(&fast, HOVER));
        assert!(
            could_stall_playback(&fast, BACKGROUND),
            "3 times for the background"
        );
        assert!(!could_stall_playback(
            &BufferState {
                input_rate: Some(13e6),
                ..fast
            },
            BACKGROUND
        ));
        // But not in the first moments after a load or a seek...
        assert!(could_stall_playback(
            &BufferState {
                cached_seconds: Some(2.0),
                ..fast
            },
            HOVER
        ));
        // ...nor when the link only just keeps up, or the rates aren't known.
        assert!(could_stall_playback(
            &BufferState {
                input_rate: Some(5e6),
                ..fast
            },
            HOVER
        ));
        assert!(could_stall_playback(
            &BufferState {
                bitrate: None,
                ..fast
            },
            HOVER
        ));
        assert!(could_stall_playback(
            &BufferState {
                bitrate: Some(0.0),
                ..fast
            },
            HOVER
        ));
    }

    #[test]
    fn near_the_end_what_is_left_is_enough() {
        // 6 s left, 5.5 s buffered: all there is.
        assert!(!stalls(&network(5.5, 2794.0, 2800.0)));
        assert!(!stalls(&network(0.0, 2799.5, 2800.0)));
        assert!(stalls(&network(2.0, 2790.0, 2800.0)));
    }

    #[test]
    fn local_media_never_waits() {
        assert!(!stalls(&BufferState::default()));
    }

    #[test]
    fn a_newer_request_supersedes_the_waiting_one() {
        let mut queue = Queue::default();
        let (first_tx, first) = mpsc::channel();
        let (second_tx, second) = mpsc::channel();
        queue.push(Pending {
            position: 10.0,
            reply: first_tx,
        });
        queue.push(Pending {
            position: 20.0,
            reply: second_tx,
        });
        assert_eq!(first.try_recv(), Ok(Outcome::Superseded));
        assert!(second.try_recv().is_err(), "the newer one waits its turn");
        assert_eq!(queue.pending.map(|pending| pending.position), Some(20.0));
    }

    #[test]
    fn a_request_comes_before_warming() {
        let mut queue = Queue::default();
        assert!(queue.take().is_none());
        let (warm_reply, _warm) = mpsc::channel();
        queue.warm = Some(Pending {
            position: 5.0,
            reply: warm_reply,
        });
        let (reply, _answer) = mpsc::channel();
        queue.push(Pending {
            position: 10.0,
            reply,
        });
        assert!(matches!(queue.take(), Some(Job::Preview(_))));
        assert!(matches!(queue.take(), Some(Job::Warm(pending)) if pending.position == 5.0));
        assert!(queue.take().is_none(), "warming is done once");
    }

    /// A 10 s, 128×72 H.264 video with a keyframe every 2 s (made with
    /// ffmpeg's `testsrc2`; see testdata/README.md).
    const FIXTURE: &[u8] = include_bytes!("testdata/seekable.mkv");

    /// Serves `body` over http on a loopback port, as a stream host would:
    /// honouring range requests, or (`ranges: false`) always sending all of
    /// it. Returns the URL and the bytes sent so far.
    fn serve_with(
        body: &'static [u8],
        ranges: bool,
    ) -> (String, Arc<std::sync::atomic::AtomicUsize>) {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let sent = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = sent.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let counter = counter.clone();
                std::thread::spawn(move || {
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut range: Option<(usize, Option<usize>)> = None;
                    let mut line = String::new();
                    while reader.read_line(&mut line).is_ok_and(|read| read > 2) {
                        if let Some(value) = line
                            .to_ascii_lowercase()
                            .trim()
                            .strip_prefix("range: bytes=")
                            && let Some((from, to)) = value.split_once('-')
                        {
                            range = from.parse().ok().map(|from| (from, to.parse().ok()));
                        }
                        line.clear();
                    }
                    let last = body.len() - 1;
                    let (head, start, end) = match range.filter(|_| ranges) {
                        Some((from, to)) => {
                            let (from, to) = (from.min(last), to.unwrap_or(last).min(last));
                            let head = format!(
                                "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {from}-{to}/{}\r\n",
                                body.len()
                            );
                            (head, from, to)
                        }
                        None => ("HTTP/1.1 200 OK\r\n".to_owned(), 0, last),
                    };
                    let head = format!(
                        "{head}Content-Type: video/x-matroska\r\nAccept-Ranges: {}\r\n\
                         Content-Length: {}\r\nConnection: close\r\n\r\n",
                        if ranges { "bytes" } else { "none" },
                        end - start + 1
                    );
                    if stream.write_all(head.as_bytes()).is_ok()
                        && stream.write_all(&body[start..=end]).is_ok()
                    {
                        counter.fetch_add(end - start + 1, Ordering::Relaxed);
                    }
                });
            }
        });
        (format!("http://127.0.0.1:{port}/seekable.mkv"), sent)
    }

    fn serve(body: &'static [u8]) -> (String, Arc<std::sync::atomic::AtomicUsize>) {
        serve_with(body, true)
    }

    fn frame(outcome: Outcome) -> Frame {
        match outcome {
            Outcome::Frame(frame) => frame,
            other => panic!("expected a frame, got {other:?}"),
        }
    }

    /// The JPEG's width and height, from its start-of-frame segment.
    fn jpeg_size(jpeg: &[u8]) -> Option<(u16, u16)> {
        let mut at = 2;
        while at + 9 < jpeg.len() {
            let (marker, length) = (
                jpeg[at + 1],
                u16::from_be_bytes([jpeg[at + 2], jpeg[at + 3]]),
            );
            if (0xC0..=0xC2).contains(&marker) {
                let height = u16::from_be_bytes([jpeg[at + 5], jpeg[at + 6]]);
                let width = u16::from_be_bytes([jpeg[at + 7], jpeg[at + 8]]);
                return Some((width, height));
            }
            at += 2 + usize::from(length);
        }
        None
    }

    #[test]
    fn previews_the_keyframe_before_each_position() {
        let (url, _) = serve(FIXTURE);
        let previewer = Previewer::new().unwrap();
        previewer.set_source(Some(url));

        for (asked, keyframe) in [(5.0, 4.0), (9.5, 8.0), (1.0, 0.0), (6.0, 6.0)] {
            let frame = frame(previewer.request(asked));
            assert!(
                (frame.position - keyframe).abs() < 0.2,
                "asked {asked}: got {}",
                frame.position
            );
            assert_eq!(&frame.jpeg[..2], &[0xFF, 0xD8], "a JPEG");
            assert_eq!(jpeg_size(&frame.jpeg), Some((PREVIEW_WIDTH as u16, 180)));
        }
    }

    #[test]
    fn follows_the_stream_and_gives_up_on_one_that_fails() {
        let (url, _) = serve(FIXTURE);
        let previewer = Previewer::new().unwrap();
        // Nothing listens on port 9 of the loopback interface.
        previewer.set_source(Some("http://127.0.0.1:9/missing.mkv".into()));
        assert_eq!(previewer.request(5.0), Outcome::Unavailable);
        // Not tried again for the same stream.
        let started = Instant::now();
        assert_eq!(previewer.request(5.0), Outcome::Unavailable);
        assert!(started.elapsed() < Duration::from_millis(100));

        previewer.set_source(Some(url));
        assert!((frame(previewer.request(5.0)).position - 4.0).abs() < 0.2);
    }

    #[test]
    fn gives_up_on_a_host_that_ignores_ranges() {
        let (url, sent) = serve_with(FIXTURE, false);
        let previewer = Previewer::new().unwrap();
        previewer.set_source(Some(url));
        assert_eq!(previewer.request(5.0), Outcome::Unavailable);
        // Seeking would mean reading from the start each time: not tried again.
        let after_first = sent.load(Ordering::Relaxed);
        assert_eq!(previewer.request(7.0), Outcome::Unavailable);
        assert_eq!(sent.load(Ordering::Relaxed), after_first);
    }

    #[test]
    fn warming_opens_the_stream_at_the_first_position_wanted() {
        let (url, sent) = serve(FIXTURE);
        let previewer = Previewer::new().unwrap();
        // Without a stream there is nothing to open.
        assert_eq!(previewer.warm(5.0), Outcome::Unavailable);
        assert_eq!(sent.load(Ordering::Relaxed), 0);

        previewer.set_source(Some(url));
        // Opening at 5 s reads the keyframe at 4 s: that is the frame.
        let warmed = frame(previewer.warm(5.0));
        assert!((warmed.position - 4.0).abs() < 0.2, "{}", warmed.position);
        let opened = sent.load(Ordering::Relaxed);
        assert!(opened > 0);
        // Open already: nothing more to show, and nothing read.
        assert_eq!(previewer.warm(9.0), Outcome::Warm);
        assert_eq!(sent.load(Ordering::Relaxed), opened);
        // A request elsewhere only seeks and decodes.
        let frame = frame(previewer.request(9.5));
        assert!((frame.position - 8.0).abs() < 0.2);
    }

    #[test]
    fn opening_again_reads_nothing_until_the_first_seek() {
        let (url, sent) = serve(FIXTURE);
        let shared = Arc::new(Shared {
            queue: Mutex::default(),
            wake: Condvar::new(),
            stop: AtomicBool::new(false),
        });
        let mut worker = Worker::new(shared);
        let core = worker.open(&url, None).unwrap();
        let opened = sent.load(Ordering::Relaxed);
        assert!(opened > 0);
        drop(core);
        // The core was freed (idle): the next opening is served from memory.
        let core = worker.open(&url, None).unwrap();
        assert_eq!(sent.load(Ordering::Relaxed), opened, "nothing read");
        // Previews work as before (the fixture is small enough that opening
        // read all of it, so they read nothing either).
        let dir = worker.frames_dir().unwrap();
        let (frame, _) = capture(
            &core.mpv,
            7.0,
            &dir.join("frame.jpg"),
            &worker.shared.stop,
            core.reader.as_deref(),
        )
        .unwrap();
        assert!((frame.position - 6.0).abs() < 0.2);
        drop(core);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn without_a_stream_nothing_is_previewed() {
        let previewer = Previewer::new().unwrap();
        assert_eq!(previewer.request(10.0), Outcome::Unavailable);
        previewer.set_source(None);
        assert_eq!(previewer.request(10.0), Outcome::Unavailable);
    }
}
