//! Intro and credits times from SkipDB (<https://skipdb.tv>), for episodes
//! whose file has no chapters naming them, which is most streaming releases.
//!
//! SkipDB is crowd-sourced and keyed by IMDb id, season and episode. Its data
//! is ODbL 1.0 (© SkipDB contributors); Kiro only displays it, which its
//! reciprocity term exempts, and keeps nothing beyond an in-memory cache.
//!
//! The same episode is cut differently by different releases (a studio or
//! service logo, a longer recap), so times recorded on one file are not
//! simply right for another. Kiro sends the playing file's duration and asks
//! for the times as recorded (`adjust=none`). SkipDB reports, per segment,
//! `offset_ms`: this file's length minus the recorded file's. SkipDB's own
//! `match` labels depend on the `adjust` mode (with `none`, 13 s off is
//! "exact"), so only the offset is relied on:
//!
//! - Within [`MAX_OFFSET_MS`] (SkipDB's own limit for shifting), the segment
//!   is used, trimmed to what is the part whether the difference comes
//!   before it or after it: from `start + max(0, offset)` to
//!   `end + min(0, offset)`. Skipping then never skips any of the episode;
//!   at worst a few seconds of the theme still play. A part too short once
//!   trimmed is left out (by the renderer's minimum length).
//! - Further off, or with no length recorded, it is not used. Where the
//!   other file's length is known it is reported, for Stats.
//!
//! Everything in the response is untrusted: what does not parse, or falls
//! outside the file, is dropped. Where in the video a part may be, and how
//! long, is checked by the renderer with the same rules as chapters
//! (`chapter-skip.ts`).

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use url::Url;

use crate::addons::AddonUrl;
use crate::addons::transport::{HttpTransport, Limits};
use crate::core::error::{Error, Result};

/// Shown with the times (Stats, Settings), as ODbL asks.
pub const SOURCE: &str = "SkipDB";
const ENDPOINT: &str = "https://skipdb.tv/api/segments";

/// A response is a few hundred bytes; anything near this is not SkipDB's.
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
/// Episodes remembered for the session (each a few segments).
const CACHE_ENTRIES: usize = 256;
/// Longer than any episode; also keeps the duration a sane number to send.
const MAX_DURATION_SECONDS: f64 = 6.0 * 60.0 * 60.0;
/// How far a recorded file's length may be from this one's for its times to
/// be used (trimmed, see the module docs). SkipDB shifts up to this much.
const MAX_OFFSET_MS: f64 = 15_000.0;
/// Other lengths reported, at most (SkipDB has a few releases per episode).
const MAX_OTHER_LENGTHS: usize = 4;
/// A segment may overrun the file's ends by this much (rounding); it is
/// clamped. Further out, it was recorded on another cut.
const EDGE_TOLERANCE_SECONDS: f64 = 2.0;

/// One episode of one release: what is looked up, and the cache key.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct EpisodeQuery {
    imdb_id: String,
    season: u32,
    episode: u32,
    /// The playing file's duration, to the millisecond.
    duration_ms: u64,
}

impl EpisodeQuery {
    /// Validates what the renderer sends: an IMDb series id (`tt` and 7 to 10
    /// digits), a regular season and episode (specials, season 0, are not
    /// looked up) and the file's duration in seconds.
    pub fn new(imdb_id: &str, season: u32, episode: u32, duration: f64) -> Result<Self> {
        let digits = imdb_id.strip_prefix("tt").unwrap_or_default();
        if !(7..=10).contains(&digits.len()) || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(Error::invalid_argument("Invalid IMDb id"));
        }
        if !(1..=999).contains(&season) || !(1..=9999).contains(&episode) {
            return Err(Error::invalid_argument("Invalid season or episode"));
        }
        if !duration.is_finite() || duration <= 0.0 || duration > MAX_DURATION_SECONDS {
            return Err(Error::invalid_argument("Invalid duration"));
        }
        Ok(Self {
            imdb_id: imdb_id.to_owned(),
            season,
            episode,
            duration_ms: (duration * 1000.0).round() as u64,
        })
    }

    fn duration(&self) -> f64 {
        self.duration_ms as f64 / 1000.0
    }

    fn url(&self, endpoint: &AddonUrl) -> Result<AddonUrl> {
        let mut url: Url = endpoint.as_url().clone();
        url.query_pairs_mut()
            .clear()
            .append_pair("imdb_id", &self.imdb_id)
            .append_pair("season", &self.season.to_string())
            .append_pair("episode", &self.episode.to_string())
            .append_pair("duration", &format!("{:.3}", self.duration()))
            // The times as recorded, with `offset_ms`: Kiro does its own trimming.
            .append_pair("adjust", "none");
        AddonUrl::parse(url.as_str())
    }
}

