import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { parseManifest, type ResourceRequest } from '@kiro/addon-sdk';

import type { InstalledAddon } from '@/features/addons/addons-store';
import {
  groupByType,
  normalizeQuery,
  searchKey,
  searchPath,
  searchTargets,
  typeLabel,
} from '@/features/search/search-data';
import { createSearchStore, type SearchBackend } from '@/features/search/search-store';

function addon(name: string, catalogs: unknown[]): InstalledAddon {
  const manifest = parseManifest({
    id: `org.${name.toLowerCase()}`,
    version: '1.0.0',
    name,
    types: ['movie', 'series'],
    resources: ['catalog', 'meta'],
    catalogs,
  });
  assert.ok(manifest.ok);
  return {
    transportUrl: `https://${name.toLowerCase()}.example/manifest.json`,
    manifest: manifest.value,
  };
}

const searchExtra = [{ name: 'search' }, { name: 'genre' }, { name: 'skip' }];
const cinemeta = addon('Cinemeta', [
  { type: 'movie', id: 'top', name: 'Popular', extra: searchExtra },
  { type: 'series', id: 'top', name: 'Popular', extra: searchExtra },
  { type: 'movie', id: 'year', extra: [{ name: 'genre', isRequired: true }] },
]);
const anime = addon('Anime', [
  { type: 'series', id: 'search', extra: [{ name: 'search', isRequired: true }] },
]);
const discoverOnly = addon('Trending', [{ type: 'movie', id: 'trending' }]);

