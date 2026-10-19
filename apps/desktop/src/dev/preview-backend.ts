/**
 * Development only: a stand-in for the Rust core so the renderer can be
 * previewed in a plain browser (`pnpm --filter @kiro/desktop dev:renderer`)
 * with realistic data.
 *
 * It answers the same `invoke` commands through Tauri's IPC mock:
 * - addon requests go to the real addons with `fetch` (Stremio addons allow
 *   cross-origin requests), and Cinemeta, Anime Kitsu (its own `anime`
 *   catalogues), fake catalogues with wide and square artwork (one slow,
 *   one failing), and fake streams (one deliberately slow) and subtitles
 *   addons are installed to start with. The real defaults are Cinemeta and
 *   OpenSubtitles v3; OpenSubtitles starts out missing here (the fake
 *   subtitles stand in for it), so "Restore default addons" has something
 *   to put back;
 * - the library is kept in memory, seeded with a few titles;
 * - the player is imitated by `preview-player.ts`: no video, but real
 *   controls, tracks and events over a still picture;
 * - settings are kept in `localStorage['kiro.preview.settings']`, so they
 *   (Discover's rows, for one) survive a reload; remove it to start over.
 *   The library's "mark as watched" threshold follows them, and window
 *   fullscreen uses the page's Fullscreen API;
 * - SkipDB lookups (`skip_times_lookup`) answer with made-up times for the
 *   imitated file, or none, another release's, a failure or a slow reply.
 *
 * Nothing else is persisted: reloading starts again from the seed. `main.tsx`
 * loads this module behind `import.meta.env.DEV`, so production builds leave
 * it out. Set `VITE_KIRO_PREVIEW=0` to preview without it.
 */
import { buildResourcePath, type ResourceRequest } from '@kiro/addon-sdk';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';

import { DURATION, playerHandlers } from '@/dev/preview-player';
import { DEFAULT_SETTINGS, parseSettings } from '@/features/settings/settings-data';
import type {
  AppInfo,
  CommandError,
  HistoryEntry,
  InstalledAddonRecord,
  LibraryTitle,
  LibraryVideo,
  PlaybackProgress,
  Settings,
  WatchlistItem,
} from '@/services/native';

const CINEMETA = 'https://v3-cinemeta.strem.io/manifest.json';
const OPENSUBTITLES = 'https://opensubtitles-v3.strem.io/manifest.json';
const PREVIEW_STREAMS = 'https://streams.preview.kiro.invalid/manifest.json';
const SLOW_STREAMS = 'https://slow-streams.preview.kiro.invalid/manifest.json';
const PREVIEW_SUBTITLES = 'https://subtitles.preview.kiro.invalid/manifest.json';
const KITSU = 'https://anime-kitsu.strem.fun/manifest.json';
const PREVIEW_CHANNELS = 'https://channels.preview.kiro.invalid/manifest.json';

const APP_INFO: AppInfo = {
  name: 'Kiro',
  version: '0.1.0',
  tauriVersion: '2.12.0',
  os: 'macos',
  arch: 'aarch64',
  nativePlayer: true,
  discordPresence: true,
  smokeTestUrl: null,
};

// ---------------------------------------------------------------------------
// Addons
// ---------------------------------------------------------------------------

/** A streams addon answered locally, so title pages have streams to list. */
const previewStreamsManifest = {
  id: 'dev.kiro.preview-streams',
  version: '1.0.0',
  name: 'Preview Streams',
  description: 'Sample streams for the browser preview. They do not play.',
  types: ['movie', 'series'],
  resources: ['stream'],
  catalogs: [],
  idPrefixes: ['tt'],
};

/** A second streams addon that takes its time, to see Play's time budget. */
const slowStreamsManifest = {
  ...previewStreamsManifest,
  id: 'dev.kiro.preview-slow-streams',
  name: 'Slow Streams',
  description: 'Sample streams that arrive late, to try one-click Play’s time budget.',
};

const SAMPLE_VIDEO =
  'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/1080/Big_Buck_Bunny_1080_10s_30MB.mp4';

