import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SkipSegment } from '@/features/playback/chapter-skip';
import {
  chooseSkipParts,
  episodeRef,
  parseSkipTimes,
  shouldLookUp,
  type EpisodeRef,
} from '@/features/playback/online-skip';
import type { PlaybackMedia } from '@/features/playback/playback-request';
import type { SkipTimes } from '@/services/native';

function media(
  titleId: string,
  videoId: string,
  season: number | null,
  episode: number | null,
  type = 'series',
): PlaybackMedia {
  return {
    title: { type, id: titleId, name: 'Breaking Bad', poster: null },
    video: { id: videoId, season, episode, name: null },
  };
}

describe('episodeRef', () => {
  it('reads the IMDb id, season and episode from the video id', () => {
    assert.deepEqual(episodeRef(media('tt0903747', 'tt0903747:2:4', 2, 4)), {
      imdbId: 'tt0903747',
      season: 2,
      episode: 4,
    });
    assert.deepEqual(episodeRef(media('tt10919420', 'tt10919420:1:12', null, null)), {
      imdbId: 'tt10919420',
      season: 1,
      episode: 12,
    });
  });

  it('falls back to the title id and the episode numbers', () => {
    assert.deepEqual(episodeRef(media('tt0903747', 'some-addon:bb-s2e4', 2, 4)), {
      imdbId: 'tt0903747',
      season: 2,
      episode: 4,
    });
  });

  it('has nothing for films, specials and other catalogues', () => {
    for (const value of [
      undefined,
      media('tt0111161', 'tt0111161', null, null, 'movie'),
      media('tt0903747', 'tt0903747:0:3', 0, 3),
      media('kitsu:1376', 'kitsu:1376:4', 1, 4),
      media('tmdb:1396', 'tmdb:1396:2:4', 2, 4),
      media('tt0903747', 'tt0903747:2', 2, null),
      media('tt0903747:2:4', 'x', null, null),
    ]) {
      assert.equal(episodeRef(value), null, JSON.stringify(value?.video));
    }
  });
});

describe('parseSkipTimes', () => {
  const valid: SkipTimes = {
    source: 'SkipDB',
    segments: [
      { kind: 'intro', start: 73.5, end: 90, offset: 0 },
      { kind: 'credits', start: 2800, end: 2853, offset: -1.2 },
    ],
    unmatched: 1,
    otherLengths: [2820],
  };

  it('accepts what the core returns', () => {
    assert.deepEqual(parseSkipTimes(valid), valid);
    assert.deepEqual(parseSkipTimes({ ...valid, unmatched: -1 }), { ...valid, unmatched: 0 });
  });

  it('reads a missing offset as none', () => {
    assert.deepEqual(
      parseSkipTimes({ ...valid, segments: [{ kind: 'intro', start: 73.5, end: 90 }] })?.segments,
      [{ kind: 'intro', start: 73.5, end: 90, offset: 0 }],
    );
  });

  it('keeps only believable lengths for other releases', () => {
    assert.deepEqual(
      parseSkipTimes({ ...valid, otherLengths: [1368, -1, '1368', Number.NaN, 99_999] })
        ?.otherLengths,
      [1368],
    );
    const { otherLengths: _, ...withoutLengths } = valid;
    assert.deepEqual(parseSkipTimes(withoutLengths)?.otherLengths, []);
  });

  it('refuses anything else', () => {
    for (const value of [
      null,
      'SkipDB',
      [],
      { ...valid, source: '' },
      { ...valid, source: '<img src=x>' },
      { ...valid, source: 'x'.repeat(40) },
      { ...valid, segments: null },
      { ...valid, segments: [{ kind: 'op', start: 0, end: 90 }] },
      { ...valid, segments: [{ kind: 'intro', start: '0', end: 90 }] },
      { ...valid, segments: [{ kind: 'intro', start: 0, end: Number.POSITIVE_INFINITY }] },
      { ...valid, segments: Array.from({ length: 17 }, () => valid.segments[0]) },
      { ...valid, segments: [{ kind: 'intro', start: 0, end: 90, offset: 40 }] },
      { ...valid, segments: [{ kind: 'intro', start: 0, end: 90, offset: '0' }] },
    ]) {
      assert.equal(parseSkipTimes(value), null, JSON.stringify(value));
    }
  });
});

