//! Backend-independent player state, and the events the renderer receives.
//!
//! A playback engine feeds raw [`Change`]s (property updates and lifecycle
//! notifications) into [`PlayerModel::apply`], which keeps the current state
//! and returns the [`PlayerEvent`]s to forward. The event shapes mirror
//! `PlayerEventMap` in `@kiro/player-core`, so the renderer's `NativePlayer`
//! can re-emit them unchanged.
//!
//! Kept free of libmpv types so it compiles (and is tested) in every build.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// Minimum interval between `timeUpdate` events while playing. mpv reports
/// `time-pos` on every frame; the UI only needs a few updates per second.
pub const TIME_UPDATE_INTERVAL: Duration = Duration::from_millis(250);

/// Upper bound for volume, where `1.0` is unity gain (mpv's `volume-max=130`).
pub const MAX_VOLUME: f64 = 1.3;

/// Most chapters reported for one file. Chapter metadata comes from the file
/// itself, so its size is bounded like any other untrusted input.
pub const MAX_CHAPTERS: usize = 256;
/// Chapter titles longer than this (in characters) are cut short.
pub const MAX_CHAPTER_TITLE_CHARS: usize = 120;
/// A `chapter-list` larger than this is ignored rather than parsed.
const MAX_CHAPTER_LIST_BYTES: usize = 256 * 1024;

/// Mirrors `PlaybackState` in `@kiro/player-core`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PlaybackState {
    Idle,
    Loading,
    Ready,
    Playing,
    Paused,
    Ended,
    Error,
}

/// Mirrors `TrackKind` in `@kiro/player-core`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TrackKind {
    Video,
    Audio,
    Subtitle,
}

/// Mirrors `MediaTrack` in `@kiro/player-core`. `id` is mpv's track id, which
/// is unique per kind (audio 1 and subtitle 1 can both exist).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaTrack {
    pub id: String,
    pub kind: TrackKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codec: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channels: Option<u32>,
    pub is_default: bool,
    pub is_forced: bool,
    pub is_external: bool,
    /// Not part of `MediaTrack` in player-core (selection arrives through
    /// `trackSelect`), but handy for the snapshot and for logs.
    #[serde(skip)]
    pub selected: bool,
    /// For external tracks, the file they were loaded from.
    #[serde(skip)]
    pub external_url: Option<String>,
}

/// Mirrors `Chapter` in `@kiro/player-core`: where a chapter of the loaded
/// file starts, and its title as the file names it (untrusted).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Chapter {
    /// Seconds from the start of the file.
    pub start: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// Mirrors `PlayerErrorCode` (the subset a backend reports asynchronously).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum FailureCode {
    UnsupportedSource,
    Network,
    Decode,
    Unknown,
}

/// A playback failure, serialised like `PlayerError` (`{ code, message, recoverable }`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PlayerFailure {
    pub code: FailureCode,
    pub message: String,
    pub recoverable: bool,
}

/// One entry of `PlayerEventMap`: `{ "event": <name>, "payload": <payload> }`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "event", content = "payload", rename_all = "camelCase")]
pub enum PlayerEvent {
    StateChange {
        state: PlaybackState,
    },
    TimeUpdate {
        position: f64,
        duration: Option<f64>,
    },
    Buffering {
        buffering: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        progress: Option<f64>,
    },
    TracksChange {
        tracks: Vec<MediaTrack>,
    },
    ChaptersChange {
        chapters: Vec<Chapter>,
    },
    #[serde(rename_all = "camelCase")]
    TrackSelect {
        kind: TrackKind,
        track_id: Option<String>,
    },
    VolumeChange {
        volume: f64,
        muted: bool,
    },
    /// Not part of `PlayerEventMap` in player-core: the native player's
    /// subtitle and audio delays (seconds) and speed (`1.0` is normal).
    #[serde(rename_all = "camelCase")]
    TimingChange {
        subtitle_delay: f64,
        audio_delay: f64,
        speed: f64,
    },
    Error {
        error: PlayerFailure,
    },
    Ended {},
}

