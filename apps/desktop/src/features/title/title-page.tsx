import type { MetaDetail, Video } from '@kiro/addon-sdk';
import { Button, buttonVariants } from '@kiro/ui';
import { cx, formatDuration } from '@kiro/utils';
import { Clapperboard, Ellipsis, ListVideo, Loader2, Play, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';

import { MenuButton } from '@/components/action-menu';
import { PageMessage } from '@/components/page';
import { useAddonsStore, type InstalledAddon } from '@/features/addons/addons-store';
import { displayableImage } from '@/features/addons/catalog';
import { HeroBackdrop, MetaLine, TitleLogo } from '@/features/discovery/hero';
import { titleKey } from '@/features/library/library-data';
import { useLibraryStore } from '@/features/library/library-store';
import { showActions } from '@/features/library/watch-actions';
import { WatchedButton } from '@/features/library/watched-button';
import { WatchlistButton } from '@/features/library/watchlist-button';
import { EpisodeList } from '@/features/title/episode-list';
import { StreamList } from '@/features/title/stream-list';
import { rankedPlaybackRequest } from '@/features/title/stream-ranking';
import {
  episodeLabel,
  episodeMedia,
  groupSeasons,
  metaAddons,
  metaKey,
  movieMedia,
  nextEpisode,
  releaseYear,
  type Season,
} from '@/features/title/title-data';
import { useTitleStore } from '@/features/title/title-store';
import { useRankedStreams } from '@/features/title/use-ranked-streams';
import { isNativeRuntime, type HistoryEntry, type LibraryTitle } from '@/services/native';

/**
 * A movie or series: its metadata from the first addon that provides it, and
 * streams from every installed stream addon. A series lists its episodes; the
 * selected one (`?episode=<video id>`) gets the stream list (`?tab=streams`).
 * Play starts the best-ranked stream of the movie or next episode; `#streams`
 * (Discover's Play) does the same on arrival.
 */
export function TitlePage() {
  const { type = '', id = '' } = useParams();
  const native = isNativeRuntime();
  const addonsStatus = useAddonsStore((state) => state.status);
  const addons = useAddonsStore((state) => state.addons);
  const loadAddons = useAddonsStore((state) => state.load);

  useEffect(() => {
    if (native) void loadAddons();
  }, [native, loadAddons]);

  if (!native) {
    return (
      <PageMessage
        icon={<Clapperboard aria-hidden className="size-5" />}
        title="Titles are only available inside the desktop app."
      >
        <BackToDiscover />
      </PageMessage>
    );
  }
  if (addonsStatus === 'error') {
    return (
      <PageMessage
        icon={<Clapperboard aria-hidden className="size-5" />}
        title="Installed addons could not be loaded."
      >
        <Button variant="secondary" onClick={() => void loadAddons({ force: true })}>
          Retry
        </Button>
      </PageMessage>
    );
  }
  if (addonsStatus !== 'ready') return null;
  return <Title key={`${type}/${id}`} addons={addons} type={type} id={id} />;
}

function Title({ addons, type, id }: { addons: InstalledAddon[]; type: string; id: string }) {
  const sources = useMemo(() => metaAddons(addons, type, id), [addons, type, id]);
  const entry = useTitleStore((state) => state.metas[metaKey(type, id, sources)]);
  const loadMeta = useTitleStore((state) => state.loadMeta);
  const library = useLibraryStore((state) => state.titles[titleKey(type, id)]);
  const [params, setParams] = useSearchParams();
  const { hash, search } = useLocation();
  const navigate = useNavigate();
  const tabsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadMeta(addons, type, id);
  }, [addons, type, id, loadMeta]);

  const meta = entry?.status === 'ready' ? entry.meta : undefined;
  /** Shown by the player while it opens a stream. */
  const artwork = meta ? { background: meta.background, logo: meta.logo } : undefined;
  useEffect(() => {
    if (meta) document.title = `${meta.name} · Kiro`;
  }, [meta]);
  const seasons = useMemo(() => groupSeasons(meta?.videos ?? []), [meta]);
  /** What the library stores about this title (until metadata loads, just its id). */
  const libraryTitle = useMemo<LibraryTitle>(
    () => ({
      type,
      id,
      name: meta?.name.trim() || id,
      poster: displayableImage(meta?.poster) ?? null,
    }),
    [type, id, meta],
  );
  // A series can only be played once its episodes are known.
  const episodic = type === 'series' || seasons.length > 0;
  const progress = library?.progress ?? [];
  const next = episodic ? nextEpisode(seasons, progress) : undefined;
  const episodes = seasons.flatMap((season) => season.episodes);
  const selected = episodes.find((video) => video.id === params.get('episode'));
  const tab = episodic && !(selected && params.get('tab') === 'streams') ? 'episodes' : 'streams';

  /** Shows the streams of `video` (a series) or of the movie, in view. */
  const showStreams = (video?: Video) => {
    // Replace, so Back leaves the title instead of stepping through episodes.
    if (video) setParams({ episode: video.id, tab: 'streams' }, { replace: true });
    requestAnimationFrame(() => tabsRef.current?.scrollIntoView({ behavior: 'smooth' }));
  };

  // What Play starts: the movie, or the next episode once episodes are known.
  const playVideo = episodic ? next?.video : undefined;
  const playId = episodic ? playVideo?.id : id;
  /** Counts presses of Play; 0 until it is pressed (or after "Choose stream"). */
  const [playPresses, setPlayPresses] = useState(0);
  // Play waits for every addon, so a slower one with a better stream still
  // counts, but only for so long when a good stream has already arrived.
  const best = useRankedStreams(addons, type, meta ? playId : undefined, {
    waiting: playPresses > 0,
  });
  const finding = playPresses > 0 && !best.ready;
  /** Why Play showed the streams instead of playing. */
  const notice =
    playPresses > 0 && best.settled && best.ranking.playable.length === 0 && best.sources.length > 0
      ? best.ranking.filtered.length > 0
        ? 'Every stream found is filtered out by your stream settings. You can still play one below.'
        : best.ranking.unplayable.length > 0
          ? 'None of the streams found can play in Kiro. Kiro plays direct https links.'
          : best.sources.every(({ entry }) => entry?.status === 'error')
            ? 'Streams couldn’t be loaded. Retry an addon below.'
            : 'No streams were found for this title.'
      : undefined;

  const play = () => setPlayPresses((presses) => presses + 1);
  const chooseStream = () => {
    setPlayPresses(0);
    showStreams(playVideo);
  };

  // Once every addon has answered (or a good stream once the time budget is
  // spent), play the best stream, or show the list.
  useEffect(() => {
    if (playPresses === 0 || !best.ready) return;
    const choice = best.ranking.playable[0];
    if (!choice) {
      showStreams(playVideo);
      return;
    }
    void navigate('/player', {
      state: rankedPlaybackRequest(choice, {
        title: libraryTitle.name,
        ...(playVideo
          ? { subtitle: episodeLabel(playVideo), media: episodeMedia(libraryTitle, playVideo) }
          : { media: movieMedia(libraryTitle) }),
        artwork,
      }),
    });
    // The rest is read as it is when the streams are ready or Play is pressed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playPresses, best.ready]);

  // Discover's Play lands here with #streams: do what this page's Play does.
  // The hash is dropped first, so coming Back from the player doesn't play again.
  const handledHash = useRef(false);
  useEffect(() => {
    if (handledHash.current || hash !== '#streams' || !meta) return;
    if (episodic && !next) return;
    handledHash.current = true;
    void navigate({ search }, { replace: true });
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a one-off request from the URL
    play();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash, meta, episodic, next]);

  return (
    <div className="pb-16">
      {meta ? (
        <Hero
          meta={meta}
          libraryTitle={libraryTitle}
          action={
            (!episodic || next) && (
              <>
                <PlayButton
                  label={
                    next
                      ? `${next.resume ? 'Resume' : 'Play'} ${shortEpisode(next.video)}`
                      : movieProgress(progress, id)
                        ? 'Resume'
                        : 'Play'
                  }
                  resume={next ? next.resume : Boolean(movieProgress(progress, id))}
                  finding={finding}
                  answered={best.answered}
                  addonCount={best.sources.length}
                  onClick={play}
                />
                <Button
                  variant="secondary"
                  size="lg"
                  onClick={chooseStream}
                  title={finding ? 'Stop waiting and choose a stream yourself' : undefined}
                >
                  <ListVideo aria-hidden className="size-4.5" />
                  Choose stream
                </Button>
              </>
            )
          }
          watched={
            !episodic ? (
              <WatchedButton title={libraryTitle} progress={progress} ready={Boolean(library)} />
            ) : (
              seasons.length > 0 && (
                <MenuButton
                  label="Mark the show watched or unwatched"
                  actions={showActions(libraryTitle, seasons, progress)}
                  className={buttonVariants({
                    variant: 'secondary',
                    size: 'lg',
                    className: 'w-12 px-0!',
                  })}
                >
                  <Ellipsis aria-hidden className="size-5" />
                </MenuButton>
              )
            )
          }
          note={
            episodic
              ? next?.resume
                ? remaining(progress, next.video.id)
                : undefined
              : remaining(progress, id)
          }
        />
      ) : (
        <div className="px-10 pt-24">
          {entry?.status === 'error' ? (
            <div className="flex items-center gap-4 rounded-card border border-white/[0.07] bg-white/[0.025] px-5 py-4 text-sm">
              <p className="flex-1 text-ink-400">Couldn’t load details. {entry.message}</p>
              {sources.length > 0 && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void loadMeta(addons, type, id, { force: true })}
                >
                  Retry
                </Button>
              )}
            </div>
          ) : (
            <HeroSkeleton />
          )}
        </div>
      )}

      <div className="relative z-10 -mt-8 px-10">
        {!episodic ? (
          <div ref={tabsRef} className="scroll-mt-20">
            <SectionTitle>Streams</SectionTitle>
            <StreamList
              addons={addons}
              type={type}
              id={id}
              title={libraryTitle.name}
              media={movieMedia(libraryTitle)}
              artwork={artwork}
              notice={notice}
            />
          </div>
        ) : meta ? (
          <SeriesTabs
            tabsRef={tabsRef}
            tab={tab}
            selected={selected}
            onTab={(value) =>
              setParams(
                selected
                  ? { episode: selected.id, ...(value === 'streams' ? { tab: value } : {}) }
                  : {},
                { replace: true },
              )
            }
          >
            {tab === 'streams' && selected ? (
              <StreamList
                addons={addons}
                type={type}
                id={selected.id}
                title={meta.name}
                subtitle={episodeLabel(selected)}
                media={episodeMedia(libraryTitle, selected)}
                artwork={artwork}
                notice={selected.id === playVideo?.id ? notice : undefined}
              />
            ) : (
              <Episodes
                title={libraryTitle}
                seasons={seasons}
                selected={selected ?? next?.video}
                progress={progress}
                onSelect={showStreams}
              />
            )}
          </SeriesTabs>
        ) : null}
      </div>
    </div>
  );
}

