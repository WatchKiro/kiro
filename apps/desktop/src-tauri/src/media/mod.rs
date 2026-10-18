//! Native media playback.
//!
//! Kiro's native player is built on libmpv (hardware decoding, 4K/HDR, MKV,
//! multiple audio/subtitle tracks, accurate seeking, network streams).
//!
//! The contract mirrors `MediaPlayer` in `@kiro/player-core`: the renderer's
//! `NativePlayer` translates each method into a Tauri command backed by a
//! [`PlaybackBackend`], and receives backend events ([`model::PlayerEvent`])
//! over a Tauri channel. Video is rendered natively, never decoded in the
//! webview.
//!
//! [`mpv`] is the libmpv backend (macOS, Windows and Linux), compiled only with the
//! `libmpv` Cargo feature. See `docs/playback.md`.

pub mod keep_awake;
pub mod model;
#[cfg(native_player)]
pub mod mpv;

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use url::Url;

/// Media to load, mirroring `MediaSource` in `@kiro/player-core`.
#[derive(Debug, Clone)]
pub enum MediaSource {
    Network {
        url: Url,
        headers: Vec<(String, String)>,
    },
    Local {
        path: PathBuf,
    },
}

/// Subtitle file loaded alongside the media, mirroring `ExternalSubtitle`.
#[derive(Debug, Clone)]
pub struct ExternalSubtitle {
    pub url: Url,
    pub label: Option<String>,
    /// ISO 639 code or BCP 47 tag.
    pub language: Option<String>,
}

/// How subtitles look (Settings → Subtitles), applied through mpv's `sub-*`
/// properties. Mirrors `SubtitleStyle` in `apps/desktop/src/services/player.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubtitleStyle {
    /// Text size as a percentage of the player's default, within
    /// [`SUBTITLE_SIZES`].
    pub size: u32,
    /// Text colour, `#rrggbb` (lowercase).
    pub color: String,
    pub edge: SubtitleEdge,
    /// How far above the usual bottom position, as a percentage of the
    /// picture's height, at most [`MAX_SUBTITLE_OFFSET`].
    pub offset: u32,
}

/// What sets the text apart from the picture.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SubtitleEdge {
    Outline,
    Shadow,
    Background,
}

/// Smallest and largest subtitle size, in percent.
pub const SUBTITLE_SIZES: std::ops::RangeInclusive<u32> = 50..=200;
/// Highest subtitles can be raised, in percent of the picture's height.
pub const MAX_SUBTITLE_OFFSET: u32 = 40;

impl Default for SubtitleStyle {
    fn default() -> Self {
        Self {
            size: 100,
            color: "#ffffff".into(),
            edge: SubtitleEdge::Outline,
            offset: 0,
        }
    }
}

impl SubtitleStyle {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !SUBTITLE_SIZES.contains(&self.size) {
            return Err("Unsupported subtitle size");
        }
        if !is_hex_color(&self.color) {
            return Err("Subtitle colour must look like #rrggbb");
        }
        if self.offset > MAX_SUBTITLE_OFFSET {
            return Err("Subtitles can't be raised that far");
        }
        Ok(())
    }

    /// The mpv properties that give this look, in the order to set them.
    /// Colours are `#rrggbb` or `#aarrggbb`. Styled (ASS) subtitles keep their
    /// own look apart from the size (mpv's default `sub-ass-override=scale`).
    pub fn mpv_properties(&self) -> Vec<(&'static str, String)> {
        let (border_style, outline_size, outline_color, shadow_offset, back_color) = match self.edge
        {
            SubtitleEdge::Outline => ("outline-and-shadow", "2.5", "#000000", "0", "#00000000"),
            SubtitleEdge::Shadow => ("outline-and-shadow", "0.6", "#000000", "2.5", "#c0000000"),
            // One box behind the whole block. The outline size pads it, and is
            // transparent so the glyphs get no outline of their own.
            SubtitleEdge::Background => ("background-box", "6", "#00000000", "0", "#b3000000"),
        };
        vec![
            ("sub-scale", format!("{:.2}", f64::from(self.size) / 100.0)),
            ("sub-color", self.color.clone()),
            ("sub-border-style", border_style.into()),
            ("sub-outline-size", outline_size.into()),
            ("sub-outline-color", outline_color.into()),
            ("sub-shadow-offset", shadow_offset.into()),
            ("sub-back-color", back_color.into()),
            (
                "sub-pos",
                (100 - self.offset.min(MAX_SUBTITLE_OFFSET)).to_string(),
            ),
        ]
    }
}

