import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_SETTINGS,
  LANGUAGE_CHOICES,
  MAX_KEYWORDS,
  MAX_KEYWORD_CHARS,
  MAX_LANGUAGES,
  areFieldsChanged,
  isChanged,
  isHexColor,
  isPassthroughAvailable,
  isValidLanguageList,
  languageLabel,
  normalizeKeyword,
  normalizeKeywords,
  normalizeLanguages,
  normalizePassthroughFormats,
  parseSettings,
  withDefaultFields,
  withDefaults,
  withGeneral,
  withPassthroughFormat,
  withPlayback,
  withStreams,
  withSubtitles,
} from '@/features/settings/settings-data';
import type { Settings } from '@/services/native';

describe('parseSettings', () => {
  const CHANGED: Settings = {
    general: {
      discordPresence: true,
      discordShowTitle: false,
      discordShowEpisode: false,
    },
    playback: {
      audioLanguages: ['ja', 'en'],
      subtitleLanguages: ['en'],
      subtitlesOff: true,
      skipIntros: true,
      onlineSkipTimes: true,
      autoplayNext: false,
      upNextSeconds: 30,
      seekSeconds: 5,
      resume: 'ask',
      rememberVolume: false,
      volume: 45,
      markWatchedPercent: 80,
      keepScreenOn: false,
      seekPreviews: false,
      audioPassthrough: true,
      passthroughFormats: ['eac3', 'dts', 'dtsHd'],
    },
    subtitles: {
      size: 150,
      color: '#ffe45c',
      edge: 'background',
      offset: 15,
      preferredType: 'sdh',
    },
    streams: {
      maxResolution: 1080,
      preferHdr: false,
      preferCached: true,
      excludeCam: true,
      maxSizeGb: 20,
      avoidCodecs: ['av1'],
      excludedKeywords: ['GROUP', '3D'],
    },
    rows: {
      discover: [{ addon: 'com.linvo.cinemeta', type: 'movie', catalog: 'top', hidden: true }],
      movies: [],
      tvShows: null,
    },
  };

  it('reads valid settings', () => {
    assert.deepEqual(parseSettings(CHANGED), CHANGED);
  });

  it('reads settings saved before the newer ones existed, with those at their defaults', () => {
    // As the core stored them in format version 1.
    const version1 = {
      playback: { audioLanguages: ['ja'], subtitleLanguages: ['en'], subtitlesOff: false },
      streams: { maxResolution: 1080, preferHdr: false, preferCached: true },
    };
    assert.deepEqual(parseSettings(version1), {
      general: DEFAULT_SETTINGS.general,
      playback: { ...DEFAULT_SETTINGS.playback, audioLanguages: ['ja'], subtitleLanguages: ['en'] },
      subtitles: DEFAULT_SETTINGS.subtitles,
      streams: { ...DEFAULT_SETTINGS.streams, maxResolution: 1080, preferHdr: false },
      rows: DEFAULT_SETTINGS.rows,
    });
  });

  it('reads row layouts, keeping their well-formed, distinct rows', () => {
    const kitsu = { addon: 'community.anime.kitsu', type: 'anime', catalog: 'kitsu-anime-airing' };
    assert.deepEqual(
      parseSettings({
        rows: {
          discover: [
            { ...kitsu, hidden: true },
            { ...kitsu, hidden: false },
            { addon: 'bad id', type: 'movie', catalog: 'top' },
            { addon: 'a.b', type: 'movie', catalog: 'to\np' },
            { addon: 'a.b', type: 'movie', catalog: 'top', later: 1 },
            'a.b/movie/top',
          ],
          movies: 'all',
        },
      }).rows,
      {
        discover: [
          { ...kitsu, hidden: true },
          { addon: 'a.b', type: 'movie', catalog: 'top', hidden: false },
        ],
        movies: null,
        tvShows: null,
      },
    );
  });

  it('reads stream settings value by value', () => {
    assert.deepEqual(
      parseSettings({ streams: { maxResolution: 999, preferHdr: false, preferCached: 'no' } })
        .streams,
      { ...DEFAULT_SETTINGS.streams, preferHdr: false },
    );
    assert.deepEqual(parseSettings({ streams: 'x' }).streams, DEFAULT_SETTINGS.streams);
    assert.deepEqual(
      parseSettings({
        streams: {
          maxSizeGb: 0,
          avoidCodecs: ['hevc', 'mpeg2', 'hevc', 'av1'],
          excludedKeywords: ['GROUP', ' group ', '', 4, 'x'.repeat(41), 'HC'],
        },
      }).streams,
      {
        ...DEFAULT_SETTINGS.streams,
        avoidCodecs: ['av1', 'hevc'],
        excludedKeywords: ['GROUP', 'HC'],
      },
    );
  });

  it('keeps the newer settings within what the core accepts', () => {
    const parsed = parseSettings({
      playback: {
        upNextSeconds: 12,
        seekSeconds: 30,
        resume: 'sometimes',
        volume: 131,
        markWatchedPercent: 99,
        keepScreenOn: 'no',
        seekPreviews: 1,
      },
      subtitles: { size: 49, color: '#FFFFFF', edge: 'glow', offset: 41, preferredType: 'forced' },
    });
    assert.deepEqual(parsed.playback, { ...DEFAULT_SETTINGS.playback, seekSeconds: 30 });
    assert.deepEqual(parsed.subtitles, { ...DEFAULT_SETTINGS.subtitles, preferredType: 'forced' });
    assert.equal(
      parseSettings({ playback: { markWatchedPercent: 70 } }).playback.markWatchedPercent,
      70,
    );
    assert.equal(
      parseSettings({ playback: { markWatchedPercent: 69 } }).playback.markWatchedPercent,
      90,
    );
    assert.equal(parseSettings({ playback: { volume: 12.5 } }).playback.volume, 100);
  });

  it('keeps Discord off unless chosen, reading its options value by value', () => {
    assert.equal(DEFAULT_SETTINGS.general.discordPresence, false);
    assert.deepEqual(
      parseSettings({ general: { discordPresence: 'yes', discordShowTitle: false } }).general,
      { ...DEFAULT_SETTINGS.general, discordShowTitle: false },
    );
    const on = withGeneral(DEFAULT_SETTINGS, { discordPresence: true });
    assert.equal(on.general.discordPresence, true);
    assert.deepEqual(on.playback, DEFAULT_SETTINGS.playback);
  });

  it('changes stream settings without touching playback', () => {
    const settings = withPlayback(DEFAULT_SETTINGS, { audioLanguages: ['ja'] });
    const changed = withStreams(settings, { maxResolution: 720 });
    assert.equal(changed.streams.maxResolution, 720);
    assert.deepEqual(changed.playback, settings.playback);
  });

  it('falls back to the default for anything missing or malformed', () => {
    for (const value of [null, 'x', {}, { playback: 1 }, { playback: {} }]) {
      assert.deepEqual(parseSettings(value), DEFAULT_SETTINGS, JSON.stringify(value));
    }
    assert.deepEqual(
      parseSettings({
        playback: { audioLanguages: ['en', 'EN!'], subtitleLanguages: ['fr', 3], subtitlesOff: 1 },
      }),
      DEFAULT_SETTINGS,
    );
    assert.deepEqual(
      parseSettings({
        playback: {
          audioLanguages: ['de'],
          subtitlesOff: 'yes',
          skipIntros: 1,
          onlineSkipTimes: 'on',
        },
      }).playback,
      { ...DEFAULT_SETTINGS.playback, audioLanguages: ['de'] },
    );
  });
});

