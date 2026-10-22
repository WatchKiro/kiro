import { cx } from '@kiro/utils';
import { Check } from 'lucide-react';
import { useState } from 'react';

import type { LibraryTitle } from '@/services/native';

/**
 * A title's saved poster (2:3), or its name when there is none. `progress`
 * (0–1) draws a watched bar along the bottom; `watched` a tick.
 */
export function LibraryPoster({
  title,
  progress,
  watched = false,
  className,
}: {
  title: LibraryTitle;
  progress?: number;
  watched?: boolean;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  return (
    <div
      className={cx(
        'relative aspect-[2/3] overflow-hidden rounded-xl border border-white/[0.06] bg-linear-to-b from-white/[0.06] to-white/[0.02]',
        className,
      )}
    >
      {title.poster && !failed ? (
        <img
          src={title.poster}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className="size-full object-cover"
        />
      ) : (
        <span className="absolute inset-0 flex items-center justify-center p-2 text-center text-xs font-medium text-ink-300">
          {title.name}
        </span>
      )}
      {progress !== undefined && (
        <div aria-hidden className="absolute inset-x-0 bottom-0 h-1 bg-black/60">
          <div className="h-full bg-accent" style={{ width: `${progress * 100}%` }} />
        </div>
      )}
      {watched && <WatchedTick />}
    </div>
  );
}
/** The corner tick on a watched film's artwork. */
export function WatchedTick() {
  return (
    <span
      role="img"
      aria-label="Watched"
      className="absolute top-2 left-2 flex size-6 items-center justify-center rounded-full bg-accent text-white shadow-[0_2px_10px_rgb(0_0_0/0.5)]"
    >
      <Check aria-hidden className="size-3.5" strokeWidth={3} />
    </span>
  );
}
