import { Button } from '@kiro/ui';
import { Check, CircleCheck } from 'lucide-react';
import { useState } from 'react';

import { useLibraryStore } from '@/features/library/library-store';
import { isWatched } from '@/features/library/watched-data';
import { movieMedia } from '@/features/title/title-data';
import { describeError, type HistoryEntry, type LibraryTitle } from '@/services/native';

/**
 * Marks a film watched, or (pressed again) unwatched, which forgets its
 * progress. `progress` is the film's saved progress; `ready` once it's read.
 */
export function WatchedButton({
  title,
  progress,
  ready,
}: {
  title: LibraryTitle;
  progress: HistoryEntry[];
  ready: boolean;
}) {
  const markWatched = useLibraryStore((store) => store.markWatched);
  const markUnwatched = useLibraryStore((store) => store.markUnwatched);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const watched = isWatched(progress, title.id);

  async function toggle() {
    setPending(true);
    setError(null);
    try {
      await (watched
        ? markUnwatched(title, [title.id])
        : markWatched(title, [movieMedia(title).video]));
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setPending(false);
    }
  }

  const Icon = watched ? CircleCheck : Check;
  return (
    <div className="flex items-center gap-3">
      <Button
        variant="secondary"
        size="lg"
        aria-pressed={watched}
        title={watched ? 'Mark as unwatched' : undefined}
        disabled={!ready || pending}
        onClick={() => void toggle()}
      >
        <Icon aria-hidden className={watched ? 'size-5 text-accent-strong' : 'size-5'} />
        {watched ? 'Watched' : 'Mark as watched'}
      </Button>
      {error && (
        <p aria-live="polite" className="text-[13px] text-rose-300">
          {error}
        </p>
      )}
    </div>
  );
}
