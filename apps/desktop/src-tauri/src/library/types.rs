//! Library records and their validated parts.
//!
//! Inputs deserialize via `try_from`, so a command taking them rejects invalid
//! input before the handler runs. Values read back from the database were
//! validated when written and are not checked again.
//!
//! Mirrored in `apps/desktop/src/services/native.ts`.

use serde::{Deserialize, Serialize};
use url::Url;

use crate::core::error::Error;

// Type and id limits match addon resource requests (`addons::transport`) and
// `@kiro/addon-sdk`, so anything an addon can describe can be saved.
const MAX_TYPE_LENGTH: usize = 64;
const MAX_ID_LENGTH: usize = 512;
const MAX_NAME_CHARS: usize = 300;
const MAX_URL_LENGTH: usize = 2048;
/// A week: longer "durations" are not real videos.
pub const MAX_DURATION_SECONDS: f64 = 7.0 * 24.0 * 3600.0;
/// Most videos one mark can cover: a whole long-running series.
pub const MAX_MARKED_VIDEOS: usize = 5_000;

/// An addon content type such as `movie` or `series`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String")]
pub struct MediaType(String);

impl MediaType {
    pub fn parse(value: &str) -> Result<Self, Error> {
        // Used as a path segment of the title page's route.
        let valid = !value.is_empty()
            && value.len() <= MAX_TYPE_LENGTH
            && !matches!(value, "." | "..")
            && !value.chars().any(|c| c.is_control() || c == '/');
        if valid {
            Ok(Self(value.to_owned()))
        } else {
            Err(Error::invalid_argument("Invalid media type"))
        }
    }

    pub(super) fn from_db(value: String) -> Self {
        Self(value)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for MediaType {
    type Error = Error;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(&value)
    }
}

/// An addon-assigned title or video id (e.g. `tt0111161`, `tt0944947:1:2`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String")]
pub struct MediaId(String);

impl MediaId {
    pub fn parse(value: &str) -> Result<Self, Error> {
        let valid = !value.is_empty() && value.len() <= MAX_ID_LENGTH;
        if valid {
            Ok(Self(value.to_owned()))
        } else {
            Err(Error::invalid_argument("Invalid media id"))
        }
    }

    pub(super) fn from_db(value: String) -> Self {
        Self(value)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for MediaId {
    type Error = Error;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(&value)
    }
}

/// A display name from addon metadata. Runs of whitespace and control
/// characters become one space, and overlong names are truncated.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String")]
pub struct DisplayName(String);

impl DisplayName {
    pub fn parse(value: &str) -> Result<Self, Error> {
        let normalized = value
            .split(|c: char| c.is_whitespace() || c.is_control())
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        if normalized.is_empty() {
            return Err(Error::invalid_argument("Name must not be empty"));
        }
        Ok(Self(normalized.chars().take(MAX_NAME_CHARS).collect()))
    }

    pub(super) fn from_db(value: String) -> Self {
        Self(value)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for DisplayName {
    type Error = Error;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(&value)
    }
}

/// An https artwork URL without credentials (the only kind the app's CSP
/// loads).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String")]
pub struct PosterUrl(String);

impl PosterUrl {
    pub fn parse(value: &str) -> Result<Self, Error> {
        let valid = value.len() <= MAX_URL_LENGTH
            && Url::parse(value).is_ok_and(|url| {
                url.scheme() == "https"
                    && url.host().is_some()
                    && url.username().is_empty()
                    && url.password().is_none()
            });
        if valid {
            Ok(Self(value.to_owned()))
        } else {
            Err(Error::invalid_argument("Poster must be an https URL"))
        }
    }

