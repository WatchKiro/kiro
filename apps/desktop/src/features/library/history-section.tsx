import { Button, buttonVariants } from '@kiro/ui';
import { cx } from '@kiro/utils';
import {
  Check,
  ChevronDown,
  History,
  Play,
  RotateCcw,
  Search,
  SkipForward,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';

import {
  filterHistory,
  formatTimeLeft,
  formatWatchedAt,
  groupHistory,
  historyAction,
  type HistoryAction,
  type HistoryFilter,
} from '@/features/library/history-data';
import { entryPath, progressFraction, titleKey, videoLabel } from '@/features/library/library-data';
import { LibrarySection } from '@/features/library/library-section';
import { useLibraryStore } from '@/features/library/library-store';
import { titlePath } from '@/features/title/title-data';
import { useTitleArtwork } from '@/features/title/use-title-artwork';
import { useInView } from '@/hooks/use-in-view';
import { describeError, type HistoryEntry, type HistoryTitle } from '@/services/native';

/** Entries rendered at first, and added each time the end of the list nears. */
const PAGE_SIZE = 30;

const FILTERS: { value: HistoryFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'movie', label: 'Movies' },
  { value: 'series', label: 'TV Shows' },
];

const ACTION_ICONS: Record<HistoryAction['kind'], typeof Play> = {
  resume: Play,
  play: Play,
  next: SkipForward,
  again: RotateCcw,
};

/** Recently watched titles, grouped by when they were watched. */
export function WatchHistory() {
  const list = useLibraryStore((state) => state.history);
  const remove = useLibraryStore((state) => state.removeFromHistory);
  const clear = useLibraryStore((state) => state.clearHistory);
  const load = useLibraryStore((state) => state.load);
  const [error, setError] = useState<string | null>(null);
  /** Clearing asks for a second click. */
  const [confirming, setConfirming] = useState(false);
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [query, setQuery] = useState('');
  const [shownCount, setShownCount] = useState(PAGE_SIZE);

  const matching = useMemo(
    () => filterHistory(list.items, filter, query),
    [list.items, filter, query],
  );
  const shown = matching.slice(0, shownCount);
  const groups = groupHistory(shown);
  const more = matching.length > shown.length;

  const run = (action: Promise<void>) => {
    setError(null);
    action.catch((reason: unknown) => setError(describeError(reason)));
  };
  const refine = (update: () => void) => {
    update();
    setShownCount(PAGE_SIZE);
  };

  const action =
    list.items.length === 0 ? null : confirming ? (
      <div className="flex items-center gap-2">
        <span className="text-[13px] text-ink-400">Clear all history?</span>
        <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setConfirming(false);
            run(clear());
          }}
        >
          <Trash2 aria-hidden className="size-3.5" />
          Clear
        </Button>
      </div>
    ) : (
      <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
        Clear history
      </Button>
    );

  return (
    <LibrarySection
      title="History"
      list={list}
      error={error}
      action={action}
      onRetry={() => void load('history')}
      placeholder={<HistorySkeleton />}
    >
      {list.items.length === 0 ? (
        <HistoryEmpty />
      ) : (
        // Search and filters sit in a rail beside the list on wide windows.
        <div className="grid gap-x-10 gap-y-6 lg:grid-cols-[minmax(0,1fr)_16rem]">
          <Toolbar
            filter={filter}
            query={query}
            onFilter={(value) => refine(() => setFilter(value))}
            onQuery={(value) => refine(() => setQuery(value))}
          />
          <div className="min-w-0 space-y-8 lg:col-start-1 lg:row-start-1">
            {matching.length === 0 ? (
              <NoMatches
                query={query}
                onReset={() =>
                  refine(() => {
                    setFilter('all');
                    setQuery('');
                  })
                }
              />
            ) : (
              groups.map((group) => (
                <HistoryGroupList key={group.key} label={group.label}>
                  {group.items.map((item) => (
                    <HistoryCard
                      key={`${item.title.type}:${item.title.id}`}
                      item={item}
                      onRemove={() => run(remove(item.title.type, item.title.id))}
                    />
                  ))}
                </HistoryGroupList>
              ))
            )}
            {more && (
              <ShowMore
                key={shown.length}
                onShow={() => setShownCount((count) => count + PAGE_SIZE)}
              />
            )}
          </div>
        </div>
      )}
    </LibrarySection>
  );
}

