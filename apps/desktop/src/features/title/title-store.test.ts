import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { parseManifest, type ResourceRequest } from '@kiro/addon-sdk';

import type { InstalledAddon } from '@/features/addons/addons-store';
import {
  classifyStream,
  groupSeasons,
  nextEpisode,
  episodeAfter,
  metaKey,
  releaseYear,
  streamsKey,
} from '@/features/title/title-data';
import { createTitleStore, type TitleBackend } from '@/features/title/title-store';

function addon(name: string, resources: unknown[], idPrefixes?: string[]): InstalledAddon {
  const manifest = parseManifest({
    id: `org.${name.toLowerCase()}`,
    version: '1.0.0',
    name,
    types: ['movie', 'series'],
    resources,
    idPrefixes,
  });
  assert.ok(manifest.ok);
  return {
    transportUrl: `https://${name.toLowerCase()}.example/manifest.json`,
    manifest: manifest.value,
  };
}

const META = addon('Meta', ['meta'], ['tt']);
const BACKUP = addon('Backup', ['meta']);
const STREAMS = addon('Streams', ['stream'], ['tt']);
const MOVIES = addon('Movies', [{ name: 'stream', types: ['movie'] }]);
const OTHER = addon('Other', ['stream'], ['kitsu:']);
const ADDONS = [META, BACKUP, STREAMS, MOVIES, OTHER];

type Handler = () => Promise<unknown>;

/** Routes requests to per-addon, per-resource handlers and records them. */
function fakeBackend() {
  const calls: [string, ResourceRequest][] = [];
  const handlers = new Map<string, Handler>();
  const backend: TitleBackend = {
    fetchResource: (url, request) => {
      calls.push([url, request]);
      const handler = handlers.get(`${url} ${request.resource}`);
      // Tauri rejects with the command's serialised `{ code, message }` error.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return handler ? handler() : Promise.reject({ code: 'ADDON_ERROR', message: 'Unreachable' });
    },
  };
  const on = (target: InstalledAddon, resource: string, handler: Handler) =>
    handlers.set(`${target.transportUrl} ${resource}`, handler);
  return { backend, calls, on };
}

const movieMeta = { meta: { id: 'tt1', type: 'movie', name: 'Movie', releaseInfo: '1999' } };