/// `#rrggbb` in lowercase hex.
pub fn is_hex_color(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value[1..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Furthest subtitles can be shifted, in seconds either way (mpv `sub-delay`).
pub const MAX_SUBTITLE_DELAY: f64 = 60.0;
/// Furthest audio can be shifted, in seconds either way (mpv `audio-delay`).
pub const MAX_AUDIO_DELAY: f64 = 10.0;
/// Slowest and fastest playback speed (mpv `speed`), where `1.0` is normal.
pub const SPEEDS: std::ops::RangeInclusive<f64> = 0.25..=4.0;

/// Validates a subtitle delay from the renderer: positive shows subtitles
/// later. Out-of-range values are clamped to ±[`MAX_SUBTITLE_DELAY`].
pub fn subtitle_delay(seconds: f64) -> Result<f64, &'static str> {
    if !seconds.is_finite() {
        return Err("Subtitle delay must be a number");
    }
    Ok(seconds.clamp(-MAX_SUBTITLE_DELAY, MAX_SUBTITLE_DELAY))
}

/// Validates an audio delay from the renderer: positive plays the audio
/// later. Out-of-range values are clamped to ±[`MAX_AUDIO_DELAY`].
pub fn audio_delay(seconds: f64) -> Result<f64, &'static str> {
    if !seconds.is_finite() {
        return Err("Audio delay must be a number");
    }
    Ok(seconds.clamp(-MAX_AUDIO_DELAY, MAX_AUDIO_DELAY))
}

/// Validates a playback speed from the renderer, clamped to [`SPEEDS`].
pub fn playback_speed(speed: f64) -> Result<f64, &'static str> {
    if !speed.is_finite() {
        return Err("Speed must be a number");
    }
    Ok(speed.clamp(*SPEEDS.start(), *SPEEDS.end()))
}

/// Longest URL accepted for streams and subtitles.
const MAX_URL_LEN: usize = 8 * 1024;

/// Parses a stream URL from the renderer: http(s) only. Local files will need
/// a separate, path-validated command.
pub fn parse_stream_url(url: &str) -> Result<Url, &'static str> {
    if url.len() > MAX_URL_LEN {
        return Err("The URL is too long");
    }
    let url = Url::parse(url).map_err(|_| "Not a valid URL")?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Only http(s) streams are supported");
    }
    Ok(url)
}

/// Validates a track id from the renderer: mpv's ids are small positive integers.
pub fn parse_track_id(id: &str) -> Result<&str, &'static str> {
    let valid = (1..=6).contains(&id.len())
        && id.bytes().all(|b| b.is_ascii_digit())
        && !id.starts_with('0');
    if valid {
        Ok(id)
    } else {
        Err("Not a valid track id")
    }
}

impl ExternalSubtitle {
    /// Validates a subtitle from the renderer: https only, a short printable
    /// label and a BCP 47-shaped language tag.
    pub fn parse(
        url: &str,
        label: Option<String>,
        language: Option<String>,
    ) -> Result<Self, &'static str> {
        if url.len() > MAX_URL_LEN {
            return Err("The URL is too long");
        }
        let url = Url::parse(url).map_err(|_| "Not a valid URL")?;
        if url.scheme() != "https" {
            return Err("Subtitles must be loaded over https");
        }
        let label = label.map(|l| l.trim().to_owned()).filter(|l| !l.is_empty());
        if label
            .as_ref()
            .is_some_and(|l| l.chars().count() > 200 || l.chars().any(char::is_control))
        {
            return Err("The subtitle label is invalid");
        }
        let language = language.filter(|l| !l.is_empty());
        if language.as_ref().is_some_and(|l| {
            l.len() > 35 || !l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        }) {
            return Err("The subtitle language is invalid");
        }
        Ok(Self {
            url,
            label,
            language,
        })
    }
}

