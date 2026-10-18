//! Keeping the display awake while video plays.
//!
//! mpv stops the screensaver itself only when it owns the video window
//! (`stop-screensaver`). Where Kiro draws the video through mpv's render API
//! (macOS, Linux), the player holds the system's "keep the display awake"
//! assertion instead, through a [`Wakelock`].
//!
//! [`KeepAwake`] follows the player's [`PlaybackState`]: it holds the
//! assertion only while the state is `Playing` (which includes buffering in
//! the middle of playback) and the setting is on, and gives it back on pause,
//! end, error, idle and when the player goes away. Kept free of platform
//! types so it compiles (and is tested) in every build.

use super::model::PlaybackState;

/// Whether playback in `state` keeps the display awake.
pub fn keeps_display_awake(state: PlaybackState) -> bool {
    state == PlaybackState::Playing
}

/// Takes the platform's "keep the display awake" assertion. Dropping the
/// returned hold gives it back.
pub trait Wakelock {
    type Hold;
    fn acquire(&mut self) -> Result<Self::Hold, String>;
}

/// For a player whose mpv owns the video window and so stops the screensaver
/// itself (`stop-screensaver`, e.g. on Windows): holds nothing.
pub struct NoWakelock;

impl Wakelock for NoWakelock {
    type Hold = ();
    fn acquire(&mut self) -> Result<(), String> {
        Ok(())
    }
}

/// What [`KeepAwake`] just did, for the logs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Transition {
    Held,
    Released,
    /// The assertion could not be taken; it is tried again the next time
    /// playback starts.
    Failed(String),
}

/// Holds a [`Wakelock`] exactly while the player is playing and the setting
/// ("Keep the screen on while playing") is on.
pub struct KeepAwake<W: Wakelock> {
    wakelock: W,
    enabled: bool,
    /// The last state seen by [`Self::sync`].
    state: PlaybackState,
    /// Whether the assertion should be held. Only a change of this calls the
    /// platform, so a failure isn't retried on every event.
    wanted: bool,
    hold: Option<W::Hold>,
    /// After [`Self::stop`], nothing is held again.
    stopped: bool,
}

impl<W: Wakelock> KeepAwake<W> {
    pub fn new(wakelock: W) -> Self {
        Self {
            wakelock,
            enabled: true,
            state: PlaybackState::Idle,
            wanted: false,
            hold: None,
            stopped: false,
        }
    }

    pub fn is_held(&self) -> bool {
        self.hold.is_some()
    }

