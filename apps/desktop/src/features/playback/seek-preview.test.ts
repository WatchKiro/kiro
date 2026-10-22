import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import {
  BUSY_RETRY_MS,
  BACKGROUND_DELAY_MS,
  HOVER_DELAY_MS,
  MAX_BACKGROUND_RETRIES,
  MAX_PREFETCHES,
  MAX_SEEDS,
  NEAREST_CELLS,
  PREFETCH_DELAY_MS,
  PreviewCache,
  PreviewCaches,
  PreviewScheduler,
  STORYBOARD_FRAMES,
  WARM_INTERVAL_MS,
  backgroundSlots,
  parsePlayerPreview,
  previewNeighbours,
  previewSlot,
  previewStep,
  storyboardReach,
} from '@/features/playback/seek-preview';
import type { PlayerPreview, PreviewKind } from '@/services/player';

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

  it('lists the cells to make as the stream loads: where it started, chapters, then a storyboard', () => {
    // A 2853 s video: 15 s cells, 191 of them.
    const slots = backgroundSlots(2853, 1830, [0, 95, 2700]);
    const seeds = slots.filter((slot) => slot.kind === 'prefetch');
    assert.deepEqual(
      seeds.map((slot) => slot.index),
      [122, 121, 0, 6, 180],
      'the start, the cell before it, then each chapter',
    );
    const storyboard = slots.filter((slot) => slot.kind === 'storyboard');
    assert.equal(storyboard.length, STORYBOARD_FRAMES);
    assert.equal(storyboard[0]?.index, 5, 'half a spacing in');
    assert.equal(storyboard[15]?.index, 184);
    assert.equal(new Set(slots.map((slot) => slot.index)).size, slots.length, 'no cell twice');

    // Seeds are capped, and outside the video ignored; a storyboard cell
    // already seeded isn't repeated.
    const many = backgroundSlots(
      2853,
      0,
      Array.from({ length: 20 }, (_, i) => i * 100 + 50),
    );
    assert.equal(many.filter((slot) => slot.kind === 'prefetch').length, MAX_SEEDS);
    const short = backgroundSlots(60, 0, [-5, 70]);
    assert.deepEqual(
      short.map((slot) => [slot.index, slot.kind]),
      [
        [0, 'prefetch'],
        ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((index) => [index, 'storyboard']),
      ],
    );
  });

  it('reaches as far as half the storyboard spacing for a stand-in', () => {
    assert.equal(storyboardReach(2853), 6);
    assert.equal(storyboardReach(60), NEAREST_CELLS);
  });

  it('names the cells either side, the next one first, inside the video', () => {
    assert.deepEqual(previewNeighbours(previewSlot(100, 2853), 2853), [
      { index: 7, position: 112.5 },
      { index: 5, position: 82.5 },
    ]);
    assert.deepEqual(previewNeighbours(previewSlot(0, 60), 60), [{ index: 1, position: 7.5 }]);
    assert.deepEqual(previewNeighbours(previewSlot(60, 60), 60), [{ index: 10, position: 52.5 }]);
  });
});

