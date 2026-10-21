import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

import { titleKey } from '@/features/library/library-data';
import {
  describeError,
  libraryCommands,
  type HistoryEntry,
  type HistoryTitle,
  type LibraryTitle,
  type PlaybackProgress,
  type TitleLibraryState,
  type WatchlistItem,
} from '@/services/native';

/** The native commands the store depends on; a fake is injected in tests. */
export type LibraryBackend = typeof libraryCommands;

/** A list read from the Rust core. Reloads keep showing the previous items. */
export interface LibraryList<T> {
  status: 'idle' | 'loading' | 'ready' | 'error';
  items: T[];
  error: string | null;
}

type ListName = 'watchlist' | 'history' | 'continueWatching';

/** How many recently watched titles Discover shows. */
export const CONTINUE_WATCHING_LIMIT = 20;
/** How many titles the Library's history loads (`library::MAX_LIST_LIMIT`). */
export const HISTORY_LIMIT = 1_000;

export interface LibraryState {
  watchlist: LibraryList<WatchlistItem>;
  /** Recently watched titles (the latest video of each), newest first. */
  history: LibraryList<HistoryTitle>;
  continueWatching: LibraryList<HistoryEntry>;
  /** Per-title state by {@link titleKey}, for title pages and the player. */
  titles: Record<string, TitleLibraryState>;

  /**
   * (Re)reads a list. Library data is local and cheap to query, so pages
   * reload on mount instead of tracking staleness.
   */
  load: (list: ListName) => Promise<void>;
  loadTitle: (type: string, id: string) => Promise<TitleLibraryState | null>;
  addToWatchlist: (title: LibraryTitle) => Promise<void>;
  removeFromWatchlist: (type: string, id: string) => Promise<void>;
  /** Saves progress. Lists pick it up on their next load. */
  recordProgress: (progress: PlaybackProgress) => Promise<void>;
  removeFromHistory: (type: string, id: string) => Promise<void>;
  clearHistory: () => Promise<void>;
  /**
   * Forgets everything read (another profile is now active): lists go back
   * to idle and responses still on their way are ignored.
   */
  clear: () => void;
}

function emptyList<T>(): LibraryList<T> {
  return { status: 'idle', items: [], error: null };
}

export function createLibraryStore(backend: LibraryBackend) {
  /** Latest request per list, so a slow earlier response can't overwrite a newer one. */
  const requests: Record<ListName, number> = { watchlist: 0, history: 0, continueWatching: 0 };
  const fetchers = {
    watchlist: () => backend.watchlist(),
    history: () => backend.history(HISTORY_LIMIT),
    continueWatching: () => backend.continueWatching(CONTINUE_WATCHING_LIMIT),
  };

  return createStore<LibraryState>()((set, get) => {
    const updateTitle = (
      type: string,
      id: string,
      update: (state: TitleLibraryState) => TitleLibraryState,
    ) => {
      const key = titleKey(type, id);
      const current = get().titles[key];
      if (current) set((state) => ({ titles: { ...state.titles, [key]: update(current) } }));
    };

    const setList = (
      list: ListName,
      update: (current: LibraryList<unknown>) => LibraryList<unknown>,
    ) =>
      // Not type-checked per list: `update` only changes status fields or sets
      // the items `fetchers[list]` returned.
      set((state) => ({ [list]: update(state[list]) }));

    const matches = (type: string, id: string) => (entry: { title: LibraryTitle }) =>
      entry.title.type === type && entry.title.id === id;

    return {
      watchlist: emptyList(),
      history: emptyList(),
      continueWatching: emptyList(),
      titles: {},

      async load(list) {
        const request = ++requests[list];
        setList(list, (current) => ({
          ...current,
          status: current.status === 'ready' ? 'ready' : 'loading',
          error: null,
        }));
        try {
          const items: unknown[] = await fetchers[list]();
          if (request === requests[list]) {
            setList(list, () => ({ status: 'ready', items, error: null }));
          }
        } catch (error) {
          if (request !== requests[list]) return;
          setList(list, (current) => ({
            ...current,
            status: 'error',
            error: describeError(error),
          }));
        }
      },

      async loadTitle(type, id) {
        try {
          const titleState = await backend.titleState(type, id);
          set((state) => ({ titles: { ...state.titles, [titleKey(type, id)]: titleState } }));
          return titleState;
        } catch {
          return null;
        }
      },

      async addToWatchlist(title) {
        const item = await backend.addToWatchlist(title);
        updateTitle(title.type, title.id, (state) => ({ ...state, inWatchlist: true }));
        set((state) => ({
          watchlist: {
            ...state.watchlist,
            items: [
              item,
              ...state.watchlist.items.filter((other) => !matches(title.type, title.id)(other)),
            ],
          },
        }));
      },

      async removeFromWatchlist(type, id) {
        await backend.removeFromWatchlist(type, id);
        updateTitle(type, id, (state) => ({ ...state, inWatchlist: false }));
        set((state) => ({
          watchlist: {
            ...state.watchlist,
            items: state.watchlist.items.filter((item) => !matches(type, id)(item)),
          },
        }));
      },

      async recordProgress(progress) {
        const entry = await backend.recordProgress(progress);
        updateTitle(entry.title.type, entry.title.id, (state) => ({
          ...state,
          progress: [entry, ...state.progress.filter((other) => other.video.id !== entry.video.id)],
        }));
      },

      async removeFromHistory(type, id) {
        await backend.removeFromHistory(type, id);
        updateTitle(type, id, (state) => ({ ...state, progress: [] }));
        const keep = (entry: HistoryEntry) => !matches(type, id)(entry);
        set((state) => ({
          history: { ...state.history, items: state.history.items.filter(keep) },
          continueWatching: {
            ...state.continueWatching,
            items: state.continueWatching.items.filter(keep),
          },
        }));
      },

      clear() {
        for (const list of Object.keys(requests) as ListName[]) requests[list] += 1;
        set({
          watchlist: emptyList(),
          history: emptyList(),
          continueWatching: emptyList(),
          titles: {},
        });
      },

      async clearHistory() {
        await backend.clearHistory();
        set((state) => ({
          history: { ...state.history, items: [] },
          continueWatching: { ...state.continueWatching, items: [] },
          titles: Object.fromEntries(
            Object.entries(state.titles).map(([key, title]) => [key, { ...title, progress: [] }]),
          ),
        }));
      },
    };
  });
}

export const libraryStore = createLibraryStore(libraryCommands);

export function useLibraryStore<T>(selector: (state: LibraryState) => T): T {
  return useStore(libraryStore, selector);
}
