import { supportsResource, type Stream, type Video } from '@kiro/addon-sdk';

import type { InstalledAddon } from '@/features/addons/addons-store';
import type { PlaybackMedia } from '@/features/playback/playback-request';
import type { LibraryTitle, LibraryVideo } from '@/services/native';

/** Route of a title's page. */
export function titlePath(type: string, id: string) {
  return `/title/${encodeURIComponent(type)}/${encodeURIComponent(id)}`;
}

/** Installed addons that can describe `type`/`id`, in install order. */
export function metaAddons(addons: InstalledAddon[], type: string, id: string) {
  return addons.filter((addon) => supportsResource(addon.manifest, 'meta', type, id));
}

/** Installed addons that can list streams for `type`/`id`, in install order. */
export function streamAddons(addons: InstalledAddon[], type: string, id: string) {
  return addons.filter((addon) => supportsResource(addon.manifest, 'stream', type, id));
}

/** Whether an addon lists streams for anything at all. */
export function providesStreams(addon: InstalledAddon) {
  return addon.manifest.resources.some(
    (entry) => (typeof entry === 'string' ? entry : entry.name) === 'stream',
  );
}

/**
 * Why a movie or episode has streams to load, or doesn't: `none` when no
 * enabled addon provides streams for anything (Kiro has nothing to play
 * until one is added), `other` when some do but not for this kind of title
 * or id, otherwise `available`. Whether those addons then find any streams
 * is up to them.
 */
export function streamAvailability(
  addons: InstalledAddon[],
  type: string,
  id: string,
): 'none' | 'other' | 'available' {
  if (streamAddons(addons, type, id).length > 0) return 'available';
  return addons.some(providesStreams) ? 'other' : 'none';
}

/**
 * Cache key for a title's metadata. It includes the addons that were asked, so
 * installing or removing a metadata addon refetches instead of serving a
 * result from an addon that is gone.
 */
export function metaKey(type: string, id: string, addons: InstalledAddon[]) {
  return JSON.stringify([type, id, ...addons.map((addon) => addon.transportUrl)]);
}

/** Cache key for one addon's streams for a movie or episode. */
export function streamsKey(transportUrl: string, type: string, id: string) {
  return JSON.stringify([transportUrl, type, id]);
}

export type StreamSource =
  { kind: 'playable'; url: string } | { kind: 'unavailable'; reason: string };

/**
 * What Kiro can do with a stream. Only direct https URLs play; torrents (which
 * Kiro doesn't support), YouTube and external links are listed but never
 * opened.
 */
export function classifyStream(stream: Stream): StreamSource {
  if (stream.url) {
    return stream.url.startsWith('https://')
      ? { kind: 'playable', url: stream.url }
      : { kind: 'unavailable', reason: 'Insecure (http) streams aren’t supported' };
  }
  if (stream.infoHash) return { kind: 'unavailable', reason: 'Torrents aren’t supported' };
  if (stream.ytId) return { kind: 'unavailable', reason: 'YouTube isn’t supported yet' };
  return { kind: 'unavailable', reason: 'Opens outside Kiro — not supported' };
}

export interface Season {
  /** `0` holds specials. */
  number: number;
  episodes: Video[];
}

/**
 * A series' videos grouped by season (specials last), each sorted by episode.
 * Videos without a season number are left out: they can't be placed.
 */
export function groupSeasons(videos: Video[]): Season[] {
  const seasons = new Map<number, Video[]>();
  for (const video of videos) {
    if (video.season === undefined) continue;
    const episodes = seasons.get(video.season) ?? [];
    episodes.push(video);
    seasons.set(video.season, episodes);
  }
  return [...seasons]
    .map(([number, episodes]) => ({
      number,
      episodes: episodes.sort(
        (a, b) => (a.episode ?? Infinity) - (b.episode ?? Infinity) || a.id.localeCompare(b.id),
      ),
    }))
    .sort((a, b) => (a.number === 0 ? 1 : b.number === 0 ? -1 : a.number - b.number));
}

/** Where to start watching a series. */
export interface NextEpisode {
  video: Video;
  /** Whether it has unfinished progress to resume. */
  resume: boolean;
}

/**
 * The episode a series' Play button starts: the latest played episode if it
 * is unfinished, the one after it if it is finished, otherwise the first
 * episode. Specials are skipped unless there is nothing else.
 *
 * `progress` is the title's saved progress, newest first.
 */
export function nextEpisode(
  seasons: Season[],
  progress: readonly { video: { id: string }; completed: boolean }[],
): NextEpisode | undefined {
  const episodes = watchOrder(seasons);
  const latest = progress.find((entry) => episodes.some((video) => video.id === entry.video.id));
  if (latest) {
    const index = episodes.findIndex((video) => video.id === latest.video.id);
    const current = episodes[index];
    if (current && !latest.completed) return { video: current, resume: true };
    const following = episodes[index + 1];
    if (following) return { video: following, resume: false };
  }
  const first = episodes[0];
  return first && { video: first, resume: false };
}

/**
 * The episode after `videoId` in viewing order (what plays next when it
 * ends), or undefined after the last one. Specials are skipped unless the
 * series has nothing else, as for {@link nextEpisode}.
 */
export function episodeAfter(seasons: Season[], videoId: string): Video | undefined {
  const episodes = watchOrder(seasons);
  const index = episodes.findIndex((video) => video.id === videoId);
  return index >= 0 ? episodes[index + 1] : undefined;
}

/** Every episode in viewing order: regular seasons in order, specials only if alone. */
export function watchOrder(seasons: Season[]): Video[] {
  const regular = seasons.filter((season) => season.number !== 0);
  return (regular.length > 0 ? regular : seasons).flatMap((season) => season.episodes);
}

/** What the library records for playing an episode of `title`. */
export function episodeMedia(title: LibraryTitle, video: Video): PlaybackMedia {
  return { title, video: librarySnapshot(video) };
}

/** What the library records about an episode. */
export function librarySnapshot(video: Video): LibraryVideo {
  return {
    id: video.id,
    season: video.season ?? null,
    episode: video.episode ?? null,
    name: video.title?.trim() || video.name?.trim() || null,
  };
}

/** What the library records for playing a film: the film itself. */
export function movieMedia(title: LibraryTitle): PlaybackMedia {
  return { title, video: { id: title.id, season: null, episode: null, name: null } };
}

/** e.g. `S1 E2 · Pilot`, or `Special 3 · Behind the scenes`. */
export function episodeLabel(video: Video): string {
  const name = video.title ?? video.name;
  const number =
    video.season === 0
      ? `Special ${video.episode ?? ''}`.trim()
      : `S${video.season ?? '?'} E${video.episode ?? '?'}`;
  return name ? `${number} · ${name}` : number;
}

/** The year part of a release string such as `2011–2019` or `2010-07-16T…`. */
export function releaseYear(value: string | undefined): string | undefined {
  return value?.match(/^\d{4}(?:\s*[–-]\s*(?:\d{4})?)?(?!\d)/)?.[0].replace(/\s+/g, '');
}
