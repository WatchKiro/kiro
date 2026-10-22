import { useEffect, useReducer, useState } from 'react';

import {
  PreviewCache,
  PreviewScheduler,
  previewNeighbours,
  previewSlot,
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
}

/**
 * Seek-bar previews for the stream playing (`seek-preview.ts`). Mount it once
 * per stream: the previews it keeps belong to that stream.
 */
export function useSeekPreview(
  enabled: boolean,
  duration: number | null,
  request: (position: number, kind: PreviewKind) => Promise<unknown> = previewCommand,
): SeekPreview {
  const [hover, setHover] = useState<SeekHover | null>(null);
  // Answers arrive outside React's state: re-render when one does.
  const [, answered] = useReducer((count: number) => count + 1, 0);
  const [cache] = useState(() => new PreviewCache());
  const [scheduler] = useState(() => new PreviewScheduler(cache, request, answered));
  useEffect(() => () => scheduler.stop(), [scheduler]);

  const slot = hover && duration ? previewSlot(hover.position, duration) : null;
  // Fetched while dragging too: the preview is what the drag shows.
  const fetching = enabled && hover !== null;
  const index = slot?.index;
  const position = slot?.position;
  // The pointer reached the bar: get the core ready before it rests anywhere.
  useEffect(() => {
    if (fetching) scheduler.warm();
  }, [scheduler, fetching]);
  useEffect(() => {
    if (fetching && index !== undefined && position !== undefined && duration) {
      const slot = { index, position };
      scheduler.want(slot, previewNeighbours(slot, duration));
    } else {
      scheduler.want(null);
    }
  }, [scheduler, fetching, index, position, duration]);

  const nearest = slot ? cache.nearest(slot.index) : undefined;
  const stale = nearest !== undefined && nearest.distance > 0;
  // Not while the core is busy or the stream can't be previewed: a shimmer
  // would promise a frame that isn't coming.
  const loading =
    fetching && slot !== null && nearest?.distance !== 0 && cache.available && !scheduler.paused;
  return { hover, setHover, frame: nearest?.frame, stale, loading };
}
