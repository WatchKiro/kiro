import type { Stream } from '@kiro/addon-sdk';

import {
  parseAddonSubtitles,
  toAddonSubtitles,
  MAX_STREAM_SUBTITLES,
  type AddonSubtitle,
  type StreamFile,
} from '@/features/playback/addon-subtitles';
import type { LibraryTitle, LibraryVideo } from '@/services/native';
import type { NowPlaying } from '@/services/player';

/** What is being played, for the library (progress and "Continue watching"). */
export interface PlaybackMedia {
  title: LibraryTitle;
  video: LibraryVideo;
}

/** Title artwork shown while the stream opens. Only https URLs are kept. */
export interface PlaybackArtwork {
  background?: string;
  logo?: string;
}

/**
 * Where the stream came from, so the next episode can be played from the same
 * addon and release (Stremio's `behaviorHints.bingeGroup`).
 */
export interface PlaybackSource {
  /** The addon's transport URL. */
  addon: string;
  bingeGroup?: string;
}

/**
 * What the player should open, handed over in router state (`navigate('/player',
 * { state })`) so stream URLs never appear in the address or the query string.
 */
export interface PlaybackRequest {
  /** An https stream URL. */
  url: string;
  title: string;
  /** e.g. the episode, or the addon and stream name. */
  subtitle?: string;
  /** The chosen stream's addon and quality, shown while it opens. */
  streamLabel?: string;
  /** Present when the stream belongs to a title, so progress can be saved. */
  media?: PlaybackMedia;
  /** Backdrop and logo for the opening screen. */
  artwork?: PlaybackArtwork;
  /** The addon and binge group the stream came from. */
  source?: PlaybackSource;
  /** Subtitles that come with the stream (`stream.subtitles`). */
  subtitles?: AddonSubtitle[];
  /** The stream's file name and size, for subtitle addons to match. */
  file?: StreamFile;
}

/**
 * The request for playing `stream` from `addon` (a stream list's Play, or
 * Up next): the subtitle names the episode, the addon and the stream.
 */
export function streamPlaybackRequest({
  url,
  stream,
  addon,
  title,
  subtitle,
  media,
  artwork,
}: {
  url: string;
  stream: Stream;
  addon: { transportUrl: string; manifest: { name: string } };
  title: string;
  subtitle?: string;
  media?: PlaybackMedia;
  artwork?: PlaybackArtwork;
}): PlaybackRequest {
  const name = stream.name?.split('\n')[0]?.trim();
  const { bingeGroup, filename, videoSize } = stream.behaviorHints ?? {};
  const subtitles = toAddonSubtitles(
    stream.subtitles ?? [],
    addon.manifest.name,
    MAX_STREAM_SUBTITLES,
  );
  const file = parseStreamFile({ filename, videoSize });
  return {
    url,
    title,
    subtitle: [subtitle, name ? `${addon.manifest.name} · ${name}` : addon.manifest.name]
      .filter(Boolean)
      .join(' — '),
    ...(media && { media }),
    ...(artwork && { artwork }),
    source: { addon: addon.transportUrl, ...(bingeGroup && { bingeGroup }) },
    ...(subtitles.length > 0 && { subtitles }),
    ...(file && { file }),
  };
}

/** Highest season or episode number passed on (`presence::MAX_EPISODE_NUMBER`). */
const MAX_EPISODE_NUMBER = 99_999;

/**
 * What Discord Rich Presence may know about `request`: the title, the
 * season and episode numbers and an https poster. Never the stream URL, its
 * addon or the subtitle line, which names both.
 */
export function nowPlayingFor(request: PlaybackRequest | null): NowPlaying | null {
  if (!request) return null;
  const { media } = request;
  const title = (media?.title.name ?? request.title).trim();
  if (title === '') return null;
  const number = (value: number | null | undefined) =>
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_EPISODE_NUMBER
      ? value
      : null;
  const poster = media?.title.poster;
  return {
    title,
    season: number(media?.video.season),
    episode: number(media?.video.episode),
    poster: poster?.startsWith('https://') ? poster : null,
  };
}

