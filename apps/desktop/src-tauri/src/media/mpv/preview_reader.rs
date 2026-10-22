//! Bounded reads for the preview core (`preview.rs`).
//!
//! Left to itself, mpv asks a stream host for everything from a position
//! onwards and drops the connection once it has what it needs; by then the
//! host has sent far more (3 to 5 times a preview's keyframe on a fast link).
//! Through this reader, registered as `kiro-preview://<url>` with libmpv's
//! stream callbacks (stream_cb.h), the preview core instead asks for bounded
//! ranges: [`FIRST_READ`] after each seek, doubling while mpv keeps reading
//! straight on, up to [`MAX_READ`]. Measured on realistic streams that cuts
//! a preview's download 2 to 4 times, for a round trip or two more
//! (docs/playback.md, "Seek-bar previews"). Those round trips go after the
//! first previews: the preview core tells the reader how much mpv took from
//! it before each frame was there ([`ReaderContext::learn`]; one keyframe's
//! worth, which varies by stream far more than within one), and the next
//! seek asks for the median of that at once, up to [`MAX_FIRST_READ`].
//!
//! Opening a stream reads its header and index (1 MB for a 1080p web
//! release, 4 to 6 MB for a 4K remux): what the reader downloads before the
//! core reports the stream open is kept ([`OpeningCache`], up to
//! [`MAX_OPENING_CACHE`]) and served from memory when the same stream is
//! opened again after the core was freed for being idle.
//!
//! mpv calls the callbacks on its own threads, and `read` may block: requests
//! run on Tauri's async runtime with `block_on`, bounded by
//! [`REQUEST_TIMEOUT`]. A host that ignores ranges can't be previewed at all
//! (seeking would mean reading from the start), and is reported as such
//! ([`ReaderContext::ranges_refused`]); other failures to open fall back to
//! mpv's own reading. So does an HLS playlist ([`ReaderContext::playlist`]):
//! its segments are separate files, which libavformat's HLS demuxer opens
//! by URL itself, so there is nothing for bounded reads to do, and through
//! this reader mpv would take the playlist for a plain list of files. Of a
//! master playlist, mpv is given only the variant with the lowest bitrate
//! ([`lowest_variant`]): opening the master reads the first segments of
//! every variant, tens of MB for a stream with a 1080p one.

use std::collections::VecDeque;
use std::ffi::{CStr, c_char, c_int, c_void};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use url::Url;

use super::client::{self, Mpv};
use super::ffi;
use super::ffi::error as mpv_error;
use super::{debug_log_enabled, player_log};
use crate::media::parse_stream_url;

/// The protocol the preview core opens wrapped URLs with.
pub const PROTOCOL: &str = "kiro-preview";
/// Bytes asked for after a seek: about a 1080p keyframe.
pub const FIRST_READ: u64 = 256 * 1024;
/// The most asked for at once, however long mpv reads straight on.
pub const MAX_READ: u64 = 512 * 1024;
/// The most a learned first read grows to: a remux keyframe, with room.
pub const MAX_FIRST_READ: u64 = 2 * 1024 * 1024;
/// Seeks whose reads are remembered, for the median.
const LEARNED_BURSTS: usize = 8;
/// First reads are rounded up to this.
const READ_GRANULARITY: u64 = 64 * 1024;
/// The most of one stream's opening kept for opening it again.
pub const MAX_OPENING_CACHE: u64 = 8 * 1024 * 1024;
/// Streams whose openings are kept (the one playing, and a couple to come
/// back to).
pub const KEPT_OPENINGS: usize = 3;

/// The ranges read while a stream was opened, to serve its next opening
/// from memory: for the last few streams, the one used longest ago going
/// first. Shared by every preview core in the process, so it outlives the
/// player (leaving an episode and coming back opens it from memory too).
#[derive(Default)]
pub struct OpeningCache {
    streams: Vec<KeptOpening>,
}

struct KeptOpening {
    url: Url,
    /// By start offset, each range as the host sent it.
    ranges: Vec<(u64, Vec<u8>)>,
    size: u64,
}

