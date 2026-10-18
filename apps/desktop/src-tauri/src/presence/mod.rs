//! Discord Rich Presence: "Watching Breaking Bad · S2 E4" on the user's
//! Discord profile while a video plays (Settings → General).
//!
//! Off unless chosen, and nothing at all happens while it's off: no thread,
//! no connection to Discord. What can be sent is the title, the season and
//! episode numbers, an https poster URL and how far into the video playback
//! is; the settings can hide the title (and with it the episode and poster)
//! or just the episode. [`NowPlaying`] has no room for anything else, so
//! stream URLs, addon names and file paths can't reach Discord.
//!
//! [`Presence`] follows the player's [`PlaybackState`] as
//! [`KeepAwake`](crate::media::keep_awake::KeepAwake) does: the player's
//! event thread reports every change ([`Presence::sync_player`]), and
//! [`activity`] maps it to what Discord should show: the activity with a
//! start timestamp while playing, "Paused" while paused, nothing otherwise.
//! Talking to Discord happens on a thread of its own ([`worker`]), so the
//! player never waits on it. That thread connects over Discord's local IPC
//! only while there is something to show, retries gently while Discord isn't
//! running, keeps within Discord's rate limit and clears the activity when
//! the setting is turned off and when the app quits.

pub mod discord;
mod worker;

use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use url::Url;

use crate::media::model::PlaybackState;
use crate::settings::GeneralSettings;
pub use worker::{Ipc, IpcError, Timing};

/// The Discord application Kiro's activity belongs to. Discord shows its
/// name after "Watching" ("Watching Kiro") and its Rich Presence art holds
/// the logo ([`LOGO_ASSET`]) shown when a title has no https poster.
///
/// TODO(discord): this is a placeholder, and presence stays off until it's
/// replaced (Settings says so). Create an application named "Kiro" at
/// <https://discord.com/developers/applications>, upload
/// `apps/desktop/app-icon.png` under Rich Presence → Art Assets with the
/// name `kiro`, then set the application's ID here or in
/// `KIRO_DISCORD_APPLICATION_ID` when building.
pub const APPLICATION_ID: &str = match option_env!("KIRO_DISCORD_APPLICATION_ID") {
    Some(id) => id,
    None => PLACEHOLDER_APPLICATION_ID,
};
const PLACEHOLDER_APPLICATION_ID: &str = "000000000000000000";

/// The Kiro logo's name among the application's Rich Presence art assets.
pub const LOGO_ASSET: &str = "kiro";

/// Shown instead of the title when the title is hidden.
pub const HIDDEN_TITLE: &str = "Watching something on Kiro";

/// Discord's limits: text fields take 2 to 128 characters, image URLs up to
/// 256.
const MIN_TEXT_CHARS: usize = 2;
const MAX_TEXT_CHARS: usize = 128;
const MAX_IMAGE_URL_LEN: usize = 256;
/// Titles longer than this (in characters) are refused rather than cut.
const MAX_TITLE_INPUT_CHARS: usize = 500;
/// Season and episode numbers above this are refused.
const MAX_EPISODE_NUMBER: u32 = 99_999;
/// While playing, the start timestamp moves with the position (seeking,
/// buffering). Moves smaller than this aren't worth an update.
const TIMESTAMP_TOLERANCE_MS: i64 = 3_000;

/// Whether this build has a real Discord application ID.
pub fn is_configured() -> bool {
    is_application_id(APPLICATION_ID)
}

/// A Discord snowflake: 17 to 20 digits, and not the placeholder.
fn is_application_id(id: &str) -> bool {
    id != PLACEHOLDER_APPLICATION_ID
        && (17..=20).contains(&id.len())
        && id.bytes().all(|b| b.is_ascii_digit())
}

/// Settings → General → "Show what I'm watching on Discord" and its options.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PresenceOptions {
    pub enabled: bool,
    /// Off: "Watching something on Kiro", with the Kiro logo.
    pub show_title: bool,
    /// The season and episode numbers, after the title.
    pub show_episode: bool,
}

