import { cx } from '@kiro/utils';
import { useState } from 'react';

import type { LibraryTitle } from '@/services/native';

/**
 * A title's saved poster (2:3), or its name when there is none. `progress`
 * (0–1) draws a watched bar along the bottom.
 */
export function LibraryPoster({
  title,
  progress,
  className,
}: {
  title: LibraryTitle;
  progress?: number;
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
    </div>
  );
}