/**
 * Streams named the way Torrentio shows them through TorBox, in a scrambled
 * order so the ranking shows. Each has its own URL; the preview player fails
 * those with `dead` in them before they start, and those with `drops` after
 * a few seconds of playback (`preview-player.ts`). A 480p one is always dead.
 *
 * Set `localStorage['kiro.preview.streams']` to:
 * - `dead`: the two best streams are dead, so Play falls back twice (to the
 *   same release first);
 * - `all-dead`: every stream is dead, to see fallback give up;
 * - `drops`: the best stream fails after it has started (no fallback);
 * - `unplayable` (only torrents and http links) or `none`: Play shows the list.
 */
function previewStreams() {
  const mode = readPreviewSetting('kiro.preview.streams');
  if (mode === 'none') return { streams: [] };
  const dead = [
    [
      '[TB+] Preview\n4k HDR',
      'Sample.2024.2160p.WEB-DL.DDP5.1.Atmos.HDR10.H.265-DEAD\n👤 311 💾 16.4 GB ⚙️ ThePirateBay',
    ],
    [
      '[TB+] Preview\n4k HDR',
      'Sample.2024.2160p.BluRay.DDP5.1.Atmos.HDR10.H.265-GONE\n👤 120 💾 17.0 GB ⚙️ 1337x',
    ],
  ] as const;
  const playable = [
    [
      '[TB download] Preview\n4k HDR',
      'Sample.2024.UHD.BluRay.2160p.TrueHD.Atmos.7.1.HEVC.REMUX-FraMeSToR\n👤 51 💾 72.1 GB ⚙️ RARBG',
    ],
    [
      '[TB+] Preview\n1080p',
      'Sample.2024.1080p.WEB-DL.DDP5.1.H.264-FLUX\n👤 402 💾 6.1 GB ⚙️ ThePirateBay',
    ],
    [
      '[TB+] Preview\n4k DV | HDR',
      'Sample.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX\n👤 214 💾 18.4 GB ⚙️ ThePirateBay',
    ],
    ['[TB+] Preview\n720p', 'Sample.2024.720p.WEBRip.x264.AAC\n👤 90 💾 1.9 GB ⚙️ YTS'],
    ['[TB+] Preview\n480p', 'Sample.2024.480p.WEBRip.x264-DEAD\n👤 4 💾 700 MB ⚙️ YTS'],
    [
      '[TB+] Preview\n1080p',
      'Sample.2024.1080p.HDCAM.x264\n👤 12 💾 2.1 GB ⚙️ 1337x\nMulti Audio / 🇮🇹 / 🇪🇸',
    ],
    [
      '[TB download] Preview\n1080p',
      'Sample.2024.1080p.BluRay.x265.10bit.DTS-HD.MA.5.1\n👤 77 💾 9.8 GB ⚙️ 1337x',
    ],
  ] as const;
  const unplayable = [
    {
      infoHash: 'c9e15763f722f23e98a29decdfae341b98d53056',
      name: 'Preview\n4k',
      title: 'Sample.2024.2160p.WEB-DL.DDP5.1.HDR.H.265\n👤 980 💾 16.2 GB ⚙️ ThePirateBay',
    },
    {
      url: 'http://insecure.preview.kiro.invalid/sample.mkv',
      name: 'Preview\n720p',
      title: 'Sample.2024.720p.HDTV.x264\n💾 1.1 GB',
    },
  ];
  return {
    streams: [
      ...(mode === 'unplayable'
        ? []
        : [...(mode === 'dead' ? dead : []), ...playable].map(([name, title], index) => ({
            url: `${SAMPLE_VIDEO}?preview=${index}${
              mode === 'all-dead' || title.includes('-DEAD') || title.includes('-GONE')
                ? '&dead'
                : mode === 'drops' && name.includes('DV')
                  ? '&drops'
                  : ''
            }`,
            name,
            title,
            behaviorHints: {
              bingeGroup: `preview|${name.split('\n')[1] ?? ''}`,
              filename: `${title.split('\n')[0] ?? 'Sample'}.mkv`,
            },
            // Some addons send subtitles with the stream itself.
            subtitles: [
              {
                id: 'stream-ita',
                url: 'https://streams.preview.kiro.invalid/subtitles/release.ita.srt',
                lang: 'ita',
                label: 'Italiano (release)',
              },
            ],
          }))),
      ...unplayable,
    ],
  };
}

