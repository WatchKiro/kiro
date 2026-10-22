/**
 * Typed bridge to the Rust core. All `invoke` calls go through this module so
 * the command surface exposed to the renderer is explicit and greppable. Each
 * command must also be allowed in `src-tauri/capabilities/`.
 */
import type { AddonManifest, ResourceRequest } from '@kiro/addon-sdk';
import { invoke, isTauri } from '@tauri-apps/api/core';

import { cancellable } from '@/services/cancellable';

/** Mirrors `commands::app::AppInfo` in Rust. */
export interface AppInfo {
  name: string;
  version: string;
  tauriVersion: string;
  /** `macos` | `windows` | `linux` | ... (Rust `std::env::consts::OS`). */
  os: string;
  arch: string;
  /** Whether this build includes the native player (`--features libmpv` on macOS, Windows or Linux). */
  nativePlayer: boolean;
  /**
   * Whether Discord Rich Presence can work: the native player, and a Discord
   * application ID set when building (`presence::APPLICATION_ID`).
   */
  discordPresence: boolean;
  /**
   * `KIRO_SMOKE_TEST_URL`: open the player on this URL and pause once it plays
   * (CI's check of an installed build, `scripts/playback-smoke.mjs --app`).
   */
  smokeTestUrl: string | null;
}

/** Shape of errors returned by Kiro commands (`core::error::Error`). */
export interface CommandError {
  code: string;
  message: string;
}

export function describeError(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as CommandError).message);
  }
  return String(error);
}

/**
 * `false` when the renderer runs in a plain browser (e.g. `pnpm dev:renderer`),
 * unless the development preview backend stands in for the core.
 */
export const isNativeRuntime = isTauri;

/** Whether native commands are answered by the browser preview backend (`src/dev`). */
export function isPreviewBackend(): boolean {
  return import.meta.env.DEV && '__KIRO_PREVIEW__' in globalThis;
}

export function getAppInfo(): Promise<AppInfo> {
  return invoke<AppInfo>('app_info');
}

/**
 * Mirrors `addons::registry::InstalledAddon` in Rust. The stored manifest is
 * untrusted: validate it with `parseManifest` after reading it back.
 */
export interface InstalledAddonRecord {
  transportUrl: string;
  manifest: unknown;
  /** Disabled addons stay installed but aren't queried. */
  enabled: boolean;
}

/**
 * Addon commands (`commands::addons`). Fetches return the addon's **raw,
 * unvalidated** JSON; pass it through the `@kiro/addon-sdk` parsers.
 */
export const addonCommands = {
  fetchManifest: (url: string) => invoke<unknown>('addon_fetch_manifest', { url }),
  /** With a `signal`, aborting it also aborts the HTTP request in the core. */
  fetchResource: (
    url: string,
    { resource, type, id, extra }: ResourceRequest,
    { signal }: { signal?: AbortSignal } = {},
  ) => {
    const fetch = (requestId?: string) =>
      invoke<unknown>('addon_fetch_resource', { url, resource, type, id, extra, requestId });
    return signal
      ? cancellable(signal, fetch, (requestId) =>
          invoke<boolean>('addon_cancel_request', { requestId }),
        )
      : fetch();
  },
  list: () => invoke<InstalledAddonRecord[]>('addon_list'),
  install: (addon: { transportUrl: string; manifest: AddonManifest }) =>
    invoke<InstalledAddonRecord[]>('addon_install', { addon }),
  uninstall: (url: string) => invoke<InstalledAddonRecord[]>('addon_uninstall', { url }),
  /** Turns an addon on or off without uninstalling it. */
  setEnabled: (url: string, enabled: boolean) =>
    invoke<InstalledAddonRecord[]>('addon_set_enabled', { url, enabled }),
  /** Moves an addon to `index` in the priority order (the list's order). */
  move: (url: string, index: number) =>
    invoke<InstalledAddonRecord[]>('addon_move', { url, index }),
  /** The addons a new profile starts with, installed now or not. */
  defaults: () => invoke<InstalledAddonRecord[]>('addon_defaults'),
  /** Installs the default addons that are missing, at the end of the list. */
  restoreDefaults: () => invoke<InstalledAddonRecord[]>('addon_restore_defaults'),
};

