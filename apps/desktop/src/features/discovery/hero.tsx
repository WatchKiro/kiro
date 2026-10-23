import type { MetaPreview } from '@kiro/addon-sdk';
import { buttonVariants } from '@kiro/ui';
import { cx } from '@kiro/utils';
import { Info, Play, Star } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';

import { displayableImage } from '@/features/addons/catalog';
import { WatchlistButton } from '@/features/library/watchlist-button';
import { releaseYear, titlePath } from '@/features/title/title-data';

/** Height of the artwork; content below starts inside its fade. */
// On a TV, low enough for the first row to show beneath it.
export const HERO_HEIGHT = 'h-[clamp(30rem,72vh,44rem)] tv:h-[62vh]';

/**
 * Full-bleed artwork for one title, under the floating header. The text sits
 * bottom-left over a fade into the page, so rows below can rise into it.
 */
export function HeroBackdrop({
  src,
  children,
  className,
}: {
  src: string | undefined;
  children: ReactNode;
  /** e.g. a height of its own on a TV (`tv:` classes). */
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <section className={cx('relative isolate flex items-end', HERO_HEIGHT, className)}>
      <div aria-hidden className="absolute inset-0 -z-10 overflow-hidden bg-ink-900">
        {src && !failed ? (
          <img
            src={src}
            alt=""
            decoding="async"
            fetchPriority="high"
            referrerPolicy="no-referrer"
            onError={() => setFailed(true)}
            className="size-full animate-[kiro-fade-in_600ms_ease-out] object-cover object-[center_22%]"
          />
        ) : (
          <div className="size-full bg-[radial-gradient(ellipse_at_70%_20%,rgb(132_60_251/0.35),transparent_60%),radial-gradient(ellipse_at_90%_80%,rgb(93_123_255/0.2),transparent_55%)]" />
        )}
        <div className="absolute inset-0 bg-linear-to-r from-ink-950/95 via-ink-950/55 to-transparent to-75%" />
        <div className="absolute inset-0 bg-linear-to-t from-ink-950 via-ink-950/40 via-30% to-transparent to-60%" />
      </div>
      {children}
    </section>
  );
}

/** A title's logo artwork, or its name when it has none (or it fails to load). */
export function TitleLogo({
  name,
  logo,
  as: Heading = 'h2',
  className,
}: {
  name: string;
  logo: string | undefined;
  as?: 'h1' | 'h2';
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const src = displayableImage(logo);
  return (
    <Heading className={className}>
      {src && !failed ? (
        <img
          src={src}
          alt={name}
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className="max-h-32 max-w-[min(28rem,80%)] object-contain object-left drop-shadow-[0_8px_30px_rgb(0_0_0/0.6)] tv:max-h-16"
        />
      ) : (
        <span className="block max-w-2xl text-5xl leading-[1.05] font-semibold tracking-[-0.035em] text-balance text-ink-50">
          {name}
        </span>
      )}
    </Heading>
  );
}

/** Rating, year, runtime and genres, separated by dots. */
export function MetaLine({
  rating,
  facts,
}: {
  rating: string | undefined;
  facts: (string | undefined)[];
}) {
  const shown = facts.filter((fact): fact is string => Boolean(fact));
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm text-ink-200">
      {rating && (
        <span className="flex items-center gap-1 font-semibold text-[#f5c518]" title="IMDb rating">
          <Star aria-hidden className="size-3.5 fill-current" />
          <span className="sr-only">IMDb rating</span>
          {rating}
        </span>
      )}
      {shown.map((fact, index) => (
        <span key={fact} className="flex items-center gap-2.5 tabular-nums">
          {(index > 0 || rating) && (
            <span aria-hidden className="size-[3px] rounded-full bg-ink-400" />
          )}
          {fact}
        </span>
      ))}
    </div>
  );
}

/** Discover's featured title: artwork, logo, a short synopsis and actions. */
export function FeaturedHero({ item }: { item: MetaPreview }) {
  const path = titlePath(item.type, item.id);
  return (
    <HeroBackdrop src={displayableImage(item.background)}>
      {/* On a TV: shorter, to stay clear of the header above and the rows below. */}
      <div className="w-full px-10 pb-36 tv:pb-16">
        <TitleLogo name={item.name} logo={item.logo} />
        <div className="mt-6 tv:mt-3">
          <MetaLine
            rating={item.imdbRating}
            facts={[
              releaseYear(item.releaseInfo),
              item.runtime,
              item.genres?.slice(0, 3).join(' · '),
            ]}
          />
        </div>
        {item.description && (
          <p className="mt-3.5 line-clamp-3 max-w-xl text-[15px] leading-relaxed text-ink-200 tv:mt-2 tv:line-clamp-1">
            {item.description}
          </p>
        )}
        <div data-nav-group className="mt-6 flex items-center gap-3 tv:mt-4">
          <Link to={`${path}#streams`} data-nav-start className={buttonVariants({ size: 'lg' })}>
            <Play aria-hidden className="size-4.5 fill-current" />
            Play
          </Link>
          <Link to={path} className={buttonVariants({ variant: 'secondary', size: 'lg' })}>
            <Info aria-hidden className="size-5" />
            Details
          </Link>
          <WatchlistButton
            compact
            title={{
              type: item.type,
              id: item.id,
              name: item.name,
              poster: displayableImage(item.poster) ?? null,
            }}
          />
        </div>
      </div>
    </HeroBackdrop>
  );
}

/** Space held for the hero while the featured catalogue loads. */
export function HeroPlaceholder() {
  return (
    <div aria-hidden className={`relative ${HERO_HEIGHT}`}>
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_70%_10%,rgb(132_60_251/0.14),transparent_60%)]" />
      <div className="absolute bottom-36 left-10 space-y-4">
        <div className="h-24 w-80 animate-pulse rounded-2xl bg-white/[0.05]" />
        <div className="h-4 w-64 animate-pulse rounded-full bg-white/[0.04]" />
        <div className="h-4 w-96 animate-pulse rounded-full bg-white/[0.04]" />
      </div>
    </div>
  );
}