/// What a segment is. Mirrors `ChapterRole` in `chapter-skip.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SkipKind {
    Intro,
    Recap,
    Credits,
    Preview,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct SkipTime {
    pub kind: SkipKind,
    /// Seconds, within the file, trimmed for `offset`.
    pub start: f64,
    pub end: f64,
    /// This file's length minus the recorded file's, in seconds.
    pub offset: f64,
}

/// The times found for an episode, for the file that is playing.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkipTimes {
    /// Where the times come from, for display.
    pub source: &'static str,
    /// Segments recorded on a file of (about) this length, in order.
    pub segments: Vec<SkipTime>,
    /// Segments SkipDB has for the episode that could not be matched to this
    /// file (another release's length, or none recorded).
    pub unmatched: u32,
    /// The lengths, in seconds, of the files those segments were recorded on,
    /// where SkipDB says (`offset_ms` is this file's duration minus theirs).
    /// Shown in Stats, so a mismatch explains itself.
    pub other_lengths: Vec<f64>,
}

/// SkipDB's segment names, and what Kiro calls them.
const KINDS: [(&str, SkipKind); 4] = [
    ("intro", SkipKind::Intro),
    ("recap", SkipKind::Recap),
    ("outro", SkipKind::Credits),
    ("preview", SkipKind::Preview),
];

/// Reads a SkipDB `/api/segments` response for a file of `duration` seconds.
///
/// ```json
/// { "segments": { "intro": { "start_ms": 73500, "end_ms": 90000, "adjusted": false,
///   "offset_ms": 0, "match": "exact", "confidence": 0.9 }, "recap": null, ... } }
/// ```
///
/// Never fails: anything malformed is left out.
pub fn parse_segments(value: &Value, duration: f64) -> SkipTimes {
    let mut times = SkipTimes {
        source: SOURCE,
        segments: Vec::new(),
        unmatched: 0,
        other_lengths: Vec::new(),
    };
    let Some(segments) = value.get("segments").and_then(Value::as_object) else {
        return times;
    };
    for (name, kind) in KINDS {
        let Some(entry) = segments.get(name).and_then(Value::as_object) else {
            continue;
        };
        // Only a segment SkipDB compared with this file's length says how
        // far off it is ("agnostic": no length was recorded).
        let compared = matches!(
            entry.get("match").and_then(Value::as_str),
            Some("exact" | "shifted" | "out-of-range")
        );
        let Some(offset_ms) = entry
            .get("offset_ms")
            .and_then(Value::as_f64)
            .filter(|offset| compared && offset.is_finite())
        else {
            times.unmatched += 1;
            continue;
        };
        if offset_ms.abs() > MAX_OFFSET_MS {
            times.unmatched += 1;
            let length = ((duration - offset_ms / 1000.0) * 10.0).round() / 10.0;
            if length > 0.0
                && length <= MAX_DURATION_SECONDS
                && times.other_lengths.len() < MAX_OTHER_LENGTHS
                && !times
                    .other_lengths
                    .iter()
                    .any(|known| (known - length).abs() < 1.0)
            {
                times.other_lengths.push(length);
            }
            continue;
        }
        let seconds = |key: &str| {
            entry
                .get(key)
                .and_then(Value::as_f64)
                .filter(|ms| ms.is_finite())
                .map(|ms| ms / 1000.0)
        };
        let (Some(start), Some(end)) = (seconds("start_ms"), seconds("end_ms")) else {
            continue;
        };
        // Asked for as recorded; undo a shift anyway if SkipDB made one.
        let offset = offset_ms / 1000.0;
        let shift = match entry.get("adjusted").and_then(Value::as_bool) {
            Some(false) => 0.0,
            Some(true) => offset,
            None => continue,
        };
        let (start, end) = (start - shift, end - shift);
        // The part, whether the difference is before it or after it.
        let (start, end) = (start + offset.max(0.0), end + offset.min(0.0));
        if start < -EDGE_TOLERANCE_SECONDS || end > duration + EDGE_TOLERANCE_SECONDS {
            continue;
        }
        let (start, end) = (start.max(0.0), end.min(duration));
        if end > start {
            times.segments.push(SkipTime {
                kind,
                start,
                end,
                offset,
            });
        }
    }
    times.segments.sort_by(|a, b| a.start.total_cmp(&b.start));
    times.other_lengths.sort_by(f64::total_cmp);
    times
}