/**
 * Display data the library keeps for a title (`library::TitleSnapshot`).
 * `poster` must be an https URL.
 */
export interface LibraryTitle {
  type: string;
  id: string;
  name: string;
  poster: string | null;
}

/**
 * The played video (`library::VideoSnapshot`): the movie itself (`id` equals
 * the title's id) or an episode.
 */
export interface LibraryVideo {
  id: string;
  season: number | null;
  episode: number | null;
  /** The episode's title. */
  name: string | null;
}

/** Mirrors `library::WatchlistItem`. */
export interface WatchlistItem {
  title: LibraryTitle;
  /** Unix milliseconds. */
  addedAt: number;
}

/** Saved progress for one video (`library::HistoryEntry`). */
export interface HistoryEntry {
  title: LibraryTitle;
  video: LibraryVideo;
  /** Seconds. */
  position: number;
  /** Seconds. */
  duration: number;
  /** Watched far enough to count as finished. */
  completed: boolean;
  /** Unix milliseconds. */
  updatedAt: number;
}

/** A recently watched title (`library::HistoryTitle`): its latest video's progress. */
export interface HistoryTitle extends HistoryEntry {
  /** How many of the title's videos have been played: a series' episodes, 1 for a film. */
  playedVideos: number;
}

/** Mirrors `library::TitleLibraryState`. */
export interface TitleLibraryState {
  inWatchlist: boolean;
  /** Every played video of the title, most recent first. */
  progress: HistoryEntry[];
}

/** A title without its display data (`library::TitleRef`). */
export interface TitleRef {
  type: string;
  id: string;
}

/** A progress report (`library::PlaybackProgress`). */
export interface PlaybackProgress {
  title: LibraryTitle;
  video: LibraryVideo;
  position: number;
  duration: number;
}

/** Library commands (`commands::library`): the active profile's watchlist and watch history. */
export const libraryCommands = {
  watchlist: () => invoke<WatchlistItem[]>('library_watchlist'),
  addToWatchlist: (title: LibraryTitle) =>
    invoke<WatchlistItem>('library_watchlist_add', { title }),
  removeFromWatchlist: (type: string, id: string) =>
    invoke<void>('library_watchlist_remove', { type, id }),
  recordProgress: (progress: PlaybackProgress) =>
    invoke<HistoryEntry>('library_record_progress', { progress }),
  /** Recently watched titles (the latest video of each), newest first. */
  history: (limit?: number) => invoke<HistoryTitle[]>('library_history', { limit }),
  /**
   * Titles to carry on with (unfinished, or a series between episodes),
   * newest first, without those taken off the list.
   */
  continueWatching: (limit?: number) =>
    invoke<HistoryEntry[]>('library_continue_watching', { limit }),
  /** Takes a title off Continue watching until it is played again; history is kept. */
  dismissFromContinue: (type: string, id: string) =>
    invoke<void>('library_continue_dismiss', { type, id }),
  /** Undoes `dismissFromContinue`. */
  restoreToContinue: (type: string, id: string) =>
    invoke<void>('library_continue_restore', { type, id }),
  /**
   * Marks a film (its own video) or episodes, in the order watched, as
   * watched. At most 5,000, each once. Returns the title's state.
   */
  markWatched: (title: LibraryTitle, videos: LibraryVideo[]) =>
    invoke<TitleLibraryState>('library_mark_watched', { title, videos }),
  /** Forgets the progress of videos of a title. Returns the title's state. */
  markUnwatched: (type: string, id: string, videos: string[]) =>
    invoke<TitleLibraryState>('library_mark_unwatched', { type, id, videos }),
  /** Finished films, for the watched tick on posters. */
  watchedTitles: () => invoke<TitleRef[]>('library_watched_titles'),
  titleState: (type: string, id: string) =>
    invoke<TitleLibraryState>('library_title_state', { type, id }),
  removeFromHistory: (type: string, id: string) =>
    invoke<void>('library_history_remove', { type, id }),
  clearHistory: () => invoke<void>('library_history_clear'),
};

/** The app as a whole (`settings::GeneralSettings`): what it shares outside Kiro. */
export interface GeneralSettings {
  /**
   * Show what's playing on the user's Discord profile. Sends the title,
   * episode and poster to the Discord app, so it is off unless chosen.
   */
  discordPresence: boolean;
  /** Off: Discord shows "Watching something on Kiro" instead of the title, episode and poster. */
  discordShowTitle: boolean;
  /** The season and episode numbers, after the title. */
  discordShowEpisode: boolean;
}

