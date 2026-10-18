/**
 * Subtitle delay, audio delay and playback speed: the steps the player's
 * "Sync & speed" panel and keys take, how values read, and what one stream
 * remembers.
 *
 * Kept free of React so it can be tested on its own; `use-player-timing.ts`
 * applies it to the player.
 */
import { clamp } from '@kiro/utils';

/** Mirrors `media::MAX_SUBTITLE_DELAY` in Rust: seconds either way. */
export const MAX_SUBTITLE_DELAY = 60;
/** Mirrors `media::MAX_AUDIO_DELAY` in Rust: seconds either way. */
export const MAX_AUDIO_DELAY = 10;
/** Mirrors `media::SPEEDS` in Rust. */
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;

/** How far one press of − or + (or Z, X, J, K) moves a delay. */
export const DELAY_STEP = 0.1;
/** The speeds offered, and what [ and ] step through. */
export const SPEED_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

export type DelayKind = 'subtitle' | 'audio';

const MAX_DELAY: Record<DelayKind, number> = {
  subtitle: MAX_SUBTITLE_DELAY,
  audio: MAX_AUDIO_DELAY,
};

/** To the millisecond, as Rust reports it, without `-0`. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000 || 0;
}

/** A delay moved by `delta` seconds, within what the player accepts. */
export function stepDelay(kind: DelayKind, current: number, delta: number): number {
  const max = MAX_DELAY[kind];
  return round(clamp(current + delta, -max, max));
}

/**
 * The next preset speed above (`1`) or below (`-1`) `current`. A speed
 * between presets moves to the nearest one that way; the ends stay put.
 */
export function stepSpeed(current: number, direction: 1 | -1): number {
  const presets = direction > 0 ? SPEED_PRESETS : [...SPEED_PRESETS].reverse();
  return presets.find((speed) => (speed - current) * direction > 1e-9) ?? current;
}

/** Within what the player accepts. */
export function clampSpeed(speed: number): number {
  return round(clamp(speed, MIN_SPEED, MAX_SPEED));
}

const MINUS = '−';

/** `+0.3 s`, `−1.25 s`, `0.0 s`: tenths, or finer when set more finely. */
export function formatDelay(seconds: number): string {
  const value = round(seconds);
  const magnitude = Math.abs(value);
  const digits = Number.isInteger(round(magnitude * 10)) ? magnitude.toFixed(1) : `${magnitude}`;
  const sign = value > 0 ? '+' : value < 0 ? MINUS : '';
  return `${sign}${digits} s`;
}

/** `1×`, `1.25×`, `0.5×`. */
export function formatSpeed(speed: number): string {
  return `${Number(speed.toFixed(2))}×`;
}

/** What a delay does, under its value in the panel. */
export function describeDelay(kind: DelayKind, seconds: number): string {
  const value = round(seconds);
  const what = kind === 'subtitle' ? 'Subtitles show' : 'Audio plays';
  if (value === 0) return kind === 'subtitle' ? 'Shown as the file times them' : 'Not shifted';
  const amount = formatDelay(Math.abs(value)).slice(1);
  return `${what} ${amount} ${value > 0 ? 'later' : 'earlier'}`;
}

/** The brief on-screen notice after a change, e.g. `Subtitles +0.3 s`. */
export function timingNotice(
  change: { kind: DelayKind; seconds: number } | { kind: 'speed'; speed: number },
): string {
  switch (change.kind) {
    case 'subtitle':
      return `Subtitles ${formatDelay(change.seconds)}`;
    case 'audio':
      return `Audio ${formatDelay(change.seconds)}`;
    case 'speed':
      return `Speed ${formatSpeed(change.speed)}`;
  }
}

/**
 * The delays one stream remembers: a subtitle delay for each subtitle track
 * (so turning subtitles off and on, or trying another track and coming
 * back, keeps the fix for that track), and one audio delay. A new stream,
 * such as the next episode, starts from none.
 */
export interface StreamTiming {
  /** By the player's subtitle track id. */
  readonly subtitleDelays: Readonly<Record<string, number>>;
  readonly audioDelay: number;
}

export const NO_TIMING: StreamTiming = { subtitleDelays: {}, audioDelay: 0 };

/** The subtitle delay remembered for a track: none until it is changed. */
export function subtitleDelayFor(timing: StreamTiming, trackId: string | null): number {
  return trackId === null ? 0 : (timing.subtitleDelays[trackId] ?? 0);
}

/** Remembers `seconds` as the delay for a subtitle track. */
export function withSubtitleDelay(
  timing: StreamTiming,
  trackId: string,
  seconds: number,
): StreamTiming {
  return { ...timing, subtitleDelays: { ...timing.subtitleDelays, [trackId]: round(seconds) } };
}

/**
 * The speed kept for the rest of the app's run (not saved), so the next
 * episode plays at the speed the viewer chose.
 */
let sessionSpeed = 1;

export function rememberedSpeed(): number {
  return sessionSpeed;
}

export function rememberSpeed(speed: number) {
  sessionSpeed = clampSpeed(speed);
}
