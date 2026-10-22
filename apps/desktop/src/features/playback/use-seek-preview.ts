import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import {
  PreviewCache,
  PreviewScheduler,
  backgroundSlots,
  previewCaches,
  previewNeighbours,
  previewSlot,
  storyboardReach,
  type PreviewFrame,
} from '@/features/playback/seek-preview';
import { previewCommand, type PreviewKind } from '@/services/player';

/** Where the pointer is over the seek bar. */
export interface SeekHover {
  /** Seconds under the pointer. */
  position: number;
  /** A button is down: the thumb is being dragged (the player seeks on release). */
  pressed: boolean;
}

export interface SeekPreview {
  hover: SeekHover | null;
  setHover: (hover: SeekHover | null) => void;
  /**
   * The preview for the hovered position, or until there is one, a nearby
   * one to stand in (`stale`).
   */
  frame: PreviewFrame | undefined;
  /** `frame` is from a nearby cell, not the one hovered. */
  stale: boolean;
  /** The hovered cell's own preview is wanted and expected to arrive. */
  loading: boolean;
  /** The nearest frame kept for `position` (within the storyboard's reach), if any. */
  frameAt: (position: number) => PreviewFrame | undefined;
}

export interface SeekPreviewOptions {
  /** Settings → Playback → Seek bar previews. */
  enabled: boolean;
  /** The stream's URL: its previews are kept for the session under it. */
  url: string | null;
  duration: number | null;
  /** The controls are showing: get the preview core ready. */
  active: boolean;
  /** Where playback is, for the cells made first as the stream loads. */
  position: number;
  /** Chapter and skip-part starts, made as the stream loads too. */
  starts: readonly number[];
  request?: (position: number, kind: PreviewKind) => Promise<unknown>;
}

/**
 * Seek-bar previews for the stream playing (`seek-preview.ts`): those kept
 * for its URL and duration (`previewCaches`), so a stream played before in
 * the session starts with its frames.
 */
export function useSeekPreview({
  enabled,
  url,
  duration,
  active,
  position,
  starts,
  request = previewCommand,
}: SeekPreviewOptions): SeekPreview {
  const [hover, setHover] = useState<SeekHover | null>(null);
  // Answers arrive outside React's state: re-render when one does.
  const [, answered] = useReducer((count: number) => count + 1, 0);
  // Until the stream and its duration are known, nothing is asked for; a
  // cache of its own keeps that from being kept under the wrong key.
  const key = url && duration ? `${url}#${duration}` : null;
  const cache = useMemo(() => (key ? previewCaches.get(key) : new PreviewCache()), [key]);
  const scheduler = useMemo(() => new PreviewScheduler(cache, request, answered), [cache, request]);
  useEffect(() => () => scheduler.stop(), [scheduler]);

  // As the stream loads: the cells people look at first, then a storyboard.
  // Where it started is read once, when the duration is known.
  const latestPosition = useRef(position);
  useEffect(() => {
    latestPosition.current = position;
  });
  const startsKey = starts.join(',');
  useEffect(() => {
    if (!enabled || !duration) return;
    scheduler.background(
      backgroundSlots(
        duration,
        latestPosition.current,
        startsKey ? startsKey.split(',').map(Number) : [],
      ),
    );
  }, [scheduler, enabled, duration, startsKey]);

  // The controls appeared (after the background cells are known, so the core
  // opens at the first of them): get it ready before the pointer rests anywhere.
  useEffect(() => {
    if (enabled && active && duration) scheduler.warm();
  }, [scheduler, enabled, active, duration]);

  const slot = hover && duration ? previewSlot(hover.position, duration) : null;
  // Fetched while dragging too: the preview is what the drag shows.
  const fetching = enabled && hover !== null;
  const index = slot?.index;
  const slotPosition = slot?.position;
  useEffect(() => {
    if (fetching && index !== undefined && slotPosition !== undefined && duration) {
      const slot = { index, position: slotPosition };
      scheduler.want(slot, previewNeighbours(slot, duration));
    } else {
      scheduler.want(null);
    }
  }, [scheduler, fetching, index, slotPosition, duration]);

  const frameAt = useCallback(
    (position: number) =>
      duration
        ? cache.nearest(previewSlot(position, duration).index, storyboardReach(duration))?.frame
        : undefined,
    [cache, duration],
  );
  const nearest =
    slot && duration ? cache.nearest(slot.index, storyboardReach(duration)) : undefined;
  const stale = nearest !== undefined && nearest.distance > 0;
  // Not while the core is busy or the stream can't be previewed: a shimmer
  // would promise a frame that isn't coming.
  const loading =
    fetching && slot !== null && nearest?.distance !== 0 && cache.available && !scheduler.paused;
  return { hover, setHover, frame: nearest?.frame, stale, loading, frameAt };
}
