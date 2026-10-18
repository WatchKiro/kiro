import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { parseManifest, type ResourceRequest } from '@kiro/addon-sdk';

import type { InstalledAddon } from '@/features/addons/addons-store';
import {
  appendPage,
  browsePath,
  browseSources,
  catalogExtra,
  discoverSources,
  effectiveGenre,
  feedKey,
  filterLabel,
  findSource,
  genreFilter,
  MAX_FEED_ITEMS,
  otherTypes,
  rowTitle,
  sectionFor,
  sourceLabel,
  sourceParam,
  type BrowseSource,
} from '@/features/discovery/browse-data';
import { createBrowseStore, type BrowseBackend } from '@/features/discovery/browse-store';

function addon(name: string, catalogs: unknown[], types = ['movie', 'series']): InstalledAddon {
  const manifest = parseManifest({
    id: `org.${name.toLowerCase()}`,
    version: '1.0.0',
    name,
    types,
    resources: ['catalog', 'meta'],
    catalogs,
  });
  assert.ok(manifest.ok);
  return {
    transportUrl: `https://${name.toLowerCase()}.example/manifest.json`,
    manifest: manifest.value,
  };
}

const genres = { name: 'genre', options: ['Action', 'Drama', 'Sci-Fi'] };
/** Shaped like Cinemeta's catalogues. */
const cinemeta = addon('Cinemeta', [
  {
    type: 'movie',
    id: 'top',
    name: 'Popular',
    extra: [genres, { name: 'search' }, { name: 'skip' }],
  },
  { type: 'series', id: 'top', name: 'Popular', extra: [genres, { name: 'skip' }] },
  {
    type: 'movie',
    id: 'year',
    name: 'New',
    extra: [{ name: 'genre', isRequired: true, options: ['2026', '2025'] }, { name: 'skip' }],
  },
  { type: 'movie', id: 'imdbRating', name: 'Featured', extra: [genres, { name: 'skip' }] },
  { type: 'series', id: 'last-videos', extra: [{ name: 'lastVideosIds', isRequired: true }] },
]);
const anime = addon('Anime', [
  { type: 'movie', id: 'popular', name: 'Popular' },
  { type: 'movie', id: 'search', extra: [{ name: 'search', isRequired: true }] },
  // Requires a genre but lists no options, so it cannot be browsed.
  { type: 'movie', id: 'by-genre', extra: [{ name: 'genre', isRequired: true }] },
]);
/** Declares a movie catalogue its `catalog` resource does not cover. */
const seriesOnly = addon('Shows', [{ type: 'movie', id: 'top' }], ['series']);

function source(owner: InstalledAddon, type: string, id: string): BrowseSource {
  const catalog = owner.manifest.catalogs.find((c) => c.type === type && c.id === id);
  assert.ok(catalog, `${owner.manifest.name} has no ${type}/${id}`);
  return { addon: owner, catalog };
}

const meta = (id: string, type = 'movie') => ({ id, type, name: `Title ${id}` });
const metas = (from: number, count: number) =>
  Array.from({ length: count }, (_, index) => meta(`tt${from + index}`));

