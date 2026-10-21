//! User preferences, persisted on-device.
//!
//! Stored as a small JSON file (`settings.json` in the config directory), like
//! the installed addons: a handful of values, read when the app starts and
//! written only when the user changes one. Keeping them in the core rather
//! than the webview's `localStorage` means they survive a change of the
//! renderer's origin (the dev server's port, `tauri://` in release builds)
//! and are validated here, at the boundary, like every other stored input.
//!
//! Reading is forgiving: a missing file gives the defaults, an invalid value
//! falls back to its default, and an unparseable file is moved aside (not
//! overwritten). Writing is strict: invalid settings are rejected.
//!
//! Writes go to a temporary file that is then renamed over the old one, so a
//! crash mid-write never leaves a truncated file behind.
//!
//! Format history: version 1 held the preferred languages and the first
//! stream preferences. Version 2 adds the rest of playback, subtitles and the
//! stream filters. Version 3 adds `rows`, the catalogue rows of Discover,
//! Movies and TV Shows. Nothing is converted: a field a file doesn't have reads as
//! its default, so an older file loads unchanged and is rewritten in the
//! current version the next time a setting is saved. Settings added without a
//! version change (such as General) read as their defaults the same way.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::core::error::{Error, Result};
use crate::media::passthrough::{self, PassthroughFormat};
use crate::media::{
    MAX_SUBTITLE_OFFSET, SUBTITLE_SIZES, SubtitleEdge, SubtitleStyle, is_hex_color,
};

mod rows;

pub use rows::{CatalogRow, MAX_LAYOUT_ROWS, RowSettings};

pub const FILE_NAME: &str = "settings.json";
const FORMAT_VERSION: u32 = 3;
/// Most languages that can be listed for audio or subtitles.
pub const MAX_LANGUAGES: usize = 8;
/// Maximum resolutions Play can be limited to, in vertical lines.
pub const MAX_RESOLUTIONS: [u32; 3] = [2160, 1080, 720];
/// Up next countdown lengths, in seconds.
pub const UP_NEXT_SECONDS: [u32; 5] = [5, 10, 15, 20, 30];
/// How far ←/→ and the skip buttons jump, in seconds.
pub const SEEK_SECONDS: [u32; 4] = [5, 10, 15, 30];
/// Loudest remembered volume, in percent (the player's `MAX_VOLUME`).
pub const MAX_VOLUME_PERCENT: u32 = 130;
/// The "mark as watched" threshold is kept within this range, in percent:
/// lower would mark half-watched videos, higher would miss the credits.
pub const WATCHED_PERCENT: std::ops::RangeInclusive<u32> = 70..=98;
/// Largest maximum file size, in GB.
pub const MAX_SIZE_GB: u32 = 500;
/// Most keywords that can be excluded, and their longest length.
pub const MAX_KEYWORDS: usize = 20;
pub const MAX_KEYWORD_CHARS: usize = 40;

/// All user preferences. Mirrored by `Settings` in
/// `apps/desktop/src/services/native.ts`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    #[serde(default)]
    pub general: GeneralSettings,
    pub playback: PlaybackSettings,
    #[serde(default)]
    pub subtitles: SubtitleSettings,
    #[serde(default)]
    pub streams: StreamSettings,
    #[serde(default)]
    pub rows: RowSettings,
}

/// The app as a whole: what it shares outside Kiro.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct GeneralSettings {
    /// Show what's playing on the user's Discord profile (`crate::presence`).
    /// Sends the title, episode and poster to the Discord app, so it is off
    /// unless chosen.
    pub discord_presence: bool,
    /// Off: Discord shows "Watching something on Kiro" instead of the title,
    /// episode and poster.
    pub discord_show_title: bool,
    /// The season and episode numbers, after the title.
    pub discord_show_episode: bool,
}

impl Default for GeneralSettings {
    fn default() -> Self {
        Self {
            discord_presence: false,
            discord_show_title: true,
            discord_show_episode: true,
        }
    }
}

impl GeneralSettings {
    /// Reads stored general settings field by field, as for playback.
    fn from_stored(value: &Value) -> Self {
        let defaults = Self::default();
        let flag =
            |key: &str, default: bool| value.get(key).and_then(Value::as_bool).unwrap_or(default);
        Self {
            discord_presence: flag("discordPresence", defaults.discord_presence),
            discord_show_title: flag("discordShowTitle", defaults.discord_show_title),
            discord_show_episode: flag("discordShowEpisode", defaults.discord_show_episode),
        }
    }
}

