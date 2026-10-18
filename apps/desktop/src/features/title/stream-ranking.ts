import { parseStreamQuality, type Stream, type StreamQuality } from '@kiro/addon-sdk';

import type { InstalledAddon } from '@/features/addons/addons-store';
import {
  streamPlaybackRequest,
  type PlaybackArtwork,
  type PlaybackMedia,
  type PlaybackRequest,
} from '@/features/playback/playback-request';
import { classifyStream } from '@/features/title/title-data';
import type { StreamSettings } from '@/services/native';

/** One addon's answer for a movie or episode, in install order. */
export interface AddonStreams {
  addon: InstalledAddon;
  streams: Stream[];
}

export interface RankedStream {
  stream: Stream;
  addon: InstalledAddon;
  /** Position in the addon's own list. */
  index: number;
  /** The https URL to play. */
  url: string;
  quality: StreamQuality;
}

export interface UnplayableStream {
  stream: Stream;
  addon: InstalledAddon;
  /** Position in the addon's own list. */
  index: number;
  reason: string;
}

/** A playable stream the stream settings filter out: listed, never picked. */
export interface FilteredStream extends RankedStream {
  /** Why, for the list, e.g. `CAM`, `Over 20 GB`, `AV1`, `“YIFY”`. */
  reasons: string[];
}

export interface StreamRanking {
  /** Best first: `playable[0]` is what Play starts. */
  playable: RankedStream[];
  /** Playable streams the filters exclude, ranked the same way. */
  filtered: FilteredStream[];
  /** Listed after the playable ones, in addon order. */
  unplayable: UnplayableStream[];
}

export interface RankingOptions extends StreamSettings {
  /**
   * The viewer's languages (ISO 639-1). A stream that names only other
   * languages goes after those that name one of these, or none.
   */
  languages?: readonly string[];
}

/**
 * Orders the streams Kiro can play, best first. In order of importance:
 * cached on a debrid service (when preferred), not a cam recording, in a
 * language the viewer speaks, the highest resolution up to the preferred
 * maximum, HDR (or SDR), a sensible file size for the resolution, the source,
 * audio, codec, and the larger file. Remaining ties keep addon order (the
 * user's addon priority), then the addon's own order, so the result is
 * always the same for the same input.
 *
 * Streams the filters exclude ({@link filterReasons}) are ranked the same
 * way but kept apart in `filtered`, so they can still be listed and chosen.
 */
export function rankStreams(groups: AddonStreams[], options: RankingOptions): StreamRanking {
  const candidates: (FilteredStream & { score: number[]; order: number })[] = [];
  const unplayable: UnplayableStream[] = [];
  const keywords = keywordPatterns(options.excludedKeywords);
  let order = 0;
  for (const { addon, streams } of groups) {
    for (const [index, stream] of streams.entries()) {
      const source = classifyStream(stream);
      if (source.kind === 'unavailable') {
        unplayable.push({ stream, addon, index, reason: source.reason });
        continue;
      }
      const quality = parseStreamQuality(stream);
      candidates.push({
        stream,
        addon,
        index,
        url: source.url,
        quality,
        reasons: filterReasons(stream, quality, options, keywords),
        score: streamScore(quality, options),
        order: order++,
      });
    }
  }
  candidates.sort((a, b) => compareScores(b.score, a.score) || a.order - b.order);
  const ranked = candidates.map(({ score: _score, order: _order, ...stream }) => stream);
  return {
    playable: ranked
      .filter(({ reasons }) => reasons.length === 0)
      .map(({ reasons: _reasons, ...stream }) => stream),
    filtered: ranked.filter(({ reasons }) => reasons.length > 0),
    unplayable,
  };
}

/** The settings that filter streams out. */
export type StreamFilters = Pick<
  StreamSettings,
  'excludeCam' | 'maxSizeGb' | 'avoidCodecs' | 'excludedKeywords'
>;

/**
 * Why the stream settings filter out a stream, or nothing when they don't:
 * a cam, telesync or screener release, a file over the maximum size (an
 * unknown size passes), a codec to avoid, or an excluded keyword anywhere in
 * the stream's name, description or file name (as a whole word, ignoring
 * case; a space also matches `.`, `-` and `_`).
 */