impl OpeningCache {
    /// The cache every preview core shares.
    pub fn shared() -> Arc<Mutex<OpeningCache>> {
        static SHARED: std::sync::LazyLock<Arc<Mutex<OpeningCache>>> =
            std::sync::LazyLock::new(Arc::default);
        SHARED.clone()
    }

    /// The range kept that holds `offset` of `url`, if any.
    fn get(&mut self, url: &Url, offset: u64) -> Option<(u64, Vec<u8>)> {
        let index = self.streams.iter().position(|kept| kept.url == *url)?;
        let found = self.streams[index]
            .ranges
            .iter()
            .find(|(start, body)| (*start..*start + body.len() as u64).contains(&offset))
            .cloned();
        if found.is_some() && index + 1 != self.streams.len() {
            // Used: last to go.
            let kept = self.streams.remove(index);
            self.streams.push(kept);
        }
        found
    }

    /// Keeps `body` read from `offset` of `url`, while there is room.
    fn put(&mut self, url: &Url, offset: u64, body: &[u8]) {
        let index = match self.streams.iter().position(|kept| kept.url == *url) {
            Some(index) => index,
            None => {
                while self.streams.len() >= KEPT_OPENINGS {
                    self.streams.remove(0);
                }
                self.streams.push(KeptOpening {
                    url: url.clone(),
                    ranges: Vec::new(),
                    size: 0,
                });
                self.streams.len() - 1
            }
        };
        let kept = &mut self.streams[index];
        if body.is_empty() || kept.size + body.len() as u64 > MAX_OPENING_CACHE {
            return;
        }
        kept.size += body.len() as u64;
        kept.ranges.push((offset, body.to_vec()));
    }

    /// Bytes kept for `url`.
    pub fn bytes(&self, url: &Url) -> u64 {
        self.streams
            .iter()
            .find(|kept| kept.url == *url)
            .map_or(0, |kept| kept.size)
    }
}
/// One range request, connecting included. mpv waits for `read` to return
/// (also when the preview core is freed), so this bounds that wait.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_REDIRECTS: usize = 5;

/// `url` as the preview core opens it through this reader.
pub fn wrap(url: &str) -> String {
    format!("{PROTOCOL}://{url}")
}

/// What the readers of one preview core share: the HTTP client, and how much
/// they have downloaded (for the log).
pub struct ReaderContext {
    client: reqwest::Client,
    bytes: AtomicU64,
    /// Bytes mpv has taken from its readers (what it needed, as against
    /// what was downloaded to have it).
    taken: AtomicU64,
    /// The host answered without the range asked for: it can't be previewed
    /// (seeking would mean reading the stream from the start).
    refused: AtomicBool,
    /// The stream is an HLS playlist: mpv reads it itself.
    playlist: AtomicBool,
    /// Of a master playlist, the variant previews read.
    variant: Mutex<Option<Url>>,
    /// What the last few previews downloaded before their frame was there.
    bursts: Mutex<VecDeque<u64>>,
    /// The stream's opening, kept across cores for opening it again.
    opening: Arc<Mutex<OpeningCache>>,
    /// Still opening: what is read goes into `opening`.
    recording: AtomicBool,
}

