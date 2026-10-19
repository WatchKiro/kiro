import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router';

import { useAddonsStore } from '@/features/addons/addons-store';
import type { PlaybackHandoff, PlaybackRequest } from '@/features/playback/playback-request';
import {
  MAX_STREAM_ATTEMPTS,
  nextFallback,
  switchPosition,
  switchRequest,
} from '@/features/playback/stream-fallback';
import type { RankedStream, StreamRanking } from '@/features/title/stream-ranking';
import { useRankedStreams } from '@/features/title/use-ranked-streams';

export interface StreamSwitching {
  /** This video's streams, ranked as one-click Play ranks them. */
  ranking: StreamRanking;
  /** Every stream addon has answered. */
  settled: boolean;
  /** The URL of the stream this session plays. */
  current: string;
  /** Streams (URLs) that didn't play for this video, this one included once it fails. */
  failed: readonly string[];
  /**
   * After a failure before the first frame: `finding` while waiting for
   * addons that may still have a stream to fall back to, `exhausted` once
   * nothing is left to try automatically (or the stream was picked by hand).
   */
  fallback: 'none' | 'finding' | 'exhausted';
  /** Opens `choice` in place of this stream, from where this one is. */
  pick: (choice: Pick<RankedStream, 'stream' | 'addon' | 'url' | 'quality'>) => void;
}

/**
 * Stream fallback and switching for one stream of a library title (see
 * `stream-fallback.ts`). Without a title (`request.media`) there's nothing
 * to rank, so it returns `null`.
 *
 * When `failedBeforeStart` turns true, the next stream opens in place of this
 * one automatically, unless the viewer picked this one in the player: then,
 * as after the last attempt, the player shows the error with the streams.
 */
export function useStreamSwitching(
  request: PlaybackRequest | null,
  {
    failedBeforeStart,
    started,
    position,
    startPosition,
    resumed,
  }: {
    /** The stream failed (or couldn't load) before its first frame. */
    failedBeforeStart: boolean;
    /** Its first frame has shown. */
    started: boolean;
    /** The current position, once playing. */
    position: number | null;
    /** Where this stream was opened at (0 from the start). */
    startPosition: number;
    /** Whether that was saved progress being resumed. */
    resumed: boolean;
  },
): StreamSwitching | null {
  const navigate = useNavigate();
  const media = request?.media;
  const addons = useAddonsStore((state) => state.addons);
  const loadAddons = useAddonsStore((state) => state.load);
  useEffect(() => {
    if (media) void loadAddons();
  }, [media, loadAddons]);
  // The same list one-click Play chose from (cached by the title page).
  const { ranking, settled } = useRankedStreams(addons, media?.title.type ?? '', media?.video.id);

  const handoff = request?.handoff;
  const failed = useMemo(() => {
    const before = handoff?.failed ?? [];
    return request && failedBeforeStart && !before.includes(request.url)
      ? [...before, request.url]
      : before;
  }, [request, handoff, failedBeforeStart]);

  const switchTo = useCallback(
    (
      choice: Pick<RankedStream, 'stream' | 'addon' | 'url' | 'quality'>,
      next: Omit<PlaybackHandoff, 'failed'>,
    ) => {
      if (!request) return;
      // Replace, so Back still returns to the title. A stream picked again
      // after failing gets another chance.
      const handoff = { ...next, failed: failed.filter((url) => url !== choice.url) };
      void navigate('/player', {
        state: switchRequest(request, choice, handoff),
        replace: true,
      });
    },
    [request, failed, navigate],
  );

  const automatic = media !== undefined && handoff?.reason !== 'picked';
  const fallback = useMemo(
    () =>
      automatic && failedBeforeStart
        ? nextFallback(ranking.playable, failed, request?.source?.bingeGroup)
        : null,
    [automatic, failedBeforeStart, ranking, failed, request],
  );
  // Fall back once: a retry that fails again leaves the error up.
  const fellBack = useRef(false);
  useEffect(() => {
    if (!fallback || fellBack.current) return;
    fellBack.current = true;
    switchTo(fallback.choice, {
      startPosition,
      resumed,
      reason: 'fallback',
      attempt: { number: fallback.attempt, of: fallback.total },
    });
  }, [fallback, switchTo, startPosition, resumed]);

  const pick = useCallback(
    (choice: Pick<RankedStream, 'stream' | 'addon' | 'url' | 'quality'>) => {
      if (choice.url === request?.url && !failedBeforeStart) return;
      // From where this stream is, or from where it was to start.
      switchTo(choice, {
        startPosition: started ? switchPosition(position) : startPosition,
        resumed: !started && resumed,
        reason: 'picked',
      });
    },
    [request, failedBeforeStart, started, position, startPosition, resumed, switchTo],
  );

  if (!request || !media) return null;
  // Addons still answering may have a stream to fall back to.
  const mayFindOne = automatic && !settled && failed.length < MAX_STREAM_ATTEMPTS;
  return {
    ranking,
    settled,
    current: request.url,
    failed,
    fallback: !failedBeforeStart ? 'none' : fallback || mayFindOne ? 'finding' : 'exhausted',
    pick,
  };
}
