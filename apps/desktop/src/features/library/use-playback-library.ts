/**
 * The player's link to the library: saves playback progress and resumes
 * from saved progress.
 *
 * It only consumes {@link PlaybackSample}s, so it works the same whether the
 * player polls its status or pushes events.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { resumePosition } from '@/features/library/library-data';
import { libraryStore } from '@/features/library/library-store';
import {
  ProgressTracker,
  type PlaybackSample,
  type ProgressPoint,
} from '@/features/library/progress-tracker';
import type { PlaybackMedia } from '@/features/playback/playback-request';
import { useSettingsStore } from '@/features/settings/settings-store';

type Resume =
  /** Looking up saved progress; playback waits for this. */
  | { status: 'loading' }
  /** Nothing to resume: start from the beginning. */
  | { status: 'none' }
  /** Saved progress found, not yet used. */
  | { status: 'saved'; position: number }
  /** Playback was started from saved progress. */
  | { status: 'resumed'; position: number }
  /** Told where to start (a stream switch): no lookup, no question. */
  | { status: 'given'; position: number; resumed: boolean };

export interface PlaybackLibrary {
  /**
   * Whether playback can start: saved progress has been looked up, the
   * resume setting is known and, when it is "ask", the viewer has answered.
   */
  ready: boolean;
  /** Saved progress the viewer is being asked about ("ask"), until {@link answer}. */
  asking: number | null;
  /** Answers {@link asking}: resume from the saved position, or start from the beginning. */
  answer: (resume: boolean) => void;
  /**
   * The position to start playback from (saved progress), or `null` to start
   * from the beginning. Call once, when loading the stream.
   */
  takeStartPosition: () => number | null;
  /** Where {@link takeStartPosition} started playback (0: the beginning). */
  startPosition: number;
  /** Where playback was resumed from, while that's worth showing. */
  resumedFrom: number | null;
  /** Restart from the beginning after resuming; returns the position to seek to. */
  startOver: () => number;
  /** Hides the "resumed" notice. */
  dismissResumed: () => void;
}

/**
 * Resuming follows Settings → Playback → "Resume playback":
 * - `always` (the default, like most streaming apps): resume from saved
 *   progress automatically (via the player's start position rather than a
 *   seek after starting), with a "Start over" notice;
 * - `ask`: before starting, ask whether to resume ({@link PlaybackLibrary.asking});
 * - `never`: start from the beginning. Progress is still saved, so Continue
 *   watching and the Library keep showing it.
 *
 * A stream opened in place of another one (`start`, from a fallback or a
 * stream picked in the player) starts where that one was instead: the
 * setting was already applied, and the viewer already answered.
 */
export function usePlaybackLibrary(
  media: PlaybackMedia | undefined,
  sample: PlaybackSample | null,
  start?: { position: number; resumed: boolean },
): PlaybackLibrary {
  const [resume, setResume] = useState<Resume>(() =>
    start ? { status: 'given', ...start } : { status: media ? 'loading' : 'none' },
  );
  /** Whether saved progress needs looking up; fixed for the hook's life. */
  const [lookUp] = useState(start === undefined);
  const [startPosition, setStartPosition] = useState(0);
  const [noticeVisible, setNoticeVisible] = useState(true);
  /** The viewer's answer when asked: resume (`true`) or start over. */
  const [answer, setAnswer] = useState<boolean | null>(null);
  const settingsStatus = useSettingsStore((state) => state.status);
  const mode = useSettingsStore((state) => state.settings.playback.resume);
  const loadSettings = useSettingsStore((state) => state.load);
  useEffect(() => void loadSettings(), [loadSettings]);
  // Settings that fail to load leave the default: resume.
  const settingsKnown = settingsStatus === 'ready' || settingsStatus === 'error';
  const asking = settingsKnown && mode === 'ask' && resume.status === 'saved' && answer === null;
  const [tracker] = useState(() => new ProgressTracker());
  const resumeRef = useRef(resume);
  useEffect(() => {
    resumeRef.current = resume;
  }, [resume]);

  // Look up saved progress for this video. A failed lookup only means
  // starting from the beginning.
  useEffect(() => {
    if (!media || !lookUp) return;
    let active = true;
    libraryStore
      .getState()
      .loadTitle(media.title.type, media.title.id)
      .then(
        (state) => {
          if (!active) return;
          const position = resumePosition(
            state?.progress.find((entry) => entry.video.id === media.video.id),
          );
          setResume(position === null ? { status: 'none' } : { status: 'saved', position });
        },
        () => active && setResume({ status: 'none' }),
      );
    return () => {
      active = false;
    };
  }, [media, lookUp]);

  // Saving waits for the lookup, so early samples can't replace saved progress.
  useProgressRecorder(tracker, media, sample, resume.status !== 'loading');

  const takeStartPosition = useCallback(() => {
    const current = resumeRef.current;
    if (current.status === 'given') {
      const { position, resumed } = current;
      setResume(resumed ? { status: 'resumed', position } : { status: 'none' });
      if (position <= 0) return null;
      setStartPosition(position);
      // As when resuming, samples from before the start can't be saved; the
      // position itself was saved by the stream this one replaces.
      tracker.startAt(position, Date.now());
      return position;
    }
    if (current.status !== 'saved') return null;
    if (mode === 'never' || (mode === 'ask' && answer !== true)) {
      setResume({ status: 'none' });
      return null;
    }
    // Until playback reaches the saved position, ignore samples from before it.
    tracker.expectSeek(current.position, Date.now());
    setResume({ status: 'resumed', position: current.position });
    setStartPosition(current.position);
    // Having just chosen to resume, there's no need to say so.
    if (mode === 'ask') setNoticeVisible(false);
    return current.position;
  }, [tracker, mode, answer]);

  const startOver = useCallback(() => {
    tracker.expectSeek(0, Date.now());
    setNoticeVisible(false);
    return 0;
  }, [tracker]);

  const dismissResumed = useCallback(() => setNoticeVisible(false), []);

  return {
    ready: resume.status !== 'loading' && settingsKnown && !asking,
    asking: asking && resume.status === 'saved' ? resume.position : null,
    answer: setAnswer,
    takeStartPosition,
    startPosition,
    resumedFrom: resume.status === 'resumed' && noticeVisible ? resume.position : null,
    startOver,
    dismissResumed,
  };
}

/** Saves progress as {@link ProgressTracker} decides. */
function useProgressRecorder(
  tracker: ProgressTracker,
  media: PlaybackMedia | undefined,
  sample: PlaybackSample | null,
  enabled: boolean,
) {
  const enabledRef = useRef(enabled);

  const save = useCallback(
    (point: ProgressPoint | null) => {
      if (!media || !point) return;
      // Losing one progress update is harmless; the next one replaces it.
      libraryStore
        .getState()
        .recordProgress({ ...media, ...point })
        .catch(() => undefined);
    },
    [media],
  );

  useEffect(() => {
    enabledRef.current = enabled;
    if (media && enabled && sample) save(tracker.next(sample, Date.now()));
  }, [media, enabled, sample, save, tracker]);

  // Leaving the player (or closing the window) saves the latest position.
  useEffect(() => {
    if (!media) return;
    const flush = () => {
      if (enabledRef.current) save(tracker.flush(Date.now()));
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [media, save, tracker]);
}