/**
 * The slow addon answers after `localStorage['kiro.preview.slow-streams']`
 * seconds (10 by default), or never, like the app's 20 s transport timeout,
 * when set to `hang`.
 */
async function slowStreams() {
  const setting = readPreviewSetting('kiro.preview.slow-streams');
  if (setting === 'hang') {
    await new Promise((resolve) => setTimeout(resolve, 20_000));
    throw commandError('ADDON_ERROR', 'The addon did not respond in time');
  }
  const allDead = readPreviewSetting('kiro.preview.streams') === 'all-dead';
  const seconds = Number(setting ?? 10);
  await new Promise((resolve) =>
    setTimeout(resolve, (Number.isFinite(seconds) ? seconds : 10) * 1000),
  );
  return {
    streams: (
      [
        [
          '[TB+] Slow\n1080p',
          'Sample.2024.1080p.BluRay.DDP5.1.x265-SLOW\n👤 33 💾 7.4 GB ⚙️ 1337x',
        ],
        [
          '[TB download] Slow\n4k HDR',
          'Sample.2024.2160p.WEB-DL.DDP5.1.HDR.H.265-SLOW\n👤 8 💾 15.2 GB ⚙️ 1337x',
        ],
      ] as const
    ).map(([name, title], index) => ({
      url: `${SAMPLE_VIDEO}?slow=${index}${allDead ? '&dead' : ''}`,
      name,
      title,
      behaviorHints: { bingeGroup: `slow|${name.split('\n')[1] ?? ''}` },
    })),
  };
}

/** A subtitles addon answered locally, shaped like OpenSubtitles v3. */
const previewSubtitlesManifest = {
  id: 'dev.kiro.preview-subtitles',
  version: '1.0.0',
  name: 'Preview Subtitles',
  description: 'Sample subtitles for the browser preview.',
  types: ['movie', 'series'],
  resources: ['subtitles'],
  catalogs: [],
  idPrefixes: ['tt'],
};

/**
 * OpenSubtitles-like answers: several files per language, its `pob` code,
 * a German file that fails to load (the next one is tried), and entries the
 * SDK must drop (http, no URL).
 * Set `localStorage['kiro.preview.subtitles']` to `none` for an empty answer.
 */
function previewSubtitles(request: ResourceRequest) {
  if (readPreviewSetting('kiro.preview.subtitles') === 'none') return { subtitles: [] };
  const base = `https://subtitles.preview.kiro.invalid/${encodeURIComponent(request.id)}`;
  const languages = ['eng', 'eng', 'ger', 'ger', 'ger', 'fre', 'spa', 'pob', 'por', 'ita', 'jpn'];
  return {
    subtitles: [
      { id: 'broken', url: `${base}/broken.srt`, lang: 'ger' },
      ...languages.map((lang, index) => ({
        id: String(1000 + index),
        url: `${base}/${index}.srt`,
        lang,
        SubEncoding: 'UTF-8',
      })),
      { id: 'insecure', url: `http://subtitles.preview.kiro.invalid/x.srt`, lang: 'eng' },
      { id: 'no-url', lang: 'eng' },
    ],
  };
}

/**
 * Catalogues answered locally, for Discover's rows: wide and square artwork
 * (`posterShape`), one that takes 8 s, one that fails, and a search-only one
 * that can't be a row.
 */
const previewChannelsManifest = {
  id: 'dev.kiro.preview-channels',
  version: '1.0.0',
  name: 'Preview Channels',
  description: 'Sample catalogues with wide and square artwork, a slow one and a broken one.',
  types: ['channel'],
  resources: ['catalog'],
  catalogs: [
    { type: 'channel', id: 'wide', name: 'Wide Picks', extra: [{ name: 'skip' }] },
    { type: 'channel', id: 'square', name: 'Square Picks' },
    { type: 'channel', id: 'slow', name: 'Slow Lane' },
    { type: 'channel', id: 'broken', name: 'Broken Channel' },
    {
      type: 'channel',
      id: 'search',
      name: 'Search',
      extra: [{ name: 'search', isRequired: true }],
    },
  ],
};

