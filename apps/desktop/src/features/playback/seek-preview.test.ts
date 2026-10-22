import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import {
  BUSY_RETRY_MS,
  HOVER_DELAY_MS,
  PreviewCache,
  PreviewScheduler,
  parsePlayerPreview,
  previewSlot,
  previewStep,
} from '@/features/playback/seek-preview';
import type { PlayerPreview } from '@/services/player';

const IMAGE = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
const frame = (position: number): PlayerPreview => ({ status: 'frame', position, image: IMAGE });

describe('previewStep and previewSlot', () => {
  it('spaces previews at least 5 s apart, at most 200 to a video', () => {
    assert.equal(previewStep(60), 5);
    assert.equal(previewStep(1000), 5);
    assert.equal(previewStep(2853), 15);
    assert.equal(previewStep(2 * 60 * 60), 36);
  });

  it('previews the middle of the cell under the pointer', () => {
    assert.deepEqual(previewSlot(0, 2853), { index: 0, position: 7.5 });
    assert.deepEqual(previewSlot(100, 2853), { index: 6, position: 97.5 });
    assert.deepEqual(previewSlot(104.9, 2853), { index: 6, position: 97.5 });
    assert.deepEqual(previewSlot(105, 2853), { index: 7, position: 112.5 });
  });

  it('stays inside the video', () => {
    assert.deepEqual(previewSlot(-3, 60), { index: 0, position: 2.5 });
    assert.deepEqual(previewSlot(60, 60), { index: 11, position: 57.5 });
    // A last cell shorter than the step: its middle would be past the end.
    assert.deepEqual(previewSlot(61, 62), { index: 12, position: 61.5 });
  });
});

describe('parsePlayerPreview', () => {
  it('accepts what the core sends', () => {
    assert.deepEqual(parsePlayerPreview(frame(97.2)), frame(97.2));
    for (const status of ['busy', 'superseded', 'unavailable'] as const) {
      assert.deepEqual(parsePlayerPreview({ status }), { status });
    }
  });

  it('refuses anything that is not a JPEG data URL with a position', () => {
    for (const value of [
      null,
      'frame',
      { status: 'frame', position: 3 },
      { status: 'frame', position: -1, image: IMAGE },
      { status: 'frame', position: Number.NaN, image: IMAGE },
      { status: 'frame', position: 3, image: 'https://example.com/a.jpg' },
      { status: 'frame', position: 3, image: 'data:image/svg+xml;base64,PHN2Zz4=' },
      { status: 'frame', position: 3, image: 'data:image/jpeg;base64,"><script>' },
      { status: 'frame', position: 3, image: `data:image/jpeg;base64,${'A'.repeat(600_000)}` },
      { status: 'ready' },
    ]) {
      assert.equal(parsePlayerPreview(value), null, JSON.stringify(value)?.slice(0, 80));
    }
  });
});

describe('PreviewCache', () => {
  it('keeps frames and stops asking for cells it has', () => {
    const cache = new PreviewCache();
    assert.equal(cache.wants(3, 0), true);
    cache.record(3, frame(40), 0);
    assert.equal(cache.wants(3, 0), false);
    assert.deepEqual(cache.get(3), { image: IMAGE, position: 40 });
    assert.equal(cache.wants(4, 0), true);
  });

  it('waits after busy, and gives up when the stream cannot be previewed', () => {
    const cache = new PreviewCache();
    cache.record(1, { status: 'busy' }, 1000);
    assert.equal(cache.wants(2, 1000 + BUSY_RETRY_MS - 1), false);
    assert.equal(cache.wants(2, 1000 + BUSY_RETRY_MS), true);
    cache.record(2, { status: 'superseded' }, 0);
    assert.equal(cache.wants(2, 1000 + BUSY_RETRY_MS), true);
    cache.record(2, { status: 'unavailable' }, 0);
    assert.equal(cache.wants(5, Number.MAX_SAFE_INTEGER), false);
  });
});

/** A request whose answers the test hands out. */
function fakeRequest() {
  const calls: { position: number; resolve: (value: unknown) => void }[] = [];
  const request = (position: number) =>
    new Promise<unknown>((resolve) => calls.push({ position, resolve }));
  return { calls, request };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('PreviewScheduler', () => {
  it('asks once the pointer rests, one request at a time, then the newest cell', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const cache = new PreviewCache();
      const { calls, request } = fakeRequest();
      let frames = 0;
      const scheduler = new PreviewScheduler(
        cache,
        request,
        () => frames++,
        () => 0,
      );

      scheduler.want({ index: 1, position: 7.5 });
      scheduler.want({ index: 2, position: 22.5 });
      mock.timers.tick(HOVER_DELAY_MS - 1);
      assert.equal(calls.length, 0, 'not before the pointer rests');
      mock.timers.tick(1);
      assert.deepEqual(
        calls.map((call) => call.position),
        [22.5],
      );

      // Moving on while it is made: no second request yet...
      scheduler.want({ index: 3, position: 37.5 });
      scheduler.want({ index: 4, position: 52.5 });
      mock.timers.tick(HOVER_DELAY_MS);
      assert.equal(calls.length, 1);
      // ...then the newest cell, straight away.
      calls[0]?.resolve(frame(20));
      await settle();
      assert.equal(frames, 1);
      assert.deepEqual(cache.get(2), { image: IMAGE, position: 20 });
      assert.deepEqual(
        calls.map((call) => call.position),
        [22.5, 52.5],
      );
    } finally {
      mock.timers.reset();
    }
  });

  it('does not ask again for a cell it has, or once stopped', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const cache = new PreviewCache();
      cache.record(2, frame(20), 0);
      const { calls, request } = fakeRequest();
      const scheduler = new PreviewScheduler(
        cache,
        request,
        () => undefined,
        () => 0,
      );
      scheduler.want({ index: 2, position: 22.5 });
      mock.timers.tick(HOVER_DELAY_MS);
      scheduler.want({ index: 5, position: 67.5 });
      scheduler.stop();
      mock.timers.tick(HOVER_DELAY_MS * 10);
      assert.equal(calls.length, 0);
    } finally {
      mock.timers.reset();
    }
  });

  it('asks again later after busy, while the pointer stays', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let now = 0;
      const cache = new PreviewCache();
      const { calls, request } = fakeRequest();
      const scheduler = new PreviewScheduler(
        cache,
        request,
        () => undefined,
        () => now,
      );
      scheduler.want({ index: 2, position: 22.5 });
      mock.timers.tick(HOVER_DELAY_MS);
      calls[0]?.resolve({ status: 'busy' });
      await settle();
      now = BUSY_RETRY_MS;
      mock.timers.tick(BUSY_RETRY_MS);
      assert.equal(calls.length, 2);
      calls[1]?.resolve(frame(20));
      await settle();
      assert.ok(cache.get(2));
    } finally {
      mock.timers.reset();
    }
  });

  it('treats a failed or malformed answer as nothing to show', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const cache = new PreviewCache();
      const { calls, request } = fakeRequest();
      const scheduler = new PreviewScheduler(
        cache,
        request,
        () => undefined,
        () => 0,
      );
      scheduler.want({ index: 2, position: 22.5 });
      mock.timers.tick(HOVER_DELAY_MS);
      calls[0]?.resolve({ status: 'frame', position: 3, image: 'javascript:alert(1)' });
      await settle();
      // Malformed: the stream is treated as one that can't be previewed.
      assert.equal(cache.wants(9, 0), false);
    } finally {
      mock.timers.reset();
    }
  });
});
