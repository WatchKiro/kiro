/**
 * `MediaPlayer` backed by the Rust libmpv player.
 *
 * Commands go through a {@link PlayerBridge}; state arrives as events over a
 * Tauri channel (no polling) and is mirrored here so `getState()` and the
 * React bindings can read it synchronously.
 *
 * Only one native player exists per window. `create()` and `destroy()` are
 * queued per bridge, so React StrictMode's mount → unmount → mount reaches
 * Rust as attach → detach → attach, in that order.
 */
import {
  createEmitter,
  type Chapter,
  PlayerError,
  type ExternalSubtitle,
  type MediaPlayer,
  type MediaSource,
  type MediaTrack,
  type PlaybackState,
  type PlayerCapabilities,
  type PlayerErrorCode,
  type PlayerEventMap,
  type Unsubscribe,
} from '@kiro/player-core';

import { MAX_AUDIO_DELAY, MAX_SUBTITLE_DELAY, clampSpeed } from '@/features/playback/timing';
import type {
  BufferedRange,
  NativePlayerEvent,
  NowPlaying,
  PlayerBridge,
  PlayerFailure,
  PlayerSnapshot,
  SubtitleStyle,
} from '@/services/player';

/** Everything the player UI renders, replaced (never mutated) on each change. */
export interface NativePlayerView {
  state: PlaybackState;
  position: number;
  duration: number | null;
  buffering: boolean;
  bufferingProgress: number | null;
  tracks: readonly MediaTrack[];
  chapters: readonly Chapter[];
  /** Where seeking is instant: what the player holds, in order. */
  buffered: readonly BufferedRange[];
  audioTrackId: string | null;
  subtitleTrackId: string | null;
  volume: number;
  muted: boolean;
  /** Seconds subtitles are shown later (earlier when negative). */
  subtitleDelay: number;
  /** Seconds the audio plays later (earlier when negative). */
  audioDelay: number;
  /** Playback speed, where 1 is normal. */
  speed: number;
}

const lifecycles = new WeakMap<PlayerBridge, Promise<unknown>>();

/** Runs `task` after every lifecycle task queued earlier on `bridge`. */
function enqueue<T>(bridge: PlayerBridge, task: () => Promise<T>): Promise<T> {
  const previous = lifecycles.get(bridge) ?? Promise.resolve();
  const next = previous.then(task, task);
  lifecycles.set(
    bridge,
    next.catch(() => undefined),
  );
  return next;
}

/** Maps a command rejection (`{ code, message }` from Rust) to a `PlayerError`. */
export function toPlayerError(reason: unknown, fallback: PlayerErrorCode = 'UNKNOWN'): PlayerError {
  if (reason instanceof PlayerError) return reason;
  const { code, message } =
    typeof reason === 'object' && reason !== null
      ? (reason as { code?: unknown; message?: unknown })
      : { code: undefined, message: reason };
  const text = typeof message === 'string' ? message : String(reason);
  const mapped: Record<string, PlayerErrorCode> = {
    PLAYER_NOT_ATTACHED: 'BACKEND_UNAVAILABLE',
    NOT_LOADED: 'NOT_LOADED',
    TRACK_NOT_FOUND: 'TRACK_NOT_FOUND',
    UNSUPPORTED_SOURCE: 'UNSUPPORTED_SOURCE',
  };
  // Builds without the libmpv feature do not register the commands at all.
  if (/command .* not found/i.test(text)) {
    return new PlayerError(
      'BACKEND_UNAVAILABLE',
      'The native player is not available in this build',
      {
        cause: reason,
      },
    );
  }
  const resolved = (typeof code === 'string' && mapped[code]) || fallback;
  return new PlayerError(resolved, text, { cause: reason });
}

function fromFailure(failure: PlayerFailure): PlayerError {
  return new PlayerError(failure.code, failure.message, { recoverable: failure.recoverable });
}

export class NativePlayer implements MediaPlayer {
  readonly backend = 'native' as const;
  readonly capabilities: PlayerCapabilities;

  private readonly emitter = createEmitter<PlayerEventMap>();
  private readonly viewListeners = new Set<() => void>();
  private view: NativePlayerView = {
    state: 'idle',
    position: 0,
    duration: null,
    buffering: false,
    bufferingProgress: null,
    tracks: [],
    chapters: [],
    buffered: [],
    audioTrackId: null,
    subtitleTrackId: null,
    volume: 1,
    muted: false,
    subtitleDelay: 0,
    audioDelay: 0,
    speed: 1,
  };
  private destroyed = false;
  /** Events that arrived before the attach snapshot; replayed after it. */
  private early: NativePlayerEvent[] | null = [];
  /** Subtitles from the last `load()`, added once its tracks are known. */
  private pendingSubtitles: readonly ExternalSubtitle[] = [];