const CHANNEL_TITLES = [
  ['tt15239678', 'Dune: Part Two'],
  ['tt0816692', 'Interstellar'],
  ['tt1375666', 'Inception'],
  ['tt15398776', 'Oppenheimer'],
  ['tt1856101', 'Blade Runner 2049'],
  ['tt0133093', 'The Matrix'],
  ['tt6751668', 'Parasite'],
  ['tt0468569', 'The Dark Knight'],
  ['tt2582802', 'Whiplash'],
  ['tt0245429', 'Spirited Away'],
] as const;

async function previewChannels(request: ResourceRequest, requestId?: string) {
  if (request.resource !== 'catalog') {
    throw commandError('ADDON_ERROR', 'The addon returned HTTP 404');
  }
  if (request.id === 'broken') {
    await delay(600, requestId);
    throw commandError('ADDON_ERROR', 'The addon returned HTTP 503');
  }
  await delay(request.id === 'slow' ? 8000 : 500, requestId);
  // One page only: later pages are empty.
  if (request.extra?.skip) return { metas: [] };
  const shape = request.id === 'slow' ? 'poster' : request.id === 'wide' ? 'landscape' : 'square';
  return {
    metas: CHANNEL_TITLES.map(([id, name]) => ({
      id,
      type: 'movie',
      name,
      posterShape: shape,
      poster:
        shape === 'poster'
          ? `https://images.metahub.space/poster/small/${id}/img`
          : `https://images.metahub.space/background/medium/${id}/img`,
    })),
  };
}

function readPreviewSetting(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

let addons: InstalledAddonRecord[] | undefined;
const inflight = new Map<string, AbortController>();

async function installedAddons(): Promise<InstalledAddonRecord[]> {
  if (addons) return addons;
  // Kiro works without Kitsu, so the preview does too when it can't be reached.
  const kitsu = await fetchJson(KITSU).catch(() => undefined);
  addons ??= [
    { transportUrl: CINEMETA, manifest: await fetchJson(CINEMETA), enabled: true },
    ...(kitsu ? [{ transportUrl: KITSU, manifest: kitsu, enabled: true }] : []),
    { transportUrl: PREVIEW_CHANNELS, manifest: previewChannelsManifest, enabled: true },
    { transportUrl: PREVIEW_STREAMS, manifest: previewStreamsManifest, enabled: true },
    { transportUrl: SLOW_STREAMS, manifest: slowStreamsManifest, enabled: true },
    { transportUrl: PREVIEW_SUBTITLES, manifest: previewSubtitlesManifest, enabled: true },
  ];
  return addons;
}

/** Like the core's `addons::defaults`, with live manifests instead of snapshots. */
let defaultAddons: Promise<InstalledAddonRecord[]> | undefined;

function defaults(): Promise<InstalledAddonRecord[]> {
  defaultAddons ??= Promise.all(
    [CINEMETA, OPENSUBTITLES].map(async (transportUrl) => ({
      transportUrl,
      manifest: await fetchJson(transportUrl),
      enabled: true,
    })),
  ).catch((error: unknown) => {
    defaultAddons = undefined;
    throw error;
  });
  return defaultAddons;
}

async function fetchManifest(url: string): Promise<unknown> {
  if (url === PREVIEW_STREAMS) return previewStreamsManifest;
  if (url === PREVIEW_SUBTITLES) return previewSubtitlesManifest;
  if (url === PREVIEW_CHANNELS) return previewChannelsManifest;
  return url === SLOW_STREAMS ? slowStreamsManifest : fetchJson(url);
}

async function fetchResource(url: string, request: ResourceRequest, requestId?: string) {
  if (url === PREVIEW_STREAMS || url === SLOW_STREAMS) {
    if (request.resource !== 'stream') {
      throw commandError('ADDON_ERROR', 'The addon returned HTTP 404');
    }
    if (url === SLOW_STREAMS) return slowStreams();
    // A real addon takes a moment: long enough to see Play wait for it.
    await new Promise((resolve) => setTimeout(resolve, 800));
    return previewStreams();
  }
  if (url === PREVIEW_CHANNELS) return previewChannels(request, requestId);
  if (url === PREVIEW_SUBTITLES) {
    if (request.resource !== 'subtitles') {
      throw commandError('ADDON_ERROR', 'The addon returned HTTP 404');
    }
    // Slow enough to see the menu fill in after the stream has started.
    await delay(1500, requestId);
    return previewSubtitles(request);
  }
  const base = url.replace(/\/manifest\.json$/, '');
  const controller = new AbortController();
  if (requestId) inflight.set(requestId, controller);
  try {
    return await fetchJson(`${base}${buildResourcePath(request)}`, controller.signal);
  } finally {
    if (requestId) inflight.delete(requestId);
  }
}

/** Waits `ms`, or rejects like a cancelled request when `requestId` is cancelled. */
function delay(ms: number, requestId?: string): Promise<void> {
  const controller = new AbortController();
  if (requestId) inflight.set(requestId, controller);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    controller.signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(commandError('CANCELLED', 'The request was cancelled'));
    });
  }).finally(() => {
    if (requestId) inflight.delete(requestId);
  });
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { signal, headers: { accept: 'application/json' } });
  } catch (error) {
    if (signal?.aborted) throw commandError('CANCELLED', 'The request was cancelled');
    throw commandError('ADDON_ERROR', `The addon could not be reached (${String(error)})`);
  }
  if (!response.ok) throw commandError('ADDON_ERROR', `The addon returned HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw commandError('ADDON_ERROR', 'The addon did not return JSON');
  }
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

const MIN_RESUME_SECONDS = 15;
const MINUTE = 60_000;

function title(type: string, id: string, name: string): LibraryTitle {
  return { type, id, name, poster: `https://images.metahub.space/poster/small/${id}/img` };
}

