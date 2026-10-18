import { useEffect, useMemo, useState } from 'react';

import { skipSegments } from '@/features/playback/chapter-skip';
import type { NativePlayerView } from '@/features/playback/native-player';
import {
  chooseSkipParts,
  episodeRef,
  parseSkipTimes,
  shouldLookUp,
  type EpisodeRef,
  type LookupResult,
  type SkipParts,
} from '@/features/playback/online-skip';
import type { PlaybackMedia } from '@/features/playback/playback-request';
import { skipTimesCommands } from '@/services/native';

interface LookupQuery extends EpisodeRef {
  duration: number;
}

/**
 * The parts of this stream that can be skipped: from the file's chapters, or,
 * with `lookUp` on and no chapters marking any, from SkipDB (`online-skip.ts`).
 *
 * The lookup starts once the file has loaded and runs in the background:
 * playback never waits for it, and a failure only means no button.
 */
export function useSkipParts(
  view: NativePlayerView | null,
  media: PlaybackMedia | undefined,
  lookUp: boolean,
  lookup: typeof skipTimesCommands.lookup = skipTimesCommands.lookup,
): SkipParts {
  const chapters = view?.chapters;
  const duration = view?.duration ?? null;
  const chapterSegments = useMemo(
    () => (chapters ? skipSegments(chapters, duration) : []),
    [chapters, duration],
  );

  // Loaded once it plays: by then the file's chapters and duration are in.
  // (Each stream has its own session, so this never needs resetting.)
  const [loaded, setLoaded] = useState(false);
  if (!loaded && (view?.state === 'playing' || view?.state === 'paused') && duration) {
    setLoaded(true);
  }

  const episode = useMemo(() => episodeRef(media), [media]);
  const wanted = shouldLookUp({ enabled: lookUp, episode, loaded, duration, chapterSegments });
  // One lookup per stream, with the duration the file first reported (some
  // formats refine it while playing; the core caches by episode and length).
  const [query, setQuery] = useState<LookupQuery | null>(null);
  if (query === null && wanted && episode && duration) setQuery({ ...episode, duration });
  /** Turned off since, or chapters say otherwise: the file's chapters only. */
  const active = wanted && query !== null;

  const [result, setResult] = useState<{ query: LookupQuery; lookup: LookupResult } | null>(null);
  useEffect(() => {
    if (!query) return;
    let live = true;
    lookup(query.imdbId, query.season, query.episode, query.duration).then(
      (value) => {
        if (!live) return;
        const times = parseSkipTimes(value);
        setResult({ query, lookup: times ? { state: 'done', times } : { state: 'failed' } });
      },
      () => {
        if (live) setResult({ query, lookup: { state: 'failed' } });
      },
    );
    return () => {
      live = false;
    };
  }, [query, lookup]);

  return useMemo(() => {
    const current: LookupResult | null = !active
      ? null
      : result?.query === query
        ? result.lookup
        : { state: 'looking' };
    return chooseSkipParts(chapterSegments, current, duration);
  }, [chapterSegments, active, query, result, duration]);
}