impl ReaderContext {
    pub fn new(opening: Arc<Mutex<OpeningCache>>) -> Result<Arc<Self>, reqwest::Error> {
        // reqwest is built without a crypto provider; use `ring`, like the
        // addon transport. Fails harmlessly if one is installed already.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let redirect = reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= MAX_REDIRECTS
                || !matches!(attempt.url().scheme(), "http" | "https")
            {
                attempt.stop()
            } else {
                attempt.follow()
            }
        });
        let client = reqwest::Client::builder()
            .user_agent(concat!("Kiro/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .redirect(redirect)
            .build()?;
        Ok(Arc::new(Self {
            client,
            bytes: AtomicU64::new(0),
            taken: AtomicU64::new(0),
            refused: AtomicBool::new(false),
            playlist: AtomicBool::new(false),
            variant: Mutex::new(None),
            bursts: Mutex::new(VecDeque::new()),
            opening,
            recording: AtomicBool::new(true),
        }))
    }

    /// The stream is open: what is read from now on is previews, not kept.
    pub fn opened(&self) {
        self.recording.store(false, Ordering::Relaxed);
    }

    /// mpv took `bytes` between a preview's seek and its frame: the next
    /// seek's first read is sized by this (and the last few).
    pub fn learn(&self, bytes: u64) {
        let mut bursts = self.bursts.lock().unwrap_or_else(PoisonError::into_inner);
        if bursts.len() == LEARNED_BURSTS {
            bursts.pop_front();
        }
        bursts.push_back(bytes);
    }

    /// The first read after a seek: [`FIRST_READ`] until previews have shown
    /// what mpv takes for one, then the median of that and a little more,
    /// rounded up, so one request usually covers a keyframe.
    pub fn first_read(&self) -> u64 {
        let bursts = self.bursts.lock().unwrap_or_else(PoisonError::into_inner);
        if bursts.is_empty() {
            return FIRST_READ;
        }
        let mut sorted: Vec<u64> = bursts.iter().copied().collect();
        sorted.sort_unstable();
        let median = sorted[sorted.len() / 2];
        (median + median / 8)
            .div_ceil(READ_GRANULARITY)
            .saturating_mul(READ_GRANULARITY)
            .clamp(FIRST_READ, MAX_FIRST_READ)
    }

    /// Bytes downloaded by this context's readers so far.
    pub fn bytes_read(&self) -> u64 {
        self.bytes.load(Ordering::Relaxed)
    }

    /// Bytes mpv has taken from this context's readers so far.
    pub fn bytes_taken(&self) -> u64 {
        self.taken.load(Ordering::Relaxed)
    }

    /// Whether the host answered a range request with something else.
    pub fn ranges_refused(&self) -> bool {
        self.refused.load(Ordering::Relaxed)
    }

    /// Whether the stream turned out to be an HLS playlist, which this
    /// reader doesn't open.
    pub fn playlist(&self) -> bool {
        self.playlist.load(Ordering::Relaxed)
    }

    /// For an HLS master playlist, the variant mpv should read instead:
    /// the one with the lowest bitrate that has video.
    pub fn variant(&self) -> Option<Url> {
        self.variant
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

/// Makes `kiro-preview://<url>` open through a [`Reader`] on `mpv`.
///
/// `context` must outlive `mpv`: keep the `Arc` and drop the core first.
pub fn register(mpv: &Mpv, context: &Arc<ReaderContext>) -> client::Result<()> {
    // SAFETY: the caller keeps `context` alive for as long as the core;
    // `open` and the callbacks it installs keep stream_cb.h's contract.
    unsafe { mpv.add_stream_protocol(PROTOCOL, Arc::as_ptr(context).cast_mut().cast(), Some(open)) }
}

/// Why a range could not be read.
#[derive(Debug, PartialEq)]
enum ReadError {
    Cancelled,
    /// The host answered, but not with the range asked for.
    Refused,
    /// The stream is an HLS playlist.
    Playlist,
    Network,
}

/// One open stream: the range read last, and where mpv is.
struct Reader {
    context: *const ReaderContext,
    url: Url,
    /// Where `url` redirected to, if it did: asked directly from then on,
    /// so a host that redirects each range (an addon's link to a CDN)
    /// costs one round trip per range, not two. Dropped, to be found
    /// again, when a request to it fails (a signed link that expired).
    resolved: Option<Url>,
    /// Where mpv reads next.
    offset: u64,
    size: Option<u64>,
    /// Bytes from `buffer_start`, as read last.
    buffer: Vec<u8>,
    buffer_start: u64,
    /// How much the last request asked for, to grow it while reading on.
    last_len: u64,
    cancelled: AtomicBool,
}

impl Reader {
    fn context(&self) -> &ReaderContext {
        // SAFETY: `register`'s caller keeps the context alive while the core,
        // and so this reader, exists.
        unsafe { &*self.context }
    }

    fn buffer_end(&self) -> u64 {
        self.buffer_start + self.buffer.len() as u64
    }

    /// Whether a read from `offset` carries straight on from the last range.
    fn reading_on(&self) -> bool {
        self.offset == self.buffer_end() && !self.buffer.is_empty()
    }

    /// How much to ask for from `offset`: a first read after a seek, twice
    /// as much as last time when it carries on from the last range.
    fn next_len(&self) -> u64 {
        if self.reading_on() {
            (self.last_len * 2).min(MAX_READ)
        } else {
            self.context().first_read()
        }
    }

    /// Reads a range from `offset` into the buffer. An empty buffer means the
    /// end of the stream.
    fn fill(&mut self) -> Result<(), ReadError> {
        let mut len = self.next_len();
        if let Some(size) = self.size {
            len = len.min(size.saturating_sub(self.offset));
        }
        if len == 0 {
            self.buffer.clear();
            self.buffer_start = self.offset;
            return Ok(());
        }
        let (start, end) = (self.offset, self.offset + len - 1);
        // Read while this stream was opened before: served from memory.
        let kept = self
            .context()
            .opening
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&self.url, start);
        if let Some((kept_start, body)) = kept {
            self.buffer = body;
            self.buffer_start = kept_start;
            self.last_len = len;
            return Ok(());
        }
        let mut result = self.request(
            self.resolved.clone().unwrap_or_else(|| self.url.clone()),
            start,
            end,
        );
        if result.is_err() && result != Err(ReadError::Cancelled) && self.resolved.is_some() {
            // The resolved link stopped working (expired): back to the
            // original, which will redirect afresh.
            if debug_log_enabled() {
                player_log!("[kiro-reader] the resolved link failed: asking the original again");
            }
            self.resolved = None;
            result = self.request(self.url.clone(), start, end);
        }
        if result == Err(ReadError::Refused) {
            self.context().refused.store(true, Ordering::Relaxed);
        }
        let (body, total, served_by) = result?;
        if start == 0 && is_playlist(&body) {
            // Not kept for the next opening either: mpv will read it itself.
            let context = self.context();
            *context
                .variant
                .lock()
                .unwrap_or_else(PoisonError::into_inner) =
                lowest_variant(&String::from_utf8_lossy(&body), &served_by);
            context.playlist.store(true, Ordering::Relaxed);
            return Err(ReadError::Playlist);
        }
        if served_by != self.url {
            self.resolved = Some(served_by);
        }
        let context = self.context();
        context
            .bytes
            .fetch_add(body.len() as u64, Ordering::Relaxed);
        if context.recording.load(Ordering::Relaxed) {
            context
                .opening
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .put(&self.url, start, &body);
        }
        self.size = total.or(self.size);
        self.buffer = body;
        self.buffer_start = start;
        self.last_len = len;
        Ok(())
    }

    /// One range request to `url`: the body, the total size the host gave
    /// and the URL that served it (after any redirect).
    fn request(
        &self,
        url: Url,
        start: u64,
        end: u64,
    ) -> Result<(Vec<u8>, Option<u64>, Url), ReadError> {
        let len = end - start + 1;
        let client = self.context().client.clone();
        let cancelled = &self.cancelled;
        let log = debug_log_enabled();
        let asked = Instant::now();
        tauri::async_runtime::block_on(async move {
            let mut response = client
                .get(url.clone())
                .header(reqwest::header::RANGE, format!("bytes={start}-{end}"))
                .send()
                .await
                .map_err(|_| ReadError::Network)?;
            let served_by = response.url().clone();
            if log {
                // Where the range came from, and how long the first byte took:
                // a host that redirects each range costs a round trip more.
                let redirected = served_by.host_str() != url.host_str();
                player_log!(
                    "[kiro-reader] bytes {start}-{end} ({} KB): {} after {:?}{}",
                    len / 1024,
                    response.status().as_u16(),
                    asked.elapsed(),
                    if redirected {
                        format!(", redirected to {}", served_by.host_str().unwrap_or("-"))
                    } else {
                        String::new()
                    }
                );
            }
            let total = match response.status().as_u16() {
                206 => response
                    .headers()
                    .get(reqwest::header::CONTENT_RANGE)
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| content_range(value, start))
                    .ok_or(ReadError::Refused)?,
                // Without ranges, previews would read the whole stream.
                _ => return Err(ReadError::Refused),
            };
            let mut body = Vec::with_capacity(len as usize);
            while let Some(chunk) = response.chunk().await.map_err(|_| ReadError::Network)? {
                if cancelled.load(Ordering::Acquire) {
                    return Err(ReadError::Cancelled);
                }
                let room = len as usize - body.len();
                body.extend_from_slice(&chunk[..chunk.len().min(room)]);
                if body.len() as u64 >= len {
                    break;
                }
            }
            if log {
                player_log!(
                    "[kiro-reader] bytes {start}-{end}: {} KB in {:?}",
                    body.len() / 1024,
                    asked.elapsed()
                );
            }
            Ok((body, total, served_by))
        })
    }

    fn read(&mut self, out: &mut [u8]) -> Result<usize, ReadError> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err(ReadError::Cancelled);
        }
        if self.size.is_some_and(|size| self.offset >= size) {
            return Ok(0);
        }
        if !(self.buffer_start..self.buffer_end()).contains(&self.offset) {
            self.fill()?;
        }
        let from = (self.offset - self.buffer_start) as usize;
        let count = out.len().min(self.buffer.len().saturating_sub(from));
        out[..count].copy_from_slice(&self.buffer[from..from + count]);
        self.offset += count as u64;
        self.context()
            .taken
            .fetch_add(count as u64, Ordering::Relaxed);
        Ok(count)
    }
}