    /// Turns the setting on or off. Takes effect at the next [`Self::sync`].
    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }

    /// Takes or gives back the assertion to match `state`.
    pub fn sync(&mut self, state: PlaybackState) -> Option<Transition> {
        self.state = state;
        let wanted = !self.stopped && self.enabled && keeps_display_awake(state);
        if wanted == self.wanted {
            return None;
        }
        self.wanted = wanted;
        if wanted {
            Some(match self.wakelock.acquire() {
                Ok(hold) => {
                    self.hold = Some(hold);
                    Transition::Held
                }
                Err(error) => Transition::Failed(error),
            })
        } else {
            self.hold.take().map(|_| Transition::Released)
        }
    }

    /// [`Self::sync`] with the last state seen, e.g. after the setting changed.
    pub fn resync(&mut self) -> Option<Transition> {
        self.sync(self.state)
    }

    /// Gives the assertion back for good: the player is going away, or the
    /// app is quitting.
    pub fn stop(&mut self) -> Option<Transition> {
        self.stopped = true;
        self.resync()
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::rc::Rc;

    use super::*;
    use PlaybackState::{Ended, Error, Idle, Loading, Paused, Playing, Ready};

    /// Counts the assertions currently held.
    #[derive(Default)]
    struct FakeWakelock {
        held: Rc<Cell<u32>>,
        acquired: u32,
        fail: bool,
    }

    struct FakeHold(Rc<Cell<u32>>);

    impl Drop for FakeHold {
        fn drop(&mut self) {
            self.0.set(self.0.get() - 1);
        }
    }

    impl Wakelock for FakeWakelock {
        type Hold = FakeHold;
        fn acquire(&mut self) -> Result<FakeHold, String> {
            if self.fail {
                return Err("no screensaver service".into());
            }
            self.acquired += 1;
            self.held.set(self.held.get() + 1);
            Ok(FakeHold(self.held.clone()))
        }
    }

    fn keep_awake() -> (KeepAwake<FakeWakelock>, Rc<Cell<u32>>) {
        let wakelock = FakeWakelock::default();
        let held = wakelock.held.clone();
        (KeepAwake::new(wakelock), held)
    }

    #[test]
    fn only_playing_keeps_the_display_awake() {
        let awake: Vec<_> = [Idle, Loading, Ready, Playing, Paused, Ended, Error]
            .into_iter()
            .filter(|state| keeps_display_awake(*state))
            .collect();
        assert_eq!(awake, [Playing]);
    }

    #[test]
    fn holds_while_playing_and_releases_on_pause_end_and_error() {
        let (mut keep, held) = keep_awake();
        assert_eq!(keep.sync(Loading), None);
        assert_eq!(keep.sync(Playing), Some(Transition::Held));
        assert_eq!(held.get(), 1);
        assert_eq!(keep.sync(Paused), Some(Transition::Released));
        assert_eq!(held.get(), 0);
        assert_eq!(keep.sync(Playing), Some(Transition::Held));
        assert_eq!(keep.sync(Ended), Some(Transition::Released));
        assert_eq!(keep.sync(Playing), Some(Transition::Held));
        assert_eq!(keep.sync(Error), Some(Transition::Released));
        assert_eq!(keep.sync(Loading), None);
        assert_eq!(keep.sync(Playing), Some(Transition::Held));
        // `stop` (the player went idle, e.g. on detach).
        assert_eq!(keep.sync(Idle), Some(Transition::Released));
        assert_eq!(held.get(), 0);
        assert_eq!(keep.wakelock.acquired, 4);
    }

    #[test]
    fn repeated_states_take_one_assertion() {
        let (mut keep, held) = keep_awake();
        for _ in 0..3 {
            keep.sync(Playing);
        }
        assert_eq!(held.get(), 1);
        assert_eq!(keep.wakelock.acquired, 1);
        assert!(keep.is_held());
    }

    #[test]
    fn the_setting_turns_it_off_and_on_while_playing() {
        let (mut keep, held) = keep_awake();
        keep.sync(Playing);
        keep.set_enabled(false);
        assert_eq!(keep.resync(), Some(Transition::Released));
        assert_eq!(held.get(), 0);
        assert_eq!(keep.sync(Paused), None);
        assert_eq!(keep.sync(Playing), None);
        assert_eq!(held.get(), 0);
        keep.set_enabled(true);
        assert_eq!(keep.resync(), Some(Transition::Held));
        assert_eq!(held.get(), 1);
    }

    #[test]
    fn stop_releases_for_good() {
        let (mut keep, held) = keep_awake();
        keep.sync(Playing);
        assert_eq!(keep.stop(), Some(Transition::Released));
        assert_eq!(held.get(), 0);
        // A late event from the player doesn't take it again.
        assert_eq!(keep.sync(Playing), None);
        assert_eq!(keep.stop(), None);
        assert_eq!(held.get(), 0);
    }

    #[test]
    fn dropping_releases() {
        let (mut keep, held) = keep_awake();
        keep.sync(Playing);
        drop(keep);
        assert_eq!(held.get(), 0);
    }

    #[test]
    fn a_failure_is_retried_when_playback_next_starts() {
        let (mut keep, held) = keep_awake();
        keep.wakelock.fail = true;
        assert_eq!(
            keep.sync(Playing),
            Some(Transition::Failed("no screensaver service".into()))
        );
        // Not retried on every event while playing…
        assert_eq!(keep.sync(Playing), None);
        assert_eq!(keep.sync(Paused), None);
        // …but on the next start.
        keep.wakelock.fail = false;
        assert_eq!(keep.sync(Playing), Some(Transition::Held));
        assert_eq!(held.get(), 1);
    }
}