describe('browse data', () => {
  it('finds browsable catalogues of a type, in install then manifest order', () => {
    const names = (sources: BrowseSource[]) =>
      sources.map(({ addon: owner, catalog }) => `${owner.manifest.name} ${catalog.id}`);
    assert.deepEqual(names(browseSources([cinemeta, anime, seriesOnly], 'movie')), [
      'Cinemeta top',
      'Cinemeta year',
      'Cinemeta imdbRating',
      'Anime popular',
    ]);
    assert.deepEqual(names(browseSources([cinemeta, anime], 'series')), ['Cinemeta top']);
    assert.deepEqual(browseSources([anime], 'series'), []);
    assert.deepEqual(names(discoverSources([cinemeta, seriesOnly])), [
      'Cinemeta top',
      'Cinemeta top',
      'Cinemeta year',
      'Cinemeta imdbRating',
    ]);
  });

  it('reads genre filters and picks the genre to request', () => {
    const popular = source(cinemeta, 'movie', 'top').catalog;
    const year = source(cinemeta, 'movie', 'year').catalog;
    assert.deepEqual(genreFilter(popular), {
      options: ['Action', 'Drama', 'Sci-Fi'],
      required: false,
    });
    assert.deepEqual(genreFilter(year), { options: ['2026', '2025'], required: true });
    assert.equal(genreFilter(source(anime, 'movie', 'popular').catalog), null);

    assert.equal(filterLabel({ options: ['Action', '2026'], required: false }), 'Genre');
    assert.equal(filterLabel({ options: ['2026', '2025'], required: true }), 'Year');

    assert.equal(effectiveGenre(popular), undefined);
    assert.equal(effectiveGenre(popular, 'Drama'), 'Drama');
    assert.equal(effectiveGenre(popular, 'Western'), undefined, 'unknown genres are ignored');
    assert.equal(effectiveGenre(year), '2026', 'a required genre defaults to the first option');
    assert.equal(effectiveGenre(year, '2025'), '2025');
    assert.equal(effectiveGenre(source(anime, 'movie', 'popular').catalog, 'Drama'), undefined);
  });

  it('builds page extras', () => {
    assert.equal(catalogExtra(undefined, 0), undefined);
    assert.deepEqual(catalogExtra('Drama', 0), { genre: 'Drama' });
    assert.deepEqual(catalogExtra(undefined, 48), { skip: '48' });
    assert.deepEqual(catalogExtra('Drama', 96), { genre: 'Drama', skip: '96' });
  });

  it('names sources for the URL and the page', () => {
    const sources = browseSources([cinemeta, anime], 'movie');
    const [popular, , featured, animePopular] = sources;
    assert.ok(popular && featured && animePopular);
    assert.equal(sourceParam(popular), 'org.cinemeta/top');
    assert.equal(findSource(sources, 'org.anime/popular'), animePopular);
    assert.equal(findSource(sources, 'org.gone/top'), undefined);
    assert.equal(findSource(sources, null), undefined);
    // Two catalogues called "Popular" are told apart by addon.
    assert.equal(sourceLabel(popular, sources), 'Popular · Cinemeta');
    assert.equal(sourceLabel(featured, sources), 'Featured');
    assert.notEqual(feedKey(popular, undefined), feedKey(popular, 'Drama'));
    assert.equal(browsePath(popular), '/movies?catalog=org.cinemeta%2Ftop');
    assert.equal(rowTitle(popular), 'Popular movies');
    const shows = browseSources([cinemeta], 'series')[0];
    assert.ok(shows);
    assert.equal(browsePath(shows), '/tv?catalog=org.cinemeta%2Ftop');
    assert.equal(rowTitle(shows), 'Popular TV shows');
    const channels = addon('Channels', [{ type: 'tv', id: 'live', name: 'Live' }], ['tv']);
    const [live] = discoverSources([channels]);
    assert.ok(live);
    // Other types get a browse page of their own, so See all works for them too.
    assert.equal(browsePath(live), '/browse/tv?catalog=org.channels%2Flive');
    assert.equal(rowTitle(live), 'Live');
  });

  it('gives other content types a browse page', () => {
    const kitsu = addon('Kitsu', [{ type: 'anime', id: 'trending', name: 'Trending' }], ['anime']);
    const odd = addon('Odd', [{ type: 'live_events', id: 'now', name: 'Now' }], ['live_events']);
    assert.deepEqual(otherTypes([cinemeta, kitsu, odd, kitsu]), ['anime', 'live_events']);
    assert.deepEqual(otherTypes([cinemeta]), []);
    assert.deepEqual(sectionFor('anime'), {
      type: 'anime',
      title: 'Anime',
      noun: 'anime',
      path: '/browse/anime',
    });
    assert.equal(sectionFor('live_events').title, 'Live Events');
    assert.equal(sectionFor('tv').title, 'Live TV');
    assert.equal(sectionFor('movie').path, '/movies', 'movies and series keep their own pages');
    assert.equal(sectionFor('movie').page, 'movies');
    assert.equal(sectionFor('anime').page, undefined, 'other pages have no saved layout');
  });

  it('appends pages without repeating items', () => {
    const first = [meta('a'), meta('b')];
    assert.deepEqual(
      appendPage(first, [meta('b'), meta('c'), meta('c')]).map((item) => item.id),
      ['a', 'b', 'c'],
    );
    assert.equal(appendPage(first, [meta('a')]), first, 'nothing new keeps the same array');
    // The same id with another type is a different title.
    assert.equal(appendPage(first, [meta('a', 'series')]).length, 3);
  });
});