/// Whether a stream starting with `head` is an HLS playlist (`#EXTM3U`
/// first, after a byte order mark if there is one).
fn is_playlist(head: &[u8]) -> bool {
    head.strip_prefix(b"\xEF\xBB\xBF".as_slice())
        .unwrap_or(head)
        .starts_with(b"#EXTM3U")
}

/// Codecs (RFC 6381 names, as an HLS `CODECS` attribute lists them) that
/// are video.
const VIDEO_CODECS: &[&str] = &[
    "avc1", "avc3", "hvc1", "hev1", "dvh1", "dvhe", "vp08", "vp09", "av01", "mp4v",
];

/// The variant of an HLS master playlist with the lowest bandwidth that has
/// video (a resolution, a video codec, or no codecs listed), resolved
/// against `base`, the URL the playlist came from. `None` for a media
/// playlist (it lists segments, not variants), or when no variant has an
/// http(s) URL.
fn lowest_variant(playlist: &str, base: &Url) -> Option<Url> {
    let mut lowest: Option<(u64, Url)> = None;
    let mut lines = playlist.lines().map(str::trim);
    while let Some(line) = lines.next() {
        let Some(attributes) = line.strip_prefix("#EXT-X-STREAM-INF:") else {
            continue;
        };
        // The variant's URL is the next line that isn't a tag or blank.
        let Some(uri) = lines.find(|line| !line.is_empty() && !line.starts_with('#')) else {
            break;
        };
        let video = attribute(attributes, "RESOLUTION").is_some()
            || attribute(attributes, "CODECS").is_none_or(|codecs| {
                codecs.split(',').any(|codec| {
                    VIDEO_CODECS
                        .iter()
                        .any(|video| codec.trim().starts_with(video))
                })
            });
        let Some(url) = base
            .join(uri)
            .ok()
            .and_then(|url| parse_stream_url(url.as_str()).ok())
        else {
            continue;
        };
        let bandwidth = attribute(attributes, "BANDWIDTH")
            .and_then(|value| value.parse().ok())
            .unwrap_or(u64::MAX);
        if video && lowest.as_ref().is_none_or(|(least, _)| bandwidth < *least) {
            lowest = Some((bandwidth, url));
        }
    }
    lowest.map(|(_, url)| url)
}

