import type { Video } from '@kiro/addon-sdk';
import { Check, CheckCheck, RotateCcw } from 'lucide-react';
import { useEffect } from 'react';

import type { MenuAction } from '@/components/action-menu';
import { titleKey } from '@/features/library/library-data';
import { libraryStore, useLibraryStore } from '@/features/library/library-store';
import {
  episodeMarks,
  seasonEpisodes,
  showEpisodes,
  videosToMark,
  videosToUnmark,
  watchedState,
} from '@/features/library/watched-data';
import { librarySnapshot, movieMedia, type Season } from '@/features/title/title-data';
import type { HistoryEntry, LibraryTitle } from '@/services/native';

/**
 * Menu actions that mark titles watched or unwatched by hand (see
 * watched-data.ts for what they send).
 */

function markWatched(title: LibraryTitle, videos: Video[]) {
  return libraryStore.getState().markWatched(title, videos.map(librarySnapshot));
}

function markUnwatched(title: LibraryTitle, ids: string[]) {
  return libraryStore.getState().markUnwatched(title, ids);
}

/** Whether a film is watched, for its poster; reads the watched films once. */
export function useWatchedFilm(type: string, id: string): boolean {
  const watched = useLibraryStore((state) => Boolean(state.watchedFilms.keys[titleKey(type, id)]));
  const load = useLibraryStore((state) => state.loadWatchedFilms);
  useEffect(() => {
    void load();
  }, [load]);
  return watched;
}

/** A film's: mark it watched, or unwatched. Nothing for other types. */
export function filmActions(title: LibraryTitle, watched: boolean): MenuAction[] {
  if (title.type !== 'movie') return [];
  return watched
    ? [
        {
          label: 'Mark as unwatched',
          icon: RotateCcw,
          run: () => markUnwatched(title, [title.id]),
        },
      ]
    : [
        {
          label: 'Mark as watched',
          icon: Check,
          run: () => libraryStore.getState().markWatched(title, [movieMedia(title).video]),
        },
      ];
}

/** An episode's: watched or unwatched, and "Mark watched up to here". */
export function episodeActions(
  title: LibraryTitle,
  seasons: Season[],
  progress: HistoryEntry[],
  video: Video,
): MenuAction[] {
  const marks = episodeMarks(seasons, progress, video.id);
  const actions: MenuAction[] = [
    marks.watched
      ? {
          label: 'Mark as unwatched',
          icon: RotateCcw,
          run: () => markUnwatched(title, [video.id]),
        }
      : { label: 'Mark as watched', icon: Check, run: () => markWatched(title, [video]) },
  ];
  const upTo = marks.upTo;
  if (upTo) {
    actions.push({
      label: 'Mark watched up to here',
      icon: CheckCheck,
      run: () => markWatched(title, upTo),
    });
  }
  return actions;
}

/** `Season 2`, or `Specials`. */
export function seasonName(number: number) {
  return number === 0 ? 'Specials' : `Season ${number}`;
}

/** A season's: all of its episodes watched, or (asking first) unwatched. */
export function seasonActions(
  title: LibraryTitle,
  seasons: Season[],
  progress: HistoryEntry[],
  number: number,
): MenuAction[] {
  const name = seasonName(number);
  return groupActions(title, progress, seasonEpisodes(seasons, number), {
    watched: `Mark ${name} as watched`,
    unwatched: `Mark ${name} as unwatched`,
    question: `Forget your progress in every episode of ${name}?`,
  });
}

/** The whole show's: every episode watched, or (asking first) unwatched. */
export function showActions(
  title: LibraryTitle,
  seasons: Season[],
  progress: HistoryEntry[],
): MenuAction[] {
  const episodes = showEpisodes(seasons);
  const actions = groupActions(title, progress, episodes, {
    watched: 'Mark show as watched',
    unwatched: 'Mark show as unwatched',
    question: `Forget your progress in every episode of ${title.name}?`,
  });
  // Unwatching the whole show also forgets episodes no longer listed.
  return actions.map((action) =>
    action.confirm
      ? { ...action, run: () => libraryStore.getState().removeFromHistory(title.type, title.id) }
      : action,
  );
}

function groupActions(
  title: LibraryTitle,
  progress: HistoryEntry[],
  episodes: Video[],
  labels: { watched: string; unwatched: string; question: string },
): MenuAction[] {
  const state = watchedState(progress, episodes);
  const actions: MenuAction[] = [];
  if (episodes.length > 0 && state !== 'all') {
    actions.push({
      label: labels.watched,
      icon: CheckCheck,
      run: () => markWatched(title, videosToMark(progress, episodes)),
    });
  }
  if (state !== 'none') {
    actions.push({
      label: labels.unwatched,
      icon: RotateCcw,
      confirm: { question: labels.question, label: 'Mark unwatched' },
      run: () => markUnwatched(title, videosToUnmark(progress, episodes)),
    });
  }
  return actions;
}
