import type { Video } from '@kiro/addon-sdk';

import { watchOrder, type Season } from '@/features/title/title-data';
import type { HistoryEntry } from '@/services/native';

/**
 * Marking titles watched or unwatched by hand. The core records a mark as
 * watching the videos now, in the order sent, so the last one becomes the
 * title's latest and Continue watching moves on to the episode after it.
 */

type Progress = readonly Pick<HistoryEntry, 'video' | 'completed'>[];

/** How much of a set of videos has been watched. */
export type WatchedState =
  /** Not one has any progress. */
  | 'none'
  /** Some are watched or started. */
  | 'some'
  /** Every one is watched. */
  | 'all';

/** Whether a video is marked watched in a title's progress. */
export function isWatched(progress: Progress, videoId: string): boolean {
  return progress.some((entry) => entry.video.id === videoId && entry.completed);
}

export function watchedState(progress: Progress, videos: readonly Video[]): WatchedState {
  if (videos.length > 0 && videos.every((video) => isWatched(progress, video.id))) return 'all';
  return videos.some((video) => progress.some((entry) => entry.video.id === video.id))
    ? 'some'
    : 'none';
}

/** One season's episodes, in order. */
export function seasonEpisodes(seasons: readonly Season[], number: number): Video[] {
  return seasons.find((season) => season.number === number)?.episodes ?? [];
}

/**
 * Every episode of a show, specials first, so a whole-show mark ends on its
 * last regular episode and leaves nothing to continue.
 */
export function showEpisodes(seasons: readonly Season[]): Video[] {
  const specials = seasons.filter((season) => season.number === 0);
  const regular = watchOrder([...seasons]);
  return regular.some((video) => video.season === 0)
    ? regular
    : [...specials.flatMap((season) => season.episodes), ...regular];
}

/**
 * The episodes "Mark watched up to here" covers: those before `videoId` in
 * viewing order, and it. A special counts within its own season only.
 */
export function episodesUpTo(seasons: readonly Season[], videoId: string): Video[] {
  const order = watchOrder([...seasons]);
  const index = order.findIndex((video) => video.id === videoId);
  if (index >= 0) return order.slice(0, index + 1);
  const season = seasons.find((entry) => entry.episodes.some((video) => video.id === videoId));
  if (!season) return [];
  const own = season.episodes.findIndex((video) => video.id === videoId);
  return season.episodes.slice(0, own + 1);
}

/**
 * What to send to mark `videos` watched: those not watched yet (so earlier
 * viewings keep their dates), and always the last one, which the title then
 * continues from. Empty when there is nothing to mark.
 */
export function videosToMark(progress: Progress, videos: readonly Video[]): Video[] {
  const last = videos.at(-1);
  return videos.filter((video) => video === last || !isWatched(progress, video.id));
}

/** Ids of the videos among `videos` that have progress to forget. */
export function videosToUnmark(progress: Progress, videos: readonly Video[]): string[] {
  return videos
    .filter((video) => progress.some((entry) => entry.video.id === video.id))
    .map((video) => video.id);
}

/** What an episode's menu offers. */
export interface EpisodeMarks {
  watched: boolean;
  /**
   * "Mark watched up to here": the episodes to send, or `null` when no
   * earlier episode is left unwatched (marking it alone does the same).
   */
  upTo: Video[] | null;
}

export function episodeMarks(
  seasons: readonly Season[],
  progress: Progress,
  videoId: string,
): EpisodeMarks {
  const earlier = episodesUpTo(seasons, videoId).slice(0, -1);
  const unwatched = earlier.some((video) => !isWatched(progress, video.id));
  const upTo = unwatched ? videosToMark(progress, episodesUpTo(seasons, videoId)) : null;
  return { watched: isWatched(progress, videoId), upTo };
}
