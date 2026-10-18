import type { Stream } from './resources';

/** Where a release comes from, roughly best to worst. */
export type StreamSource = 'remux' | 'bluray' | 'web' | 'tv' | 'dvd' | 'cam';

export type VideoCodec = 'hevc' | 'av1' | 'h264' | 'vp9' | 'xvid';

/**
 * Quality facts read from a stream's free-form text. Every field is a best
 * guess: addons format names however they like, so anything not recognised is
 * left out rather than guessed.
 */
export interface StreamQuality {
  /** Vertical resolution, e.g. `2160` for 4K. */
  resolution?: number;
  /** HDR10, HDR10+, HLG or unspecified HDR. */
  hdr: boolean;
  dolbyVision: boolean;
  codec?: VideoCodec;
  source?: StreamSource;
  atmos: boolean;
  /** The most audio channels mentioned, e.g. `7.1`. */
  channels?: string;
  /** File size in bytes. */
  size?: number;
  /**
   * Whether a debrid service has the file ready to play (`[TB+]`, ⚡, "cached",
   * "instant"), or is still to download it (`[TB download]`, ⏳, "uncached").
   * Unknown for streams that say neither.
   */
  cached?: boolean;
  /** ISO 639-1 codes of the languages mentioned: flags first, then names. */
  languages: string[];
  /** Mentions several audio languages ("Multi", "Dual audio"). */
  multiAudio: boolean;
}

/** Reads {@link StreamQuality} from a stream's name, description and hints. */
export function parseStreamQuality(stream: Stream): StreamQuality {
  const name = stream.name ?? '';
  const details = [stream.description, stream.title, stream.behaviorHints?.filename]
    .filter(Boolean)
    .join('\n');
  const text = `${name}\n${details}`;
  // The addon's own label wins over whatever the release name says.
  const resolution = parseResolution(name) ?? parseResolution(details);
  const videoSize = stream.behaviorHints?.videoSize;

  const quality: StreamQuality = {
    hdr: HDR.test(text),
    dolbyVision: DOLBY_VISION.test(text),
    atmos: ATMOS.test(text),
    languages: parseLanguages(text),
    multiAudio: MULTI_AUDIO.test(text),
  };
  if (resolution !== undefined) quality.resolution = resolution;
  const codec = firstMatch(CODECS, text);
  if (codec) quality.codec = codec;
  const source = firstMatch(SOURCES, text);
  if (source) quality.source = source;
  const channels = parseChannels(text);
  if (channels) quality.channels = channels;
  const size = videoSize && videoSize > 0 ? videoSize : parseSize(text);
  if (size !== undefined) quality.size = size;
  const cached = parseCached(`${name}\n${stream.description ?? ''}\n${stream.title ?? ''}`);
  if (cached !== undefined) quality.cached = cached;
  return quality;
}

/**
 * A pattern that only matches as a whole token. Release names separate words
 * with dots, dashes, underscores, brackets and pipes as often as with spaces,
 * so a "word" boundary is anything that isn't a letter or digit.
 */
function token(pattern: string) {
  return new RegExp(`(?<![a-z0-9])(?:${pattern})(?![a-z0-9])`, 'i');
}

const RESOLUTIONS: [number, RegExp][] = [
  [2160, token('2160[pi]?|4k|uhd|3840\\s*x\\s*2160')],
  [1440, token('1440[pi]?|2k|qhd')],
  [1080, token('1080[pi]|fhd|full\\s*hd|1920\\s*x\\s*1080')],
  [720, token('720[pi]|1280\\s*x\\s*720')],
  [576, token('576[pi]')],
  [480, token('480[pi]|sd')],
  [360, token('360[pi]')],
];

function parseResolution(text: string): number | undefined {
  return RESOLUTIONS.find(([, pattern]) => pattern.test(text))?.[0];
}

// `HDRip` is a rip from an HD source, not HDR video: tokens rule it out.
const HDR = token('hdr(?:10)?(?:\\+|plus)?|hlg');
const DOLBY_VISION = token('dv|dovi|dolby[\\s._-]?vision');
const ATMOS = token('atmos');

const CODECS: [VideoCodec, RegExp][] = [
  ['hevc', token('[xh][\\s.]?265|hevc')],
  ['av1', token('av1')],
  ['h264', token('[xh][\\s.]?264|avc')],
  ['vp9', token('vp9')],
  ['xvid', token('xvid|divx')],
];

// Checked in order: a "BluRay REMUX" is a remux, a "HDCAM" is a cam.
const SOURCES: [StreamSource, RegExp][] = [
  ['cam', token('cam(?:rip)?|hd-?cam|hd-?ts|telesync|telecine|hd-?tc|(?:dvd)?scr|screener')],
  ['remux', token('(?:bd|uhd)?remux')],
  ['bluray', token('blu-?ray|bd-?rip|br-?rip|bdmv')],
  ['web', token('web(?:-?dl|-?rip)?|amzn|nf|dsnp|atvp|hmax')],
  ['tv', token('hdtv|pdtv|sdtv')],
  ['dvd', token('dvd(?:rip|r|5|9)?')],
];

function firstMatch<T>(patterns: [T, RegExp][], text: string): T | undefined {
  return patterns.find(([, pattern]) => pattern.test(text))?.[0];
}