  /**
   * Resolves once the native player is attached and this instance holds its
   * state. Rejects with `BACKEND_UNAVAILABLE` in builds without libmpv.
   */
  readonly ready: Promise<void>;

  /**
   * Starts attaching the native player to this window and returns at once,
   * so that a `destroy()` issued before attaching finishes is still queued
   * after it. Commands wait for {@link ready}.
   */
  static attach(bridge: PlayerBridge): NativePlayer {
    return new NativePlayer(bridge);
  }

  /** `attach`, then wait until ready (the `MediaPlayerFactory.create` shape). */
  static async create(bridge: PlayerBridge): Promise<NativePlayer> {
    const player = NativePlayer.attach(bridge);
    await player.ready;
    return player;
  }

  private constructor(private readonly bridge: PlayerBridge) {
    this.capabilities = {
      hardwareDecoding: true,
      // HDR10 decodes in hardware but is tone-mapped to SDR (docs/playback.md).
      hdr: false,
      containers: ['mkv', 'mp4', 'webm', 'mov', 'avi', 'ts', 'm3u8'],
      multipleAudioTracks: true,
      embeddedSubtitles: true,
      externalSubtitles: true,
      localFiles: false,
      maxVolume: 1.3,
    };
    this.ready = enqueue(bridge, () =>
      bridge.attach((event) => (this.early ? this.early.push(event) : this.handle(event))),
    ).then(
      (snapshot) => this.applySnapshot(snapshot),
      (reason: unknown) => {
        throw toPlayerError(reason, 'BACKEND_UNAVAILABLE');
      },
    );
    // Callers observe failures through `ready` or the commands that await it.
    this.ready.catch(() => undefined);
  }

  private applySnapshot(snapshot: PlayerSnapshot) {
    this.capabilities.maxVolume = snapshot.maxVolume;
    const { maxVolume: _, ...view } = snapshot;
    const early = this.early ?? [];
    this.early = null;
    this.update({ ...view, bufferingProgress: null });
    for (const event of early) this.handle(event);
  }

  // --- MediaPlayer ---------------------------------------------------------

  async load(source: MediaSource): Promise<void> {
    this.assertAlive();
    if (source.kind === 'local') {
      throw new PlayerError('UNSUPPORTED_SOURCE', 'Local files are not supported yet');
    }
    if (source.headers && Object.keys(source.headers).length > 0) {
      throw new PlayerError(
        'UNSUPPORTED_SOURCE',
        'Streams that need custom headers are not supported yet',
      );
    }
    this.pendingSubtitles = source.externalSubtitles ?? [];
    await this.call(() => this.bridge.load(source.url, source.startPosition), 'UNSUPPORTED_SOURCE');
  }

  /**
   * Tells Discord Rich Presence what is playing. It shows nothing unless
   * Settings → General turns it on.
   */
  setNowPlaying(nowPlaying: NowPlaying | null): Promise<void> {
    return this.call(() => this.bridge.setNowPlaying(nowPlaying));
  }

  /** Resumes playback; after the end, starts again from the beginning. */
  play(): Promise<void> {
    return this.call(async () => {
      if (this.view.state === 'ended') await this.bridge.seek(0);
      await this.bridge.setPaused(false);
    });
  }

  pause(): Promise<void> {
    return this.call(() => this.bridge.setPaused(true));
  }

  seek(seconds: number): Promise<void> {
    return this.call(() => this.bridge.seek(Math.max(0, seconds)));
  }

  setVolume(volume: number): Promise<void> {
    const clamped = Math.min(Math.max(volume, 0), this.capabilities.maxVolume);
    return this.call(() => this.bridge.setVolume(clamped));
  }

  setMuted(muted: boolean): Promise<void> {
    return this.call(() => this.bridge.setMuted(muted));
  }

  getState(): PlaybackState {
    return this.view.state;
  }

  getPosition(): Promise<number> {
    return Promise.resolve(this.view.position);
  }

  getDuration(): Promise<number | null> {
    return Promise.resolve(this.view.duration);
  }

  getTracks(): Promise<readonly MediaTrack[]> {
    return Promise.resolve(this.view.tracks);
  }

  selectAudioTrack(trackId: string): Promise<void> {
    return this.call(() => this.bridge.selectAudioTrack(trackId), 'TRACK_NOT_FOUND');
  }

  selectSubtitleTrack(trackId: string | null): Promise<void> {
    return this.call(() => this.bridge.selectSubtitleTrack(trackId), 'TRACK_NOT_FOUND');
  }

  addExternalSubtitle(subtitle: ExternalSubtitle): Promise<MediaTrack> {
    const { url, label, language } = subtitle;
    return this.call(
      () =>
        this.bridge.addSubtitle({
          url,
          ...(label === undefined ? {} : { label }),
          ...(language === undefined ? {} : { language }),
        }),
      'NETWORK',
    );
  }