impl From<&GeneralSettings> for PresenceOptions {
    fn from(general: &GeneralSettings) -> Self {
        Self {
            enabled: general.discord_presence,
            show_title: general.discord_show_title,
            show_episode: general.discord_show_episode,
        }
    }
}

/// What is playing, as far as Discord may know: everything here can be
/// shown, nothing else is kept.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NowPlaying {
    title: String,
    season: Option<u32>,
    episode: Option<u32>,
    /// https, short enough for Discord, without credentials.
    poster: Option<Url>,
}

impl NowPlaying {
    /// Validates what the renderer sends. A poster that isn't a usable https
    /// URL is dropped (the logo shows instead); anything else invalid is
    /// refused.
    pub fn new(
        title: &str,
        season: Option<u32>,
        episode: Option<u32>,
        poster: Option<&str>,
    ) -> Result<Self, &'static str> {
        let title = clean_text(title);
        if title.is_empty() {
            return Err("The title is empty");
        }
        if title.chars().count() > MAX_TITLE_INPUT_CHARS {
            return Err("The title is too long");
        }
        if season.is_some_and(|n| n > MAX_EPISODE_NUMBER)
            || episode.is_some_and(|n| n > MAX_EPISODE_NUMBER)
        {
            return Err("The season or episode number is out of range");
        }
        Ok(Self {
            title,
            season,
            episode,
            poster: poster.and_then(poster_url),
        })
    }

    /// "S2 E4", or "E4" without a season; `None` for a film.
    pub fn episode_label(&self) -> Option<String> {
        match (self.season, self.episode) {
            (Some(season), Some(episode)) => Some(format!("S{season} E{episode}")),
            (None, Some(episode)) => Some(format!("E{episode}")),
            _ => None,
        }
    }
}

/// A poster Discord can show: an https URL of at most 256 bytes with no
/// user name or password in it.
fn poster_url(value: &str) -> Option<Url> {
    if value.len() > MAX_IMAGE_URL_LEN {
        return None;
    }
    let url = Url::parse(value).ok()?;
    let usable = url.scheme() == "https"
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.as_str().len() <= MAX_IMAGE_URL_LEN;
    usable.then_some(url)
}

/// Trimmed, with control characters removed and runs of whitespace joined.
fn clean_text(text: &str) -> String {
    text.split(|c: char| c.is_whitespace() || c.is_control())
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// `text` within Discord's 2 to 128 characters: cut with an ellipsis when
/// longer, padded with a blank Braille cell (which Discord doesn't trim)
/// when a single character.
fn fit(text: &str) -> String {
    let count = text.chars().count();
    if count > MAX_TEXT_CHARS {
        let mut cut: String = text.chars().take(MAX_TEXT_CHARS - 1).collect();
        cut.truncate(cut.trim_end().len());
        cut.push('…');
        cut
    } else if count < MIN_TEXT_CHARS {
        format!("{text}\u{2800}")
    } else {
        text.to_owned()
    }
}

/// What the player is doing, as presence needs it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlayerView {
    pub state: PlaybackState,
    /// Seconds.
    pub position: Option<f64>,
    pub duration: Option<f64>,
}

impl PlayerView {
    pub const IDLE: Self = Self {
        state: PlaybackState::Idle,
        position: None,
        duration: None,
    };
}

/// What Discord shows. Converted to the IPC payload in [`discord`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Activity {
    /// The first line: the title, or [`HIDDEN_TITLE`].
    pub details: String,
    /// The second line: the episode and/or "Paused".
    pub state: Option<String>,
    /// An https poster URL or [`LOGO_ASSET`].
    pub large_image: String,
    /// Shown when hovering the image.
    pub large_text: String,
    /// Unix milliseconds: when playback would have begun at this speed, and
    /// when it will end. Discord shows the time elapsed (and, with the end, a
    /// progress bar). Only while playing.
    pub timestamps: Option<Timestamps>,
    /// Shows [`Self::details`] in the member list ("Watching Breaking Bad")
    /// rather than the application's name ("Watching Kiro").
    pub details_in_status: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timestamps {
    pub start: i64,
    pub end: Option<i64>,
}

