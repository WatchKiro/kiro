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
 *
 * To have frames sooner: the core opens the stream when the controls appear
 * (`warm`); a nearby frame stands in while a cell's own is made
 * (`PreviewCache.nearest`); the cells either side of one the pointer rests
 * on are made ahead (`prefetch`); and as the stream loads, a few cells
 * people look at first (where it resumed, chapter and skip-part starts) and
 * a coarse storyboard of 16 frames spread over the video are made in the
 * background, one at a time behind whatever the pointer wants, only while
 * the player has plenty buffered, and a limited number per stream.
 */
import type { PlayerPreview, PreviewKind } from '@/services/player';

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
    case 'warming':
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
 * worthwhile: not once the core says the stream can't be previewed, not
 * again for a while after it says it's busy, and (background frames) not
 * past a budget per stream.
 */
export class PreviewCache {
  private readonly frames = new Map<number, PreviewFrame>();
  private unavailable = false;
  private busyUntil = 0;
  private backgroundBusyUntil = 0;
  private prefetches = 0;
  private storyboards = 0;

  get(index: number): PreviewFrame | undefined {
    return this.frames.get(index);
  }

  /**
   * The frame for cell `index`, or failing that the nearest one within
   * `maxDistance` cells (the earlier of two equally near), to show, dimmed,
   * while the cell's own is made.
   */
  nearest(index: number, maxDistance = NEAREST_CELLS): PreviewNearest | undefined {
    for (let distance = 0; distance <= maxDistance; distance++) {
      for (const candidate of [index - distance, index + distance]) {
        const frame = this.frames.get(candidate);
        if (frame) return { frame, distance };
      }
    }
    return undefined;
  }

  /** Whether to ask for cell `index` now (`now` in ms). */
  wants(index: number, now: number): boolean {
    return !this.unavailable && now >= this.busyUntil && !this.frames.has(index);
  }

  /** Whether to ask for cell `index` in the background now, as `kind`. */
  wantsBackground(index: number, now: number, kind: BackgroundKind): boolean {
    const budget =
      kind === 'storyboard'
        ? this.storyboards < STORYBOARD_FRAMES
        : this.prefetches < MAX_PREFETCHES;
    return this.wants(index, now) && now >= this.backgroundBusyUntil && budget;
  }

  /** The core has not said the stream can't be previewed. */
  get available(): boolean {
    return !this.unavailable;
  }

  /** Records what the core answered for cell `index`. */
  record(index: number, result: PlayerPreview, now: number, kind: PreviewKind = 'hover'): void {
    switch (result.status) {
      case 'frame':
        this.frames.set(index, { image: result.image, position: result.position });
        if (kind === 'prefetch') this.prefetches++;
        else if (kind === 'storyboard') this.storyboards++;
        break;
      case 'busy':
        // Background frames need more buffered than a hover: their refusal
        // says nothing about hovers.
        if (kind === 'hover') this.busyUntil = now + BUSY_RETRY_MS;
        else this.backgroundBusyUntil = now + BUSY_RETRY_MS;
        break;
      case 'unavailable':
        this.unavailable = true;
        break;
      case 'superseded':
      case 'warming':
        break;
    }
  }

  get size(): number {
    return this.frames.size;
  }
}

/** A frame near the cell wanted (`PreviewCache.nearest`). */
export interface PreviewNearest {
  frame: PreviewFrame;
  /** How many cells away it is: 0 for the cell's own. */
  distance: number;
}

/** A preview made without the pointer asking for it. */
export type BackgroundKind = 'prefetch' | 'storyboard';

/** A stand-in frame comes from at most this many cells away. */
export const NEAREST_CELLS = 2;
/** After `busy`, wait this long before asking again. */
export const BUSY_RETRY_MS = 3000;
/** Hovering this long over a cell asks for its preview. */
export const HOVER_DELAY_MS = 120;
/** Resting this long on a cell asks for the cells either side of it. */
export const PREFETCH_DELAY_MS = 400;
/** Prefetched frames per stream, at most (each reads part of the stream). */
export const MAX_PREFETCHES = 40;
/** Frames spread over the video to stand in anywhere on the bar. */
export const STORYBOARD_FRAMES = 16;
/** Cells made first as a stream loads (where it resumed, chapters), at most. */
export const MAX_SEEDS = 8;
/** Background frames start this long after the stream is known: its first moments are the player's. */
export const BACKGROUND_DELAY_MS = 1500;
/** Background frames are tried again after `busy` at most this many times per stream. */
export const MAX_BACKGROUND_RETRIES = 3;
/** Warming the preview core is asked for at most this often. */
export const WARM_INTERVAL_MS = 20_000;

