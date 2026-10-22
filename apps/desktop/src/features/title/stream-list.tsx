import { Badge, Button } from '@kiro/ui';
import { cx } from '@kiro/utils';
import { AlertCircle, Filter, Loader2, Play, Puzzle, RotateCcw, Zap } from 'lucide-react';
import { useId, useState } from 'react';
import { Link, useNavigate } from 'react-router';

import type { InstalledAddon } from '@/features/addons/addons-store';
import type { PlaybackArtwork, PlaybackMedia } from '@/features/playback/playback-request';
import {
  qualityBadges,
  resolutionLabel,
  rankedPlaybackRequest,
  type FilteredStream,
  type RankedStream,
  type UnplayableStream,
} from '@/features/title/stream-ranking';
import { streamAvailability } from '@/features/title/title-data';
import { useTitleStore } from '@/features/title/title-store';
import { useRankedStreams, type AddonStreamsStatus } from '@/features/title/use-ranked-streams';

interface StreamListProps {
  addons: InstalledAddon[];
  type: string;
  /** The movie's id, or the episode's video id. */
  id: string;
  /** Shown by the player. */
  title: string;
  subtitle?: string;
  /** The title and video being played, so the player can save progress. */
  media?: PlaybackMedia;
  /** Backdrop and logo shown while the player opens the stream. */
  artwork?: PlaybackArtwork;
  /** Why Play brought the viewer here instead of playing. */
  notice?: string;
}

/** How many ranked streams show before "Show all". */
const INITIAL_STREAMS = 8;

/**
 * Streams for a movie or episode from every enabled stream addon, best first
 * (what Play starts is marked), then the ones the stream settings filter out
 * (still playable from here), then the ones Kiro can't play.
 */
export function StreamList({
  addons,
  type,
  id,
  title,
  subtitle,
  media,
  artwork,
  notice,
}: StreamListProps) {
  const { sources, settled, ranking } = useRankedStreams(addons, type, id);
  const navigate = useNavigate();
  const [showAll, setShowAll] = useState(false);

  const play = (choice: RankedStream) => {
    void navigate('/player', {
      state: rankedPlaybackRequest(choice, { title, subtitle, media, artwork }),
    });
  };

  if (sources.length === 0) {
    // No addon to ask: none provides streams at all, or none for this title.
    const none = streamAvailability(addons, type, id) === 'none';
    return (
      <section
        id="streams"
        aria-label="Streams"
        className="flex flex-col items-center rounded-card border border-white/[0.07] bg-white/[0.025] px-5 py-10 text-center"
      >
        <Puzzle aria-hidden className="size-6 text-ink-500" />
        <p className="mt-3 text-sm text-ink-300">
          {none
            ? 'None of your addons provide streams.'
            : 'None of your addons provide streams for this title.'}
        </p>
        {none && (
          <p className="mt-1 text-[13px] text-ink-500">
            Kiro plays what your addons provide. Add one that provides streams to watch here.
          </p>
        )}
        <Link
          to="/addons"
          className="mt-2 rounded text-[13px] text-accent-strong hover:underline focus-visible:focus-ring"
        >
          Go to Addons
        </Link>
      </section>
    );
  }

  const { playable, filtered, unplayable } = ranking;
  const shown = showAll ? playable : playable.slice(0, INITIAL_STREAMS);

  return (
    <section
      id="streams"
      aria-label={subtitle ? `Streams for ${subtitle}` : 'Streams'}
      aria-busy={!settled}
      className="space-y-4"
    >
      {notice && (
        <p
          role="status"
          className="flex items-start gap-3 rounded-card border border-accent/25 bg-accent/[0.07] px-5 py-3.5 text-sm text-ink-100"
        >
          <AlertCircle aria-hidden className="mt-0.5 size-4 shrink-0 text-accent-strong" />
          {notice}
        </p>
      )}

      <AddonStatuses sources={sources} type={type} id={id} />

      {playable.length > 0 ? (
        <div className="overflow-hidden rounded-card border border-white/[0.07] bg-white/[0.025]">
          <ul className="divide-y divide-white/[0.05]">
            {shown.map((choice, rank) => (
              <PlayableRow
                key={`${choice.addon.transportUrl}#${choice.index}`}
                choice={choice}
                best={rank === 0}
                onPlay={() => play(choice)}
              />
            ))}
          </ul>
          {playable.length > shown.length && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="w-full cursor-pointer border-t border-white/[0.06] px-5 py-3 text-[13px] font-medium text-ink-300 transition-colors hover:bg-white/[0.025] hover:text-ink-50 focus-visible:focus-ring focus-visible:-outline-offset-2"
            >
              Show all {playable.length} streams
            </button>
          )}
        </div>
      ) : notice ? null : settled ? (
        <p className="rounded-card border border-white/[0.07] bg-white/[0.025] px-5 py-4 text-sm text-ink-400">
          {filtered.length > 0
            ? 'Every stream found is filtered out by your stream settings.'
            : unplayable.length > 0
              ? 'None of these streams can play in Kiro yet.'
              : 'No streams were found for this title.'}
        </p>
      ) : (
        <div
          aria-hidden
          className="space-y-3 rounded-card border border-white/[0.07] bg-white/[0.025] px-5 py-4"
        >
          <div className="h-3.5 w-2/5 animate-pulse rounded-full bg-white/[0.05]" />
          <div className="h-3.5 w-3/5 animate-pulse rounded-full bg-white/[0.04]" />
        </div>
      )}

      {filtered.length > 0 && (
        <FilteredStreams streams={filtered} open={settled && playable.length === 0} onPlay={play} />
      )}

      {unplayable.length > 0 && (
        <UnplayableStreams
          streams={unplayable}
          open={settled && playable.length === 0 && filtered.length === 0}
        />
      )}
    </section>
  );
}