impl Activity {
    /// Whether showing `other` instead would change what Discord shows by
    /// more than the timestamps drifting a little.
    fn differs_from(&self, other: &Self) -> bool {
        let close = |a: i64, b: i64| (a - b).abs() < TIMESTAMP_TOLERANCE_MS;
        let timestamps_match = match (self.timestamps, other.timestamps) {
            (None, None) => true,
            (Some(a), Some(b)) => {
                close(a.start, b.start)
                    && match (a.end, b.end) {
                        (None, None) => true,
                        (Some(x), Some(y)) => close(x, y),
                        _ => false,
                    }
            }
            _ => false,
        };
        !timestamps_match
            || self.details != other.details
            || self.state != other.state
            || self.large_image != other.large_image
            || self.large_text != other.large_text
            || self.details_in_status != other.details_in_status
    }
}

fn differs(a: Option<&Activity>, b: Option<&Activity>) -> bool {
    match (a, b) {
        (None, None) => false,
        (Some(a), Some(b)) => a.differs_from(b),
        _ => true,
    }
}

/// The activity Discord should show, if any, at `now_ms` (Unix ms):
///
/// - setting off, or nothing known about the video: nothing;
/// - playing (including buffering mid-way): the title, the episode, the
///   poster and the time elapsed;
/// - paused: the same with "Paused" and no time;
/// - loading, ended, failed, stopped or closed: nothing.
pub fn activity(
    options: &PresenceOptions,
    media: Option<&NowPlaying>,
    player: &PlayerView,
    now_ms: i64,
) -> Option<Activity> {
    if !options.enabled {
        return None;
    }
    let media = media?;
    let paused = match player.state {
        PlaybackState::Playing => false,
        PlaybackState::Paused => true,
        PlaybackState::Idle
        | PlaybackState::Loading
        | PlaybackState::Ready
        | PlaybackState::Ended
        | PlaybackState::Error => return None,
    };

    let episode = if options.show_title && options.show_episode {
        media.episode_label()
    } else {
        None
    };
    let state = match (episode, paused) {
        (Some(episode), true) => Some(format!("{episode} · Paused")),
        (Some(episode), false) => Some(episode),
        (None, true) => Some("Paused".to_owned()),
        (None, false) => None,
    };
    let timestamps = (!paused).then(|| {
        let seconds = |value: Option<f64>| value.filter(|s| s.is_finite() && *s >= 0.0);
        let millis = |s: f64| (s * 1000.0).round() as i64;
        let start = now_ms - seconds(player.position).map_or(0, millis);
        Timestamps {
            start,
            end: seconds(player.duration)
                .filter(|d| *d > 0.0)
                .map(|d| start + millis(d)),
        }
    });

    Some(if options.show_title {
        let title = fit(&media.title);
        Activity {
            details: title.clone(),
            state,
            large_image: media
                .poster
                .as_ref()
                .map_or_else(|| LOGO_ASSET.to_owned(), |url| url.as_str().to_owned()),
            large_text: title,
            timestamps,
            details_in_status: true,
        }
    } else {
        Activity {
            details: HIDDEN_TITLE.to_owned(),
            state,
            large_image: LOGO_ASSET.to_owned(),
            large_text: "Kiro".to_owned(),
            timestamps,
            details_in_status: false,
        }
    })
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
        })
}

/// `KIRO_SPIKE_LOG`: log what presence does. Otherwise it logs nothing.
fn debug_log_enabled() -> bool {
    std::env::var_os("KIRO_SPIKE_LOG").is_some()
}

/// What the worker should do, shared with it.
struct Desired {
    options: PresenceOptions,
    media: Option<NowPlaying>,
    player: PlayerView,
    /// What Discord should show now.
    activity: Option<Activity>,
    /// The app is quitting: clear the activity and stop.
    quit: bool,
    /// The worker has stopped.
    finished: bool,
}

struct Shared {
    desired: Mutex<Desired>,
    changed: Condvar,
}

