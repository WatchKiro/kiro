/**
 * Recovering from streams that don't play, and switching streams in the
 * player. When a stream fails before its first frame, the player moves on to
 * the next stream in the order one-click Play ranked them (`rankStreams`),
 * the same release (binge group) first, up to {@link MAX_STREAM_ATTEMPTS}
 * streams. The viewer can also pick another stream from the player's Streams
 * panel, which carries on from the current position.
 *
 * Either way the player opens a new {@link PlaybackRequest} in place of the
 * current one, with a {@link PlaybackHandoff} saying where to start and which
 * streams have already failed.
 */
import type { PlaybackHandoff, PlaybackRequest } from '@/features/playback/playback-request';
import { rankedPlaybackRequest, type RankedStream } from '@/features/title/stream-ranking';
import { episodeLabel } from '@/features/title/title-data';

/** At most this many streams are tried for one play before giving up (the first included). */
export const MAX_STREAM_ATTEMPTS = 5;

export interface Fallback {
  choice: RankedStream;
  /** This stream's place among the streams tried, counting from 1 (the one that failed). */
  attempt: number;
  /** How many streams will be tried at most, e.g. the 5 of "2 of 5". */
  total: number;
}

/**
 * The streams to fall back to, in order: the playable ones (so the stream
 * filters apply) that haven't failed, from the same release as the stream
 * that failed (its `bingeGroup`) first, otherwise in ranked order. Streams
 * with the same URL are the same stream, so each URL appears once.
 */
export function fallbackCandidates(
  playable: readonly RankedStream[],
  failed: readonly string[],
  bingeGroup: string | undefined,
): RankedStream[] {
  const seen = new Set(failed);
  const candidates = playable.filter(({ url }) => {
    if (seen.has(url)) return false;
    seen.add(url);
    return true;
  });
  if (!bingeGroup) return candidates;
  const sameRelease = (choice: RankedStream) =>
    choice.stream.behaviorHints?.bingeGroup === bingeGroup;
  return [...candidates.filter(sameRelease), ...candidates.filter((other) => !sameRelease(other))];
}

/**
 * The stream to try after the ones in `failed` (oldest first, the stream that
 * just failed last) didn't play, or `null` once {@link MAX_STREAM_ATTEMPTS}
 * have been tried or nothing is left.
 */
export function nextFallback(
  playable: readonly RankedStream[],
  failed: readonly string[],
  bingeGroup: string | undefined,
  maxAttempts = MAX_STREAM_ATTEMPTS,
): Fallback | null {
  if (failed.length >= maxAttempts) return null;
  const candidates = fallbackCandidates(playable, failed, bingeGroup);
  const choice = candidates[0];
  if (!choice) return null;
  return {
    choice,
    attempt: failed.length + 1,
    total: Math.min(maxAttempts, failed.length + candidates.length),
  };
}

/** e.g. "That stream didn't work, trying the next one (2 of 5)". */
export function fallbackNotice({ number, of }: { number: number; of: number }) {
  return `That stream didn’t work, trying the next one (${number} of ${of})`;
}

/**
 * The request that plays `choice` in place of `request`: the same title,
 * episode, artwork and library entry, starting where `handoff` says.
 */
export function switchRequest(
  request: PlaybackRequest,
  choice: Pick<RankedStream, 'stream' | 'addon' | 'url' | 'quality'>,
  handoff: PlaybackHandoff,
): PlaybackRequest {
  const { media, artwork } = request;
  const episode =
    media && media.video.season !== null
      ? episodeLabel({
          id: media.video.id,
          season: media.video.season,
          ...(media.video.episode !== null && { episode: media.video.episode }),
          ...(media.video.name !== null && { name: media.video.name }),
        })
      : undefined;
  return {
    ...rankedPlaybackRequest(choice, {
      title: request.title,
      ...(episode && { subtitle: episode }),
      ...(media && { media }),
      ...(artwork && { artwork }),
    }),
    handoff,
  };
}

/** Where a stream switch starts: the current position, or 0 before any is known. */
export function switchPosition(position: number | null | undefined): number {
  return typeof position === 'number' && Number.isFinite(position) && position > 0 ? position : 0;
}
