import type { Video } from '@kiro/addon-sdk';
import { cx } from '@kiro/utils';
import { Check, ChevronDown, Ellipsis } from 'lucide-react';
import { useId, useState } from 'react';

import { CardMenu, MenuButton, type MenuAction } from '@/components/action-menu';
import { displayableImage } from '@/features/addons/catalog';
import { progressFraction } from '@/features/library/library-data';
import { episodeActions, seasonActions, seasonName } from '@/features/library/watch-actions';
import { episodeLabel, type Season } from '@/features/title/title-data';
import type { HistoryEntry, LibraryTitle } from '@/services/native';

interface EpisodeListProps {
  /** The series, as the library saves it. */
  title: LibraryTitle;
  seasons: Season[];
  season: number | undefined;
  onSeasonChange: (season: number) => void;
  /** The episode Play starts, or the one whose streams were last shown. */
  selectedId: string | undefined;
  /** The series' saved progress, for watched marks and progress bars. */
  progress: HistoryEntry[];
  onSelect: (video: Video) => void;
}

/**
 * A season picker and that season's episodes as a grid of wide cards. A menu
 * beside the picker marks the season watched or unwatched; each episode's
 * menu (its "⋯", a right click or the Menu key) marks the episode.
 */
export function EpisodeList({
  title,
  seasons,
  season,
  onSeasonChange,
  selectedId,
  progress,
  onSelect,
}: EpisodeListProps) {
  const selectId = useId();
  const current = seasons.find((entry) => entry.number === season) ?? seasons[0];
  /**
   * Marks keep this season in view: until one is picked, the list follows
   * the episode Play starts, which a mark moves on.
   */
  const staying = (actions: MenuAction[]) =>
    actions.map((action) => ({
      ...action,
      run: () => {
        if (current) onSeasonChange(current.number);
        return action.run();
      },
    }));

  return (
    <section aria-label="Episodes" className="space-y-5">
      <div data-nav-group className="flex items-center gap-2">
        <div className="relative inline-flex items-center">
          <label htmlFor={selectId} className="sr-only">
            Season
          </label>
          <select
            id={selectId}
            value={current?.number}
            onChange={(event) => onSeasonChange(Number(event.target.value))}
            className="h-10 cursor-pointer appearance-none rounded-full border border-white/12 bg-white/[0.06] pr-10 pl-4 text-sm font-medium text-ink-50 transition-colors hover:bg-white/[0.1] focus-visible:focus-ring"
          >
            {seasons.map((entry) => (
              <option key={entry.number} value={entry.number} className="bg-ink-900">
                {seasonName(entry.number)} · {entry.episodes.length} episodes
              </option>
            ))}
          </select>
          <ChevronDown
            aria-hidden
            className="pointer-events-none absolute right-3.5 size-4 text-ink-300"
          />
        </div>
        {current && (
          <MenuButton
            label={`Mark ${seasonName(current.number)} watched or unwatched`}
            actions={staying(seasonActions(title, seasons, progress, current.number))}
            className="flex size-10 cursor-pointer items-center justify-center rounded-full border border-white/12 bg-white/[0.06] text-ink-100 transition-colors hover:bg-white/[0.1] hover:text-ink-50 focus-visible:focus-ring"
          >
            <Ellipsis aria-hidden className="size-4" />
          </MenuButton>
        )}
      </div>

      <ol
        data-nav-group
        className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-x-5 gap-y-7"
      >
        {current?.episodes.map((video) => (
          <li key={video.id}>
            <CardMenu
              label={`${title.name} ${episodeLabel(video)}`}
              actions={staying(episodeActions(title, seasons, progress, video))}
            >
              <EpisodeCard
                video={video}
                entry={progress.find((candidate) => candidate.video.id === video.id)}
                selected={video.id === selectedId}
                onSelect={() => onSelect(video)}
              />
            </CardMenu>
          </li>
        ))}
      </ol>
    </section>
  );
}

function EpisodeCard({
  video,
  entry,
  selected,
  onSelect,
}: {
  video: Video;
  entry: HistoryEntry | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const thumbnail = displayableImage(video.thumbnail);
  const released = video.released ? new Date(video.released) : undefined;
  const name = video.title ?? video.name;
  const number =
    video.season === 0 ? `Special ${video.episode ?? ''}`.trim() : `E${video.episode ?? '?'}`;

  return (
    <button
      type="button"
      aria-current={selected || undefined}
      onClick={onSelect}
      className="group block w-full cursor-pointer rounded-xl text-left outline-none"
    >
      <div
        className={cx(
          'relative aspect-video overflow-hidden rounded-xl bg-ink-850 transition duration-300 ease-out-soft group-focus-visible:focus-lift',
          selected
            ? 'shadow-[0_0_0_2px_var(--color-accent)]'
            : 'shadow-[0_0_0_1px_rgb(255_255_255/0.07)] group-hover:shadow-[0_0_0_1px_rgb(255_255_255/0.22)]',
        )}
      >
        {thumbnail && !failed && (
          <img
            src={thumbnail}
            alt=""
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={() => setFailed(true)}
            className="size-full object-cover transition duration-500 ease-out-soft group-hover:scale-[1.04]"
          />
        )}
        {entry?.completed && (
          <span className="absolute top-2.5 left-2.5 flex items-center gap-1 rounded-full bg-black/65 px-2 py-0.5 text-[11px] font-medium text-ink-100 backdrop-blur">
            <Check aria-hidden className="size-3" />
            Watched
          </span>
        )}
        {entry && !entry.completed && (
          <div aria-hidden className="absolute inset-x-0 bottom-0 h-1 bg-white/15">
            <div
              className="h-full bg-accent"
              style={{ width: `${progressFraction(entry) * 100}%` }}
            />
          </div>
        )}
      </div>
      <p className="mt-2.5 truncate text-sm font-medium text-ink-50">
        <span className="text-ink-400 tabular-nums">{number}</span>
        {name && <span> · {name}</span>}
      </p>
      {released && !Number.isNaN(released.getTime()) && (
        <p className="mt-0.5 text-xs text-ink-500 tabular-nums">
          {released.toLocaleDateString(undefined, { dateStyle: 'medium' })}
        </p>
      )}
      {video.overview && (
        <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-ink-400">{video.overview}</p>
      )}
    </button>
  );
}