describe('title store', () => {
  let fake: ReturnType<typeof fakeBackend>;
  beforeEach(() => {
    fake = fakeBackend();
  });

  it('loads metadata once from the first supporting addon', async () => {
    fake.on(META, 'meta', () => Promise.resolve(movieMeta));
    const store = createTitleStore(fake.backend);

    await Promise.all([
      store.getState().loadMeta(ADDONS, 'movie', 'tt1'),
      store.getState().loadMeta(ADDONS, 'movie', 'tt1'),
    ]);
    await store.getState().loadMeta(ADDONS, 'movie', 'tt1');

    assert.deepEqual(fake.calls, [
      [META.transportUrl, { resource: 'meta', type: 'movie', id: 'tt1' }],
    ]);
    const entry = store.getState().metas[metaKey('movie', 'tt1', [META, BACKUP])];
    assert.equal(entry?.status, 'ready');
    assert.equal(entry.status === 'ready' && entry.addonName, 'Meta');
  });

  it('falls back to the next addon when one fails or returns invalid data', async () => {
    fake.on(META, 'meta', () => Promise.resolve({ meta: { id: 'tt1' } }));
    fake.on(BACKUP, 'meta', () => Promise.resolve(movieMeta));
    const store = createTitleStore(fake.backend);

    await store.getState().loadMeta(ADDONS, 'movie', 'tt1');
    const entry = store.getState().metas[metaKey('movie', 'tt1', [META, BACKUP])];
    assert.equal(entry?.status === 'ready' && entry.addonName, 'Backup');
  });

  it('reports the first failure when every addon fails, and retries on demand', async () => {
    const store = createTitleStore(fake.backend);
    const key = metaKey('movie', 'tt1', [META, BACKUP]);

    await store.getState().loadMeta(ADDONS, 'movie', 'tt1');
    assert.deepEqual(store.getState().metas[key], {
      status: 'error',
      message: 'Meta: Unreachable',
    });

    fake.on(META, 'meta', () => Promise.resolve(movieMeta));
    await store.getState().loadMeta(ADDONS, 'movie', 'tt1');
    assert.equal(store.getState().metas[key]?.status, 'error', 'cached until forced');
    await store.getState().loadMeta(ADDONS, 'movie', 'tt1', { force: true });
    assert.equal(store.getState().metas[key]?.status, 'ready');
  });

  it('respects id prefixes and reports when no addon provides details', async () => {
    const store = createTitleStore(fake.backend);
    await store.getState().loadMeta([META], 'movie', 'kitsu:1');
    assert.equal(fake.calls.length, 0);
    assert.equal(store.getState().metas[metaKey('movie', 'kitsu:1', [])]?.status, 'error');
  });

  it('queries every stream addon in parallel and keeps results per addon', async () => {
    let release: (() => void) | undefined;
    fake.on(STREAMS, 'stream', () =>
      Promise.resolve({ streams: [{ url: 'https://cdn.example/a.mp4' }, { name: 'no source' }] }),
    );
    fake.on(
      MOVIES,
      'stream',
      () =>
        new Promise((resolve) => {
          release = () => resolve({ streams: [{ infoHash: 'a'.repeat(40) }] });
        }),
    );
    const store = createTitleStore(fake.backend);

    const pending = store.getState().loadStreams(ADDONS, 'movie', 'tt1');
    // Both requests are in flight before either finishes; OTHER (kitsu:) is skipped.
    assert.deepEqual(
      fake.calls.map(([url]) => url),
      [STREAMS.transportUrl, MOVIES.transportUrl],
    );
    await new Promise((resolve) => setImmediate(resolve));
    const streams = () => store.getState().streams;
    const ready = streams()[streamsKey(STREAMS.transportUrl, 'movie', 'tt1')];
    assert.equal(ready?.status === 'ready' && ready.streams.length, 1);
    assert.equal(streams()[streamsKey(MOVIES.transportUrl, 'movie', 'tt1')]?.status, 'loading');

    release?.();
    await pending;
    assert.equal(streams()[streamsKey(MOVIES.transportUrl, 'movie', 'tt1')]?.status, 'ready');

    // Episodes are requested by video id; MOVIES only serves movies.
    await store.getState().loadStreams(ADDONS, 'series', 'tt2:1:1');
    assert.deepEqual(fake.calls.at(-1), [
      STREAMS.transportUrl,
      { resource: 'stream', type: 'series', id: 'tt2:1:1' },
    ]);
  });

  it('records failing and invalid stream responses per addon and retries one addon', async () => {
    fake.on(STREAMS, 'stream', () => Promise.resolve({ streams: 'nope' }));
    const store = createTitleStore(fake.backend);
    await store.getState().loadStreams(ADDONS, 'movie', 'tt1');

    const entry = (target: InstalledAddon) =>
      store.getState().streams[streamsKey(target.transportUrl, 'movie', 'tt1')];
    assert.equal(entry(STREAMS)?.status, 'error');
    assert.deepEqual(entry(MOVIES), { status: 'error', message: 'Unreachable' });

    fake.on(MOVIES, 'stream', () => Promise.resolve({ streams: [] }));
    await store.getState().loadAddonStreams(MOVIES, 'movie', 'tt1', { force: true });
    assert.deepEqual(entry(MOVIES), { status: 'ready', streams: [] });
    assert.equal(entry(STREAMS)?.status, 'error');
  });
});

describe('classifyStream', () => {
  it('only plays https URLs', () => {
    assert.deepEqual(classifyStream({ url: 'https://cdn.example/a.mp4' }), {
      kind: 'playable',
      url: 'https://cdn.example/a.mp4',
    });
    for (const stream of [
      { url: 'http://cdn.example/a.mp4' },
      { infoHash: 'a'.repeat(40) },
      { ytId: 'dQw4w9WgXcQ' },
      { externalUrl: 'https://example.com/watch' },
    ]) {
      assert.equal(classifyStream(stream).kind, 'unavailable');
    }
  });
});