/// How the player behaves: which tracks it picks when a stream loads,
/// resuming, Up next, skipping and volume.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct PlaybackSettings {
    /// ISO 639 language codes (`en`, `ja`, `fil`), most preferred first.
    /// Empty: keep the stream's default track.
    pub audio_languages: Vec<String>,
    /// As `audio_languages`, for subtitles.
    pub subtitle_languages: Vec<String>,
    /// Start with subtitles off (forced subtitles still show).
    pub subtitles_off: bool,
    /// Skip intros and recaps marked by the file's chapters (or found online)
    /// without asking.
    pub skip_intros: bool,
    /// When a file's chapters mark nothing to skip, look up an episode's
    /// intro and credits on SkipDB. Sends the series' IMDb id, the season and
    /// episode number, and the file's duration, so it is off unless chosen.
    pub online_skip_times: bool,
    /// Play the next episode when Up next's countdown ends. Off: the card
    /// waits for Play now.
    pub autoplay_next: bool,
    /// Up next's countdown, one of [`UP_NEXT_SECONDS`].
    pub up_next_seconds: u32,
    /// How far ←/→ and the skip buttons jump, one of [`SEEK_SECONDS`].
    pub seek_seconds: u32,
    /// What to do with saved progress when a video is played again.
    pub resume: ResumeMode,
    /// Start each video at [`Self::volume`] instead of full volume.
    pub remember_volume: bool,
    /// The last volume set in the player, in percent (0 to
    /// [`MAX_VOLUME_PERCENT`]).
    pub volume: u32,
    /// Watched this much of a video (percent, within [`WATCHED_PERCENT`]):
    /// counted as finished. Applies to progress saved from then on.
    pub mark_watched_percent: u32,
    /// Keep the display awake (no screensaver or display sleep) while a
    /// video plays.
    pub keep_screen_on: bool,
    /// Send [`Self::passthrough_formats`] to an AV receiver untouched
    /// (`crate::media::passthrough`) instead of decoding them.
    pub audio_passthrough: bool,
    /// The formats passed through while [`Self::audio_passthrough`] is on:
    /// distinct, each supported on this platform, DTS-HD only with DTS.
    pub passthrough_formats: Vec<PassthroughFormat>,
}