/// The full state, returned when the renderer attaches so it can start from
/// the truth rather than wait for the next change of every property.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerSnapshot {
    pub state: PlaybackState,
    pub position: f64,
    pub duration: Option<f64>,
    pub buffering: bool,
    pub tracks: Vec<MediaTrack>,
    pub chapters: Vec<Chapter>,
    pub audio_track_id: Option<String>,
    pub subtitle_track_id: Option<String>,
    pub volume: f64,
    pub muted: bool,
    pub max_volume: f64,
    /// Seconds subtitles are shown later (earlier when negative).
    pub subtitle_delay: f64,
    /// Seconds the audio plays later (earlier when negative).
    pub audio_delay: f64,
    /// Playback speed, where `1.0` is normal.
    pub speed: f64,
}

/// A raw update from the playback engine.
#[derive(Debug, Clone, PartialEq)]
pub enum Change {
    /// A new file started loading (also sent when one replaces another).
    StartFile,
    /// The file was opened and its tracks are known.
    FileLoaded,
    /// Playback restarted after loading or seeking.
    PlaybackRestart,
    /// The file stopped because of an error.
    Failed(PlayerFailure),
    Idle(bool),
    Paused(bool),
    EofReached(bool),
    Position(Option<f64>),
    Duration(Option<f64>),
    PausedForCache(bool),
    /// Percentage (0–100) of the cache target filled while buffering.
    CacheBufferingState(i64),
    /// mpv's `track-list`, as JSON.
    TrackList(String),
    /// mpv's `chapter-list`, as JSON.
    ChapterList(String),
    /// mpv volume, 0–130.
    Volume(f64),
    Muted(bool),
    /// mpv `sub-delay`, in seconds.
    SubtitleDelay(f64),
    /// mpv `audio-delay`, in seconds.
    AudioDelay(f64),
    /// mpv `speed`.
    Speed(f64),
}

#[derive(Debug)]
pub struct PlayerModel {
    state: PlaybackState,
    idle: bool,
    loading: bool,
    /// A file is open (between `FileLoaded` and its end, a failure or idling).
    loaded: bool,
    paused: bool,
    eof: bool,
    failed: bool,
    position: Option<f64>,
    duration: Option<f64>,
    buffering: bool,
    cache_percent: Option<i64>,
    tracks: Vec<MediaTrack>,
    chapters: Vec<Chapter>,
    audio: Option<String>,
    subtitle: Option<String>,
    volume: f64,
    muted: bool,
    subtitle_delay: f64,
    audio_delay: f64,
    speed: f64,
    /// When the last `timeUpdate` went out, and whether one is being held back.
    last_time_update: Option<Instant>,
    time_pending: bool,
}

impl Default for PlayerModel {
    fn default() -> Self {
        Self {
            state: PlaybackState::Idle,
            idle: true,
            loading: false,
            loaded: false,
            paused: false,
            eof: false,
            failed: false,
            position: None,
            duration: None,
            buffering: false,
            cache_percent: None,
            tracks: Vec::new(),
            chapters: Vec::new(),
            audio: None,
            subtitle: None,
            volume: 1.0,
            muted: false,
            subtitle_delay: 0.0,
            audio_delay: 0.0,
            speed: 1.0,
            last_time_update: None,
            time_pending: false,
        }
    }
}

impl PlayerModel {
    pub fn state(&self) -> PlaybackState {
        self.state
    }

    /// The position and duration in seconds, as last reported.
    pub fn timeline(&self) -> (Option<f64>, Option<f64>) {
        (self.position, self.duration)
    }

    pub fn tracks(&self) -> &[MediaTrack] {
        &self.tracks
    }

    pub fn has_track(&self, kind: TrackKind, id: &str) -> bool {
        self.tracks.iter().any(|t| t.kind == kind && t.id == id)
    }

    pub fn snapshot(&self) -> PlayerSnapshot {
        PlayerSnapshot {
            state: self.state,
            position: self.position.unwrap_or(0.0),
            duration: self.duration,
            buffering: self.buffering,
            tracks: self.tracks.clone(),
            chapters: self.chapters.clone(),
            audio_track_id: self.audio.clone(),
            subtitle_track_id: self.subtitle.clone(),
            volume: self.volume,
            muted: self.muted,
            max_volume: MAX_VOLUME,
            subtitle_delay: self.subtitle_delay,
            audio_delay: self.audio_delay,
            speed: self.speed,
        }
    }