/** A grid cell and the position previewed for it (`previewSlot`). */
export interface PreviewSlot {
  index: number;
  position: number;
}

/** A cell to make in the background, and as what. */
export interface BackgroundSlot extends PreviewSlot {
  kind: BackgroundKind;
}

/** The cells either side of `slot`, nearest first, inside the video. */
export function previewNeighbours(slot: PreviewSlot, duration: number): PreviewSlot[] {
  const step = previewStep(duration);
  const neighbours: PreviewSlot[] = [];
  for (const index of [slot.index + 1, slot.index - 1]) {
    const candidate = previewSlot(index * step + step / 2, duration);
    if (candidate.index === index) neighbours.push(candidate);
  }
  return neighbours;
}

/**
 * The cells to make as a stream loads, in order: where it started (and the
 * cell before, for a step back), then each of `starts` (chapter and
 * skip-part starts), at most `MAX_SEEDS`, then `STORYBOARD_FRAMES` spread
 * evenly over the video. No cell twice.
 */
export function backgroundSlots(
  duration: number,
  startPosition: number,
  starts: readonly number[],
): BackgroundSlot[] {
  const slots: BackgroundSlot[] = [];
  const seen = new Set<number>();
  const add = (position: number, kind: BackgroundKind) => {
    const slot = previewSlot(position, duration);
    if (seen.has(slot.index)) return;
    seen.add(slot.index);
    slots.push({ ...slot, kind });
  };
  const step = previewStep(duration);
  const seeds = [startPosition, startPosition - step, ...starts].filter(
    (position) => position >= 0 && position < duration,
  );
  for (const position of seeds) {
    if (slots.length >= MAX_SEEDS) break;
    add(position, 'prefetch');
  }
  for (let frame = 0; frame < STORYBOARD_FRAMES; frame++) {
    add(((frame + 0.5) / STORYBOARD_FRAMES) * duration, 'storyboard');
  }
  return slots;
}

/**
 * How far a stand-in frame may come from once the storyboard is there: half
 * the storyboard's spacing, so every cell has one within reach.
 */
export function storyboardReach(duration: number): number {
  const cells = Math.ceil(duration / previewStep(duration));
  return Math.max(NEAREST_CELLS, Math.ceil(cells / STORYBOARD_FRAMES / 2));
}

/**
 * Asks for previews, one request at a time, the most wanted first: the cell
 * under the pointer once it has been hovered for `HOVER_DELAY_MS` (and the
 * newest cell wanted when that one finishes; after `busy`, again
 * `BUSY_RETRY_MS` later if the pointer is still there); then, once the
 * pointer has rested `PREFETCH_DELAY_MS` on a cell it has, the cells either
 * side; then, with the pointer away or at rest, the background cells
 * (`background`), which stop for a while when the core is busy and give up
 * after `MAX_BACKGROUND_RETRIES` refusals.
 */
export class PreviewScheduler {
  private wanted: PreviewSlot | null = null;
  private neighbours: PreviewSlot[] = [];
  private wantedSince = 0;
  private queued: BackgroundSlot[] = [];
  private backgroundRetries = 0;
  private inFlight = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pausedByBusy = false;
  private warmedAt = -Infinity;