impl Default for PlaybackSettings {
    fn default() -> Self {
        Self {
            audio_languages: Vec::new(),
            subtitle_languages: Vec::new(),
            subtitles_off: false,
            skip_intros: false,
            online_skip_times: false,
            autoplay_next: true,
            up_next_seconds: 10,
            seek_seconds: 10,
            resume: ResumeMode::Always,
            remember_volume: true,
            volume: 100,
            mark_watched_percent: 90,
            keep_screen_on: true,
            audio_passthrough: false,
            passthrough_formats: PassthroughFormat::DEFAULTS.to_vec(),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResumeMode {
    /// Resume where playback stopped, with a "Start over" notice.
    #[default]
    Always,
    /// Ask before starting.
    Ask,
    /// Always start from the beginning (progress is still saved).
    Never,
}

/// How subtitles look, and which kind of track is picked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct SubtitleSettings {
    /// Text size, percent of the player's default (see [`SubtitleStyle`]).
    pub size: u32,
    /// Text colour, `#rrggbb`.
    pub color: String,
    pub edge: SubtitleEdge,
    /// Raised above the usual position, percent of the picture's height.
    pub offset: u32,
    /// Which track to pick among those in the chosen language.
    pub preferred_type: SubtitleType,
}

impl Default for SubtitleSettings {
    fn default() -> Self {
        let style = SubtitleStyle::default();
        Self {
            size: style.size,
            color: style.color,
            edge: style.edge,
            offset: style.offset,
            preferred_type: SubtitleType::Regular,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SubtitleType {
    /// Full subtitles first, then SDH, then forced.
    #[default]
    Regular,
    /// Subtitles for the deaf and hard of hearing (SDH, CC) first.
    Sdh,
    /// Forced subtitles (signs and foreign dialogue only) first.
    Forced,
}

impl SubtitleSettings {
    /// The look, as the player applies it.
    pub fn style(&self) -> SubtitleStyle {
        SubtitleStyle {
            size: self.size,
            color: self.color.clone(),
            edge: self.edge,
            offset: self.offset,
        }
    }

    fn validate(&self) -> Result<()> {
        self.style().validate().map_err(Error::invalid_argument)
    }

    /// Reads stored subtitle settings field by field, as for playback.
    fn from_stored(value: &Value) -> Self {
        let defaults = Self::default();
        Self {
            size: number(value, "size")
                .filter(|size| SUBTITLE_SIZES.contains(size))
                .unwrap_or(defaults.size),
            color: value
                .get("color")
                .and_then(Value::as_str)
                .filter(|color| is_hex_color(color))
                .map_or(defaults.color, str::to_owned),
            edge: parsed(value, "edge").unwrap_or(defaults.edge),
            offset: number(value, "offset")
                .filter(|offset| *offset <= MAX_SUBTITLE_OFFSET)
                .unwrap_or(defaults.offset),
            preferred_type: parsed(value, "preferredType").unwrap_or(defaults.preferred_type),
        }
    }
}

/// How Play chooses a stream from the ones the addons list. Streams the
/// filters exclude are still listed (marked as filtered), never picked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct StreamSettings {
    /// Highest resolution picked when anything within it is available; one
    /// of [`MAX_RESOLUTIONS`].
    pub max_resolution: u32,
    /// Pick HDR and Dolby Vision versions first (SDR first when off).
    pub prefer_hdr: bool,
    /// Pick streams a debrid service already has ready first.
    pub prefer_cached: bool,
    /// Filter out cam, telesync and screener releases.
    pub exclude_cam: bool,
    /// Filter out files larger than this, in GB (1 to [`MAX_SIZE_GB`]).
    /// `None`: no limit.
    pub max_size_gb: Option<u32>,
    /// Filter out these video codecs (distinct).
    pub avoid_codecs: Vec<VideoCodec>,
    /// Filter out streams whose name or description has one of these as a
    /// whole word, ignoring case. Trimmed, distinct ignoring case, at most
    /// [`MAX_KEYWORDS`] of [`MAX_KEYWORD_CHARS`] characters.
    pub excluded_keywords: Vec<String>,
}

/// Codecs some displays and devices can't decode in hardware.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VideoCodec {
    Av1,
    Hevc,
}

impl Default for StreamSettings {
    fn default() -> Self {
        Self {
            max_resolution: 2160,
            prefer_hdr: true,
            prefer_cached: true,
            exclude_cam: false,
            max_size_gb: None,
            avoid_codecs: Vec::new(),
            excluded_keywords: Vec::new(),
        }
    }
}

impl StreamSettings {
    fn validate(&self) -> Result<()> {
        if !MAX_RESOLUTIONS.contains(&self.max_resolution) {
            return Err(Error::invalid_argument("Unsupported maximum resolution"));
        }
        if self
            .max_size_gb
            .is_some_and(|size| !(1..=MAX_SIZE_GB).contains(&size))
        {
            return Err(Error::invalid_argument(format!(
                "The maximum file size must be 1 to {MAX_SIZE_GB} GB"
            )));
        }
        if has_duplicates(&self.avoid_codecs) {
            return Err(Error::invalid_argument("Duplicate codec"));
        }
        if self.excluded_keywords.len() > MAX_KEYWORDS {
            return Err(Error::invalid_argument(format!(
                "At most {MAX_KEYWORDS} keywords can be excluded"
            )));
        }
        for (index, keyword) in self.excluded_keywords.iter().enumerate() {
            if !valid_keyword(keyword) {
                return Err(Error::invalid_argument("Invalid keyword"));
            }
            let lower = keyword.to_lowercase();
            if self.excluded_keywords[..index]
                .iter()
                .any(|earlier| earlier.to_lowercase() == lower)
            {
                return Err(Error::invalid_argument("Duplicate keyword"));
            }
        }
        Ok(())
    }

    /// Reads stored stream settings field by field, as for playback. Lists
    /// keep their valid entries.
    fn from_stored(value: &Value) -> Self {
        let defaults = Self::default();
        let flag =
            |key: &str, default: bool| value.get(key).and_then(Value::as_bool).unwrap_or(default);
        let list = |key: &str| {
            value
                .get(key)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        };

        let mut avoid_codecs = Vec::new();
        for codec in list("avoidCodecs") {
            if let Ok(codec) = serde_json::from_value::<VideoCodec>(codec)
                && !avoid_codecs.contains(&codec)
            {
                avoid_codecs.push(codec);
            }
        }
        let mut excluded_keywords: Vec<String> = Vec::new();
        for keyword in list("excludedKeywords") {
            if let Some(keyword) = keyword.as_str().filter(|keyword| valid_keyword(keyword))
                && !excluded_keywords
                    .iter()
                    .any(|earlier| earlier.to_lowercase() == keyword.to_lowercase())
            {
                excluded_keywords.push(keyword.to_owned());
            }
        }
        excluded_keywords.truncate(MAX_KEYWORDS);

        Self {
            max_resolution: number(value, "maxResolution")
                .filter(|resolution| MAX_RESOLUTIONS.contains(resolution))
                .unwrap_or(defaults.max_resolution),
            prefer_hdr: flag("preferHdr", defaults.prefer_hdr),
            prefer_cached: flag("preferCached", defaults.prefer_cached),
            exclude_cam: flag("excludeCam", defaults.exclude_cam),
            max_size_gb: number(value, "maxSizeGb").filter(|size| (1..=MAX_SIZE_GB).contains(size)),
            avoid_codecs,
            excluded_keywords,
        }
    }
}

/// A keyword as stored: trimmed, 1 to [`MAX_KEYWORD_CHARS`] characters, no
/// control characters.
fn valid_keyword(keyword: &str) -> bool {
    let length = keyword.chars().count();
    (1..=MAX_KEYWORD_CHARS).contains(&length)
        && keyword.trim() == keyword
        && !keyword.chars().any(char::is_control)
}

fn has_duplicates<T: PartialEq>(items: &[T]) -> bool {
    items
        .iter()
        .enumerate()
        .any(|(index, item)| items[..index].contains(item))
}

/// A stored value of type `T` (such as one of an enum's names).
fn parsed<T: serde::de::DeserializeOwned>(value: &Value, key: &str) -> Option<T> {
    value
        .get(key)
        .and_then(|stored| serde_json::from_value(stored.clone()).ok())
}

/// A stored whole number that fits a `u32`.
fn number(value: &Value, key: &str) -> Option<u32> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|number| u32::try_from(number).ok())
}

impl Settings {
    pub fn validate(&self) -> Result<()> {
        self.playback.validate()?;
        self.subtitles.validate()?;
        self.streams.validate()?;
        self.rows.validate()
    }
}

impl PlaybackSettings {
    fn validate(&self) -> Result<()> {
        validate_languages(&self.audio_languages, "audio")?;
        validate_languages(&self.subtitle_languages, "subtitle")?;
        if !UP_NEXT_SECONDS.contains(&self.up_next_seconds) {
            return Err(Error::invalid_argument("Unsupported Up next countdown"));
        }
        if !SEEK_SECONDS.contains(&self.seek_seconds) {
            return Err(Error::invalid_argument("Unsupported skip interval"));
        }
        if self.volume > MAX_VOLUME_PERCENT {
            return Err(Error::invalid_argument("Volume is out of range"));
        }
        if !WATCHED_PERCENT.contains(&self.mark_watched_percent) {
            return Err(Error::invalid_argument(format!(
                "Mark as watched must be between {}% and {}%",
                WATCHED_PERCENT.start(),
                WATCHED_PERCENT.end()
            )));
        }
        validate_passthrough_formats(&self.passthrough_formats)
    }