interface PendingRequest {
  url: string;
  request: ResourceRequest;
  signal: AbortSignal | undefined;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

/**
 * Stand-in for the Rust commands. Requests stay pending until the test
 * settles them, so ordering and cancellation can be exercised; like the real
 * bridge, an aborted request rejects with the signal's reason.
 */
function fakeBackend() {
  const requests: PendingRequest[] = [];
  const backend: SearchBackend = {
    fetchResource: (url, request, { signal } = {}) =>
      new Promise((resolve, reject) => {
        requests.push({ url, request, signal, resolve, reject });
        signal?.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
      }),
  };
  /** The pending request for an addon's catalogue of `type`. */
  const find = (target: InstalledAddon, type: string, query?: string) => {
    const found = requests.findLast(
      (pending) =>
        pending.url === target.transportUrl &&
        pending.request.type === type &&
        (query === undefined || pending.request.extra?.search === query),
    );
    assert.ok(found, `no request to ${target.manifest.name} for ${type}`);
    return found;
  };
  return { backend, requests, find };
}

const meta = (id: string, type = 'movie') => ({ id, type, name: `Title ${id}` });
/** Lets awaited fake responses propagate into the store. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('search data', () => {
  it('finds the searchable catalogues of every addon, in install order', () => {
    assert.deepEqual(
      searchTargets([cinemeta, discoverOnly, anime]).map(
        ({ addon: owner, catalog }) => `${owner.manifest.name} ${catalog.type}/${catalog.id}`,
      ),
      ['Cinemeta movie/top', 'Cinemeta series/top', 'Anime series/search'],
    );
  });

  it('groups targets by type in order of first appearance', () => {
    const groups = groupByType(searchTargets([anime, cinemeta]));
    assert.deepEqual(
      groups.map(({ type, targets }) => [type, targets.map((t) => t.addon.manifest.name)]),
      [
        ['series', ['Anime', 'Cinemeta']],
        ['movie', ['Cinemeta']],
      ],
    );
    assert.deepEqual(['movie', 'series', 'anime'].map(typeLabel), ['Movies', 'TV Shows', 'Anime']);
  });

  it('normalises queries and builds search paths', () => {
    assert.equal(normalizeQuery('  the   dark\tknight '), 'the dark knight');
    assert.equal(normalizeQuery('x'.repeat(500)).length, 200);
    assert.equal(searchPath(' alien & co '), '/search?q=alien+%26+co');
    assert.equal(searchPath('   '), '/search');
  });
});

describe('search store', () => {
  let fake: ReturnType<typeof fakeBackend>;
  beforeEach(() => {
    fake = fakeBackend();
  });

  it('searches every searchable catalogue with a search extra and validates results', async () => {
    const store = createSearchStore(fake.backend);
    const targets = searchTargets([cinemeta, discoverOnly]);
    const done = store.getState().search(targets, '  alien ');

    assert.equal(store.getState().query, 'alien');
    assert.deepEqual(
      fake.requests.map(({ request }) => request),
      [
        { resource: 'catalog', type: 'movie', id: 'top', extra: { search: 'alien' } },
        { resource: 'catalog', type: 'series', id: 'top', extra: { search: 'alien' } },
      ],
    );
    assert.ok(
      fake.requests.every(({ signal }) => signal),
      'requests are cancellable',
    );
    for (const target of targets) {
      assert.deepEqual(store.getState().entries[searchKey(target)], { status: 'loading' });
    }

    fake.find(cinemeta, 'movie').resolve({ metas: [meta('tt1'), meta('tt1'), { id: '' }] });
    fake.find(cinemeta, 'series').resolve({ metas: [meta('tt2', 'series')] });
    await done;

    const [movies, series] = targets.map((target) => store.getState().entries[searchKey(target)]);
    assert.deepEqual(
      movies,
      { status: 'ready', items: [meta('tt1')] },
      'invalid and repeated items are dropped',
    );
    assert.deepEqual(series, { status: 'ready', items: [meta('tt2', 'series')] });
  });

  it('keeps results from addons that succeed when another fails', async () => {
    const store = createSearchStore(fake.backend);
    const targets = searchTargets([cinemeta, anime]);
    const done = store.getState().search(targets, 'naruto');

    fake.find(cinemeta, 'movie').resolve({ metas: [] });
    fake.find(cinemeta, 'series').resolve({ metas: [meta('tt3', 'series')] });
    // Tauri rejects with the command's serialised `{ code, message }` error.
    fake
      .find(anime, 'series')
      .reject({ code: 'ADDON_ERROR', message: 'The addon did not respond in time' });
    await done;

    const entries = targets.map((target) => store.getState().entries[searchKey(target)]);
    assert.deepEqual(entries, [
      { status: 'ready', items: [] },
      { status: 'ready', items: [meta('tt3', 'series')] },
      { status: 'error', message: 'The addon did not respond in time' },
    ]);
  });

  it('reports invalid responses as errors', async () => {
    const store = createSearchStore(fake.backend);
    const [target] = searchTargets([anime]);
    assert.ok(target);
    const done = store.getState().search([target], 'x');
    fake.find(anime, 'series').resolve({ metas: 'not a list' });
    await done;
    assert.deepEqual(store.getState().entries[searchKey(target)], {
      status: 'error',
      message: 'The addon returned invalid results.',
    });
  });

  it('cancels the previous search when the query changes and ignores its results', async () => {
    const store = createSearchStore(fake.backend);
    const [target] = searchTargets([anime]);
    assert.ok(target);

    void store.getState().search([target], 'ali');
    const stale = fake.find(anime, 'series', 'ali');
    const done = store.getState().search([target], 'alien');

    assert.equal(stale.signal?.aborted, true, 'the stale request is aborted');
    stale.resolve({ metas: [meta('stale', 'series')] });
    await settle();
    assert.deepEqual(store.getState().entries[searchKey(target)], { status: 'loading' });

    fake.find(anime, 'series', 'alien').resolve({ metas: [meta('fresh', 'series')] });
    await done;
    assert.equal(store.getState().query, 'alien');
    assert.deepEqual(store.getState().entries[searchKey(target)], {
      status: 'ready',
      items: [meta('fresh', 'series')],
    });
  });

  it('does not repeat the current search unless forced or the targets change', async () => {
    const store = createSearchStore(fake.backend);
    const targets = searchTargets([anime]);
    void store.getState().search(targets, 'alien');
    void store.getState().search(targets, ' alien ');
    assert.equal(fake.requests.length, 1);

    void store.getState().search(targets, 'alien', { force: true });
    assert.equal(fake.requests.length, 2);
    assert.equal(fake.requests[0]?.signal?.aborted, true);

    void store.getState().search(searchTargets([anime, cinemeta]), 'alien');
    assert.equal(fake.requests.length, 5, 'a newly installed addon is searched too');
    await settle();
  });

  it('clears results for an empty query or when no addon can search', async () => {
    const store = createSearchStore(fake.backend);
    const targets = searchTargets([anime]);
    void store.getState().search(targets, 'alien');
    await store.getState().search(targets, '   ');
    assert.equal(fake.requests[0]?.signal?.aborted, true);
    assert.deepEqual([store.getState().query, store.getState().entries], ['', {}]);

    await store.getState().search([], 'alien');
    assert.equal(fake.requests.length, 1, 'nothing to request');
    assert.deepEqual([store.getState().query, store.getState().entries], ['alien', {}]);
  });

  it('retries one failed catalogue of the current search', async () => {
    const store = createSearchStore(fake.backend);
    const targets = searchTargets([cinemeta]);
    const [movies, series] = targets;
    assert.ok(movies && series);
    const done = store.getState().search(targets, 'alien');
    fake
      .find(cinemeta, 'movie')
      .reject({ code: 'ADDON_ERROR', message: 'The addon could not be reached' });
    fake.find(cinemeta, 'series').resolve({ metas: [meta('tt2', 'series')] });
    await done;

    const retried = store.getState().retry(movies);
    assert.deepEqual(store.getState().entries[searchKey(movies)], { status: 'loading' });
    assert.equal(fake.requests.length, 3, 'only the failed catalogue is requested again');
    fake.find(cinemeta, 'movie').resolve({ metas: [meta('tt1')] });
    await retried;

    assert.deepEqual(store.getState().entries[searchKey(movies)], {
      status: 'ready',
      items: [meta('tt1')],
    });
    assert.deepEqual(store.getState().entries[searchKey(series)], {
      status: 'ready',
      items: [meta('tt2', 'series')],
    });
  });

  it('cancels an unfinished search on leaving but keeps a finished one', async () => {
    const store = createSearchStore(fake.backend);
    const targets = searchTargets([anime]);

    void store.getState().search(targets, 'alien');
    store.getState().cancel();
    assert.equal(fake.requests[0]?.signal?.aborted, true);
    assert.deepEqual(store.getState().entries, {});

    const done = store.getState().search(targets, 'alien');
    assert.equal(fake.requests.length, 2, 'returning searches again');
    fake.find(anime, 'series').resolve({ metas: [meta('tt1', 'series')] });
    await done;

    store.getState().cancel();
    assert.equal(store.getState().query, 'alien');
    await store.getState().search(targets, 'alien');
    assert.equal(fake.requests.length, 2, 'a finished search is reused');
  });
});
