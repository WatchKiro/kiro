/**
 * How subtitles look (Settings → Subtitles): the style sent to the native
 * player, and a CSS approximation of mpv's rendering for previews (the
 * Settings swatch and the browser preview's fake player).
 */
import type { CSSProperties } from 'react';

import type { SubtitleSettings } from '@/services/native';
import type { SubtitleStyle } from '@/services/player';

/** The look part of the subtitle settings, as `player_set_subtitle_style` takes it. */
export function subtitleStyle({ size, color, edge, offset }: SubtitleSettings): SubtitleStyle {
  return { size, color, edge, offset };
}

/**
 * mpv's defaults, in its 720-line coordinate space: `sub-font-size` and
 * `sub-margin-y`. Both scale with the picture's height.
 */
const FONT_SIZE = 38;
const MARGIN_Y = 22;
const LINES = 720;

/**
 * CSS for a caption over a picture `height` pixels tall, matching
 * `SubtitleStyle::mpv_properties` in `src-tauri/src/media/mod.rs` closely
 * enough to judge size, colour, edge and position. Place the caption
 * absolutely within the picture, centred horizontally.
 */
export function captionCss(style: SubtitleStyle, height: number): CSSProperties {
  const unit = height / LINES;
  const fontSize = FONT_SIZE * unit * (style.size / 100);
  // mpv sizes edges relative to the font, so they grow with it.
  const edgeUnit = fontSize / FONT_SIZE;
  const base: CSSProperties = {
    position: 'absolute',
    left: '50%',
    transform: 'translateX(-50%)',
    bottom: `${style.offset + (MARGIN_Y / LINES) * 100}%`,
    // Centred from the left edge, it would otherwise wrap at half the width.
    width: 'max-content',
    maxWidth: '90%',
    textAlign: 'center',
    fontSize: `${fontSize}px`,
    lineHeight: 1.2,
    color: style.color,
    whiteSpace: 'pre-line',
  };
  switch (style.edge) {
    case 'outline':
      return {
        ...base,
        WebkitTextStroke: `${2.5 * 2 * edgeUnit}px #000`,
        paintOrder: 'stroke fill',
      };
    case 'shadow':
      return {
        ...base,
        WebkitTextStroke: `${0.6 * 2 * edgeUnit}px #000`,
        paintOrder: 'stroke fill',
        textShadow: `${2.5 * edgeUnit}px ${2.5 * edgeUnit}px 0 rgb(0 0 0 / 0.75)`,
      };
    case 'background':
      return {
        ...base,
        background: 'rgb(0 0 0 / 0.7)',
        padding: `${3 * edgeUnit}px ${6 * edgeUnit}px`,
        boxDecorationBreak: 'clone',
        WebkitBoxDecorationBreak: 'clone',
      };
  }
}
