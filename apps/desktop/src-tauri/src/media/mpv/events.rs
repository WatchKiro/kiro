//! mpv's event loop, on a dedicated thread.
//!
//! mpv pushes property changes for everything in [`OBSERVED`] plus lifecycle
//! events (start/end of file, seeks). The thread turns each into a
//! [`Change`], feeds it to the shared [`PlayerModel`](crate::media::model::PlayerModel)
//! and forwards the resulting events to the renderer. Nothing polls.
//!
//! While audio passthrough is on it also reads mpv's log, for the one line
//! that says the audio output refused a passthrough format
//! ([`passthrough_refused`]).

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use super::client::{self, Event, Format, Mpv, PropertyData};
use super::ffi::error as mpv_error;
use super::{RenderStats, Shared, debug_log_enabled, debug_stats, mpv_error_message};
use crate::media::model::{Change, FailureCode, PlayerFailure};
use crate::media::passthrough::FALLBACK_MESSAGE;

/// Properties the player observes, by observation id (index + 1). Formats are
/// limited to what [`client`] decodes in events (no `Node`): `track-list`,
/// `chapter-list` and `demuxer-cache-state` arrive as JSON strings.
const OBSERVED: &[(&str, Format)] = &[
    ("idle-active", Format::Flag),
    ("pause", Format::Flag),
    ("eof-reached", Format::Flag),
    ("time-pos", Format::Double),
    ("duration", Format::Double),
    ("paused-for-cache", Format::Flag),
    ("cache-buffering-state", Format::Int64),
    ("track-list", Format::String),
    ("chapter-list", Format::String),
    ("demuxer-cache-state", Format::String),
    ("seeking", Format::Flag),
    ("volume", Format::Double),
    ("mute", Format::Flag),
    ("sub-delay", Format::Double),
    ("audio-delay", Format::Double),
    ("speed", Format::Double),
];

/// How often `KIRO_SPIKE_LOG` prints mpv stats.
const STATS_LOG_INTERVAL: Duration = Duration::from_secs(2);

pub fn observe(mpv: &Mpv) -> client::Result<()> {
    for (id, (name, format)) in (1..).zip(OBSERVED) {
        mpv.observe_property(name, *format, id)?;
    }
    Ok(())
}

pub fn spawn(
    mpv: Arc<Mpv>,
    shared: Arc<Shared>,
    stats: Arc<RenderStats>,
    stop: Arc<AtomicBool>,
) -> std::io::Result<JoinHandle<()>> {
    std::thread::Builder::new()
        .name("kiro-mpv-events".into())
        .spawn(move || run(&mpv, &shared, &stats, &stop))
}

/// Interrupts the event thread's wait so it can notice its stop flag.
pub fn wake(mpv: &Mpv) {
    mpv.wakeup();
}

fn run(mpv: &Mpv, shared: &Shared, stats: &RenderStats, stop: &AtomicBool) {
    let log = debug_log_enabled();
    let mut last_stats_log = Instant::now();
    // Without logging, block until mpv has something to say.
    let timeout = if log {
        STATS_LOG_INTERVAL.as_secs_f64()
    } else {
        -1.0
    };

    while !stop.load(Ordering::Acquire) {
        let change = match mpv.wait_event(timeout) {
            // A wakeup, a timeout, or a property that became unavailable.
            None => None,
            Some(Ok(Event::Shutdown)) => break,
            Some(Ok(Event::LogMessage { prefix, text })) => {
                if prefix == "cplayer" && text.starts_with(FALLBACK_MESSAGE) {
                    passthrough_refused(mpv, shared);
                }
                None
            }
            Some(Ok(Event::StartFile)) => {
                // A new stream tries every chosen format again.
                shared.spdif().new_stream();
                let _ = shared.apply_spdif(mpv);
                Some(Change::StartFile)
            }
            Some(Ok(event)) => to_change(event),
            // Failed `end-file` events arrive as errors; nothing else we use
            // completes asynchronously.
            Some(Err(error)) => Some(Change::Failed(failure(&error))),
        };
        if let Some(change) = change {
            let events = shared.model().apply(change, Instant::now());
            shared.emit(events);
        }
        // Also after a wakeup: the setting may have changed.
        shared.sync_keep_awake();
        shared.sync_presence();
        if log && last_stats_log.elapsed() >= STATS_LOG_INTERVAL {
            last_stats_log = Instant::now();
            let state = shared.model().state();
            eprintln!("[kiro-player] {state:?} {:?}", debug_stats(mpv, stats));
        }
    }
}

