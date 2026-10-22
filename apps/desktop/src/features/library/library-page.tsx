import { Library, Bookmark, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';

import { CardMenu } from '@/components/action-menu';
import { Page, PageMessage } from '@/components/page';
import { useAddonsStore } from '@/features/addons/addons-store';
import { WatchHistory } from '@/features/library/history-section';
import { LibraryEmpty, LibrarySection } from '@/features/library/library-section';
import { LibraryPoster } from '@/features/library/library-poster';
import { useLibraryStore } from '@/features/library/library-store';
import { filmActions, useWatchedFilm } from '@/features/library/watch-actions';
import { titlePath } from '@/features/title/title-data';
import { describeError, isNativeRuntime, type WatchlistItem } from '@/services/native';

/** The watchlist and watch history, stored on this device. */
export function LibraryPage() {
  const native = isNativeRuntime();
  const load = useLibraryStore((state) => state.load);
  // History cards show artwork from the installed addons.
  const loadAddons = useAddonsStore((state) => state.load);

  useEffect(() => {
    if (!native) return;
    void load('watchlist');
    void load('history');
    void loadAddons();
  }, [native, load, loadAddons]);

  if (!native) {
    return (
      <PageMessage
        icon={<Library aria-hidden className="size-5" />}
        title="Your library is only available inside the desktop app."
      />
    );
  }

  return (
    <Page title="Library" description="Your watchlist and history, kept on this device.">
      <div className="space-y-14">
        <Watchlist />
        <WatchHistory />
      </div>
    </Page>
  );
}

function Watchlist() {
  const list = useLibraryStore((state) => state.watchlist);
  const remove = useLibraryStore((state) => state.removeFromWatchlist);
  const load = useLibraryStore((state) => state.load);
  const [error, setError] = useState<string | null>(null);

  const onRemove = (item: WatchlistItem) => {
    setError(null);
    remove(item.title.type, item.title.id).catch((reason: unknown) =>
      setError(describeError(reason)),
    );
  };

  return (
    <LibrarySection
      title="Watchlist"
      list={list}
      error={error}
      onRetry={() => void load('watchlist')}
    >
      {list.items.length === 0 ? (
        <LibraryEmpty icon={Bookmark}>
          Titles you add with <span className="text-ink-200">Add to watchlist</span> appear here.
        </LibraryEmpty>
      ) : (
        <ul
          data-nav-group
          className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-x-5 gap-y-8"
        >
          {list.items.map((item) => (
            <WatchlistCard
              key={`${item.title.type}:${item.title.id}`}
              item={item}
              onRemove={() => onRemove(item)}
            />
          ))}
        </ul>
      )}
    </LibrarySection>
  );
}

/** A watchlist poster: a film shows a tick once watched and can be marked from its menu. */
function WatchlistCard({ item, onRemove }: { item: WatchlistItem; onRemove: () => void }) {
  const watched = useWatchedFilm(item.title.type, item.title.id);

  return (
    <li className="group relative">
      <CardMenu
        label={item.title.name}
        actions={filmActions(item.title, watched)}
        buttonClassName="top-2 right-11"
      >
        <Link
          to={titlePath(item.title.type, item.title.id)}
          title={item.title.name}
          className="group/poster block rounded-xl outline-none"
        >
          <LibraryPoster
            title={item.title}
            watched={watched}
            className="transition duration-300 ease-out-soft group-hover:border-white/[0.22] group-focus-visible/poster:focus-lift"
          />
          <p className="mt-2.5 truncate px-0.5 text-[13px] font-medium text-ink-100">
            {item.title.name}
          </p>
        </Link>
      </CardMenu>
      <button
        type="button"
        aria-label={`Remove ${item.title.name} from watchlist`}
        onClick={onRemove}
        className="absolute top-2 right-2 flex size-8 cursor-pointer items-center justify-center rounded-full bg-black/70 text-ink-200 opacity-0 backdrop-blur transition group-focus-within:opacity-100 group-hover:opacity-100 hover:text-ink-50 focus-visible:opacity-100 focus-visible:focus-ring"
      >
        <X aria-hidden className="size-3.5" />
      </button>
    </li>
  );
}