function movie(id: string): LibraryVideo {
  return { id, season: null, episode: null, name: null };
}

function episode(id: string, season: number, number: number, name: string): LibraryVideo {
  return { id: `${id}:${season}:${number}`, season, episode: number, name };
}

const started = Date.now();

const SETTINGS_KEY = 'kiro.preview.settings';

/** The saved settings, read like the core reads its file: what's missing is a default. */
function storedSettings(): Settings {
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    if (stored) return parseSettings(JSON.parse(stored));
  } catch {
    // Unreadable or blocked: start from the defaults.
  }
  return structuredClone(DEFAULT_SETTINGS);
}

let settings: Settings = storedSettings();

const watchlist: WatchlistItem[] = [
  { title: title('movie', 'tt15239678', 'Dune: Part Two'), addedAt: started - 30 * MINUTE },
  { title: title('series', 'tt11280740', 'Severance'), addedAt: started - 90 * MINUTE },
  { title: title('movie', 'tt0816692', 'Interstellar'), addedAt: started - 300 * MINUTE },
  { title: title('series', 'tt0903747', 'Breaking Bad'), addedAt: started - 900 * MINUTE },
];

/** `hour:minute` local time, `days` ago, for seeding by day. */
function daysAgo(days: number, hour: number, minute = 0) {
  const date = new Date(started);
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() - days,
    hour,
    minute,
  ).getTime();
}

