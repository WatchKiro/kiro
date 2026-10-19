import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseManifest, type Stream } from '@kiro/addon-sdk';

import type { InstalledAddon } from '@/features/addons/addons-store';
import { parsePlaybackRequest, type PlaybackRequest } from '@/features/playback/playback-request';
import {
  MAX_STREAM_ATTEMPTS,
  fallbackCandidates,
  fallbackNotice,
  nextFallback,
  switchPosition,
  switchRequest,
} from '@/features/playback/stream-fallback';
import { DEFAULT_STREAM_SETTINGS } from '@/features/settings/settings-data';
import { rankStreams, type RankedStream } from '@/features/title/stream-ranking';

function addon(name: string): InstalledAddon {
  const manifest = parseManifest({
    id: `org.${name.toLowerCase()}`,
    version: '1.0.0',
    name,
    types: ['movie', 'series'],
    resources: ['stream'],
  });
  assert.ok(manifest.ok);
  return {
    transportUrl: `https://${name.toLowerCase()}.example/manifest.json`,
    manifest: manifest.value,
  };
}

const TORRENTIO = addon('Torrentio');
const OTHER = addon('Other');

const stream = (id: string, title: string, bingeGroup?: string): Stream => ({
  url: `https://cdn.example/${id}.mkv`,
  name: id,
  title,
  ...(bingeGroup && { behaviorHints: { bingeGroup } }),
});

/** Ranked as one-click Play ranks them, leaving out cams (Settings → Streams). */
function rank(...groups: [InstalledAddon, Stream[]][]) {
  return rankStreams(
    groups.map(([source, streams]) => ({ addon: source, streams })),
    { ...DEFAULT_STREAM_SETTINGS, excludeCam: true },
  );
}

const urlOf = (id: string) => `https://cdn.example/${id}.mkv`;
const ids = (choices: readonly RankedStream[]) => choices.map(({ stream: { name } }) => name);

// Best first: a 4K and a 1080p from one release group, a 1080p and a 720p
// from others, and a cam the settings filter out.
const { playable, filtered } = rank(
  [
    TORRENTIO,
    [
      stream('720p', 'Film.2024.720p.WEB-DL.x264 💾 1.5 GB', 'torrentio|720p'),
      stream('4k', 'Film.2024.2160p.WEB-DL.HDR.x265 💾 15 GB', 'torrentio|flux'),
      stream('cam', 'Film.2024.1080p.HDCAM.x264 💾 2 GB', 'torrentio|cam'),
    ],
  ],
  [
    OTHER,
    [
      stream('1080p', 'Film.2024.1080p.BluRay.x264 💾 9 GB', 'other|bluray'),
      stream('1080p-flux', 'Film.2024.1080p.WEB-DL.x264 💾 5 GB', 'torrentio|flux'),
    ],
  ],
);

describe('fallbackCandidates', () => {
  it('keeps the ranked order, without the streams that failed', () => {
    assert.deepEqual(ids(playable), ['4k', '1080p', '1080p-flux', '720p']);
    assert.deepEqual(ids(fallbackCandidates(playable, [urlOf('4k')], undefined)), [
      '1080p',
      '1080p-flux',
      '720p',
    ]);
  });

  it('tries the same release (binge group) first', () => {
    assert.deepEqual(ids(fallbackCandidates(playable, [urlOf('4k')], 'torrentio|flux')), [
      '1080p-flux',
      '1080p',
      '720p',
    ]);
  });

  it('respects the stream filters: a filtered stream is never fallen back to', () => {
    assert.deepEqual(ids(filtered), ['cam']);
    const all = fallbackCandidates(playable, [urlOf('4k'), urlOf('1080p')], 'torrentio|cam');
    assert.ok(!ids(all).includes('cam'));
  });

  it('lists a URL once, as the same stream', () => {
    const twice = rank([TORRENTIO, [stream('a', 'A 1080p'), stream('a', 'A 1080p again')]]);
    assert.equal(fallbackCandidates(twice.playable, [], undefined).length, 1);
    assert.equal(fallbackCandidates(twice.playable, [urlOf('a')], undefined).length, 0);
  });
});