export function filterReasons(
  stream: Stream,
  quality: StreamQuality,
  filters: StreamFilters,
  keywords = keywordPatterns(filters.excludedKeywords),
): string[] {
  const reasons: string[] = [];
  if (filters.excludeCam && quality.source === 'cam') reasons.push('CAM');
  if (
    filters.maxSizeGb !== null &&
    quality.size !== undefined &&
    quality.size > filters.maxSizeGb * GB
  ) {
    reasons.push(`Over ${filters.maxSizeGb} GB`);
  }
  if (quality.codec && (filters.avoidCodecs as string[]).includes(quality.codec)) {
    reasons.push(quality.codec === 'hevc' ? 'HEVC' : quality.codec.toUpperCase());
  }
  if (keywords.length > 0) {
    const text = [
      stream.name,
      stream.description,
      stream.title,
      stream.behaviorHints?.filename,
    ].join('\n');
    for (const { keyword, pattern } of keywords) {
      if (pattern.test(text)) reasons.push(`“${keyword}”`);
    }
  }
  return reasons;
}

/**
 * Whole-word, case-insensitive patterns for keywords. As in release names, a
 * word boundary is anything that isn't a letter or digit, so `HC` matches
 * `Film.HC.1080p` but not `HCAM`.
 */
function keywordPatterns(keywords: readonly string[]) {
  return keywords.map((keyword) => {
    // Spaces also match the dots, dashes and underscores of release names.
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s._-]+');
    return {
      keyword,
      pattern: new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu'),
    };
  });
}

/**
 * How long one-click Play, and Up next when it falls back to the best-ranked
 * stream, wait for every stream addon before settling for a good stream that
 * has already arrived (`readyToStart`).
 */
export const STREAM_BUDGET_MS = 4000;

/**
 * Whether `choice` is good enough to start without waiting for the addons
 * still answering: cached on a debrid service (so it starts at once), at a
 * known resolution within the preferred maximum, not a cam recording, and in
 * a language the viewer speaks.
 */
export function goodEnoughToStart(
  { quality }: Pick<RankedStream, 'quality'>,
  options: RankingOptions,
): boolean {
  return (
    quality.cached === true &&
    quality.resolution !== undefined &&
    quality.resolution <= options.maxResolution &&
    quality.source !== 'cam' &&
    speaksLanguage(quality, options.languages)
  );
}

/**
 * Whether Play can act on `ranking` now: start `playable[0]`, or show the
 * list when there is none. That is once every addon has answered
 * (`settled`), or, once the time budget is spent, as soon as the best stream
 * so far is good enough to start. Until then a slower addon may still have
 * something better, so Play keeps waiting.
 */
export function readyToStart(
  ranking: StreamRanking,
  settled: boolean,
  budgetSpent: boolean,
  options: RankingOptions,
): boolean {
  if (settled) return true;
  const best = ranking.playable[0];
  return budgetSpent && best !== undefined && goodEnoughToStart(best, options);
}

/** Higher is better, compared element by element. */
export function streamScore(quality: StreamQuality, options: RankingOptions): number[] {
  const { resolution, size } = quality;
  const max = options.maxResolution;
  const fits = resolution === undefined ? 1 : resolution <= max ? 2 : 0;
  return [
    options.preferCached ? (quality.cached === true ? 2 : quality.cached === false ? 0 : 1) : 0,
    quality.source === 'cam' ? 0 : 1,
    speaksLanguage(quality, options.languages) ? 1 : 0,
    // Within the maximum, higher is better; above it, the closer the better.
    fits,
    resolution === undefined ? 0 : fits === 2 ? resolution : -resolution,
    dynamicRangeScore(quality, options.preferHdr),
    size === undefined || sensibleSize(size, resolution) ? 1 : 0,
    SOURCE_SCORES[quality.source ?? 'unknown'],
    quality.atmos ? 1 : 0,
    Number(quality.channels ?? 0),
    CODEC_SCORES[quality.codec ?? 'unknown'],
    size ?? 0,
  ];
}

