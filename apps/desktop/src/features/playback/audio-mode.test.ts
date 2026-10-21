import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeAudio } from '@/features/playback/audio-mode';

describe('describeAudio', () => {
  it('says when the soundtrack goes to the receiver untouched', () => {
    assert.equal(
      describeAudio({ audioCodec: 'eac3', audioMode: 'passthrough eac3', audioOutput: 'wasapi' }),
      'passthrough eac3 · wasapi',
    );
    assert.equal(
      describeAudio({
        audioCodec: 'dts',
        audioMode: 'passthrough dts',
        audioOutput: 'coreaudio_exclusive',
      }),
      'passthrough dts · coreaudio_exclusive',
    );
  });

  it('names the codec of a decoded soundtrack', () => {
    assert.equal(
      describeAudio({ audioCodec: 'ac3', audioMode: 'decoded', audioOutput: 'coreaudio' }),
      'decoded ac3 · coreaudio',
    );
    assert.equal(
      describeAudio({ audioCodec: null, audioMode: 'decoded', audioOutput: null }),
      'decoded',
    );
  });

  it('shows nothing without audio', () => {
    assert.equal(describeAudio(null), '—');
    assert.equal(describeAudio({ audioCodec: 'aac', audioMode: null, audioOutput: null }), '—');
  });
});
