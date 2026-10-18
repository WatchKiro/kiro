import { useCallback, useEffect, useRef, useState } from 'react';

import { isAutoSkippable, segmentAt, type SkipSegment } from '@/features/playback/chapter-skip';
import type { NativePlayer, NativePlayerView } from '@/features/playback/native-player';

/** How long the skip button stays after its part starts, even with the controls hidden. */
export const SKIP_LINGER_MS = 6000;
/** How long "Skipped intro" (with its undo) stays after an automatic skip. */
export const AUTO_SKIPPED_NOTICE_MS = 6000;

export interface ChapterSkip {
  /** Every part of this file that can be skipped, in order. */
  segments: SkipSegment[];
  /** The part playback is in, if it can be skipped. */
  segment: SkipSegment | undefined;
  /** Whether the button shows on its own: for a few seconds after the part starts. */
  lingering: boolean;
  /** Seeks past `segment`. */
  skip: () => void;
  /** The part just skipped automatically, while its notice shows. */
  autoSkipped: SkipSegment | undefined;
  /** Goes back to the start of `autoSkipped`, and plays it this time. */
  undoAutoSkip: () => void;
  dismissAutoSkipped: () => void;
}

/**
 * Skip intro and Skip credits for `segments`: the file's chapters
 * (`chapter-skip.ts`), or times looked up online (`use-skip-parts.ts`).
 * With `autoSkip` on, intros and recaps are skipped as playback reaches
 * them, once each per stream; going back to one plays it.
 */
export function useChapterSkip(
  player: NativePlayer | null,
  view: NativePlayerView | null,
  segments: SkipSegment[],
  run: (action: Promise<unknown>) => void,
  autoSkip: boolean,
): ChapterSkip {
  const state = view?.state;
  const playing = state === 'playing' || state === 'paused';
  const segment = playing && view ? segmentAt(segments, view.position) : undefined;

  // The button lingers for a while each time playback enters a part (known
  // by where it starts).
  const [lingering, setLingering] = useState(false);
  const [entered, setEntered] = useState<number | undefined>(undefined);
  if (segment?.start !== entered) {
    setEntered(segment?.start);
    setLingering(segment !== undefined);
  }
  useEffect(() => {
    if (entered === undefined) return;
    const timer = window.setTimeout(() => setLingering(false), SKIP_LINGER_MS);
    return () => window.clearTimeout(timer);
  }, [entered]);

  const skip = useCallback(() => {
    if (player && segment) run(player.seek(segment.end));
  }, [player, segment, run]);

  // Automatic skipping: each part once (keyed by where it starts).
  const autoSkippedStarts = useRef(new Set<number>());
  const [autoSkipped, setAutoSkipped] = useState<SkipSegment | undefined>(undefined);
  useEffect(() => {
    if (!autoSkip || !player || state !== 'playing' || !segment) return;
    if (!isAutoSkippable(segment.kind) || autoSkippedStarts.current.has(segment.start)) return;
    autoSkippedStarts.current.add(segment.start);
    setAutoSkipped(segment);
    run(player.seek(segment.end));
  }, [autoSkip, player, state, segment, run]);
  useEffect(() => {
    if (!autoSkipped) return;
    const timer = window.setTimeout(() => setAutoSkipped(undefined), AUTO_SKIPPED_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [autoSkipped]);

  const undoAutoSkip = useCallback(() => {
    if (player && autoSkipped) run(player.seek(autoSkipped.start));
    setAutoSkipped(undefined);
  }, [player, autoSkipped, run]);
  const dismissAutoSkipped = useCallback(() => setAutoSkipped(undefined), []);

  return { segments, segment, lingering, skip, autoSkipped, undoAutoSkip, dismissAutoSkipped };
}