/**
 * How the player behaves (`settings::PlaybackSettings`): the tracks it picks
 * when a stream loads, resuming, Up next, skipping and volume.
 */
export interface PlaybackSettings {
  /** ISO 639 codes (`en`, `ja`), most preferred first. Empty: the stream's default. */
  audioLanguages: string[];
  subtitleLanguages: string[];
  /** Start with subtitles off (forced subtitles still show). */
  subtitlesOff: boolean;
  /** Skip intros and recaps marked by the file's chapters (or found online) without asking. */
  skipIntros: boolean;
  /**
   * When a file's chapters mark nothing, look up an episode's intro and
   * credits on SkipDB. Sends the IMDb id, season, episode and duration.
   */
  onlineSkipTimes: boolean;
  /** Play the next episode when Up next's countdown ends. Off: wait for Play now. */
  autoplayNext: boolean;
  /** Up next's countdown, in seconds. */
  upNextSeconds: 5 | 10 | 15 | 20 | 30;
  /** How far ←/→ and the skip buttons jump, in seconds. */
  seekSeconds: 5 | 10 | 15 | 30;
  /** Saved progress: resume (with "Start over"), ask first, or start from the beginning. */
  resume: 'always' | 'ask' | 'never';
  /** Start each video at `volume` instead of full volume. */
  rememberVolume: boolean;
  /** The last volume set in the player, in percent (0–130). */
  volume: number;
  /** Watched this much (percent, 70–98): finished. Applies to progress saved from then on. */
  markWatchedPercent: number;
  /** Keep the display awake (no screensaver or display sleep) while a video plays. */
  keepScreenOn: boolean;
  /**
   * Show a frame of the video when hovering over the seek bar. Each one reads
   * part of the stream, only on demand, and none while the player is short
   * of buffered video.
   */
  seekPreviews: boolean;
  /**
   * Decode video on the graphics card where it can (mpv's `hwdec=auto-safe`).
   * Off: on the CPU, for a graphics driver that shows broken frames or stutters.
   */
  hardwareDecoding: boolean;
  /** Send `passthroughFormats` to an AV receiver untouched instead of decoding them. */
  audioPassthrough: boolean;
  /** Distinct, each available on this platform, DTS-HD only with DTS. */
  passthroughFormats: PassthroughFormat[];
}

/**
 * A soundtrack format that can be passed through to an AV receiver
 * (`media::passthrough::PassthroughFormat`).
 */
export type PassthroughFormat = 'ac3' | 'eac3' | 'dts' | 'dtsHd' | 'truehd';

/** How subtitles look (`settings::SubtitleSettings`), and which track type is picked. */
export interface SubtitleSettings {
  /** Percent of the player's default size (50–200). */
  size: number;
  /** `#rrggbb`. */
  color: string;
  edge: 'outline' | 'shadow' | 'background';
  /** Raised above the usual position, percent of the picture's height (0–40). */
  offset: number;
  /** Which track to pick among those in the chosen language. */
  preferredType: 'regular' | 'sdh' | 'forced';
}

/**
 * How Play chooses a stream (`settings::StreamSettings`). Streams the filters
 * exclude are still listed, marked as filtered, but never picked.
 */
export interface StreamSettings {
  /** Highest resolution picked when anything within it is available. */
  maxResolution: 2160 | 1080 | 720;
  /** Pick HDR and Dolby Vision versions first (SDR first when off). */
  preferHdr: boolean;
  /** Pick streams their addon marks as cached (ready to start at once) first. */
  preferCached: boolean;
  /** Filter out cam, telesync and screener releases. */
  excludeCam: boolean;
  /** Filter out larger files, in GB (1–500). `null`: no limit. */
  maxSizeGb: number | null;
  /** Filter out these video codecs. */
  avoidCodecs: ('av1' | 'hevc')[];
  /** Filter out streams naming one of these as a whole word (ignoring case). */
  excludedKeywords: string[];
}

/**
 * One catalogue's place in a page's rows (`settings::CatalogRow`), named by
 * addon id, content type and catalogue id.
 */
