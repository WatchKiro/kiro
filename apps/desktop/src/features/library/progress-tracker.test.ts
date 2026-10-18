import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ProgressTracker,
  SAVE_INTERVAL_MS,
  SEEK_GRACE_MS,
} from '@/features/library/progress-tracker';

const playing = (position: number, paused = false) => ({
  idle: false,
  paused,
  position,
  duration: 1000,
});
const idle = { idle: true, paused: false, position: null, duration: null };

describe('ProgressTracker', () => {
  it('saves periodically once past the first seconds, and on pause', () => {
    const tracker = new ProgressTracker();
    assert.equal(tracker.next(playing(2), 0), null, 'too early to be worth saving');
    assert.deepEqual(tracker.next(playing(6), 100), { position: 6, duration: 1000 });
    assert.equal(tracker.next(playing(8), 2_000), null, 'saved recently');
    assert.deepEqual(tracker.next(playing(9, true), 3_000), { position: 9, duration: 1000 });
    assert.equal(tracker.next(playing(9, true), 20_000), null, 'paused, nothing moved');
    assert.deepEqual(tracker.next(playing(30), 20_000 + SAVE_INTERVAL_MS), {
      position: 30,
      duration: 1000,
    });
  });

  it('saves the end as finished when playback stops near it', () => {
    const tracker = new ProgressTracker();
    tracker.next(playing(980), 0);
    assert.deepEqual(tracker.next(idle, 1_000), { position: 1000, duration: 1000 });
    assert.equal(tracker.next(idle, 2_000), null, 'only once');
    assert.equal(tracker.flush(3_000), null);
  });

  it('keeps the position when playback stops early (an error)', () => {
    const tracker = new ProgressTracker();
    tracker.next(playing(400), 0);
    assert.deepEqual(tracker.next(idle, 1_000), { position: 400, duration: 1000 });
  });

  it('flushes unsaved progress when the player is left', () => {
    const tracker = new ProgressTracker();
    assert.equal(tracker.flush(0), null, 'nothing played');
    tracker.next(playing(3), 0);
    assert.equal(tracker.flush(0), null, 'too early to be worth saving');
    tracker.next(playing(50), 0);
    tracker.next(playing(52), 1_000);
    assert.deepEqual(tracker.flush(2_000), { position: 52, duration: 1000 });
    assert.equal(tracker.flush(3_000), null, 'already saved');
  });

  it('ignores samples from before an expected seek lands', () => {
    const tracker = new ProgressTracker();
    tracker.expectSeek(900, 0);
    assert.equal(tracker.next(playing(12), 100), null, 'still at the old position');
    assert.equal(tracker.flush(200), null, 'nothing from before the seek is flushed');
    assert.deepEqual(tracker.next(playing(901), 300), { position: 901, duration: 1000 });

    // A seek that never shows up stops blocking after the grace period.
    const stuck = new ProgressTracker();
    stuck.expectSeek(500, 0);
    assert.equal(stuck.next(playing(40), SEEK_GRACE_MS - 1), null);
    assert.deepEqual(stuck.next(playing(40), SEEK_GRACE_MS), {
      position: 40,
      duration: 1000,
    });
  });
});