/**
 * Channel layouts such as `5.1` in `DDP5.1` or `TrueHD 7.1`. A number followed
 * by a size unit (`2.0 GB`) is a size, not a layout.
 */
const CHANNELS = /(?<!\d|\d[.,])([2567])[.,]([01])(?!\d|[.,]\d\d|\s*[KMGT]i?B)/gi;

function parseChannels(text: string): string | undefined {
  let best: string | undefined;
  for (const [, main = '', lfe = ''] of text.matchAll(CHANNELS)) {
    const layout = `${main}.${lfe}`;
    if (!best || Number(layout) > Number(best)) best = layout;
  }
  return best;
}

const SIZE = /(?<![\d.,])(\d{1,5}(?:[.,]\d{1,3})?)\s*(TB|TiB|GB|GiB|MB|MiB)(?![a-z])/i;
const UNITS: Record<string, number> = {
  tb: 1e12,
  tib: 2 ** 40,
  gb: 1e9,
  gib: 2 ** 30,
  mb: 1e6,
  mib: 2 ** 20,
};

/** The first size mentioned, e.g. `💾 18.4 GB` or `Size: 700MB`. */
function parseSize(text: string): number | undefined {
  const match = SIZE.exec(text);
  if (!match) return undefined;
  const value = Number((match[1] ?? '').replace(',', '.'));
  const unit = UNITS[(match[2] ?? '').toLowerCase()];
  return unit && value > 0 ? Math.round(value * unit) : undefined;
}

// Debrid services: RealDebrid, TorBox, AllDebrid, Premiumize, Debrid-Link,
// EasyDebrid, Offcloud, put.io… as Torrentio, Comet and MediaFusion tag them.
const UNCACHED = [
  /\[[a-z]{2,8}\s*(?:download|⬇️?|⏳)\s*\]/i,
  /⏳/u,
  /⬇/u,
  token('un-?cached|not\\s+cached'),
  /cached\s*[:=]\s*(?:no|false)\b/i,
];
const CACHED = [
  /\[[a-z]{2,8}\s*(?:\+|⚡️?)\s*\]/i,
  /⚡/u,
  token('cached|instant(?:ly)?(?:\\s+available)?'),
];

function parseCached(text: string): boolean | undefined {
  if (UNCACHED.some((pattern) => pattern.test(text))) return false;
  if (CACHED.some((pattern) => pattern.test(text))) return true;
  return undefined;
}

const MULTI_AUDIO = token('multi(?:[\\s._-]?(?:audio|lang|language)s?)?|dual[\\s._-]?audio');

/** Flags (regional indicator pairs) of countries, by the language they stand for. */
const FLAG_LANGUAGES: Record<string, string> = {
  GB: 'en',
  US: 'en',
  AU: 'en',
  CA: 'en',
  FR: 'fr',
  DE: 'de',
  AT: 'de',
  ES: 'es',
  MX: 'es',
  AR: 'es',
  IT: 'it',
  PT: 'pt',
  BR: 'pt',
  NL: 'nl',
  PL: 'pl',
  RU: 'ru',
  UA: 'uk',
  JP: 'ja',
  KR: 'ko',
  CN: 'zh',
  TW: 'zh',
  HK: 'zh',
  IN: 'hi',
  TR: 'tr',
  SE: 'sv',
  NO: 'no',
  DK: 'da',
  FI: 'fi',
  GR: 'el',
  CZ: 'cs',
  HU: 'hu',
  RO: 'ro',
  IL: 'he',
  SA: 'ar',
  AE: 'ar',
  TH: 'th',
  VN: 'vi',
  ID: 'id',
};

const LANGUAGE_WORDS: [string, RegExp][] = [
  ['en', token('english|eng')],
  ['fr', token('french|fran[cç]ais|vff|vfq|truefrench')],
  ['de', token('german|deutsch|ger')],
  ['es', token('spanish|espa[nñ]ol|castellano|latino|spa')],
  ['it', token('italian|italiano|ita')],
  ['pt', token('portuguese|portugu[eê]s|por')],
  ['nl', token('dutch')],
  ['pl', token('polish|polski|pol')],
  ['ru', token('russian|rus')],
  ['uk', token('ukrainian|ukr')],
  ['ja', token('japanese|jpn')],
  ['ko', token('korean|kor')],
  ['zh', token('chinese|mandarin|cantonese|chi')],
  ['hi', token('hindi|hin')],
  ['ta', token('tamil|tam')],
  ['te', token('telugu|tel')],
  ['tr', token('turkish|tur')],
  ['ar', token('arabic|ara')],
  ['sv', token('swedish|swe')],
];

const FLAG = /([\u{1F1E6}-\u{1F1FF}])([\u{1F1E6}-\u{1F1FF}])/gu;
const REGIONAL_A = 0x1f1e6;

function parseLanguages(text: string): string[] {
  const found: string[] = [];
  const add = (code: string | undefined) => {
    if (code && !found.includes(code)) found.push(code);
  };
  for (const [, first = '', second = ''] of text.matchAll(FLAG)) {
    const country = [first, second]
      .map((char) => String.fromCharCode(65 + (char.codePointAt(0) ?? 0) - REGIONAL_A))
      .join('');
    add(FLAG_LANGUAGES[country]);
  }
  for (const [code, pattern] of LANGUAGE_WORDS) {
    if (pattern.test(text)) add(code);
  }
  return found;
}