/// The value of `name` in an HLS attribute list (`A=1,B="x,y"`), without
/// the quotes of a quoted one.
fn attribute<'a>(list: &'a str, name: &str) -> Option<&'a str> {
    let mut rest = list;
    while !rest.is_empty() {
        let (key, after) = rest.split_once('=')?;
        let (value, next) = match after.strip_prefix('"') {
            Some(quoted) => {
                let (value, next) = quoted.split_once('"')?;
                (value, next.strip_prefix(',').unwrap_or(next))
            }
            None => after.split_once(',').unwrap_or((after, "")),
        };
        if key.trim() == name {
            return Some(value);
        }
        rest = next;
    }
    None
}

/// The total size from a `Content-Range: bytes <start>-<end>/<total>` that
/// starts where asked (`None` for an unknown total, `*`).
fn content_range(value: &str, start: u64) -> Option<Option<u64>> {
    let (range, total) = value.strip_prefix("bytes ")?.split_once('/')?;
    let (from, _) = range.split_once('-')?;
    if from.trim().parse::<u64>().ok()? != start {
        return None;
    }
    Some(total.trim().parse::<u64>().ok())
}

// --- stream_cb.h callbacks ---------------------------------------------------

unsafe extern "C" fn open(
    user_data: *mut c_void,
    uri: *mut c_char,
    info: *mut ffi::mpv_stream_cb_info,
) -> c_int {
    // SAFETY: mpv passes a NUL-terminated URI.
    let uri = unsafe { CStr::from_ptr(uri) }.to_string_lossy();
    let Some(url) = uri
        .strip_prefix(PROTOCOL)
        .and_then(|rest| rest.strip_prefix("://"))
        .and_then(|url| parse_stream_url(url).ok())
    else {
        return mpv_error::LOADING_FAILED;
    };
    let mut reader = Box::new(Reader {
        context: user_data.cast_const().cast(),
        url,
        resolved: None,
        offset: 0,
        size: None,
        buffer: Vec::new(),
        buffer_start: 0,
        last_len: 0,
        cancelled: AtomicBool::new(false),
    });
    // Learns the size, and finds out whether the host serves ranges.
    if reader.fill().is_err() {
        return mpv_error::LOADING_FAILED;
    }
    // SAFETY: mpv passes a valid `info` to fill in.
    unsafe {
        *info = ffi::mpv_stream_cb_info {
            cookie: Box::into_raw(reader).cast(),
            read_fn: Some(read),
            seek_fn: Some(seek),
            size_fn: Some(size),
            close_fn: Some(close),
            cancel_fn: Some(cancel),
        };
    }
    0
}

