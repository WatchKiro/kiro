/**
 * Settings values and their validation, mirroring the core's rules
 * (`src-tauri/src/settings`) so the page can refuse a bad value before
 * saving and treat whatever comes back as untrusted.
 */
import { languageCode, languageName } from '@/features/playback/track-labels';
import type {
  CatalogRowSetting,
  GeneralSettings,
  PassthroughFormat,
  PlaybackSettings,
  RowSettings,
  Settings,
  StreamSettings,
  SubtitleSettings,
} from '@/services/native';

/** Most languages that can be listed for audio or subtitles (`MAX_LANGUAGES`). */
export const MAX_LANGUAGES = 8;

export const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
  discordPresence: false,
  discordShowTitle: true,
  discordShowEpisode: true,
};

export const DEFAULT_PLAYBACK_SETTINGS: PlaybackSettings = {
  audioLanguages: [],
  subtitleLanguages: [],
  subtitlesOff: false,
  skipIntros: false,
  onlineSkipTimes: false,
  autoplayNext: true,
  upNextSeconds: 10,
  seekSeconds: 10,
  resume: 'always',
  rememberVolume: true,
  volume: 100,
  markWatchedPercent: 90,
  keepScreenOn: true,
  seekPreviews: true,
  audioPassthrough: false,
  passthroughFormats: ['ac3', 'dts'],
};

export const DEFAULT_SUBTITLE_SETTINGS: SubtitleSettings = {
  size: 100,
  color: '#ffffff',
  edge: 'outline',
  offset: 0,
  preferredType: 'regular',
};

export const DEFAULT_STREAM_SETTINGS: StreamSettings = {
  maxResolution: 2160,
  preferHdr: true,
  preferCached: true,
  excludeCam: false,
  maxSizeGb: null,
  avoidCodecs: [],
  excludedKeywords: [],
};

export const DEFAULT_ROW_SETTINGS: RowSettings = {
  discover: null,
  movies: null,
  tvShows: null,
};

export const DEFAULT_SETTINGS: Settings = {
  general: DEFAULT_GENERAL_SETTINGS,
  playback: DEFAULT_PLAYBACK_SETTINGS,
  subtitles: DEFAULT_SUBTITLE_SETTINGS,
  streams: DEFAULT_STREAM_SETTINGS,
  rows: DEFAULT_ROW_SETTINGS,
};

/** Most rows a page's layout keeps (`MAX_LAYOUT_ROWS`). */
export const MAX_LAYOUT_ROWS = 500;

/** Up next countdown lengths, in seconds (`UP_NEXT_SECONDS`). */
export const UP_NEXT_SECONDS: PlaybackSettings['upNextSeconds'][] = [5, 10, 15, 20, 30];
/** How far ←/→ and the skip buttons can jump, in seconds (`SEEK_SECONDS`). */
export const SEEK_SECONDS: PlaybackSettings['seekSeconds'][] = [5, 10, 15, 30];
export const RESUME_MODES: { value: PlaybackSettings['resume']; label: string }[] = [
  { value: 'always', label: 'Resume' },
  { value: 'ask', label: 'Ask' },
  { value: 'never', label: 'Start over' },
];
/** Loudest remembered volume, in percent (`MAX_VOLUME_PERCENT`). */
export const MAX_VOLUME_PERCENT = 130;
/** The "mark as watched" threshold stays within this, in percent (`WATCHED_PERCENT`). */
export const WATCHED_PERCENT = { min: 70, max: 98 } as const;

/** Formats audio passthrough can send, in order (`PassthroughFormat::ALL`). */
export const PASSTHROUGH_FORMATS: { value: PassthroughFormat; label: string }[] = [
  { value: 'ac3', label: 'Dolby Digital' },
  { value: 'eac3', label: 'Dolby Digital Plus' },
  { value: 'dts', label: 'DTS' },
  { value: 'dtsHd', label: 'DTS-HD' },
  { value: 'truehd', label: 'TrueHD' },
];

/**
 * Whether the platform (`AppInfo.os`) can pass a format through, as
 * `PassthroughFormat::is_supported` decides: a Mac only sends Dolby Digital
 * and DTS. `null` (not known yet, or the browser preview): every format.
 */
export function isPassthroughAvailable(format: PassthroughFormat, os: string | null): boolean {
  return os !== 'macos' || format === 'ac3' || format === 'dts';
}