/// Looks up and remembers skip times. Responses (including "none") are kept
/// per episode and file duration for the session; failures are not.
#[derive(Debug)]
pub struct SkipTimesService {
    endpoint: AddonUrl,
    /// Created on first use, like the addon transport.
    transport: OnceLock<HttpTransport>,
    cache: Mutex<Cache>,
}

#[derive(Debug, Default)]
struct Cache {
    entries: HashMap<EpisodeQuery, SkipTimes>,
    /// Oldest first, for eviction.
    order: VecDeque<EpisodeQuery>,
}

impl Default for SkipTimesService {
    fn default() -> Self {
        Self::with_endpoint(AddonUrl::parse(ENDPOINT).expect("the SkipDB endpoint is valid"))
    }
}

impl SkipTimesService {
    pub fn with_endpoint(endpoint: AddonUrl) -> Self {
        Self {
            endpoint,
            transport: OnceLock::new(),
            cache: Mutex::new(Cache::default()),
        }
    }

    fn transport(&self) -> Result<&HttpTransport> {
        if let Some(transport) = self.transport.get() {
            return Ok(transport);
        }
        // Tighter than for addons: the answer is small, and nothing waits on it.
        let transport = HttpTransport::with_limits(Limits {
            connect_timeout: Duration::from_secs(5),
            timeout: Duration::from_secs(8),
            max_manifest_bytes: MAX_RESPONSE_BYTES,
            max_resource_bytes: MAX_RESPONSE_BYTES,
            max_redirects: 2,
        })?;
        Ok(self.transport.get_or_init(|| transport))
    }

    fn cached(&self, query: &EpisodeQuery) -> Option<SkipTimes> {
        let cache = self
            .cache
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        cache.entries.get(query).cloned()
    }

    fn remember(&self, query: EpisodeQuery, times: SkipTimes) {
        let mut cache = self
            .cache
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if cache.entries.insert(query.clone(), times).is_none() {
            cache.order.push_back(query);
        }
        while cache.order.len() > CACHE_ENTRIES {
            if let Some(oldest) = cache.order.pop_front() {
                cache.entries.remove(&oldest);
            }
        }
    }

