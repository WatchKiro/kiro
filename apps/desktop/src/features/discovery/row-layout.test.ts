import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseManifest } from '@kiro/addon-sdk';

import type { InstalledAddon } from '@/features/addons/addons-store';
import { browseSources, discoverSources } from '@/features/discovery/browse-data';
import {
  capLayout,
  entryOf,
  moveRow,
  newRowAddons,
  resolveLayout,
  rowKey,
  setHidden,
  type LaidOutRow,
} from '@/features/discovery/row-layout';
import { createSettingsStore } from '@/features/settings/settings-store';
import { DEFAULT_SETTINGS, MAX_LAYOUT_ROWS } from '@/features/settings/settings-data';
import type { CatalogRowSetting, Settings } from '@/services/native';

function addon(
  id: string,
  name: string,
  catalogs: unknown[],
  types = ['movie', 'series'],
): InstalledAddon {
  const manifest = parseManifest({
    id,
    version: '1.0.0',
    name,
    types,
    resources: ['catalog', 'meta'],
    catalogs,
  });
  assert.ok(manifest.ok);
  return { transportUrl: `https://${id}.example/manifest.json`, manifest: manifest.value };
}

const genres = { name: 'genre', options: ['Action', 'Drama'] };
/** Shaped like Cinemeta: a search-only catalogue and one needing ids it can't be given. */
const cinemeta = addon('com.linvo.cinemeta', 'Cinemeta', [
  { type: 'movie', id: 'top', name: 'Popular', extra: [genres, { name: 'search' }] },
  { type: 'series', id: 'top', name: 'Popular', extra: [genres, { name: 'skip' }] },
  {
    type: 'movie',
    id: 'year',
    name: 'New',
    extra: [{ name: 'genre', isRequired: true, options: ['2026', '2025'] }],
  },
  { type: 'movie', id: 'search', extra: [{ name: 'search', isRequired: true }] },
  { type: 'series', id: 'last-videos', extra: [{ name: 'lastVideosIds', isRequired: true }] },
]);
/** Shaped like Anime Kitsu: catalogues of its own `anime` type. */
const kitsu = addon(
  'community.anime.kitsu',
  'Anime Kitsu',
  [
    { type: 'anime', id: 'kitsu-anime-trending', name: 'Kitsu Trending' },
    { type: 'anime', id: 'kitsu-anime-airing', name: 'Kitsu Top Airing', extra: [genres] },
    { type: 'anime', id: 'kitsu-search', extra: [{ name: 'search', isRequired: true }] },
    // Requires a genre but lists none to pick from.
    { type: 'anime', id: 'kitsu-by-genre', extra: [{ name: 'genre', isRequired: true }] },
  ],
  ['anime'],
);
const channels = addon(
  'dev.channels',
  'Channels',
  [{ type: 'tv', id: 'live', name: 'Live' }],
  ['tv'],
);

const names = (rows: LaidOutRow[]) =>
  rows.map(
    ({ source, hidden, isNew }) =>
      `${source.addon.manifest.name} ${source.catalog.type}/${source.catalog.id}` +
      (hidden ? ' (hidden)' : '') +
      (isNew ? ' (new)' : ''),
  );

const entry = (addonId: string, type: string, catalog: string, hidden = false) => ({
  addon: addonId,
  type,
  catalog,
  hidden,
});
const key = (addonId: string, type: string, catalog: string) =>
  rowKey({ addon: addonId, type, catalog });

/** The keys of the rows a page shows, in order. */
const shownKeys = (entries: CatalogRowSetting[], addons: InstalledAddon[]) =>
  resolveLayout(discoverSources(addons), entries)
    .rows.filter((row) => !row.hidden)
    .map((row) => row.key);