/// No audio output took the passthrough format of the track playing, and
/// mpv fell back to decoding it. mpv 0.41 then stalls: it never opens an
/// output for the decoded audio, and video waits for it. Dropping the codec
/// from `audio-spdif` re-creates the decoder and playback carries on,
/// decoded, for the rest of the stream; if there is nothing to drop, an
/// exact seek to where playback is restarts it the same way.
fn passthrough_refused(mpv: &Mpv, shared: &Shared) {
    let codec = mpv
        .get_property::<String>("audio-codec-name")
        .unwrap_or_default();
    let dropped = shared.spdif().refuse(&codec);
    let result = if dropped {
        shared.apply_spdif(mpv).map(|_| ())
    } else {
        mpv.command("seek", &["0", "relative+exact"])
    };
    let now = mpv
        .get_property::<String>("audio-spdif")
        .unwrap_or_default();
    eprintln!(
        "[kiro-player] audio passthrough: the audio output refused {codec}, decoding it \
         (passing through: {}){}",
        if now.is_empty() { "nothing" } else { &now },
        match result {
            Ok(()) => String::new(),
            Err(error) => format!(", restarting audio failed: {error:?}"),
        }
    );
}

fn to_change(event: Event) -> Option<Change> {
    Some(match event {
        Event::StartFile => Change::StartFile,
        Event::FileLoaded => Change::FileLoaded,
        Event::PlaybackRestart => Change::PlaybackRestart,
        Event::PropertyChange { id, data } => {
            let (name, _) = OBSERVED.get(usize::try_from(id).ok()?.checked_sub(1)?)?;
            property_change(name, data)?
        }
        _ => return None,
    })
}

fn property_change(name: &str, data: PropertyData) -> Option<Change> {
    use PropertyData::{Double, Flag, Int64, Str};
    Some(match (name, data) {
        ("idle-active", Flag(value)) => Change::Idle(value),
        ("pause", Flag(value)) => Change::Paused(value),
        ("eof-reached", Flag(value)) => Change::EofReached(value),
        ("time-pos", Double(value)) => Change::Position(Some(value)),
        ("duration", Double(value)) => Change::Duration(Some(value)),
        ("paused-for-cache", Flag(value)) => Change::PausedForCache(value),
        ("cache-buffering-state", Int64(value)) => Change::CacheBufferingState(value),
        ("track-list", Str(json)) => Change::TrackList(json),
        ("chapter-list", Str(json)) => Change::ChapterList(json),
        ("demuxer-cache-state", Str(json)) => Change::CacheState(json),
        ("seeking", Flag(value)) => Change::Seeking(value),
        ("volume", Double(value)) => Change::Volume(value),
        ("mute", Flag(value)) => Change::Muted(value),
        ("sub-delay", Double(value)) => Change::SubtitleDelay(value),
        ("audio-delay", Double(value)) => Change::AudioDelay(value),
        ("speed", Double(value)) => Change::Speed(value),
        _ => return None,
    })
}

