import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AddonManifest, ResourceRequest } from '@kiro/addon-sdk';

import type { InstalledAddon } from '@/features/addons/addons-store';
import {
  fetchAddonSubtitles,
  groupSubtitles,
  mergeSubtitles,
  playerLabel,
  subtitleAddons,
  subtitleLanguage,
  subtitlesRequest,
  toAddonSubtitles,
  type AddonSubtitle,
} from '@/features/playback/addon-subtitles';

function addon(name: string, resources: AddonManifest['resources']): InstalledAddon {
  return {
    transportUrl: `https://${name.toLowerCase()}.example/manifest.json`,
    manifest: {
      id: `org.example.${name.toLowerCase()}`,
      version: '1.0.0',
      name,
      types: ['movie', 'series'],
      resources,
      catalogs: [],
      idPrefixes: ['tt'],
    },
  };
}

const OPENSUBTITLES = addon('OpenSubtitles', ['subtitles']);
const SUBSOURCE = addon('SubSource', [{ name: 'subtitles', types: ['series'] }]);
const STREAMS = addon('Streams', ['stream']);

const sub = (language: string | undefined, origin = 'OpenSubtitles', n = 1): AddonSubtitle => ({
  url: `https://subs.example/${origin}/${language ?? 'x'}/${n}.srt`,
  ...(language && { language }),
  origin,
});

describe('subtitleAddons and subtitlesRequest', () => {
  it('asks only the addons with a subtitles resource for the type', () => {
    const addons = [STREAMS, OPENSUBTITLES, SUBSOURCE];
    assert.deepEqual(subtitleAddons(addons, 'movie', 'tt1'), [OPENSUBTITLES]);
    assert.deepEqual(subtitleAddons(addons, 'series', 'tt1:1:2'), [OPENSUBTITLES, SUBSOURCE]);
    assert.deepEqual(subtitleAddons(addons, 'movie', 'kitsu:1'), []);
  });

  it('asks for the movie or episode, with the file name and size when known', () => {
    assert.deepEqual(subtitlesRequest('series', 'tt1:1:2'), {
      resource: 'subtitles',
      type: 'series',
      id: 'tt1:1:2',
    });
    assert.deepEqual(
      subtitlesRequest('movie', 'tt1', { filename: ' Movie.2024.mkv ', videoSize: 1024 }),
      {
        resource: 'subtitles',
        type: 'movie',
        id: 'tt1',
        extra: { filename: 'Movie.2024.mkv', videoSize: '1024' },
      },
    );
    assert.equal(subtitlesRequest('movie', 'tt1', { videoSize: -5 }).extra, undefined);
  });
});

describe('subtitleLanguage', () => {
  it('keeps tags and maps names and OpenSubtitles codes', () => {
    assert.equal(subtitleLanguage('eng'), 'eng');
    assert.equal(subtitleLanguage('pt_BR'), 'pt-BR');
    assert.equal(subtitleLanguage('pob'), 'pt-BR');
    assert.equal(subtitleLanguage('English'), 'en');
    assert.equal(subtitleLanguage(' french '), 'fr');
  });

  it('drops unknown or unsafe values', () => {
    for (const value of [undefined, '', 'und', 'Klingonese', 'en;rm', 'en\nx', 'x'.repeat(40)]) {
      assert.equal(subtitleLanguage(value), undefined, String(value));
    }
  });
});

describe('toAddonSubtitles and mergeSubtitles', () => {
  it('keeps https files, cleans labels and caps the count', () => {
    const subtitles = toAddonSubtitles(
      [
        { url: 'https://subs.example/1.srt', lang: 'eng', label: '  Release\nname ' },
        { url: 'http://subs.example/2.srt', lang: 'eng' },
        { url: 'https://subs.example/3.srt', lang: 'und' },
        { url: 'https://subs.example/4.srt', lang: 'fre' },
      ],
      'OpenSubtitles v3',
      2,
    );
    assert.deepEqual(subtitles, [
      {
        url: 'https://subs.example/1.srt',
        language: 'eng',
        label: 'Release name',
        origin: 'OpenSubtitles v3',
      },
      { url: 'https://subs.example/3.srt', origin: 'OpenSubtitles v3' },
    ]);
  });

  it('merges by URL, keeping the first, up to a limit', () => {
    const a = sub('eng', 'A');
    const b = sub('fre', 'B');
    assert.deepEqual(mergeSubtitles([a], [{ ...a, origin: 'C' }, b]), [a, b]);
    assert.deepEqual(mergeSubtitles([a], [b], 1), [a]);
  });
});

