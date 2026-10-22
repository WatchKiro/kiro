import { useEffect, useReducer, useState } from 'react';

import {
  PreviewCache,
  PreviewScheduler,
  previewSlot,
  type PreviewFrame,
} from '@/features/playback/seek-preview';
import { previewCommand } from '@/services/player';

/** Where the pointer is over the seek bar. */
export interface SeekHover {
  /** Seconds under the pointer. */
  position: number;
  /** A button is down: dragging seeks the player itself, so nothing is fetched. */
  pressed: boolean;
}

export interface SeekPreview {
  hover: SeekHover | null;
  setHover: (hover: SeekHover | null) => void;
  /** The preview for the hovered position, once there is one. */
  frame: PreviewFrame | undefined;
}

/**
 * Seek-bar previews for the stream playing (`seek-preview.ts`). Mount it once
 * per stream: the previews it keeps belong to that stream.
 */
export function useSeekPreview(
  enabled: boolean,
  duration: number | null,
  request: (position: number) => Promise<unknown> = previewCommand,
): SeekPreview {
  const [hover, setHover] = useState<SeekHover | null>(null);
  // Previews arrive outside React's state: re-render when one does.
  const [, frameArrived] = useReducer((count: number) => count + 1, 0);
  const [cache] = useState(() => new PreviewCache());
  const [scheduler] = useState(() => new PreviewScheduler(cache, request, frameArrived));
  useEffect(() => () => scheduler.stop(), [scheduler]);

  const slot = hover && duration ? previewSlot(hover.position, duration) : null;
  const fetching = enabled && hover !== null && !hover.pressed;
  const index = slot?.index;
  const position = slot?.position;
  useEffect(() => {
    scheduler.want(
      fetching && index !== undefined && position !== undefined ? { index, position } : null,
    );
  }, [scheduler, fetching, index, position]);

  return { hover, setHover, frame: slot ? cache.get(slot.index) : undefined };
}