describe('nextFallback', () => {
  it('moves on to the next stream and says which attempt it is', () => {
    const next = nextFallback(playable, [urlOf('4k')], 'torrentio|flux');
    assert.equal(next?.choice.stream.name, '1080p-flux');
    assert.equal(next?.attempt, 2);
    // Four streams in all: the one that failed and three more.
    assert.equal(next?.total, 4);
    assert.equal(
      fallbackNotice({ number: 2, of: 4 }),
      'That stream didn’t work, trying the next one (2 of 4)',
    );
  });

  it('carries on down the list as each stream fails', () => {
    const failed = [urlOf('4k')];
    const order: string[] = [];
    for (let next = nextFallback(playable, failed, undefined); next;) {
      order.push(`${next.choice.stream.name} ${next.attempt}/${next.total}`);
      failed.push(next.choice.url);
      next = nextFallback(playable, failed, undefined);
    }
    assert.deepEqual(order, ['1080p 2/4', '1080p-flux 3/4', '720p 4/4']);
  });

  it(`stops after ${MAX_STREAM_ATTEMPTS} streams`, () => {
    const many = rank([
      TORRENTIO,
      Array.from({ length: 8 }, (_, index) => stream(`s${index}`, `S${index} 1080p`)),
    ]).playable;
    const failed = [many[0]!.url];
    let tried = 1;
    for (let next = nextFallback(many, failed, undefined); next; tried++) {
      assert.equal(next.total, MAX_STREAM_ATTEMPTS);
      failed.push(next.choice.url);
      next = nextFallback(many, failed, undefined);
    }
    assert.equal(tried, MAX_STREAM_ATTEMPTS);
    assert.equal(nextFallback(many, failed.slice(0, 2), undefined, 2), null);
  });

  it('gives up when the list runs out', () => {
    assert.equal(nextFallback([], [urlOf('4k')], undefined), null);
    assert.equal(
      nextFallback(
        playable,
        playable.map(({ url }) => url),
        undefined,
      ),
      null,
    );
  });
});

describe('switchRequest', () => {
  const episode: PlaybackRequest = {
    url: urlOf('4k'),
    title: 'Show',
    subtitle: 'S1 E2 · Pilot — Torrentio · 4k',
    streamLabel: 'Torrentio · 4K',
    media: {
      title: { type: 'series', id: 'tt1', name: 'Show', poster: null },
      video: { id: 'tt1:1:2', season: 1, episode: 2, name: 'Pilot' },
    },
    artwork: { background: 'https://img.example/bg.jpg' },
    source: { addon: TORRENTIO.transportUrl, bingeGroup: 'torrentio|flux' },
  };

  it('plays the chosen stream from the given position, for the same episode', () => {
    const choice = playable.find(({ stream: { name } }) => name === '1080p')!;
    const next = switchRequest(episode, choice, {
      startPosition: 754.2,
      resumed: false,
      failed: [],
      reason: 'picked',
    });
    assert.equal(next.url, urlOf('1080p'));
    assert.equal(next.title, 'Show');
    assert.equal(next.subtitle, 'S1 E2 · Pilot — Other · 1080p');
    assert.deepEqual(next.media, episode.media);
    assert.deepEqual(next.artwork, episode.artwork);
    assert.deepEqual(next.source, { addon: OTHER.transportUrl, bingeGroup: 'other|bluray' });
    assert.match(next.streamLabel ?? '', /^Other · 1080p/);
    assert.deepEqual(next.handoff, {
      startPosition: 754.2,
      resumed: false,
      failed: [],
      reason: 'picked',
    });
    // It survives the trip through router state.
    assert.deepEqual(parsePlaybackRequest(structuredClone(next)), next);
  });

  it('keeps a movie without an episode line', () => {
    const movie: PlaybackRequest = {
      ...episode,
      media: {
        title: { type: 'movie', id: 'tt2', name: 'Film', poster: null },
        video: { id: 'tt2', season: null, episode: null, name: null },
      },
    };
    const next = switchRequest(movie, playable[1]!, {
      startPosition: 0,
      resumed: false,
      failed: [urlOf('4k')],
      reason: 'fallback',
      attempt: { number: 2, of: 4 },
    });
    assert.equal(next.subtitle, 'Other · 1080p');
    assert.deepEqual(parsePlaybackRequest(next)?.handoff?.attempt, { number: 2, of: 4 });
  });

  it('starts at the current position, or the start before there is one', () => {
    assert.equal(switchPosition(612.5), 612.5);
    assert.equal(switchPosition(null), 0);
    assert.equal(switchPosition(Number.NaN), 0);
    assert.equal(switchPosition(-3), 0);
  });
});

describe('parsePlaybackRequest: handoff', () => {
  const base = { url: urlOf('a'), title: 'Film' };
  const handoff = {
    startPosition: 30,
    resumed: true,
    failed: [urlOf('b')],
    reason: 'fallback',
  };

  it('reads a handoff back', () => {
    assert.deepEqual(parsePlaybackRequest({ ...base, handoff })?.handoff, handoff);
  });

  it('leaves out one that does not check out', () => {
    for (const bad of [
      { ...handoff, startPosition: -1 },
      { ...handoff, startPosition: Number.POSITIVE_INFINITY },
      { ...handoff, resumed: 'yes' },
      { ...handoff, failed: 'https://cdn.example/b.mkv' },
      { ...handoff, reason: 'other' },
      'handoff',
    ]) {
      assert.equal(parsePlaybackRequest({ ...base, handoff: bad })?.handoff, undefined);
    }
  });

  it('keeps only https URLs and sensible attempt counts', () => {
    const parsed = parsePlaybackRequest({
      ...base,
      handoff: {
        ...handoff,
        failed: ['http://cdn.example/x.mkv', 42, urlOf('c')],
        attempt: { number: 3, of: 2 },
      },
    })?.handoff;
    assert.deepEqual(parsed?.failed, [urlOf('c')]);
    assert.equal(parsed?.attempt, undefined);
  });
});