describe('keywords', () => {
  it('stores trimmed keywords of 1 to 40 characters without control characters', () => {
    assert.equal(normalizeKeyword('  GROUP '), 'GROUP');
    assert.equal(normalizeKeyword('Dual Audio'), 'Dual Audio');
    assert.equal(normalizeKeyword('x'.repeat(MAX_KEYWORD_CHARS)), 'x'.repeat(MAX_KEYWORD_CHARS));
    for (const input of ['', '   ', 'x'.repeat(MAX_KEYWORD_CHARS + 1), 'a\nb', 'tab\there']) {
      assert.equal(normalizeKeyword(input), null, JSON.stringify(input));
    }
  });

  it('keeps distinct keywords, ignoring case, within the limit', () => {
    assert.deepEqual(normalizeKeywords(['HC', 'hc', ' Cam ', 7, '']), ['HC', 'Cam']);
    const many = Array.from({ length: MAX_KEYWORDS + 5 }, (_, index) => `word${index}`);
    assert.equal(normalizeKeywords(many).length, MAX_KEYWORDS);
    assert.deepEqual(
      withStreams(DEFAULT_SETTINGS, { excludedKeywords: [' 3D', '3d', 'GROUP'] }).streams
        .excludedKeywords,
      ['3D', 'GROUP'],
    );
  });
});