    /// Applies one change and returns the events it produces, in order.
    pub fn apply(&mut self, change: Change, now: Instant) -> Vec<PlayerEvent> {
        let mut events = Vec::new();
        let mut force_time = false;
        match change {
            Change::StartFile => {
                self.loading = true;
                self.loaded = false;
                self.failed = false;
                self.eof = false;
                self.position = None;
                self.duration = None;
                self.buffering = false;
                self.cache_percent = None;
                force_time = true;
                // The next file's chapters arrive once it is open.
                if !self.chapters.is_empty() {
                    self.chapters.clear();
                    events.push(PlayerEvent::ChaptersChange {
                        chapters: Vec::new(),
                    });
                }
            }
            Change::FileLoaded => {
                self.loading = false;
                self.loaded = true;
            }
            Change::PlaybackRestart => {
                self.loading = false;
                force_time = true;
            }
            Change::Failed(error) => {
                self.failed = true;
                self.loading = false;
                self.loaded = false;
                events.push(PlayerEvent::Error { error });
            }
            Change::Idle(idle) => {
                self.idle = idle;
                if idle {
                    self.loaded = false;
                }
            }
            Change::Paused(paused) => {
                self.paused = paused;
                // Report the exact position the player stopped at.
                force_time = paused;
            }
            Change::EofReached(eof) => {
                if eof && !self.eof && !self.idle {
                    events.push(PlayerEvent::Ended {});
                }
                self.eof = eof;
            }
            Change::Position(position) => {
                if position != self.position {
                    self.position = position;
                    self.time_pending = true;
                }
            }
            Change::Duration(duration) => {
                if duration != self.duration {
                    self.duration = duration;
                    force_time = true;
                }
            }
            Change::PausedForCache(buffering) => {
                if buffering != self.buffering {
                    self.buffering = buffering;
                    events.push(self.buffering_event());
                }
            }
            Change::CacheBufferingState(percent) => {
                self.cache_percent = Some(percent.clamp(0, 100));
                if self.buffering {
                    events.push(self.buffering_event());
                }
            }
            Change::TrackList(json) => {
                let tracks = parse_track_list(&json);
                let audio = selected_id(&tracks, TrackKind::Audio);
                let subtitle = selected_id(&tracks, TrackKind::Subtitle);
                // Selection changes are reported by `trackSelect` alone.
                let changed = !same_tracks(&tracks, &self.tracks);
                self.tracks = tracks;
                if changed {
                    events.push(PlayerEvent::TracksChange {
                        tracks: self.tracks.clone(),
                    });
                }
                if audio != self.audio {
                    self.audio = audio;
                    events.push(PlayerEvent::TrackSelect {
                        kind: TrackKind::Audio,
                        track_id: self.audio.clone(),
                    });
                }
                if subtitle != self.subtitle {
                    self.subtitle = subtitle;
                    events.push(PlayerEvent::TrackSelect {
                        kind: TrackKind::Subtitle,
                        track_id: self.subtitle.clone(),
                    });
                }
            }
            Change::ChapterList(json) => {
                let chapters = parse_chapter_list(&json);
                if chapters != self.chapters {
                    self.chapters = chapters;
                    events.push(PlayerEvent::ChaptersChange {
                        chapters: self.chapters.clone(),
                    });
                }
            }
            Change::Volume(volume) => {
                let volume = (volume / 100.0).clamp(0.0, MAX_VOLUME);
                if volume != self.volume {
                    self.volume = volume;
                    events.push(self.volume_event());
                }
            }
            Change::Muted(muted) => {
                if muted != self.muted {
                    self.muted = muted;
                    events.push(self.volume_event());
                }
            }
            Change::SubtitleDelay(seconds) => {
                if self.set_timing(|model| &mut model.subtitle_delay, seconds) {
                    events.push(self.timing_event());
                }
            }
            Change::AudioDelay(seconds) => {
                if self.set_timing(|model| &mut model.audio_delay, seconds) {
                    events.push(self.timing_event());
                }
            }
            Change::Speed(speed) => {
                if self.set_timing(|model| &mut model.speed, speed) {
                    events.push(self.timing_event());
                }
            }
        }

        let due = self
            .last_time_update
            .is_none_or(|last| now.duration_since(last) >= TIME_UPDATE_INTERVAL);
        if force_time || (self.time_pending && due) {
            self.time_pending = false;
            self.last_time_update = Some(now);
            events.push(PlayerEvent::TimeUpdate {
                position: self.position.unwrap_or(0.0),
                duration: self.duration,
            });
        }

        let state = self.derive_state();
        if state != self.state {
            self.state = state;
            events.push(PlayerEvent::StateChange { state });
        }
        events
    }

