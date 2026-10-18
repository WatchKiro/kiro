import { captionCss, subtitleStyle } from '@/features/playback/subtitle-appearance';
import type { SubtitleSettings } from '@/services/native';

/** The swatch's height: subtitles scale with the picture's height, as in the player. */
const HEIGHT = 216;

/**
 * A live preview of the subtitle look over a bright, busy picture, where a
 * weak edge shows. An approximation of the player's rendering.
 */
export function SubtitlePreview({ subtitles }: { subtitles: SubtitleSettings }) {
  return (
    <figure className="px-5 pt-4">
      <div
        style={{ height: HEIGHT }}
        className="relative overflow-hidden rounded-xl bg-[linear-gradient(180deg,#9cc3e4_0%,#e9dcc2_48%,#c9a77a_62%,#5c4a36_100%)] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]"
      >
        <div
          aria-hidden
          className="absolute inset-x-0 top-[38%] h-24 bg-[radial-gradient(ellipse_at_30%_100%,#fff7e0_0%,transparent_60%)]"
        />
        <p style={captionCss(subtitleStyle(subtitles), HEIGHT)}>
          {'This is how subtitles will look.\nThe second line sits here.'}
        </p>
      </div>
      <figcaption className="mt-2 text-xs text-ink-500">
        Preview. Styled subtitles (common in anime) keep their own look, apart from the size.
      </figcaption>
    </figure>
  );
}
