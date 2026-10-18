import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { MediaTrack } from '@kiro/player-core';

import { languageCode } from '@/features/playback/track-labels';
import { chooseTracks, type TrackSettings } from '@/features/playback/track-preferences';

describe('languageCode', () => {
  it('reduces ISO 639-2 codes and BCP 47 tags to one comparable code', () => {
    assert.equal(languageCode('eng'), 'en');
    assert.equal(languageCode('ger'), 'de');
    assert.equal(languageCode('deu'), 'de');
    assert.equal(languageCode('fre'), 'fr');
    assert.equal(languageCode('pt-BR'), 'pt');
    assert.equal(languageCode('zh_Hant'), 'zh');
    assert.equal(languageCode('nob'), 'no');
    assert.equal(languageCode(' JA '), 'ja');
    assert.equal(languageCode('fil'), 'fil', 'three-letter codes without a short form');
  });

  it('has no code for missing or non-language values', () => {
    for (const value of [undefined, '', 'und', 'zxx', 'mul', 'english', '12', 'e']) {
      assert.equal(languageCode(value), undefined, String(value));
    }
  });
});

/** test5.mkv-like tracks, as mpv reports them. */
const TRACKS: MediaTrack[] = [
  { id: '1', kind: 'audio', language: 'eng', label: 'Surround', isDefault: true },
  { id: '2', kind: 'audio', language: 'eng', label: 'Director’s commentary' },
  { id: '3', kind: 'audio', language: 'jpn' },
  { id: '4', kind: 'audio', language: 'jpn', label: 'Commentary', isDefault: true },
  { id: '1', kind: 'subtitle', language: 'eng', label: 'English (SDH)' },
  { id: '2', kind: 'subtitle', language: 'eng', label: 'English' },
  { id: '3', kind: 'subtitle', language: 'eng', label: 'Signs', isForced: true },
  { id: '4', kind: 'subtitle', language: 'jpn', label: 'Signs & songs', isForced: true },
  { id: '5', kind: 'subtitle', language: 'spa' },
  { id: '6', kind: 'video', language: 'und' },
];

const settings = (patch: Partial<TrackSettings>): TrackSettings => ({
  audioLanguages: [],
  subtitleLanguages: [],
  subtitlesOff: false,
  ...patch,
});
const NONE = { audioTrackId: '1', subtitleTrackId: null };