  /** Changes how subtitles look, for this and later streams. */
  setSubtitleStyle(style: SubtitleStyle): Promise<void> {
    return this.call(() => this.bridge.setSubtitleStyle(style));
  }

  /**
   * Shows subtitles `seconds` later (earlier when negative), within ±60 s.
   * The player keeps it for later streams too, until changed.
   */
  setSubtitleDelay(seconds: number): Promise<void> {
    const clamped = Math.min(Math.max(seconds, -MAX_SUBTITLE_DELAY), MAX_SUBTITLE_DELAY);
    return this.call(() => this.bridge.setSubtitleDelay(clamped));
  }

  /** Plays the audio `seconds` later (earlier when negative), within ±10 s. */
  setAudioDelay(seconds: number): Promise<void> {
    const clamped = Math.min(Math.max(seconds, -MAX_AUDIO_DELAY), MAX_AUDIO_DELAY);
    return this.call(() => this.bridge.setAudioDelay(clamped));
  }

  /** Playback speed from 0.25 to 4, where 1 is normal. */
  setSpeed(speed: number): Promise<void> {
    return this.call(() => this.bridge.setSpeed(clampSpeed(speed)));
  }

  on<E extends keyof PlayerEventMap>(
    event: E,
    listener: (payload: PlayerEventMap[E]) => void,
  ): Unsubscribe {
    return this.emitter.on(event, listener);
  }

  /** Stops playback and releases the native player. Safe to call more than once. */
  destroy(): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    this.destroyed = true;
    this.emitter.clear();
    this.viewListeners.clear();
    return enqueue(this.bridge, () => this.bridge.detach()).catch((reason: unknown) => {
      throw toPlayerError(reason);
    });
  }

  // --- React bindings (useSyncExternalStore) -------------------------------

  readonly subscribe = (listener: () => void): Unsubscribe => {
    this.viewListeners.add(listener);
    return () => this.viewListeners.delete(listener);
  };

  readonly getView = (): NativePlayerView => this.view;

  // --- internals -----------------------------------------------------------

  private assertAlive() {
    if (this.destroyed) throw new PlayerError('DESTROYED', 'The player was destroyed');
  }

  private async call<T>(command: () => Promise<T>, fallback?: PlayerErrorCode): Promise<T> {
    this.assertAlive();
    await this.ready;
    this.assertAlive();
    try {
      return await command();
    } catch (reason) {
      throw toPlayerError(reason, fallback);
    }
  }

  private update(patch: Partial<NativePlayerView>) {
    this.view = { ...this.view, ...patch };
    for (const listener of [...this.viewListeners]) listener();
  }

  private handle(message: NativePlayerEvent) {
    if (this.destroyed) return;
    switch (message.event) {
      case 'stateChange': {
        const previous = this.view.state;
        this.update({ state: message.payload.state });
        this.emitter.emit('stateChange', message.payload);
        if (previous === 'loading' && message.payload.state !== 'error') this.addPendingSubtitles();
        return;
      }
      case 'timeUpdate':
        this.update(message.payload);
        this.emitter.emit('timeUpdate', message.payload);
        return;
      case 'buffering':
        this.update({
          buffering: message.payload.buffering,
          bufferingProgress: message.payload.progress ?? null,
        });
        this.emitter.emit('buffering', message.payload);
        return;
      case 'tracksChange':
        this.update({ tracks: message.payload.tracks });
        this.emitter.emit('tracksChange', message.payload);
        return;
      case 'chaptersChange':
        this.update({ chapters: message.payload.chapters });
        this.emitter.emit('chaptersChange', message.payload);
        return;
      case 'trackSelect':
        this.update(
          message.payload.kind === 'audio'
            ? { audioTrackId: message.payload.trackId }
            : { subtitleTrackId: message.payload.trackId },
        );
        this.emitter.emit('trackSelect', message.payload);
        return;
      case 'volumeChange':
        this.update(message.payload);
        this.emitter.emit('volumeChange', message.payload);
        return;
      case 'timingChange':
        // Not a `PlayerEventMap` event: the view alone carries it.
        this.update(message.payload);
        return;
      case 'bufferedChange':
        this.update({ buffered: message.payload.ranges });
        return;
      case 'error':
        this.emitter.emit('error', { error: fromFailure(message.payload.error) });
        return;
      case 'ended':
        this.emitter.emit('ended', message.payload);
        return;
    }
  }

  /** Adds the subtitles passed to `load()`; failures are reported as recoverable errors. */
  private addPendingSubtitles() {
    const subtitles = this.pendingSubtitles;
    this.pendingSubtitles = [];
    for (const subtitle of subtitles) {
      this.addExternalSubtitle(subtitle).catch((reason: unknown) => {
        const error = toPlayerError(reason, 'NETWORK');
        this.emitter.emit('error', {
          error: new PlayerError(error.code, error.message, { recoverable: true, cause: error }),
        });
      });
    }
  }
}