/**
 * Passthrough formats as the core keeps them: known, distinct, in
 * {@link PASSTHROUGH_FORMATS} order, and DTS-HD only with DTS (mpv's DTS-HD
 * passthrough also sends DTS cores).
 */
export function normalizePassthroughFormats(formats: readonly unknown[]): PassthroughFormat[] {
  const kept = PASSTHROUGH_FORMATS.map((format) => format.value).filter((format) =>
    formats.includes(format),
  );
  return kept.includes('dts') ? kept : kept.filter((format) => format !== 'dtsHd');
}

/**
 * `formats` with one turned on or off. DTS-HD brings DTS with it, and DTS
 * takes DTS-HD with it.
 */
export function withPassthroughFormat(
  formats: readonly PassthroughFormat[],
  format: PassthroughFormat,
  on: boolean,
): PassthroughFormat[] {
  if (on) {
    return normalizePassthroughFormats([
      ...formats,
      format,
      ...(format === 'dtsHd' ? ['dts'] : []),
    ]);
  }
  return normalizePassthroughFormats(
    formats.filter((kept) => kept !== format && !(format === 'dts' && kept === 'dtsHd')),
  );
}

/** Subtitle sizes, in percent of the player's default (`SUBTITLE_SIZES`). */
export const SUBTITLE_SIZE = { min: 50, max: 200, step: 10 } as const;
/** Highest subtitles can be raised, percent of the picture's height (`MAX_SUBTITLE_OFFSET`). */
export const MAX_SUBTITLE_OFFSET = 40;
/** Colours offered for subtitle text; any `#rrggbb` is accepted. */
export const SUBTITLE_COLORS: { value: string; label: string }[] = [
  { value: '#ffffff', label: 'White' },
  { value: '#ffe45c', label: 'Yellow' },
  { value: '#7fe3ff', label: 'Cyan' },
  { value: '#9cf59c', label: 'Green' },
];
export const SUBTITLE_EDGES: { value: SubtitleSettings['edge']; label: string }[] = [
  { value: 'outline', label: 'Outline' },
  { value: 'shadow', label: 'Shadow' },
  { value: 'background', label: 'Background' },
];
export const SUBTITLE_TYPES: { value: SubtitleSettings['preferredType']; label: string }[] = [
  { value: 'regular', label: 'Full' },
  { value: 'sdh', label: 'SDH' },
  { value: 'forced', label: 'Forced' },
];

/** Largest maximum file size, in GB (`MAX_SIZE_GB`). */
export const MAX_SIZE_GB = 500;
/** Maximum file sizes offered, in GB; `null` is no limit. */
export const MAX_SIZE_CHOICES: (number | null)[] = [null, 2, 5, 10, 20, 40];
export const AVOIDABLE_CODECS: { value: StreamSettings['avoidCodecs'][number]; label: string }[] = [
  { value: 'av1', label: 'AV1' },
  { value: 'hevc', label: 'HEVC (H.265)' },
];
/** Most keywords that can be excluded, and their longest length (`MAX_KEYWORDS`). */
export const MAX_KEYWORDS = 20;
export const MAX_KEYWORD_CHARS = 40;

/** The maximum resolutions Play can be limited to (`MAX_RESOLUTIONS`). */
export const MAX_RESOLUTIONS: { value: StreamSettings['maxResolution']; label: string }[] = [
  { value: 2160, label: '4K' },
  { value: 1080, label: '1080p' },
  { value: 720, label: '720p' },
];

/**
 * Languages offered in Settings, as ISO 639-1 codes. Track languages are
 * compared by {@link languageCode}, so `en` also matches `eng` tracks.
 */
// prettier-ignore
export const LANGUAGE_CHOICES = [
  'en', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'zh', 'ru', 'ar', 'hi', 'nl', 'sv', 'no',
  'da', 'fi', 'pl', 'tr', 'cs', 'el', 'he', 'hu', 'ro', 'th', 'vi', 'id', 'ms', 'tl', 'uk',
  'bg', 'hr', 'sr', 'sk', 'sl', 'et', 'lv', 'lt', 'fa', 'bn', 'ta', 'te', 'ca', 'is',
] as const;

/** Display name for a stored language code, e.g. `ja` → `Japanese`. */
export function languageLabel(code: string): string {
  return languageName(code) ?? code.toUpperCase();
}

/**
 * Normalises a language list for storing: comparable codes
 * ({@link languageCode}), without duplicates or unusable entries, at most
 * {@link MAX_LANGUAGES}.
 */