describe('chooseTracks', () => {
  it('keeps the stream’s choice without preferences', () => {
    assert.deepEqual(chooseTracks(TRACKS, settings({}), NONE), {});
  });

  it('picks the first preferred audio language the stream has, avoiding commentary', () => {
    assert.deepEqual(chooseTracks(TRACKS, settings({ audioLanguages: ['ja', 'en'] }), NONE), {
      audioTrackId: '3',
    });
    assert.deepEqual(chooseTracks(TRACKS, settings({ audioLanguages: ['ko', 'en'] }), NONE), {});
    assert.deepEqual(chooseTracks(TRACKS, settings({ audioLanguages: ['ko'] }), NONE), {});
  });

  it('prefers full subtitles to SDH and forced ones, in preference order', () => {
    assert.deepEqual(chooseTracks(TRACKS, settings({ subtitleLanguages: ['en'] }), NONE), {
      subtitleTrackId: '2',
    });
    assert.deepEqual(chooseTracks(TRACKS, settings({ subtitleLanguages: ['de', 'es'] }), NONE), {
      subtitleTrackId: '5',
    });
    assert.deepEqual(
      chooseTracks(TRACKS, settings({ subtitleLanguages: ['de'] }), {
        audioTrackId: '1',
        subtitleTrackId: '5',
      }),
      {},
      'no match keeps the stream’s subtitles',
    );
  });

  it('puts SDH or forced subtitles first when preferred', () => {
    const english = { subtitleLanguages: ['en'] };
    assert.deepEqual(
      chooseTracks(TRACKS, settings({ ...english, preferredSubtitleType: 'sdh' }), NONE),
      { subtitleTrackId: '1' },
    );
    assert.deepEqual(
      chooseTracks(TRACKS, settings({ ...english, preferredSubtitleType: 'forced' }), NONE),
      { subtitleTrackId: '3' },
    );
    assert.deepEqual(
      chooseTracks(TRACKS, settings({ ...english, preferredSubtitleType: 'regular' }), NONE),
      { subtitleTrackId: '2' },
    );
    // Without that type in the language, the usual order applies.
    assert.deepEqual(
      chooseTracks(
        TRACKS,
        settings({ subtitleLanguages: ['es'], preferredSubtitleType: 'forced' }),
        NONE,
      ),
      { subtitleTrackId: '5' },
    );
  });

  it('turns subtitles off, keeping forced ones in the audio language', () => {
    const current = { audioTrackId: '1', subtitleTrackId: '2' };
    assert.deepEqual(chooseTracks(TRACKS, settings({ subtitlesOff: true }), current), {
      subtitleTrackId: '3',
    });
    assert.deepEqual(
      chooseTracks(TRACKS, settings({ subtitlesOff: true, audioLanguages: ['ja'] }), current),
      { audioTrackId: '3', subtitleTrackId: '4' },
    );
    assert.deepEqual(
      chooseTracks(TRACKS, settings({ subtitlesOff: true, subtitleLanguages: ['en'] }), {
        audioTrackId: '9',
        subtitleTrackId: '2',
      }),
      { subtitleTrackId: null },
      'without a known audio language, off means off',
    );
  });

  it('only reports changes from the current selection', () => {
    assert.deepEqual(
      chooseTracks(TRACKS, settings({ audioLanguages: ['ja'], subtitleLanguages: ['en'] }), {
        audioTrackId: '3',
        subtitleTrackId: '2',
      }),
      {},
    );
  });

  describe('with addon subtitles', () => {
    const addon = (language: string, label?: string) => ({
      url: `https://subs.example/${language}-${label ?? 'plain'}.srt`,
      language,
      origin: 'OpenSubtitles v3',
      ...(label && { label }),
    });
    const ADDON = [addon('ger', 'German SDH'), addon('ger'), addon('pt-BR'), addon('eng')];

    it('picks an addon subtitle when the stream has none in a preferred language', () => {
      assert.deepEqual(
        chooseTracks(TRACKS, settings({ subtitleLanguages: ['de', 'es'] }), NONE, ADDON),
        { addonSubtitle: addon('ger') },
        'full subtitles before SDH ones',
      );
      assert.deepEqual(chooseTracks(TRACKS, settings({ subtitleLanguages: ['pt'] }), NONE, ADDON), {
        addonSubtitle: addon('pt-BR'),
      });
    });

    it('prefers an SDH addon subtitle when SDH is preferred', () => {
      assert.deepEqual(
        chooseTracks(
          TRACKS,
          settings({ subtitleLanguages: ['de'], preferredSubtitleType: 'sdh' }),
          NONE,
          ADDON,
        ),
        { addonSubtitle: addon('ger', 'German SDH') },
      );
    });

    it('keeps the stream’s own track for the same language', () => {
      assert.deepEqual(chooseTracks(TRACKS, settings({ subtitleLanguages: ['en'] }), NONE, ADDON), {
        subtitleTrackId: '2',
      });
      assert.deepEqual(
        chooseTracks(TRACKS, settings({ subtitleLanguages: ['es', 'de'] }), NONE, ADDON),
        { subtitleTrackId: '5' },
        'an earlier preferred language in the stream wins',
      );
    });

    it('never adds one when subtitles are off by default', () => {
      assert.deepEqual(
        chooseTracks(
          TRACKS,
          settings({ subtitlesOff: true, subtitleLanguages: ['de'] }),
          { audioTrackId: '1', subtitleTrackId: '3' },
          ADDON,
        ),
        {},
        'only the forced track in the audio language',
      );
    });

    it('does nothing without a preferred language', () => {
      assert.deepEqual(chooseTracks(TRACKS, settings({}), NONE, ADDON), {});
    });
  });
});
