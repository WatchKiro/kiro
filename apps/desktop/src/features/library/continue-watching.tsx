import { formatDuration } from '@kiro/utils';
import { Check, EyeOff } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router';

import { CardMenu, type MenuAction } from '@/components/action-menu';
import { RowHeading } from '@/features/discovery/catalog-row';
import { ScrollRow } from '@/features/discovery/poster-grid';
import {
  continueTarget,
  entryPath,
  progressFraction,
  videoLabel,
} from '@/features/library/library-data';
import { useLibraryStore } from '@/features/library/library-store';
import { episodeLabel, episodeMedia } from '@/features/title/title-data';
import { useTitleArtwork } from '@/features/title/use-title-artwork';
import { useInView } from '@/hooks/use-in-view';
import { describeError, type HistoryEntry } from '@/services/native';
import { showToast } from '@/stores/toast-store';

/**
 * Titles to carry on with, newest first: unfinished progress, and series
 * between episodes (offering the next one). Renders nothing when there are none.
 * Each card's menu takes it off the list (with Undo) or marks it watched.
 */
export function ContinueWatching() {
  const list = useLibraryStore((state) => state.continueWatching);
  const load = useLibraryStore((state) => state.load);
  const headingId = useId();

  useEffect(() => {
    void load('continueWatching');
  }, [load]);

  if (list.items.length === 0) return null;

  return (
    <section aria-labelledby={headingId}>
      <RowHeading id={headingId} title="Continue watching" />
      <ScrollRow>
        {list.items.map((entry) => (
          <ContinueCard key={`${entry.title.type}:${entry.title.id}`} entry={entry} />
        ))}
      </ScrollRow>
    </section>
  );
}

/**
 * A wide card: the title's backdrop and logo (from its details, fetched when
 * the card nears the viewport), falling back to the saved poster.
 */
function ContinueCard({ entry }: { entry: HistoryEntry }) {
  const { title } = entry;
  const [ref, near] = useInView<HTMLAnchorElement>({ once: true });
  const [item, setItem] = useState<HTMLLIElement | null>(null);
  const dismiss = useLibraryStore((state) => state.dismissFromContinue);
  const restore = useLibraryStore((state) => state.restoreToContinue);
  const markWatched = useLibraryStore((state) => state.markWatched);
  // A finished episode needs the series' episodes to know what's next.
  const needsEpisodes = entry.completed && title.type === 'series';
  const artwork = useTitleArtwork(title.type, title.id, near || needsEpisodes);
  const target = continueTarget(entry, artwork.seasons);
  /** Image URLs that failed to load. */
  const [failed, setFailed] = useState<string[]>([]);
  const image = [artwork.background, title.poster ?? undefined].find(
    (src): src is string => src !== undefined && !failed.includes(src),
  );
  const logo = artwork.logo && !failed.includes(artwork.logo) ? artwork.logo : undefined;

  // The series is over (or a finished film slipped through): nothing to offer.
  if (target.kind === 'done') return null;

  const next = target.kind === 'next' ? episodeMedia(title, target.video).video : null;
  const href = next
    ? entryPath({ title, video: next })
    : target.kind === 'resume'
      ? entryPath(entry)
      : entryPath({ title, video: { ...entry.video, id: title.id } });
  const detail =
    target.kind === 'resume'
      ? [
          videoLabel(entry.video),
          `${formatDuration(Math.max(entry.duration - entry.position, 0))} left`,
        ]
          .filter(Boolean)
          .join(' · ')
      : next
        ? `Next · ${videoLabel(next) ?? 'Episode'}`
        : 'Next episode';

  /**
   * Takes the card off the row, offering Undo. Focus (when the keys did it)
   * goes to Undo, then to the card beside this one.
   */
  const remove = async () => {
    const active = document.activeElement;
    const keys =
      Boolean(item?.contains(active)) &&
      Boolean(active?.matches(':focus-visible, [data-nav-focus]'));
    const beside = item?.nextElementSibling ?? item?.previousElementSibling;
    const neighbour = beside?.querySelector<HTMLElement>('a[href]');
    await dismiss(title.type, title.id);
    showToast({
      message: `Removed “${title.name}” from Continue watching`,
      action: {
        label: 'Undo',
        run: () =>
          restore(title.type, title.id).catch((error: unknown) =>
            showToast({ message: describeError(error), error: true }),
          ),
      },
      focus: keys,
      returnFocus: () => (neighbour?.isConnected ? neighbour : undefined),
    });
  };
  const actions: MenuAction[] = [
    { label: 'Remove from Continue watching', icon: EyeOff, run: remove },
    target.kind === 'resume'
      ? {
          label: 'Mark as watched',
          icon: Check,
          run: () => markWatched(title, [entry.video]),
        }
      : target.kind === 'next'
        ? {
            label: `Mark ${episodeLabel({ ...target.video, title: undefined, name: undefined })} as watched`,
            icon: Check,
            run: () => markWatched(title, [episodeMedia(title, target.video).video]),
          }
        : null,
  ].filter((action) => action !== null);

  return (
    <li ref={setItem} className="w-[19rem] shrink-0 snap-start">
      <CardMenu label={title.name} actions={actions}>
        <Link
          ref={ref}
          to={href}
          title={title.name}
          className="group block rounded-xl outline-none"
        >
          <div className="relative aspect-video overflow-hidden rounded-xl bg-ink-850 shadow-[0_0_0_1px_rgb(255_255_255/0.07)] transition duration-300 ease-out-soft group-hover:shadow-[0_0_0_1px_rgb(255_255_255/0.22)] group-focus-visible:focus-lift">
            {image && (
              <img
                src={image}
                alt=""
                loading="lazy"
                decoding="async"
                referrerPolicy="no-referrer"
                onError={() => setFailed((urls) => [...urls, image])}
                className={
                  image === artwork.background
                    ? 'size-full object-cover transition duration-500 ease-out-soft group-hover:scale-[1.04]'
                    : 'size-full object-cover object-[center_20%] opacity-80 blur-[1px]'
                }
              />
            )}
            <div className="absolute inset-0 bg-linear-to-t from-black/80 via-black/10 to-transparent" />
            <div className="absolute inset-x-4 bottom-4">
              {logo ? (
                <img
                  src={logo}
                  alt=""
                  decoding="async"
                  referrerPolicy="no-referrer"
                  onError={() => setFailed((urls) => [...urls, logo])}
                  className="max-h-11 max-w-[60%] object-contain object-left drop-shadow-[0_4px_16px_rgb(0_0_0/0.7)]"
                />
              ) : (
                <p className="truncate text-base font-semibold text-ink-50 drop-shadow">
                  {title.name}
                </p>
              )}
            </div>
            {target.kind === 'resume' && (
              <div aria-hidden className="absolute inset-x-0 bottom-0 h-1 bg-white/15">
                <div
                  className="h-full bg-accent shadow-[0_0_12px_rgb(132_60_251/0.8)]"
                  style={{ width: `${progressFraction(entry) * 100}%` }}
                />
              </div>
            )}
          </div>
          <div className="mt-2.5 px-0.5">
            <p className="truncate text-[13px] font-medium text-ink-100 group-hover:text-ink-50 group-focus-visible:text-ink-50">
              {title.name}
            </p>
            <p className="mt-0.5 truncate text-xs text-ink-500 tabular-nums">{detail}</p>
          </div>
        </Link>
      </CardMenu>
    </li>
  );
}
