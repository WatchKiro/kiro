import { Button } from '@kiro/ui';
import { ChevronRight } from 'lucide-react';
import { useEffect, useId, type ReactNode } from 'react';
import { Link } from 'react-router';

import { effectiveGenre, feedKey, type BrowseSource } from '@/features/discovery/browse-data';
import { useBrowseStore } from '@/features/discovery/browse-store';
import { PosterRow, PosterRowSkeleton } from '@/features/discovery/poster-grid';
import { useInView } from '@/hooks/use-in-view';

/** Items a catalogue row shows before "See all". */
const ROW_ITEMS = 20;

interface CatalogRowProps {
  source: BrowseSource;
  title: string;
  /** Where "See all" goes, when the catalogue has a page of its own. */
  seeAll?: string;
}

/**
 * A catalogue's first page as a row, fetched when it nears the viewport. It
 * shares the browse store's feed, so "See all" opens with these items loaded.
 */
export function CatalogRow({ source, title, seeAll }: CatalogRowProps) {
  const genre = effectiveGenre(source.catalog);
  const feed = useBrowseStore((state) => state.feeds[feedKey(source, genre)]);
  const load = useBrowseStore((state) => state.load);
  const retry = useBrowseStore((state) => state.retry);
  const [ref, near] = useInView<HTMLElement>({ once: true });
  const headingId = useId();

  useEffect(() => {
    if (near) void load(source, genre);
  }, [near, source, genre, load]);

  return (
    // A group with its heading, so coming down from the row above lands on
    // its posters (where they were left) rather than on "See all".
    <section ref={ref} aria-labelledby={headingId} data-nav-group>
      <RowHeading
        id={headingId}
        title={title}
        detail={[genre, source.addon.manifest.name].filter(Boolean).join(' · ')}
        seeAll={seeAll}
      />
      {feed && feed.items.length > 0 ? (
        <PosterRow items={feed.items.slice(0, ROW_ITEMS)} />
      ) : feed?.status === 'error' ? (
        <InlineError
          message={`Couldn’t load this catalogue. ${feed.error ?? ''}`}
          onRetry={() => void retry(source, genre)}
        />
      ) : feed?.status === 'ready' ? (
        <p className="text-sm text-ink-400">This catalogue is empty.</p>
      ) : (
        // Rows further down wait still: an animation, even off screen, is
        // restyled on every frame the page draws (slow on a TV).
        <PosterRowSkeleton pulse={near} />
      )}
    </section>
  );
}

/** The heading over a row: its title, a muted detail and "See all". */
export function RowHeading({
  id,
  title,
  detail,
  seeAll,
}: {
  id: string;
  title: ReactNode;
  detail?: string;
  seeAll?: string;
}) {
  return (
    <div className="mb-3.5 flex items-baseline gap-3">
      <h2 id={id} className="text-[19px] font-semibold tracking-[-0.015em] text-ink-50">
        {title}
      </h2>
      {detail && <span className="truncate text-xs text-ink-500">{detail}</span>}
      {seeAll && (
        <Link
          to={seeAll}
          data-nav-forget
          className="ml-auto flex shrink-0 items-center gap-0.5 rounded text-[13px] font-medium text-ink-400 transition-colors hover:text-ink-50 focus-visible:focus-ring"
        >
          See all
          <ChevronRight aria-hidden className="size-4" />
        </Link>
      )}
    </div>
  );
}

export function InlineError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex items-center gap-4 rounded-card border border-white/[0.07] bg-white/[0.025] px-5 py-4 text-sm">
      <p className="flex-1 text-ink-400">{message}</p>
      <Button variant="secondary" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