    fn derive_state(&self) -> PlaybackState {
        if self.failed {
            PlaybackState::Error
        } else if self.loading {
            PlaybackState::Loading
        } else if self.idle || !self.loaded {
            // mpv can leave idle mode before announcing the file it opens.
            PlaybackState::Idle
        } else if self.eof {
            PlaybackState::Ended
        } else if self.paused {
            PlaybackState::Paused
        } else {
            PlaybackState::Playing
        }
    }

    fn buffering_event(&self) -> PlayerEvent {
        PlayerEvent::Buffering {
            buffering: self.buffering,
            progress: self
                .buffering
                .then_some(self.cache_percent)
                .flatten()
                .map(|p| p as f64 / 100.0),
        }
    }

    fn volume_event(&self) -> PlayerEvent {
        PlayerEvent::VolumeChange {
            volume: self.volume,
            muted: self.muted,
        }
    }

    /// Stores a delay or speed to the millisecond (mpv reports sums such as
    /// `0.30000000000000004`), returning whether it changed.
    fn set_timing(&mut self, field: impl FnOnce(&mut Self) -> &mut f64, value: f64) -> bool {
        if !value.is_finite() {
            return false;
        }
        let value = (value * 1000.0).round() / 1000.0;
        let current = field(self);
        let changed = *current != value;
        *current = value;
        changed
    }

    fn timing_event(&self) -> PlayerEvent {
        PlayerEvent::TimingChange {
            subtitle_delay: self.subtitle_delay,
            audio_delay: self.audio_delay,
            speed: self.speed,
        }
    }
}

/// Whether two track lists are equal apart from which tracks are selected.
fn same_tracks(a: &[MediaTrack], b: &[MediaTrack]) -> bool {
    a.len() == b.len()
        && a.iter().zip(b).all(|(x, y)| {
            MediaTrack {
                selected: y.selected,
                ..x.clone()
            } == *y
        })
}

fn selected_id(tracks: &[MediaTrack], kind: TrackKind) -> Option<String> {
    tracks
        .iter()
        .find(|t| t.kind == kind && t.selected)
        .map(|t| t.id.clone())
}

/// One entry of mpv's `track-list` property (only the fields Kiro uses).
#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
struct MpvTrack {
    id: i64,
    #[serde(rename = "type")]
    kind: String,
    title: Option<String>,
    lang: Option<String>,
    codec: Option<String>,
    audio_channels: Option<u32>,
    demux_channel_count: Option<u32>,
    #[serde(default)]
    default: bool,
    #[serde(default)]
    forced: bool,
    #[serde(default)]
    external: bool,
    external_filename: Option<String>,
    #[serde(default)]
    selected: bool,
    #[serde(default)]
    albumart: bool,
}