    pub async fn lookup(&self, query: &EpisodeQuery) -> Result<SkipTimes> {
        if let Some(times) = self.cached(query) {
            return Ok(times);
        }
        let url = query.url(&self.endpoint)?;
        let value = self
            .transport()?
            .fetch_json(&url, MAX_RESPONSE_BYTES)
            .await?;
        let times = parse_segments(&value, query.duration());
        self.remember(query.clone(), times.clone());
        Ok(times)
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::thread;

    use serde_json::json;

    use super::*;
    use crate::addons::transport::AddonError;

    fn query(duration: f64) -> EpisodeQuery {
        EpisodeQuery::new("tt0903747", 2, 4, duration).unwrap()
    }

    /// A segment as SkipDB sends it.
    fn segment(start_ms: f64, end_ms: f64, matched: &str, offset_ms: f64) -> Value {
        json!({
            "start_ms": start_ms, "end_ms": end_ms, "adjusted": false,
            "offset_ms": offset_ms, "match": matched, "confidence": 0.9,
        })
    }

    #[test]
    fn validates_queries() {
        assert!(EpisodeQuery::new("tt0903747", 1, 1, 2853.0).is_ok());
        assert!(EpisodeQuery::new("tt10919420", 1, 1, 2853.0).is_ok());
        for (id, season, episode, duration) in [
            ("tt090374", 1, 1, 2853.0),
            ("0903747", 1, 1, 2853.0),
            ("tt0903747&x=1", 1, 1, 2853.0),
            ("tt０９０３７４７", 1, 1, 2853.0),
            ("kitsu:1", 1, 1, 2853.0),
            ("tt0903747", 0, 1, 2853.0),
            ("tt0903747", 1, 0, 2853.0),
            ("tt0903747", 1, 1, 0.0),
            ("tt0903747", 1, 1, f64::NAN),
            ("tt0903747", 1, 1, f64::INFINITY),
            ("tt0903747", 1, 1, 7.0 * 60.0 * 60.0),
        ] {
            let error = EpisodeQuery::new(id, season, episode, duration).unwrap_err();
            assert_eq!(
                error.code(),
                "INVALID_ARGUMENT",
                "{id} {season} {episode} {duration}"
            );
        }
    }

    #[test]
    fn builds_the_request_url() {
        let url = query(2853.0)
            .url(&AddonUrl::parse(ENDPOINT).unwrap())
            .unwrap();
        assert_eq!(
            url.as_url().as_str(),
            "https://skipdb.tv/api/segments?imdb_id=tt0903747&season=2&episode=4&duration=2853.000&adjust=none"
        );
    }

    fn time(kind: SkipKind, start: f64, end: f64, offset: f64) -> SkipTime {
        SkipTime {
            kind,
            start,
            end,
            offset,
        }
    }

    #[test]
    fn keeps_segments_recorded_on_a_file_of_this_length() {
        let value = json!({ "segments": {
            "intro": segment(73_500.0, 90_000.0, "exact", 0.0),
            "recap": null,
            "outro": segment(2_800_000.0, 2_853_000.0, "exact", 0.0),
            "preview": null,
        }});
        assert_eq!(
            parse_segments(&value, 2853.0),
            SkipTimes {
                source: "SkipDB",
                segments: vec![
                    time(SkipKind::Intro, 73.5, 90.0, 0.0),
                    time(SkipKind::Credits, 2800.0, 2853.0, 0.0),
                ],
                unmatched: 0,
                other_lengths: vec![],
            }
        );
    }

    #[test]
    fn trims_parts_from_a_slightly_different_cut_to_what_is_the_part_either_way() {
        // The Big Bang Theory S11E1: this file is 10 s longer than the one
        // recorded. Before the intro, the intro starts 10 s later; after it,
        // it ends where recorded. 182.5 to 193.1 is the intro in both cases.
        let longer = json!({ "segments": {
            "intro": segment(172_500.0, 193_100.0, "exact", 10_000.0),
            "outro": segment(1_205_000.0, 1_232_000.0, "exact", 10_000.0),
        }});
        assert_eq!(
            parse_segments(&longer, 1241.952).segments,
            vec![
                time(SkipKind::Intro, 182.5, 193.1, 10.0),
                time(SkipKind::Credits, 1215.0, 1232.0, 10.0),
            ]
        );

        // Breaking Bad S1E2: this file is 8 s shorter. 315 to 323 either way.
        let shorter = json!({ "segments": {
            "intro": segment(315_000.0, 331_000.0, "exact", -8_000.0),
            "outro": segment(2_850_000.0, 2_901_000.0, "exact", -8_000.0),
        }});
        assert_eq!(
            parse_segments(&shorter, 2892.947).segments,
            vec![
                time(SkipKind::Intro, 315.0, 323.0, -8.0),
                time(SkipKind::Credits, 2850.0, 2892.947, -8.0),
            ]
        );
    }

    #[test]
    fn undoes_a_shift_skipdb_made() {
        // As `adjust=conservative` would send Breaking Bad S1E2: moved 8 s
        // earlier. Back to as recorded, then trimmed as above.
        let shifted = json!({ "segments": { "intro": {
            "start_ms": 307_000, "end_ms": 323_000, "adjusted": true,
            "offset_ms": -8_000, "match": "shifted",
        }}});
        assert_eq!(
            parse_segments(&shifted, 2892.947).segments,
            vec![time(SkipKind::Intro, 315.0, 323.0, -8.0)]
        );
    }

    #[test]
    fn leaves_out_releases_too_far_off_and_says_how_long_they_were() {
        // The Big Bang Theory S1E1: one recording, on a 22:48 file.
        let recorded = |offset_ms: f64, matched: &str| {
            json!({ "segments": {
                "intro": segment(361_400.0, 381_400.0, matched, offset_ms),
                "outro": segment(1_345_000.0, 1_368_000.0, matched, offset_ms),
            }})
        };
        for (duration, offset_ms) in [(1340.0, -28_000.0), (1400.0, 32_000.0)] {
            let times = parse_segments(&recorded(offset_ms, "out-of-range"), duration);
            assert!(times.segments.is_empty(), "{duration}");
            assert_eq!(times.unmatched, 2);
            assert_eq!(times.other_lengths, vec![1368.0], "{duration}");
        }
        // SkipDB's labels depend on its `adjust` mode; the offset decides.
        let labelled_exact = parse_segments(&recorded(16_000.0, "exact"), 1384.0);
        assert!(labelled_exact.segments.is_empty());
        let within = parse_segments(&recorded(15_000.0, "out-of-range"), 1383.0);
        assert_eq!(within.segments.len(), 2);

        // Without a recorded length there is nothing to go on.
        let agnostic = parse_segments(&recorded(0.0, "agnostic"), 1340.0);
        assert!(agnostic.segments.is_empty());
        assert_eq!(agnostic.unmatched, 2);
        assert!(agnostic.other_lengths.is_empty());
    }

    #[test]
    fn clamps_to_the_file_and_drops_what_lies_outside_it() {
        let value = json!({ "segments": {
            "recap": segment(-1_500.0, 50_000.0, "exact", 0.0),
            "outro": segment(1_400_000.0, 1_501_000.0, "exact", 0.0),
        }});
        assert_eq!(
            parse_segments(&value, 1500.0).segments,
            vec![
                time(SkipKind::Recap, 0.0, 50.0, 0.0),
                time(SkipKind::Credits, 1400.0, 1500.0, 0.0),
            ]
        );

        let outside = json!({ "segments": {
            "recap": segment(-30_000.0, 50_000.0, "exact", 0.0),
            "outro": segment(1_400_000.0, 1_600_000.0, "exact", 0.0),
            "intro": segment(90_000.0, 90_000.0, "exact", 0.0),
            // Trimmed to nothing: a 6 s part from a cut 8 s off.
            "preview": segment(1_450_000.0, 1_456_000.0, "exact", 8_000.0),
        }});
        assert!(parse_segments(&outside, 1500.0).segments.is_empty());
    }

    #[test]
    fn ignores_malformed_responses() {
        for value in [
            json!(null),
            json!([]),
            json!({ "error": "imdb_id is required (e.g. tt0903747)" }),
            json!({ "segments": [] }),
            json!({ "segments": { "intro": "0-90" } }),
            json!({ "segments": { "intro": { "start_ms": "0", "end_ms": 90_000,
                "adjusted": false, "offset_ms": 0, "match": "exact" } } }),
            json!({ "segments": { "intro": { "start_ms": 0, "end_ms": 90_000,
                "match": "exact" } } }),
            json!({ "segments": { "intro": { "start_ms": 0, "end_ms": 90_000,
                "offset_ms": 0, "match": "exact" } } }),
            json!({ "segments": { "intro": { "start_ms": 0, "end_ms": 90_000,
                "adjusted": false, "offset_ms": "0", "match": "exact" } } }),
            json!({ "segments": { "credits": segment(0.0, 9_000.0, "exact", 0.0) } }),
        ] {
            assert!(
                parse_segments(&value, 1500.0).segments.is_empty(),
                "{value}"
            );
        }
    }

    /// Serves `body` as JSON on a loopback port, counting requests and
    /// keeping the last request line. Returns a service pointed at it.
    fn serve(
        status: &'static str,
        body: Value,
    ) -> (SkipTimesService, Arc<AtomicUsize>, Arc<Mutex<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let hits = Arc::new(AtomicUsize::new(0));
        let line = Arc::new(Mutex::new(String::new()));
        let (counter, last) = (hits.clone(), line.clone());
        let body = body.to_string();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut request = [0; 4096];
                let read = stream.read(&mut request).unwrap_or(0);
                let text = String::from_utf8_lossy(&request[..read]);
                *last.lock().unwrap() = text.lines().next().unwrap_or_default().to_owned();
                counter.fetch_add(1, Ordering::SeqCst);
                let response = format!(
                    "HTTP/1.1 {status}\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });
        let endpoint = AddonUrl::parse(&format!("http://127.0.0.1:{port}/api/segments")).unwrap();
        (SkipTimesService::with_endpoint(endpoint), hits, line)
    }

    #[test]
    fn looks_up_once_per_episode_and_file() {
        let (service, hits, line) = serve(
            "200 OK",
            json!({ "segments": { "intro": segment(73_500.0, 90_000.0, "exact", 0.0) } }),
        );
        let lookup = |duration| tauri::async_runtime::block_on(service.lookup(&query(duration)));

        let first = lookup(2853.0).unwrap();
        assert_eq!(first.segments.len(), 1);
        assert_eq!(
            *line.lock().unwrap(),
            "GET /api/segments?imdb_id=tt0903747&season=2&episode=4&duration=2853.000&adjust=none HTTP/1.1"
        );
        assert_eq!(lookup(2853.0).unwrap(), first);
        assert_eq!(
            hits.load(Ordering::SeqCst),
            1,
            "the second lookup is cached"
        );

        // Another release of the same episode is another question.
        lookup(2820.0).unwrap();
        assert_eq!(hits.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn remembers_episodes_without_times() {
        let (service, hits, _) = serve("200 OK", json!({ "segments": { "intro": null } }));
        for _ in 0..2 {
            let times = tauri::async_runtime::block_on(service.lookup(&query(2853.0))).unwrap();
            assert!(times.segments.is_empty());
        }
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn does_not_remember_failures() {
        let (service, hits, _) = serve("503 Service Unavailable", json!({}));
        for _ in 0..2 {
            let error = tauri::async_runtime::block_on(service.lookup(&query(2853.0))).unwrap_err();
            assert!(
                matches!(error, Error::Addon(AddonError::Status(503))),
                "{error:?}"
            );
        }
        assert_eq!(hits.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn forgets_the_oldest_episodes() {
        let service = SkipTimesService::default();
        let empty = parse_segments(&json!({}), 1.0);
        for second in 0..=CACHE_ENTRIES {
            service.remember(query(1000.0 + second as f64), empty.clone());
        }
        assert!(service.cached(&query(1000.0)).is_none());
        assert!(service.cached(&query(1001.0)).is_some());
        let cache = service.cache.lock().unwrap();
        assert_eq!(
            (cache.entries.len(), cache.order.len()),
            (CACHE_ENTRIES, CACHE_ENTRIES)
        );
    }

    /// Live check against SkipDB: `cargo test -- --ignored skipdb`.
    /// Breaking Bad S2E4, from a release that runs 47:33.
    #[test]
    #[ignore = "uses the network"]
    fn finds_breaking_bad_on_skipdb() {
        let service = SkipTimesService::default();
        let times = tauri::async_runtime::block_on(service.lookup(&query(2853.0))).unwrap();
        let intro = times
            .segments
            .iter()
            .find(|segment| segment.kind == SkipKind::Intro)
            .expect("an intro");
        assert!(
            intro.start < 300.0 && intro.end - intro.start < 60.0,
            "{times:?}"
        );

        // A cut 33 s shorter does not match.
        let other = tauri::async_runtime::block_on(service.lookup(&query(2820.0))).unwrap();
        assert!(other.segments.is_empty(), "{other:?}");
        assert!(other.unmatched > 0);
        assert!(
            other
                .other_lengths
                .iter()
                .any(|length| (length - 2853.0).abs() < 1.0)
        );
    }

    /// Live: The Big Bang Theory S11E1 from a release 10 s longer than the
    /// one recorded (`cargo test -- --ignored skipdb`).
    #[test]
    #[ignore = "uses the network"]
    fn trims_skipdb_times_for_a_slightly_longer_cut() {
        let service = SkipTimesService::default();
        let query = EpisodeQuery::new("tt0898266", 11, 1, 1241.952).unwrap();
        let times = tauri::async_runtime::block_on(service.lookup(&query)).unwrap();
        let intro = times
            .segments
            .iter()
            .find(|segment| segment.kind == SkipKind::Intro)
            .expect("an intro");
        assert!(intro.offset > 5.0 && intro.offset < 15.0, "{times:?}");
        assert!(intro.end - intro.start >= 5.0, "{times:?}");
    }
}