/// Errors from a [`PlaybackBackend`]. Messages are shown to the user.
#[derive(Debug, thiserror::Error)]
pub enum PlaybackError {
    #[error("The player is not ready")]
    NotAttached,
    #[error("Nothing is playing")]
    NotLoaded,
    #[error("That track is not available")]
    TrackNotFound,
    #[error("This source is not supported: {0}")]
    UnsupportedSource(String),
    #[error("{0}")]
    Backend(String),
}

impl PlaybackError {
    /// Error code for the renderer, mapped onto `PlayerErrorCode` by `NativePlayer`.
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotAttached => "PLAYER_NOT_ATTACHED",
            Self::NotLoaded => "NOT_LOADED",
            Self::TrackNotFound => "TRACK_NOT_FOUND",
            Self::UnsupportedSource(_) => "UNSUPPORTED_SOURCE",
            Self::Backend(_) => "PLAYBACK_ERROR",
        }
    }
}

/// A native playback engine instance.
///
/// Methods take `&self` because engines such as libmpv are internally
/// synchronised and are driven from multiple command threads. Resources are
/// released on `Drop`.
pub trait PlaybackBackend: Send + Sync {
    /// Opens `source`, starting at `start_position` seconds when given.
    fn load(&self, source: &MediaSource, start_position: Option<f64>) -> Result<(), PlaybackError>;
    fn play(&self) -> Result<(), PlaybackError>;
    fn pause(&self) -> Result<(), PlaybackError>;
    /// Seek to an absolute position in seconds.
    fn seek(&self, seconds: f64) -> Result<(), PlaybackError>;
    /// Volume where `1.0` is unity gain; values above `1.0` amplify.
    fn set_volume(&self, volume: f64) -> Result<(), PlaybackError>;
    fn set_muted(&self, muted: bool) -> Result<(), PlaybackError>;
    /// Current position in seconds.
    fn position(&self) -> Result<f64, PlaybackError>;
    /// Tracks of the loaded media, embedded and external.
    fn tracks(&self) -> Vec<model::MediaTrack>;
    fn select_audio_track(&self, id: &str) -> Result<(), PlaybackError>;
    /// `None` disables subtitles.
    fn select_subtitle_track(&self, id: Option<&str>) -> Result<(), PlaybackError>;
    /// Loads and selects a subtitle file, returning its track.
    fn add_external_subtitle(
        &self,
        subtitle: &ExternalSubtitle,
    ) -> Result<model::MediaTrack, PlaybackError>;
    /// Changes how subtitles look, for this and later media.
    fn set_subtitle_style(&self, style: &SubtitleStyle) -> Result<(), PlaybackError>;
    /// Shows subtitles `seconds` later (earlier when negative). Kept for
    /// later media too, until changed.
    fn set_subtitle_delay(&self, seconds: f64) -> Result<(), PlaybackError>;
    /// Plays the audio `seconds` later (earlier when negative). Kept for
    /// later media too, until changed.
    fn set_audio_delay(&self, seconds: f64) -> Result<(), PlaybackError>;
    /// Playback speed, where `1.0` is normal. Kept for later media too.
    fn set_speed(&self, speed: f64) -> Result<(), PlaybackError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_urls_must_be_http() {
        assert!(parse_stream_url("https://cdn.example/film.mkv").is_ok());
        assert!(parse_stream_url("http://127.0.0.1:8080/film.mkv").is_ok());
        for url in [
            "file:///etc/passwd",
            "av://lavfi:testsrc",
            "/tmp/film.mkv",
            "",
        ] {
            assert!(parse_stream_url(url).is_err(), "{url}");
        }
        let long = format!("https://cdn.example/{}", "a".repeat(MAX_URL_LEN));
        assert!(parse_stream_url(&long).is_err());
    }

    #[test]
    fn track_ids_are_small_positive_integers() {
        assert_eq!(parse_track_id("1"), Ok("1"));
        assert_eq!(parse_track_id("42"), Ok("42"));
        for id in ["", "0", "01", "-1", "1.5", "no", "auto", "1234567", "1 2"] {
            assert!(parse_track_id(id).is_err(), "{id}");
        }
    }

