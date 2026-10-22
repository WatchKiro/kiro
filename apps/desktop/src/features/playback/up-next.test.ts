import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseManifest, type Stream } from '@kiro/addon-sdk';

import {
  UP_NEXT_LEAD_SECONDS,
  bingeStream,
  isCountingDown,
  isNearEnd,
  upNextAction,
  type RankedNext,
} from '@/features/playback/up-next';
import { DEFAULT_STREAM_SETTINGS } from '@/features/settings/settings-data';
import { rankStreams } from '@/features/title/stream-ranking';

const manifest = parseManifest({
  id: 'org.other',
  version: '1.0.0',
  name: 'Other',
  types: ['series'],
  resources: ['stream'],
});
assert.ok(manifest.ok);
const ADDON = { transportUrl: 'https://other.example/manifest.json', manifest: manifest.value };

const stream = (url: string | undefined, bingeGroup?: string): Stream => ({
  ...(url && { url }),
  ...(bingeGroup && { behaviorHints: { bingeGroup } }),
});

describe('isNearEnd', () => {
  const duration = 2_700;

  it('is true in the last seconds of an episode, and at its end', () => {
    assert.equal(isNearEnd('playing', duration - UP_NEXT_LEAD_SECONDS - 1, duration), false);
    assert.equal(isNearEnd('playing', duration - UP_NEXT_LEAD_SECONDS, duration), true);
    assert.equal(isNearEnd('paused', duration - 5, duration), true);
    assert.equal(isNearEnd('ended', 0, null), true);
  });

  it('is false while loading, for live streams and for short clips', () => {
    assert.equal(isNearEnd('loading', duration - 5, duration), false);
    assert.equal(isNearEnd('idle', duration - 5, duration), false);
    assert.equal(isNearEnd('playing', 100, null), false);
    assert.equal(isNearEnd('playing', 55, 60), false);
  });

  it('is true from the start of closing credits marked by chapters', () => {
    const credits = duration - 120;
    assert.equal(isNearEnd('playing', credits - 1, duration, credits), false);
    assert.equal(isNearEnd('playing', credits, duration, credits), true);
    assert.equal(isNearEnd('paused', credits + 30, duration, credits), true);
    assert.equal(isNearEnd('loading', credits + 30, duration, credits), false);
    assert.equal(isNearEnd('playing', 50, 100, 40), false, 'not for short clips');
  });
});

describe('isCountingDown', () => {
  it('counts while playing or ended, not while paused', () => {
    assert.equal(isCountingDown('playing'), true);
    assert.equal(isCountingDown('ended'), true);
    assert.equal(isCountingDown('paused'), false);
  });

  it('never counts with autoplay off', () => {
    assert.equal(isCountingDown('playing', false), false);
    assert.equal(isCountingDown('ended', false), false);
  });
});

describe('bingeStream', () => {
  it('picks the first playable stream with the same binge group', () => {
    const streams = [
      stream('https://cdn.example/4k.mkv', 'beta|2160p'),
      stream('http://cdn.example/insecure.mkv', 'beta|1080p'),
      stream(undefined, 'beta|1080p'),
      stream('https://cdn.example/1080p.mkv', 'beta|1080p'),
      stream('https://cdn.example/1080p-b.mkv', 'beta|1080p'),
    ];
    assert.equal(bingeStream(streams, 'beta|1080p')?.url, 'https://cdn.example/1080p.mkv');
  });

  it('matches nothing without a binge group, or when the release is missing', () => {
    const streams = [stream('https://cdn.example/a.mkv'), stream('https://cdn.example/b.mkv', 'x')];
    assert.equal(bingeStream(streams, undefined), undefined);
    assert.equal(bingeStream(streams, 'y'), undefined);
    assert.equal(bingeStream([], 'x'), undefined);
  });
});

describe('upNextAction', () => {
  const ready = (streams: Stream[]) => ({ status: 'ready' as const, streams });
  const nothing: RankedNext = { ready: true, best: undefined };
  const ranking = (streams: Stream[]): RankedNext => ({
    ready: true,
    best: rankStreams([{ addon: ADDON, streams }], DEFAULT_STREAM_SETTINGS).playable[0],
  });

  it('plays the matching stream from the same addon', () => {
    const action = upNextAction(
      ready([stream('https://cdn.example/e4.mkv', 'g')]),
      'g',
      true,
      ranking([stream('https://other.example/better-4k.mkv')]),
    );
    assert.equal(action.kind, 'play');
    assert.equal(action.kind === 'play' && action.url, 'https://cdn.example/e4.mkv');
  });

  it('waits while the next episode’s streams load', () => {
    assert.deepEqual(upNextAction(undefined, 'g', true, nothing), { kind: 'wait' });
    assert.deepEqual(upNextAction({ status: 'loading' }, 'g', true, nothing), { kind: 'wait' });
    assert.deepEqual(
      upNextAction(ready([]), 'g', true, { ready: false, best: undefined }),
      { kind: 'wait' },
      'other addons still answering',
    );
  });

  it('plays the best-ranked stream when the same release has none', () => {
    const best = ranking([
      stream('https://other.example/720.mkv'),
      { url: 'https://other.example/1080.mkv', name: '[XY+] Other\n1080p' },
    ]);
    for (const action of [
      upNextAction(ready([stream('https://cdn.example/x', 'other')]), 'g', true, best),
      upNextAction({ status: 'error', message: 'down' }, 'g', true, best),
      upNextAction(undefined, undefined, true, best),
      upNextAction(undefined, 'g', false, best),
    ]) {
      assert.equal(action.kind, 'best');
      assert.equal(action.kind === 'best' && action.choice.url, 'https://other.example/1080.mkv');
    }
  });

  it('opens the stream list when nothing can play', () => {
    const choose = { kind: 'choose' };
    assert.deepEqual(
      upNextAction(ready([stream('https://cdn.example/x', 'other')]), 'g', true, nothing),
      choose,
    );
    assert.deepEqual(
      upNextAction({ status: 'error', message: 'down' }, 'g', true, nothing),
      choose,
    );
    assert.deepEqual(upNextAction(undefined, undefined, true, nothing), choose, 'no binge group');
    assert.deepEqual(upNextAction(undefined, 'g', false, nothing), choose, 'addon uninstalled');
  });
});
