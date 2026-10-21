/**
 * The Stats overlay's audio line: whether the soundtrack goes to the
 * receiver untouched (audio passthrough) or is decoded, and through which
 * of mpv's audio outputs.
 */
import type { PlayerStats } from '@/services/player';

/**
 * `passthrough eac3 · wasapi`, `decoded ac3 · coreaudio`, or `—` without
 * audio. A decoded track names its codec, so a format that was meant to pass
 * through but didn't (the output refused it) is easy to spot.
 */
export function describeAudio(
  stats: Pick<PlayerStats, 'audioCodec' | 'audioMode' | 'audioOutput'> | null,
): string {
  if (!stats?.audioMode) return '—';
  const mode =
    stats.audioMode === 'decoded' && stats.audioCodec
      ? `decoded ${stats.audioCodec}`
      : stats.audioMode;
  return stats.audioOutput ? `${mode} · ${stats.audioOutput}` : mode;
}