    #[test]
    fn delays_and_speed_are_validated_and_clamped() {
        assert_eq!(subtitle_delay(0.3), Ok(0.3));
        assert_eq!(subtitle_delay(-2.5), Ok(-2.5));
        assert_eq!(subtitle_delay(90.0), Ok(MAX_SUBTITLE_DELAY));
        assert_eq!(subtitle_delay(-1e9), Ok(-MAX_SUBTITLE_DELAY));
        assert_eq!(audio_delay(-0.2), Ok(-0.2));
        assert_eq!(audio_delay(11.0), Ok(MAX_AUDIO_DELAY));
        assert_eq!(audio_delay(-11.0), Ok(-MAX_AUDIO_DELAY));
        assert_eq!(playback_speed(1.25), Ok(1.25));
        assert_eq!(playback_speed(0.0), Ok(0.25));
        assert_eq!(playback_speed(-3.0), Ok(0.25));
        assert_eq!(playback_speed(16.0), Ok(4.0));
        for invalid in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert!(subtitle_delay(invalid).is_err());
            assert!(audio_delay(invalid).is_err());
            assert!(playback_speed(invalid).is_err());
        }
    }

    #[test]
    fn subtitle_styles_are_validated() {
        assert!(SubtitleStyle::default().validate().is_ok());
        let style = |size, color: &str, offset| SubtitleStyle {
            size,
            color: color.into(),
            edge: SubtitleEdge::Background,
            offset,
        };
        assert!(style(50, "#ffe45c", 40).validate().is_ok());
        assert!(style(200, "#000000", 0).validate().is_ok());
        for invalid in [
            style(49, "#ffffff", 0),
            style(201, "#ffffff", 0),
            style(100, "#FFFFFF", 0),
            style(100, "#fff", 0),
            style(100, "white", 0),
            style(100, "#ffffff;", 0),
            style(100, "#ffffff", 41),
        ] {
            assert!(invalid.validate().is_err(), "{invalid:?}");
        }
    }

    #[test]
    fn subtitle_styles_map_to_mpv_properties() {
        let properties = SubtitleStyle {
            size: 125,
            color: "#ffe45c".into(),
            edge: SubtitleEdge::Background,
            offset: 10,
        }
        .mpv_properties();
        let get = |name: &str| {
            properties
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| value.as_str())
        };
        assert_eq!(get("sub-scale"), Some("1.25"));
        assert_eq!(get("sub-color"), Some("#ffe45c"));
        assert_eq!(get("sub-border-style"), Some("background-box"));
        assert_eq!(get("sub-pos"), Some("90"));

        let outline = SubtitleStyle::default().mpv_properties();
        assert!(outline.contains(&("sub-border-style", "outline-and-shadow".into())));
        assert!(outline.contains(&("sub-pos", "100".into())));
    }

    #[test]
    fn subtitle_styles_reject_unknown_fields() {
        let parsed = serde_json::from_value::<SubtitleStyle>(serde_json::json!({
            "size": 100, "color": "#ffffff", "edge": "outline", "offset": 0, "font": "x"
        }));
        assert!(parsed.is_err());
        let parsed = serde_json::from_value::<SubtitleStyle>(serde_json::json!({
            "size": 100, "color": "#ffffff", "edge": "glow", "offset": 0
        }));
        assert!(parsed.is_err());
    }

    #[test]
    fn external_subtitles_are_validated() {
        let subtitle = ExternalSubtitle::parse(
            "https://subs.example/film.en.srt",
            Some("  English  ".into()),
            Some("en-GB".into()),
        )
        .unwrap();
        assert_eq!(subtitle.label.as_deref(), Some("English"));
        assert_eq!(subtitle.language.as_deref(), Some("en-GB"));

        let blank = ExternalSubtitle::parse(
            "https://s.example/a.vtt",
            Some(" ".into()),
            Some(String::new()),
        )
        .unwrap();
        assert_eq!((blank.label, blank.language), (None, None));

        assert!(ExternalSubtitle::parse("http://subs.example/a.srt", None, None).is_err());
        assert!(ExternalSubtitle::parse("file:///tmp/a.srt", None, None).is_err());
        assert!(
            ExternalSubtitle::parse("https://s.example/a.srt", Some("a\nb".into()), None).is_err()
        );
        assert!(
            ExternalSubtitle::parse("https://s.example/a.srt", None, Some("en;rm".into())).is_err()
        );
    }
}
