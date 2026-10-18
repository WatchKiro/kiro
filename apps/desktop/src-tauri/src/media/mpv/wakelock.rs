//! The system's "keep the display awake" assertion, for
//! [`KeepAwake`](crate::media::keep_awake::KeepAwake): an IOPMAssertion
//! (`PreventUserIdleDisplaySleep`) on macOS, `org.freedesktop.ScreenSaver`
//! `Inhibit` over D-Bus on Linux. Check it with `pmset -g assertions` or
//! `gnome-session-inhibit --list`.

use crate::media::keep_awake::Wakelock;

/// What `pmset -g assertions` and the desktop's inhibitor list show.
const REASON: &str = "Kiro is playing video";

pub struct SystemWakelock;

impl Wakelock for SystemWakelock {
    type Hold = keepawake::KeepAwake;

    fn acquire(&mut self) -> Result<Self::Hold, String> {
        keepawake::Builder::default()
            .display(true)
            .reason(REASON)
            .app_name("Kiro")
            .app_reverse_domain("app.kiro.desktop")
            .create()
            .map_err(|error| error.to_string())
    }
}