describe('parsePlayerPreview', () => {
  it('accepts what the core sends', () => {
    assert.deepEqual(parsePlayerPreview(frame(97.2)), frame(97.2));
    for (const status of ['busy', 'superseded', 'unavailable', 'warming'] as const) {
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

  it('finds the nearest frame to stand in, the earlier of two equally near', () => {
    const cache = new PreviewCache();
    assert.equal(cache.nearest(5), undefined);
    cache.record(3, frame(30), 0);
    cache.record(7, frame(70), 0);
    assert.deepEqual(cache.nearest(5), { frame: { image: IMAGE, position: 30 }, distance: 2 });
    assert.deepEqual(cache.nearest(6), { frame: { image: IMAGE, position: 70 }, distance: 1 });
    assert.deepEqual(cache.nearest(3), { frame: { image: IMAGE, position: 30 }, distance: 0 });
    assert.equal(cache.nearest(0), undefined, `no further than ${NEAREST_CELLS} cells`);
    assert.equal(cache.nearest(5, 1), undefined);
  });

  it('waits after busy, and gives up when the stream cannot be previewed', () => {
    const cache = new PreviewCache();
    cache.record(1, { status: 'busy' }, 1000);
    assert.equal(cache.wants(2, 1000 + BUSY_RETRY_MS - 1), false);
    assert.equal(cache.wants(2, 1000 + BUSY_RETRY_MS), true);
    cache.record(2, { status: 'superseded' }, 0);
    assert.equal(cache.wants(2, 1000 + BUSY_RETRY_MS), true);
    assert.equal(cache.available, true);
    cache.record(2, { status: 'unavailable' }, 0);
    assert.equal(cache.wants(5, Number.MAX_SAFE_INTEGER), false);
    assert.equal(cache.available, false);
  });

  it('keeps a background refusal from holding up hovers, and a budget on background frames', () => {
    const cache = new PreviewCache();
    cache.record(1, { status: 'busy' }, 1000, 'prefetch');
    assert.equal(cache.wants(1, 1000), true, 'hovers still ask');
    assert.equal(cache.wantsBackground(1, 1000, 'prefetch'), false);
    assert.equal(cache.wantsBackground(1, 1000, 'storyboard'), false);
    assert.equal(cache.wantsBackground(1, 1000 + BUSY_RETRY_MS, 'prefetch'), true);
    // A hover's refusal holds up both.
    cache.record(1, { status: 'busy' }, 2000);
    assert.equal(cache.wantsBackground(1, 2000, 'prefetch'), false);

    const budgeted = new PreviewCache();
    for (let index = 0; index < MAX_PREFETCHES; index++) {
      budgeted.record(index, frame(index * 5), 0, 'prefetch');
    }
    assert.equal(budgeted.wantsBackground(100, 0, 'prefetch'), false, 'the budget is spent');
    assert.equal(budgeted.wantsBackground(100, 0, 'storyboard'), true, 'its own budget');
    assert.equal(budgeted.wants(100, 0), true, 'hovers are not budgeted');
    for (let index = 100; index < 100 + STORYBOARD_FRAMES; index++) {
      budgeted.record(index, frame(index * 5), 0, 'storyboard');
    }
    assert.equal(budgeted.wantsBackground(200, 0, 'storyboard'), false);
    // Hovered frames don't count against either.
    const hovered = new PreviewCache();
    for (let index = 0; index < MAX_PREFETCHES; index++) hovered.record(index, frame(index * 5), 0);
    assert.equal(hovered.wantsBackground(100, 0, 'prefetch'), true);
  });
});

describe('PreviewCaches', () => {
  it('keeps the last few streams, the one used longest ago going first', () => {
    const caches = new PreviewCaches(2);
    const a = caches.get('a');
    a.record(1, frame(5), 0);
    assert.equal(caches.get('a'), a, 'the same again');
    const b = caches.get('b');
    assert.notEqual(b, a);
    caches.get('a');
    caches.get('c');
    assert.equal(caches.size, 2);
    assert.equal(caches.get('a'), a, 'used since b: kept');
    assert.notEqual(caches.get('b'), b, 'gone');
  });
});

/** A request whose answers the test hands out. */
function fakeRequest() {
  const calls: { position: number; kind: PreviewKind; resolve: (value: unknown) => void }[] = [];
  const request = (position: number, kind: PreviewKind) =>
    new Promise<unknown>((resolve) => calls.push({ position, kind, resolve }));
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
      let answers = 0;
      const cache = new PreviewCache();
      const { calls, request } = fakeRequest();
      const scheduler = new PreviewScheduler(
        cache,
        request,
        () => answers++,
        () => now,
      );
      scheduler.want({ index: 2, position: 22.5 });
      mock.timers.tick(HOVER_DELAY_MS);
      calls[0]?.resolve({ status: 'busy' });
      await settle();
      // Told, so the bar can stop showing a frame as on its way.
      assert.equal(answers, 1);
      assert.equal(scheduler.paused, true);
      now = BUSY_RETRY_MS;
      mock.timers.tick(BUSY_RETRY_MS);
      assert.equal(calls.length, 2);
      assert.equal(scheduler.paused, false);
      calls[1]?.resolve(frame(20));
      await settle();
      assert.ok(cache.get(2));
    } finally {
      mock.timers.reset();
    }
  });

  it('prefetches the cells either side once the pointer has rested on one it has', async () => {
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
      const neighbours = [
        { index: 3, position: 37.5 },
        { index: 1, position: 7.5 },
      ];
      scheduler.want({ index: 2, position: 22.5 }, neighbours);
      mock.timers.tick(HOVER_DELAY_MS);
      now = HOVER_DELAY_MS;
      calls[0]?.resolve(frame(20));
      await settle();
      assert.equal(calls.length, 1, 'not before the pointer has rested');

      now = PREFETCH_DELAY_MS;
      mock.timers.tick(PREFETCH_DELAY_MS - HOVER_DELAY_MS);
      assert.deepEqual(
        calls.map((call) => [call.position, call.kind]),
        [
          [22.5, 'hover'],
          [37.5, 'prefetch'],
        ],
      );
      // The other side follows straight away...
      calls[1]?.resolve(frame(35));
      await settle();
      assert.equal(calls[2]?.position, 7.5);
      assert.equal(calls[2]?.kind, 'prefetch');
      // ...and the pointer moving on to a prefetched cell finds it ready.
      calls[2]?.resolve(frame(5));
      await settle();
      assert.equal(calls.length, 3);
      scheduler.want({ index: 3, position: 37.5 }, [{ index: 4, position: 52.5 }]);
      mock.timers.tick(HOVER_DELAY_MS);
      assert.equal(calls.length, 3, 'already there');
      assert.deepEqual(cache.get(3), { image: IMAGE, position: 35 });
    } finally {
      mock.timers.reset();
    }
  });

  it('gives a hover priority over a prefetch, and lets a refused prefetch be', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let now = 0;
      const cache = new PreviewCache();
      cache.record(2, frame(20), 0);
      const { calls, request } = fakeRequest();
      const scheduler = new PreviewScheduler(
        cache,
        request,
        () => undefined,
        () => now,
      );
      scheduler.want({ index: 2, position: 22.5 }, [{ index: 3, position: 37.5 }]);
      now = PREFETCH_DELAY_MS;
      mock.timers.tick(PREFETCH_DELAY_MS);
      assert.equal(calls[0]?.kind, 'prefetch');
      // The pointer moves while the prefetch is made: its cell comes next.
      scheduler.want({ index: 9, position: 142.5 }, []);
      mock.timers.tick(HOVER_DELAY_MS);
      assert.equal(calls.length, 1, 'one at a time');
      calls[0]?.resolve({ status: 'busy' });
      await settle();
      assert.equal(calls[1]?.position, 142.5);
      assert.equal(calls[1]?.kind, 'hover');
      assert.equal(scheduler.paused, false, 'a prefetch refusal is not a hover one');
      calls[1]?.resolve(frame(140));
      await settle();
      // Resting here: nothing to prefetch, and the refused one is not retried.
      now += PREFETCH_DELAY_MS;
      mock.timers.tick(PREFETCH_DELAY_MS);
      assert.equal(calls.length, 2);
    } finally {
      mock.timers.reset();
    }
  });

  it('makes background cells while the pointer asks for nothing, hovers first', async () => {
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
      scheduler.background([
        { index: 10, position: 157.5, kind: 'prefetch' },
        { index: 3, position: 52.5, kind: 'storyboard' },
        { index: 20, position: 307.5, kind: 'storyboard' },
      ]);
      mock.timers.tick(BACKGROUND_DELAY_MS - 1);
      assert.equal(calls.length, 0, "the stream's first moments are the player's");
      mock.timers.tick(1);
      assert.deepEqual(
        calls.map((call) => [call.position, call.kind]),
        [[157.5, 'prefetch']],
      );
      // A hover while one is made comes next, then the background goes on.
      scheduler.want({ index: 7, position: 112.5 });
      mock.timers.tick(HOVER_DELAY_MS);
      assert.equal(calls.length, 1, 'one at a time');
      calls[0]?.resolve(frame(155));
      await settle();
      assert.deepEqual(calls[1] && [calls[1].position, calls[1].kind], [112.5, 'hover']);
      calls[1]?.resolve(frame(110));
      await settle();
      // Resting on the hovered cell: its neighbours would come first, but
      // there are none given; the storyboard goes on after the rest.
      assert.equal(calls.length, 2);
      now = PREFETCH_DELAY_MS;
      mock.timers.tick(PREFETCH_DELAY_MS);
      assert.deepEqual(calls[2] && [calls[2].position, calls[2].kind], [52.5, 'storyboard']);
      calls[2]?.resolve(frame(50));
      await settle();
      // The pointer leaving doesn't stop it.
      scheduler.want(null);
      mock.timers.tick(0);
      assert.deepEqual(calls[3] && [calls[3].position, calls[3].kind], [307.5, 'storyboard']);
      calls[3]?.resolve(frame(305));
      await settle();
      mock.timers.tick(BACKGROUND_DELAY_MS * 2);
      assert.equal(calls.length, 4, 'all made');
      assert.equal(cache.size, 4);
    } finally {
      mock.timers.reset();
    }
  });

  it('tries background cells again after busy a few times, then leaves them', async () => {
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
      scheduler.background([{ index: 3, position: 52.5, kind: 'storyboard' }]);
      mock.timers.tick(BACKGROUND_DELAY_MS);
      for (let attempt = 0; attempt <= MAX_BACKGROUND_RETRIES; attempt++) {
        assert.equal(calls.length, attempt + 1);
        calls[attempt]?.resolve({ status: 'busy' });
        await settle();
        now += BUSY_RETRY_MS;
        mock.timers.tick(BUSY_RETRY_MS);
      }
      assert.equal(calls.length, MAX_BACKGROUND_RETRIES + 1, 'given up');
      // A hover still asks, and is not held up by the background refusals.
      scheduler.want({ index: 9, position: 142.5 });
      mock.timers.tick(HOVER_DELAY_MS);
      assert.equal(calls.at(-1)?.kind, 'hover');
      // Stopping ends everything.
      scheduler.stop();
      calls.at(-1)?.resolve(frame(140));
      await settle();
      mock.timers.tick(BACKGROUND_DELAY_MS * 2);
      assert.equal(calls.length, MAX_BACKGROUND_RETRIES + 2);
    } finally {
      mock.timers.reset();
    }
  });

  it('warms the core at most once in a while, and not for a stream that cannot be previewed', async () => {
    let now = 0;
    let answers = 0;
    const cache = new PreviewCache();
    const { calls, request } = fakeRequest();
    const scheduler = new PreviewScheduler(
      cache,
      request,
      () => answers++,
      () => now,
    );
    // Opened where the first background cell is; its frame comes with it.
    scheduler.background([{ index: 122, position: 1837.5, kind: 'prefetch' }]);
    scheduler.warm();
    scheduler.warm();
    assert.deepEqual(
      calls.map((call) => [call.kind, call.position]),
      [['warm', 1837.5]],
    );
    calls[0]?.resolve(frame(1836));
    await settle();
    assert.deepEqual(cache.get(122), { image: IMAGE, position: 1836 });
    assert.equal(answers, 1);
    now = WARM_INTERVAL_MS;
    scheduler.warm();
    assert.equal(calls.length, 2);
    assert.equal(calls[1]?.position, 0, 'nothing left to seed: the start');
    calls[1]?.resolve({ status: 'warming' });
    await settle();
    assert.equal(answers, 1, 'nothing to show');
    cache.record(1, { status: 'unavailable' }, now);
    now += WARM_INTERVAL_MS;
    scheduler.warm();
    assert.equal(calls.length, 2);
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
