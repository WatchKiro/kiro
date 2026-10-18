import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { clamp, cx, formatDuration } from './index';

describe('cx', () => {
  it('joins truthy class names', () => {
    assert.equal(cx('a', false, undefined, 'b', null, ''), 'a b');
  });
});

describe('clamp', () => {
  it('restricts values to the range', () => {
    assert.equal(clamp(5, 0, 1), 1);
    assert.equal(clamp(-1, 0, 1), 0);
    assert.equal(clamp(0.5, 0, 1), 0.5);
    assert.equal(clamp(Number.NaN, 0, 1), 0);
  });

  it('rejects an inverted range', () => {
    assert.throws(() => clamp(1, 2, 1), RangeError);
  });
});

describe('formatDuration', () => {
  it('formats minutes and hours', () => {
    assert.equal(formatDuration(0), '0:00');
    assert.equal(formatDuration(65), '1:05');
    assert.equal(formatDuration(3723), '1:02:03');
  });

  it('treats invalid input as zero', () => {
    assert.equal(formatDuration(-10), '0:00');
    assert.equal(formatDuration(Number.POSITIVE_INFINITY), '0:00');
  });
});