describe('catalogue rows', () => {
  it('lists every browsable catalogue of every addon, skipping ones needing input', () => {
    const layout = resolveLayout(discoverSources([cinemeta, kitsu, channels]), null);
    assert.deepEqual(names(layout.rows), [
      'Cinemeta movie/top',
      'Cinemeta series/top',
      'Cinemeta movie/year',
      'Anime Kitsu anime/kitsu-anime-trending',
      'Anime Kitsu anime/kitsu-anime-airing',
      'Channels tv/live',
    ]);
    assert.equal(layout.customised, false);
    assert.deepEqual(layout.entries, [
      entry('com.linvo.cinemeta', 'movie', 'top'),
      entry('com.linvo.cinemeta', 'series', 'top'),
      entry('com.linvo.cinemeta', 'movie', 'year'),
      entry('community.anime.kitsu', 'anime', 'kitsu-anime-trending'),
      entry('community.anime.kitsu', 'anime', 'kitsu-anime-airing'),
      entry('dev.channels', 'tv', 'live'),
    ]);
    assert.deepEqual(newRowAddons(layout.rows), []);
  });

  it('keys rows by addon id, type and catalogue id', () => {
    const [movies, series] = discoverSources([cinemeta]);
    assert.ok(movies && series);
    assert.deepEqual(entryOf(movies), entry('com.linvo.cinemeta', 'movie', 'top'));
    assert.notEqual(rowKey(entryOf(movies)), rowKey(entryOf(series)));
    // The transport URL (which changes with an addon's configuration) is not part of it.
    const moved = { ...cinemeta, transportUrl: 'https://elsewhere.example/manifest.json' };
    assert.equal(rowKey(entryOf({ ...movies, addon: moved })), rowKey(entryOf(movies)));
  });

  it('applies a saved order and hidden rows', () => {
    const saved = [
      entry('community.anime.kitsu', 'anime', 'kitsu-anime-airing'),
      entry('com.linvo.cinemeta', 'movie', 'top', true),
      entry('com.linvo.cinemeta', 'series', 'top'),
      entry('com.linvo.cinemeta', 'movie', 'year'),
      entry('community.anime.kitsu', 'anime', 'kitsu-anime-trending', true),
    ];
    const layout = resolveLayout(discoverSources([cinemeta, kitsu]), saved);
    assert.deepEqual(names(layout.rows), [
      'Anime Kitsu anime/kitsu-anime-airing',
      'Cinemeta movie/top (hidden)',
      'Cinemeta series/top',
      'Cinemeta movie/year',
      'Anime Kitsu anime/kitsu-anime-trending (hidden)',
    ]);
    assert.equal(layout.customised, true);
    assert.deepEqual(layout.entries, saved);
  });

  it('adds a new addon’s rows at the end, shown and marked new', () => {
    const saved = [
      entry('com.linvo.cinemeta', 'movie', 'year'),
      entry('com.linvo.cinemeta', 'movie', 'top', true),
      entry('com.linvo.cinemeta', 'series', 'top'),
    ];
    const layout = resolveLayout(discoverSources([kitsu, cinemeta]), saved);
    assert.deepEqual(names(layout.rows), [
      'Cinemeta movie/year',
      'Cinemeta movie/top (hidden)',
      'Cinemeta series/top',
      'Anime Kitsu anime/kitsu-anime-trending (new)',
      'Anime Kitsu anime/kitsu-anime-airing (new)',
    ]);
    assert.deepEqual(newRowAddons(layout.rows), ['Anime Kitsu']);
    // Saving the resolved layout makes them part of it.
    const saved2 = resolveLayout(discoverSources([kitsu, cinemeta]), layout.entries);
    assert.deepEqual(newRowAddons(saved2.rows), []);
  });

  it('puts a catalogue an update adds after its addon’s other rows', () => {
    const saved = [
      entry('community.anime.kitsu', 'anime', 'kitsu-anime-trending'),
      entry('com.linvo.cinemeta', 'movie', 'top'),
      entry('com.linvo.cinemeta', 'series', 'top'),
      entry('com.linvo.cinemeta', 'movie', 'year'),
    ];
    const layout = resolveLayout(discoverSources([cinemeta, kitsu]), saved);
    assert.deepEqual(names(layout.rows), [
      'Anime Kitsu anime/kitsu-anime-trending',
      'Anime Kitsu anime/kitsu-anime-airing (new)',
      'Cinemeta movie/top',
      'Cinemeta series/top',
      'Cinemeta movie/year',
    ]);
  });

  it('drops the rows of a removed addon but remembers their places', () => {
    const saved = [
      entry('community.anime.kitsu', 'anime', 'kitsu-anime-airing'),
      entry('com.linvo.cinemeta', 'movie', 'top'),
      entry('community.anime.kitsu', 'anime', 'kitsu-anime-trending', true),
      entry('com.linvo.cinemeta', 'series', 'top'),
      entry('com.linvo.cinemeta', 'movie', 'year'),
    ];
    const without = resolveLayout(discoverSources([cinemeta]), saved);
    assert.deepEqual(names(without.rows), [
      'Cinemeta movie/top',
      'Cinemeta series/top',
      'Cinemeta movie/year',
    ]);
    // Moving a row while Kitsu is away keeps Kitsu's rows where they were.
    const moved = moveRow(
      without.entries,
      shownKeys(without.entries, [cinemeta]),
      key('com.linvo.cinemeta', 'movie', 'year'),
      0,
    );
    assert.deepEqual(moved, [
      entry('community.anime.kitsu', 'anime', 'kitsu-anime-airing'),
      entry('com.linvo.cinemeta', 'movie', 'year'),
      entry('com.linvo.cinemeta', 'movie', 'top'),
      entry('community.anime.kitsu', 'anime', 'kitsu-anime-trending', true),
      entry('com.linvo.cinemeta', 'series', 'top'),
    ]);

    const back = resolveLayout(discoverSources([cinemeta, kitsu]), moved);
    assert.deepEqual(names(back.rows), [
      'Anime Kitsu anime/kitsu-anime-airing',
      'Cinemeta movie/year',
      'Cinemeta movie/top',
      'Anime Kitsu anime/kitsu-anime-trending (hidden)',
      'Cinemeta series/top',
    ]);
    assert.deepEqual(newRowAddons(back.rows), [], 'a returning addon is not new');
  });

  it('ignores unknown and repeated rows', () => {
    const layout = resolveLayout(discoverSources([cinemeta]), [
      entry('com.linvo.cinemeta', 'series', 'top', true),
      entry('com.linvo.cinemeta', 'series', 'top'),
      entry('org.gone', 'movie', 'top'),
      entry('com.linvo.cinemeta', 'movie', 'search'),
      entry('com.linvo.cinemeta', 'movie', 'top'),
      entry('com.linvo.cinemeta', 'movie', 'year'),
    ]);
    assert.deepEqual(names(layout.rows), [
      'Cinemeta series/top (hidden)',
      'Cinemeta movie/top',
      'Cinemeta movie/year',
    ]);
  });

  it('filters by page type, as Movies and TV Shows do', () => {
    const saved = [
      entry('com.linvo.cinemeta', 'movie', 'year'),
      entry('com.linvo.cinemeta', 'series', 'top'),
    ];
    const layout = resolveLayout(browseSources([cinemeta, kitsu], 'movie'), saved);
    assert.deepEqual(names(layout.rows), ['Cinemeta movie/year', 'Cinemeta movie/top (new)']);
  });

  it('shows and hides rows', () => {
    const { entries } = resolveLayout(discoverSources([cinemeta]), null);
    const hidden = setHidden(entries, key('com.linvo.cinemeta', 'series', 'top'), true);
    assert.deepEqual(names(resolveLayout(discoverSources([cinemeta]), hidden).rows), [
      'Cinemeta movie/top',
      'Cinemeta series/top (hidden)',
      'Cinemeta movie/year',
    ]);
    const shown = setHidden(hidden, key('com.linvo.cinemeta', 'series', 'top'), false);
    assert.deepEqual(shown, entries);
  });

  it('moves shown rows up, down and to a position, past hidden ones', () => {
    const addons = [cinemeta, kitsu];
    const entries = setHidden(
      resolveLayout(discoverSources(addons), null).entries,
      key('com.linvo.cinemeta', 'movie', 'year'),
      true,
    );
    const shown = shownKeys(entries, addons);
    const airing = key('community.anime.kitsu', 'anime', 'kitsu-anime-airing');
    const series = key('com.linvo.cinemeta', 'series', 'top');
    const movies = key('com.linvo.cinemeta', 'movie', 'top');
    const order = (moved: CatalogRowSetting[]) => moved.map((row) => row.catalog);

    // Up from just below a hidden row lands above the shown row before it.
    const trending = key('community.anime.kitsu', 'anime', 'kitsu-anime-trending');
    assert.deepEqual(order(moveRow(entries, shown, trending, shown.indexOf(trending) - 1)), [
      'top',
      'kitsu-anime-trending',
      'top',
      'year',
      'kitsu-anime-airing',
    ]);
    // Down past the hidden row.
    assert.deepEqual(order(moveRow(entries, shown, series, shown.indexOf(series) + 1)), [
      'top',
      'year',
      'kitsu-anime-trending',
      'top',
      'kitsu-anime-airing',
    ]);
    // To the end and to the start, as a drag would.
    assert.deepEqual(order(moveRow(entries, shown, movies, shown.length - 1)), [
      'top',
      'year',
      'kitsu-anime-trending',
      'kitsu-anime-airing',
      'top',
    ]);
    assert.deepEqual(order(moveRow(entries, shown, airing, 0)), [
      'kitsu-anime-airing',
      'top',
      'top',
      'year',
      'kitsu-anime-trending',
    ]);
    // Nowhere to go: unchanged.
    assert.equal(moveRow(entries, shown, movies, 0), entries);
    assert.equal(moveRow(entries, [movies], movies, 1), entries);
  });

  it('caps a layout by forgetting remembered rows first', () => {
    const available = new Set([key('a.b', 'movie', '0')]);
    const entries = Array.from({ length: MAX_LAYOUT_ROWS + 2 }, (_, index) =>
      entry('a.b', 'movie', String(index)),
    );
    const capped = capLayout(entries, available);
    assert.equal(capped.length, MAX_LAYOUT_ROWS);
    assert.equal(capped[0]?.catalog, '0');
    assert.equal(capped.at(-1)?.catalog, String(MAX_LAYOUT_ROWS - 1));
    const small = entries.slice(0, 3);
    assert.equal(capLayout(small, available), small);
  });

  it('saves a layout and resets it to the default', async () => {
    let stored: Settings = DEFAULT_SETTINGS;
    const store = createSettingsStore({
      get: () => Promise.resolve(stored),
      set: (settings) => {
        stored = settings;
        return Promise.resolve(settings);
      },
    });
    await store.getState().load();
    const sources = discoverSources([cinemeta, kitsu]);
    const { entries } = resolveLayout(sources, null);
    const shown = entries.map(rowKey);
    const custom = moveRow(entries, shown, shown.at(-1) as string, 0);

    await store.getState().updateRows('discover', custom);
    assert.deepEqual(stored.rows.discover, custom);
    assert.equal(stored.rows.movies, null);
    assert.equal(resolveLayout(sources, stored.rows.discover).rows[0]?.key, shown.at(-1));

    await store.getState().updateRows('discover', null);
    assert.deepEqual(stored.rows, DEFAULT_SETTINGS.rows);
    const reset = resolveLayout(sources, stored.rows.discover);
    assert.equal(reset.customised, false);
    assert.deepEqual(
      reset.rows.map((row) => row.key),
      shown,
    );
  });
});
