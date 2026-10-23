import { Button, KiroMark } from '@kiro/ui';
import {
  ArrowRight,
  EyeOff,
  Library,
  Puzzle,
  Rows3,
  SlidersHorizontal,
  Sparkles,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useShallow } from 'zustand/shallow';

import { useAddonsStore } from '@/features/addons/addons-store';
import { displayableImage } from '@/features/addons/catalog';
import {
  browsePath,
  discoverSources,
  effectiveGenre,
  feedKey,
  rowTitle,
  type BrowseSource,
} from '@/features/discovery/browse-data';
import { useBrowseStore } from '@/features/discovery/browse-store';
import { CatalogRow } from '@/features/discovery/catalog-row';
import { FeaturedHero, HeroPlaceholder } from '@/features/discovery/hero';
import { RowEditor } from '@/features/discovery/row-editor';
import { newRowAddons, type LaidOutRow } from '@/features/discovery/row-layout';
import { useRowLayout, type RowLayout } from '@/features/discovery/use-row-layout';
import { ContinueWatching } from '@/features/library/continue-watching';
import { isNativeRuntime } from '@/services/native';

interface StartCard {
  to: string;
  icon: LucideIcon;
  title: string;
  description: string;
}

const START_CARDS: StartCard[] = [
  {
    to: '/addons',
    icon: Puzzle,
    title: 'Add a source',
    description: 'Install addons to bring catalogues, metadata and streams into Kiro.',
  },
  {
    to: '/library',
    icon: Library,
    title: 'Build your library',
    description: 'Keep a watchlist and pick up where you left off.',
  },
  {
    to: '/settings',
    icon: SlidersHorizontal,
    title: 'Make it yours',
    description: 'Tune playback, subtitles and appearance to your taste.',
  },
];

/** Rows the featured title can come from: the first few shown. */
const FEATURE_CANDIDATES = 3;
/**
 * How long the hero waits for an earlier row's addon before featuring a
 * later row that has answered, so one slow addon doesn't hold up the page.
 */
const FEATURE_WAIT_MS = 2500;

const editorLabel = (row: LaidOutRow) => rowTitle(row.source);

/**
 * Start screen: a featured title from the first rows, "Continue watching",
 * then a row for each catalogue of the enabled addons, arranged by the
 * user's layout (Customise), or a welcome screen until an addon with a
 * catalogue is installed.
 */
export function DiscoverPage() {
  const native = isNativeRuntime();
  const status = useAddonsStore((state) => state.status);
  const addons = useAddonsStore((state) => state.addons);
  const load = useAddonsStore((state) => state.load);

  useEffect(() => {
    if (native) void load();
  }, [native, load]);

  const sources = useMemo(() => discoverSources(addons), [addons]);
  const layout = useRowLayout('discover', sources);
  const [editing, setEditing] = useState(false);
  const shown = useMemo(() => layout.rows.filter((row) => !row.hidden), [layout.rows]);
  const candidates = useMemo(
    () => shown.slice(0, FEATURE_CANDIDATES).map((row) => row.source),
    [shown],
  );

  // Avoid flashing the welcome screen (or the default rows) while installed
  // addons and the saved layout are read.
  if (native && (status === 'idle' || status === 'loading')) return null;
  if (!layout.ready) return null;
  if (sources.length === 0) return <Welcome />;

  return (
    <div className="pb-16">
      <h1 className="sr-only">Discover</h1>
      {candidates.length > 0 ? (
        <Featured key={candidates.map(feedKeyOf).join(' ')} candidates={candidates} />
      ) : (
        <div className="h-40" />
      )}
      {/* Rows rise into the hero's fade. */}
      <div className="relative z-10 -mt-24 space-y-11 px-10 tv:-mt-10">
        <RowsToolbar layout={layout} onCustomise={() => setEditing(true)} />
        <ContinueWatching />
        {shown.map(({ key, source }) => (
          <CatalogRow
            key={`${source.addon.transportUrl} ${key}`}
            source={source}
            title={rowTitle(source)}
            seeAll={browsePath(source)}
          />
        ))}
        {shown.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <EyeOff aria-hidden className="size-5 text-ink-500" />
            <p className="text-sm text-ink-300">Every row on Discover is hidden.</p>
            <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
              Choose rows
            </Button>
          </div>
        )}
      </div>
      {editing && (
        <RowEditor
          pageTitle="Discover"
          layout={layout}
          label={editorLabel}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  );
}

const feedKeyOf = (source: BrowseSource) => feedKey(source, effectiveGenre(source.catalog));

/**
 * "Customise", and a note while the layout has rows it hasn't seen (a new
 * addon's, joined at the end). Dismissing the note saves them into it.
 */
function RowsToolbar({ layout, onCustomise }: { layout: RowLayout; onCustomise: () => void }) {
  const added = newRowAddons(layout.rows);
  return (
    // Above the first row, not on its heading's line, where "See all" is.
    <div className="absolute -top-11 right-10 flex items-center justify-end gap-3">
      {added.length > 0 && (
        <div
          role="status"
          className="flex min-w-0 items-center gap-2.5 rounded-full border border-accent/30 bg-accent/[0.12] py-1 pr-1 pl-3.5 text-[13px] text-ink-100 backdrop-blur-md"
        >
          <Sparkles aria-hidden className="size-3.5 shrink-0 text-accent-strong" />
          <span className="truncate">New rows from {listNames(added)}</span>
          <button
            type="button"
            aria-label="Dismiss"
            title="Dismiss"
            onClick={() => layout.save(layout.entries)}
            className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-ink-300 transition-colors hover:bg-white/10 hover:text-ink-50 focus-visible:focus-ring"
          >
            <X aria-hidden className="size-3.5" />
          </button>
        </div>
      )}
      <Button variant="ghost" size="sm" onClick={onCustomise}>
        {added.length > 0 ? (
          <Rows3 aria-hidden className="size-4" />
        ) : (
          <SlidersHorizontal aria-hidden className="size-4" />
        )}
        Customise
      </Button>
    </div>
  );
}

/** "Anime Kitsu", "Anime Kitsu and Channels", "A, B and C". */
function listNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
}

