/**
 * How Settings is laid out: its sections (one shown at a time, each at its
 * own address such as `/settings/playback`), the groups and settings in each,
 * and searching them. Pure data and functions, so they can be tested.
 *
 * A new setting gets an entry here, under its section, and its row the same
 * `id` (`<SettingRow id>` or `<ToggleSetting id>`), so search and links find
 * it; a new stored field also goes in its section's `fields`, for the
 * section's reset (a test checks every field has exactly one).
 */
import type { SettingsFields } from '@/features/settings/settings-data';

export type SettingsSectionId =
  | 'general'
  | 'profiles'
  | 'playback'
  | 'audio'
  | 'subtitles'
  | 'streams'
  | 'addons'
  | 'import'
  | 'about';

/** One setting (a row), for search and for links to it. */
export interface SettingEntry {
  /** The row's anchor: `/settings/playback#skip-intros`. */
  id: string;
  label: string;
  /** The heading it sits under in its section. */
  group: string;
  /** Other words people might search for it by. */
  keywords: readonly string[];
  /**
   * The setting that must be on for this one to show (Passthrough formats
   * needs Audio passthrough): links to it land there while it's off.
   */
  shownWith?: string;
}

export interface SettingsSectionInfo {
  id: SettingsSectionId;
  title: string;
  /** A line under the section's heading. */
  description: string;
  /** Needs the desktop app (its settings are stored by the core). */
  native: boolean;
  /** What the section's "Reset to defaults" puts back; none: it has no reset. */
  fields?: SettingsFields;
  settings: readonly SettingEntry[];
}

const setting = (
  id: string,
  label: string,
  group: string,
  keywords: readonly string[] = [],
  shownWith?: string,
): SettingEntry =>
  shownWith ? { id, label, group, keywords, shownWith } : { id, label, group, keywords };

