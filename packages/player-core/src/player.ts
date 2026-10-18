import type { Chapter } from './chapters';
import type { Listener, Unsubscribe } from './emitter';
import type { PlayerError } from './errors';
import type { ExternalSubtitle, MediaSource } from './source';
import type { MediaTrack } from './tracks';

/**
 * `native` — libmpv driven by the Rust core (hardware decoding, HDR, MKV, ...).
 * `web`    — HTML5 `<video>`, a fallback for formats the webview supports.
 */
export type PlayerBackend = 'native' | 'web';

export type PlaybackState = 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'ended' | 'error';

export interface PlayerCapabilities {
  hardwareDecoding: boolean;
  hdr: boolean;
  /** Lower-case container names the backend can demux (`mkv`, `mp4`, ...). */
  containers: readonly string[];
  multipleAudioTracks: boolean;
  embeddedSubtitles: boolean;
  externalSubtitles: boolean;
  localFiles: boolean;
  /** Upper bound for `setVolume`; values above 1 allow amplification. */
  maxVolume: number;
}

export interface PlayerEventMap {
  stateChange: { state: PlaybackState };
  timeUpdate: { position: number; duration: number | null };
  /** `progress` is the fraction (0–1) of the upcoming buffer target already cached. */
  buffering: { buffering: boolean; progress?: number };
  tracksChange: { tracks: readonly MediaTrack[] };
  /** The loaded media's chapters, ordered by start; empty when it has none. */
  chaptersChange: { chapters: readonly Chapter[] };
  trackSelect: { kind: 'audio' | 'subtitle'; trackId: string | null };
  volumeChange: { volume: number; muted: boolean };
  error: { error: PlayerError };
  ended: Record<string, never>;
}

/**
 * Backend-agnostic playback contract. Every command is async because native
 * backends execute off the UI thread; queries that the backend pushes via
 * events (`getState`) are synchronous.
 *
 * Implementations must reject with a `PlayerError`.
 */
export interface MediaPlayer {
  readonly backend: PlayerBackend;
  readonly capabilities: PlayerCapabilities;

  load(source: MediaSource): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  /** Seek to an absolute position in seconds. */
  seek(seconds: number): Promise<void>;
  /** Volume from 0 to `capabilities.maxVolume`. Out-of-range values are clamped. */
  setVolume(volume: number): Promise<void>;
  setMuted(muted: boolean): Promise<void>;

  getState(): PlaybackState;
  /** Current position in seconds. */
  getPosition(): Promise<number>;
  /** Duration in seconds, or `null` for live or not-yet-known streams. */
  getDuration(): Promise<number | null>;

  getTracks(): Promise<readonly MediaTrack[]>;
  selectAudioTrack(trackId: string): Promise<void>;
  /** Pass `null` to disable subtitles. */
  selectSubtitleTrack(trackId: string | null): Promise<void>;
  addExternalSubtitle(subtitle: ExternalSubtitle): Promise<MediaTrack>;

  on<E extends keyof PlayerEventMap>(event: E, listener: Listener<PlayerEventMap[E]>): Unsubscribe;

  /** Releases all native and DOM resources. The instance is unusable afterwards. */
  destroy(): Promise<void>;
}

/** Creates players for one backend. Registered in preference order by the app. */
export interface MediaPlayerFactory {
  readonly backend: PlayerBackend;
  /** Whether the backend can run in the current environment (e.g. libmpv present). */
  isAvailable(): Promise<boolean>;
  /** Cheap, synchronous check of whether the backend is likely to handle `source`. */
  canPlay(source: MediaSource): boolean;
  create(): Promise<MediaPlayer>;
}

/** Returns the first available factory, in preference order, that can play `source`. */
export async function resolvePlayerFactory(
  factories: readonly MediaPlayerFactory[],
  source: MediaSource,
): Promise<MediaPlayerFactory | null> {
  for (const factory of factories) {
    if (factory.canPlay(source) && (await factory.isAvailable())) return factory;
  }
  return null;
}