interface PendingRequest {
  url: string;
  request: ResourceRequest;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

/** Stand-in for the Rust command; requests stay pending until the test settles them. */
function fakeBackend() {
  const requests: PendingRequest[] = [];
  const backend: BrowseBackend = {
    fetchResource: (url, request) =>
      new Promise((resolve, reject) => {
        requests.push({ url, request, resolve, reject });
      }),
  };
  const latest = () => {
    const request = requests.at(-1);
    assert.ok(request, 'no request was made');
    return request;
  };
  return { backend, requests, latest };
}

/** Lets awaited fake responses propagate into the store. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('browse store', () => {
  let fake: ReturnType<typeof fakeBackend>;
  beforeEach(() => {
    fake = fakeBackend();
  });

  const popular = source(cinemeta, 'movie', 'top');
  const year = source(cinemeta, 'movie', 'year');

  it('loads the first page once and validates it', async () => {
    const store = createBrowseStore(fake.backend);
    const done = store.getState().load(popular, undefined);
    void store.getState().load(popular, undefined);
    assert.equal(fake.requests.length, 1, 'a loading feed is not fetched twice');
    assert.equal(store.getState().feeds[feedKey(popular, undefined)]?.status, 'loading');

    const request = fake.latest();
    assert.equal(request.url, cinemeta.transportUrl);
    assert.deepEqual(request.request, {
      resource: 'catalog',
      type: 'movie',
      id: 'top',
      extra: undefined,
    });
    request.resolve({ metas: [...metas(0, 3), { id: 'broken' }] });
    await done;

    const feed = store.getState().feeds[feedKey(popular, undefined)];
    assert.equal(feed?.status, 'ready');
    assert.deepEqual(
      feed.items.map((item) => item.id),
      ['tt0', 'tt1', 'tt2'],
    );
    assert.equal(feed.next, 4, 'invalid items still count towards skip');
    assert.equal(feed.hasMore, true);

    await store.getState().load(popular, undefined);
    assert.equal(fake.requests.length, 1, 'a fetched feed is cached');
  });

  it('pages with skip and genre until a page adds nothing', async () => {
    const store = createBrowseStore(fake.backend);
    const key = feedKey(year, '2026');
    void store.getState().load(year, '2026');
    assert.deepEqual(fake.latest().request.extra, { genre: '2026' });
    fake.latest().resolve({ metas: metas(0, 48) });
    await settle();

    void store.getState().loadMore(year, '2026');
    void store.getState().loadMore(year, '2026');
    assert.equal(fake.requests.length, 2, 'one page at a time');
    assert.deepEqual(fake.latest().request.extra, { genre: '2026', skip: '48' });
    // The next page overlaps the first by two items.
    fake.latest().resolve({ metas: metas(46, 50) });
    await settle();
    assert.equal(store.getState().feeds[key]?.items.length, 96);
    assert.equal(store.getState().feeds[key]?.next, 98);

    void store.getState().loadMore(year, '2026');
    assert.deepEqual(fake.latest().request.extra, { genre: '2026', skip: '98' });
    fake.latest().resolve({ metas: [] });
    await settle();
    const feed = store.getState().feeds[key];
    assert.equal(feed?.hasMore, false);
    assert.equal(feed.status, 'ready');

    await store.getState().loadMore(year, '2026');
    assert.equal(fake.requests.length, 3, 'an exhausted feed stops paging');
  });

  it('keeps feeds for each genre apart', async () => {
    const store = createBrowseStore(fake.backend);
    void store.getState().load(popular, undefined);
    void store.getState().load(popular, 'Drama');
    assert.equal(fake.requests.length, 2);
    fake.requests[1]?.resolve({ metas: metas(100, 2) });
    fake.requests[0]?.resolve({ metas: metas(0, 5) });
    await settle();
    assert.equal(store.getState().feeds[feedKey(popular, undefined)]?.items.length, 5);
    assert.equal(store.getState().feeds[feedKey(popular, 'Drama')]?.items[0]?.id, 'tt100');
  });

  it('keeps loaded items when a later page fails, and retries that page', async () => {
    const store = createBrowseStore(fake.backend);
    const key = feedKey(popular, undefined);
    void store.getState().load(popular, undefined);
    fake.latest().resolve({ metas: metas(0, 10) });
    await settle();

    void store.getState().loadMore(popular, undefined);
    // Tauri rejects with the command's serialised `{ code, message }` error.
    fake.latest().reject({ code: 'ADDON_ERROR', message: 'The addon timed out' });
    await settle();
    let feed = store.getState().feeds[key];
    assert.equal(feed?.status, 'error');
    assert.equal(feed.error, 'The addon timed out');
    assert.equal(feed.items.length, 10);

    await store.getState().loadMore(popular, undefined);
    assert.equal(fake.requests.length, 2, 'a failed feed waits for retry');

    void store.getState().retry(popular, undefined);
    assert.deepEqual(fake.latest().request.extra, { skip: '10' });
    fake.latest().resolve({ metas: metas(10, 10) });
    await settle();
    feed = store.getState().feeds[key];
    assert.equal(feed?.status, 'ready');
    assert.equal(feed.items.length, 20);
    assert.equal(feed.error, null);
  });

  it('reports invalid responses and retries the first page', async () => {
    const store = createBrowseStore(fake.backend);
    const key = feedKey(popular, undefined);
    void store.getState().load(popular, undefined);
    fake.latest().resolve({ items: [] });
    await settle();
    assert.deepEqual(store.getState().feeds[key], {
      items: [],
      next: 0,
      hasMore: true,
      status: 'error',
      error: 'The addon returned an invalid catalogue.',
    });

    await store.getState().load(popular, undefined);
    assert.equal(fake.requests.length, 1, 'load does not retry by itself');
    void store.getState().retry(popular, undefined);
    assert.equal(fake.latest().request.extra, undefined);
  });

  it(`stops at ${MAX_FEED_ITEMS} items`, async () => {
    const store = createBrowseStore(fake.backend);
    const key = feedKey(popular, undefined);
    void store.getState().load(popular, undefined);
    fake.latest().resolve({ metas: metas(0, MAX_FEED_ITEMS - 10) });
    await settle();
    void store.getState().loadMore(popular, undefined);
    fake.latest().resolve({ metas: metas(MAX_FEED_ITEMS, 50) });
    await settle();
    const feed = store.getState().feeds[key];
    assert.equal(feed?.items.length, MAX_FEED_ITEMS);
    assert.equal(feed.hasMore, false);
  });

  it('forgets the feeds of an addon', async () => {
    const store = createBrowseStore(fake.backend);
    const other = source(anime, 'movie', 'popular');
    void store.getState().load(popular, undefined);
    void store.getState().load(popular, 'Drama');
    void store.getState().load(other, undefined);
    for (const request of fake.requests) request.resolve({ metas: metas(0, 2) });
    await settle();

    store.getState().forget([cinemeta.transportUrl]);
    assert.deepEqual(Object.keys(store.getState().feeds), [feedKey(other, undefined)]);
  });
});
