import { Button } from '@kiro/ui';
import { cx } from '@kiro/utils';
import { Loader2, Play } from 'lucide-react';
import { useState, type CSSProperties } from 'react';

import { displayableImage } from '@/features/addons/catalog';
import type { UpNext } from '@/features/playback/use-up-next';

/**
 * "Up next" near the end of an episode: the next one's still and name, a
 * countdown on the Play button (unless autoplay is off), and Cancel.
 */
export function UpNextCard({ upNext, className }: { upNext: UpNext; className?: string }) {
  const { video, label, secondsLeft, countdown, autoplay, paused, starting, playNow, cancel } =
    upNext;
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const thumbnail = thumbnailFailed ? undefined : displayableImage(video.thumbnail);
  const progress = 1 - secondsLeft / countdown;

  return (
    <section
      aria-label="Up next"
      data-nav-group
      className={cx(
        'flex w-[22rem] animate-[kiro-fade-in_300ms_ease-out] flex-col overflow-hidden rounded-card border border-white/10 bg-ink-900/90 shadow-2xl shadow-black/60 backdrop-blur-xl',
        className,
      )}
    >
      {thumbnail && (
        <img
          src={thumbnail}
          alt=""
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setThumbnailFailed(true)}
          className="aspect-video w-full object-cover"
        />
      )}
      <div className="space-y-3 p-4">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold tracking-[0.12em] text-accent-strong uppercase">
            Up next
          </p>
          <p className="mt-0.5 line-clamp-2 text-[15px] leading-snug font-semibold text-ink-50">
            {label}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={playNow}
            disabled={starting}
            className="relative flex-1 overflow-hidden"
          >
            {/* The countdown fills the button. */}
            {!starting && autoplay && (
              <span
                aria-hidden
                style={{ '--fill': `${progress * 100}%` } as CSSProperties}
                className="absolute inset-y-0 left-0 w-(--fill) bg-accent/25 transition-[width] duration-1000 ease-linear"
              />
            )}
            <span className="relative flex items-center gap-1.5">
              {starting ? (
                <>
                  <Loader2 aria-hidden className="size-3.5 animate-spin" />
                  Finding stream…
                </>
              ) : (
                <>
                  <Play aria-hidden className="size-3.5 fill-current" />
                  {paused || !autoplay ? 'Play now' : `Playing in ${secondsLeft}`}
                </>
              )}
            </span>
          </Button>
          {!starting && (
            <Button variant="ghost" size="sm" onClick={cancel}>
              Cancel
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