describe('groupSeasons', () => {
  it('groups and sorts episodes, with specials last and unplaceable videos dropped', () => {
    const seasons = groupSeasons([
      { id: 's2e1', season: 2, episode: 1 },
      { id: 's1e2', season: 1, episode: 2 },
      { id: 'special', season: 0, episode: 1 },
      { id: 's1e1', season: 1, episode: 1 },
      { id: 'loose' },
    ]);
    assert.deepEqual(
      seasons.map((season) => [season.number, season.episodes.map((video) => video.id)]),
      [
        [1, ['s1e1', 's1e2']],
        [2, ['s2e1']],
        [0, ['special']],
      ],
    );
  });
});

describe('nextEpisode', () => {
  const seasons = groupSeasons([
    { id: 's0e1', season: 0, episode: 1 },
    { id: 's1e1', season: 1, episode: 1 },
    { id: 's1e2', season: 1, episode: 2 },
    { id: 's2e1', season: 2, episode: 1 },
  ]);
  const watched = (id: string, completed: boolean) => ({ video: { id }, completed });
  const pick = (progress: ReturnType<typeof watched>[]) => {
    const next = nextEpisode(seasons, progress);
    return next && `${next.video.id}${next.resume ? ' (resume)' : ''}`;
  };

  it('starts at the first regular episode', () => {
    assert.equal(pick([]), 's1e1');
  });

  it('resumes the latest unfinished episode, or moves on from a finished one', () => {
    assert.equal(pick([watched('s1e2', false), watched('s1e1', true)]), 's1e2 (resume)');
    assert.equal(pick([watched('s1e2', true)]), 's2e1', 'crosses into the next season');
    assert.equal(pick([watched('s2e1', true)]), 's1e1', 'after the last, starts again');
    assert.equal(pick([watched('gone', false)]), 's1e1', 'unknown videos are ignored');
  });

  it('falls back to specials and handles a series without episodes', () => {
    assert.equal(
      nextEpisode(groupSeasons([{ id: 'x', season: 0, episode: 1 }]), [])?.video.id,
      'x',
    );
    assert.equal(nextEpisode([], []), undefined);
  });
});

describe('episodeAfter', () => {
  const seasons = groupSeasons([
    { id: 's0e1', season: 0, episode: 1 },
    { id: 's1e1', season: 1, episode: 1 },
    { id: 's1e2', season: 1, episode: 2 },
    { id: 's2e1', season: 2, episode: 1 },
  ]);

  it('is the next episode in viewing order, across seasons', () => {
    assert.equal(episodeAfter(seasons, 's1e1')?.id, 's1e2');
    assert.equal(episodeAfter(seasons, 's1e2')?.id, 's2e1');
  });

  it('is nothing after the last episode, for specials or for unknown videos', () => {
    assert.equal(episodeAfter(seasons, 's2e1'), undefined);
    assert.equal(episodeAfter(seasons, 's0e1'), undefined);
    assert.equal(episodeAfter(seasons, 'gone'), undefined);
  });

  it('steps through specials when the series has nothing else', () => {
    const specials = groupSeasons([
      { id: 'x1', season: 0, episode: 1 },
      { id: 'x2', season: 0, episode: 2 },
    ]);
    assert.equal(episodeAfter(specials, 'x1')?.id, 'x2');
  });
});

describe('releaseYear', () => {
  it('extracts a year or year range', () => {
    assert.equal(releaseYear('1999'), '1999');
    assert.equal(releaseYear('2011–2019'), '2011–2019');
    assert.equal(releaseYear('2011– '), '2011–');
    assert.equal(releaseYear('2010-07-16T00:00:00.000Z'), '2010');
    assert.equal(releaseYear('soon'), undefined);
    assert.equal(releaseYear(undefined), undefined);
  });
});