    /// mpv's `audio-spdif`: what is passed through, or empty to decode
    /// everything.
    pub fn audio_spdif(&self) -> String {
        passthrough::spdif_codecs(self.audio_passthrough, &self.passthrough_formats)
    }

    /// Watched this fraction of a video: finished. Clamped to
    /// [`WATCHED_PERCENT`] whatever is stored.
    pub fn completed_fraction(&self) -> f64 {
        let percent = self
            .mark_watched_percent
            .clamp(*WATCHED_PERCENT.start(), *WATCHED_PERCENT.end());
        f64::from(percent) / 100.0
    }

    /// Reads stored playback settings field by field, keeping the default for
    /// any field that is missing or invalid.
    fn from_stored(value: &Value) -> Self {
        let defaults = Self::default();
        let languages = |key: &str, kind: &str| {
            value
                .get(key)
                .and_then(|value| serde_json::from_value::<Vec<String>>(value.clone()).ok())
                .filter(|languages| validate_languages(languages, kind).is_ok())
                .unwrap_or_default()
        };
        let flag =
            |key: &str, default: bool| value.get(key).and_then(Value::as_bool).unwrap_or(default);
        let choice = |key: &str, choices: &[u32], default: u32| {
            number(value, key)
                .filter(|number| choices.contains(number))
                .unwrap_or(default)
        };
        Self {
            audio_languages: languages("audioLanguages", "audio"),
            subtitle_languages: languages("subtitleLanguages", "subtitle"),
            subtitles_off: flag("subtitlesOff", defaults.subtitles_off),
            skip_intros: flag("skipIntros", defaults.skip_intros),
            online_skip_times: flag("onlineSkipTimes", defaults.online_skip_times),
            autoplay_next: flag("autoplayNext", defaults.autoplay_next),
            up_next_seconds: choice("upNextSeconds", &UP_NEXT_SECONDS, defaults.up_next_seconds),
            seek_seconds: choice("seekSeconds", &SEEK_SECONDS, defaults.seek_seconds),
            resume: parsed(value, "resume").unwrap_or(defaults.resume),
            remember_volume: flag("rememberVolume", defaults.remember_volume),
            volume: number(value, "volume")
                .filter(|volume| *volume <= MAX_VOLUME_PERCENT)
                .unwrap_or(defaults.volume),
            mark_watched_percent: number(value, "markWatchedPercent")
                .filter(|percent| WATCHED_PERCENT.contains(percent))
                .unwrap_or(defaults.mark_watched_percent),
            keep_screen_on: flag("keepScreenOn", defaults.keep_screen_on),
            audio_passthrough: flag("audioPassthrough", defaults.audio_passthrough),
            passthrough_formats: value
                .get("passthroughFormats")
                .and_then(Value::as_array)
                .map_or(defaults.passthrough_formats, |stored| {
                    stored_passthrough_formats(stored)
                }),
        }
    }
}

/// Passthrough formats must be distinct and work on this platform, and
/// DTS-HD comes with DTS (mpv's `dts-hd` passes DTS cores through too, so
/// DTS-HD alone would say DTS is decoded when it isn't).
fn validate_passthrough_formats(formats: &[PassthroughFormat]) -> Result<()> {
    if has_duplicates(formats) {
        return Err(Error::invalid_argument("Duplicate passthrough format"));
    }
    if let Some(format) = formats.iter().find(|format| !format.is_supported()) {
        return Err(Error::invalid_argument(format!(
            "{} passthrough isn't available on {}",
            format.label(),
            os_name()
        )));
    }
    if formats.contains(&PassthroughFormat::DtsHd) && !formats.contains(&PassthroughFormat::Dts) {
        return Err(Error::invalid_argument(
            "DTS-HD passthrough needs DTS passthrough on",
        ));
    }
    Ok(())
}

/// Stored passthrough formats, keeping the valid ones: known, distinct,
/// supported here, and DTS-HD only with DTS.
fn stored_passthrough_formats(stored: &[Value]) -> Vec<PassthroughFormat> {
    let mut formats = Vec::new();
    for format in stored {
        if let Ok(format) = serde_json::from_value::<PassthroughFormat>(format.clone())
            && format.is_supported()
            && !formats.contains(&format)
        {
            formats.push(format);
        }
    }
    if !formats.contains(&PassthroughFormat::Dts) {
        formats.retain(|format| *format != PassthroughFormat::DtsHd);
    }
    formats
}

fn os_name() -> &'static str {
    match std::env::consts::OS {
        "macos" => "macOS",
        "windows" => "Windows",
        "linux" => "Linux",
        other => other,
    }
}

/// A language list must hold distinct ISO 639 codes: two or three lowercase
/// ASCII letters.
fn validate_languages(languages: &[String], kind: &str) -> Result<()> {
    if languages.len() > MAX_LANGUAGES {
        return Err(Error::invalid_argument(format!(
            "At most {MAX_LANGUAGES} {kind} languages can be chosen"
        )));
    }
    for (index, code) in languages.iter().enumerate() {
        let valid = (2..=3).contains(&code.len()) && code.bytes().all(|b| b.is_ascii_lowercase());
        if !valid {
            return Err(Error::invalid_argument(format!(
                "Invalid {kind} language code"
            )));
        }
        if languages[..index].contains(code) {
            return Err(Error::invalid_argument(format!(
                "Duplicate {kind} language"
            )));
        }
    }
    Ok(())
}

