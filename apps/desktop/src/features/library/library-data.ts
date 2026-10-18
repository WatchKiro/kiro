import type { Video } from '@kiro/addon-sdk';
import { clamp } from '@kiro/utils';

import { episodeAfter, titlePath, type Season } from '@/features/title/title-data';
import type { HistoryEntry, LibraryVideo } from '@/services/native';

/** Mirrors `library::MIN_RESUME_SECONDS`: earlier progress isn't worth resuming. */
export const MIN_RESUME_SECONDS = 15;

/** Key of a title in the library store. */
export function titleKey(type: string, id: string) {
  return JSON.stringify([type, id]);
}

/** How much of the video has been watched, 0–1. */
export function progressFraction(entry: Pick<HistoryEntry, 'position' | 'duration'>) {
  return entry.duration > 0 ? clamp(entry.position / entry.duration, 0, 1) : 0;
}

/** Where to resume `entry` from, or `null` when it is finished or barely started. */
export function resumePosition(entry: HistoryEntry | undefined): number | null {
  if (!entry || entry.completed || entry.position < MIN_RESUME_SECONDS) return null;
  return entry.position;
}

/** e.g. `S1 E2 · Pilot`; `null` for a movie. */
export function videoLabel(video: LibraryVideo): string | null {
  const number =
    video.season === null && video.episode === null
      ? null
      : video.season === 0
        ? `Special ${video.episode ?? ''}`.trim()
        : `S${video.season ?? '?'} E${video.episode ?? '?'}`;
  return [number, video.name].filter(Boolean).join(' · ') || null;
}

/** The title page of a history entry, with its episode selected. */
export function entryPath(entry: Pick<HistoryEntry, 'title' | 'video'>) {
  const path = titlePath(entry.title.type, entry.title.id);
  return entry.video.id === entry.title.id
    ? path
    : `${path}?${new URLSearchParams({ episode: entry.video.id }).toString()}`;
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600_000],
  ['month', 30 * 24 * 3600_000],
  ['week', 7 * 24 * 3600_000],
  ['day', 24 * 3600_000],
  ['hour', 3600_000],
  ['minute', 60_000],
];

/** e.g. `5 minutes ago`, `yesterday`; `just now` under a minute. */
export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const elapsed = now - timestamp;
  for (const [unit, size] of UNITS) {
    if (elapsed >= size) return relative.format(-Math.floor(elapsed / size), unit);
  }
  return 'just now';
}

/** What a "Continue watching" card offers for an entry. */
export type ContinueTarget =
  /** Unfinished: resume this video. */
  | { kind: 'resume' }
  /** A finished episode with one after it: offer that. */
  | { kind: 'next'; video: Video }
  /** A finished episode, the series' episodes not known yet. */
  | { kind: 'pending' }
  /** A finished episode whose series details couldn't be loaded: open the title. */
  | { kind: 'title' }
  /** Nothing left to watch (a finished film, or the last episode). */
  | { kind: 'done' };

/**
 * Decides what a "Continue watching" entry offers. `seasons` is the series'
 * episodes: `undefined` while loading, `null` if they couldn't be loaded.
 */
export function continueTarget(
  entry: Pick<HistoryEntry, 'title' | 'video' | 'completed'>,
  seasons: Season[] | null | undefined,
): ContinueTarget {
  if (!entry.completed) return { kind: 'resume' };
  if (entry.title.type !== 'series') return { kind: 'done' };
  if (seasons === undefined) return { kind: 'pending' };
  if (seasons === null) return { kind: 'title' };
  const next = episodeAfter(seasons, entry.video.id);
  return next ? { kind: 'next', video: next } : { kind: 'done' };
}