impl Shared {
    fn desired(&self) -> MutexGuard<'_, Desired> {
        self.desired.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

type ClientFactory = Box<dyn Fn() -> Box<dyn Ipc> + Send + Sync>;

/// Discord Rich Presence for the app. Cheap until the setting is first
/// turned on, when its worker thread starts.
pub struct Presence {
    shared: Arc<Shared>,
    worker: Mutex<Option<JoinHandle<()>>>,
    client: ClientFactory,
    timing: Timing,
    /// Builds without a Discord application ID never start the worker.
    configured: bool,
}

impl Presence {
    /// Presence over Discord's local IPC.
    pub fn discord() -> Self {
        Self::new(
            Box::new(|| Box::new(discord::DiscordClient::new(APPLICATION_ID))),
            Timing::default(),
            is_configured(),
        )
    }

    fn new(client: ClientFactory, timing: Timing, configured: bool) -> Self {
        Self {
            shared: Arc::new(Shared {
                desired: Mutex::new(Desired {
                    options: PresenceOptions::default(),
                    media: None,
                    player: PlayerView::IDLE,
                    activity: None,
                    quit: false,
                    finished: false,
                }),
                changed: Condvar::new(),
            }),
            worker: Mutex::new(None),
            client,
            timing,
            configured,
        }
    }

    /// Applies the settings. The worker starts the first time they're on.
    pub fn set_options(&self, options: PresenceOptions) {
        self.update(|desired| desired.options = options);
        if options.enabled && self.configured {
            self.start_worker();
        }
    }

    /// What is playing (or `None` once the player closes).
    pub fn set_media(&self, media: Option<NowPlaying>) {
        self.update(|desired| desired.media = media);
    }

    /// The player's state, after each of its changes.
    pub fn sync_player(&self, player: PlayerView) {
        self.update(|desired| desired.player = player);
    }

    /// What Discord should be showing now.
    pub fn activity(&self) -> Option<Activity> {
        self.shared.desired().activity.clone()
    }

    fn update(&self, change: impl FnOnce(&mut Desired)) {
        let mut desired = self.shared.desired();
        change(&mut desired);
        let next = activity(
            &desired.options,
            desired.media.as_ref(),
            &desired.player,
            now_ms(),
        );
        if differs(desired.activity.as_ref(), next.as_ref()) {
            desired.activity = next;
            self.shared.changed.notify_all();
        }
    }

    fn start_worker(&self) {
        let mut worker = self.worker.lock().unwrap_or_else(PoisonError::into_inner);
        if worker.is_some() || self.shared.desired().quit {
            return;
        }
        let shared = self.shared.clone();
        let client = (self.client)();
        let timing = self.timing;
        match std::thread::Builder::new()
            .name("kiro-discord-presence".into())
            .spawn(move || worker::run(&shared, client, timing))
        {
            Ok(handle) => *worker = Some(handle),
            // Presence is a nicety: go on without it.
            Err(error) => eprintln!("[kiro-presence] could not start: {error}"),
        }
    }