/**
 * Shows the next page when it nears the viewport (remounted per page, so a
 * button still in view asks again), or when pressed.
 */
function ShowMore({ onShow }: { onShow: () => void }) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          onShow();
        }
      },
      { rootMargin: '100% 0px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, onShow]);

  return (
    <div ref={setElement} className="flex justify-center">
      <Button variant="ghost" size="sm" onClick={onShow}>
        Show more
      </Button>
    </div>
  );
}

function Toolbar({
  filter,
  query,
  onFilter,
  onQuery,
}: {
  filter: HistoryFilter;
  query: string;
  onFilter: (filter: HistoryFilter) => void;
  onQuery: (query: string) => void;
}) {
  const searchId = useId();

  return (
    <div className="flex flex-wrap items-center gap-3 lg:sticky lg:top-24 lg:col-start-2 lg:row-start-1 lg:flex-col lg:items-stretch lg:self-start">
      <div
        role="radiogroup"
        aria-label="Show"
        data-nav-group
        className="inline-flex gap-1 rounded-full bg-white/[0.05] p-1"
      >
        {FILTERS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={filter === option.value}
            onClick={() => onFilter(option.value)}
            className={cx(
              'flex-1 cursor-pointer rounded-full px-3.5 py-1.5 text-[13px] font-medium whitespace-nowrap transition-colors focus-visible:focus-ring',
              filter === option.value ? 'bg-accent text-white' : 'text-ink-300 hover:text-ink-50',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
      <div
        role="search"
        className="relative ml-auto w-full max-w-64 lg:order-first lg:ml-0 lg:max-w-none"
      >
        <label htmlFor={searchId} className="sr-only">
          Search history
        </label>
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-ink-400"
        />
        <input
          id={searchId}
          type="search"
          value={query}
          autoComplete="off"
          spellCheck={false}
          placeholder="Search history"
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query) {
              event.stopPropagation();
              onQuery('');
            }
          }}
          className="h-9 w-full rounded-full border border-white/10 bg-white/[0.03] pr-9 pl-10 text-sm text-ink-100 transition-colors placeholder:text-ink-500 focus:border-accent/50 focus:bg-white/[0.05] focus:outline-none [&::-webkit-search-cancel-button]:hidden"
        />
        {query && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => onQuery('')}
            className="absolute top-1/2 right-2 flex size-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full text-ink-400 hover:text-ink-50 focus-visible:focus-ring"
          >
            <X aria-hidden className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

function HistoryGroupList({ label, children }: { label: string; children: ReactNode }) {
  const headingId = useId();

  return (
    <section aria-labelledby={headingId}>
      <h3
        id={headingId}
        className="mb-2 text-xs font-semibold tracking-[0.08em] text-ink-400 uppercase"
      >
        {label}
      </h3>
      <ul className="-mx-3">{children}</ul>
    </section>
  );
}

/**
 * One title: its backdrop and logo (fetched when the card nears the
 * viewport), where it was left, and what to do next. A series shows its
 * latest episode and can list the others that were played.
 */
function HistoryCard({ item, onRemove }: { item: HistoryTitle; onRemove: () => void }) {
  const { title } = item;
  const [ref, near] = useInView<HTMLLIElement>({ once: true });
  const artwork = useTitleArtwork(title.type, title.id, near);
  const action = historyAction(item, artwork.seasons);
  const ActionIcon = ACTION_ICONS[action.kind];
  const [expanded, setExpanded] = useState(false);
  const episodesId = useId();
  const label = videoLabel(item.video);
  const otherEpisodes = title.type === 'series' && item.playedVideos > 1;

  return (
    // A group: Up and Down from its action reach the next card's action.
    <li
      ref={ref}
      data-nav-group
      className="rounded-2xl p-3 transition-colors focus-within:bg-white/[0.03] hover:bg-white/[0.03]"
    >
      <div className="flex items-center gap-5">
        <Link
          to={entryPath(item)}
          tabIndex={-1}
          aria-hidden
          className="group/art w-44 shrink-0 lg:w-56"
        >
          <Artwork
            name={title.name}
            poster={title.poster}
            background={artwork.background}
            logo={artwork.logo}
            progress={item.completed ? null : progressFraction(item)}
          />
        </Link>

        <div className="min-w-0 flex-1">
          <Link
            to={titlePath(title.type, title.id)}
            className="block truncate rounded text-[15px] font-semibold text-ink-50 hover:underline hover:decoration-white/30 hover:underline-offset-4 focus-visible:focus-ring"
          >
            {title.name}
          </Link>
          <p className="mt-1 truncate text-[13px] text-ink-300">
            {label ?? (title.type === 'movie' ? 'Movie' : null)}
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
            <Progress entry={item} />
            {otherEpisodes && (
              <button
                type="button"
                aria-expanded={expanded}
                aria-controls={episodesId}
                onClick={() => setExpanded((open) => !open)}
                className="inline-flex cursor-pointer items-center gap-1 rounded-full text-xs font-medium text-accent-strong hover:text-ink-50 focus-visible:focus-ring"
              >
                {item.playedVideos} episodes
                <ChevronDown
                  aria-hidden
                  className={cx('size-3.5 transition-transform', expanded && 'rotate-180')}
                />
              </button>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <time
            dateTime={new Date(item.updatedAt).toISOString()}
            className="mr-2 hidden text-xs text-ink-500 tabular-nums md:block"
          >
            {formatWatchedAt(item.updatedAt)}
          </time>
          <Link
            to={action.href}
            aria-label={`${action.label}: ${title.name}`}
            className={buttonVariants({ variant: 'secondary', size: 'sm' })}
          >
            <ActionIcon
              aria-hidden
              className={cx('size-3.5', action.kind !== 'again' && 'fill-current')}
            />
            {action.label}
          </Link>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Remove ${title.name} from history`}
            className="w-8 px-0"
            onClick={onRemove}
          >
            <X aria-hidden className="size-4" />
          </Button>
        </div>
      </div>
      {otherEpisodes && expanded && <PlayedEpisodes id={episodesId} entry={item} />}
    </li>
  );
}

function Artwork({
  name,
  poster,
  background,
  logo,
  progress,
}: {
  name: string;
  poster: string | null;
  background: string | undefined;
  logo: string | undefined;
  /** Watched fraction, or `null` when finished. */
  progress: number | null;
}) {
  /** Image URLs that failed to load. */
  const [failed, setFailed] = useState<string[]>([]);
  const image = [background, poster ?? undefined].find(
    (src): src is string => src !== undefined && !failed.includes(src),
  );
  const shownLogo = logo && !failed.includes(logo) ? logo : undefined;

  return (
    <div className="relative aspect-video overflow-hidden rounded-xl bg-ink-850 shadow-[0_0_0_1px_rgb(255_255_255/0.07)] transition duration-300 group-hover/art:shadow-[0_0_0_1px_rgb(255_255_255/0.22)]">
      {image && (
        <img
          src={image}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed((urls) => [...urls, image])}
          className={
            image === background
              ? 'size-full object-cover transition duration-500 ease-out-soft group-hover/art:scale-[1.04]'
              : 'size-full object-cover object-[center_20%] opacity-80 blur-[1px]'
          }
        />
      )}
      <div className="absolute inset-0 bg-linear-to-t from-black/75 via-black/10 to-transparent" />
      <div className="absolute inset-x-3 bottom-3">
        {shownLogo ? (
          <img
            src={shownLogo}
            alt=""
            decoding="async"
            referrerPolicy="no-referrer"
            onError={() => setFailed((urls) => [...urls, shownLogo])}
            className="max-h-8 max-w-[65%] object-contain object-left drop-shadow-[0_4px_16px_rgb(0_0_0/0.7)]"
          />
        ) : (
          <p className="truncate text-sm font-semibold text-ink-50 drop-shadow">{name}</p>
        )}
      </div>
      {progress !== null && progress > 0 && (
        <div className="absolute inset-x-0 bottom-0 h-1 bg-white/15">
          <div
            className="h-full bg-accent shadow-[0_0_12px_rgb(132_60_251/0.8)]"
            style={{ width: `${progress * 100}%` }}
          />
        </div>
      )}
    </div>
  );
}

/** "Watched", or a bar with the time left. */
function Progress({ entry }: { entry: HistoryEntry }) {
  if (entry.completed) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-ink-400">
        <Check aria-hidden className="size-3.5 text-accent-strong" />
        Watched
      </span>
    );
  }
  const fraction = progressFraction(entry);
  return (
    <span className="inline-flex items-center gap-2.5 text-xs text-ink-400 tabular-nums">
      <span
        role="progressbar"
        aria-label="Watched"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(fraction * 100)}
        className="h-1 w-20 overflow-hidden rounded-full bg-white/[0.1]"
      >
        <span className="block h-full bg-accent" style={{ width: `${fraction * 100}%` }} />
      </span>
      {formatTimeLeft(entry)}
    </span>
  );
}

/** The episodes of a series that were played, newest first. */
function PlayedEpisodes({ id, entry }: { id: string; entry: HistoryEntry }) {
  const { type, id: titleId } = entry.title;
  const state = useLibraryStore((library) => library.titles[titleKey(type, titleId)]);
  const loadTitle = useLibraryStore((library) => library.loadTitle);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let current = true;
    void loadTitle(type, titleId).then((loaded) => {
      if (current && !loaded) setFailed(true);
    });
    return () => {
      current = false;
    };
  }, [loadTitle, type, titleId]);

  return (
    <div id={id} className="mt-3 pl-[calc(11rem+1.25rem)] lg:pl-[calc(14rem+1.25rem)]">
      {state ? (
        <ul className="border-l border-white/[0.08]">
          {state.progress.map((episode) => (
            <li key={episode.video.id}>
              <Link
                to={entryPath(episode)}
                className="flex items-center gap-4 rounded-r-lg py-2 pr-3 pl-4 text-[13px] transition-colors hover:bg-white/[0.03] focus-visible:focus-ring"
              >
                <span className="min-w-0 flex-1 truncate text-ink-200">
                  {videoLabel(episode.video) ?? 'Episode'}
                </span>
                <Progress entry={episode} />
                <time
                  dateTime={new Date(episode.updatedAt).toISOString()}
                  className="w-24 text-right text-xs text-ink-500 tabular-nums"
                >
                  {formatWatchedAt(episode.updatedAt)}
                </time>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="py-2 text-[13px] text-ink-500">
          {failed ? 'Couldn’t load the episodes.' : 'Loading episodes…'}
        </p>
      )}
    </div>
  );
}

function HistoryEmpty() {
  return (
    <div className="relative flex flex-col items-center overflow-hidden rounded-card border border-white/[0.07] bg-white/[0.02] px-6 py-16 text-center">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-24 left-1/2 size-72 -translate-x-1/2 rounded-full bg-accent/15 blur-3xl"
      />
      <div className="relative flex size-12 items-center justify-center rounded-full border border-accent/30 bg-accent/10">
        <History aria-hidden className="size-5 text-accent-strong" />
      </div>
      <p className="relative mt-5 text-base font-semibold text-ink-50">Nothing watched yet</p>
      <p className="relative mt-1.5 max-w-sm text-sm text-ink-400">
        Films and episodes you play appear here, with where you left off.
      </p>
      <Link
        to="/"
        className={buttonVariants({ variant: 'secondary', size: 'sm', className: 'relative mt-6' })}
      >
        Browse Discover
      </Link>
    </div>
  );
}

function NoMatches({ query, onReset }: { query: string; onReset: () => void }) {
  return (
    <div className="flex flex-col items-center rounded-card border border-dashed border-white/[0.1] px-6 py-12 text-center">
      <Search aria-hidden className="size-5 text-ink-500" />
      <p className="mt-3 text-sm text-ink-300">
        {query.trim() ? `Nothing in your history matches “${query.trim()}”.` : 'Nothing here yet.'}
      </p>
      <Button variant="ghost" size="sm" className="mt-3" onClick={onReset}>
        Show all history
      </Button>
    </div>
  );
}

function HistorySkeleton() {
  return (
    <div aria-hidden className="space-y-2">
      <div className="mb-6 h-9 w-64 animate-pulse rounded-full bg-white/[0.04]" />
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex items-center gap-5 py-3">
          <div className="aspect-video w-44 animate-pulse rounded-xl bg-white/[0.04] lg:w-56" />
          <div className="flex-1 space-y-2.5">
            <div className="h-3.5 w-48 animate-pulse rounded bg-white/[0.05]" />
            <div className="h-3 w-32 animate-pulse rounded bg-white/[0.04]" />
            <div className="h-1 w-20 animate-pulse rounded bg-white/[0.04]" />
          </div>
        </div>
      ))}
    </div>
  );
}
