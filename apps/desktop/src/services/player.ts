/**
 * Typed bridge to the libmpv player commands in
 * `src-tauri/src/commands/player.rs`. Those commands exist only when the app
 * is built with `--features libmpv` (`AppInfo.nativePlayer`), which `pnpm dev`
 * enables automatically on macOS, Windows and Linux when libmpv is found.
 *
 * Use it through `NativePlayer` (`features/playback/native-player.ts`), which
 * implements `MediaPlayer` from `@kiro/player-core` on top of it.
 */
import type { Chapter, MediaTrack, PlaybackState, PlayerEventMap } from '@kiro/player-core';
import { Channel, invoke } from '@tauri-apps/api/core';

import type { SubtitleSettings } from '@/services/native';

/** Mirrors `media::model::PlayerSnapshot` in Rust. */
export interface PlayerSnapshot {
  state: PlaybackState;
  position: number;
  duration: number | null;
  buffering: boolean;
  tracks: MediaTrack[];
  /** Ordered by start, at most `media::model::MAX_CHAPTERS`. */
  chapters: Chapter[];
  audioTrackId: string | null;
  subtitleTrackId: string | null;
  /** 0 to `maxVolume`, where 1 is unity gain. */
  volume: number;
  muted: boolean;
  maxVolume: number;
  /** Seconds subtitles are shown later (earlier when negative). */
  subtitleDelay: number;
  /** Seconds the audio plays later (earlier when negative). */
  audioDelay: number;
  /** Playback speed, where 1 is normal. */
  speed: number;
}

/** Mirrors `PlayerEvent::TimingChange`: the native player's delays and speed. */
export interface PlayerTiming {
  subtitleDelay: number;
  audioDelay: number;
  speed: number;
}

/** A playback failure as sent by Rust (`media::model::PlayerFailure`). */
export interface PlayerFailure {
  code: 'UNSUPPORTED_SOURCE' | 'NETWORK' | 'DECODE' | 'UNKNOWN';
  message: string;
  recoverable: boolean;
}

/**
 * Payloads as sent by Rust: `PlayerEventMap`, with errors as plain data, plus
 * `timingChange`, which only the native player has.
 */
export type NativeEventMap = Omit<PlayerEventMap, 'error'> & {
  error: { error: PlayerFailure };
  timingChange: PlayerTiming;
};

/** Mirrors `media::model::PlayerEvent`: one `PlayerEventMap` entry. */
export type NativePlayerEvent = {
  [E in keyof NativeEventMap]: { event: E; payload: NativeEventMap[E] };
}[keyof NativeEventMap];

/** Mirrors `media::mpv::DebugStats` in Rust. */
export interface PlayerStats {
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  hwdec: string | null;
  primaries: string | null;
  gamma: string | null;
  fps: number | null;
  droppedFrames: number;
  cacheSeconds: number | null;
  /** The audio track's codec, e.g. `eac3`. */
  audioCodec: string | null;
  /** `passthrough eac3` (sent to the receiver untouched) or `decoded`; `null` without audio. */
  audioMode: string | null;
  /** mpv's audio output, e.g. `coreaudio`, `coreaudio_exclusive`, `wasapi`. */
  audioOutput: string | null;
  framesRendered: number;
  samplePixel: string;
  contentsScale: number;
}

export interface SubtitleRequest {
  /** https only. */
  url: string;
  label?: string;
  language?: string;
}

/**
 * How subtitles look, as `media::SubtitleStyle` validates it: the look part
 * of `SubtitleSettings`.
 */
export type SubtitleStyle = Pick<SubtitleSettings, 'size' | 'color' | 'edge' | 'offset'>;

/**
 * What Discord Rich Presence may know about the video playing (Settings →
 * General). Mirrors `commands::player::NowPlayingArgs`: nothing else is
 * accepted, so stream URLs and addon names can't be sent.
 */
export interface NowPlaying {
  title: string;
  season: number | null;
  episode: number | null;
  /** Used only when https. */
  poster: string | null;
}