/**
 * Reads a {@link PlaybackRequest} back from router state. History state can
 * outlive the code that wrote it, so it is checked like any other input.
 */
export function parsePlaybackRequest(state: unknown): PlaybackRequest | null {
  if (!isRecord(state)) return null;
  const { url, title, subtitle, streamLabel, media, artwork, source, subtitles, file } = state;
  if (typeof url !== 'string' || typeof title !== 'string') return null;
  if (subtitle !== undefined && typeof subtitle !== 'string') return null;
  try {
    if (new URL(url).protocol !== 'https:') return null;
  } catch {
    return null;
  }
  const request: PlaybackRequest =
    subtitle === undefined ? { url, title } : { url, title, subtitle };
  // Only a label: one that doesn't check out is left out.
  if (typeof streamLabel === 'string' && streamLabel.length <= 300) {
    request.streamLabel = streamLabel;
  }
  // Media that doesn't check out only disables progress saving.
  const parsedMedia = parsePlaybackMedia(media);
  if (parsedMedia) request.media = parsedMedia;
  const parsedArtwork = parsePlaybackArtwork(artwork);
  if (parsedArtwork) request.artwork = parsedArtwork;
  const parsedSource = parsePlaybackSource(source);
  if (parsedSource) request.source = parsedSource;
  const parsedSubtitles = parseAddonSubtitles(subtitles);
  if (parsedSubtitles.length > 0) request.subtitles = parsedSubtitles;
  const parsedFile = parseStreamFile(file);
  if (parsedFile) request.file = parsedFile;
  return request;
}

/** Only passed on to subtitle addons: a short file name and a byte count. */
function parseStreamFile(value: unknown): StreamFile | null {
  if (!isRecord(value)) return null;
  const { filename, videoSize } = value;
  const file: StreamFile = {};
  if (typeof filename === 'string' && filename.trim() !== '' && filename.length <= 256) {
    file.filename = filename;
  }
  if (typeof videoSize === 'number' && Number.isSafeInteger(videoSize) && videoSize > 0) {
    file.videoSize = videoSize;
  }
  return file.filename !== undefined || file.videoSize !== undefined ? file : null;
}

/** Only used to find the addon again among the installed ones. */
function parsePlaybackSource(value: unknown): PlaybackSource | null {
  if (!isRecord(value) || typeof value.addon !== 'string') return null;
  const { addon, bingeGroup } = value;
  return typeof bingeGroup === 'string' && bingeGroup !== '' ? { addon, bingeGroup } : { addon };
}

/** Artwork comes from addon metadata: keep only https image URLs. */
function parsePlaybackArtwork(value: unknown): PlaybackArtwork | null {
  if (!isRecord(value)) return null;
  const artwork: PlaybackArtwork = {};
  for (const key of ['background', 'logo'] as const) {
    const url = value[key];
    if (typeof url === 'string' && url.startsWith('https://')) artwork[key] = url;
  }
  return artwork.background || artwork.logo ? artwork : null;
}

function parsePlaybackMedia(value: unknown): PlaybackMedia | null {
  if (!isRecord(value) || !isRecord(value.title) || !isRecord(value.video)) return null;
  const { type, id, name, poster } = value.title;
  const { id: videoId, season, episode, name: videoName } = value.video;
  if (
    typeof type !== 'string' ||
    typeof id !== 'string' ||
    typeof name !== 'string' ||
    !isNullable(poster, 'string') ||
    typeof videoId !== 'string' ||
    !isNullable(season, 'number') ||
    !isNullable(episode, 'number') ||
    !isNullable(videoName, 'string')
  ) {
    return null;
  }
  return {
    title: { type, id, name, poster },
    video: { id: videoId, season, episode, name: videoName },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNullable<T extends 'string' | 'number'>(
  value: unknown,
  type: T,
): value is (T extends 'string' ? string : number) | null {
  return value === null || typeof value === type;
}
