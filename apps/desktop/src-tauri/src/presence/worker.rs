//! The thread that talks to Discord.
//!
//! It sleeps until what Discord should show changes, then makes it so:
//! connecting first if needed, and disconnecting when the setting is turned
//! off. Discord not running (or quitting) is normal: a failed connection is
//! retried after 5 s, then 10, 20, 40 and every 60 s, and only while there
//! is something to show. Updates keep within Discord's limit of 5 per 20 s;
//! changes that arrive meanwhile are merged into the next one.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use super::{Activity, Shared, debug_log_enabled};

/// Why a call to Discord failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IpcError {
    /// Discord isn't running, or the connection broke: connect again later.
    Disconnected(String),
    /// Discord refused the update. Sending it again wouldn't help.
    Rejected(String),
}

/// A connection to Discord's local IPC. Blocking: only the worker calls it.
pub trait Ipc: Send {
    fn connect(&mut self) -> Result<(), IpcError>;
    fn set_activity(&mut self, activity: &Activity) -> Result<(), IpcError>;
    fn clear_activity(&mut self) -> Result<(), IpcError>;
    /// Disconnects. Discord also clears the activity when the connection
    /// closes.
    fn close(&mut self);
}

/// How patient the worker is.
#[derive(Debug, Clone, Copy)]
pub struct Timing {
    /// The wait before the first retry, doubled after each failure…
    pub first_retry: Duration,
    /// …up to this.
    pub max_retry: Duration,
    /// At most this many updates in any `window`.
    pub max_updates: usize,
    pub window: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            first_retry: Duration::from_secs(5),
            max_retry: Duration::from_secs(60),
            max_updates: 5,
            window: Duration::from_secs(20),
        }
    }
}

#[cfg(test)]
impl Timing {
    pub(super) fn fast() -> Self {
        Self {
            first_retry: Duration::from_millis(10),
            max_retry: Duration::from_millis(40),
            max_updates: 5,
            window: Duration::from_millis(100),
        }
    }
}

/// Doubling waits between connection attempts.
struct Backoff {
    next: Duration,
    first: Duration,
    max: Duration,
}

impl Backoff {
    fn new(timing: &Timing) -> Self {
        Self {
            next: timing.first_retry,
            first: timing.first_retry,
            max: timing.max_retry,
        }
    }

    /// The wait after another failure.
    fn failed(&mut self) -> Duration {
        let wait = self.next;
        self.next = (self.next * 2).min(self.max);
        wait
    }

    fn reset(&mut self) {
        self.next = self.first;
    }
}

/// At most `max` updates in any `window`.
struct RateLimit {
    sent: VecDeque<Instant>,
    max: usize,
    window: Duration,
}

impl RateLimit {
    fn new(timing: &Timing) -> Self {
        Self {
            sent: VecDeque::new(),
            max: timing.max_updates.max(1),
            window: timing.window,
        }
    }

    /// How long until another update may go out at `now`, if it can't yet.
    fn delay(&mut self, now: Instant) -> Option<Duration> {
        while self
            .sent
            .front()
            .is_some_and(|sent| now.saturating_duration_since(*sent) >= self.window)
        {
            self.sent.pop_front();
        }
        if self.sent.len() < self.max {
            return None;
        }
        self.sent
            .front()
            .map(|oldest| (*oldest + self.window).saturating_duration_since(now))
    }

    fn record(&mut self, now: Instant) {
        self.sent.push_back(now);
    }
}

fn log(message: std::fmt::Arguments<'_>) {
    if debug_log_enabled() {
        eprintln!("[kiro-presence] {message}");
    }
}

