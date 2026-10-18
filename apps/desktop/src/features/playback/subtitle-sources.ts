/**
 * One stream's track choice and addon subtitles: applies the preferred
 * languages (Settings → Playback) once the stream's tracks are known, lists
 * the subtitles addons offer as they arrive, and loads one into the player
 * when it is picked, by the user or by the preferred subtitle languages.
 *
 * Nothing is added to the player before its stream has loaded, so subtitles
 * never hold up opening it. Once the user picks a subtitle (or Off), the
 * preferences stop switching subtitles for this stream.
 */
import type { ResourceRequest } from '@kiro/addon-sdk';
import type { MediaTrack, PlayerEventMap, Unsubscribe } from '@kiro/player-core';

import type { InstalledAddon } from '@/features/addons/addons-store';
import {
  fetchAddonSubtitles,
  mergeSubtitles,
  playerLabel,
  type AddonSubtitle,
  type FetchResource,
} from '@/features/playback/addon-subtitles';
import { chooseTracks, type TrackSettings } from '@/features/playback/track-preferences';

/** The part of `NativePlayer` this needs. */
export interface TracksPlayer {
  getView(): {
    tracks: readonly MediaTrack[];
    audioTrackId: string | null;
    subtitleTrackId: string | null;
  };
  on<E extends 'stateChange' | 'tracksChange'>(
    event: E,
    listener: (payload: PlayerEventMap[E]) => void,
  ): Unsubscribe;
  selectAudioTrack(trackId: string): Promise<void>;
  selectSubtitleTrack(trackId: string | null): Promise<void>;
  addExternalSubtitle(subtitle: {
    url: string;
    label?: string;
    language?: string;
  }): Promise<MediaTrack>;
}

export interface SubtitleSourcesState {
  /** Addon and stream subtitles, in arrival order. */
  subtitles: readonly AddonSubtitle[];
  /** Some addon has not answered yet. */
  searching: boolean;
  /** Player track ids of the addon subtitles loaded so far, by URL. */
  loaded: Readonly<Record<string, string>>;
  /** URLs being loaded into the player. */
  loading: readonly string[];
  /** URLs that could not be loaded. */
  failed: readonly string[];
}

/**
 * - `waiting`: this stream hasn't started loading (the player may still
 *   report the previous one);
 * - `loading`: preferences apply when its tracks arrive;
 * - `ready`: loaded, subtitles can be added.
 */
type Phase = 'waiting' | 'loading' | 'ready';

export class SubtitleSources {
  private state: SubtitleSourcesState;
  private readonly listeners = new Set<() => void>();
  private phase: Phase = 'waiting';
  /** The user chose a subtitle: `null` for Off, or a track id once known. */
  private userChoice: string | null | undefined;
  private touched = false;
  /** An automatic load is in flight; changes meanwhile apply after it. */
  private autoLoading = false;
  private rerun = false;

  constructor(
    private readonly player: TracksPlayer,
    private readonly readSettings: () => Promise<TrackSettings>,
    streamSubtitles: readonly AddonSubtitle[] = [],
  ) {
    this.state = {
      subtitles: mergeSubtitles([], streamSubtitles),
      searching: false,
      loaded: {},
      loading: [],
      failed: [],
    };
  }

  /** Follows the player's events until the returned function is called. */
  connect(): Unsubscribe {
    const offState = this.player.on('stateChange', ({ state }) => {
      if (state === 'loading') this.phase = 'loading';
      else if (state === 'error' || state === 'idle') this.phase = 'waiting';
    });
    const offTracks = this.player.on('tracksChange', ({ tracks }) => {
      if (this.phase !== 'loading' || tracks.length === 0) return;
      this.phase = 'ready';
      void this.applyPreferences(true);
    });
    return () => {
      offState();
      offTracks();
    };
  }

  /**
   * Asks `addons` for subtitles (`request`) and lists them as they arrive.
   * Returns a function that cancels the requests still running.
   */
  search(addons: readonly InstalledAddon[], request: ResourceRequest, fetch: FetchResource) {
    const controller = new AbortController();
    if (addons.length === 0) return () => undefined;
    this.update({ searching: true });
    void fetchAddonSubtitles({
      addons,
      request,
      fetch,
      signal: controller.signal,
      onSubtitles: (subtitles) => this.add(subtitles),
    }).finally(() => {
      if (!controller.signal.aborted) this.update({ searching: false });
    });
    return () => {
      controller.abort();
      this.update({ searching: false });
    };
  }