/// Parses mpv's `track-list` JSON. Unknown track types (and cover art posing
/// as a video track) are skipped; malformed input yields no tracks.
pub fn parse_track_list(json: &str) -> Vec<MediaTrack> {
    let Ok(tracks) = serde_json::from_str::<Vec<MpvTrack>>(json) else {
        return Vec::new();
    };
    tracks
        .into_iter()
        .filter_map(|track| {
            let kind = match track.kind.as_str() {
                "video" if !track.albumart => TrackKind::Video,
                "audio" => TrackKind::Audio,
                "sub" => TrackKind::Subtitle,
                _ => return None,
            };
            Some(MediaTrack {
                id: track.id.to_string(),
                kind,
                label: track.title.filter(|t| !t.is_empty()),
                language: track.lang.filter(|l| !l.is_empty() && l != "und"),
                codec: track.codec,
                channels: if kind == TrackKind::Audio {
                    track.audio_channels.or(track.demux_channel_count)
                } else {
                    None
                },
                is_default: track.default,
                is_forced: track.forced,
                is_external: track.external,
                selected: track.selected,
                external_url: track.external_filename,
            })
        })
        .collect()
}

/// One entry of mpv's `chapter-list` property.
#[derive(Deserialize)]
struct MpvChapter {
    title: Option<String>,
    time: f64,
}

/// Parses mpv's `chapter-list` JSON into chapters ordered by start time.
///
/// Chapter titles are file metadata, so they are treated as untrusted: control
/// characters are dropped, whitespace is collapsed, titles are cut to
/// [`MAX_CHAPTER_TITLE_CHARS`] and at most [`MAX_CHAPTERS`] chapters are kept.
/// Chapters with an unusable time are skipped, as are later chapters starting
/// at the same time as an earlier one. Malformed or oversized input yields no
/// chapters.
pub fn parse_chapter_list(json: &str) -> Vec<Chapter> {
    if json.len() > MAX_CHAPTER_LIST_BYTES {
        return Vec::new();
    }
    let Ok(raw) = serde_json::from_str::<Vec<MpvChapter>>(json) else {
        return Vec::new();
    };
    let mut chapters: Vec<Chapter> = raw
        .into_iter()
        .filter(|chapter| chapter.time.is_finite())
        .map(|chapter| Chapter {
            // mpv can report slightly negative times for the first chapter.
            start: chapter.time.max(0.0),
            title: chapter.title.as_deref().and_then(clean_title),
        })
        .take(MAX_CHAPTERS)
        .collect();
    chapters.sort_by(|a, b| a.start.total_cmp(&b.start));
    chapters.dedup_by(|later, earlier| later.start == earlier.start);
    chapters
}