#[derive(Serialize)]
struct FileRef<'a> {
    version: u32,
    #[serde(flatten)]
    settings: &'a Settings,
}

/// The settings file. Serialises reads and writes, because commands run
/// concurrently.
#[derive(Debug)]
pub struct SettingsStore {
    path: PathBuf,
    lock: Mutex<()>,
}

impl SettingsStore {
    pub fn new(config_dir: &Path) -> Self {
        Self {
            path: config_dir.join(FILE_NAME),
            lock: Mutex::new(()),
        }
    }

    pub fn get(&self) -> Result<Settings> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        self.read()
    }

    /// Validates and stores `settings`, returning what was stored.
    pub fn set(&self, settings: Settings) -> Result<Settings> {
        settings.validate()?;
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        self.write(&settings)?;
        Ok(settings)
    }

    fn read(&self) -> Result<Settings> {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(Settings::default());
            }
            Err(error) => return Err(error.into()),
        };
        let file = match serde_json::from_slice::<Value>(&bytes) {
            Ok(file) if file.is_object() => file,
            _ => {
                fs::rename(&self.path, self.path.with_extension("json.corrupt"))?;
                return Ok(Settings::default());
            }
        };
        Ok(Settings {
            general: file
                .get("general")
                .map(GeneralSettings::from_stored)
                .unwrap_or_default(),
            playback: file
                .get("playback")
                .map(PlaybackSettings::from_stored)
                .unwrap_or_default(),
            subtitles: file
                .get("subtitles")
                .map(SubtitleSettings::from_stored)
                .unwrap_or_default(),
            streams: file
                .get("streams")
                .map(StreamSettings::from_stored)
                .unwrap_or_default(),
            rows: file
                .get("rows")
                .map(RowSettings::from_stored)
                .unwrap_or_default(),
        })
    }

    fn write(&self, settings: &Settings) -> Result<()> {
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        let json = serde_json::to_vec_pretty(&FileRef {
            version: FORMAT_VERSION,
            settings,
        })
        .map_err(io::Error::other)?;

        let temp = self.path.with_extension("json.tmp");
        let mut file = fs::File::create(&temp)?;
        file.write_all(&json)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, &self.path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use serde_json::json;

    use super::*;

    /// A fresh, empty directory under the system temp dir.
    fn temp_dir() -> PathBuf {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "kiro-settings-test-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn playback(audio: &[&str], subtitles: &[&str], subtitles_off: bool) -> Settings {
        Settings {
            playback: PlaybackSettings {
                audio_languages: audio.iter().map(|code| (*code).to_owned()).collect(),
                subtitle_languages: subtitles.iter().map(|code| (*code).to_owned()).collect(),
                subtitles_off,
                ..PlaybackSettings::default()
            },
            ..Settings::default()
        }
    }

    /// Every setting changed from its default.
    fn everything_changed() -> Settings {
        Settings {
            general: GeneralSettings {
                discord_presence: true,
                discord_show_title: false,
                discord_show_episode: false,
            },
            playback: PlaybackSettings {
                audio_languages: vec!["ja".into()],
                subtitle_languages: vec!["en".into(), "fr".into()],
                subtitles_off: true,
                autoplay_next: false,
                up_next_seconds: 30,
                seek_seconds: 5,
                resume: ResumeMode::Ask,
                remember_volume: false,
                volume: 45,
                mark_watched_percent: 80,
                skip_intros: true,
                online_skip_times: true,
                keep_screen_on: false,
                audio_passthrough: true,
                passthrough_formats: vec![PassthroughFormat::Dts],
            },
            subtitles: SubtitleSettings {
                size: 150,
                color: "#ffe45c".into(),
                edge: SubtitleEdge::Background,
                offset: 15,
                preferred_type: SubtitleType::Sdh,
            },
            streams: StreamSettings {
                max_resolution: 1080,
                prefer_hdr: false,
                prefer_cached: false,
                exclude_cam: true,
                max_size_gb: Some(20),
                avoid_codecs: vec![VideoCodec::Av1, VideoCodec::Hevc],
                excluded_keywords: vec!["YIFY".into(), "3D".into()],
            },
            rows: RowSettings {
                discover: Some(vec![CatalogRow {
                    addon: "community.anime.kitsu".into(),
                    kind: "anime".into(),
                    catalog: "kitsu-anime-airing".into(),
                    hidden: false,
                }]),
                movies: Some(Vec::new()),
                tv_shows: None,
            },
        }
    }

    #[test]
    fn defaults_until_something_is_saved() {
        let dir = temp_dir();
        let store = SettingsStore::new(&dir);
        assert_eq!(store.get().unwrap(), Settings::default());
        // Reading never creates the file.
        assert!(!dir.exists());
    }

    #[test]
    fn persists_settings() {
        let dir = temp_dir();
        let settings = playback(&["ja", "en"], &["en"], true);
        SettingsStore::new(&dir).set(settings.clone()).unwrap();
        assert_eq!(SettingsStore::new(&dir).get().unwrap(), settings);

        let stored: Value =
            serde_json::from_slice(&fs::read(dir.join(FILE_NAME)).unwrap()).unwrap();
        assert_eq!(stored["version"], FORMAT_VERSION);
        assert_eq!(stored["playback"]["audioLanguages"], json!(["ja", "en"]));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_invalid_settings() {
        let store = SettingsStore::new(&temp_dir());
        for settings in [
            playback(&["EN"], &[], false),
            playback(&["english"], &[], false),
            playback(&[""], &[], false),
            playback(&["en", "en"], &[], false),
            playback(&[], &["e1"], false),
            playback(
                &["aa", "ab", "ae", "af", "ak", "am", "an", "ar", "as"],
                &[],
                false,
            ),
        ] {
            let error = store.set(settings.clone()).unwrap_err();
            assert_eq!(error.code(), "INVALID_ARGUMENT", "{settings:?}");
        }
        assert_eq!(store.get().unwrap(), Settings::default());
    }

    #[test]
    fn persists_stream_settings() {
        let dir = temp_dir();
        let settings = Settings {
            streams: StreamSettings {
                max_resolution: 1080,
                prefer_hdr: false,
                prefer_cached: true,
                ..StreamSettings::default()
            },
            ..Settings::default()
        };
        SettingsStore::new(&dir).set(settings.clone()).unwrap();
        assert_eq!(SettingsStore::new(&dir).get().unwrap(), settings);
        let stored: Value =
            serde_json::from_slice(&fs::read(dir.join(FILE_NAME)).unwrap()).unwrap();
        assert_eq!(stored["streams"]["maxResolution"], 1080);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_an_unsupported_maximum_resolution() {
        let store = SettingsStore::new(&temp_dir());
        let settings = Settings {
            streams: StreamSettings {
                max_resolution: 1440,
                ..StreamSettings::default()
            },
            ..Settings::default()
        };
        assert_eq!(store.set(settings).unwrap_err().code(), "INVALID_ARGUMENT");
    }

    #[test]
    fn settings_saved_before_streams_existed_still_load() {
        let parsed = serde_json::from_value::<Settings>(json!({
            "playback": { "audioLanguages": [], "subtitleLanguages": [], "subtitlesOff": false }
        }))
        .unwrap();
        assert_eq!(parsed.streams, StreamSettings::default());
        assert!(!parsed.playback.skip_intros, "off unless chosen");
        assert!(!parsed.playback.online_skip_times, "off unless chosen");
        assert!(!parsed.general.discord_presence, "off unless chosen");
        assert!(parsed.general.discord_show_title);
        assert!(parsed.general.discord_show_episode);
    }

    #[test]
    fn persists_skipping_intros() {
        let dir = temp_dir();
        let mut settings = Settings::default();
        settings.playback.skip_intros = true;
        SettingsStore::new(&dir).set(settings.clone()).unwrap();
        assert_eq!(SettingsStore::new(&dir).get().unwrap(), settings);
        let stored: Value =
            serde_json::from_slice(&fs::read(dir.join(FILE_NAME)).unwrap()).unwrap();
        assert_eq!(stored["playback"]["skipIntros"], true);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn persists_looking_up_skip_times_online() {
        let dir = temp_dir();
        let mut settings = Settings::default();
        settings.playback.online_skip_times = true;
        SettingsStore::new(&dir).set(settings.clone()).unwrap();
        assert_eq!(SettingsStore::new(&dir).get().unwrap(), settings);
        let stored: Value =
            serde_json::from_slice(&fs::read(dir.join(FILE_NAME)).unwrap()).unwrap();
        assert_eq!(stored["playback"]["onlineSkipTimes"], true);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_fields_are_rejected_when_saving() {
        let parsed = serde_json::from_value::<Settings>(json!({
            "playback": { "audioLanguages": [], "subtitleLanguages": [], "subtitlesOff": false, "x": 1 }
        }));
        assert!(parsed.is_err());
    }

    #[test]
    fn invalid_stored_values_fall_back_to_their_defaults() {
        let dir = temp_dir();
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(FILE_NAME),
            json!({
                "version": 1,
                "playback": {
                    "audioLanguages": ["en", "EN!"],
                    "subtitleLanguages": ["fr"],
                    "subtitlesOff": "yes",
                },
                "streams": { "maxResolution": 999, "preferHdr": false, "preferCached": "no" },
            })
            .to_string(),
        )
        .unwrap();
        assert_eq!(
            SettingsStore::new(&dir).get().unwrap(),
            Settings {
                streams: StreamSettings {
                    prefer_hdr: false,
                    ..StreamSettings::default()
                },
                ..playback(&[], &["fr"], false)
            }
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn persists_every_setting() {
        let dir = temp_dir();
        let settings = everything_changed();
        SettingsStore::new(&dir).set(settings.clone()).unwrap();
        assert_eq!(SettingsStore::new(&dir).get().unwrap(), settings);

        let stored: Value =
            serde_json::from_slice(&fs::read(dir.join(FILE_NAME)).unwrap()).unwrap();
        assert_eq!(stored["version"], FORMAT_VERSION);
        assert_eq!(stored["general"]["discordPresence"], true);
        assert_eq!(stored["general"]["discordShowTitle"], false);
        assert_eq!(stored["playback"]["resume"], "ask");
        assert_eq!(stored["playback"]["markWatchedPercent"], 80);
        assert_eq!(stored["subtitles"]["edge"], "background");
        assert_eq!(stored["subtitles"]["preferredType"], "sdh");
        assert_eq!(stored["streams"]["avoidCodecs"], json!(["av1", "hevc"]));
        assert_eq!(stored["streams"]["maxSizeGb"], 20);
        assert_eq!(stored["playback"]["audioPassthrough"], true);
        assert_eq!(stored["playback"]["passthroughFormats"], json!(["dts"]));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn passthrough_is_off_with_the_formats_every_receiver_takes() {
        let playback = PlaybackSettings::default();
        assert!(!playback.audio_passthrough);
        assert_eq!(
            playback.passthrough_formats,
            [PassthroughFormat::Ac3, PassthroughFormat::Dts]
        );
        assert_eq!(playback.audio_spdif(), "");
    }

    #[test]
    fn passthrough_maps_to_mpvs_audio_spdif() {
        let mut playback = PlaybackSettings {
            audio_passthrough: true,
            ..PlaybackSettings::default()
        };
        assert_eq!(playback.audio_spdif(), "ac3,dts");
        playback.passthrough_formats = vec![PassthroughFormat::Dts];
        assert_eq!(playback.audio_spdif(), "dts");
        playback.passthrough_formats = Vec::new();
        assert_eq!(playback.audio_spdif(), "");
        if !cfg!(target_os = "macos") {
            playback.passthrough_formats = PassthroughFormat::ALL.to_vec();
            assert_eq!(playback.audio_spdif(), "ac3,eac3,dts,dts-hd,truehd");
            // Off: everything is decoded, whatever is chosen.
            playback.audio_passthrough = false;
            assert_eq!(playback.audio_spdif(), "");
        }
    }

    #[test]
    fn rejects_invalid_passthrough_formats() {
        use PassthroughFormat::*;
        let store = SettingsStore::new(&temp_dir());
        let with = |formats: &[PassthroughFormat]| Settings {
            playback: PlaybackSettings {
                audio_passthrough: true,
                passthrough_formats: formats.to_vec(),
                ..PlaybackSettings::default()
            },
            ..Settings::default()
        };
        let mut invalid = vec![with(&[Ac3, Ac3]), with(&[DtsHd]), with(&[Ac3, DtsHd])];
        if cfg!(target_os = "macos") {
            // Greyed out in Settings on a Mac.
            invalid.extend([with(&[Eac3]), with(&[TrueHd]), with(&[Dts, DtsHd])]);
        } else {
            store.set(with(&PassthroughFormat::ALL)).unwrap();
        }
        for settings in invalid {
            let error = store.set(settings.clone()).unwrap_err();
            assert_eq!(error.code(), "INVALID_ARGUMENT", "{settings:?}");
        }
        // Validated even while passthrough is off, so turning it on can't
        // pick up something invalid.
        let mut off = with(&[DtsHd]);
        off.playback.audio_passthrough = false;
        assert!(store.set(off).is_err());
        store.set(with(&[])).unwrap();
        store.set(with(&[Dts, Ac3])).unwrap();
    }

    #[test]
    fn stored_passthrough_formats_keep_the_valid_ones() {
        let dir = temp_dir();
        fs::create_dir_all(&dir).unwrap();
        let load = |formats: Value| {
            fs::write(
                dir.join(FILE_NAME),
                json!({
                    "version": 3,
                    "playback": { "audioPassthrough": true, "passthroughFormats": formats },
                })
                .to_string(),
            )
            .unwrap();
            let playback = SettingsStore::new(&dir).get().unwrap().playback;
            assert!(playback.audio_passthrough);
            playback.passthrough_formats
        };
        use PassthroughFormat::*;
        assert_eq!(load(json!(["dts", "mp3", 7, "dts", "ac3"])), [Dts, Ac3]);
        // DTS-HD needs DTS.
        assert_eq!(load(json!(["dtsHd", "ac3"])), [Ac3]);
        assert_eq!(load(json!([])), [] as [PassthroughFormat; 0]);
        // Not a list: the defaults.
        assert_eq!(load(json!("ac3")), PassthroughFormat::DEFAULTS);
        let all = load(json!(["ac3", "eac3", "dts", "dtsHd", "truehd"]));
        if cfg!(target_os = "macos") {
            // Saved on another platform, or by hand: what a Mac can't do is dropped.
            assert_eq!(all, [Ac3, Dts]);
        } else {
            assert_eq!(all, PassthroughFormat::ALL);
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_out_of_range_settings() {
        let store = SettingsStore::new(&temp_dir());
        let changed = |change: fn(&mut Settings)| {
            let mut settings = Settings::default();
            change(&mut settings);
            settings
        };
        for settings in [
            changed(|s| s.playback.up_next_seconds = 7),
            changed(|s| s.playback.seek_seconds = 0),
            changed(|s| s.playback.volume = 131),
            changed(|s| s.playback.mark_watched_percent = 69),
            changed(|s| s.playback.mark_watched_percent = 99),
            changed(|s| s.subtitles.size = 20),
            changed(|s| s.subtitles.color = "red".into()),
            changed(|s| s.subtitles.offset = 60),
            changed(|s| s.streams.max_size_gb = Some(0)),
            changed(|s| s.streams.max_size_gb = Some(501)),
            changed(|s| s.streams.avoid_codecs = vec![VideoCodec::Av1, VideoCodec::Av1]),
            changed(|s| s.streams.excluded_keywords = vec![" padded ".into()]),
            changed(|s| s.streams.excluded_keywords = vec![String::new()]),
            changed(|s| s.streams.excluded_keywords = vec!["a\nb".into()]),
            changed(|s| s.streams.excluded_keywords = vec!["x".repeat(41)]),
            changed(|s| s.streams.excluded_keywords = vec!["Cam".into(), "cAM".into()]),
            changed(|s| s.streams.excluded_keywords = (0..21).map(|i| i.to_string()).collect()),
        ] {
            let error = store.set(settings.clone()).unwrap_err();
            assert_eq!(error.code(), "INVALID_ARGUMENT", "{settings:?}");
        }
    }

    #[test]
    fn version_2_files_load_with_default_rows() {
        let dir = temp_dir();
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(FILE_NAME),
            json!({ "version": 2, "playback": { "volume": 60 } }).to_string(),
        )
        .unwrap();
        let loaded = SettingsStore::new(&dir).get().unwrap();
        assert_eq!(loaded.playback.volume, 60);
        assert_eq!(loaded.rows, RowSettings::default());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn persists_row_layouts() {
        let dir = temp_dir();
        let store = SettingsStore::new(&dir);
        store.set(everything_changed()).unwrap();
        let stored: Value =
            serde_json::from_slice(&fs::read(dir.join(FILE_NAME)).unwrap()).unwrap();
        assert_eq!(
            stored["rows"],
            json!({
                "discover": [{
                    "addon": "community.anime.kitsu",
                    "type": "anime",
                    "catalog": "kitsu-anime-airing",
                    "hidden": false,
                }],
                "movies": [],
                "tvShows": null,
            })
        );

        let invalid = Settings {
            rows: RowSettings {
                discover: Some(vec![CatalogRow {
                    addon: "not an id".into(),
                    kind: "movie".into(),
                    catalog: "top".into(),
                    hidden: false,
                }]),
                ..RowSettings::default()
            },
            ..Settings::default()
        };
        assert_eq!(store.set(invalid).unwrap_err().code(), "INVALID_ARGUMENT");
        assert_eq!(store.get().unwrap(), everything_changed());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_watched_threshold_is_clamped() {
        let mut playback = PlaybackSettings::default();
        assert!((playback.completed_fraction() - 0.9).abs() < 1e-9);
        playback.mark_watched_percent = 10;
        assert!((playback.completed_fraction() - 0.7).abs() < 1e-9);
        playback.mark_watched_percent = 100;
        assert!((playback.completed_fraction() - 0.98).abs() < 1e-9);
    }

    #[test]
    fn version_1_files_load_with_new_settings_at_their_defaults() {
        let dir = temp_dir();
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(FILE_NAME),
            json!({
                "version": 1,
                "playback": { "audioLanguages": ["ja"], "subtitleLanguages": ["en"], "subtitlesOff": false },
                "streams": { "maxResolution": 1080, "preferHdr": false, "preferCached": true },
            })
            .to_string(),
        )
        .unwrap();
        let store = SettingsStore::new(&dir);
        let loaded = store.get().unwrap();
        assert_eq!(
            loaded,
            Settings {
                streams: StreamSettings {
                    max_resolution: 1080,
                    prefer_hdr: false,
                    ..StreamSettings::default()
                },
                ..playback(&["ja"], &["en"], false)
            }
        );

        // Saving rewrites it in the current format.
        store.set(loaded).unwrap();
        let stored: Value =
            serde_json::from_slice(&fs::read(dir.join(FILE_NAME)).unwrap()).unwrap();
        assert_eq!(stored["version"], FORMAT_VERSION);
        assert_eq!(stored["playback"]["markWatchedPercent"], 90);
        assert_eq!(stored["subtitles"]["color"], "#ffffff");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn invalid_new_stored_values_fall_back_to_their_defaults() {
        let dir = temp_dir();
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(FILE_NAME),
            json!({
                "version": 2,
                "playback": {
                    "autoplayNext": false,
                    "upNextSeconds": 12,
                    "seekSeconds": 30,
                    "resume": "sometimes",
                    "volume": 400,
                    "markWatchedPercent": 50,
                    "keepScreenOn": "no",
                },
                "general": { "discordPresence": "yes", "discordShowTitle": false },
                "subtitles": { "size": 150, "color": "yellow", "edge": "glow", "offset": 99 },
                "streams": {
                    "excludeCam": true,
                    "maxSizeGb": -3,
                    "avoidCodecs": ["av1", "av1", "mpeg2", "hevc"],
                    "excludedKeywords": ["YIFY", " bad ", "yify", 4, "HC"],
                },
            })
            .to_string(),
        )
        .unwrap();
        let loaded = SettingsStore::new(&dir).get().unwrap();
        assert_eq!(
            loaded.general,
            GeneralSettings {
                discord_show_title: false,
                ..GeneralSettings::default()
            }
        );
        assert_eq!(
            loaded.playback,
            PlaybackSettings {
                autoplay_next: false,
                seek_seconds: 30,
                ..PlaybackSettings::default()
            }
        );
        assert_eq!(
            loaded.subtitles,
            SubtitleSettings {
                size: 150,
                ..SubtitleSettings::default()
            }
        );
        assert_eq!(
            loaded.streams,
            StreamSettings {
                exclude_cam: true,
                avoid_codecs: vec![VideoCodec::Av1, VideoCodec::Hevc],
                excluded_keywords: vec!["YIFY".into(), "HC".into()],
                ..StreamSettings::default()
            }
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_subtitle_fields_are_rejected_when_saving() {
        let mut value = serde_json::to_value(Settings::default()).unwrap();
        value["subtitles"]["font"] = json!("Comic Sans");
        assert!(serde_json::from_value::<Settings>(value).is_err());
    }

    #[test]
    fn an_unparseable_file_is_moved_aside() {
        let dir = temp_dir();
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(FILE_NAME), b"{ not json").unwrap();
        assert_eq!(SettingsStore::new(&dir).get().unwrap(), Settings::default());
        assert!(dir.join("settings.json.corrupt").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
