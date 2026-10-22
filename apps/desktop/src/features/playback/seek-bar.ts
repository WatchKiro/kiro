/**
 * The seek bar's geometry and dragging, kept apart from the player page so
 * they can be tested: which buffered stretches to draw, and how a drag turns
 * into one seek.
 */
import type { BufferedRange } from '@/services/player';

/**
 * The buffered stretches ahead of `position`, each clipped to the video.
 * What's behind the position is under the played fill anyway, so it isn't
 * drawn; a stretch that starts behind it and reaches past it is drawn from
 * the position on.
 */
export function bufferedAhead(
  buffered: readonly BufferedRange[],
  position: number,
  duration: number,
): BufferedRange[] {
  const ahead: BufferedRange[] = [];
  for (const range of buffered) {
    const start = Math.max(range.start, position);
    const end = Math.min(range.end, duration);
    // Too small to see, or behind the position.
    if (end - start < 0.5) continue;
    ahead.push({ start, end });
  }
  return ahead;
}

/**
 * Dragging the seek bar: the position follows the pointer while a button is
 * down, and the player seeks once, on release. (Seeking on every move would
 * read the stream again at each step, which on a 4K stream empties its
 * buffer and stutters.)
 */
export interface DragState {
  /** Where the thumb is while dragging, or `null` when not dragging. */
  position: number | null;
}

/** The drag's next state, and the seek to make, after an event. */
export function dragStep(
  drag: DragState,
  event: { type: 'move'; position: number } | { type: 'release' } | { type: 'cancel' },
): { drag: DragState; seek: number | null } {
  switch (event.type) {
    case 'move':
      return { drag: { position: event.position }, seek: null };
    case 'release':
      return { drag: { position: null }, seek: drag.position };
    case 'cancel':
      return { drag: { position: null }, seek: null };
  }
}