/**
 * The hero: the first item with artwork from the first shown row, or, when
 * that row's addon is slow (or fails), from the next one that has answered.
 * Once featured, a title stays, so a late answer doesn't swap it.
 */
function Featured({ candidates }: { candidates: BrowseSource[] }) {
  const feeds = useBrowseStore(
    useShallow((state) => candidates.map((source) => state.feeds[feedKeyOf(source)])),
  );
  const loadFeed = useBrowseStore((state) => state.load);
  const [waited, setWaited] = useState(false);
  const [lockedIndex, setLockedIndex] = useState<number | null>(null);

  useEffect(() => {
    for (const source of candidates) void loadFeed(source, effectiveGenre(source.catalog));
  }, [candidates, loadFeed]);

  useEffect(() => {
    const timer = setTimeout(() => setWaited(true), FEATURE_WAIT_MS);
    return () => clearTimeout(timer);
  }, []);

  // In row order: a row with items wins once every row before it has
  // answered with nothing, or the wait is over.
  let chosen: number | null = null;
  for (const [index, feed] of feeds.entries()) {
    if (feed && feed.items.length > 0) {
      chosen = index;
      break;
    }
    if (!waited && (!feed || feed.status === 'loading')) break;
  }
  // Keep the first choice (state adjusted while rendering, not in an effect).
  if (lockedIndex === null && chosen !== null) setLockedIndex(chosen);
  const featured = lockedIndex ?? chosen;

  const feed = featured === null ? undefined : feeds[featured];
  const item = useMemo(
    () => feed?.items.find((candidate) => displayableImage(candidate.background)) ?? feed?.items[0],
    [feed],
  );

  if (item) return <FeaturedHero item={item} />;
  // Without anything to feature, the rows simply start under the header.
  if (feeds.every((candidate) => candidate && candidate.status !== 'loading')) {
    return <div className="h-40" />;
  }
  return <HeroPlaceholder />;
}

function Welcome() {
  return (
    <div className="relative isolate min-h-full overflow-hidden">
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute top-[-14rem] left-1/2 h-[30rem] w-[52rem] -translate-x-1/2 rounded-full bg-accent/[0.22] blur-[120px]" />
        <div className="absolute top-[6rem] left-[64%] h-[18rem] w-[24rem] rounded-full bg-glow/[0.12] blur-[100px]" />
      </div>

      <section className="mx-auto flex max-w-3xl flex-col items-center px-8 pt-32 pb-14 text-center">
        <KiroMark className="size-18 drop-shadow-[0_12px_40px_rgb(132_60_251/0.6)]" />
        <h1 className="mt-8 text-6xl font-semibold tracking-[-0.045em] text-ink-50">Kiro</h1>
        <p className="mt-4 text-xl tracking-tight text-ink-300">
          Your entertainment.{' '}
          <span className="bg-linear-to-r from-accent-strong to-glow bg-clip-text text-transparent">
            One place.
          </span>
        </p>
      </section>

      <section
        aria-label="Get started"
        className="mx-auto grid max-w-4xl gap-3 px-8 pb-8 md:grid-cols-3"
      >
        {START_CARDS.map(({ to, icon: Icon, title, description }) => (
          <Link
            key={to}
            to={to}
            className="group rounded-card border border-white/[0.07] bg-white/[0.03] p-5 backdrop-blur transition duration-200 hover:border-accent/40 hover:bg-white/[0.05] focus-visible:focus-ring"
          >
            <div className="flex items-center justify-between">
              <Icon aria-hidden className="size-5 text-accent-strong" />
              <ArrowRight
                aria-hidden
                className="size-4 text-ink-500 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-ink-200"
              />
            </div>
            <h2 className="mt-4 text-sm font-medium text-ink-50">{title}</h2>
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-400">{description}</p>
          </Link>
        ))}
      </section>

      <p className="mx-auto max-w-4xl px-8 pb-16 text-center text-sm text-ink-400">
        Coming from Stremio?{' '}
        <Link
          to="/settings#stremio"
          className="rounded font-medium text-accent-strong hover:underline focus-visible:focus-ring"
        >
          Import your addons, library and watch progress
        </Link>{' '}
        in one go.
      </p>
    </div>
  );
}