  /** Lists more subtitles; once the stream has loaded, they may be picked automatically. */
  add(subtitles: readonly AddonSubtitle[]) {
    const merged = mergeSubtitles(this.state.subtitles, subtitles);
    if (merged.length === this.state.subtitles.length) return;
    this.update({ subtitles: merged });
    if (this.phase === 'ready') void this.applyPreferences(false);
  }

  /** The user picked an addon subtitle: shows it, loading it first if needed. */
  async pick(subtitle: AddonSubtitle): Promise<void> {
    this.touched = true;
    const trackId = this.state.loaded[subtitle.url];
    if (trackId !== undefined) {
      this.userChoice = trackId;
      return this.player.selectSubtitleTrack(trackId);
    }
    this.userChoice = await this.load(subtitle);
  }

  /** The user picked one of the player's own subtitle tracks (`null`: Off). */
  pickTrack(trackId: string | null): Promise<void> {
    this.touched = true;
    this.userChoice = trackId;
    return this.player.selectSubtitleTrack(trackId);
  }

  /** The user added a subtitle file themselves (it is shown once loaded). */
  picked(track: MediaTrack) {
    this.touched = true;
    this.userChoice = track.id;
  }

  // --- React bindings (useSyncExternalStore) -------------------------------

  readonly subscribe = (listener: () => void): Unsubscribe => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getState = (): SubtitleSourcesState => this.state;

  // --- internals -----------------------------------------------------------

  private update(patch: Partial<SubtitleSourcesState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  /**
   * Picks tracks for the preferred languages: audio only right after
   * loading, subtitles until the user picks some. Addon subtitles already
   * loaded or that failed are left out (loaded ones are player tracks now).
   */
  private async applyPreferences(audio: boolean) {
    if (this.autoLoading) {
      this.rerun = true;
      return;
    }
    let settings: TrackSettings;
    try {
      settings = await this.readSettings();
    } catch {
      return;
    }
    const { loaded, failed } = this.state;
    const candidates = this.state.subtitles.filter(
      (subtitle) => loaded[subtitle.url] === undefined && !failed.includes(subtitle.url),
    );
    const current = this.player.getView();
    const choice = chooseTracks(current.tracks, settings, current, candidates);
    // A failed switch leaves the stream's default track playing.
    if (audio && choice.audioTrackId !== undefined) {
      this.player.selectAudioTrack(choice.audioTrackId).catch(() => undefined);
    }
    if (this.touched || this.autoLoading) return;
    if (choice.subtitleTrackId !== undefined) {
      this.player.selectSubtitleTrack(choice.subtitleTrackId).catch(() => undefined);
    } else if (choice.addonSubtitle) {
      await this.autoLoad(choice.addonSubtitle);
    }
  }

  private async autoLoad(subtitle: AddonSubtitle) {
    this.autoLoading = true;
    let ok = true;
    try {
      await this.load(subtitle);
    } catch {
      ok = false;
    } finally {
      this.autoLoading = false;
    }
    // Adding a file shows it: put back what the user picked meanwhile.
    if (this.touched && ok && this.userChoice !== undefined) {
      this.player.selectSubtitleTrack(this.userChoice).catch(() => undefined);
    }
    // Try the next best after a failure, or apply what arrived meanwhile.
    if (!ok || this.rerun) {
      this.rerun = false;
      await this.applyPreferences(false);
    }
  }

  /** Adds `subtitle` to the player (which shows it) and returns its track id. */
  private async load(subtitle: AddonSubtitle): Promise<string> {
    const { url } = subtitle;
    this.update({ loading: [...this.state.loading, url] });
    try {
      const track = await this.player.addExternalSubtitle({
        url,
        label: playerLabel(subtitle),
        ...(subtitle.language && { language: subtitle.language }),
      });
      this.update({
        loaded: { ...this.state.loaded, [url]: track.id },
        failed: this.state.failed.filter((failed) => failed !== url),
      });
      return track.id;
    } catch (error) {
      this.update({ failed: [...this.state.failed, url] });
      throw error;
    } finally {
      this.update({ loading: this.state.loading.filter((loading) => loading !== url) });
    }
  }
}
