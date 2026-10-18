import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_AUDIO_DELAY,
  MAX_SUBTITLE_DELAY,
  NO_TIMING,
  clampSpeed,
  describeDelay,
  formatDelay,
  formatSpeed,
  rememberSpeed,
  rememberedSpeed,
  stepDelay,
  stepSpeed,
  subtitleDelayFor,
  timingNotice,
  withSubtitleDelay,
} from '@/features/playback/timing';

describe('stepDelay', () => {
  it('moves in tenths without drifting', () => {
    let delay = 0;
    for (let i = 0; i < 3; i += 1) delay = stepDelay('subtitle', delay, 0.1);
    assert.equal(delay, 0.3);
    assert.equal(stepDelay('subtitle', 0.3, -0.1), 0.2);
    assert.equal(stepDelay('audio', 0.1, -0.1), 0);
    assert.ok(Object.is(stepDelay('audio', 0.1, -0.1), 0), 'no negative zero');
  });

  it('stays within what the player accepts', () => {
    assert.equal(stepDelay('subtitle', MAX_SUBTITLE_DELAY, 0.1), MAX_SUBTITLE_DELAY);
    assert.equal(stepDelay('subtitle', -59.95, -0.1), -MAX_SUBTITLE_DELAY);
    assert.equal(stepDelay('audio', 9.95, 0.1), MAX_AUDIO_DELAY);
    assert.equal(stepDelay('audio', -MAX_AUDIO_DELAY, -0.1), -MAX_AUDIO_DELAY);
  });
});

describe('stepSpeed', () => {
  it('steps through the presets', () => {
    assert.equal(stepSpeed(1, 1), 1.25);
    assert.equal(stepSpeed(1.25, 1), 1.5);
    assert.equal(stepSpeed(1, -1), 0.75);
    assert.equal(stepSpeed(0.75, -1), 0.5);
  });

  it('stays put at the ends', () => {
    assert.equal(stepSpeed(2, 1), 2);
    assert.equal(stepSpeed(0.5, -1), 0.5);
  });

  it('moves a speed between presets to the nearest one that way', () => {
    assert.equal(stepSpeed(1.1, 1), 1.25);
    assert.equal(stepSpeed(1.1, -1), 1);
    assert.equal(stepSpeed(3, -1), 2);
    assert.equal(stepSpeed(0.3, 1), 0.5);
  });

  it('clamps to the player’s range', () => {
    assert.equal(clampSpeed(0), 0.25);
    assert.equal(clampSpeed(10), 4);
    assert.equal(clampSpeed(1.5), 1.5);
  });
});

describe('formatting', () => {
  it('formats delays with a sign', () => {
    assert.equal(formatDelay(0), '0.0 s');
    assert.equal(formatDelay(0.1 + 0.2), '+0.3 s');
    assert.equal(formatDelay(-1), '−1.0 s');
    assert.equal(formatDelay(-0.25), '−0.25 s');
    assert.equal(formatDelay(12.5), '+12.5 s');
  });

  it('formats speeds', () => {
    assert.equal(formatSpeed(1), '1×');
    assert.equal(formatSpeed(1.25), '1.25×');
    assert.equal(formatSpeed(0.5), '0.5×');
  });

  it('says which way a delay goes', () => {
    assert.equal(describeDelay('subtitle', 0.3), 'Subtitles show 0.3 s later');
    assert.equal(describeDelay('subtitle', -1.2), 'Subtitles show 1.2 s earlier');
    assert.equal(describeDelay('subtitle', 0), 'Shown as the file times them');
    assert.equal(describeDelay('audio', 0.2), 'Audio plays 0.2 s later');
    assert.equal(describeDelay('audio', 0), 'Not shifted');
  });

  it('words the on-screen notice', () => {
    assert.equal(timingNotice({ kind: 'subtitle', seconds: 0.3 }), 'Subtitles +0.3 s');
    assert.equal(timingNotice({ kind: 'audio', seconds: -0.2 }), 'Audio −0.2 s');
    assert.equal(timingNotice({ kind: 'speed', speed: 1.5 }), 'Speed 1.5×');
  });
});

describe('StreamTiming', () => {
  it('remembers a subtitle delay per track', () => {
    let timing = withSubtitleDelay(NO_TIMING, '3', 0.1 + 0.2);
    timing = withSubtitleDelay(timing, '5', -1);
    assert.equal(subtitleDelayFor(timing, '3'), 0.3);
    assert.equal(subtitleDelayFor(timing, '5'), -1);
    assert.equal(subtitleDelayFor(timing, '7'), 0, 'a track not changed has none');
    assert.equal(subtitleDelayFor(timing, null), 0, 'subtitles off');
    assert.deepEqual(NO_TIMING.subtitleDelays, {}, 'the starting value is not changed');
  });

  it('keeps the speed for the rest of the run', () => {
    const before = rememberedSpeed();
    rememberSpeed(1.5);
    assert.equal(rememberedSpeed(), 1.5);
    rememberSpeed(9);
    assert.equal(rememberedSpeed(), 4);
    rememberSpeed(before);
  });
});
