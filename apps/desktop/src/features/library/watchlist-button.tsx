import { Button } from '@kiro/ui';
import { BookmarkCheck, BookmarkPlus } from 'lucide-react';
import { useEffect, useState } from 'react';

import { titleKey } from '@/features/library/library-data';
import { useLibraryStore } from '@/features/library/library-store';
import { describeError, type LibraryTitle } from '@/services/native';

/**
 * Adds a title to, or removes it from, the watchlist. `compact` is a round
 * icon button, for a hero beside Play.
 */
export function WatchlistButton({
  title,
  compact = false,
}: {
  title: LibraryTitle;
  compact?: boolean;
}) {
  const state = useLibraryStore((store) => store.titles[titleKey(title.type, title.id)]);
  const loadTitle = useLibraryStore((store) => store.loadTitle);
  const add = useLibraryStore((store) => store.addToWatchlist);
  const remove = useLibraryStore((store) => store.removeFromWatchlist);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadTitle(title.type, title.id);
  }, [title.type, title.id, loadTitle]);

  const inWatchlist = state?.inWatchlist ?? false;

  async function toggle() {
    setPending(true);
    setError(null);
    try {
      await (inWatchlist ? remove(title.type, title.id) : add(title));
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setPending(false);
    }
  }

  const label = inWatchlist ? 'In watchlist' : 'Add to watchlist';
  const Icon = inWatchlist ? BookmarkCheck : BookmarkPlus;

  return (
    <div className="flex items-center gap-3">
      <Button
        variant="secondary"
        size="lg"
        aria-pressed={inWatchlist}
        aria-label={compact ? label : undefined}
        title={compact ? label : undefined}
        disabled={!state || pending}
        onClick={() => void toggle()}
        className={compact ? 'w-12 px-0!' : undefined}
      >
        <Icon aria-hidden className={inWatchlist ? 'size-5 text-accent-strong' : 'size-5'} />
        {!compact && label}
      </Button>
      <p aria-live="polite" className="text-[13px] text-rose-300">
        {error}
      </p>
    </div>
  );
}