    pub(super) fn from_db(value: String) -> Self {
        Self(value)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for PosterUrl {
    type Error = Error;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(&value)
    }
}

/// What the library remembers about a title, so it can be shown without
/// fetching its metadata again.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TitleSnapshot {
    pub r#type: MediaType,
    pub id: MediaId,
    pub name: DisplayName,
    #[serde(default)]
    pub poster: Option<PosterUrl>,
}

/// The video that was played: the movie itself (`id` equals the title's id)
/// or one episode of a series.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoSnapshot {
    pub id: MediaId,
    #[serde(default)]
    pub season: Option<u32>,
    #[serde(default)]
    pub episode: Option<u32>,
    /// The episode's title.
    #[serde(default)]
    pub name: Option<DisplayName>,
}

/// A progress report from the player. `position` is clamped to `duration`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(try_from = "RawPlaybackProgress")]
pub struct PlaybackProgress {
    pub title: TitleSnapshot,
    pub video: VideoSnapshot,
    /// Seconds from the start.
    pub position: f64,
    /// Seconds.
    pub duration: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPlaybackProgress {
    title: TitleSnapshot,
    video: VideoSnapshot,
    position: f64,
    duration: f64,
}

impl TryFrom<RawPlaybackProgress> for PlaybackProgress {
    type Error = Error;

    fn try_from(raw: RawPlaybackProgress) -> Result<Self, Self::Error> {
        if !(raw.duration.is_finite() && raw.duration > 0.0 && raw.duration <= MAX_DURATION_SECONDS)
        {
            return Err(Error::invalid_argument("Invalid duration"));
        }
        if !(raw.position.is_finite() && raw.position >= 0.0) {
            return Err(Error::invalid_argument("Invalid position"));
        }
        Ok(Self {
            title: raw.title,
            video: raw.video,
            position: raw.position.min(raw.duration),
            duration: raw.duration,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchlistItem {
    pub title: TitleSnapshot,
    /// Unix milliseconds.
    pub added_at: i64,
}

/// Saved progress for one video.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub title: TitleSnapshot,
    pub video: VideoSnapshot,
    pub position: f64,
    pub duration: f64,
    /// Watched far enough to count as finished.
    pub completed: bool,
    /// Unix milliseconds.
    pub updated_at: i64,
}

/// A recently watched title: its latest video, and how many of its videos
/// have been played (a series' episodes).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryTitle {
    #[serde(flatten)]
    pub latest: HistoryEntry,
    pub played_videos: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TitleLibraryState {
    pub in_watchlist: bool,
    /// Every played video of the title, most recent first.
    pub progress: Vec<HistoryEntry>,
}

/// Videos to mark as watched, in the order they were watched (a season's
/// episodes in order): at least one, at most [`MAX_MARKED_VIDEOS`], each once.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(try_from = "Vec<VideoSnapshot>")]
pub struct WatchedVideos(Vec<VideoSnapshot>);

impl WatchedVideos {
    pub fn as_slice(&self) -> &[VideoSnapshot] {
        &self.0
    }
}

impl TryFrom<Vec<VideoSnapshot>> for WatchedVideos {
    type Error = Error;

    fn try_from(videos: Vec<VideoSnapshot>) -> Result<Self, Self::Error> {
        check_marked(videos.iter().map(|video| &video.id))?;
        Ok(Self(videos))
    }
}

/// Videos of one title to mark as unwatched: at least one, at most
/// [`MAX_MARKED_VIDEOS`], each once.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(try_from = "Vec<MediaId>")]
pub struct VideoIds(Vec<MediaId>);

impl VideoIds {
    pub fn as_slice(&self) -> &[MediaId] {
        &self.0
    }
}

impl TryFrom<Vec<MediaId>> for VideoIds {
    type Error = Error;

    fn try_from(ids: Vec<MediaId>) -> Result<Self, Self::Error> {
        check_marked(ids.iter())?;
        Ok(Self(ids))
    }
}

fn check_marked<'a>(ids: impl ExactSizeIterator<Item = &'a MediaId>) -> Result<(), Error> {
    if ids.len() == 0 || ids.len() > MAX_MARKED_VIDEOS {
        return Err(Error::invalid_argument(format!(
            "Mark between 1 and {MAX_MARKED_VIDEOS} videos"
        )));
    }
    let mut seen = std::collections::HashSet::new();
    for id in ids {
        if !seen.insert(id.as_str()) {
            return Err(Error::invalid_argument("A video is listed twice"));
        }
    }
    Ok(())
}

/// A title, without its display data.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TitleRef {
    pub r#type: MediaType,
    pub id: MediaId,
}

/// What an import ([`super::Library::import_watchlist`],
/// [`super::Library::import_history`]) did with each entry.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCounts {
    /// New to Kiro.
    pub added: u32,
    /// Replaced older progress for the same video.
    pub updated: u32,
    /// Kiro already had it, or had newer progress.
    pub skipped: u32,
    /// Could not be added (a full watchlist).
    pub failed: u32,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn validates_media_types_and_ids() {
        for valid in ["movie", "series", "tv_channel", "série", "Other 1"] {
            assert!(MediaType::parse(valid).is_ok(), "{valid}");
        }
        for invalid in ["", "..", "a/b", "movie\n", &"a".repeat(MAX_TYPE_LENGTH + 1)] {
            assert!(MediaType::parse(invalid).is_err(), "{invalid:?}");
        }

        assert!(MediaId::parse("tt0944947:1:2").is_ok());
        assert!(MediaId::parse("kitsu:1 2").is_ok());
        for invalid in ["", &"a".repeat(MAX_ID_LENGTH + 1)] {
            assert!(MediaId::parse(invalid).is_err(), "{invalid:?}");
        }
    }