export const SETTINGS_SECTIONS: readonly SettingsSectionInfo[] = [
  {
    id: 'general',
    title: 'General',
    description: 'Updates, what Kiro shares outside the app, and the keyboard and remote.',
    native: true,
    fields: { general: ['discordPresence', 'discordShowTitle', 'discordShowEpisode'] },
    settings: [
      setting('updates', 'Check for updates', 'Updates', [
        'version',
        'check for updates',
        'download',
        'restart',
        'upgrade',
        'new version',
      ]),
      setting('discord', 'Show what I’m watching on Discord', 'Discord', [
        'rich presence',
        'status',
        'activity',
        'privacy',
      ]),
      setting('discord-title', 'Show the title', 'Discord', ['poster', 'discord'], 'discord'),
      setting('discord-episode', 'Show the episode', 'Discord', ['season', 'discord'], 'discord'),
      setting('keyboard', 'Keyboard shortcuts', 'Keyboard and remote', [
        'remote control',
        'keys',
        'hotkeys',
        'arrows',
        'tv',
      ]),
    ],
  },
  {
    id: 'profiles',
    title: 'Profiles',
    description:
      'Everyone using Kiro on this computer can have their own library and settings. Addons are shared.',
    native: true,
    settings: [
      setting('profiles', 'Profiles on this computer', 'People', [
        'users',
        'accounts',
        'family',
        'add profile',
        'rename',
        'avatar',
        'pin',
        'lock',
        'delete',
      ]),
      setting('ask-whos-watching', 'Ask who’s watching', 'When Kiro opens', [
        'profile picker',
        'launch',
        'startup',
      ]),
    ],
  },
  {
    id: 'playback',
    title: 'Playback',
    description: 'What the player does when something starts, ends and plays.',
    native: true,
    fields: {
      playback: [
        'resume',
        'markWatchedPercent',
        'autoplayNext',
        'upNextSeconds',
        'skipIntros',
        'onlineSkipTimes',
        'seekSeconds',
        'rememberVolume',
        'volume',
        'keepScreenOn',
      ],
    },
    settings: [
      setting('resume', 'Resume playback', 'Resuming', ['continue', 'start over', 'ask']),
      setting('mark-watched', 'Mark as watched at', 'Resuming', [
        'watched',
        'threshold',
        'percent',
        'continue watching',
        'progress',
      ]),
      setting('autoplay', 'Autoplay next episode', 'Up next', ['binge', 'next episode']),
      setting('up-next-countdown', 'Up next countdown', 'Up next', ['timer', 'seconds', 'delay']),
      setting('skip-intros', 'Skip intros automatically', 'Intros and credits', [
        'recap',
        'opening',
        'skip intro',
      ]),
      setting('online-skip-times', 'Look up intro times online', 'Intros and credits', [
        'skipdb',
        'credits',
        'internet',
      ]),
      setting('seek', 'Skip interval', 'Player', [
        'seek',
        'jump',
        'forward',
        'back',
        'arrow keys',
        'rewind',
      ]),
      setting('remember-volume', 'Remember volume', 'Player', ['sound', 'loudness']),
      setting('keep-screen-on', 'Keep the screen on while playing', 'Player', [
        'sleep',
        'screensaver',
        'display',
        'awake',
      ]),
    ],
  },
  {
    id: 'audio',
    title: 'Audio',
    description: 'Which soundtrack plays, and sending surround sound to an AV receiver.',
    native: true,
    fields: { playback: ['audioLanguages', 'audioPassthrough', 'passthroughFormats'] },
    settings: [
      setting('audio-languages', 'Audio languages', 'Languages', [
        'dub',
        'dubbed',
        'original language',
        'track',
        'soundtrack',
      ]),
      setting('passthrough', 'Audio passthrough (AV receiver)', 'AV receiver', [
        'bitstream',
        'hdmi',
        'optical',
        'soundbar',
        'surround',
        'dolby',
        'atmos',
        'dts',
        'spdif',
      ]),
      setting(
        'passthrough-formats',
        'Passthrough formats',
        'AV receiver',
        ['dolby digital', 'truehd', 'dts-hd', 'eac3', 'ac3', 'atmos', 'dts:x'],
        'passthrough',
      ),
    ],
  },
  {
    id: 'subtitles',
    title: 'Subtitles',
    description: 'Which subtitles are turned on, and how they look in the player.',
    native: true,
    fields: {
      playback: ['subtitlesOff', 'subtitleLanguages'],
      subtitles: ['size', 'color', 'edge', 'offset', 'preferredType'],
    },
    settings: [
      setting('subtitles-off', 'Subtitles off by default', 'Choosing subtitles', [
        'captions',
        'cc',
        'forced',
      ]),
      setting('subtitle-languages', 'Subtitle languages', 'Choosing subtitles', ['captions', 'cc']),
      setting('subtitle-type', 'Preferred type', 'Choosing subtitles', [
        'sdh',
        'hearing impaired',
        'deaf',
        'forced',
        'captions',
        'cc',
      ]),
      setting('subtitle-size', 'Size', 'Appearance', ['font', 'text', 'bigger', 'smaller']),
      setting('subtitle-colour', 'Text colour', 'Appearance', ['color', 'yellow', 'white', 'font']),
      setting('subtitle-edge', 'Edge', 'Appearance', [
        'outline',
        'shadow',
        'background',
        'box',
        'border',
      ]),
      setting('subtitle-position', 'Raise subtitles', 'Appearance', [
        'position',
        'offset',
        'overscan',
        'height',
        'move up',
      ]),
    ],
  },
  {
    id: 'streams',
    title: 'Streams',
    description:
      'How Play picks a stream. Streams your filters leave out are still listed, marked as filtered, so you can play one yourself.',
    native: true,
    fields: {
      streams: [
        'maxResolution',
        'preferHdr',
        'preferCached',
        'excludeCam',
        'maxSizeGb',
        'avoidCodecs',
        'excludedKeywords',
      ],
    },
    settings: [
      setting('max-resolution', 'Maximum resolution', 'Quality', [
        '4k',
        '2160p',
        '1080p',
        '720p',
        'uhd',
      ]),
      setting('prefer-hdr', 'Prefer HDR', 'Quality', ['dolby vision', 'hdr10']),
      setting('prefer-cached', 'Prefer cached streams', 'Quality', [
        'debrid',
        'real-debrid',
        'instant',
      ]),
      setting('exclude-cam', 'Filter out cam releases', 'Filters', [
        'telesync',
        'screener',
        'cinema',
      ]),
      setting('max-size', 'Maximum file size', 'More filters', ['gb', 'large', 'bandwidth']),
      setting('avoid-codecs', 'Codecs to avoid', 'More filters', ['av1', 'hevc', 'h265', 'x265']),
      setting('excluded-keywords', 'Excluded keywords', 'More filters', [
        'words',
        'block',
        'release group',
        '3d',
      ]),
    ],
  },
  {
    id: 'addons',
    title: 'Addons',
    description:
      'The first addon wins when two streams are otherwise equal, and lists come in this order. Turned-off addons stay installed but aren’t asked for anything.',
    native: true,
    settings: [
      setting('addon-order', 'Addon order', 'Installed addons', [
        'priority',
        'enable',
        'disable',
        'turn off',
        'reorder',
        'sources',
      ]),
      setting('setup-again', 'First-run setup', 'Setup', [
        'welcome',
        'onboarding',
        'set up again',
        'add addons',
      ]),
    ],
  },
  {
    id: 'import',
    title: 'Import',
    description:
      'Bring your addons, library and watch progress over from your Stremio account in one go.',
    native: true,
    settings: [
      setting('stremio', 'Import from Stremio', 'Stremio', [
        'migrate',
        'account',
        'library',
        'watch progress',
        'auth key',
        'sign in',
      ]),
    ],
  },
  {
    id: 'about',
    title: 'About',
    description: 'This copy of Kiro and the computer it runs on.',
    native: false,
    settings: [
      setting('version', 'Version', 'About Kiro', ['build', 'platform', 'tauri', 'system']),
    ],
  },
];