pub(super) fn run(shared: &Shared, mut ipc: Box<dyn Ipc>, timing: Timing) {
    let mut connected = false;
    // What Discord shows from this connection.
    let mut shown: Option<Activity> = None;
    // No attempt before then (retrying, or rate limited).
    let mut not_before: Option<Instant> = None;
    let mut backoff = Backoff::new(&timing);
    let mut rate = RateLimit::new(&timing);

    loop {
        let (target, enabled) = {
            let mut desired = shared.desired();
            loop {
                if desired.quit {
                    break;
                }
                let work = if desired.options.enabled {
                    desired.activity != shown
                } else {
                    connected
                };
                if !work {
                    desired = shared
                        .changed
                        .wait(desired)
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    continue;
                }
                let wait = not_before.map_or(Duration::ZERO, |at| {
                    at.saturating_duration_since(Instant::now())
                });
                if wait.is_zero() {
                    break;
                }
                desired = shared
                    .changed
                    .wait_timeout(desired, wait)
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .0;
            }
            if desired.quit {
                drop(desired);
                if connected {
                    let _ = ipc.clear_activity();
                    ipc.close();
                    log(format_args!("cleared and disconnected (quitting)"));
                }
                let mut desired = shared.desired();
                desired.finished = true;
                shared.changed.notify_all();
                return;
            }
            (desired.activity.clone(), desired.options.enabled)
        };
        not_before = None;
        let now = Instant::now();

        if !enabled {
            let _ = ipc.clear_activity();
            ipc.close();
            connected = false;
            shown = None;
            log(format_args!("cleared and disconnected (turned off)"));
            continue;
        }

        if !connected {
            if target.is_none() {
                // Nothing is shown without a connection.
                shown = None;
                continue;
            }
            match ipc.connect() {
                Ok(()) => {
                    connected = true;
                    shown = None;
                    backoff.reset();
                    log(format_args!("connected to Discord"));
                }
                Err(IpcError::Disconnected(error) | IpcError::Rejected(error)) => {
                    let wait = backoff.failed();
                    not_before = Some(now + wait);
                    log(format_args!(
                        "Discord isn't available ({error}); trying again in {wait:?}"
                    ));
                    continue;
                }
            }
        }

        if let Some(wait) = rate.delay(now) {
            not_before = Some(now + wait);
            continue;
        }
        rate.record(now);
        let result = match &target {
            Some(activity) => ipc.set_activity(activity),
            None => ipc.clear_activity(),
        };
        match result {
            Ok(()) => {
                log(format_args!("showing {target:?}"));
                shown = target;
            }
            Err(IpcError::Rejected(error)) => {
                log(format_args!("Discord refused {target:?}: {error}"));
                shown = target;
            }
            Err(IpcError::Disconnected(error)) => {
                ipc.close();
                connected = false;
                shown = None;
                let wait = backoff.failed();
                not_before = Some(now + wait);
                log(format_args!(
                    "lost Discord ({error}); trying again in {wait:?}"
                ));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::super::{NowPlaying, PlayerView, Presence, PresenceOptions};
    use super::*;
    use crate::media::model::PlaybackState;

    #[test]
    fn backoff_doubles_up_to_the_maximum_and_resets() {
        let mut backoff = Backoff::new(&Timing::default());
        let waits: Vec<u64> = (0..6).map(|_| backoff.failed().as_secs()).collect();
        assert_eq!(waits, [5, 10, 20, 40, 60, 60]);
        backoff.reset();
        assert_eq!(backoff.failed().as_secs(), 5);
    }

    #[test]
    fn at_most_five_updates_in_twenty_seconds() {
        let mut rate = RateLimit::new(&Timing::default());
        let start = Instant::now();
        let at = |seconds: u64| start + Duration::from_secs(seconds);
        for second in 0..5 {
            assert_eq!(rate.delay(at(second)), None);
            rate.record(at(second));
        }
        // The sixth waits until the first is 20 s old.
        assert_eq!(rate.delay(at(5)), Some(Duration::from_secs(15)));
        assert_eq!(rate.delay(at(20)), None);
        rate.record(at(20));
        assert_eq!(rate.delay(at(20)), Some(Duration::from_secs(1)));
    }

    /// Discord as a script: connection attempts fail until `up`, and sending
    /// fails once `drop_next` is set.
    #[derive(Default)]
    struct Discord {
        up: bool,
        drop_next: bool,
        calls: Vec<String>,
    }

    struct Fake(Arc<Mutex<Discord>>);

    impl Ipc for Fake {
        fn connect(&mut self) -> Result<(), IpcError> {
            let mut discord = self.0.lock().unwrap();
            discord.calls.push("connect".into());
            if discord.up {
                Ok(())
            } else {
                Err(IpcError::Disconnected("not running".into()))
            }
        }
        fn set_activity(&mut self, activity: &Activity) -> Result<(), IpcError> {
            let mut discord = self.0.lock().unwrap();
            if std::mem::take(&mut discord.drop_next) {
                discord.up = false;
                discord.calls.push("broken".into());
                return Err(IpcError::Disconnected("broken pipe".into()));
            }
            discord.calls.push(format!("set {:?}", activity.state));
            Ok(())
        }
        fn clear_activity(&mut self) -> Result<(), IpcError> {
            self.0.lock().unwrap().calls.push("clear".into());
            Ok(())
        }
        fn close(&mut self) {
            self.0.lock().unwrap().calls.push("close".into());
        }
    }

    fn presence(discord: &Arc<Mutex<Discord>>) -> Presence {
        let discord = discord.clone();
        let presence = Presence::new(
            Box::new(move || Box::new(Fake(discord.clone()))),
            Timing::fast(),
            true,
        );
        presence.set_options(PresenceOptions {
            enabled: true,
            show_title: true,
            show_episode: true,
        });
        presence.set_media(Some(
            NowPlaying::new("Show", Some(1), Some(2), None).unwrap(),
        ));
        presence
    }

    fn player(state: PlaybackState) -> PlayerView {
        PlayerView {
            state,
            position: Some(1.0),
            duration: None,
        }
    }

    fn eventually(discord: &Arc<Mutex<Discord>>, done: impl Fn(&[String]) -> bool) -> Vec<String> {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let calls = discord.lock().unwrap().calls.clone();
            if done(&calls) || Instant::now() > deadline {
                return calls;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn waits_for_discord_to_start_and_comes_back_after_it_quits() {
        let discord = Arc::new(Mutex::new(Discord::default()));
        let presence = presence(&discord);
        presence.sync_player(player(PlaybackState::Playing));

        // Not running: a few gentle attempts.
        let calls = eventually(&discord, |calls| calls.len() >= 3);
        assert!(calls.iter().all(|call| call == "connect"), "{calls:?}");

        // Discord starts: the activity appears.
        discord.lock().unwrap().up = true;
        let calls = eventually(&discord, |calls| {
            calls.contains(&"set Some(\"S1 E2\")".into())
        });
        assert_eq!(calls.last().unwrap(), "set Some(\"S1 E2\")");

        // Discord quits mid-way; when it's back, the latest activity shows.
        discord.lock().unwrap().drop_next = true;
        presence.sync_player(player(PlaybackState::Paused));
        eventually(&discord, |calls| calls.contains(&"broken".into()));
        discord.lock().unwrap().up = true;
        let calls = eventually(&discord, |calls| {
            calls.last().map(String::as_str) == Some("set Some(\"S1 E2 · Paused\")")
        });
        let broken = calls.iter().position(|call| call == "broken").unwrap();
        assert_eq!(calls[broken + 1], "close");
        assert_eq!(calls.last().unwrap(), "set Some(\"S1 E2 · Paused\")");

        presence.shutdown(Duration::from_secs(5));
        let calls = discord.lock().unwrap().calls.clone();
        assert_eq!(&calls[calls.len() - 2..], ["clear", "close"]);
    }

    #[test]
    fn stops_retrying_once_there_is_nothing_to_show() {
        let discord = Arc::new(Mutex::new(Discord::default()));
        let presence = presence(&discord);
        presence.sync_player(player(PlaybackState::Playing));
        eventually(&discord, |calls| !calls.is_empty());
        presence.sync_player(player(PlaybackState::Ended));
        // Let any attempt already scheduled run, then expect silence.
        std::thread::sleep(Duration::from_millis(100));
        let attempts = discord.lock().unwrap().calls.len();
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(discord.lock().unwrap().calls.len(), attempts);
        presence.shutdown(Duration::from_secs(5));
        // Never connected: nothing to clear.
        assert!(
            discord
                .lock()
                .unwrap()
                .calls
                .iter()
                .all(|call| call == "connect")
        );
    }

    #[test]
    fn quick_changes_are_merged_within_the_rate_limit() {
        let discord = Arc::new(Mutex::new(Discord {
            up: true,
            ..Discord::default()
        }));
        let presence = presence(&discord);
        for _ in 0..20 {
            presence.sync_player(player(PlaybackState::Playing));
            presence.sync_player(player(PlaybackState::Paused));
        }
        presence.sync_player(player(PlaybackState::Playing));
        let calls = eventually(&discord, |calls| {
            calls.last().map(String::as_str) == Some("set Some(\"S1 E2\")")
        });
        let sets = calls.iter().filter(|call| call.starts_with("set")).count();
        assert!(sets <= 5, "{calls:?}");
        presence.shutdown(Duration::from_secs(5));
    }
}