describe('playerLabel', () => {
  it('names the language (or the addon’s label) and the addon', () => {
    assert.equal(playerLabel(sub('ger', 'OpenSubtitles v3')), 'German · OpenSubtitles v3');
    assert.equal(playerLabel({ ...sub('eng'), label: 'Forced' }), 'Forced · OpenSubtitles');
    assert.equal(playerLabel(sub(undefined, 'Addon')), 'Subtitles · Addon');
  });
});

describe('groupSubtitles', () => {
  it('groups by language, preferred first, then by name, unknown last', () => {
    const groups = groupSubtitles(
      [sub(undefined), sub('spa'), sub('eng'), sub('ger'), sub('en-GB', 'B'), sub('fre')],
      ['de', 'en'],
    );
    assert.deepEqual(
      groups.map((group) => [group.name, group.preferred, group.options.length]),
      [
        ['German', true, 1],
        ['English', true, 2],
        ['French', false, 1],
        ['Spanish', false, 1],
        ['Other languages', false, 1],
      ],
    );
  });

  it('numbers unlabelled files from the same addon and names regional variants', () => {
    const [portuguese] = groupSubtitles(
      [
        sub('por', 'OpenSubtitles', 1),
        sub('pt-BR', 'OpenSubtitles', 2),
        { ...sub('por', 'SubSource'), label: 'Release.1080p' },
      ],
      [],
    );
    assert.deepEqual(
      portuguese?.options.map(({ title, detail }) => [title, detail]),
      [
        ['OpenSubtitles 1', undefined],
        ['OpenSubtitles 2', 'Brazilian Portuguese'],
        ['Release.1080p', 'SubSource'],
      ],
    );
  });
});

describe('fetchAddonSubtitles', () => {
  it('reports each addon’s valid subtitles and skips failures', async () => {
    const requests: string[] = [];
    const reported: AddonSubtitle[][] = [];
    await fetchAddonSubtitles({
      addons: [OPENSUBTITLES, SUBSOURCE, STREAMS],
      request: subtitlesRequest('series', 'tt1:1:2'),
      signal: new AbortController().signal,
      fetch: (url: string, request: ResourceRequest) => {
        requests.push(`${url} ${request.id}`);
        if (url === STREAMS.transportUrl) return Promise.reject(new Error('HTTP 404'));
        if (url === SUBSOURCE.transportUrl) return Promise.resolve({ nope: true });
        return Promise.resolve({
          subtitles: [
            { id: '1', url: 'https://subs.example/1.srt', lang: 'eng' },
            { id: '2', url: 'http://subs.example/2.srt', lang: 'eng' },
          ],
        });
      },
      onSubtitles: (subtitles) => reported.push(subtitles),
    });
    assert.equal(requests.length, 3);
    assert.deepEqual(reported, [
      [{ url: 'https://subs.example/1.srt', language: 'eng', origin: 'OpenSubtitles' }],
    ]);
  });

  it('stops reporting once aborted, and passes the signal on', async () => {
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    const reported: unknown[] = [];
    const done = fetchAddonSubtitles({
      addons: [OPENSUBTITLES],
      request: subtitlesRequest('movie', 'tt1'),
      signal: controller.signal,
      fetch: (_url, _request, options) => {
        signal = options.signal;
        return new Promise((resolve) =>
          setTimeout(
            () => resolve({ subtitles: [{ url: 'https://subs.example/1.srt', lang: 'eng' }] }),
            5,
          ),
        );
      },
      onSubtitles: (subtitles) => reported.push(subtitles),
    });
    controller.abort();
    await done;
    assert.equal(signal, controller.signal);
    assert.deepEqual(reported, []);
  });
});