    #[test]
    fn normalizes_display_names() {
        assert_eq!(
            DisplayName::parse("  The\n\tShow ").unwrap().as_str(),
            "The Show"
        );
        assert!(DisplayName::parse(" \n ").is_err());
        let long = DisplayName::parse(&"é".repeat(MAX_NAME_CHARS * 2)).unwrap();
        assert_eq!(long.as_str().chars().count(), MAX_NAME_CHARS);
    }

    #[test]
    fn accepts_only_https_posters() {
        assert!(PosterUrl::parse("https://img.example/p.jpg").is_ok());
        for invalid in [
            "http://img.example/p.jpg",
            "data:image/png;base64,AAAA",
            "https://user:pw@img.example/p.jpg",
            "not a url",
        ] {
            assert!(PosterUrl::parse(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn validates_progress_while_deserializing() {
        let progress = |position: serde_json::Value, duration: serde_json::Value| {
            serde_json::from_value::<PlaybackProgress>(json!({
                "title": { "type": "movie", "id": "tt1", "name": "Movie" },
                "video": { "id": "tt1" },
                "position": position,
                "duration": duration,
            }))
        };

        assert_eq!(progress(json!(10), json!(100)).unwrap().position, 10.0);
        assert_eq!(progress(json!(150), json!(100)).unwrap().position, 100.0);
        assert!(progress(json!(-1), json!(100)).is_err());
        assert!(progress(json!(1), json!(0)).is_err());
        assert!(progress(json!(1), json!(1e9)).is_err());
        assert!(progress(json!("1"), json!(100)).is_err());

        let bad_title = serde_json::from_value::<PlaybackProgress>(json!({
            "title": { "type": "movie", "id": "tt1", "name": "Movie", "poster": "http://x/y.jpg" },
            "video": { "id": "tt1" },
            "position": 1,
            "duration": 100,
        }));
        assert!(bad_title.is_err());
    }

    #[test]
    fn validates_marked_videos_while_deserializing() {
        let videos = |ids: Vec<String>| {
            let list: Vec<_> = ids.iter().map(|id| json!({ "id": id })).collect();
            serde_json::from_value::<WatchedVideos>(json!(list))
        };
        let ids = |ids: Vec<String>| serde_json::from_value::<VideoIds>(json!(ids));
        let numbered = |count: usize| (0..count).map(|n| format!("tt1:1:{n}")).collect();

        assert_eq!(videos(numbered(3)).unwrap().as_slice().len(), 3);
        assert_eq!(
            ids(numbered(MAX_MARKED_VIDEOS)).unwrap().as_slice().len(),
            MAX_MARKED_VIDEOS
        );
        for invalid in [
            vec![],
            numbered(MAX_MARKED_VIDEOS + 1),
            vec!["tt1:1:1".into(), "tt1:1:1".into()],
            vec![String::new()],
        ] {
            assert!(videos(invalid.clone()).is_err(), "{}", invalid.len());
            assert!(ids(invalid).is_err());
        }
        let bad_name =
            serde_json::from_value::<WatchedVideos>(json!([{ "id": "tt1", "name": " " }]));
        assert!(bad_name.is_err());
    }
}