export const DEFAULT_SECTION: SettingsSectionId = 'general';

export function settingsSection(id: SettingsSectionId): SettingsSectionInfo {
  return SETTINGS_SECTIONS.find((section) => section.id === id) ?? SETTINGS_SECTIONS[0]!;
}

/** The address of a section, or of one setting in it. */
export function settingsPath(section: SettingsSectionId, setting?: string): string {
  return `/settings/${section}${setting ? `#${setting}` : ''}`;
}

/** The element id of a setting's row (anchors are prefixed to keep page ids apart). */
export function settingElementId(setting: string): string {
  return `setting-${setting}`;
}

/**
 * Anchors from before Settings had a page per section (`/settings#streams`)
 * that aren't a section's id.
 */
const LEGACY_ANCHORS: Record<string, { section: SettingsSectionId; setting?: string }> = {
  stremio: { section: 'import', setting: 'stremio' },
  keyboard: { section: 'general', setting: 'keyboard' },
};

export type SettingsLocation =
  | { section: SettingsSectionId; setting: string | null }
  /** The address isn't a section's: go to `to` instead (replacing it). */
  | { redirect: string };

/**
 * What `/settings/:section#hash` shows. `/settings` alone is General; an old
 * `/settings#streams` link, or a setting's anchor without its section, goes
 * to the section's own address; an unknown section goes back to `/settings`.
 */
export function resolveSettingsLocation(
  sectionParam: string | undefined,
  hash: string,
): SettingsLocation {
  const anchor = decodeURIComponent(hash.replace(/^#/, '')) || null;
  if (sectionParam === undefined) {
    if (!anchor) return { section: DEFAULT_SECTION, setting: null };
    const legacy = LEGACY_ANCHORS[anchor];
    if (legacy) return { redirect: settingsPath(legacy.section, legacy.setting) };
    if (SETTINGS_SECTIONS.some((section) => section.id === anchor)) {
      return { redirect: settingsPath(anchor as SettingsSectionId) };
    }
    const found = findSetting(anchor);
    return found
      ? { redirect: settingsPath(found.section.id, anchor) }
      : { section: DEFAULT_SECTION, setting: null };
  }
  const section = SETTINGS_SECTIONS.find((candidate) => candidate.id === sectionParam);
  if (!section) return { redirect: '/settings' };
  return { section: section.id, setting: anchor };
}

/** A setting by its id, with its section. */
export function findSetting(id: string): SettingsSearchResult | undefined {
  for (const section of SETTINGS_SECTIONS) {
    const setting = section.settings.find((entry) => entry.id === id);
    if (setting) return { section, setting };
  }
  return undefined;
}

export interface SettingsSearchResult {
  section: SettingsSectionInfo;
  setting: SettingEntry;
}

/** Lower case, without accents or curly quotes, so “who’s” finds “who's”. */
function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[‘’]/g, "'").toLowerCase();
}

/** The words of `text`, for matching search terms against their starts. */
function words(text: string): string[] {
  return fold(text)
    .split(/[^a-z0-9']+/)
    .map((word) => word.replace(/'/g, ''))
    .filter(Boolean);
}

/** How strongly each place a term can match counts. */
const WEIGHTS = { label: 4, keywords: 2, context: 1 } as const;

/**
 * The settings matching `query`, best first: every word of the query must
 * start a word of the setting's label, its keywords, its group or its
 * section's title. Matches in the label rank highest; ties keep page order.
 */
export function searchSettings(
  query: string,
  sections: readonly SettingsSectionInfo[] = SETTINGS_SECTIONS,
): SettingsSearchResult[] {
  const terms = words(query);
  if (terms.length === 0) return [];
  const scored: { result: SettingsSearchResult; score: number; order: number }[] = [];
  for (const section of sections) {
    for (const entry of section.settings) {
      const fields = {
        label: words(entry.label),
        keywords: entry.keywords.flatMap(words),
        context: [...words(entry.group), ...words(section.title)],
      };
      let score = 0;
      for (const term of terms) {
        const best = (Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[]).find((field) =>
          fields[field].some((word) => word.startsWith(term)),
        );
        if (!best) {
          score = -1;
          break;
        }
        score += WEIGHTS[best];
      }
      if (score > 0) {
        scored.push({ result: { section, setting: entry }, score, order: scored.length });
      }
    }
  }
  return scored
    .toSorted((a, b) => b.score - a.score || a.order - b.order)
    .map(({ result }) => result);
}