/** Seeded so History shows each day group, series with several episodes and every action. */
const history: HistoryEntry[] = [
  // Today: an episode in progress, after the two before it.
  ...(
    [
      [1, 'Seven Thirty-Seven', 2_820, 2_820, daysAgo(2, 21, 5)],
      [2, 'Grilled', 2_820, 2_820, daysAgo(1, 22, 10)],
      [3, 'Bit by a Dead Bee', 2_820, 2_820, started - 70 * MINUTE],
      [4, 'Down', 1_820, 2_820, started - 20 * MINUTE],
    ] as const
  ).map(([number, name, position, duration, at]) =>
    progressEntry(
      {
        title: title('series', 'tt0903747', 'Breaking Bad'),
        video: episode('tt0903747', 2, number, name),
      },
      position,
      duration,
      at,
    ),
  ),
  // Yesterday: a film left halfway, and a finished episode with one after it.
  progressEntry(
    { title: title('movie', 'tt1375666', 'Inception'), video: movie('tt1375666') },
    4_310,
    8_880,
    daysAgo(1, 20, 40),
  ),
  ...(
    [
      [1, 'System', daysAgo(3, 19, 30)],
      [2, 'Hands', daysAgo(1, 18, 0)],
      [3, 'Brigade', daysAgo(1, 18, 30)],
    ] as const
  ).map(([number, name, at]) =>
    progressEntry(
      {
        title: title('series', 'tt14452776', 'The Bear'),
        video: episode('tt14452776', 1, number, name),
      },
      1_700,
      1_800,
      at,
    ),
  ),
  // This week.
  progressEntry(
    {
      title: title('series', 'tt11280740', 'Severance'),
      video: episode('tt11280740', 1, 3, 'In Perpetuity'),
    },
    640,
    3_300,
    daysAgo(3, 22, 15),
  ),
  progressEntry(
    { title: title('movie', 'tt0816692', 'Interstellar'), video: movie('tt0816692') },
    9_900,
    10_140,
    daysAgo(4, 21, 0),
  ),
  // Earlier: the last episode of a series (nothing next), a finished film and
  // one barely started.
  ...(
    [
      [9, 'Crimson Sky', daysAgo(12, 21, 0)],
      [10, 'A Dream of a Dream', daysAgo(11, 21, 30)],
    ] as const
  ).map(([number, name, at]) =>
    progressEntry(
      {
        title: title('series', 'tt2788316', 'Shōgun'),
        video: episode('tt2788316', 1, number, name),
      },
      3_400,
      3_500,
      at,
    ),
  ),
  progressEntry(
    { title: title('movie', 'tt15398776', 'Oppenheimer'), video: movie('tt15398776') },
    10_800,
    10_860,
    daysAgo(16, 20, 0),
  ),
  progressEntry(
    { title: title('movie', 'tt1856101', 'Blade Runner 2049'), video: movie('tt1856101') },
    8,
    9_840,
    daysAgo(40, 22, 0),
  ),
  progressEntry(
    {
      title: title('series', 'tt3581920', 'The Last of Us'),
      video: episode('tt3581920', 1, 1, 'When You’re Lost in the Darkness'),
    },
    2_100,
    4_860,
    daysAgo(70, 21, 0),
  ),
];

function progressEntry(
  { title: entryTitle, video }: Pick<PlaybackProgress, 'title' | 'video'>,
  position: number,
  duration: number,
  updatedAt = Date.now(),
): HistoryEntry {
  return {
    title: entryTitle,
    video,
    position,
    duration,
    // Like the core: the setting as progress is saved (the seed uses the default).
    completed: position >= (duration * settings.playback.markWatchedPercent) / 100,
    updatedAt,
  };
}

const sameTitle = (type: string, id: string) => (entry: { title: LibraryTitle }) =>
  entry.title.type === type && entry.title.id === id;