/** A movie's own unfinished progress, if any. */
function movieProgress(progress: HistoryEntry[], id: string) {
  return progress.find((entry) => entry.video.id === id && !entry.completed);
}

/** "32m left" for unfinished progress on a video. */
function remaining(progress: HistoryEntry[], videoId: string) {
  const entry = progress.find((candidate) => candidate.video.id === videoId);
  if (!entry || entry.completed || entry.position <= 0) return undefined;
  return `${formatDuration(Math.max(entry.duration - entry.position, 0))} left`;
}

/** `S2 E4`, or `Special 1`. */
function shortEpisode(video: Video) {
  return episodeLabel({ ...video, title: undefined, name: undefined });
}

/** Starts the best stream; while the addons answer, it says how many have. */
function PlayButton({
  label,
  resume,
  finding,
  answered,
  addonCount,
  onClick,
}: {
  label: string;
  resume: boolean;
  finding: boolean;
  answered: number;
  addonCount: number;
  onClick: () => void;
}) {
  const Icon = finding ? Loader2 : resume ? RotateCcw : Play;
  return (
    <Button
      size="lg"
      data-nav-start
      onClick={onClick}
      disabled={finding}
      aria-busy={finding}
      className="tabular-nums"
    >
      <Icon
        aria-hidden
        className={cx('size-4.5', finding ? 'animate-spin' : !resume && 'fill-current')}
      />
      {finding
        ? addonCount > 1
          ? `Finding the best stream… ${answered} of ${addonCount} addons`
          : 'Finding the best stream…'
        : label}
    </Button>
  );
}

