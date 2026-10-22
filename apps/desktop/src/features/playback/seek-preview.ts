/**
 * Seek-bar previews: a frame of the video above the seek bar while the
 * pointer hovers over it (`commands::player::player_preview`, made by a
 * second mpv in the core).
 *
 * Each preview reads part of the stream (0.25 to 2 MB), so they are only
 * asked for on hover, one at a time, for positions snapped to a grid so
 * nearby positions share one, and kept for the rest of the stream. The core
 * refuses while the player is short of buffered video (`busy`): the bar then
 * shows only the time, and asks again a little later.
 */
import type { PlayerPreview } from '@/services/player';

/** Previews are at least this many seconds apart... */
const MIN_STEP_SECONDS = 5;
/** ...and there are at most this many for a video. */
const MAX_PREVIEWS = 200;

/** Seconds between previewed positions for a video `duration` seconds long. */
export function previewStep(duration: number): number {
  return Math.max(MIN_STEP_SECONDS, Math.ceil(duration / MAX_PREVIEWS));
}

/**
 * The grid cell `position` is in, and the position previewed for it (its
 * middle, so the keyframe shown, at or before it, usually falls inside it).
 */
export function previewSlot(
  position: number,
  duration: number,
): { index: number; position: number } {
  const step = previewStep(duration);
  const last = Math.max(0, Math.ceil(duration / step) - 1);
  const index = Math.min(Math.max(0, Math.floor(position / step)), last);
  return { index, position: Math.min(index * step + step / 2, Math.max(0, duration - 0.5)) };
}

/** A JPEG `data:` URL, nothing else, as an image source. */
const IMAGE = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;
/** Far more than a 320-pixel JPEG needs. */
const MAX_IMAGE_LENGTH = 512 * 1024;

/** `player_preview`'s result, or `null` if it is not one. */
export function parsePlayerPreview(value: unknown): PlayerPreview | null {
  if (typeof value !== 'object' || value === null) return null;
  const { status, position, image } = value as Record<string, unknown>;
  switch (status) {
    case 'frame':
      return typeof position === 'number' &&
        Number.isFinite(position) &&
        position >= 0 &&
        typeof image === 'string' &&
        image.length <= MAX_IMAGE_LENGTH &&
        IMAGE.test(image)
        ? { status, position, image }
        : null;
    case 'busy':
    case 'superseded':
    case 'unavailable':
      return { status };
    default:
      return null;
  }
}

/** A preview kept for a grid cell. */
export interface PreviewFrame {
  image: string;
  /** The keyframe shown, in seconds. */
  position: number;
}

/**
 * The previews made for one stream, by grid cell, and whether asking is
 * worthwhile: not once the core says the stream can't be previewed, and not
 * again for a while after it says it's busy.
 */
export class PreviewCache {
  private readonly frames = new Map<number, PreviewFrame>();
  private unavailable = false;
  private busyUntil = 0;

  get(index: number): PreviewFrame | undefined {
    return this.frames.get(index);
  }

  /** Whether to ask for cell `index` now (`now` in ms). */
  wants(index: number, now: number): boolean {
    return !this.unavailable && now >= this.busyUntil && !this.frames.has(index);
  }

  /** Records what the core answered for cell `index`. */
  record(index: number, result: PlayerPreview, now: number): void {
    switch (result.status) {
      case 'frame':
        this.frames.set(index, { image: result.image, position: result.position });
        break;
      case 'busy':
        this.busyUntil = now + BUSY_RETRY_MS;
        break;
      case 'unavailable':
        this.unavailable = true;
        break;
      case 'superseded':
        break;
    }
  }

  get size(): number {
    return this.frames.size;
  }
}

/** After `busy`, wait this long before asking again. */
export const BUSY_RETRY_MS = 3000;
/** Hovering this long over a cell asks for its preview. */
export const HOVER_DELAY_MS = 120;

/** A grid cell and the position previewed for it (`previewSlot`). */
export interface PreviewSlot {
  index: number;
  position: number;
}

/**
 * Asks for the preview of the cell under the pointer: once it has been
 * hovered for `HOVER_DELAY_MS`, one request at a time, then the newest cell
 * wanted when that one finishes. After `busy` it asks again
 * `BUSY_RETRY_MS` later if the pointer is still there.
 */
export class PreviewScheduler {
  private wanted: PreviewSlot | null = null;
  private inFlight = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly cache: PreviewCache,
    private readonly request: (position: number) => Promise<unknown>,
    /** Called when a preview arrives, to show it. */
    private readonly onFrame: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** The cell under the pointer (`null`: none, or nothing to fetch). */
  want(slot: PreviewSlot | null): void {
    if (slot?.index === this.wanted?.index) return;
    this.wanted = slot;
    this.schedule(slot ? HOVER_DELAY_MS : null);
  }

  /** Forgets what was wanted (the pointer left, or the page went away). */
  stop(): void {
    this.wanted = null;
    this.schedule(null);
  }

  private schedule(delay: number | null): void {
    clearTimeout(this.timer);
    this.timer = delay === null ? undefined : setTimeout(() => this.fetch(), delay);
  }

  private fetch(): void {
    const target = this.wanted;
    if (this.inFlight || !target || !this.cache.wants(target.index, this.now())) return;
    this.inFlight = true;
    void this.request(target.position)
      .then(
        (value) => parsePlayerPreview(value) ?? ({ status: 'unavailable' } as const),
        // Not attached, or no such command: worth trying on a later hover.
        () => ({ status: 'superseded' }) as const,
      )
      .then((result) => {
        this.inFlight = false;
        this.cache.record(target.index, result, this.now());
        if (result.status === 'frame') this.onFrame();
        if (!this.wanted) return;
        if (result.status === 'busy') this.schedule(BUSY_RETRY_MS);
        // The pointer moved on while this one was made.
        else if (this.wanted.index !== target.index) this.fetch();
      });
  }
}
