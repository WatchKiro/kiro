import type { MetaPreview } from '@kiro/addon-sdk';
import { cx } from '@kiro/utils';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';

import { CardMenu } from '@/components/action-menu';
import { displayableImage } from '@/features/addons/catalog';
import { WatchedTick } from '@/features/library/library-poster';
import { filmActions, useWatchedFilm } from '@/features/library/watch-actions';
import { titlePath } from '@/features/title/title-data';

type PosterShape = NonNullable<MetaPreview['posterShape']>;

const SHAPES: Record<PosterShape, string> = {
  poster: 'aspect-[2/3]',
  landscape: 'aspect-video',
  square: 'aspect-square',
};

/**
 * Card widths in a row, by artwork shape: wide and square artwork gets a
 * wider card so it stays about as tall as a poster's.
 */
const ROW_WIDTHS: Record<PosterShape, string> = {
  poster: 'w-[9.5rem]',
  landscape: 'w-[16.5rem]',
  square: 'w-[11.5rem]',
};

/** Grid columns and an off-screen card's estimated size, by artwork shape. */
const GRID_SHAPES: Record<PosterShape, { columns: string; size: string }> = {
  poster: {
    columns: 'grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))]',
    size: '[contain-intrinsic-size:auto_9.5rem_auto_17rem]',
  },
  landscape: {
    columns: 'grid-cols-[repeat(auto-fill,minmax(15rem,1fr))]',
    size: '[contain-intrinsic-size:auto_15rem_auto_11.5rem]',
  },
  square: {
    columns: 'grid-cols-[repeat(auto-fill,minmax(11rem,1fr))]',
    size: '[contain-intrinsic-size:auto_11rem_auto_14rem]',
  },
};

const GRID = 'grid gap-x-5 gap-y-8';

/** A catalogue's artwork shape, taken from its first item (addons use one shape per catalogue). */
function shapeOf(items: MetaPreview[]): PosterShape {
  return items[0]?.posterShape ?? 'poster';
}

/**
 * Catalogue items as a poster grid.
 *
 * Not virtualised: a catalogue page is usually ≤ 100 items (validation caps it
 * at 1000), images load lazily, and `content-visibility: auto` lets the
 * browser skip layout and paint for off-screen cards.
 */
export function PosterGrid({ items }: { items: MetaPreview[] }) {
  const shape = GRID_SHAPES[shapeOf(items)];
  return (
    <ul data-nav-group className={cx(GRID, shape.columns)}>
      {items.map((item) => (
        <li key={`${item.type}:${item.id}`} className={cx(shape.size, '[content-visibility:auto]')}>
          <PosterCard item={item} />
        </li>
      ))}
    </ul>
  );
}

/**
 * A catalogue item. A film shows a tick once watched, and its menu (the "⋯",
 * a right click or the Menu key) marks it watched or unwatched.
 */
export function PosterCard({ item }: { item: MetaPreview }) {
  const [failed, setFailed] = useState(false);
  const poster = displayableImage(item.poster);
  const watched = useWatchedFilm(item.type, item.id);
  const title = {
    type: item.type,
    id: item.id,
    name: item.name.trim() || item.id,
    poster: poster ?? null,
  };

  return (
    <CardMenu label={title.name} actions={filmActions(title, watched)}>
      <Link
        to={titlePath(item.type, item.id)}
        title={item.name}
        className="group block rounded-xl outline-none"
      >
        <div
          className={cx(
            'relative overflow-hidden rounded-xl bg-linear-to-b from-white/[0.07] to-white/[0.02] shadow-[0_0_0_1px_rgb(255_255_255/0.06),0_14px_30px_-16px_rgb(0_0_0/0.9)] transition duration-300 ease-out-soft group-hover:shadow-[0_0_0_1px_rgb(255_255_255/0.22),0_18px_40px_-16px_rgb(0_0_0/0.9)] group-focus-visible:focus-lift',
            SHAPES[item.posterShape ?? 'poster'],
          )}
        >
          {poster && !failed ? (
            <img
              src={poster}
              alt=""
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              onError={() => setFailed(true)}
              className="size-full object-cover transition duration-500 ease-out-soft group-hover:scale-[1.04]"
            />
          ) : (
            <span className="absolute inset-0 flex items-center justify-center p-3 text-center text-sm font-medium text-ink-300">
              {item.name}
            </span>
          )}
          {watched && <WatchedTick />}
        </div>
        <div className="mt-2.5 px-0.5">
          <p className="truncate text-[13px] font-medium text-ink-100 group-hover:text-ink-50 group-focus-visible:text-ink-50">
            {item.name}
          </p>
          {item.releaseInfo && (
            <p className="mt-0.5 truncate text-xs text-ink-500 tabular-nums">{item.releaseInfo}</p>
          )}
        </div>
      </Link>
    </CardMenu>
  );
}

