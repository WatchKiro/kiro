//! Reading Stremio's addon collection and library items, and mapping them to
//! Kiro's addons and library.
//!
//! Everything here is untrusted input. Fields are read one at a time and an
//! odd one only costs that field (or, when it is essential, that item), so a
//! change on Stremio's side degrades the import instead of failing it. Values
//! that reach Kiro's library pass the same validation as the renderer's own
//! saves ([`MediaType`], [`DisplayName`], [`PosterUrl`], …).
//!
//! Library item shape (`stremio-core`'s `LibraryItem`), abridged:
//!
//! ```json
//! { "_id": "tt0903747", "type": "series", "name": "…", "poster": "https://…",
//!   "removed": false, "temp": false,
//!   "_ctime": "2023-01-14T19:20:31.441Z", "_mtime": "2024-02-10T21:03:12.004Z",
//!   "state": { "lastWatched": "2024-02-10T21:03:11.998Z",
//!              "timeOffset": 1320456, "duration": 2820000,
//!              "video_id": "tt0903747:5:16", "timesWatched": 0,
//!              "flaggedWatched": 0, … } }
//! ```
//!
//! Times are milliseconds. `removed` items were taken out of the library;
//! `temp` items were watched without being added to it.

use serde::Serialize;
use serde_json::{Map, Value};

use crate::addons::registry::{InstalledAddon, MAX_ADDONS};
use crate::addons::{AddonUrl, is_loopback};
use crate::library::{
    DisplayName, HistoryEntry, MAX_DURATION_SECONDS, MIN_RESUME_SECONDS, MediaId, MediaType,
    PosterUrl, TitleSnapshot, VideoSnapshot, WatchlistItem,
};

/// More library items than anyone has; the rest are ignored.
pub const MAX_LIBRARY_ITEMS: usize = 20_000;

/// An addon in the user's Stremio collection, and whether Kiro can add it.
///
/// Mirrored by `StremioAddon` in `apps/desktop/src/services/native.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StremioAddon {
    pub transport_url: String,
    pub name: String,
    pub status: AddonStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AddonStatus {
    /// Not installed in Kiro: the import installs it.
    New,
    /// Kiro has it already (the same manifest URL).
    Installed,
    /// Kiro can't use it: not https, or Stremio's own local server.
    Unsupported,
}

/// The addons in an `addonCollectionGet` result, in Stremio's order, without
/// duplicates.
pub fn read_addons(collection: &Value, installed: &[InstalledAddon]) -> Vec<StremioAddon> {
    let descriptors = collection
        .get("addons")
        .or(Some(collection))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let mut addons: Vec<StremioAddon> = Vec::new();
    for descriptor in descriptors.iter().take(MAX_ADDONS * 2) {
        let Some(raw_url) = descriptor.get("transportUrl").and_then(Value::as_str) else {
            continue;
        };
        if raw_url.is_empty() || addons.iter().any(|addon| addon.transport_url == raw_url) {
            continue;
        }
        let url = AddonUrl::parse(raw_url)
            .ok()
            .filter(|url| !is_loopback(url.as_url()));
        let status = match &url {
            None => AddonStatus::Unsupported,
            Some(url) if installed.iter().any(|addon| &addon.transport_url == url) => {
                AddonStatus::Installed
            }
            Some(_) => AddonStatus::New,
        };
        let manifest = descriptor.get("manifest");
        let name = [
            manifest.and_then(|manifest| manifest.get("name")),
            manifest.and_then(|manifest| manifest.get("id")),
        ]
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .find_map(|name| DisplayName::parse(name).ok())
        .map(|name| name.as_str().to_owned())
        .or_else(|| {
            url.as_ref()
                .and_then(|url| url.as_url().host_str().map(str::to_owned))
        })
        .unwrap_or_else(|| "Unnamed addon".to_owned());
        addons.push(StremioAddon {
            // Kiro's normalised form, so the renderer installs exactly what
            // was checked here.
            transport_url: url.map_or_else(|| truncate(raw_url, 2048), |url| url.to_string()),
            name,
            status,
        });
    }
    addons
}