export interface CatalogRowSetting {
  addon: string;
  type: string;
  catalog: string;
  /** Left off the page (still listed in its editor). */
  hidden: boolean;
}

/**
 * The catalogue rows of Discover, Movies and TV Shows (`settings::RowSettings`).
 * `null`: every catalogue, in addon order. A layout also remembers rows of
 * addons that aren't installed or enabled now.
 */
export interface RowSettings {
  discover: CatalogRowSetting[] | null;
  movies: CatalogRowSetting[] | null;
  tvShows: CatalogRowSetting[] | null;
}

/** All user preferences (`settings::Settings`). */
export interface Settings {
  general: GeneralSettings;
  playback: PlaybackSettings;
  subtitles: SubtitleSettings;
  streams: StreamSettings;
  rows: RowSettings;
}

/** A part of an episode SkipDB knows, in seconds (`skip_times::SkipTime`). */
export interface SkipTime {
  kind: 'intro' | 'recap' | 'credits' | 'preview';
  /** Within this file, trimmed for `offset`. */
  start: number;
  end: number;
  /** This file's length minus that of the file the times were recorded on. */
  offset: number;
}

/** What SkipDB has for an episode, for the file playing (`skip_times::SkipTimes`). */
export interface SkipTimes {
  /** Where the times come from, for display: `SkipDB`. */
  source: string;
  /** Recorded on a file of (about) this length, in order. */
  segments: SkipTime[];
  /** Times it has for other releases of the episode (another length). */
  unmatched: number;
  /** How long those releases' files are, in seconds, where SkipDB says. */
  otherLengths: number[];
}

/**
 * Intro and credits times looked up online (`commands::skip_times`). Rejects
 * with `INVALID_ARGUMENT` unless the setting is on.
 */
export const skipTimesCommands = {
  lookup: (imdbId: string, season: number, episode: number, duration: number) =>
    invoke<unknown>('skip_times_lookup', { imdbId, season, episode, duration }),
};

/** Settings commands (`commands::settings`): the active profile's, stored on-device by the core. */
export const settingsCommands = {
  get: () => invoke<Settings>('settings_get'),
  /** Rejects with `INVALID_ARGUMENT` if the core refuses a value. */
  set: (settings: Settings) => invoke<Settings>('settings_set', { settings }),
};

/** A profile (`profiles::Profile`). Its PIN never leaves the core, only whether it has one. */
export interface Profile {
  id: number;
  name: string;
  /** One of the built-in avatars (`AVATARS` in `features/profiles/profiles-data.ts`). */
  avatar: string;
  /** Switching into it asks for its 4-digit PIN. */
  hasPin: boolean;
  /** Unix milliseconds. */
  createdAt: number;
  /** Where it is with the first-run setup (`profiles::FirstRun`). */
  firstRun: FirstRun;
}

/** `pending` until the profile's first-run setup is completed or skipped. */
export type FirstRun = 'pending' | 'completed' | 'skipped';

/** Every profile, oldest first, and the active one (`profiles::ProfilesOverview`). */
export interface ProfilesOverview {
  profiles: Profile[];
  /** The library and settings commands act on this profile. */
  active: number;
  /** Show "Who’s watching?" at launch when there is more than one profile. */
  showPicker: boolean;
}

/**
 * Profile commands (`commands::profiles`). Each returns the profiles as they
 * are now. `pin` is the profile's PIN, needed to switch into a locked profile
 * and to change one other than the active profile; a missing or wrong one
 * rejects with `PIN_REQUIRED` or `WRONG_PIN`. Don't keep PINs in a store or log them.
 */
