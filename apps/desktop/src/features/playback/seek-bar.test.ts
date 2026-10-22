import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bufferedAhead, dragStep, type DragState } from '@/features/playback/seek-bar';

describe('bufferedAhead', () => {
  it('draws what is buffered ahead of the position, clipped to the video', () => {
    const buffered = [
      { start: 0, end: 12 },
      { start: 100, end: 160 },
      { start: 2800, end: 2900 },
    ];
    assert.deepEqual(bufferedAhead(buffered, 5, 2853), [
      { start: 5, end: 12 },
      { start: 100, end: 160 },
      { start: 2800, end: 2853 },
    ]);
  });

  it('leaves out what is behind the position, or too small to see', () => {
    assert.deepEqual(bufferedAhead([{ start: 0, end: 12 }], 12, 2853), []);
    assert.deepEqual(bufferedAhead([{ start: 0, end: 12 }], 11.8, 2853), []);
    assert.deepEqual(bufferedAhead([{ start: 0, end: 12.5 }], 12, 2853), [
      { start: 12, end: 12.5 },
    ]);
    assert.deepEqual(bufferedAhead([], 0, 2853), []);
  });
});

describe('dragStep', () => {
  it('follows the pointer and seeks once, on release', () => {
    let drag: DragState = { position: null };
    for (const position of [10, 20, 30]) {
      const next = dragStep(drag, { type: 'move', position });
      assert.equal(next.seek, null);
      drag = next.drag;
      assert.equal(drag.position, position);
    }
    const released = dragStep(drag, { type: 'release' });
    assert.deepEqual(released, { drag: { position: null }, seek: 30 });
  });

  it('seeks nowhere when cancelled, or released without moving', () => {
    assert.deepEqual(dragStep({ position: 30 }, { type: 'cancel' }), {
      drag: { position: null },
      seek: null,
    });
    assert.deepEqual(dragStep({ position: null }, { type: 'release' }), {
      drag: { position: null },
      seek: null,
    });
  });
});