/// What a Stremio library maps to in Kiro.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct LibraryImport {
    /// Titles in the user's Stremio library, saved for later.
    pub watchlist: Vec<WatchlistItem>,
    /// Watch progress, one entry per title (Stremio keeps the latest video).
    pub progress: Vec<HistoryEntry>,
    /// Items that could not be read, or that Kiro has no use for.
    pub skipped: u32,
}

impl LibraryImport {
    /// Progress that "Continue watching" offers to resume.
    pub fn in_progress(&self) -> usize {
        self.progress
            .iter()
            .filter(|entry| !entry.completed && entry.position >= MIN_RESUME_SECONDS)
            .count()
    }
}

/// Maps a `datastoreGet` result. `completed_fraction` is the user's "Mark as
/// watched at" setting: imported progress counts as finished by the same rule
/// as progress saved by Kiro's player.
pub fn read_library(items: &Value, completed_fraction: f64) -> LibraryImport {
    let mut import = LibraryImport::default();
    let items = items.as_array().map(Vec::as_slice).unwrap_or_default();
    for item in items.iter().take(MAX_LIBRARY_ITEMS) {
        match read_item(item, completed_fraction) {
            Some(Mapped {
                watchlist,
                progress,
            }) => {
                let title_seen = |title: &TitleSnapshot, other: &TitleSnapshot| {
                    title.r#type == other.r#type && title.id == other.id
                };
                if let Some(entry) = watchlist
                    && !import
                        .watchlist
                        .iter()
                        .any(|item| title_seen(&item.title, &entry.title))
                {
                    import.watchlist.push(entry);
                }
                if let Some(entry) = progress
                    && !import
                        .progress
                        .iter()
                        .any(|other| title_seen(&other.title, &entry.title))
                {
                    import.progress.push(entry);
                }
            }
            None => import.skipped += 1,
        }
    }
    import
}

struct Mapped {
    watchlist: Option<WatchlistItem>,
    progress: Option<HistoryEntry>,
}

/// One library item. `None` when it can't be read, was removed from the
/// library, or carries nothing to import.
fn read_item(item: &Value, completed_fraction: f64) -> Option<Mapped> {
    let item = item.as_object()?;
    let r#type = MediaType::parse(str_field(item, "type")?).ok()?;
    // Stremio's catch-all type (e.g. a pasted URL): nothing to show for it.
    if r#type.as_str() == "other" {
        return None;
    }
    let id = MediaId::parse(str_field(item, "_id")?).ok()?;
    let name = DisplayName::parse(str_field(item, "name")?).ok()?;
    let poster = str_field(item, "poster").and_then(|poster| PosterUrl::parse(poster).ok());
    let removed = bool_field(item, "removed");
    let temp = bool_field(item, "temp");
    // Taken out of the library (and not merely watched): Stremio hides it,
    // progress and all.
    if removed && !temp {
        return None;
    }
    let created = item.get("_ctime").and_then(read_time);
    let modified = item.get("_mtime").and_then(read_time);
    let title = TitleSnapshot {
        r#type,
        id,
        name,
        poster,
    };

    let watchlist = (!removed && !temp).then(|| WatchlistItem {
        title: title.clone(),
        added_at: created.or(modified).unwrap_or(0),
    });
    let progress = item
        .get("state")
        .and_then(Value::as_object)
        .and_then(|state| read_progress(&title, state, modified, completed_fraction));

    if watchlist.is_none() && progress.is_none() {
        return None;
    }
    Some(Mapped {
        watchlist,
        progress,
    })
}