describe('shouldLookUp', () => {
  const episode: EpisodeRef = { imdbId: 'tt0903747', season: 2, episode: 4 };
  const ready = { enabled: true, episode, loaded: true, duration: 2853, chapterSegments: [] };

  it('looks up a loaded episode whose chapters mark nothing', () => {
    assert.equal(shouldLookUp(ready), true);
  });

  it('does not look up when chapters mark something, or it cannot', () => {
    const intro: SkipSegment = { kind: 'intro', start: 0, end: 60 };
    assert.equal(shouldLookUp({ ...ready, chapterSegments: [intro] }), false);
    assert.equal(shouldLookUp({ ...ready, enabled: false }), false);
    assert.equal(shouldLookUp({ ...ready, episode: null }), false);
    assert.equal(shouldLookUp({ ...ready, loaded: false }), false);
    assert.equal(shouldLookUp({ ...ready, duration: null }), false);
    assert.equal(shouldLookUp({ ...ready, duration: 0 }), false);
  });
});

describe('chooseSkipParts', () => {
  const chapters: SkipSegment[] = [{ kind: 'intro', start: 20, end: 50 }];
  const times = (
    segments: SkipTimes['segments'],
    unmatched = 0,
    otherLengths: number[] = [],
  ): SkipTimes => ({ source: 'SkipDB', segments, unmatched, otherLengths });

  it('prefers the file’s chapters, whatever a lookup found', () => {
    const found = times([{ kind: 'intro', start: 73.5, end: 90, offset: 0 }]);
    for (const lookup of [
      null,
      { state: 'looking' } as const,
      { state: 'failed' } as const,
      { state: 'done', times: found } as const,
    ]) {
      assert.deepEqual(chooseSkipParts(chapters, lookup, 2853), { segments: chapters });
    }
  });

  it('uses what the lookup found when the chapters mark nothing', () => {
    const lookup = {
      state: 'done',
      times: times([
        { kind: 'credits', start: 2800, end: 2853, offset: 0 },
        { kind: 'intro', start: 73.5, end: 90, offset: 0 },
      ]),
    } as const;
    assert.deepEqual(chooseSkipParts([], lookup, 2853), {
      segments: [
        { kind: 'intro', start: 73.5, end: 90 },
        { kind: 'credits', start: 2800, end: 2853 },
      ],
      online: { state: 'found', source: 'SkipDB', offset: 0 },
    });
  });

  it('says how far off the recorded file was when the parts were trimmed for it', () => {
    // The Big Bang Theory S11E1 from a release 10 s longer than the one recorded.
    const lookup = {
      state: 'done',
      times: times([
        { kind: 'intro', start: 182.5, end: 193.1, offset: 10 },
        { kind: 'credits', start: 1215, end: 1232, offset: 10 },
      ]),
    } as const;
    assert.deepEqual(chooseSkipParts([], lookup, 1241.952), {
      segments: [
        { kind: 'intro', start: 182.5, end: 193.1 },
        { kind: 'credits', start: 1215, end: 1232 },
      ],
      online: { state: 'found', source: 'SkipDB', offset: 10 },
    });
  });

  it('holds looked-up times to the chapter rules', () => {
    // An "intro" in the second half, and credits longer than 40 % of the video.
    const lookup = {
      state: 'done',
      times: times([
        { kind: 'intro', start: 1500, end: 1560, offset: 0 },
        { kind: 'credits', start: 1500, end: 2853, offset: 0 },
      ]),
    } as const;
    assert.deepEqual(chooseSkipParts([], lookup, 2853), {
      segments: [],
      online: {
        state: 'none',
        source: 'SkipDB',
        otherReleases: true,
        otherLengths: [],
        fileLength: 2853,
      },
    });
  });

  it('says why there is nothing', () => {
    assert.deepEqual(chooseSkipParts([], { state: 'done', times: times([]) }, 2853), {
      segments: [],
      online: {
        state: 'none',
        source: 'SkipDB',
        otherReleases: false,
        otherLengths: [],
        fileLength: 2853,
      },
    });
    // The Big Bang Theory S1E1: recorded on a 22:48 file, this one is 22:13.
    assert.deepEqual(chooseSkipParts([], { state: 'done', times: times([], 2, [1368]) }, 1333), {
      segments: [],
      online: {
        state: 'none',
        source: 'SkipDB',
        otherReleases: true,
        otherLengths: [1368],
        fileLength: 1333,
      },
    });
    assert.deepEqual(chooseSkipParts([], { state: 'looking' }, 2853), {
      segments: [],
      online: { state: 'looking', source: 'SkipDB' },
    });
    assert.deepEqual(chooseSkipParts([], { state: 'failed' }, 2853), {
      segments: [],
      online: { state: 'failed', source: 'SkipDB' },
    });
  });

  it('is just the chapters when nothing was looked up', () => {
    assert.deepEqual(chooseSkipParts([], null, 2853), { segments: [] });
  });
});