function compareScores(a: number[], b: number[]) {
  for (let index = 0; index < a.length; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function speaksLanguage(quality: StreamQuality, languages: readonly string[] = []) {
  if (languages.length === 0 || quality.languages.length === 0 || quality.multiAudio) return true;
  return quality.languages.some((language) => languages.includes(language));
}

/**
 * HDR10 first when HDR is preferred: Dolby Vision alone (profile 5) needs a
 * player and display that handle it, so it comes after.
 */
function dynamicRangeScore({ hdr, dolbyVision }: StreamQuality, preferHdr: boolean) {
  if (!preferHdr) return hdr || dolbyVision ? 0 : 1;
  return hdr ? 2 : dolbyVision ? 1 : 0;
}

const GB = 1e9;

/**
 * Sizes that suit a resolution: below the range is likely a fake or a
 * sample, above it (an 80 GB remux) may not stream smoothly.
 */
const SIZE_RANGES: [minResolution: number, min: number, max: number][] = [
  [2160, 1 * GB, 40 * GB],
  [1080, 0.3 * GB, 20 * GB],
  [720, 0.15 * GB, 8 * GB],
  [0, 0.05 * GB, 4 * GB],
];

export function sensibleSize(size: number, resolution: number | undefined) {
  if (resolution === undefined) return size >= 0.05 * GB && size <= 60 * GB;
  const [, min, max] = SIZE_RANGES.find(([minimum]) => resolution >= minimum) ?? [0, 0, Infinity];
  return size >= min && size <= max;
}

const SOURCE_SCORES: Record<NonNullable<StreamQuality['source']> | 'unknown', number> = {
  remux: 4,
  bluray: 3,
  web: 2,
  unknown: 2,
  tv: 1,
  dvd: 1,
  cam: 0,
};

const CODEC_SCORES: Record<NonNullable<StreamQuality['codec']> | 'unknown', number> = {
  hevc: 3,
  av1: 2,
  h264: 2,
  unknown: 1,
  vp9: 1,
  xvid: 0,
};

/** Short labels for a stream's quality, most important first. */
export function qualityBadges(quality: StreamQuality): string[] {
  return [
    resolutionLabel(quality.resolution),
    quality.dolbyVision ? 'DV' : undefined,
    quality.hdr ? 'HDR' : undefined,
    quality.atmos
      ? 'Atmos'
      : quality.channels && quality.channels !== '2.0'
        ? quality.channels
        : undefined,
    quality.source === 'remux' ? 'Remux' : quality.source === 'cam' ? 'CAM' : undefined,
    quality.size === undefined ? undefined : formatSize(quality.size),
  ].filter((badge): badge is string => badge !== undefined);
}

export function resolutionLabel(resolution: number | undefined) {
  if (resolution === undefined) return undefined;
  return resolution >= 2160 ? '4K' : `${resolution}p`;
}

/** e.g. `18.4 GB`, `700 MB`. */
export function formatSize(bytes: number) {
  return bytes >= GB
    ? `${(bytes / GB).toFixed(1)} GB`
    : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

/**
 * One line naming the chosen stream for the player's opening screen, e.g.
 * `Torrentio · 4K · DV · HDR · Atmos · 18.4 GB · Cached`.
 */
export function describeStream({ addon, quality }: Pick<RankedStream, 'addon' | 'quality'>) {
  return [addon.manifest.name, ...qualityBadges(quality), quality.cached ? 'Cached' : undefined]
    .filter(Boolean)
    .join(' · ');
}

/**
 * What the player needs to open `choice` for a title or episode: the stream
 * list's request (with the addon and binge group, for Up next) plus a label
 * naming the stream on the opening screen.
 */
export function rankedPlaybackRequest(
  choice: Pick<RankedStream, 'stream' | 'addon' | 'url' | 'quality'>,
  context: { title: string; subtitle?: string; media?: PlaybackMedia; artwork?: PlaybackArtwork },
): PlaybackRequest {
  const { stream, addon, url } = choice;
  return {
    ...streamPlaybackRequest({ url, stream, addon, ...context }),
    streamLabel: describeStream(choice),
  };
}