/** Each addon's progress: how many streams it found, or a retry if it failed. */
function AddonStatuses({
  sources,
  type,
  id,
}: {
  sources: AddonStreamsStatus[];
  type: string;
  id: string;
}) {
  const loadAddonStreams = useTitleStore((state) => state.loadAddonStreams);

  return (
    <ul aria-label="Stream addons" className="flex flex-wrap gap-2">
      {sources.map(({ addon, entry }) => (
        <li
          key={addon.transportUrl}
          className="flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.03] py-1 pr-1 pl-3 text-xs text-ink-300"
        >
          <span className="font-medium text-ink-100">{addon.manifest.name}</span>
          {entry?.status === 'ready' ? (
            <span className="pr-2 tabular-nums">
              {entry.streams.length} {entry.streams.length === 1 ? 'stream' : 'streams'}
            </span>
          ) : entry?.status === 'error' ? (
            <>
              <span className="max-w-64 truncate text-ink-400" title={entry.message}>
                Couldn’t load
              </span>
              <button
                type="button"
                onClick={() => void loadAddonStreams(addon, type, id, { force: true })}
                className="flex cursor-pointer items-center gap-1 rounded-full bg-white/[0.06] px-2 py-0.5 font-medium text-ink-100 hover:bg-white/[0.1] focus-visible:focus-ring"
              >
                <RotateCcw aria-hidden className="size-3" />
                Retry
              </button>
            </>
          ) : (
            <span className="flex items-center gap-1.5 pr-2">
              <Loader2 aria-hidden className="size-3 animate-spin" />
              Loading
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function PlayableRow({
  choice,
  best = false,
  reasons,
  onPlay,
}: {
  choice: RankedStream;
  best?: boolean;
  /** Why the stream settings filter it out, if they do. */
  reasons?: string[];
  onPlay: () => void;
}) {
  const { stream, addon, quality } = choice;
  const labelId = useId();
  const details = stream.description ?? stream.title;
  const heading = resolutionLabel(quality.resolution) ?? stream.name?.split('\n')[0]?.trim();
  // The resolution already heads the row.
  const badges = qualityBadges(quality).slice(quality.resolution === undefined ? 0 : 1);

  return (
    <li
      className={cx(
        'flex items-center gap-5 px-5 py-3.5 transition-colors hover:bg-white/[0.025]',
        best && 'bg-accent/[0.06]',
      )}
    >
      <div id={labelId} className="flex min-w-0 flex-1 gap-5">
        <div className="w-24 shrink-0">
          <p className="text-[15px] leading-snug font-semibold text-ink-50">
            {heading ?? 'Stream'}
          </p>
          <p className="truncate text-xs text-ink-400" title={addon.manifest.name}>
            {addon.manifest.name}
          </p>
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            {best && (
              <Badge tone="accent" className="border-accent bg-accent text-white">
                Best
              </Badge>
            )}
            {quality.cached && (
              <Badge tone="accent">
                <Zap aria-hidden className="size-3 fill-current" />
                Cached
              </Badge>
            )}
            {reasons && (
              <Badge className="border-amber-300/25 bg-amber-300/10 text-amber-100">
                <Filter aria-hidden className="size-3" />
                Filtered: {reasons.join(', ')}
              </Badge>
            )}
            {quality.cached === false && <Badge>Not cached</Badge>}
            {badges.map((badge) => (
              <Badge key={badge} className={cx(badge === 'CAM' && 'text-ink-50')}>
                {badge}
              </Badge>
            ))}
          </div>
          {details && (
            <p className="line-clamp-2 text-xs leading-relaxed break-words whitespace-pre-line text-ink-400">
              {details}
            </p>
          )}
        </div>
      </div>
      <Button
        size="sm"
        variant={best ? 'primary' : 'secondary'}
        aria-describedby={labelId}
        onClick={onPlay}
      >
        <Play aria-hidden className="size-3.5 fill-current" />
        Play
      </Button>
    </li>
  );
}

/**
 * Streams the stream settings filter out, folded away but listed, so nothing
 * silently disappears. They can still be played from here.
 */
function FilteredStreams({
  streams,
  open,
  onPlay,
}: {
  streams: FilteredStream[];
  open: boolean;
  onPlay: (choice: RankedStream) => void;
}) {
  return (
    <details
      open={open || undefined}
      className="group overflow-hidden rounded-card border border-white/[0.07] bg-white/[0.02]"
    >
      <summary className="cursor-pointer px-5 py-3 text-[13px] font-medium text-ink-400 select-none hover:text-ink-100 focus-visible:focus-ring focus-visible:-outline-offset-2">
        {streams.length} {streams.length === 1 ? 'stream' : 'streams'} filtered by your settings
        <Link
          to="/settings#streams"
          className="ml-2 rounded text-accent-strong hover:underline focus-visible:focus-ring"
        >
          Change filters
        </Link>
      </summary>
      <ul className="divide-y divide-white/[0.05] border-t border-white/[0.06]">
        {streams.map((choice) => (
          <PlayableRow
            key={`${choice.addon.transportUrl}#${choice.index}`}
            choice={choice}
            reasons={choice.reasons}
            onPlay={() => onPlay(choice)}
          />
        ))}
      </ul>
    </details>
  );
}

/** Torrents, YouTube, http and external links, folded away. */
function UnplayableStreams({ streams, open }: { streams: UnplayableStream[]; open: boolean }) {
  return (
    // Opens by itself when there is nothing else; after that it is the viewer's.
    <details
      open={open || undefined}
      className="group overflow-hidden rounded-card border border-white/[0.07] bg-white/[0.02]"
    >
      <summary className="cursor-pointer px-5 py-3 text-[13px] font-medium text-ink-400 select-none hover:text-ink-100 focus-visible:focus-ring focus-visible:-outline-offset-2">
        {streams.length} {streams.length === 1 ? 'stream' : 'streams'} Kiro can’t play yet
      </summary>
      <ul className="divide-y divide-white/[0.05] border-t border-white/[0.06]">
        {streams.map(({ stream, addon, index, reason }) => (
          <li key={`${addon.transportUrl}#${index}`} className="flex gap-5 px-5 py-3">
            <div className="w-24 shrink-0">
              <p className="text-[13px] leading-snug font-semibold whitespace-pre-line text-ink-400">
                {stream.name?.split('\n')[0]?.trim() || 'Stream'}
              </p>
              <p className="truncate text-xs text-ink-500">{addon.manifest.name}</p>
            </div>
            <div className="min-w-0 flex-1">
              {(stream.description ?? stream.title) && (
                <p className="line-clamp-2 text-xs leading-relaxed break-words whitespace-pre-line text-ink-500">
                  {stream.description ?? stream.title}
                </p>
              )}
              <p className="mt-1 text-xs font-medium text-ink-400">{reason}</p>
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}