export function normalizeLanguages(languages: readonly unknown[]): string[] {
  const codes: string[] = [];
  for (const language of languages) {
    const code = typeof language === 'string' ? languageCode(language) : undefined;
    if (code && !codes.includes(code)) codes.push(code);
  }
  return codes.slice(0, MAX_LANGUAGES);
}

/** Whether a list is exactly what the core accepts (two or three lowercase letters, distinct). */
export function isValidLanguageList(languages: readonly string[]): boolean {
  return (
    languages.length <= MAX_LANGUAGES &&
    languages.every((code, index) => /^[a-z]{2,3}$/.test(code) && languages.indexOf(code) === index)
  );
}

/**
 * A keyword as the core stores it: trimmed, 1 to {@link MAX_KEYWORD_CHARS}
 * characters, no control characters. `null` when there's nothing usable.
 */
export function normalizeKeyword(input: string): string | null {
  const keyword = input.trim();
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  if (/[\u0000-\u001f\u007f-\u009f]/.test(keyword)) return null;
  const length = [...keyword].length;
  return length >= 1 && length <= MAX_KEYWORD_CHARS ? keyword : null;
}

/**
 * Keywords for storing: each one normalised, without duplicates (ignoring
 * case) or unusable entries, at most {@link MAX_KEYWORDS}.
 */
export function normalizeKeywords(keywords: readonly unknown[]): string[] {
  const kept: string[] = [];
  for (const entry of keywords) {
    const keyword = typeof entry === 'string' ? normalizeKeyword(entry) : null;
    if (keyword && !kept.some((other) => other.toLowerCase() === keyword.toLowerCase())) {
      kept.push(keyword);
    }
  }
  return kept.slice(0, MAX_KEYWORDS);
}

/** `#rrggbb` in lowercase, as the core accepts it. */
export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/.test(value);
}

/**
 * Reads settings from the core. Anything missing or malformed falls back to
 * its default, so a newer or damaged value never breaks playback.
 */
export function parseSettings(value: unknown): Settings {
  const section = (key: string) =>
    isRecord(value) && isRecord(value[key]) ? value[key] : undefined;
  return {
    general: parseGeneralSettings(section('general')),
    playback: parsePlaybackSettings(section('playback')),
    subtitles: parseSubtitleSettings(section('subtitles')),
    streams: parseStreamSettings(section('streams')),
    rows: parseRowSettings(section('rows')),
  };
}

/**
 * Row layouts as the core keeps them: a page whose value isn't a list has
 * the default layout; a list keeps its well-formed, distinct rows.
 */
export function parseRowSettings(value: unknown): RowSettings {
  const rows = isRecord(value) ? value : {};
  return {
    discover: parseRowLayout(rows.discover),
    movies: parseRowLayout(rows.movies),
    tvShows: parseRowLayout(rows.tvShows),
  };
}

function parseRowLayout(value: unknown): CatalogRowSetting[] | null {
  if (!Array.isArray(value)) return null;
  const kept: CatalogRowSetting[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const { addon, type, catalog, hidden } = entry;
    if (!isAddonId(addon) || !isRowText(type, 64) || !isRowText(catalog, 128)) continue;
    const key = JSON.stringify([addon, type, catalog]);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push({ addon, type, catalog, hidden: hidden === true });
  }
  return kept.slice(0, MAX_LAYOUT_ROWS);
}

function isAddonId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value);
}