/** The latest video of each title, newest first (`Library::latest_per_title`). */
function latestPerTitle(filter: (entry: HistoryEntry) => boolean, limit = 100) {
  const seen = new Set<string>();
  return [...history]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .filter((entry) => {
      const key = `${entry.title.type}:${entry.title.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .filter(filter)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

type Args = Record<string, unknown>;

/** Has the `{ code, message }` shape of the core's command errors. */
class PreviewCommandError extends Error implements CommandError {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function commandError(code: string, message: string): PreviewCommandError {
  return new PreviewCommandError(code, message);
}

// ---------------------------------------------------------------------------
// Settings and the window
// ---------------------------------------------------------------------------

/**
 * `skip_times_lookup`, refused unless the setting is on, as in the core.
 * Breaking Bad episodes get times recorded on a file as long as the
 * imitated one. `localStorage['kiro.preview.skip-times']`: `none` (nothing
 * known), `other` (only another release's), `error` or `slow`.
 */
async function lookUpSkipTimes({ imdbId, season, episode, duration }: Args) {
  if (!settings.playback.onlineSkipTimes) {
    throw commandError('INVALID_ARGUMENT', 'Looking up intro times online is turned off');
  }
  const mode = readPreviewSetting('kiro.preview.skip-times');
  await delay(mode === 'slow' ? 6000 : 400);
  if (mode === 'error') throw commandError('ADDON_ERROR', 'The addon did not respond in time');
  const known = imdbId === 'tt0903747' && Number(season) >= 1 && Number(episode) >= 1;
  const sameLength = Math.abs(Number(duration) - DURATION) <= 2;
  const nothing = { source: 'SkipDB', segments: [], unmatched: 0, otherLengths: [] };
  if (!known || mode === 'none') return nothing;
  if (!sameLength || mode === 'other') {
    return { ...nothing, unmatched: 2, otherLengths: [DURATION + 33] };
  }
  return {
    ...nothing,
    segments: [
      { kind: 'intro', start: 61.5, end: 78, offset: 0 },
      { kind: 'credits', start: 2_772, end: DURATION, offset: 0 },
    ],
  };
}

const windowHandlers: Record<string, (args: Args) => unknown> = {
  skip_times_lookup: lookUpSkipTimes,
  settings_get: () => settings,
  settings_set: ({ settings: next }) => {
    settings = structuredClone(next as Settings);
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // Private window or blocked storage: kept for this page only.
    }
    return settings;
  },
  'plugin:window|is_fullscreen': () => document.fullscreenElement !== null,
  'plugin:window|set_fullscreen': async ({ value }) => {
    if (value && !document.fullscreenElement) await document.documentElement.requestFullscreen();
    if (!value && document.fullscreenElement) await document.exitFullscreen();
  },
};

// ---------------------------------------------------------------------------
// Import from Stremio
// ---------------------------------------------------------------------------

/**
 * `stremio_import_*`: an imitation account. Any key or password works except
 * `wrong`; the addons are real ones, so installing them fetches live
 * manifests (one fails, one is already installed, one is Stremio's local
 * server).
 */
let stremioAccountRead = false;

const stremioHandlers: Record<string, (args: Args) => unknown> = {
  stremio_import_fetch: async ({ signIn }) => {
    await delay(900);
    const given = signIn as { authKey?: string; password?: string };
    if ((given.authKey ?? given.password) === 'wrong') {
      throw commandError(
        'STREMIO_ERROR',
        'Stremio didn’t accept that auth key. Copy a fresh one and try again.',
      );
    }
    stremioAccountRead = true;
    return {
      addons: [
        { transportUrl: CINEMETA, name: 'Cinemeta', status: 'installed' },
        {
          transportUrl: 'http://127.0.0.1:11470/local-addon/manifest.json',
          name: 'Local Files',
          status: 'unsupported',
        },
        {
          transportUrl: 'https://watchhub.strem.io/manifest.json',
          name: 'WatchHub',
          status: 'new',
        },
        { transportUrl: OPENSUBTITLES, name: 'OpenSubtitles v3', status: 'new' },
        {
          transportUrl: 'https://gone.invalid/manifest.json',
          name: 'A Gone Addon',
          status: 'new',
        },
      ],
      libraryItems: 140,
      watched: 95,
      inProgress: 38,
      skipped: 3,
    };
  },
  stremio_import_library: async ({ choice }) => {
    if (!stremioAccountRead) {
      throw commandError('INVALID_ARGUMENT', 'Sign in to Stremio again to import.');
    }
    stremioAccountRead = false;
    await delay(700);
    const { libraryItems, progress } = choice as { libraryItems: boolean; progress: boolean };
    return {
      libraryItems: libraryItems ? { added: 137, updated: 0, skipped: 3, failed: 0 } : null,
      progress: progress ? { added: 90, updated: 2, skipped: 3, failed: 0 } : null,
    };
  },
  stremio_import_discard: () => {
    stremioAccountRead = false;
  },
};

const handlers: Record<string, (args: Args) => unknown> = {
  ...stremioHandlers,
  ...playerHandlers,
  ...windowHandlers,
  app_info: () => APP_INFO,

  addon_list: () => installedAddons(),
  addon_fetch_manifest: ({ url }) => fetchManifest(url as string),
  addon_fetch_resource: ({ url, resource, type, id, extra, requestId }) =>
    fetchResource(
      url as string,
      { resource, type, id, extra } as ResourceRequest,
      requestId as string | undefined,
    ),
  addon_cancel_request: ({ requestId }) => {
    const controller = inflight.get(requestId as string);
    controller?.abort();
    return Boolean(controller);
  },
  // Like the core: an update keeps its place and switch, a new addon goes last, enabled.
  addon_install: async ({ addon }) => {
    const record = addon as Omit<InstalledAddonRecord, 'enabled'>;
    const current = await installedAddons();
    const existing = current.find((r) => r.transportUrl === record.transportUrl);
    addons = existing
      ? current.map((r) => (r === existing ? { ...record, enabled: existing.enabled } : r))
      : [...current, { ...record, enabled: true }];
    return addons;
  },
  addon_set_enabled: async ({ url, enabled }) => {
    const current = await installedAddons();
    if (!current.some((r) => r.transportUrl === url)) {
      throw commandError('INVALID_ARGUMENT', 'That addon is not installed');
    }
    addons = current.map((r) => (r.transportUrl === url ? { ...r, enabled: Boolean(enabled) } : r));
    return addons;
  },
  addon_move: async ({ url, index }) => {
    const current = [...(await installedAddons())];
    const from = current.findIndex((r) => r.transportUrl === url);
    if (from < 0) throw commandError('INVALID_ARGUMENT', 'That addon is not installed');
    const [record] = current.splice(from, 1);
    if (record) current.splice(Math.min(Number(index), current.length), 0, record);
    addons = current;
    return addons;
  },
  addon_uninstall: async ({ url }) => {
    addons = (await installedAddons()).filter((record) => record.transportUrl !== url);
    return addons;
  },
  addon_defaults: () => defaults(),
  addon_restore_defaults: async () => {
    const current = await installedAddons();
    const missing = (await defaults()).filter(
      (addon) => !current.some((r) => r.transportUrl === addon.transportUrl),
    );
    addons = [...current, ...missing];
    return addons;
  },

  library_watchlist: () => [...watchlist].sort((a, b) => b.addedAt - a.addedAt),
  library_watchlist_add: ({ title: added }) => {
    const { type, id } = added as LibraryTitle;
    const existing = watchlist.find(sameTitle(type, id));
    if (existing) return existing;
    const item = { title: added as LibraryTitle, addedAt: Date.now() };
    watchlist.push(item);
    return item;
  },
  library_watchlist_remove: ({ type, id }) => {
    const index = watchlist.findIndex(sameTitle(type as string, id as string));
    if (index >= 0) watchlist.splice(index, 1);
  },
  library_record_progress: ({ progress }) => {
    const { title: progressTitle, video, position, duration } = progress as PlaybackProgress;
    const entry = progressEntry({ title: progressTitle, video }, position, duration);
    const index = history.findIndex(
      (existing) =>
        sameTitle(progressTitle.type, progressTitle.id)(existing) && existing.video.id === video.id,
    );
    if (index >= 0) history.splice(index, 1, entry);
    else history.push(entry);
    return entry;
  },
  library_history: ({ limit }) =>
    latestPerTitle(() => true, limit as number | undefined).map((entry) => ({
      ...entry,
      playedVideos: history.filter(sameTitle(entry.title.type, entry.title.id)).length,
    })),
  library_continue_watching: ({ limit }) =>
    latestPerTitle(
      // Mirrors `Library::continue_watching`: series between episodes stay.
      (entry) =>
        (!entry.completed && entry.position >= MIN_RESUME_SECONDS) ||
        (entry.title.type === 'series' && entry.completed),
      limit as number | undefined,
    ),
  library_title_state: ({ type, id }) => ({
    inWatchlist: watchlist.some(sameTitle(type as string, id as string)),
    progress: history
      .filter(sameTitle(type as string, id as string))
      .sort((a, b) => b.updatedAt - a.updatedAt),
  }),
  library_history_remove: ({ type, id }) => {
    const keep = history.filter((entry) => !sameTitle(type as string, id as string)(entry));
    history.splice(0, history.length, ...keep);
  },
  library_history_clear: () => {
    history.length = 0;
  },
};

export function installPreviewBackend() {
  mockIPC((command, args) => {
    const handler = handlers[command];
    if (!handler) {
      return Promise.reject(
        commandError('UNSUPPORTED', `${command} is not available in the browser preview`),
      );
    }
    // Run it as a continuation so a handler that throws rejects the call.
    return Promise.resolve().then(() => handler((args ?? {}) as Args));
  });
  // `getCurrentWindow()` reads the window label from here.
  mockWindows('main');
  // `isTauri()` reads this global, so the renderer behaves as if native;
  // `isPreviewBackend()` reads the other.
  Object.assign(globalThis, { isTauri: true, __KIRO_PREVIEW__: true });
}