describe('withSubtitles', () => {
  it('normalises colours and refuses values the core would', () => {
    assert.equal(withSubtitles(DEFAULT_SETTINGS, { color: '#FFE45C' }).subtitles.color, '#ffe45c');
    assert.equal(withSubtitles(DEFAULT_SETTINGS, { color: 'red' }).subtitles.color, '#ffffff');
    assert.equal(withSubtitles(DEFAULT_SETTINGS, { size: 500 }).subtitles.size, 100);
    assert.equal(withSubtitles(DEFAULT_SETTINGS, { offset: 20 }).subtitles.offset, 20);
    assert.ok(isHexColor('#00ff7f'));
    assert.ok(!isHexColor('#00FF7F'));
  });
});

describe('resetting', () => {
  it('puts one section back to its defaults and knows what changed', () => {
    const changed = withSubtitles(withPlayback(DEFAULT_SETTINGS, { seekSeconds: 30 }), {
      edge: 'shadow',
    });
    assert.ok(isChanged(changed, 'playback'));
    assert.ok(isChanged(changed, 'subtitles'));
    assert.ok(!isChanged(changed, 'streams'));
    const reset = withDefaults(changed, 'playback');
    assert.deepEqual(reset.playback, DEFAULT_SETTINGS.playback);
    assert.equal(reset.subtitles.edge, 'shadow');
  });

  it('puts some fields back, across sections, and leaves the rest', () => {
    // Settings → Subtitles: two playback fields and the subtitle section.
    const changed = withSubtitles(
      withPlayback(DEFAULT_SETTINGS, { subtitlesOff: true, audioLanguages: ['ja'] }),
      { size: 150 },
    );
    const fields = {
      playback: ['subtitlesOff', 'subtitleLanguages'],
      subtitles: ['size'],
    } as const;
    assert.ok(areFieldsChanged(changed, fields));
    const reset = withDefaultFields(changed, fields);
    assert.equal(reset.playback.subtitlesOff, false);
    assert.equal(reset.subtitles.size, DEFAULT_SETTINGS.subtitles.size);
    // Audio's language isn't one of them.
    assert.deepEqual(reset.playback.audioLanguages, ['ja']);
    assert.ok(!areFieldsChanged(reset, fields));
    assert.ok(areFieldsChanged(reset, { playback: ['audioLanguages'] }));
    assert.equal(withDefaultFields(changed, {}), changed);
  });
});

describe('language lists', () => {
  it('accepts exactly what the core accepts', () => {
    assert.equal(isValidLanguageList([]), true);
    assert.equal(isValidLanguageList(['en', 'fil']), true);
    for (const list of [['EN'], ['en-GB'], ['e'], ['en', 'en'], ['english']]) {
      assert.equal(isValidLanguageList(list), false, JSON.stringify(list));
    }
    assert.equal(isValidLanguageList(Array.from({ length: MAX_LANGUAGES + 1 }, () => 'en')), false);
  });

  it('normalises to comparable, distinct codes within the limit', () => {
    assert.deepEqual(normalizeLanguages(['eng', 'en', 'pt-BR', 'und', 7, 'ger']), [
      'en',
      'pt',
      'de',
    ]);
    const many = normalizeLanguages(LANGUAGE_CHOICES);
    assert.equal(many.length, MAX_LANGUAGES);
    assert.ok(isValidLanguageList(many));
  });

  it('offers only valid, distinct, named choices', () => {
    assert.equal(new Set(LANGUAGE_CHOICES).size, LANGUAGE_CHOICES.length);
    for (const code of LANGUAGE_CHOICES) {
      assert.deepEqual(normalizeLanguages([code]), [code], code);
      assert.notEqual(languageLabel(code), code.toUpperCase(), `${code} has a name`);
    }
  });
});