/** Catalogue items as a single row of posters that scrolls sideways. */
export function PosterRow({ items }: { items: MetaPreview[] }) {
  return (
    <ScrollRow>
      {items.map((item) => (
        <li
          key={`${item.type}:${item.id}`}
          className={cx(ROW_WIDTHS[item.posterShape ?? 'poster'], 'shrink-0 snap-start')}
        >
          <PosterCard item={item} />
        </li>
      ))}
    </ScrollRow>
  );
}

/**
 * A row of cards that scrolls sideways, running to the edges of the page,
 * with arrow buttons at either end while there is more to see.
 */
export function ScrollRow({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });

  const measure = useCallback(() => {
    const list = ref.current;
    if (!list) return;
    setEdges({
      start: list.scrollLeft <= 1,
      end: list.scrollLeft + list.clientWidth >= list.scrollWidth - 1,
    });
  }, []);

  useEffect(() => {
    const list = ref.current;
    if (!list) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [measure, children]);

  const step = (direction: 1 | -1) => {
    const list = ref.current;
    if (list) list.scrollBy({ left: direction * list.clientWidth * 0.85, behavior: 'smooth' });
  };

  return (
    <div className="group/row relative">
      {/* Padded above so a focused card's lift and glow aren't clipped. */}
      <ul
        ref={ref}
        data-nav-group
        onScroll={measure}
        className="-mx-10 -mt-3 flex snap-x scroll-px-10 [scrollbar-width:none] gap-5 overflow-x-auto overscroll-x-contain px-10 pt-4 pb-3"
      >
        {children}
      </ul>
      <RowArrow side="start" hidden={edges.start} onClick={() => step(-1)} />
      <RowArrow side="end" hidden={edges.end} onClick={() => step(1)} />
    </div>
  );
}

function RowArrow({
  side,
  hidden,
  onClick,
}: {
  side: 'start' | 'end';
  hidden: boolean;
  onClick: () => void;
}) {
  const Icon = side === 'start' ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-hidden
      onClick={onClick}
      className={cx(
        'absolute top-3 bottom-3 z-10 flex w-10 cursor-pointer items-center justify-center text-ink-50 opacity-0 transition-opacity duration-200',
        side === 'start'
          ? '-left-10 bg-linear-to-r from-ink-950 via-ink-950/70 to-transparent'
          : '-right-10 bg-linear-to-l from-ink-950 via-ink-950/70 to-transparent',
        hidden ? 'pointer-events-none' : 'group-hover/row:opacity-100',
      )}
    >
      <Icon className="size-6 drop-shadow" />
    </button>
  );
}

/** Placeholder row shown while a catalogue loads. */
export function PosterRowSkeleton({ count = 9 }: { count?: number }) {
  return (
    <ul aria-hidden className="-mx-10 flex gap-5 overflow-hidden px-10 pt-1 pb-3">
      {Array.from({ length: count }, (_, index) => (
        <li key={index} className="w-[9.5rem] shrink-0">
          <div className="aspect-[2/3] animate-pulse rounded-xl bg-white/[0.04]" />
          <div className="mt-2.5 h-3 w-3/4 rounded-full bg-white/[0.04]" />
        </li>
      ))}
    </ul>
  );
}

/** Placeholder grid shown while a catalogue loads. */
export function PosterGridSkeleton({ count = 12 }: { count?: number }) {
  return (
    <ul aria-hidden className={cx(GRID, GRID_SHAPES.poster.columns)}>
      {Array.from({ length: count }, (_, index) => (
        <li key={index}>
          <div className="aspect-[2/3] animate-pulse rounded-xl bg-white/[0.04]" />
          <div className="mt-2.5 h-3 w-3/4 rounded-full bg-white/[0.04]" />
        </li>
      ))}
    </ul>
  );
}