/** The player commands, as an interface so tests can substitute a fake. */
export interface PlayerBridge {
  /** Creates (or reconnects to) the native player; events arrive on `onEvent`. */
  attach(onEvent: (event: NativePlayerEvent) => void): Promise<PlayerSnapshot>;
  detach(): Promise<void>;
  load(url: string, startPosition?: number): Promise<void>;
  /** What is playing, for Discord Rich Presence; `null`: nothing it may know about. */
  setNowPlaying(nowPlaying: NowPlaying | null): Promise<void>;
  setPaused(paused: boolean): Promise<void>;
  seek(seconds: number): Promise<void>;
  setVolume(volume: number): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  stop(): Promise<void>;
  selectAudioTrack(id: string): Promise<void>;
  selectSubtitleTrack(id: string | null): Promise<void>;
  addSubtitle(subtitle: SubtitleRequest): Promise<MediaTrack>;
  /** Kept by the player for later media too. */
  setSubtitleStyle(style: SubtitleStyle): Promise<void>;
  /** Seconds, clamped to ±60 by Rust. Kept by the player for later media too. */
  setSubtitleDelay(seconds: number): Promise<void>;
  /** Seconds, clamped to ±10 by Rust. Kept by the player for later media too. */
  setAudioDelay(seconds: number): Promise<void>;
  /** Clamped to 0.25–4 by Rust. Kept by the player for later media too. */
  setSpeed(speed: number): Promise<void>;
  stats(): Promise<PlayerStats>;
}

/**
 * A seek-bar preview (`commands::player::player_preview`), or why there
 * isn't one. Mirrors `media::mpv::PreviewResult`.
 */
export type PlayerPreview =
  /** `image`: a JPEG `data:` URL; `position`: the keyframe shown, at or before the one asked for. */
  | { status: 'frame'; position: number; image: string }
  /** Not now: the player is short of buffered video. */
  | { status: 'busy' }
  /** A newer request replaced this one. */
  | { status: 'superseded' }
  /** Nothing to preview for this stream (or the setting is off). */
  | { status: 'unavailable' };

/** A frame at `position` seconds for the seek bar. Resolves to `unknown`: check it with `parsePlayerPreview`. */
export function previewCommand(position: number): Promise<unknown> {
  return invoke<unknown>('player_preview', { position });
}

export const tauriPlayerBridge: PlayerBridge = {
  attach: (onEvent) => {
    const channel = new Channel<NativePlayerEvent>();
    channel.onmessage = onEvent;
    return invoke<PlayerSnapshot>('player_attach', { onEvent: channel });
  },
  detach: () => invoke('player_detach'),
  load: (url, startPosition) => invoke('player_load', { url, startPosition }),
  setNowPlaying: (nowPlaying) => invoke('player_set_now_playing', { nowPlaying }),
  setPaused: (paused) => invoke('player_set_paused', { paused }),
  seek: (seconds) => invoke('player_seek', { seconds }),
  setVolume: (volume) => invoke('player_set_volume', { volume }),
  setMuted: (muted) => invoke('player_set_muted', { muted }),
  stop: () => invoke('player_stop'),
  selectAudioTrack: (id) => invoke('player_select_audio_track', { id }),
  selectSubtitleTrack: (id) => invoke('player_select_subtitle_track', { id }),
  addSubtitle: ({ url, label, language }) =>
    invoke<MediaTrack>('player_add_subtitle', { url, label, language }),
  setSubtitleStyle: ({ size, color, edge, offset }) =>
    invoke('player_set_subtitle_style', { style: { size, color, edge, offset } }),
  setSubtitleDelay: (seconds) => invoke('player_set_subtitle_delay', { seconds }),
  setAudioDelay: (seconds) => invoke('player_set_audio_delay', { seconds }),
  setSpeed: (speed) => invoke('player_set_speed', { speed }),
  stats: () => invoke<PlayerStats>('player_stats'),
};