type SeriesTab = 'episodes' | 'streams';

function SeriesTabs({
  tabsRef,
  tab,
  selected,
  onTab,
  children,
}: {
  tabsRef: RefObject<HTMLDivElement | null>;
  tab: SeriesTab;
  selected: Video | undefined;
  onTab: (tab: SeriesTab) => void;
  children: ReactNode;
}) {
  const tabs: { value: SeriesTab; label: string; disabled?: boolean }[] = [
    { value: 'episodes', label: 'Episodes' },
    {
      value: 'streams',
      label: selected ? `Streams · ${shortEpisode(selected)}` : 'Streams',
      disabled: !selected,
    },
  ];
  return (
    <div ref={tabsRef} className="scroll-mt-20">
      <div role="tablist" data-nav-group className="mb-6 flex gap-7 border-b border-white/[0.08]">
        {tabs.map(({ value, label, disabled }) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            disabled={disabled}
            title={disabled ? 'Choose an episode first' : undefined}
            onClick={() => onTab(value)}
            className={cx(
              '-mb-px cursor-pointer border-b-2 pb-3 text-[15px] transition-colors disabled:cursor-not-allowed disabled:opacity-40',
              'focus-visible:focus-ring',
              tab === value
                ? 'border-accent font-semibold text-ink-50'
                : 'border-transparent font-medium text-ink-400 hover:text-ink-100',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel">{children}</div>
    </div>
  );
}

function Episodes({
  title,
  seasons,
  selected,
  progress,
  onSelect,
}: {
  title: LibraryTitle;
  seasons: Season[];
  selected: Video | undefined;
  progress: HistoryEntry[];
  onSelect: (video: Video) => void;
}) {
  // Until a season is picked, show the selected episode's (it may arrive late).
  const [picked, setPicked] = useState<number>();
  const season = picked ?? selected?.season ?? seasons[0]?.number;

  if (seasons.length === 0) {
    return <p className="text-sm text-ink-400">No episodes are listed for this series.</p>;
  }
  return (
    <EpisodeList
      title={title}
      seasons={seasons}
      season={season}
      onSeasonChange={setPicked}
      selectedId={selected?.id}
      progress={progress}
      onSelect={onSelect}
    />
  );
}

function Hero({
  meta,
  libraryTitle,
  action,
  watched,
  note,
}: {
  meta: MetaDetail;
  libraryTitle: LibraryTitle;
  action: ReactNode;
  /** Marking it watched or unwatched. */
  watched: ReactNode;
  note: string | undefined;
}) {
  const year = releaseYear(meta.releaseInfo) ?? releaseYear(meta.released);

  return (
    <HeroBackdrop src={displayableImage(meta.background)}>
      <div className="w-full px-10 pb-20">
        <TitleLogo as="h1" name={meta.name} logo={meta.logo} />
        <div className="mt-6">
          <MetaLine
            rating={meta.imdbRating}
            facts={[year, meta.runtime, meta.genres?.slice(0, 3).join(' · ')]}
          />
        </div>
        {meta.description && (
          <p
            title={meta.description}
            className="mt-3.5 line-clamp-4 max-w-2xl text-[15px] leading-relaxed text-ink-200"
          >
            {meta.description}
          </p>
        )}
        <div data-nav-group className="mt-6 flex flex-wrap items-center gap-3">
          {action}
          <WatchlistButton title={libraryTitle} />
          {watched}
          {note && <span className="ml-1 text-sm text-ink-300 tabular-nums">{note}</span>}
        </div>
      </div>
    </HeroBackdrop>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-5 border-b border-white/[0.08] pb-3 text-[15px] font-semibold text-ink-50">
      {children}
    </h2>
  );
}

function HeroSkeleton() {
  return (
    <div aria-hidden className="space-y-4 pt-40">
      <div className="h-20 w-80 animate-pulse rounded-2xl bg-white/[0.05]" />
      <div className="h-4 w-1/4 animate-pulse rounded-full bg-white/[0.04]" />
      <div className="h-4 w-3/5 animate-pulse rounded-full bg-white/[0.04]" />
    </div>
  );
}

function BackToDiscover() {
  return (
    <Link to="/" className={buttonVariants({ variant: 'secondary', className: 'mt-2' })}>
      Back to Discover
    </Link>
  );
}
