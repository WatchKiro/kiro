/** The player state progress tracking needs (`PlayerStatus` satisfies it). */
export interface PlaybackSample {
  idle: boolean;
  paused: boolean;
  position: number | null;
  duration: number | null;
}

export interface ProgressPoint {
  position: number;
  duration: number;
}

/** Save at most this often during playback. */
export const SAVE_INTERVAL_MS = 10_000;
/** Don't overwrite saved progress with a position this early. */
export const MIN_SAVE_SECONDS = 5;
/** Stopping this close to the end counts as watching to the end. */
export const END_MARGIN_SECONDS = 30;
/** How long to wait for an expected seek to show up in samples. */
export const SEEK_GRACE_MS = 5_000;
/** How close a sample must be to an expected seek target to count as arrived. */
const SEEK_TOLERANCE_SECONDS = 10;

/**
 * Decides when playback progress is worth saving: every
 * {@link SAVE_INTERVAL_MS} while playing, on pause, when playback stops
 * (near the end: as finished) and when the player is left.
 */
export class ProgressTracker {
  /** The latest position while playing. */
  private last: ProgressPoint | null = null;
  private saved: { at: number; position: number } | null = null;
  private wasPaused = false;
  private pendingSeek: { target: number; until: number } | null = null;

  /**
   * Announces a seek (e.g. resuming): until a sample near `target` arrives,
   * samples still showing the old position are ignored so they can't
   * overwrite the progress being resumed.
   */
  expectSeek(target: number, now: number) {
    this.pendingSeek = { target, until: now + SEEK_GRACE_MS };
  }

  /** Feeds a player sample; returns progress to save now, if any. */
  next(sample: PlaybackSample, now: number): ProgressPoint | null {
    const seek = this.pendingSeek;
    if (seek && now < seek.until) {
      const arrived =
        sample.position !== null &&
        Math.abs(sample.position - seek.target) <= SEEK_TOLERANCE_SECONDS;
      if (!arrived) return null;
    }
    this.pendingSeek = null;

    if (sample.idle) {
      // Playback stopped after it had started: at the end, or on an error.
      const final = this.last;
      if (!final) return null;
      this.last = null;
      const ended = final.duration - final.position <= END_MARGIN_SECONDS;
      return this.mark(ended ? { ...final, position: final.duration } : final, now);
    }
    if (sample.position === null || !sample.duration) return null;

    const current = { position: sample.position, duration: sample.duration };
    this.last = current;
    const justPaused = sample.paused && !this.wasPaused;
    this.wasPaused = sample.paused;
    if (current.position < MIN_SAVE_SECONDS) return null;

    const previous = this.saved;
    const due = !previous || now - previous.at >= SAVE_INTERVAL_MS;
    const moved = !previous || Math.abs(previous.position - current.position) >= 1;
    return (due || justPaused) && moved ? this.mark(current, now) : null;
  }

  /** Progress to save when leaving the player, if any is unsaved. */
  flush(now: number): ProgressPoint | null {
    const final = this.last;
    if (!final || final.position < MIN_SAVE_SECONDS) return null;
    if (this.saved?.position === final.position) return null;
    return this.mark(final, now);
  }

  private mark(point: ProgressPoint, now: number) {
    this.saved = { at: now, position: point.position };
    return point;
  }
}
