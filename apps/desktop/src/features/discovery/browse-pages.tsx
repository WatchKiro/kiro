import { Button, buttonVariants } from '@kiro/ui';
import { cx } from '@kiro/utils';
import { EyeOff, Film, Puzzle, SlidersHorizontal, Tv, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';

import { contentTypeIcon } from '@/app/navigation';
import { Page, PageMessage } from '@/components/page';
import { ScrollStrip } from '@/components/scroll-strip';
import { useAddonsStore } from '@/features/addons/addons-store';
import {
  browsePath,
  browseSources,
  effectiveGenre,
  feedKey,
  filterLabel,
  findSource,
  genreFilter,
  MOVIES,
  sectionFor,
  sourceLabel,
  sourceParam,
  TV_SHOWS,
  type BrowseSection,
  type BrowseSource,
  type GenreFilter,
} from '@/features/discovery/browse-data';
import { useBrowseStore, type Feed } from '@/features/discovery/browse-store';
import { CatalogRow, InlineError } from '@/features/discovery/catalog-row';
import { PosterGrid, PosterGridSkeleton } from '@/features/discovery/poster-grid';
import { RowEditor } from '@/features/discovery/row-editor';
import type { LaidOutRow } from '@/features/discovery/row-layout';
import { useRowLayout } from '@/features/discovery/use-row-layout';
import { useInView } from '@/hooks/use-in-view';
import { isNativeRuntime } from '@/services/native';

export function MoviesPage() {
  return <BrowsePage section={MOVIES} icon={Film} />;
}

export function TvShowsPage() {
  return <BrowsePage section={TV_SHOWS} icon={Tv} />;
}

/** Any other content type an addon lists catalogues of (`/browse/anime`). */
export function TypeBrowsePage() {
  const { type = '' } = useParams();
  const section = useMemo(() => sectionFor(type), [type]);
  return <BrowsePage key={type} section={section} icon={contentTypeIcon(type)} />;
}

/** Filters with more options than this are a menu instead of chips. */
const MAX_GENRE_CHIPS = 24;

interface BrowsePageProps {
  section: BrowseSection;
  icon: LucideIcon;
}

/**
 * Every installed catalogue of one content type. Without `?catalog=` the
 * page shows a row per catalogue; with it, that catalogue as a grid with its
 * genre filter (`?genre=`) that loads more pages as it scrolls.
 */
function BrowsePage({ section, icon: Icon }: BrowsePageProps) {
  const native = isNativeRuntime();
  const status = useAddonsStore((state) => state.status);
  const addons = useAddonsStore((state) => state.addons);
  const loadAddons = useAddonsStore((state) => state.load);
  const [params] = useSearchParams();
  const sources = useMemo(() => browseSources(addons, section.type), [addons, section.type]);
  const layout = useRowLayout(section.page, sources);
  const [editing, setEditing] = useState(false);
  const label = useCallback((row: LaidOutRow) => sourceLabel(row.source, sources), [sources]);

  useEffect(() => {
    if (native) void loadAddons();
  }, [native, loadAddons]);

  if (!native) {
    return (
      <PageMessage
        icon={<Icon aria-hidden className="size-5" />}
        title={`Browsing ${section.noun} needs the desktop app.`}
      >
        <p className="max-w-sm text-sm text-ink-400">
          Addon catalogues are fetched by the native core.
        </p>
      </PageMessage>
    );
  }
  if (status === 'error') {
    return (
      <PageMessage
        icon={<Icon aria-hidden className="size-5" />}
        title="Installed addons could not be loaded."
      >
        <Button variant="secondary" onClick={() => void loadAddons({ force: true })}>
          Retry
        </Button>
      </PageMessage>
    );
  }
  if (status !== 'ready' || !layout.ready) return null;
  if (sources.length === 0) {
    return (
      <PageMessage
        icon={<Puzzle aria-hidden className="size-5" />}
        title={`No addon provides ${section.noun}`}
      >
        <p className="max-w-sm text-sm text-ink-400">
          Install an addon with {section.noun} catalogues, such as Cinemeta, to browse them here.
        </p>
        <Link to="/addons" className={buttonVariants({ variant: 'secondary', className: 'mt-2' })}>
          Manage addons
        </Link>
      </PageMessage>
    );
  }

  const selected = findSource(sources, params.get('catalog'));
  // Hidden catalogues leave the overview and the tabs, but a link to one
  // (Discover's "See all") still opens it, with its tab.
  const shown = layout.rows
    .filter((row) => !row.hidden || row.source === selected)
    .map((row) => row.source);
  const overview = layout.rows.filter((row) => !row.hidden).map((row) => row.source);
  return (
    <Page
      title={section.title}
      aside={
        // Layouts are saved for Movies and TV Shows only.
        section.page && (
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
            <SlidersHorizontal aria-hidden className="size-4" />
            Customise
          </Button>
        )
      }
    >
      {/* Strips carry 6 px of padding for their focus rings; the gaps allow for it. */}
      <div className="-mt-1.5 flex flex-col gap-5">
        <CatalogTabs sources={shown} labels={sources} selected={selected} />
        {selected ? (
          <CatalogView
            key={sourceParam(selected)}
            source={selected}
            requestedGenre={params.get('genre') ?? undefined}
          />
        ) : overview.length > 0 ? (
          <div className="mt-3 space-y-12">
            {overview.map((source) => (
              <CatalogRow
                key={sourceParam(source)}
                source={source}
                title={sourceLabel(source, sources)}
                seeAll={browsePath(source)}
              />
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <EyeOff aria-hidden className="size-5 text-ink-500" />
            <p className="text-sm text-ink-300">Every {section.noun} catalogue is hidden.</p>
            <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
              Choose rows
            </Button>
          </div>
        )}
      </div>
      {editing && (
        <RowEditor
          pageTitle={section.title}
          layout={layout}
          label={label}
          onClose={() => setEditing(false)}
        />
      )}
    </Page>
  );
}

function CatalogTabs({
  sources,
  labels,
  selected,
}: {
  sources: BrowseSource[];
  /** Every catalogue of the page, to tell same-named ones apart consistently. */
  labels: BrowseSource[];
  selected: BrowseSource | undefined;
}) {
  return (
    <ScrollStrip label="Catalogues" className="-mx-1.5">
      <div className="flex gap-0.5 rounded-full border border-white/[0.06] bg-white/[0.03] p-1">
        <Tab to="" current={!selected}>
          Overview
        </Tab>
        {sources.map((source) => (
          <Tab
            key={sourceParam(source)}
            to={`?${new URLSearchParams({ catalog: sourceParam(source) }).toString()}`}
            current={source === selected}
          >
            {sourceLabel(source, labels)}
          </Tab>
        ))}
      </div>
    </ScrollStrip>
  );
}

/** One catalogue as a grid with its genre filter, paging in as it scrolls. */
function CatalogView({
  source,
  requestedGenre,
}: {
  source: BrowseSource;
  requestedGenre: string | undefined;
}) {
  const filter = genreFilter(source.catalog);
  const genre = effectiveGenre(source.catalog, requestedGenre);
  const feed = useBrowseStore((state) => state.feeds[feedKey(source, genre)]);
  const load = useBrowseStore((state) => state.load);

  useEffect(() => {
    void load(source, genre);
  }, [source, genre, load]);

  return (
    <div className="flex flex-col gap-6">
      {filter && <GenreFilterControl source={source} filter={filter} genre={genre} />}
      <FeedGrid source={source} genre={genre} feed={feed} />
    </div>
  );
}

function GenreFilterControl({
  source,
  filter,
  genre,
}: {
  source: BrowseSource;
  filter: GenreFilter;
  genre: string | undefined;
}) {
  const navigate = useNavigate();
  const href = (option?: string) =>
    `?${new URLSearchParams({
      catalog: sourceParam(source),
      ...(option ? { genre: option } : {}),
    }).toString()}`;
  const label = filterLabel(filter);

  // A long list (Cinemeta's years) is a menu rather than rows of chips.
  if (filter.options.length > MAX_GENRE_CHIPS) {
    return (
      <label className="flex items-center gap-3 text-[13px] text-ink-400">
        {label}
        <select
          value={genre ?? ''}
          onChange={(event) => void navigate(href(event.target.value), { replace: true })}
          className="h-8 cursor-pointer rounded-full border border-white/10 bg-white/[0.04] px-3 text-ink-100 focus-visible:focus-ring"
        >
          {!filter.required && <option value="">All</option>}
          {filter.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    );
  }

  return (
    <ScrollStrip label={`${label}s`} className="-mx-1.5 -my-1.5">
      {!filter.required && (
        <Chip to={href()} current={!genre}>
          All
        </Chip>
      )}
      {filter.options.map((option) => (
        <Chip key={option} to={href(option)} current={option === genre}>
          {option}
        </Chip>
      ))}
    </ScrollStrip>
  );
}

function FeedGrid({
  source,
  genre,
  feed,
}: {
  source: BrowseSource;
  genre: string | undefined;
  feed: Feed | undefined;
}) {
  const loadMore = useBrowseStore((state) => state.loadMore);
  const retry = useBrowseStore((state) => state.retry);
  const [sentinelRef, nearEnd] = useInView<HTMLDivElement>();

  // Keep paging while the end of the grid is within a screen. Each page that
  // lands re-runs this, so a tall window fills up without scrolling.
  useEffect(() => {
    if (nearEnd && feed?.status === 'ready' && feed.hasMore) void loadMore(source, genre);
  }, [nearEnd, feed, source, genre, loadMore]);

  if (!feed || (feed.items.length === 0 && feed.status === 'loading')) {
    return <PosterGridSkeleton />;
  }
  if (feed.items.length === 0) {
    return feed.status === 'error' ? (
      <InlineError
        message={`Couldn’t load this catalogue. ${feed.error ?? ''}`}
        onRetry={() => void retry(source, genre)}
      />
    ) : (
      <p className="py-8 text-center text-sm text-ink-400">
        {genre ? `Nothing in ${genre} here yet.` : 'This catalogue is empty.'}
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <PosterGrid items={feed.items} />
      {feed.status === 'loading' && <PosterGridSkeleton count={6} />}
      {feed.status === 'error' && (
        <InlineError
          message={`Couldn’t load more. ${feed.error ?? ''}`}
          onRetry={() => void retry(source, genre)}
        />
      )}
      {feed.hasMore && <div ref={sentinelRef} aria-hidden className="h-px" />}
    </div>
  );
}

/** A catalogue in the segmented control at the top of the page. */
function Tab({ to, current, children }: { to: string; current: boolean; children: ReactNode }) {
  return (
    <Link
      to={to || '.'}
      aria-current={current ? 'page' : undefined}
      className={cx(
        'shrink-0 rounded-full px-4 py-1.5 text-sm whitespace-nowrap transition-colors duration-150',
        'focus-visible:focus-ring',
        current
          ? 'bg-ink-50 font-medium text-ink-950 shadow-sm shadow-black/40'
          : 'text-ink-300 hover:bg-white/[0.06] hover:text-ink-50',
      )}
    >
      {children}
    </Link>
  );
}

/** A filter option: lighter than the tabs, so the page reads top-down. */
function Chip({ to, current, children }: { to: string; current: boolean; children: ReactNode }) {
  return (
    <Link
      to={to}
      replace
      aria-current={current ? 'page' : undefined}
      className={cx(
        'shrink-0 rounded-full border px-3 py-1 text-[13px] whitespace-nowrap transition-colors duration-150',
        'focus-visible:focus-ring',
        current
          ? 'border-accent/50 bg-accent/15 font-medium text-ink-50'
          : 'border-white/[0.07] text-ink-400 hover:border-white/20 hover:text-ink-100',
      )}
    >
      {children}
    </Link>
  );
}