describe('withPlayback', () => {
  it('changes playback settings and normalises them for saving', () => {
    const next = withPlayback(DEFAULT_SETTINGS, { audioLanguages: ['jpn', 'ja', 'en'] });
    assert.deepEqual(next.playback, { ...DEFAULT_SETTINGS.playback, audioLanguages: ['ja', 'en'] });
    assert.deepEqual(withPlayback(next, { subtitlesOff: true }).playback.audioLanguages, [
      'ja',
      'en',
    ]);
  });
});

describe('withPlayback limits', () => {
  it('keeps the watched threshold and volume within range', () => {
    assert.equal(
      withPlayback(DEFAULT_SETTINGS, { markWatchedPercent: 50 }).playback.markWatchedPercent,
      90,
    );
    assert.equal(
      withPlayback(DEFAULT_SETTINGS, { markWatchedPercent: 98 }).playback.markWatchedPercent,
      98,
    );
    assert.equal(withPlayback(DEFAULT_SETTINGS, { volume: 64.6 }).playback.volume, 65);
    assert.equal(withPlayback(DEFAULT_SETTINGS, { volume: 200 }).playback.volume, 100);
  });
});

describe('audio passthrough', () => {
  it('is off, with the formats every receiver takes', () => {
    assert.equal(DEFAULT_SETTINGS.playback.audioPassthrough, false);
    assert.deepEqual(DEFAULT_SETTINGS.playback.passthroughFormats, ['ac3', 'dts']);
  });

  it('reads stored formats as the core keeps them', () => {
    const read = (passthroughFormats: unknown) =>
      parseSettings({ playback: { audioPassthrough: true, passthroughFormats } }).playback;
    assert.deepEqual(read(['truehd', 'mp3', 7, 'ac3', 'ac3']).passthroughFormats, [
      'ac3',
      'truehd',
    ]);
    // DTS-HD needs DTS.
    assert.deepEqual(read(['dtsHd', 'eac3']).passthroughFormats, ['eac3']);
    assert.deepEqual(read([]).passthroughFormats, []);
    assert.deepEqual(read('ac3').passthroughFormats, ['ac3', 'dts']);
    assert.equal(read(['ac3']).audioPassthrough, true);
    assert.equal(
      parseSettings({ playback: { audioPassthrough: 'yes' } }).playback.audioPassthrough,
      false,
    );
  });

  it('keeps DTS-HD and DTS together when toggling', () => {
    assert.deepEqual(withPassthroughFormat(['ac3'], 'dtsHd', true), ['ac3', 'dts', 'dtsHd']);
    assert.deepEqual(withPassthroughFormat(['ac3', 'dts', 'dtsHd'], 'dts', false), ['ac3']);
    assert.deepEqual(withPassthroughFormat(['ac3', 'dts', 'dtsHd'], 'dtsHd', false), [
      'ac3',
      'dts',
    ]);
    assert.deepEqual(withPassthroughFormat(['dts'], 'eac3', true), ['eac3', 'dts']);
    assert.deepEqual(withPassthroughFormat(['dts'], 'dts', true), ['dts']);
    assert.deepEqual(normalizePassthroughFormats(['truehd', 'dts', 'ac3']), [
      'ac3',
      'dts',
      'truehd',
    ]);
  });

  it('greys out what a Mac can’t send', () => {
    const available = (os: string | null) =>
      (['ac3', 'eac3', 'dts', 'dtsHd', 'truehd'] as const).filter((format) =>
        isPassthroughAvailable(format, os),
      );
    assert.deepEqual(available('macos'), ['ac3', 'dts']);
    assert.deepEqual(available('windows'), ['ac3', 'eac3', 'dts', 'dtsHd', 'truehd']);
    assert.deepEqual(available('linux'), ['ac3', 'eac3', 'dts', 'dtsHd', 'truehd']);
    assert.deepEqual(available(null), ['ac3', 'eac3', 'dts', 'dtsHd', 'truehd']);
  });

  it('saves through withPlayback', () => {
    const settings = withPlayback(DEFAULT_SETTINGS, {
      audioPassthrough: true,
      passthroughFormats: ['dtsHd', 'ac3'],
    });
    assert.equal(settings.playback.audioPassthrough, true);
    assert.deepEqual(settings.playback.passthroughFormats, ['ac3']);
    assert.ok(isChanged(settings, 'playback'));
  });
});