/// # Safety
///
/// `cookie` is a `Reader` from `open`, not yet closed, used by one thread at a
/// time (mpv's guarantee for everything but `cancel`).
unsafe fn reader<'a>(cookie: *mut c_void) -> &'a mut Reader {
    unsafe { &mut *cookie.cast::<Reader>() }
}

unsafe extern "C" fn read(cookie: *mut c_void, buf: *mut c_char, nbytes: u64) -> i64 {
    // SAFETY: see `reader`; `buf` holds `nbytes` writable bytes.
    let (reader, out) = unsafe {
        (
            reader(cookie),
            std::slice::from_raw_parts_mut(buf.cast::<u8>(), nbytes as usize),
        )
    };
    match reader.read(out) {
        Ok(count) => count as i64,
        Err(_) => -1,
    }
}

unsafe extern "C" fn seek(cookie: *mut c_void, offset: i64) -> i64 {
    // SAFETY: see `reader`.
    let reader = unsafe { reader(cookie) };
    match u64::try_from(offset) {
        Ok(offset) => {
            reader.offset = offset;
            offset as i64
        }
        Err(_) => i64::from(mpv_error::GENERIC),
    }
}

unsafe extern "C" fn size(cookie: *mut c_void) -> i64 {
    // SAFETY: see `reader`.
    let reader = unsafe { reader(cookie) };
    reader
        .size
        .and_then(|size| i64::try_from(size).ok())
        .unwrap_or(i64::from(mpv_error::UNSUPPORTED))
}

unsafe extern "C" fn close(cookie: *mut c_void) {
    // SAFETY: `cookie` came from `Box::into_raw` in `open`; mpv closes once.
    drop(unsafe { Box::from_raw(cookie.cast::<Reader>()) });
}

