import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildResourcePath,
  parseCatalogResponse,
  parseManifest,
  parseMetaResponse,
  parseStreamResponse,
  parseSubtitlesResponse,
  searchableCatalogs,
  supportsResource,
} from './index';

const manifest = {
  id: 'org.example.catalog',
  version: '1.2.0',
  name: 'Example',
  types: ['movie', 'series'],
  resources: ['catalog', { name: 'stream', types: ['movie'], idPrefixes: ['tt'] }],
  catalogs: [{ type: 'movie', id: 'top', name: 'Top' }],
  futureField: { anything: true },
};

describe('parseManifest', () => {
  it('accepts a valid manifest and strips unknown fields', () => {
    const result = parseManifest(manifest);
    assert.ok(result.ok);
    assert.equal(result.value.id, 'org.example.catalog');
    assert.equal('futureField' in result.value, false);
  });

  it('drops unsafe optional URLs instead of rejecting the manifest', () => {
    const result = parseManifest({ ...manifest, logo: 'javascript:alert(1)' });
    assert.ok(result.ok);
    assert.equal(result.value.logo, undefined);
  });

  it('rejects manifests missing required fields', () => {
    const result = parseManifest({ id: 'x', name: 'No version' });
    assert.equal(result.ok, false);
  });
});

describe('supportsResource', () => {
  const parsed = parseManifest(manifest);
  assert.ok(parsed.ok);

  it('applies resource-level types and id prefixes', () => {
    assert.equal(supportsResource(parsed.value, 'catalog', 'series'), true);
    assert.equal(supportsResource(parsed.value, 'stream', 'movie', 'tt0111161'), true);
    assert.equal(supportsResource(parsed.value, 'stream', 'series', 'tt0111161'), false);
    assert.equal(supportsResource(parsed.value, 'stream', 'movie', 'kitsu:1'), false);
    assert.equal(supportsResource(parsed.value, 'subtitles', 'movie'), false);
  });
});

describe('searchableCatalogs', () => {
  const parse = (catalogs: unknown[], resources: unknown[] = ['catalog']) => {
    const parsed = parseManifest({ ...manifest, resources, catalogs });
    assert.ok(parsed.ok);
    return parsed.value;
  };

  it('lists catalogues that declare a search extra, in manifest order', () => {
    const searchable = searchableCatalogs(
      parse([
        { type: 'movie', id: 'top', extra: [{ name: 'genre' }, { name: 'skip' }] },
        { type: 'movie', id: 'top', extra: [{ name: 'search' }, { name: 'genre' }] },
        { type: 'series', id: 'search', extra: [{ name: 'search', isRequired: true }] },
        { type: 'movie', id: 'plain' },
      ]),
    );
    assert.deepEqual(
      searchable.map((catalog) => `${catalog.type}/${catalog.id}`),
      ['movie/top', 'series/search'],
    );
  });

  it('skips catalogues that require another extra', () => {
    const searchable = searchableCatalogs(
      parse([
        {
          type: 'movie',
          id: 'by-genre',
          extra: [{ name: 'search' }, { name: 'genre', isRequired: true }],
        },
      ]),
    );
    assert.deepEqual(searchable, []);
  });

  it('skips catalogues whose type the catalog resource does not cover', () => {
    const catalogs = [
      { type: 'movie', id: 'search', extra: [{ name: 'search', isRequired: true }] },
      { type: 'series', id: 'search', extra: [{ name: 'search', isRequired: true }] },
    ];
    const searchable = searchableCatalogs(
      parse(catalogs, [{ name: 'catalog', types: ['series'] }]),
    );
    assert.deepEqual(
      searchable.map((catalog) => catalog.type),
      ['series'],
    );
    assert.deepEqual(searchableCatalogs(parse(catalogs, ['meta'])), []);
  });
});

describe('list responses', () => {
  it('skips invalid catalog items and reports them', () => {
    const result = parseCatalogResponse({
      metas: [{ id: 'tt1', type: 'movie', name: 'Valid' }, { id: '', type: 'movie' }, 'garbage'],
    });
    assert.ok(result.ok);
    assert.equal(result.value.metas.length, 1);
    assert.equal(result.dropped, 2);
  });

  it('keeps catalogue artwork with safe URLs only', () => {
    const result = parseCatalogResponse({
      metas: [
        {
          id: 'tt1',
          type: 'movie',
          name: 'Artwork',
          background: 'https://img.example/bg.jpg',
          logo: 'javascript:alert(1)',
          runtime: '120 min',
        },
      ],
    });
    assert.ok(result.ok);
    const [item] = result.value.metas;
    assert.equal(item?.background, 'https://img.example/bg.jpg');
    assert.equal(item.logo, undefined);
    assert.equal(item.runtime, '120 min');
  });

  it('rejects streams without a playable source', () => {
    const result = parseStreamResponse({
      streams: [
        { name: 'No source' },
        { url: 'file:///etc/passwd' },
        { url: 'https://cdn.example/v.mkv' },
      ],
    });
    assert.ok(result.ok);
    assert.deepEqual(
      result.value.streams.map((s) => s.url),
      ['https://cdn.example/v.mkv'],
    );
  });

  it('keeps the legacy stream title and episode name fields', () => {
    const streams = parseStreamResponse({
      streams: [{ url: 'https://cdn.example/v.mp4', title: '1080p\nWEB' }],
    });
    assert.ok(streams.ok);
    assert.equal(streams.value.streams[0]?.title, '1080p\nWEB');

    const meta = parseMetaResponse({
      meta: {
        id: 'tt1',
        type: 'series',
        name: 'Show',
        videos: [{ id: 'tt1:1:1', name: 'Pilot', season: 1, episode: 1 }],
      },
    });
    assert.ok(meta.ok);
    assert.equal(meta.value.meta.videos?.[0]?.name, 'Pilot');
  });

  it('rejects oversized responses outright', () => {
    const result = parseStreamResponse({ streams: Array.from({ length: 501 }, () => ({})) });
    assert.equal(result.ok, false);
  });
});