/** 1 to `max` characters, none of them control characters. */
function isRowText(value: unknown, max: number): value is string {
  if (typeof value !== 'string') return false;
  const length = [...value].length;
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  return length >= 1 && length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

/** General settings, each invalid or missing value replaced by its default. */
function parseGeneralSettings(value: unknown): GeneralSettings {
  const general = isRecord(value) ? value : {};
  const defaults = DEFAULT_GENERAL_SETTINGS;
  return {
    discordPresence: flag(general.discordPresence, defaults.discordPresence),
    discordShowTitle: flag(general.discordShowTitle, defaults.discordShowTitle),
    discordShowEpisode: flag(general.discordShowEpisode, defaults.discordShowEpisode),
  };
}

/** Playback settings, each invalid or missing value replaced by its default. */
function parsePlaybackSettings(value: unknown): PlaybackSettings {
  const playback = isRecord(value) ? value : {};
  const defaults = DEFAULT_PLAYBACK_SETTINGS;
  const languages = (list: unknown) =>
    Array.isArray(list) &&
    list.every((item) => typeof item === 'string') &&
    isValidLanguageList(list)
      ? normalizeLanguages(list)
      : [];
  return {
    audioLanguages: languages(playback.audioLanguages),
    subtitleLanguages: languages(playback.subtitleLanguages),
    subtitlesOff: flag(playback.subtitlesOff, defaults.subtitlesOff),
    skipIntros: flag(playback.skipIntros, defaults.skipIntros),
    onlineSkipTimes: flag(playback.onlineSkipTimes, defaults.onlineSkipTimes),
    autoplayNext: flag(playback.autoplayNext, defaults.autoplayNext),
    upNextSeconds: oneOf(UP_NEXT_SECONDS, playback.upNextSeconds, defaults.upNextSeconds),
    seekSeconds: oneOf(SEEK_SECONDS, playback.seekSeconds, defaults.seekSeconds),
    resume: oneOf(
      RESUME_MODES.map((mode) => mode.value),
      playback.resume,
      defaults.resume,
    ),
    rememberVolume: flag(playback.rememberVolume, defaults.rememberVolume),
    volume: whole(playback.volume, 0, MAX_VOLUME_PERCENT) ?? defaults.volume,
    markWatchedPercent:
      whole(playback.markWatchedPercent, WATCHED_PERCENT.min, WATCHED_PERCENT.max) ??
      defaults.markWatchedPercent,
    keepScreenOn: flag(playback.keepScreenOn, defaults.keepScreenOn),
    seekPreviews: flag(playback.seekPreviews, defaults.seekPreviews),
    audioPassthrough: flag(playback.audioPassthrough, defaults.audioPassthrough),
    passthroughFormats: Array.isArray(playback.passthroughFormats)
      ? normalizePassthroughFormats(playback.passthroughFormats)
      : defaults.passthroughFormats,
  };
}

/** Subtitle settings, each invalid or missing value replaced by its default. */
function parseSubtitleSettings(value: unknown): SubtitleSettings {
  const subtitles = isRecord(value) ? value : {};
  const defaults = DEFAULT_SUBTITLE_SETTINGS;
  return {
    size: whole(subtitles.size, SUBTITLE_SIZE.min, SUBTITLE_SIZE.max) ?? defaults.size,
    color: isHexColor(subtitles.color) ? subtitles.color : defaults.color,
    edge: oneOf(
      SUBTITLE_EDGES.map((edge) => edge.value),
      subtitles.edge,
      defaults.edge,
    ),
    offset: whole(subtitles.offset, 0, MAX_SUBTITLE_OFFSET) ?? defaults.offset,
    preferredType: oneOf(
      SUBTITLE_TYPES.map((type) => type.value),
      subtitles.preferredType,
      defaults.preferredType,
    ),
  };
}

/** Stream settings, each invalid or missing value replaced by its default. */
function parseStreamSettings(value: unknown): StreamSettings {
  const streams = isRecord(value) ? value : {};
  const defaults = DEFAULT_STREAM_SETTINGS;
  const resolution = MAX_RESOLUTIONS.find((option) => option.value === streams.maxResolution);
  const codecs = AVOIDABLE_CODECS.map((codec) => codec.value).filter(
    (codec) => Array.isArray(streams.avoidCodecs) && streams.avoidCodecs.includes(codec),
  );
  return {
    maxResolution: resolution?.value ?? defaults.maxResolution,
    preferHdr: flag(streams.preferHdr, defaults.preferHdr),
    preferCached: flag(streams.preferCached, defaults.preferCached),
    excludeCam: flag(streams.excludeCam, defaults.excludeCam),
    maxSizeGb: whole(streams.maxSizeGb, 1, MAX_SIZE_GB) ?? null,
    avoidCodecs: codecs,
    excludedKeywords: Array.isArray(streams.excludedKeywords)
      ? normalizeKeywords(streams.excludedKeywords)
      : [],
  };
}

/** `settings` with its general section changed, normalised for saving. */
export function withGeneral(settings: Settings, patch: Partial<GeneralSettings>): Settings {
  return { ...settings, general: parseGeneralSettings({ ...settings.general, ...patch }) };
}

/** `settings` with its stream section changed, normalised for saving. */
export function withStreams(settings: Settings, patch: Partial<StreamSettings>): Settings {
  const streams = { ...settings.streams, ...patch };
  return {
    ...settings,
    streams: parseStreamSettings({
      ...streams,
      excludedKeywords: normalizeKeywords(streams.excludedKeywords),
    }),
  };
}

/** `settings` with its playback section changed, normalised for saving. */
export function withPlayback(settings: Settings, patch: Partial<PlaybackSettings>): Settings {
  const playback = { ...settings.playback, ...patch };
  return {
    ...settings,
    playback: parsePlaybackSettings({
      ...playback,
      audioLanguages: normalizeLanguages(playback.audioLanguages),
      subtitleLanguages: normalizeLanguages(playback.subtitleLanguages),
      volume: Math.round(playback.volume),
    }),
  };
}

/** `settings` with one page's catalogue rows replaced, normalised for saving. */
export function withRows(
  settings: Settings,
  page: keyof RowSettings,
  layout: CatalogRowSetting[] | null,
): Settings {
  return { ...settings, rows: { ...settings.rows, [page]: parseRowLayout(layout) } };
}

/** `settings` with its subtitle section changed, normalised for saving. */
export function withSubtitles(settings: Settings, patch: Partial<SubtitleSettings>): Settings {
  const subtitles = { ...settings.subtitles, ...patch };
  return {
    ...settings,
    subtitles: parseSubtitleSettings({ ...subtitles, color: subtitles.color.toLowerCase() }),
  };
}

/** The settings sections that can be reset on their own. */
export type SettingsSection = keyof Settings;

/** `settings` with one section back at its defaults. */
export function withDefaults(settings: Settings, section: SettingsSection): Settings {
  return { ...settings, [section]: DEFAULT_SETTINGS[section] };
}

/** Whether a section differs from its defaults. */
export function isChanged(settings: Settings, section: SettingsSection): boolean {
  return JSON.stringify(settings[section]) !== JSON.stringify(DEFAULT_SETTINGS[section]);
}

/**
 * Some fields of some sections, e.g. the playback settings that Settings →
 * Audio shows. A page of Settings can show fields from more than one section.
 */
export type SettingsFields = {
  [S in SettingsSection]?: readonly (keyof Settings[S])[];
};

/** `settings` with `fields` back at their defaults, and everything else as it was. */
export function withDefaultFields(settings: Settings, fields: SettingsFields): Settings {
  const reset = <S extends SettingsSection>(
    next: Settings,
    section: S,
    keys: readonly (keyof Settings[S])[] = [],
  ): Settings => {
    if (keys.length === 0) return next;
    const values = { ...next[section] };
    for (const key of keys) values[key] = DEFAULT_SETTINGS[section][key];
    return { ...next, [section]: values };
  };
  let next = settings;
  next = reset(next, 'general', fields.general);
  next = reset(next, 'playback', fields.playback);
  next = reset(next, 'subtitles', fields.subtitles);
  next = reset(next, 'streams', fields.streams);
  next = reset(next, 'rows', fields.rows);
  return next;
}

/** Whether any of `fields` differs from its default. */
export function areFieldsChanged(settings: Settings, fields: SettingsFields): boolean {
  const changed = <S extends SettingsSection>(
    section: S,
    keys: readonly (keyof Settings[S])[] = [],
  ): boolean =>
    keys.some(
      (key) =>
        JSON.stringify(settings[section][key]) !== JSON.stringify(DEFAULT_SETTINGS[section][key]),
    );
  return (
    changed('general', fields.general) ||
    changed('playback', fields.playback) ||
    changed('subtitles', fields.subtitles) ||
    changed('streams', fields.streams) ||
    changed('rows', fields.rows)
  );
}

/** A row's reset action: only while `value` differs from its default. */
export function resetTo<T>(value: T, fallback: T, reset: () => void): (() => void) | undefined {
  return JSON.stringify(value) === JSON.stringify(fallback) ? undefined : reset;
}

function flag(stored: unknown, fallback: boolean): boolean {
  return typeof stored === 'boolean' ? stored : fallback;
}

function oneOf<T>(choices: readonly T[], stored: unknown, fallback: T): T {
  return choices.find((choice) => choice === stored) ?? fallback;
}

/** A whole number within `min`–`max`, or `undefined`. */
function whole(stored: unknown, min: number, max: number): number | undefined {
  return typeof stored === 'number' && Number.isInteger(stored) && stored >= min && stored <= max
    ? stored
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