    /// The app is quitting: clears the activity and disconnects, waiting at
    /// most `timeout` for Discord.
    pub fn shutdown(&self, timeout: Duration) {
        let handle = self
            .worker
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        let mut desired = self.shared.desired();
        desired.quit = true;
        desired.activity = None;
        self.shared.changed.notify_all();
        let Some(handle) = handle else {
            return;
        };
        let (desired, _) = self
            .shared
            .changed
            .wait_timeout_while(desired, timeout, |desired| !desired.finished)
            .unwrap_or_else(PoisonError::into_inner);
        if desired.finished {
            drop(desired);
            let _ = handle.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex as StdMutex;
    use std::time::Instant;

    use super::*;
    use PlaybackState::{Ended, Error, Idle, Loading, Paused, Playing, Ready};

    const NOW: i64 = 1_760_000_000_000;

    fn options() -> PresenceOptions {
        PresenceOptions {
            enabled: true,
            show_title: true,
            show_episode: true,
        }
    }

    fn episode() -> NowPlaying {
        NowPlaying::new(
            "Breaking Bad",
            Some(2),
            Some(4),
            Some("https://images.example/bb/poster.jpg"),
        )
        .unwrap()
    }

    fn film() -> NowPlaying {
        NowPlaying::new("Heat", None, None, None).unwrap()
    }

    fn playing(position: f64, duration: Option<f64>) -> PlayerView {
        PlayerView {
            state: Playing,
            position: Some(position),
            duration,
        }
    }

    fn view(state: PlaybackState) -> PlayerView {
        PlayerView {
            state,
            position: Some(60.0),
            duration: Some(3000.0),
        }
    }

    #[test]
    fn playing_shows_the_title_episode_poster_and_time_elapsed() {
        let shown = activity(
            &options(),
            Some(&episode()),
            &playing(90.5, Some(2820.0)),
            NOW,
        );
        assert_eq!(
            shown,
            Some(Activity {
                details: "Breaking Bad".into(),
                state: Some("S2 E4".into()),
                large_image: "https://images.example/bb/poster.jpg".into(),
                large_text: "Breaking Bad".into(),
                timestamps: Some(Timestamps {
                    start: NOW - 90_500,
                    end: Some(NOW - 90_500 + 2_820_000),
                }),
                details_in_status: true,
            })
        );
    }

    #[test]
    fn paused_says_so_without_a_time() {
        let shown = activity(&options(), Some(&episode()), &view(Paused), NOW).unwrap();
        assert_eq!(shown.state.as_deref(), Some("S2 E4 · Paused"));
        assert_eq!(shown.timestamps, None);

        let film = activity(&options(), Some(&film()), &view(Paused), NOW).unwrap();
        assert_eq!(film.state.as_deref(), Some("Paused"));
    }

    #[test]
    fn only_playing_and_paused_show_anything() {
        let shown: Vec<_> = [Idle, Loading, Ready, Playing, Paused, Ended, Error]
            .into_iter()
            .filter(|state| activity(&options(), Some(&episode()), &view(*state), NOW).is_some())
            .collect();
        assert_eq!(shown, [Playing, Paused]);
    }

    #[test]
    fn nothing_when_off_or_when_nothing_is_known_about_the_video() {
        let off = PresenceOptions {
            enabled: false,
            ..options()
        };
        assert_eq!(activity(&off, Some(&episode()), &view(Playing), NOW), None);
        assert_eq!(activity(&options(), None, &view(Playing), NOW), None);
    }

    #[test]
    fn a_hidden_title_shows_only_that_something_is_playing() {
        let hidden = PresenceOptions {
            show_title: false,
            ..options()
        };
        let shown = activity(&hidden, Some(&episode()), &view(Playing), NOW).unwrap();
        assert_eq!(shown.details, HIDDEN_TITLE);
        assert_eq!(shown.state, None, "no episode either");
        assert_eq!(shown.large_image, LOGO_ASSET, "no poster");
        assert_eq!(shown.large_text, "Kiro");
        assert!(!shown.details_in_status);
        assert!(shown.timestamps.is_some());

        let paused = activity(&hidden, Some(&episode()), &view(Paused), NOW).unwrap();
        assert_eq!(paused.state.as_deref(), Some("Paused"));
    }

    #[test]
    fn the_episode_can_be_hidden() {
        let no_episode = PresenceOptions {
            show_episode: false,
            ..options()
        };
        let shown = activity(&no_episode, Some(&episode()), &view(Playing), NOW).unwrap();
        assert_eq!(shown.details, "Breaking Bad");
        assert_eq!(shown.state, None);
        let paused = activity(&no_episode, Some(&episode()), &view(Paused), NOW).unwrap();
        assert_eq!(paused.state.as_deref(), Some("Paused"));
    }

    #[test]
    fn episode_labels() {
        assert_eq!(episode().episode_label().as_deref(), Some("S2 E4"));
        let no_season = NowPlaying::new("Show", None, Some(12), None).unwrap();
        assert_eq!(no_season.episode_label().as_deref(), Some("E12"));
        let special = NowPlaying::new("Show", Some(0), Some(1), None).unwrap();
        assert_eq!(special.episode_label().as_deref(), Some("S0 E1"));
        assert_eq!(film().episode_label(), None);
        let season_only = NowPlaying::new("Show", Some(3), None, None).unwrap();
        assert_eq!(season_only.episode_label(), None);
    }

    #[test]
    fn only_short_https_posters_are_used() {
        let poster = |url: &str| {
            NowPlaying::new("Film", None, None, Some(url))
                .unwrap()
                .poster
        };
        assert!(poster("https://images.example/p.jpg").is_some());
        for url in [
            "http://images.example/p.jpg",
            "file:///Users/me/p.jpg",
            "/tmp/p.jpg",
            "data:image/png;base64,AAAA",
            "https://user:secret@images.example/p.jpg",
            "not a url",
        ] {
            assert_eq!(poster(url), None, "{url}");
        }
        let long = format!("https://images.example/{}.jpg", "a".repeat(240));
        assert_eq!(poster(&long), None);

        // Without a usable poster, the logo.
        let film = NowPlaying::new("Film", None, None, Some("http://x.example/p.jpg")).unwrap();
        let shown = activity(&options(), Some(&film), &view(Playing), NOW).unwrap();
        assert_eq!(shown.large_image, LOGO_ASSET);
    }

    #[test]
    fn titles_are_cleaned_and_fit_discord() {
        let title = |text: &str| {
            let media = NowPlaying::new(text, None, None, None).unwrap();
            activity(&options(), Some(&media), &view(Playing), NOW)
                .unwrap()
                .details
        };
        assert_eq!(title("  The\tWire \n"), "The Wire");
        assert_eq!(title("M"), "M\u{2800}");
        let long = title(&"x".repeat(300));
        assert_eq!(long.chars().count(), MAX_TEXT_CHARS);
        assert!(long.ends_with('…'));

        assert!(NowPlaying::new("  \n", None, None, None).is_err());
        assert!(NowPlaying::new(&"x".repeat(501), None, None, None).is_err());
        assert!(NowPlaying::new("Show", Some(100_000), Some(1), None).is_err());
    }

    #[test]
    fn unknown_positions_start_now_and_live_streams_have_no_end() {
        let live = PlayerView {
            state: Playing,
            position: None,
            duration: None,
        };
        let shown = activity(&options(), Some(&film()), &live, NOW).unwrap();
        assert_eq!(
            shown.timestamps,
            Some(Timestamps {
                start: NOW,
                end: None
            })
        );
        let odd = PlayerView {
            state: Playing,
            position: Some(f64::NAN),
            duration: Some(-1.0),
        };
        let shown = activity(&options(), Some(&film()), &odd, NOW).unwrap();
        assert_eq!(shown.timestamps.unwrap().end, None);
    }

    #[test]
    fn playing_on_doesnt_count_as_a_change_but_seeking_does() {
        let at = |position: f64, now: i64| {
            activity(
                &options(),
                Some(&episode()),
                &playing(position, Some(2820.0)),
                now,
            )
        };
        let first = at(100.0, NOW);
        // Ten seconds later, ten seconds further: the same start.
        assert!(!differs(first.as_ref(), at(110.0, NOW + 10_000).as_ref()));
        // A little buffering doesn't count either.
        assert!(!differs(first.as_ref(), at(101.0, NOW + 2_000).as_ref()));
        // Seeking does.
        assert!(differs(first.as_ref(), at(600.0, NOW + 1_000).as_ref()));
        assert!(differs(first.as_ref(), None));
        assert!(!differs(None, None));
    }

    #[test]
    fn application_ids() {
        assert!(!is_application_id(PLACEHOLDER_APPLICATION_ID));
        assert!(is_application_id("1234567890123456789"));
        assert!(!is_application_id("12345"));
        assert!(!is_application_id("1234567890123456789a"));
        assert!(!is_application_id(""));
    }

    /// Records the calls a [`Presence`] makes, connecting and sending
    /// whenever asked.
    #[derive(Default)]
    struct Log(StdMutex<Vec<String>>);

    struct Recorder(Arc<Log>);

    impl Ipc for Recorder {
        fn connect(&mut self) -> Result<(), IpcError> {
            self.0.0.lock().unwrap().push("connect".into());
            Ok(())
        }
        fn set_activity(&mut self, activity: &Activity) -> Result<(), IpcError> {
            let line = format!("set {} / {:?}", activity.details, activity.state);
            self.0.0.lock().unwrap().push(line);
            Ok(())
        }
        fn clear_activity(&mut self) -> Result<(), IpcError> {
            self.0.0.lock().unwrap().push("clear".into());
            Ok(())
        }
        fn close(&mut self) {
            self.0.0.lock().unwrap().push("close".into());
        }
    }

    fn recorded(configured: bool) -> (Presence, Arc<Log>) {
        let log = Arc::new(Log::default());
        let calls = log.clone();
        let presence = Presence::new(
            Box::new(move || Box::new(Recorder(calls.clone()))),
            Timing::fast(),
            configured,
        );
        (presence, log)
    }

    fn wait_for(log: &Log, expected: &[&str]) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if log.0.lock().unwrap().as_slice() == expected {
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(log.0.lock().unwrap().as_slice(), expected);
    }

    #[test]
    fn follows_the_player_and_clears_on_quit() {
        let (presence, log) = recorded(true);
        presence.set_options(options());
        presence.set_media(Some(episode()));
        presence.sync_player(view(Loading));
        presence.sync_player(view(Playing));
        wait_for(&log, &["connect", "set Breaking Bad / Some(\"S2 E4\")"]);
        presence.sync_player(view(Paused));
        wait_for(
            &log,
            &[
                "connect",
                "set Breaking Bad / Some(\"S2 E4\")",
                "set Breaking Bad / Some(\"S2 E4 · Paused\")",
            ],
        );
        // The player closes.
        presence.sync_player(PlayerView::IDLE);
        presence.set_media(None);
        wait_for(
            &log,
            &[
                "connect",
                "set Breaking Bad / Some(\"S2 E4\")",
                "set Breaking Bad / Some(\"S2 E4 · Paused\")",
                "clear",
            ],
        );
        presence.sync_player(view(Playing));
        presence.shutdown(Duration::from_secs(5));
        let calls = log.0.lock().unwrap().clone();
        assert_eq!(calls.last().map(String::as_str), Some("close"));
        assert_eq!(calls[calls.len() - 2], "clear");
    }

    #[test]
    fn sends_nothing_while_off() {
        let (presence, log) = recorded(true);
        presence.set_options(PresenceOptions::default());
        presence.set_media(Some(episode()));
        presence.sync_player(view(Playing));
        assert_eq!(presence.activity(), None);
        presence.shutdown(Duration::from_secs(5));
        assert!(log.0.lock().unwrap().is_empty());
        assert!(presence.worker.lock().unwrap().is_none(), "never started");
    }

    #[test]
    fn turning_it_off_clears_and_disconnects() {
        let (presence, log) = recorded(true);
        presence.set_options(options());
        presence.set_media(Some(film()));
        presence.sync_player(view(Playing));
        wait_for(&log, &["connect", "set Heat / None"]);
        presence.set_options(PresenceOptions::default());
        wait_for(&log, &["connect", "set Heat / None", "clear", "close"]);
        // Playing on sends nothing more.
        presence.sync_player(view(Paused));
        presence.sync_player(view(Playing));
        presence.shutdown(Duration::from_secs(5));
        assert_eq!(log.0.lock().unwrap().len(), 4);
    }

    #[test]
    fn builds_without_an_application_id_send_nothing() {
        let (presence, log) = recorded(false);
        presence.set_options(options());
        presence.set_media(Some(film()));
        presence.sync_player(view(Playing));
        presence.shutdown(Duration::from_secs(5));
        assert!(log.0.lock().unwrap().is_empty());
    }
}