unsafe extern "C" fn cancel(cookie: *mut c_void) {
    // SAFETY: the reader is alive until `close`; only its atomic is touched,
    // so this may run alongside `read` on another thread.
    let cancelled = unsafe { &(*cookie.cast::<Reader>()).cancelled };
    cancelled.store(true, Ordering::Release);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_total_from_content_range() {
        assert_eq!(
            content_range("bytes 0-262143/524972258", 0),
            Some(Some(524972258))
        );
        assert_eq!(content_range("bytes 4096-8191/*", 4096), Some(None));
        // Not the range asked for, or not a range at all.
        assert_eq!(content_range("bytes 0-262143/524972258", 4096), None);
        assert_eq!(content_range("items 0-1/2", 0), None);
        assert_eq!(content_range("bytes 0-262143", 0), None);
    }

    #[test]
    fn knows_an_hls_playlist_by_its_first_line() {
        assert!(is_playlist(
            b"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow.m3u8\n"
        ));
        assert!(is_playlist(b"\xEF\xBB\xBF#EXTM3U\r\n"));
        // A video file, or a playlist's name somewhere else in one.
        assert!(!is_playlist(b"\x1A\x45\xDF\xA3 matroska"));
        assert!(!is_playlist(b"\x00\x00\x00\x20ftypisom #EXTM3U"));
        assert!(!is_playlist(b""));
    }

    #[test]
    fn reads_hls_attributes() {
        let list =
            r#"PROGRAM-ID=1,BANDWIDTH=2149280,CODECS="mp4a.40.2,avc1.64001f",RESOLUTION=1280x720"#;
        assert_eq!(attribute(list, "BANDWIDTH"), Some("2149280"));
        assert_eq!(attribute(list, "CODECS"), Some("mp4a.40.2,avc1.64001f"));
        assert_eq!(attribute(list, "RESOLUTION"), Some("1280x720"));
        assert_eq!(attribute(list, "FRAME-RATE"), None);
        assert_eq!(attribute("", "BANDWIDTH"), None);
    }

    #[test]
    fn picks_the_lowest_hls_variant_with_video() {
        let base = Url::parse("https://cdn.example.com/show/master.m3u8?token=abc").unwrap();
        let master = "#EXTM3U\n\
            #EXT-X-STREAM-INF:BANDWIDTH=6221600,CODECS=\"mp4a.40.2,avc1.640028\",RESOLUTION=1920x1080\n\
            1080/index.m3u8\n\
            #EXT-X-STREAM-INF:BANDWIDTH=64000,CODECS=\"mp4a.40.5\"\n\
            audio/index.m3u8\n\
            #EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=10000,URI=\"iframes.m3u8\"\n\
            #EXT-X-STREAM-INF:BANDWIDTH=246440,CODECS=\"mp4a.40.5,avc1.42000d\",RESOLUTION=320x184\n\
            \n\
            https://other.example.com/240/index.m3u8\n\
            #EXT-X-STREAM-INF:BANDWIDTH=460560,RESOLUTION=512x288\n\
            380/index.m3u8\n";
        // Not the audio-only one, nor the I-frame playlist; an absolute URL
        // as it is.
        assert_eq!(
            lowest_variant(master, &base).map(String::from),
            Some("https://other.example.com/240/index.m3u8".into())
        );
        // A relative URL is resolved against the playlist's.
        let without = master.replace(
            "https://other.example.com/240/index.m3u8",
            "file:///240.m3u8",
        );
        assert_eq!(
            lowest_variant(&without, &base).map(String::from),
            Some("https://cdn.example.com/show/380/index.m3u8".into()),
            "only http(s)"
        );
        // A variant without codecs may be video.
        let unlabelled = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nlow.m3u8\n";
        assert_eq!(
            lowest_variant(unlabelled, &base).map(String::from),
            Some("https://cdn.example.com/show/low.m3u8".into())
        );
        // A media playlist has no variants.
        let media = "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nseg0.ts\n#EXT-X-ENDLIST\n";
        assert_eq!(lowest_variant(media, &base), None);
    }

    /// A reader on `context`, which the test keeps alive.
    fn reader(context: &Arc<ReaderContext>) -> Reader {
        Reader {
            context: Arc::as_ptr(context),
            url: Url::parse("http://127.0.0.1/a.mkv").unwrap(),
            resolved: None,
            offset: 0,
            size: Some(100 * MAX_READ),
            buffer: Vec::new(),
            buffer_start: 0,
            last_len: 0,
            cancelled: AtomicBool::new(false),
        }
    }

    #[test]
    fn asks_for_more_while_reading_on_and_starts_small_after_a_seek() {
        let context = ReaderContext::new(Arc::default()).unwrap();
        let mut reader = reader(&context);
        assert_eq!(reader.next_len(), FIRST_READ);
        // Read straight on from a first range: twice as much, up to the cap.
        reader.buffer = vec![0; FIRST_READ as usize];
        reader.last_len = FIRST_READ;
        reader.offset = FIRST_READ;
        assert_eq!(reader.next_len(), (2 * FIRST_READ).min(MAX_READ));
        reader.last_len = MAX_READ;
        reader.buffer_start = 10 * MAX_READ;
        reader.buffer = vec![0; MAX_READ as usize];
        reader.offset = 11 * MAX_READ;
        assert_eq!(reader.next_len(), MAX_READ);
        // A seek elsewhere starts small again.
        reader.offset = 50 * MAX_READ;
        assert_eq!(reader.next_len(), FIRST_READ);
    }

    #[test]
    fn learns_how_much_a_preview_downloads() {
        let context = ReaderContext::new(Arc::default()).unwrap();
        let reader = reader(&context);
        assert_eq!(context.first_read(), FIRST_READ);
        // 4K keyframes: about 600 KB each, one of them huge.
        for bytes in [600, 580, 2800, 610, 590] {
            context.learn(bytes * 1024);
        }
        // The median (600 KB) and an eighth more, rounded up to 64 KB.
        assert_eq!(context.first_read(), 704 * 1024);
        assert_eq!(reader.next_len(), 704 * 1024, "after a seek");
        // Small keyframes never go below the first read; huge ones are capped.
        let small = ReaderContext::new(Arc::default()).unwrap();
        small.learn(100 * 1024);
        assert_eq!(small.first_read(), FIRST_READ);
        let huge = ReaderContext::new(Arc::default()).unwrap();
        huge.learn(3 * 1024 * 1024);
        assert_eq!(huge.first_read(), MAX_FIRST_READ);
        // Only the last few count, so a stream that changes is followed.
        for _ in 0..LEARNED_BURSTS {
            context.learn(200 * 1024);
        }
        assert_eq!(context.first_read(), FIRST_READ);
    }

    #[test]
    fn keeps_what_opening_reads_and_serves_it_next_time() {
        let url = Url::parse("http://127.0.0.1/a.mkv").unwrap();
        let mut cache = OpeningCache::default();
        assert!(cache.get(&url, 0).is_none());
        cache.put(&url, 0, &[1, 2, 3, 4]);
        cache.put(&url, 1000, &[5, 6]);
        assert_eq!(cache.get(&url, 2), Some((0, vec![1, 2, 3, 4])));
        assert_eq!(cache.get(&url, 1001), Some((1000, vec![5, 6])));
        assert!(cache.get(&url, 4).is_none(), "just past a range");
        assert_eq!(cache.bytes(&url), 6);
        // Too much is left out.
        cache.put(&url, 1, &vec![0; MAX_OPENING_CACHE as usize]);
        assert_eq!(cache.bytes(&url), 6);
        // The last few streams are kept, the one used longest ago going first.
        let stream = |name: &str| Url::parse(&format!("http://127.0.0.1/{name}.mkv")).unwrap();
        for name in ["b", "c"] {
            cache.put(&stream(name), 0, &[9]);
        }
        assert!(cache.get(&url, 0).is_some(), "a used: last to go");
        cache.put(&stream("d"), 0, &[9]);
        assert!(cache.get(&stream("b"), 0).is_none(), "b went");
        assert!(cache.get(&url, 0).is_some());
        assert_eq!(cache.streams.len(), KEPT_OPENINGS);
    }

    #[test]
    fn serves_reads_from_the_last_range() {
        let context = ReaderContext::new(Arc::default()).unwrap();
        let mut reader = reader(&context);
        reader.buffer = (0..=255u8).collect();
        reader.buffer_start = 1000;
        reader.offset = 1010;
        let mut out = [0u8; 4];
        assert_eq!(reader.read(&mut out), Ok(4));
        assert_eq!(out, [10, 11, 12, 13]);
        assert_eq!(reader.offset, 1014);
        // At the end of the stream there is nothing more to read.
        reader.offset = reader.size.unwrap();
        assert_eq!(reader.read(&mut out), Ok(0));
        // Once cancelled, reads fail.
        reader.cancelled.store(true, Ordering::Release);
        reader.offset = 1010;
        assert_eq!(reader.read(&mut out), Err(ReadError::Cancelled));
    }
}
