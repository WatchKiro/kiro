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

/**
 * Holding ← or → scrubs: the first press steps as a tap does, and from the
 * first key repeat on the thumb (and the preview card) travels from there,
 * faster the longer the key is held, with the seek on release. Distance
 * comes from how long the key has been held, not how many repeats the
 * system sends, so every keyboard scrubs at the same speed.
 */
export const KEY_SCRUB_RATES: readonly { until: number; rate: number }[] = [
  /** The first second: 30 s of video a second. */
  { until: 1000, rate: 30 },
  /** The next two: 90 s a second. */
  { until: 3000, rate: 90 },
  /** Then 4 minutes a second: across a film in half a minute. */
  { until: Infinity, rate: 240 },
];

/** Seconds of video a key held for `heldMs` has scrubbed across. */
export function keyScrubDistance(heldMs: number): number {
  let distance = 0;
  let from = 0;
  for (const { until, rate } of KEY_SCRUB_RATES) {
    const to = Math.min(heldMs, until);
    if (to <= from) break;
    distance += ((to - from) / 1000) * rate;
    from = to;
  }
  return distance;
}

/** Where a key held `heldMs` in `direction` from `from` has scrubbed to. */
export function keyScrubPosition(
  from: number,
  direction: -1 | 1,
  heldMs: number,
  duration: number,
): number {
  return Math.min(Math.max(from + direction * keyScrubDistance(heldMs), 0), duration);
}