/// The item's latest video and how far into it the user got.
fn read_progress(
    title: &TitleSnapshot,
    state: &Map<String, Value>,
    modified: Option<i64>,
    completed_fraction: f64,
) -> Option<HistoryEntry> {
    let duration = number_field(state, "duration")? / 1000.0;
    if !(duration.is_finite() && duration > 0.0 && duration <= MAX_DURATION_SECONDS) {
        return None;
    }
    let offset = number_field(state, "timeOffset").unwrap_or(0.0) / 1000.0;
    let finished = number_field(state, "timesWatched").is_some_and(|times| times > 0.0)
        || number_field(state, "flaggedWatched").is_some_and(|flag| flag > 0.0);
    let position = if offset.is_finite() && offset > 0.0 {
        offset.min(duration)
    } else if finished {
        // Stremio rewinds a finished video to the start; Kiro keeps it at the end.
        duration
    } else {
        return None;
    };

    let video_id = str_field(state, "video_id")
        .filter(|video| !video.is_empty())
        .or_else(|| (title.r#type.as_str() == "movie").then_some(title.id.as_str()))?;
    let video_id = MediaId::parse(video_id).ok()?;
    let (season, episode) = episode_numbers(title, &video_id);
    let updated_at = state.get("lastWatched").and_then(read_time).or(modified)?;

    Some(HistoryEntry {
        title: title.clone(),
        video: VideoSnapshot {
            id: video_id,
            season,
            episode,
            name: None,
        },
        position,
        duration,
        completed: position >= duration * completed_fraction,
        updated_at,
    })
}

/// `tt0903747:5:16` → season 5, episode 16 (for the series `tt0903747`).
fn episode_numbers(title: &TitleSnapshot, video: &MediaId) -> (Option<u32>, Option<u32>) {
    if title.r#type.as_str() != "series" {
        return (None, None);
    }
    let numbers = video
        .as_str()
        .strip_prefix(title.id.as_str())
        .and_then(|rest| rest.strip_prefix(':'))
        .and_then(|rest| rest.split_once(':'))
        .and_then(|(season, episode)| Some((season.parse().ok()?, episode.parse().ok()?)));
    match numbers {
        Some((season, episode)) => (Some(season), Some(episode)),
        None => (None, None),
    }
}

fn str_field<'a>(object: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    object.get(key).and_then(Value::as_str)
}

fn bool_field(object: &Map<String, Value>, key: &str) -> bool {
    object.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn number_field(object: &Map<String, Value>, key: &str) -> Option<f64> {
    object
        .get(key)
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite())
}

