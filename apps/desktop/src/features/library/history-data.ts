import { continueTarget, entryPath, MIN_RESUME_SECONDS } from '@/features/library/library-data';
import { episodeMedia, titlePath, type Season } from '@/features/title/title-data';
import type { HistoryEntry } from '@/services/native';

/** Which titles the history shows. */
export type HistoryFilter = 'all' | 'movie' | 'series';

/** Entries watched in the same period, e.g. "Yesterday" or "September". */
export interface HistoryGroup<T> {
  key: string;
  label: string;
  items: T[];
}

type Period = 'today' | 'yesterday' | 'week' | 'earlier';

/** Local midnight of the day `days` before `timestamp`'s day (DST-safe). */
function startOfDay(timestamp: number, days = 0) {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - days).getTime();
}

function period(timestamp: number, now: number): Period {
  if (timestamp >= startOfDay(now)) return 'today';
  if (timestamp >= startOfDay(now, 1)) return 'yesterday';
  // The five days before yesterday: within the last week.
  if (timestamp >= startOfDay(now, 6)) return 'week';
  return 'earlier';
}

const monthFormat = new Intl.DateTimeFormat(undefined, { month: 'long' });
const monthYearFormat = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });

/**
 * Splits entries (newest first) into Today, Yesterday, This week, then one
 * group per month, e.g. "September" or "August 2025" for another year.
 */
export function groupHistory<T extends Pick<HistoryEntry, 'updatedAt'>>(
  items: T[],
  now = Date.now(),
): HistoryGroup<T>[] {
  const groups = new Map<string, HistoryGroup<T>>();
  for (const item of items) {
    const when = period(item.updatedAt, now);
    let key: string = when;
    let label = when === 'today' ? 'Today' : when === 'yesterday' ? 'Yesterday' : 'This week';
    if (when === 'earlier') {
      const date = new Date(item.updatedAt);
      key = `${date.getFullYear()}-${date.getMonth()}`;
      label = (
        date.getFullYear() === new Date(now).getFullYear() ? monthFormat : monthYearFormat
      ).format(date);
    }
    const group = groups.get(key) ?? { key, label, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** Lower case without accents, so "shogun" finds "Shōgun". */
function fold(text: string) {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase();
}

/** Entries of the chosen kind whose title or episode name contains `query`. */
export function filterHistory<T extends Pick<HistoryEntry, 'title' | 'video'>>(
  items: T[],
  filter: HistoryFilter,
  query: string,
): T[] {
  const needle = fold(query.trim());
  return items.filter(
    (item) =>
      (filter === 'all' || item.title.type === filter) &&
      (!needle ||
        fold(item.title.name).includes(needle) ||
        (item.video.name !== null && fold(item.video.name).includes(needle))),
  );
}

/** An entry's main button: where it goes and what it says. */
export interface HistoryAction {
  kind: 'resume' | 'play' | 'next' | 'again';
  label: string;
  href: string;
}

/**
 * Resume unfinished progress, offer the next episode after a finished one,
 * or watch a finished film (or series) again. `seasons` is the series'
 * episodes: `undefined` while loading, `null` if they couldn't be loaded.
 */
export function historyAction(
  entry: Pick<HistoryEntry, 'title' | 'video' | 'completed' | 'position'>,
  seasons: Season[] | null | undefined,
): HistoryAction {
  const target = continueTarget(entry, seasons);
  switch (target.kind) {
    case 'resume':
      return entry.position >= MIN_RESUME_SECONDS
        ? { kind: 'resume', label: 'Resume', href: entryPath(entry) }
        : { kind: 'play', label: 'Play', href: entryPath(entry) };
    case 'next':
      return {
        kind: 'next',
        label: 'Next episode',
        href: entryPath({
          title: entry.title,
          video: episodeMedia(entry.title, target.video).video,
        }),
      };
    // Until the episodes are known (or if they can't be), the title page
    // selects the next episode itself.
    case 'pending':
    case 'title':
      return {
        kind: 'next',
        label: 'Next episode',
        href: titlePath(entry.title.type, entry.title.id),
      };
    case 'done':
      return { kind: 'again', label: 'Watch again', href: entryPath(entry) };
  }
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const weekdayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  hour: 'numeric',
  minute: '2-digit',
});
const dayFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const dayYearFormat = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/**
 * When an entry was watched, to sit under its group's heading: the time today
 * and yesterday, the weekday this week, else the date.
 */
export function formatWatchedAt(timestamp: number, now = Date.now()): string {
  const when = period(timestamp, now);
  if (when === 'today' || when === 'yesterday') return timeFormat.format(timestamp);
  if (when === 'week') return weekdayFormat.format(timestamp);
  return (
    new Date(timestamp).getFullYear() === new Date(now).getFullYear() ? dayFormat : dayYearFormat
  ).format(timestamp);
}

/** e.g. `45 min left`, `1 hr 12 min left`. */
export function formatTimeLeft(entry: Pick<HistoryEntry, 'position' | 'duration'>): string {
  const minutes = Math.max(1, Math.round(Math.max(entry.duration - entry.position, 0) / 60));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min left`;
  return rest === 0 ? `${hours} hr left` : `${hours} hr ${rest} min left`;
}