fn failure(error: &client::Error) -> PlayerFailure {
    let code = match error {
        client::Error::Raw(mpv_error::LOADING_FAILED) => FailureCode::Network,
        client::Error::Raw(mpv_error::UNKNOWN_FORMAT) => FailureCode::UnsupportedSource,
        client::Error::Raw(
            mpv_error::NOTHING_TO_PLAY | mpv_error::AO_INIT_FAILED | mpv_error::VO_INIT_FAILED,
        ) => FailureCode::Decode,
        _ => FailureCode::Unknown,
    };
    PlayerFailure {
        code,
        message: mpv_error_message(error).to_owned(),
        // Network failures (expired links, dropped connections) can
        // succeed on a reload; a format mpv cannot read will not.
        recoverable: matches!(code, FailureCode::Network | FailureCode::Unknown),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::sync::mpsc;

    use super::*;
    use crate::media::model::{PlaybackState, PlayerEvent, TrackKind};

    /// A headless mpv (no video surface) with the real event thread
    /// forwarding its events to the returned receiver.
    struct Headless {
        mpv: Arc<Mpv>,
        shared: Arc<Shared>,
        events: mpsc::Receiver<PlayerEvent>,
        stop: Arc<AtomicBool>,
        thread: JoinHandle<()>,
    }

    impl Headless {
        fn start() -> Self {
            let mpv = Mpv::with_initializer(|init| {
                init.set_option("vo", "null")?;
                init.set_option("ao", "null")?;
                init.set_option("idle", "yes")?;
                init.set_option("keep-open", "yes")?;
                Ok(())
            })
            .expect("mpv should initialise");
            let mpv = Arc::new(mpv);
            observe(&mpv).unwrap();

            let (tx, events) = mpsc::channel::<PlayerEvent>();
            let tx = Mutex::new(tx);
            let shared = Arc::new(Shared::new(Box::new(move |event| {
                let _ = tx.lock().unwrap().send(event);
            })));
            let stop = Arc::new(AtomicBool::new(false));
            let thread = spawn(
                mpv.clone(),
                shared.clone(),
                Arc::new(RenderStats::default()),
                stop.clone(),
            )
            .unwrap();
            Self {
                mpv,
                shared,
                events,
                stop,
                thread,
            }
        }

        /// Collects events until one matches `done`, failing after 15 s.
        fn until(&self, done: impl Fn(&PlayerEvent) -> bool) -> Vec<PlayerEvent> {
            let mut events = Vec::new();
            let deadline = Instant::now() + Duration::from_secs(15);
            while !events.last().is_some_and(&done) {
                let left = deadline.saturating_duration_since(Instant::now());
                match self.events.recv_timeout(left) {
                    Ok(event) => events.push(event),
                    Err(_) => panic!("the awaited event never came; got {events:#?}"),
                }
            }
            events
        }

        /// Shuts down as `MpvPlayer::drop` does: the thread exits on wakeup.
        fn stop(self) {
            self.stop.store(true, Ordering::Release);
            wake(&self.mpv);
            self.thread.join().unwrap();
            drop(self.shared);
            assert_eq!(Arc::strong_count(&self.mpv), 1);
        }
    }

    /// Runs the real event thread against a headless mpv, playing a
    /// one-second lavfi test pattern to its end.
    #[test]
    fn follows_a_short_file_to_the_end() {
        let headless = Headless::start();
        let mpv = &headless.mpv;
        let shared = &headless.shared;
        mpv.command(
            "loadfile",
            &[
                "av://lavfi:testsrc=duration=1:size=64x48:rate=25",
                "replace",
            ],
        )
        .unwrap();

        let ended = PlayerEvent::StateChange {
            state: PlaybackState::Ended,
        };
        let events = headless.until(|event| *event == ended);

        let states: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                PlayerEvent::StateChange { state } => Some(*state),
                _ => None,
            })
            .collect();
        // keep-open pauses at the end just before reporting `eof-reached`.
        assert_eq!(states.first(), Some(&PlaybackState::Loading));
        assert_eq!(states[1], PlaybackState::Playing);
        assert_eq!(states.last(), Some(&PlaybackState::Ended));
        assert!(events.contains(&PlayerEvent::Ended {}));
        // The display assertion taken while playing is back once it ended.
        assert!(!shared.keep_awake().is_held());
        assert!(events.iter().any(|e| matches!(
            e,
            PlayerEvent::TracksChange { tracks } if tracks.iter().any(|t| t.kind == TrackKind::Video)
        )));
        assert!(events.iter().any(|e| matches!(
            e,
            PlayerEvent::TimeUpdate { position, duration: Some(_) } if *position > 0.5
        )));

        headless.stop();
    }

    /// Subtitle delay, audio delay and speed reach the renderer as
    /// `timingChange`, from mpv's own values.
    #[test]
    fn reports_delays_and_speed() {
        let headless = Headless::start();
        let timing = |subtitle_delay, audio_delay, speed| PlayerEvent::TimingChange {
            subtitle_delay,
            audio_delay,
            speed,
        };

        headless.mpv.set_property("sub-delay", 0.1 + 0.2).unwrap();
        headless.until(|event| *event == timing(0.3, 0.0, 1.0));
        headless.mpv.set_property("audio-delay", -0.2).unwrap();
        headless.until(|event| *event == timing(0.3, -0.2, 1.0));
        headless.mpv.set_property("speed", 1.5).unwrap();
        headless.until(|event| *event == timing(0.3, -0.2, 1.5));

        let snapshot = headless.shared.model().snapshot();
        assert_eq!(
            (
                snapshot.subtitle_delay,
                snapshot.audio_delay,
                snapshot.speed
            ),
            (0.3, -0.2, 1.5)
        );
        headless.stop();
    }
}
