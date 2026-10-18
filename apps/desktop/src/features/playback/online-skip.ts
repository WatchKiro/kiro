/**
 * Skip intro for files without chapters: an episode's intro and credits times
 * looked up online (SkipDB, through the core's `skip_times_lookup`), when the
 * setting is on and the file's own chapters mark nothing to skip.
 *
 * The core only returns times recorded on a file of about the same length
 * (within 15 s; another release is cut differently), trimmed to what is the
 * part whichever end of the file the difference is at, and drops anything
 * outside the file. Here the
 * result is treated as untrusted once more, then held to the same rules as
 * chapters (`externalSkipSegments`). Chapter-derived parts always win: when
 * the file has any, nothing is looked up.
 */
import {
  externalSkipSegments,
  type ChapterRole,
  type OnlineLookup,
  type SkipSegment,
} from '@/features/playback/chapter-skip';
import type { PlaybackMedia } from '@/features/playback/playback-request';
import type { SkipTimes } from '@/services/native';

/** What is looked up: an episode of a series, by its IMDb id. */
export interface EpisodeRef {
  imdbId: string;
  season: number;
  episode: number;
}

/** A Stremio video id: `tt0903747:2:4` (IMDb id, season, episode). */
const VIDEO_ID = /^(tt\d{7,10}):(\d{1,3}):(\d{1,4})$/;
const IMDB_ID = /^tt\d{7,10}$/;

/**
 * The episode a stream plays, if it can be looked up: a regular episode
 * (specials, season 0, are numbered too differently between databases) of a
 * series with an IMDb id. Prefers the video id, which names all three.
 */
export function episodeRef(media: PlaybackMedia | undefined): EpisodeRef | null {
  if (!media) return null;
  const match = VIDEO_ID.exec(media.video.id);
  const ref: EpisodeRef | null = match
    ? { imdbId: match[1] ?? '', season: Number(match[2]), episode: Number(match[3]) }
    : IMDB_ID.test(media.title.id) && media.video.season !== null && media.video.episode !== null
      ? { imdbId: media.title.id, season: media.video.season, episode: media.video.episode }
      : null;
  return ref &&
    Number.isInteger(ref.season) &&
    ref.season >= 1 &&
    ref.season <= 999 &&
    Number.isInteger(ref.episode) &&
    ref.episode >= 1 &&
    ref.episode <= 9999
    ? ref
    : null;
}

const KINDS: readonly ChapterRole[] = ['intro', 'recap', 'credits', 'preview'];
/** More than any episode has; a longer list is not the core's. */
const MAX_TIMES = 16;
/** How far off a recorded file may be for its times to be used (`skip_times`). */
const MAX_OFFSET = 15;
/** Other releases' lengths shown, at most, and the longest believable (6 h). */
const MAX_OTHER_LENGTHS = 4;
const MAX_LENGTH = 6 * 60 * 60;
/** The source is shown as is, so only a short plain name is accepted. */
const SOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9 .-]{0,31}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `skip_times_lookup`'s result, or `null` if it is not one. */
export function parseSkipTimes(value: unknown): SkipTimes | null {
  if (!isRecord(value)) return null;
  const { source, segments, unmatched } = value;
  if (typeof source !== 'string' || !SOURCE_NAME.test(source)) return null;
  if (!Array.isArray(segments) || segments.length > MAX_TIMES) return null;
  const parsed: SkipTimes['segments'] = [];
  for (const segment of segments) {
    if (!isRecord(segment)) return null;
    const { kind, start, end, offset = 0 } = segment;
    if (typeof kind !== 'string' || !KINDS.includes(kind as ChapterRole)) return null;
    if (typeof start !== 'number' || typeof end !== 'number') return null;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (typeof offset !== 'number' || !(Math.abs(offset) <= MAX_OFFSET)) return null;
    parsed.push({ kind: kind as ChapterRole, start, end, offset });
  }
  const lengths = Array.isArray(value.otherLengths) ? value.otherLengths : [];
  const otherLengths = lengths
    .filter(
      (length): length is number => typeof length === 'number' && length > 0 && length < MAX_LENGTH,
    )
    .slice(0, MAX_OTHER_LENGTHS);
  return {
    source,
    segments: parsed,
    otherLengths,
    unmatched:
      Number.isSafeInteger(unmatched) && (unmatched as number) >= 0 ? (unmatched as number) : 0,
  };
}

/**
 * Whether to look up a file's times: the setting is on, the stream is an
 * episode with an IMDb id, the file has loaded (so its chapters and duration
 * are known) and its chapters mark nothing to skip.
 */
export function shouldLookUp({
  enabled,
  episode,
  loaded,
  duration,
  chapterSegments,
}: {
  enabled: boolean;
  episode: EpisodeRef | null;
  loaded: boolean;
  duration: number | null;
  chapterSegments: readonly SkipSegment[];
}): boolean {
  return (
    enabled &&
    episode !== null &&
    loaded &&
    duration !== null &&
    duration > 0 &&
    chapterSegments.length === 0
  );
}

/** A lookup's outcome, while it runs and after. */
export type LookupResult =
  { state: 'looking' } | { state: 'failed' } | { state: 'done'; times: SkipTimes };

/** Where the parts to skip came from, and what the stats overlay says about it. */
export interface SkipParts {
  segments: SkipSegment[];
  /** Absent when nothing was looked up (chapters decided, or the setting is off). */
  online?: OnlineLookup;
}

/** Shown while looking up, and if the core never says. */
const DEFAULT_SOURCE = 'SkipDB';

/**
 * The parts to skip: the file's own whenever its chapters mark any, otherwise
 * what a lookup found (made to follow the chapter rules), otherwise none.
 */
export function chooseSkipParts(
  chapterSegments: SkipSegment[],
  lookup: LookupResult | null,
  duration: number | null,
): SkipParts {
  if (chapterSegments.length > 0 || lookup === null) return { segments: chapterSegments };
  if (lookup.state === 'looking') {
    return { segments: [], online: { state: 'looking', source: DEFAULT_SOURCE } };
  }
  if (lookup.state === 'failed') {
    return { segments: [], online: { state: 'failed', source: DEFAULT_SOURCE } };
  }
  const { source } = lookup.times;
  const segments = externalSkipSegments(lookup.times.segments, duration);
  // How far the recorded file's length was from this one's (the largest, if
  // the parts come from different recordings): the parts were trimmed for it.
  const offset = lookup.times.segments.reduce(
    (largest, { offset }) => (Math.abs(offset) > Math.abs(largest) ? offset : largest),
    0,
  );
  return segments.length > 0
    ? { segments, online: { state: 'found', source, offset } }
    : {
        segments,
        online: {
          state: 'none',
          source,
          // Times it had for this episode, from other cuts or implausible here.
          otherReleases: lookup.times.unmatched > 0 || lookup.times.segments.length > 0,
          otherLengths: lookup.times.otherLengths,
          fileLength: duration,
        },
      };
}
