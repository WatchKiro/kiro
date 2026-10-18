import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { titleKey } from '@/features/library/library-data';
import { createLibraryStore, type LibraryBackend } from '@/features/library/library-store';
import type {
  HistoryEntry,
  LibraryTitle,
  PlaybackProgress,
  WatchlistItem,
} from '@/services/native';

const movie: LibraryTitle = { type: 'movie', id: 'tt1', name: 'Movie', poster: null };
const show: LibraryTitle = {
  type: 'series',
  id: 'tt2',
  name: 'Show',
  poster: 'https://img.example/tt2.jpg',
};

function progress(title: LibraryTitle, videoId: string, position: number): PlaybackProgress {
  return {
    title,
    video: { id: videoId, season: null, episode: null, name: null },
    position,
    duration: 1000,
  };
}

/** In-memory stand-in for the Rust commands, with the same list semantics. */
function fakeBackend() {
  let clock = 0;
  let watchlist: WatchlistItem[] = [];
  let history: HistoryEntry[] = [];
  const same = (type: string, id: string) => (entry: { title: LibraryTitle }) =>
    entry.title.type === type && entry.title.id === id;
  const latestPerTitle = () =>
    history
      .toSorted((a, b) => b.updatedAt - a.updatedAt)
      .filter(
        (entry, index, sorted) =>
          sorted.findIndex(same(entry.title.type, entry.title.id)) === index,
      );
  const calls: string[] = [];

  const backend: LibraryBackend = {
    watchlist: () => Promise.resolve(watchlist),
    addToWatchlist: (title) => {
      const item = { title, addedAt: ++clock };
      watchlist = [item, ...watchlist.filter((other) => !same(title.type, title.id)(other))];
      return Promise.resolve(item);
    },
    removeFromWatchlist: (type, id) => {
      watchlist = watchlist.filter((item) => !same(type, id)(item));
      return Promise.resolve();
    },
    recordProgress: ({ title, video, position, duration }) => {
      calls.push(`record ${video.id} ${position}`);
      const entry: HistoryEntry = {
        title,
        video,
        position,
        duration,
        completed: position >= duration * 0.9,
        updatedAt: ++clock,
      };
      history = [entry, ...history.filter((other) => other.video.id !== video.id)];
      return Promise.resolve(entry);
    },
    history: () =>
      Promise.resolve(
        latestPerTitle().map((entry) => ({
          ...entry,
          playedVideos: history.filter(same(entry.title.type, entry.title.id)).length,
        })),
      ),
    continueWatching: (limit) =>
      Promise.resolve(
        latestPerTitle()
          .filter((entry) => !entry.completed)
          .slice(0, limit),
      ),
    titleState: (type, id) =>
      Promise.resolve({
        inWatchlist: watchlist.some(same(type, id)),
        progress: history.filter(same(type, id)),
      }),
    removeFromHistory: (type, id) => {
      history = history.filter((entry) => !same(type, id)(entry));
      return Promise.resolve();
    },
    clearHistory: () => {
      history = [];
      return Promise.resolve();
    },
  };
  return { backend, calls };
}

describe('library store', () => {
  let fake: ReturnType<typeof fakeBackend>;
  beforeEach(() => {
    fake = fakeBackend();
  });

  it('loads lists and keeps showing items while reloading', async () => {
    const store = createLibraryStore(fake.backend);
    assert.equal(store.getState().watchlist.status, 'idle');

    await fake.backend.addToWatchlist(movie);
    await store.getState().load('watchlist');
    assert.equal(store.getState().watchlist.status, 'ready');
    assert.deepEqual(
      store.getState().watchlist.items.map((item) => item.title.id),
      ['tt1'],
    );

    const reload = store.getState().load('watchlist');
    assert.equal(store.getState().watchlist.status, 'ready', 'no loading flash on reload');
    await reload;
  });

  it('records load errors and ignores responses that a newer load superseded', async () => {
    const store = createLibraryStore({
      ...fake.backend,
      // Tauri rejects with the command's serialised `{ code, message }` error.
      history: () =>
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        Promise.reject({ code: 'DATABASE_ERROR', message: 'An internal error occurred' }),
    });
    await store.getState().load('history');
    assert.deepEqual(store.getState().history, {
      status: 'error',
      items: [],
      error: 'An internal error occurred',
    });

    let resolveSlow: (items: HistoryEntry[]) => void = () => undefined;
    let call = 0;
    const racing = createLibraryStore({
      ...fake.backend,
      continueWatching: () =>
        ++call === 1
          ? new Promise((resolve) => (resolveSlow = resolve))
          : fake.backend.continueWatching(20),
    });
    await fake.backend.recordProgress(progress(movie, 'tt1', 100));
    const slow = racing.getState().load('continueWatching');
    await racing.getState().load('continueWatching');
    resolveSlow([]);
    await slow;
    assert.equal(racing.getState().continueWatching.items.length, 1);
  });

  it('toggles the watchlist and keeps title state and the list in sync', async () => {
    const store = createLibraryStore(fake.backend);
    await store.getState().load('watchlist');
    await store.getState().loadTitle(show.type, show.id);
    const title = () => store.getState().titles[titleKey(show.type, show.id)];
    assert.equal(title()?.inWatchlist, false);

    await store.getState().addToWatchlist(movie);
    await store.getState().addToWatchlist(show);
    assert.equal(title()?.inWatchlist, true);
    assert.deepEqual(
      store.getState().watchlist.items.map((item) => item.title.id),
      ['tt2', 'tt1'],
    );

    await store.getState().removeFromWatchlist(show.type, show.id);
    assert.equal(title()?.inWatchlist, false);
    assert.deepEqual(
      store.getState().watchlist.items.map((item) => item.title.id),
      ['tt1'],
    );
  });

  it('records progress into loaded title state, and removes and clears history', async () => {
    const store = createLibraryStore(fake.backend);
    await store.getState().loadTitle(show.type, show.id);
    await store.getState().recordProgress(progress(show, 'tt2:1:1', 100));
    await store.getState().recordProgress(progress(show, 'tt2:1:2', 50));
    await store.getState().recordProgress(progress(show, 'tt2:1:1', 950));
    await store.getState().recordProgress(progress(movie, 'tt1', 300));

    const showState = store.getState().titles[titleKey(show.type, show.id)];
    assert.deepEqual(
      showState?.progress.map((entry) => [entry.video.id, entry.position]),
      [
        ['tt2:1:1', 950],
        ['tt2:1:2', 50],
      ],
    );
    // Titles that were never loaded are not tracked.
    assert.equal(store.getState().titles[titleKey(movie.type, movie.id)], undefined);

    await store.getState().load('history');
    await store.getState().load('continueWatching');
    assert.deepEqual(
      store.getState().history.items.map((entry) => entry.title.id),
      ['tt1', 'tt2'],
    );
    // The show's latest episode is finished.
    assert.deepEqual(
      store.getState().continueWatching.items.map((entry) => entry.title.id),
      ['tt1'],
    );

    await store.getState().removeFromHistory(movie.type, movie.id);
    assert.deepEqual(
      store.getState().history.items.map((entry) => entry.title.id),
      ['tt2'],
    );
    assert.deepEqual(store.getState().continueWatching.items, []);

    await store.getState().clearHistory();
    assert.deepEqual(store.getState().history.items, []);
    assert.deepEqual(store.getState().titles[titleKey(show.type, show.id)]?.progress, []);
  });
});
