import { useCallback, useEffect, useRef, useState } from 'react';

import type { NativePlayer, NativePlayerView } from '@/features/playback/native-player';
import {
  DELAY_STEP,
  NO_TIMING,
  type DelayKind,
  clampSpeed,
  rememberSpeed,
  rememberedSpeed,
  stepDelay,
  stepSpeed,
  subtitleDelayFor,
  timingNotice,
  withSubtitleDelay,
} from '@/features/playback/timing';

/** A brief message over the video; `id` restarts its timer when the text repeats. */
export interface TimingNotice {
  id: number;
  text: string;
}

export interface PlayerTiming {
  /** What the current subtitle track and the stream are set to. */
  subtitleDelay: number;
  audioDelay: number;
  speed: number;
  /** Whether a subtitle track is showing (its delay can be changed). */
  subtitlesOn: boolean;
  /** Moves a delay by `steps` of 0.1 s (negative: earlier). */
  nudge: (kind: DelayKind, steps: number) => void;
  resetDelay: (kind: DelayKind) => void;
  setSpeed: (speed: number) => void;
  /** The next preset speed up (`1`) or down (`-1`). */
  stepSpeed: (direction: 1 | -1) => void;
  notice: TimingNotice | null;
}

/** Float noise allowed between what was asked for and what the player reports. */
const EPSILON = 1e-6;

/**
 * Subtitle delay, audio delay and speed for one stream (one
 * `PlaybackSession`). mpv keeps all three from one file to the next, so this
 * sets them whenever the stream opens, the subtitle track changes or the
 * viewer changes one: the subtitle delay remembered for the track showing
 * (none for a track not yet adjusted), the stream's audio delay (none to
 * begin with) and the speed kept for the app's run.
 *
 * `view` is `null` until this stream starts loading. Failed commands go to
 * `onError`; nothing else on the page is cleared by these automatic ones.
 */
export function usePlayerTiming(
  player: NativePlayer | null,
  view: NativePlayerView | null,
  onError: (reason: unknown) => void,
): PlayerTiming {
  const [timing, setTiming] = useState(NO_TIMING);
  const [speed, setSpeedState] = useState(rememberedSpeed);
  const [notice, setNotice] = useState<TimingNotice | null>(null);
  const trackId = view?.subtitleTrackId ?? null;
  const subtitleDelay = subtitleDelayFor(timing, trackId);
  const { audioDelay } = timing;
  const open = view !== null;

  // The latest of each, for callbacks fired several times before a render
  // (a held key) and for effects that shouldn't rerun on every render.
  const latest = useRef({ timing, speed, trackId });
  const viewRef = useRef(view);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    latest.current = { timing, speed, trackId };
    viewRef.current = view;
    onErrorRef.current = onError;
  });

  const show = useCallback((text: string) => {
    setNotice((current) => ({ id: (current?.id ?? 0) + 1, text }));
  }, []);

  // Keeps the player at the wanted values. What was last sent is compared
  // too: the player reports a change only after a round trip, so a quick
  // + then − would otherwise look like nothing to send.
  const sent = useRef<{
    player: NativePlayer | null;
    subtitle?: number;
    audio?: number;
    speed?: number;
  }>({ player: null });
  const apply = useCallback(
    (
      key: 'subtitle' | 'audio' | 'speed',
      value: number,
      reported: number | undefined,
      send: (player: NativePlayer) => Promise<void>,
    ) => {
      if (!player) return;
      if (sent.current.player !== player) sent.current = { player };
      const last = sent.current[key];
      const differs = (other: number | undefined) =>
        other === undefined || Math.abs(other - value) > EPSILON;
      if (!differs(last) && !differs(reported)) return;
      sent.current[key] = value;
      send(player).catch((reason: unknown) => onErrorRef.current(reason));
    },
    [player],
  );

  const subtitlesOn = trackId !== null;
  useEffect(() => {
    if (!open || !subtitlesOn) return;
    apply('subtitle', subtitleDelay, viewRef.current?.subtitleDelay, (p) =>
      p.setSubtitleDelay(subtitleDelay),
    );
  }, [open, subtitlesOn, trackId, subtitleDelay, apply]);

  useEffect(() => {
    if (!open) return;
    apply('audio', audioDelay, viewRef.current?.audioDelay, (p) => p.setAudioDelay(audioDelay));
  }, [open, audioDelay, apply]);

  useEffect(() => {
    if (!open) return;
    apply('speed', speed, viewRef.current?.speed, (p) => p.setSpeed(speed));
  }, [open, speed, apply]);

  const setDelay = useCallback(
    (kind: DelayKind, seconds: number) => {
      const current = latest.current;
      if (kind === 'subtitle') {
        if (current.trackId === null) {
          show('Turn subtitles on to shift them');
          return;
        }
        current.timing = withSubtitleDelay(current.timing, current.trackId, seconds);
      } else {
        current.timing = { ...current.timing, audioDelay: seconds };
      }
      setTiming(current.timing);
      show(timingNotice({ kind, seconds }));
    },
    [show],
  );

  const nudge = useCallback(
    (kind: DelayKind, steps: number) => {
      const current = latest.current;
      const from =
        kind === 'subtitle'
          ? subtitleDelayFor(current.timing, current.trackId)
          : current.timing.audioDelay;
      setDelay(kind, stepDelay(kind, from, steps * DELAY_STEP));
    },
    [setDelay],
  );

  const resetDelay = useCallback((kind: DelayKind) => setDelay(kind, 0), [setDelay]);

  const setSpeed = useCallback(
    (next: number) => {
      const value = clampSpeed(next);
      latest.current.speed = value;
      rememberSpeed(value);
      setSpeedState(value);
      show(timingNotice({ kind: 'speed', speed: value }));
    },
    [show],
  );

  const step = useCallback(
    (direction: 1 | -1) => setSpeed(stepSpeed(latest.current.speed, direction)),
    [setSpeed],
  );

  return {
    subtitleDelay,
    audioDelay,
    speed,
    subtitlesOn,
    nudge,
    resetDelay,
    setSpeed,
    stepSpeed: step,
    notice,
  };
}