fn truncate(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

/// A time as Unix milliseconds: an RFC 3339 string (what Stremio sends) or a
/// number of milliseconds. Times before 2000 are Stremio's "never" (the epoch)
/// or nonsense.
fn read_time(value: &Value) -> Option<i64> {
    const YEAR_2000: i64 = 946_684_800_000;
    let millis = match value {
        Value::String(text) => parse_rfc3339(text)?,
        Value::Number(number) => number.as_f64().filter(|n| n.is_finite())? as i64,
        _ => return None,
    };
    (millis >= YEAR_2000).then_some(millis)
}

/// `2024-02-10T21:03:11.998Z` or with an offset (`+01:00`) → Unix ms.
fn parse_rfc3339(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    let digits = |range: std::ops::Range<usize>| -> Option<i64> {
        let part = text.get(range)?;
        (!part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
            .then(|| part.parse().ok())
            .flatten()
    };
    if bytes.len() < 20
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !matches!(bytes[10], b'T' | b't' | b' ')
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    let (year, month, day) = (digits(0..4)?, digits(5..7)?, digits(8..10)?);
    let (hour, minute, second) = (digits(11..13)?, digits(14..16)?, digits(17..19)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 {
        return None;
    }
    if second > 60 {
        return None;
    }

    let mut rest = &text[19..];
    let mut millis = 0;
    if let Some(fraction) = rest.strip_prefix('.') {
        let length = fraction.bytes().take_while(u8::is_ascii_digit).count();
        if length == 0 {
            return None;
        }
        let padded = format!("{:0<3}", &fraction[..length.min(3)]);
        millis = padded.parse::<i64>().ok()?;
        rest = &fraction[length..];
    }
    let offset_minutes = match rest {
        "Z" | "z" => 0,
        _ if rest.len() == 6 && rest.as_bytes()[3] == b':' => {
            let sign = match rest.as_bytes()[0] {
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            let hours: i64 = rest[1..3].parse().ok()?;
            let minutes: i64 = rest[4..6].parse().ok()?;
            sign * (hours * 60 + minutes)
        }
        _ => return None,
    };

    let days = days_from_civil(year, month, day);
    let seconds = days * 86_400 + hour * 3_600 + minute * 60 + second - offset_minutes * 60;
    Some(seconds * 1_000 + millis)
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's
/// `days_from_civil`).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month_index = (month + 9) % 12;
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::addons::defaults::default_addons;
    use crate::library::COMPLETED_FRACTION;

    fn fixture(name: &str) -> Value {
        let text = match name {
            "addon-collection" => include_str!("fixtures/addon-collection.json"),
            "library" => include_str!("fixtures/library.json"),
            _ => unreachable!(),
        };
        let envelope: Value = serde_json::from_str(text).unwrap();
        envelope["result"].clone()
    }

    #[test]
    fn parses_rfc3339_times() {
        assert_eq!(parse_rfc3339("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            parse_rfc3339("2024-02-10T21:03:11.998Z"),
            Some(1_707_598_991_998)
        );
        assert_eq!(
            parse_rfc3339("2024-02-10T22:03:11.9+01:00"),
            Some(1_707_598_991_900)
        );
        assert_eq!(
            parse_rfc3339("2000-03-01T00:00:00.123456Z"),
            Some(951_868_800_123)
        );
        for bad in [
            "",
            "2024-02-10",
            "2024-13-10T00:00:00Z",
            "2024-02-10T21:03:11",
            "2024-02-10T21:03:11.Z",
            "2024-02-10T21:03:11+0100",
            "２０２４-02-10T21:03:11Z",
        ] {
            assert_eq!(parse_rfc3339(bad), None, "{bad:?}");
        }
        // The epoch is Stremio's "never".
        assert_eq!(read_time(&json!("1970-01-01T00:00:00.000Z")), None);
        assert_eq!(
            read_time(&json!(1_707_598_991_998_i64)),
            Some(1_707_598_991_998)
        );
    }

    #[test]
    fn reads_the_recorded_addon_collection() {
        let addons = read_addons(&fixture("addon-collection"), &default_addons());
        let summary: Vec<_> = addons
            .iter()
            .map(|addon| (addon.name.as_str(), addon.status))
            .collect();
        assert_eq!(
            summary,
            [
                ("Cinemeta", AddonStatus::Installed),
                ("Local Files", AddonStatus::Unsupported),
                ("WatchHub", AddonStatus::New),
                ("OpenSubtitles v3", AddonStatus::Installed),
                ("Example Streams", AddonStatus::New),
                ("org.example.unnamed", AddonStatus::New),
                ("Insecure Addon", AddonStatus::Unsupported),
            ]
        );
        // Configured addons keep their configuration (it's in the URL).
        assert_eq!(
            addons[4].transport_url,
            "https://streams.example.org/eyJyZWdpb24iOiJ1ayJ9/manifest.json"
        );
    }

    #[test]
    fn tolerates_odd_addon_collections() {
        assert!(read_addons(&json!(null), &[]).is_empty());
        assert!(read_addons(&json!({ "addons": "nope" }), &[]).is_empty());
        let addons = read_addons(
            &json!([
                { "transportUrl": "https://a.example/manifest.json" },
                { "transportUrl": "https://a.example/manifest.json", "manifest": { "name": "Dup" } },
                { "manifest": { "name": "No URL" } },
                { "transportUrl": "javascript:alert(1)", "manifest": { "name": "  " } },
                42,
            ]),
            &[],
        );
        let summary: Vec<_> = addons
            .iter()
            .map(|addon| (addon.name.as_str(), addon.status))
            .collect();
        assert_eq!(
            summary,
            [
                ("a.example", AddonStatus::New),
                ("Unnamed addon", AddonStatus::Unsupported),
            ]
        );
    }

    #[test]
    fn maps_the_recorded_library() {
        let import = read_library(&fixture("library"), COMPLETED_FRACTION);

        let watchlist: Vec<_> = import
            .watchlist
            .iter()
            .map(|item| (item.title.r#type.as_str(), item.title.id.as_str()))
            .collect();
        assert_eq!(
            watchlist,
            [
                ("movie", "tt0000001"),
                ("series", "tt0000002"),
                ("movie", "tt0000003"),
                ("series", "tt0000004"),
                ("movie", "tt0000007"),
            ]
        );
        // Added when Stremio created the item.
        assert_eq!(import.watchlist[0].added_at, 1_673_724_031_441);
        // An http poster is dropped, the item kept.
        assert!(import.watchlist[2].title.poster.is_none());

        let progress: Vec<_> = import
            .progress
            .iter()
            .map(|entry| {
                (
                    entry.video.id.as_str(),
                    entry.video.season,
                    entry.video.episode,
                    entry.position,
                    entry.duration,
                    entry.completed,
                )
            })
            .collect();
        assert_eq!(
            progress,
            [
                // A film half watched.
                ("tt0000001", None, None, 3120.456, 8520.0, false),
                // A series, part way into its latest episode.
                ("tt0000002:5:16", Some(5), Some(16), 1320.456, 2820.0, false),
                // A film Stremio counts as watched (rewound to 0): finished.
                ("tt0000003", None, None, 7200.0, 7200.0, true),
                // Watched without being added to the library (temp).
                ("tt0000005:1:2", Some(1), Some(2), 600.0, 1500.0, false),
                // Within the last 10%: finished by Kiro's rule.
                ("tt0000007", None, None, 5700.0, 6000.0, true),
            ]
        );
        assert_eq!(import.progress[0].updated_at, 1_707_598_991_998);
        assert_eq!(import.in_progress(), 3);
        // Removed, type "other", missing name, unknown-progress-only, garbage.
        assert_eq!(import.skipped, 5);
    }

    #[test]
    fn completion_follows_the_users_threshold() {
        let item = json!([{
            "_id": "tt1", "type": "movie", "name": "Film",
            "_mtime": "2024-01-01T00:00:00Z",
            "state": { "timeOffset": 850_000, "duration": 1_000_000, "lastWatched": "2024-01-01T00:00:00Z" },
        }]);
        assert!(!read_library(&item, 0.9).progress[0].completed);
        assert!(read_library(&item, 0.8).progress[0].completed);
    }

    #[test]
    fn tolerates_odd_library_items() {
        assert_eq!(
            read_library(&json!({ "not": "a list" }), 0.9),
            LibraryImport::default()
        );
        let import = read_library(
            &json!([
                // Strings where numbers belong, a negative offset, a huge duration.
                { "_id": "tt1", "type": "movie", "name": "A", "state": { "timeOffset": "5", "duration": "9" } },
                { "_id": "tt2", "type": "movie", "name": "B", "_mtime": "2024-01-01T00:00:00Z",
                  "state": { "timeOffset": -5, "duration": 9000, "lastWatched": "2024-01-01T00:00:00Z" } },
                { "_id": "tt3", "type": "movie", "name": "C", "_mtime": "2024-01-01T00:00:00Z",
                  "state": { "timeOffset": 5000, "duration": 1e15 } },
                // No time at all: nothing to order its progress by.
                { "_id": "tt4", "type": "series", "name": "D", "temp": true,
                  "state": { "timeOffset": 5000, "duration": 9000, "video_id": "tt4:1:1" } },
                // A series without a video id can't be resumed.
                { "_id": "tt5", "type": "series", "name": "E", "temp": true, "_mtime": "2024-01-01T00:00:00Z",
                  "state": { "timeOffset": 5000, "duration": 9000 } },
                // Odd episode ids are kept, without numbers.
                { "_id": "kitsu:1", "type": "series", "name": "F", "removed": true, "temp": true,
                  "_mtime": "2024-01-01T00:00:00Z",
                  "state": { "timeOffset": 5000, "duration": 9000, "video_id": "kitsu:1:7" } },
                // A duplicate of the first.
                { "_id": "tt1", "type": "movie", "name": "A again" },
            ]),
            0.9,
        );
        let watchlist: Vec<_> = import
            .watchlist
            .iter()
            .map(|item| item.title.name.as_str())
            .collect();
        assert_eq!(watchlist, ["A", "B", "C"]);
        let progress: Vec<_> = import
            .progress
            .iter()
            .map(|entry| {
                (
                    entry.video.id.as_str(),
                    entry.video.season,
                    entry.video.episode,
                )
            })
            .collect();
        assert_eq!(progress, [("kitsu:1:7", None, None)]);
        // tt4 and tt5 carry nothing usable (temp items aren't on the watchlist).
        assert_eq!(import.skipped, 2);
    }
}
