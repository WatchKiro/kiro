import { Button, buttonVariants } from '@kiro/ui';
import { Puzzle, Search, SearchX, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';

import { Page, PageMessage } from '@/components/page';
import { useAddonsStore, type InstalledAddon } from '@/features/addons/addons-store';
import { InlineError } from '@/features/discovery/catalog-row';
import { PosterGrid, PosterGridSkeleton } from '@/features/discovery/poster-grid';
import {
  groupByType,
  normalizeQuery,
  searchKey,
  searchTargets,
  typeLabel,
  type SearchTarget,
} from '@/features/search/search-data';
import { useSearchStore, type SearchEntry } from '@/features/search/search-store';
import { usesCommandKey } from '@/lib/platform';
import { isNativeRuntime } from '@/services/native';

/**
 * Results for `?q=` from every searchable catalogue of the installed addons,
 * grouped by content type, then by addon.
 */
export function SearchPage() {
  const [params] = useSearchParams();
  const query = normalizeQuery(params.get('q') ?? '');
  const native = isNativeRuntime();
  const addonsStatus = useAddonsStore((state) => state.status);
  const addons = useAddonsStore((state) => state.addons);
  const loadAddons = useAddonsStore((state) => state.load);

  useEffect(() => {
    if (native) void loadAddons();
  }, [native, loadAddons]);

  if (!native) {
    return <Message icon={Search} title="Search is only available inside the desktop app." />;
  }
  if (addonsStatus === 'error') {
    return (
      <Message icon={Search} title="Installed addons could not be loaded.">
        <Button variant="secondary" onClick={() => void loadAddons({ force: true })}>
          Retry
        </Button>
      </Message>
    );
  }
  if (addonsStatus !== 'ready') return null;
  return <Results addons={addons} query={query} />;
}

function Results({ addons, query }: { addons: InstalledAddon[]; query: string }) {
  const targets = useMemo(() => searchTargets(addons), [addons]);
  const groups = useMemo(() => groupByType(targets), [targets]);
  const search = useSearchStore((state) => state.search);
  const cancel = useSearchStore((state) => state.cancel);
  const storeQuery = useSearchStore((state) => state.query);
  const entries = useSearchStore((state) => state.entries);

  useEffect(() => {
    void search(targets, query);
  }, [targets, query, search]);

  // Leaving the page abandons a search still in progress.
  useEffect(() => cancel, [cancel]);

  if (targets.length === 0) {
    return (
      <Message
        icon={Puzzle}
        title="None of your addons can search"
        description="Install an addon with searchable catalogues, such as Cinemeta, to search for movies and shows."
      >
        <Link to="/addons" className={buttonVariants({ variant: 'secondary' })}>
          Manage addons
        </Link>
      </Message>
    );
  }
  if (!query) {
    return (
      <Message
        icon={Search}
        title="Search movies and shows"
        description={`Type in the search box, or press ${usesCommandKey() ? '⌘K' : 'Ctrl+K'} anywhere to jump to it.`}
      />
    );
  }

  // Until the store catches up with the URL, show this query as loading.
  const entryOf = (target: SearchTarget): SearchEntry =>
    (storeQuery === query ? entries[searchKey(target)] : undefined) ?? { status: 'loading' };
  const all = targets.map(entryOf);

  if (all.every((entry) => entry.status === 'ready' && entry.items.length === 0)) {
    return (
      <Message
        icon={SearchX}
        title={`No results for “${query}”`}
        description="Check the spelling or try a shorter search."
      />
    );
  }
  if (all.every((entry) => entry.status === 'error')) {
    return (
      <Message
        icon={SearchX}
        title="Search failed"
        description={[...new Set(all.map((entry) => entry.status === 'error' && entry.message))]
          .filter(Boolean)
          .join(' ')}
      >
        <Button variant="secondary" onClick={() => void search(targets, query, { force: true })}>
          Retry
        </Button>
      </Message>
    );
  }

  return (
    <Page
      title={`“${query}”`}
      description={<span aria-live="polite">Search results from your addons</span>}
      className="space-y-12"
    >
      {groups.map(({ type, targets: grouped }) => {
        // Hide catalogues with nothing to show; keep loading and failed ones.
        const visible = grouped.filter((target) => {
          const entry = entryOf(target);
          return entry.status !== 'ready' || entry.items.length > 0;
        });
        if (visible.length === 0) return null;
        return (
          <section key={type} aria-label={typeLabel(type)} className="space-y-5">
            <h2 className="text-[19px] font-semibold tracking-[-0.015em] text-ink-50">
              {typeLabel(type)}
            </h2>
            {visible.map((target) => (
              <ResultSection
                key={searchKey(target)}
                target={target}
                entry={entryOf(target)}
                showCatalogName={grouped.some(
                  (other) => other !== target && other.addon === target.addon,
                )}
              />
            ))}
          </section>
        );
      })}
    </Page>
  );
}

interface ResultSectionProps {
  target: SearchTarget;
  entry: SearchEntry;
  /** Whether the addon has more than one catalogue of this type to tell apart. */
  showCatalogName: boolean;
}

function ResultSection({ target, entry, showCatalogName }: ResultSectionProps) {
  const retry = useSearchStore((state) => state.retry);
  const { addon, catalog } = target;

  return (
    <div className="space-y-3">
      <h3 className="text-xs text-ink-500">
        from {addon.manifest.name}
        {showCatalogName && ` · ${catalog.name ?? catalog.id}`}
      </h3>
      {entry.status === 'ready' ? (
        <PosterGrid items={entry.items} />
      ) : entry.status === 'error' ? (
        <InlineError
          message={`${addon.manifest.name} couldn’t search. ${entry.message}`}
          onRetry={() => void retry(target)}
        />
      ) : (
        <PosterGridSkeleton count={6} />
      )}
    </div>
  );
}

interface MessageProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  children?: ReactNode;
}

function Message({ icon: Icon, title, description, children }: MessageProps) {
  return (
    <PageMessage icon={<Icon aria-hidden className="size-5" />} title={title}>
      {description && <p className="max-w-sm text-sm text-ink-400">{description}</p>}
      {children && <div className="mt-2">{children}</div>}
    </PageMessage>
  );
}