  constructor(
    private readonly cache: PreviewCache,
    private readonly request: (position: number, kind: PreviewKind) => Promise<unknown>,
    /** Called when the core answers (a frame to show, or that none is coming). */
    private readonly onResult: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The cell under the pointer (`null`: none, or nothing to fetch), and the
   * cells to prefetch once it rests there.
   */
  want(slot: PreviewSlot | null, neighbours: PreviewSlot[] = []): void {
    this.neighbours = neighbours;
    if (slot?.index === this.wanted?.index) return;
    this.wanted = slot;
    this.wantedSince = this.now();
    // The pointer left: background work goes on.
    this.schedule(slot ? HOVER_DELAY_MS : this.queued.length > 0 ? 0 : null);
  }

  /**
   * The cells to make while the pointer asks for nothing, in order, starting
   * `BACKGROUND_DELAY_MS` from now.
   */
  background(slots: BackgroundSlot[]): void {
    this.queued = slots;
    if (slots.length === 0 || this.timer !== undefined) return;
    this.schedule(BACKGROUND_DELAY_MS);
  }

  /**
   * The pointer reached the controls: has the core open the stream, so the
   * first preview doesn't wait for that. Not more than once in
   * `WARM_INTERVAL_MS`, and not once the stream is known to be unpreviewable.
   */
  warm(): void {
    const now = this.now();
    if (!this.cache.available || now - this.warmedAt < WARM_INTERVAL_MS) return;
    this.warmedAt = now;
    void this.request(0, 'warm').catch(() => undefined);
  }

  /**
   * Forgets everything wanted (the page went away). What's in flight still
   * lands in the cache; nothing follows it.
   */
  stop(): void {
    this.wanted = null;
    this.neighbours = [];
    this.queued = [];
    this.schedule(null);
  }

  /**
   * The core said it was busy and nothing has been asked since: a preview
   * is not on its way yet.
   */
  get paused(): boolean {
    return this.pausedByBusy;
  }

  private schedule(delay: number | null): void {
    clearTimeout(this.timer);
    this.timer =
      delay === null
        ? undefined
        : setTimeout(() => {
            this.timer = undefined;
            this.fetch();
          }, delay);
  }

  /** The hovered cell if still wanted; else, after a rest, a neighbour; else a background cell. */
  private fetch(): void {
    if (this.inFlight) return;
    const now = this.now();
    const target = this.wanted;
    if (target) {
      if (this.cache.wants(target.index, now)) {
        this.issue(target, 'hover');
        return;
      }
      // Refused for now (busy): the retry timer will ask again.
      if (!this.cache.get(target.index)) return;
      const rested = now - this.wantedSince;
      if (rested < PREFETCH_DELAY_MS) {
        this.schedule(PREFETCH_DELAY_MS - rested);
        return;
      }
      const next = this.neighbours.find((slot) =>
        this.cache.wantsBackground(slot.index, now, 'prefetch'),
      );
      if (next) {
        this.issue(next, 'prefetch');
        return;
      }
    }
    const next = this.queued.find((slot) => this.cache.wantsBackground(slot.index, now, slot.kind));
    if (next) this.issue(next, next.kind);
  }

  private issue(target: PreviewSlot, kind: PreviewKind): void {
    const hovered = this.wanted;
    this.inFlight = true;
    if (kind === 'hover') this.pausedByBusy = false;
    void this.request(target.position, kind)
      .then(
        (value) => parsePlayerPreview(value) ?? ({ status: 'unavailable' } as const),
        // Not attached, or no such command: worth trying on a later hover.
        () => ({ status: 'superseded' }) as const,
      )
      .then((result) => {
        this.inFlight = false;
        this.cache.record(target.index, result, this.now(), kind);
        if (kind === 'hover') this.pausedByBusy = result.status === 'busy';
        this.onResult();
        if (kind === 'hover') {
          if (result.status === 'busy') this.schedule(BUSY_RETRY_MS);
          // On to the next: the pointer moved while this one was made, or
          // (after a frame) a neighbour or the background is still to make.
          // Not after a refusal for the same cell, which would only be repeated.
          else if (result.status === 'frame' || this.wanted !== hovered) this.fetch();
        } else if (result.status === 'frame' || this.wanted !== hovered) {
          this.fetch();
        } else if (
          result.status === 'busy' &&
          this.queued.length > 0 &&
          this.backgroundRetries < MAX_BACKGROUND_RETRIES
        ) {
          // Plenty will be buffered in a while.
          this.backgroundRetries++;
          this.schedule(BUSY_RETRY_MS);
        }
      });
  }
}
