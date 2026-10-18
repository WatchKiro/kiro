import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { captionCss, subtitleStyle } from '@/features/playback/subtitle-appearance';
import { DEFAULT_SUBTITLE_SETTINGS } from '@/features/settings/settings-data';

describe('subtitle appearance', () => {
  it('sends only the look to the player', () => {
    assert.deepEqual(subtitleStyle({ ...DEFAULT_SUBTITLE_SETTINGS, preferredType: 'sdh' }), {
      size: 100,
      color: '#ffffff',
      edge: 'outline',
      offset: 0,
    });
  });

  it('scales with the picture and the size, and raises by the offset', () => {
    const style = subtitleStyle(DEFAULT_SUBTITLE_SETTINGS);
    // mpv's 38-point default on a 720-line picture.
    assert.equal(captionCss(style, 720).fontSize, '38px');
    assert.equal(captionCss({ ...style, size: 150 }, 360).fontSize, '28.5px');
    const raised = Number.parseFloat(String(captionCss({ ...style, offset: 20 }, 720).bottom));
    const usual = Number.parseFloat(String(captionCss(style, 720).bottom));
    assert.ok(Math.abs(raised - usual - 20) < 1e-9);
  });

  it('draws each edge differently', () => {
    const style = subtitleStyle(DEFAULT_SUBTITLE_SETTINGS);
    assert.ok(captionCss(style, 720).WebkitTextStroke);
    assert.ok(captionCss({ ...style, edge: 'shadow' }, 720).textShadow);
    assert.ok(captionCss({ ...style, edge: 'background' }, 720).background);
  });
});
