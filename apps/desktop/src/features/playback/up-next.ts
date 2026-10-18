/**
 * Up next: when an episode nears its end, the player offers the following
 * episode with a countdown (its length and whether it runs at all are
 * Settings → Playback), then plays it from the same addon and release
 * when it can (Stremio's `behaviorHints.bingeGroup` convention), otherwise
 * the best-ranked stream from any addon, or opens that episode's stream list
 * when nothing can play.
 */
import type { Stream } from '@kiro/addon-sdk';
import type { PlaybackState } from '@kiro/player-core';

import { END_MARGIN_SECONDS } from '@/features/library/progress-tracker';
import type { RankedStream } from '@/features/title/stream-ranking';
import { classifyStream } from '@/features/title/title-data';
import type { StreamsEntry } from '@/features/title/title-store';

/**
 * The card appears this close to the end: where stopping already counts as
 * having watched the episode (the library's end margin).
 */
export const UP_NEXT_LEAD_SECONDS = END_MARGIN_SECONDS;
/** Shorter videos (clips, extras) never show the card. */
const MIN_DURATION_SECONDS = 120;

/**
 * Whether playback is close enough to the end (or at it) to offer the next
 * episode: in its last {@link UP_NEXT_LEAD_SECONDS}, or in the closing credits
 * when the file's chapters mark where they start (`creditsFrom`, see
 * `chapter-skip.ts`).
 */
export function isNearEnd(
  state: PlaybackState,
  position: number,
  duration: number | null,
  creditsFrom: number | null = null,
) {
  if (state === 'ended') return true;
  if (state !== 'playing' && state !== 'paused') return false;
  if (duration === null || duration < MIN_DURATION_SECONDS) return false;
  return (
    duration - position <= UP_NEXT_LEAD_SECONDS || (creditsFrom !== null && position >= creditsFrom)
  );
}

/**
 * Whether the countdown runs: only with autoplay on (Settings → Playback),
 * and not while paused, so it can be read and stopped.
 */
export function isCountingDown(state: PlaybackState, autoplay = true) {
  return autoplay && (state === 'playing' || state === 'ended');
}

/**
 * The first playable stream in `streams` from the same release: its
 * `bingeGroup` equals the current stream's. Streams without a binge group
 * never match, since nothing says they are the same release.
 */
export function bingeStream(
  streams: readonly Stream[],
  bingeGroup: string | undefined,
): { stream: Stream; url: string } | undefined {
  if (!bingeGroup) return undefined;
  for (const stream of streams) {
    if (stream.behaviorHints?.bingeGroup !== bingeGroup) continue;
    const source = classifyStream(stream);
    if (source.kind === 'playable') return { stream, url: source.url };
  }
  return undefined;
}

export type UpNextAction =
  /** The next episode's streams from the same addon are still loading. */
  | { kind: 'wait' }
  /** Play this stream, from the same addon and release, in the player. */
  | { kind: 'play'; stream: Stream; url: string }
  /** No stream from the same release: play the best-ranked one instead. */
  | { kind: 'best'; choice: RankedStream }
  /** Nothing can play: let the user choose on the episode's stream list. */
  | { kind: 'choose' };

/** The next episode's streams from every addon, ranked (`useRankedStreams`). */
export interface RankedNext {
  /** Every addon has answered, or a good stream has once the time budget ran out. */
  ready: boolean;
  best: RankedStream | undefined;
}

/**
 * What Up next does once the countdown ends, given the next episode's
 * streams from the addon the current stream came from (`undefined` when that
 * addon is no longer installed or was never known) and from every addon,
 * ranked. The same release wins; otherwise the best-ranked stream.
 */
export function upNextAction(
  streams: StreamsEntry | undefined,
  bingeGroup: string | undefined,
  addonKnown: boolean,
  ranked: RankedNext,
): UpNextAction {
  if (bingeGroup && addonKnown) {
    if (!streams || streams.status === 'loading') return { kind: 'wait' };
    const match = streams.status === 'ready' ? bingeStream(streams.streams, bingeGroup) : undefined;
    if (match) return { kind: 'play', ...match };
  }
  if (!ranked.ready) return { kind: 'wait' };
  return ranked.best ? { kind: 'best', choice: ranked.best } : { kind: 'choose' };
}