export const profileCommands = {
  list: () => invoke<ProfilesOverview>('profile_list'),
  create: (name: string, avatar: string, pin: string | null) =>
    invoke<ProfilesOverview>('profile_create', { name, avatar, pin }),
  rename: (id: number, name: string, pin?: string) =>
    invoke<ProfilesOverview>('profile_rename', { id, name, pin }),
  setAvatar: (id: number, avatar: string, pin?: string) =>
    invoke<ProfilesOverview>('profile_set_avatar', { id, avatar, pin }),
  /** `newPin`: `null` removes the PIN. */
  setPin: (id: number, newPin: string | null, pin?: string) =>
    invoke<ProfilesOverview>('profile_set_pin', { id, newPin, pin }),
  /**
   * Deletes the profile with its library and settings. Not the active or last
   * one. Needs no PIN (how a profile whose PIN was forgotten is removed): ask
   * for its name to be typed first.
   */
  remove: (id: number) => invoke<ProfilesOverview>('profile_delete', { id }),
  /** Stops playback, then makes `id` the active profile (and the one opened next launch). */
  switchTo: (id: number, pin?: string) => invoke<ProfilesOverview>('profile_switch', { id, pin }),
  setShowPicker: (show: boolean) => invoke<ProfilesOverview>('profile_set_show_picker', { show }),
  /** Records how the active profile's first-run setup ended, so it doesn't show again. */
  finishFirstRun: (outcome: Exclude<FirstRun, 'pending'>) =>
    invoke<ProfilesOverview>('profile_finish_first_run', { outcome }),
};

/**
 * How to sign in to Stremio for an import (`stremio::SignIn`). Sent straight
 * to the core, which passes it to Stremio over https, uses it once and never
 * stores it. Don't keep it in a store or log it.
 */
export type StremioSignIn =
  { method: 'authKey'; authKey: string } | { method: 'password'; email: string; password: string };

/** An addon in the Stremio account (`stremio::StremioAddon`). */
export interface StremioAddon {
  transportUrl: string;
  name: string;
  /** `new`: the import installs it. `unsupported`: not https, or Stremio's local server. */
  status: 'new' | 'installed' | 'unsupported';
}

/** What a Stremio account holds, as Kiro would import it (`stremio::ImportPreview`). */
export interface StremioImportPreview {
  /** Every addon in the account, in Stremio's order. */
  addons: StremioAddon[];
  /** Titles saved in the Stremio library (Kiro's watchlist). */
  libraryItems: number;
  /** Titles with watch progress. */
  watched: number;
  /** Of those, the ones Continue watching will offer to resume. */
  inProgress: number;
  /** Library items Kiro couldn't read or has no use for. */
  skipped: number;
}

/** What an import did with each entry (`library::ImportCounts`). */
export interface ImportCounts {
  added: number;
  /** Replaced older progress for the same video. */
  updated: number;
  /** Kiro already had it, or newer progress for it. */
  skipped: number;
  /** Couldn't be added (a full watchlist). */
  failed: number;
}

/** Mirrors `stremio::LibraryImportSummary`: `null` for a part that wasn't chosen. */
export interface StremioLibrarySummary {
  libraryItems: ImportCounts | null;
  progress: ImportCounts | null;
}

/**
 * Importing a Stremio account (`commands::stremio`). `fetch` signs in, reads
 * the account and keeps it in the core (never the credentials);
 * `importLibrary` imports the chosen parts of it once; `discard` forgets it.
 * Addons are installed with the usual install path (`addonsStore.install`).
 */
export const stremioCommands = {
  fetch: (signIn: StremioSignIn) =>
    invoke<StremioImportPreview>('stremio_import_fetch', { signIn }),
  importLibrary: (choice: { libraryItems: boolean; progress: boolean }) =>
    invoke<StremioLibrarySummary>('stremio_import_library', { choice }),
  discard: () => invoke<void>('stremio_import_discard'),
};

/**
 * Where Kiro's own updating stands (`updates::UpdateStatus`). Release builds
 * check at launch and once a day; development builds are `disabled`.
 */
export type UpdateStatus =
  | { state: 'disabled' }
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'upToDate' }
  | { state: 'downloading'; version: string }
  /** Downloaded and verified: restarting installs it. */
  | { state: 'ready'; version: string }
  /** Newer, but this install can't apply it itself (the Linux .deb): download it. */
  | { state: 'available'; version: string }
  /** `message` is written for the user. */
  | { state: 'failed'; message: string };

/** Kiro updating itself (`commands::updates`). */
export const updateCommands = {
  status: () => invoke<UpdateStatus>('app_update_status'),
  /** Checks now, and downloads a newer version this install can apply. */
  check: () => invoke<UpdateStatus>('app_update_check'),
  /** Installs the downloaded update and restarts Kiro (on Windows, the installer takes over). */
  install: () => invoke<void>('app_update_install'),
  /** Opens the release page of `version` in the browser. */
  openDownload: (version: string) => invoke<void>('app_update_open_download', { version }),
};
