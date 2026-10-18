/** Restricts `value` to the inclusive range `[min, max]`. `NaN` resolves to `min`. */
export function clamp(value: number, min: number, max: number): number {
  if (min > max) throw new RangeError(`clamp: min (${min}) must not exceed max (${max})`);
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * Formats a duration in seconds as `m:ss` or `h:mm:ss`, the format used by
 * playback controls. Negative and non-finite values render as `0:00`.
 */
export function formatDuration(totalSeconds: number): string {
  const safe = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.floor(totalSeconds) : 0;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const ss = String(seconds).padStart(2, '0');

  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${ss}` : `${minutes}:${ss}`;
}