describe('parseSubtitlesResponse', () => {
  const subtitle = (n: number, lang = 'eng') => ({
    id: String(n),
    url: `https://subs.example/${n}.srt`,
    lang,
  });

  it('keeps https subtitles and skips anything else', () => {
    const result = parseSubtitlesResponse({
      subtitles: [
        subtitle(1),
        { id: '2', url: 'http://subs.example/2.srt', lang: 'eng' },
        { id: '3', url: 'javascript:alert(1)', lang: 'eng' },
        { id: '4', lang: 'eng' },
        'garbage',
        { ...subtitle(5, 'pob'), label: 'Português (Brasil)', SubEncoding: 'UTF-8' },
      ],
    });
    assert.ok(result.ok);
    assert.deepEqual(result.value.subtitles, [
      subtitle(1),
      { ...subtitle(5, 'pob'), label: 'Português (Brasil)' },
    ]);
    assert.equal(result.dropped, 4);
  });

  it('fills in a missing id or language instead of dropping the subtitle', () => {
    const result = parseSubtitlesResponse({
      subtitles: [
        { url: 'https://subs.example/a.srt', lang: ' fre ' },
        { id: 'b', url: 'https://subs.example/b.srt' },
        { id: 'c', url: 'https://subs.example/c.srt', lang: 'x', label: 42 },
      ],
    });
    assert.ok(result.ok);
    assert.deepEqual(result.value.subtitles, [
      { id: 'https://subs.example/a.srt', url: 'https://subs.example/a.srt', lang: 'fre' },
      { id: 'b', url: 'https://subs.example/b.srt', lang: 'und' },
      { id: 'c', url: 'https://subs.example/c.srt', lang: 'und' },
    ]);
  });

  it('keeps the first 500 of an oversized response', () => {
    const result = parseSubtitlesResponse({
      subtitles: Array.from({ length: 600 }, (_, n) => subtitle(n)),
    });
    assert.ok(result.ok);
    assert.equal(result.value.subtitles.length, 500);
    assert.equal(result.value.subtitles.at(-1)?.id, '499');
    assert.equal(result.dropped, 100);
  });

  it('rejects a response without a subtitles list', () => {
    assert.equal(parseSubtitlesResponse({}).ok, false);
    assert.equal(parseSubtitlesResponse({ subtitles: 'none' }).ok, false);
    assert.equal(parseSubtitlesResponse(null).ok, false);
  });

  it('keeps the valid subtitles of a stream', () => {
    const result = parseStreamResponse({
      streams: [
        {
          url: 'https://cdn.example/v.mkv',
          subtitles: [subtitle(1), { url: 'http://subs.example/2.srt', lang: 'eng' }],
        },
        { url: 'https://cdn.example/w.mkv', subtitles: 'none' },
      ],
    });
    assert.ok(result.ok);
    assert.deepEqual(result.value.streams[0]?.subtitles, [subtitle(1)]);
    assert.equal(result.value.streams[1]?.subtitles, undefined);
  });
});

describe('buildResourcePath', () => {
  it('encodes ids and extra arguments', () => {
    assert.equal(
      buildResourcePath({
        resource: 'catalog',
        type: 'movie',
        id: 'top',
        extra: { search: 'alien & co' },
      }),
      '/catalog/movie/top/search=alien%20%26%20co.json',
    );
    assert.equal(
      buildResourcePath({ resource: 'meta', type: 'series', id: '../../admin' }),
      '/meta/series/..%2F..%2Fadmin.json',
    );
    assert.equal(
      buildResourcePath({
        resource: 'subtitles',
        type: 'series',
        id: 'tt0903747:2:4',
        extra: { filename: 'Show S02E04.mkv', videoSize: '1234' },
      }),
      '/subtitles/series/tt0903747%3A2%3A4/filename=Show%20S02E04.mkv&videoSize=1234.json',
    );
  });
});