/// A chapter title fit for display: single-spaced, without control
/// characters, at most [`MAX_CHAPTER_TITLE_CHARS`] long. `None` if empty.
fn clean_title(title: &str) -> Option<String> {
    let cleaned = title
        .split(|c: char| c.is_whitespace() || c.is_control())
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let cleaned: String = cleaned.chars().take(MAX_CHAPTER_TITLE_CHARS).collect();
    let cleaned = cleaned.trim_end();
    (!cleaned.is_empty()).then(|| cleaned.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// An abridged `track-list` from the Matroska test suite's `test5.mkv`.
    const TRACK_LIST: &str = r#"[
        {"id":1,"type":"video","codec":"h264","default":true,"forced":false,"external":false,"selected":true,"albumart":false},
        {"id":1,"type":"audio","codec":"aac","audio-channels":2,"default":true,"forced":false,"external":false,"selected":true},
        {"id":2,"type":"audio","title":"Commentary","lang":"eng","codec":"aac","demux-channel-count":1,"default":false,"external":false,"selected":false},
        {"id":1,"type":"sub","lang":"eng","codec":"subrip","default":true,"forced":false,"external":false,"selected":true},
        {"id":2,"type":"sub","lang":"hun","codec":"subrip","default":false,"forced":true,"external":false,"selected":false},
        {"id":3,"type":"sub","title":"Extra","lang":"und","codec":"webvtt","external":true,"external-filename":"https://subs.example/a.vtt","selected":false},
        {"id":2,"type":"video","codec":"mjpeg","albumart":true}
    ]"#;

    fn at(ms: u64) -> Instant {
        // A fixed base keeps the arithmetic deterministic.
        thread_local!(static BASE: Instant = Instant::now());
        BASE.with(|base| *base + Duration::from_millis(ms))
    }

    #[test]
    fn parses_embedded_and_external_tracks() {
        let tracks = parse_track_list(TRACK_LIST);
        assert_eq!(tracks.len(), 6, "cover art is skipped");

        let commentary = &tracks[2];
        assert_eq!(commentary.kind, TrackKind::Audio);
        assert_eq!(commentary.label.as_deref(), Some("Commentary"));
        assert_eq!(commentary.language.as_deref(), Some("eng"));
        assert_eq!(commentary.channels, Some(1));

        assert!(tracks[4].is_forced);
        let external = &tracks[5];
        assert!(external.is_external);
        assert_eq!(external.language, None, "`und` means unknown");
        assert_eq!(
            external.external_url.as_deref(),
            Some("https://subs.example/a.vtt")
        );

        assert_eq!(
            serde_json::to_value(&tracks[1]).unwrap(),
            json!({
                "id": "1", "kind": "audio", "codec": "aac", "channels": 2,
                "isDefault": true, "isForced": false, "isExternal": false,
            })
        );
    }

    #[test]
    fn malformed_track_list_yields_no_tracks() {
        assert!(parse_track_list("not json").is_empty());
        assert!(parse_track_list("{}").is_empty());
    }

    #[test]
    fn track_list_reports_tracks_and_selection() {
        let mut model = PlayerModel::default();
        let events = model.apply(Change::TrackList(TRACK_LIST.into()), at(0));
        assert!(matches!(events[0], PlayerEvent::TracksChange { ref tracks } if tracks.len() == 6));
        assert_eq!(
            events[1..],
            [
                PlayerEvent::TrackSelect {
                    kind: TrackKind::Audio,
                    track_id: Some("1".into())
                },
                PlayerEvent::TrackSelect {
                    kind: TrackKind::Subtitle,
                    track_id: Some("1".into())
                },
            ]
        );
        assert!(model.has_track(TrackKind::Audio, "2"));
        assert!(!model.has_track(TrackKind::Subtitle, "9"));

        // Disabling subtitles only reports the selection change.
        let no_subs = TRACK_LIST.replace(
            r#""lang":"eng","codec":"subrip","default":true,"forced":false,"external":false,"selected":true"#,
            r#""lang":"eng","codec":"subrip","default":true,"forced":false,"external":false,"selected":false"#,
        );
        let events = model.apply(Change::TrackList(no_subs), at(10));
        assert_eq!(
            events,
            [PlayerEvent::TrackSelect {
                kind: TrackKind::Subtitle,
                track_id: None
            }]
        );
    }

    #[test]
    fn parses_chapters() {
        let chapters = parse_chapter_list(
            r#"[
                {"title":"Intro","time":-0.01},
                {"title":"  Part\tA\u0000 ","time":90.5},
                {"title":"","time":1200},
                {"time":2400},
                {"title":"Credits","time":1200}
            ]"#,
        );
        assert_eq!(
            chapters,
            [
                Chapter {
                    start: 0.0,
                    title: Some("Intro".into())
                },
                Chapter {
                    start: 90.5,
                    title: Some("Part A".into())
                },
                Chapter {
                    start: 1200.0,
                    title: None
                },
                Chapter {
                    start: 2400.0,
                    title: None
                },
            ]
        );
        assert_eq!(
            serde_json::to_value(&chapters[0]).unwrap(),
            json!({ "start": 0.0, "title": "Intro" })
        );
    }

    #[test]
    fn chapter_input_is_bounded() {
        let long_title = "é".repeat(MAX_CHAPTER_TITLE_CHARS * 2);
        let many: Vec<_> = (0..MAX_CHAPTERS + 50)
            .map(|i| json!({ "title": long_title, "time": i }))
            .collect();
        let chapters = parse_chapter_list(&serde_json::to_string(&many).unwrap());
        assert_eq!(chapters.len(), MAX_CHAPTERS);
        assert!(
            chapters
                .iter()
                .all(|c| c.title.as_ref().unwrap().chars().count() == MAX_CHAPTER_TITLE_CHARS)
        );

        let huge = json!([{ "title": "x".repeat(MAX_CHAPTER_LIST_BYTES), "time": 0 }]);
        assert!(parse_chapter_list(&huge.to_string()).is_empty());
        assert!(parse_chapter_list("not json").is_empty());
        assert!(parse_chapter_list(r#"[{"title":"No time"}]"#).is_empty());
    }

    #[test]
    fn chapters_are_reported_and_cleared_with_the_next_file() {
        let mut model = PlayerModel::default();
        let list = r#"[{"title":"Opening","time":0},{"title":"Episode","time":89}]"#;
        let events = model.apply(Change::ChapterList(list.into()), at(0));
        assert!(matches!(
            events.as_slice(),
            [PlayerEvent::ChaptersChange { chapters }] if chapters.len() == 2
        ));
        assert!(
            model
                .apply(Change::ChapterList(list.into()), at(1))
                .is_empty()
        );
        assert_eq!(model.snapshot().chapters.len(), 2);

        let events = model.apply(Change::StartFile, at(2));
        assert!(events.contains(&PlayerEvent::ChaptersChange { chapters: vec![] }));
        assert!(model.snapshot().chapters.is_empty());
        assert!(
            model
                .apply(Change::ChapterList("[]".into()), at(3))
                .is_empty()
        );
    }

    #[test]
    fn walks_through_a_normal_playback() {
        let mut model = PlayerModel::default();
        let states = |events: Vec<PlayerEvent>| -> Vec<PlaybackState> {
            events
                .into_iter()
                .filter_map(|e| match e {
                    PlayerEvent::StateChange { state } => Some(state),
                    _ => None,
                })
                .collect()
        };

        assert_eq!(
            states(model.apply(Change::StartFile, at(0))),
            [PlaybackState::Loading]
        );
        assert_eq!(states(model.apply(Change::Idle(false), at(1))), []);
        assert_eq!(
            states(model.apply(Change::FileLoaded, at(2))),
            [PlaybackState::Playing]
        );
        assert_eq!(
            states(model.apply(Change::Paused(true), at(3))),
            [PlaybackState::Paused]
        );
        assert_eq!(
            states(model.apply(Change::Paused(false), at(4))),
            [PlaybackState::Playing]
        );

        let events = model.apply(Change::EofReached(true), at(5));
        assert_eq!(events[0], PlayerEvent::Ended {});
        assert_eq!(states(events), [PlaybackState::Ended]);

        assert_eq!(
            states(model.apply(Change::Idle(true), at(6))),
            [PlaybackState::Idle]
        );
    }

    #[test]
    fn failures_are_reported_until_the_next_file() {
        let mut model = PlayerModel::default();
        model.apply(Change::StartFile, at(0));
        let failure = PlayerFailure {
            code: FailureCode::Network,
            message: "The stream could not be opened".into(),
            recoverable: true,
        };
        let events = model.apply(Change::Failed(failure.clone()), at(1));
        assert_eq!(
            events,
            [
                PlayerEvent::Error { error: failure },
                PlayerEvent::StateChange {
                    state: PlaybackState::Error
                }
            ]
        );
        // mpv goes idle after a failure; the error state sticks.
        assert!(model.apply(Change::Idle(true), at(2)).is_empty());
        model.apply(Change::StartFile, at(3));
        assert_eq!(model.state(), PlaybackState::Loading);
    }

    #[test]
    fn time_updates_are_throttled_but_flushed_on_pause() {
        let mut model = PlayerModel::default();
        model.apply(Change::Idle(false), at(0));
        model.apply(Change::FileLoaded, at(0));
        let time = |events: &[PlayerEvent]| {
            events.iter().find_map(|e| match e {
                PlayerEvent::TimeUpdate { position, .. } => Some(*position),
                _ => None,
            })
        };

        assert_eq!(
            time(&model.apply(Change::Position(Some(1.0)), at(0))),
            Some(1.0)
        );
        assert_eq!(
            time(&model.apply(Change::Position(Some(1.1)), at(100))),
            None
        );
        assert_eq!(
            time(&model.apply(Change::Position(Some(1.2)), at(200))),
            None
        );
        assert_eq!(
            time(&model.apply(Change::Position(Some(1.3)), at(300))),
            Some(1.3)
        );
        assert_eq!(
            time(&model.apply(Change::Position(Some(1.4)), at(350))),
            None
        );
        // Pausing reports the held-back position straight away.
        assert_eq!(time(&model.apply(Change::Paused(true), at(360))), Some(1.4));
    }

    #[test]
    fn buffering_and_volume_events() {
        let mut model = PlayerModel::default();
        assert!(
            model
                .apply(Change::CacheBufferingState(40), at(0))
                .is_empty()
        );
        assert_eq!(
            model.apply(Change::PausedForCache(true), at(1)),
            [PlayerEvent::Buffering {
                buffering: true,
                progress: Some(0.4)
            }]
        );
        assert_eq!(
            model.apply(Change::PausedForCache(false), at(2)),
            [PlayerEvent::Buffering {
                buffering: false,
                progress: None
            }]
        );

        assert_eq!(
            model.apply(Change::Volume(50.0), at(3)),
            [PlayerEvent::VolumeChange {
                volume: 0.5,
                muted: false
            }]
        );
        assert!(model.apply(Change::Volume(50.0), at(4)).is_empty());
    }

    #[test]
    fn timing_changes_are_reported_and_kept_in_the_snapshot() {
        let mut model = PlayerModel::default();
        let snapshot = model.snapshot();
        assert_eq!(
            (
                snapshot.subtitle_delay,
                snapshot.audio_delay,
                snapshot.speed
            ),
            (0.0, 0.0, 1.0)
        );

        assert_eq!(
            model.apply(Change::SubtitleDelay(0.1 + 0.2), at(0)),
            [PlayerEvent::TimingChange {
                subtitle_delay: 0.3,
                audio_delay: 0.0,
                speed: 1.0
            }]
        );
        assert!(model.apply(Change::SubtitleDelay(0.3), at(1)).is_empty());
        assert_eq!(
            model.apply(Change::AudioDelay(-0.25), at(2)),
            [PlayerEvent::TimingChange {
                subtitle_delay: 0.3,
                audio_delay: -0.25,
                speed: 1.0
            }]
        );
        assert_eq!(
            model.apply(Change::Speed(1.5), at(3)),
            [PlayerEvent::TimingChange {
                subtitle_delay: 0.3,
                audio_delay: -0.25,
                speed: 1.5
            }]
        );
        assert!(model.apply(Change::Speed(f64::NAN), at(4)).is_empty());

        // mpv keeps them for the next file; so does the model.
        model.apply(Change::StartFile, at(5));
        let snapshot = model.snapshot();
        assert_eq!(
            (
                snapshot.subtitle_delay,
                snapshot.audio_delay,
                snapshot.speed
            ),
            (0.3, -0.25, 1.5)
        );
        assert_eq!(
            serde_json::to_value(&snapshot).unwrap()["subtitleDelay"],
            json!(0.3)
        );
    }

    #[test]
    fn events_serialise_like_player_core() {
        let event = PlayerEvent::TrackSelect {
            kind: TrackKind::Subtitle,
            track_id: None,
        };
        assert_eq!(
            serde_json::to_value(event).unwrap(),
            json!({ "event": "trackSelect", "payload": { "kind": "subtitle", "trackId": null } })
        );
        assert_eq!(
            serde_json::to_value(PlayerEvent::TimingChange {
                subtitle_delay: -0.5,
                audio_delay: 0.1,
                speed: 2.0
            })
            .unwrap(),
            json!({
                "event": "timingChange",
                "payload": { "subtitleDelay": -0.5, "audioDelay": 0.1, "speed": 2.0 }
            })
        );
        assert_eq!(
            serde_json::to_value(PlayerEvent::Ended {}).unwrap(),
            json!({ "event": "ended", "payload": {} })
        );
        let error = PlayerEvent::Error {
            error: PlayerFailure {
                code: FailureCode::UnsupportedSource,
                message: "x".into(),
                recoverable: false,
            },
        };
        assert_eq!(
            serde_json::to_value(error).unwrap()["payload"]["error"]["code"],
            "UNSUPPORTED_SOURCE"
        );
    }
}
