/**
 * Development only: an imitation of the libmpv player commands for the
 * browser preview (see `preview-backend.ts`). It plays nothing; it reports
 * a believable session (tracks, a clock, pausing, seeking, volume, delays and
 * speed) over the same event channel, and shows a still behind the
 * transparent player page so the controls can be reviewed over a picture,
 * with a caption in the subtitle style from Settings while a subtitle track
 * is on. Like mpv, it keeps the delays and speed from one stream to the next.
 * Stream URLs with `dead` in them fail to open, as a dead link does, and
 * those with `drops` fail a few seconds after they start.
 */
import type { Chapter, MediaTrack, PlaybackState } from '@kiro/player-core';

import { captionCss } from '@/features/playback/subtitle-appearance';
import type {
  NativePlayerEvent,
  PlayerSnapshot,
  PlayerStats,
  SubtitleStyle,
} from '@/services/player';

/** A still behind the player page while "playing". */
const STILL = 'https://images.metahub.space/background/large/tt0903747/img';
/** Also what the preview's SkipDB times (`preview-backend.ts`) are recorded for. */
export const DURATION = 2_820;

const TRACKS: MediaTrack[] = [
  {
    id: 'a1',
    kind: 'audio',
    label: 'Surround',
    language: 'eng',
    codec: 'eac3',
    channels: 6,
    isDefault: true,
  },
  { id: 'a2', kind: 'audio', label: 'Stereo', language: 'eng', codec: 'aac', channels: 2 },
  { id: 'a3', kind: 'audio', language: 'spa', codec: 'ac3', channels: 6 },
  {
    id: 's1',
    kind: 'subtitle',
    label: 'English',
    language: 'eng',
    codec: 'subrip',
    isDefault: true,
  },
  { id: 's2', kind: 'subtitle', label: 'English (SDH)', language: 'eng', codec: 'subrip' },
  { id: 's3', kind: 'subtitle', language: 'spa', codec: 'subrip' },
  { id: 's4', kind: 'subtitle', language: 'fre', codec: 'subrip', isForced: true },
];

/** A recap and intro to skip, and closing credits that bring Up next forward. */
const CHAPTERS: Chapter[] = [
  { start: 0, title: 'Previously on' },
  { start: 48, title: 'Opening' },
  { start: 110, title: 'Chapter 3' },
  { start: 1_400, title: 'Chapter 4' },
  { start: 2_700, title: 'End Credits' },
];

/**
 * The file's chapters. Most streaming releases have none, or only numbered
 * ones, which is when Skip intro looks times up online: set
 * `localStorage['kiro.preview.chapters']` to `none` or `numbered` to try it.
 */
function fileChapters(): Chapter[] {
  let mode: string | null = null;
  try {
    mode = localStorage.getItem('kiro.preview.chapters');
  } catch {
    // No storage: the default.
  }
  if (mode === 'none') return [];
  if (mode === 'numbered')
    return CHAPTERS.map(({ start }, index) => ({ start, title: `Chapter ${index + 1}` }));
  return CHAPTERS;
}

type Channel = { onmessage: (event: NativePlayerEvent) => void };
type Args = Record<string, unknown>;

let channel: Channel | null = null;
let clock: number | undefined;
/** The pending end of opening a stream (or its failure). */
let opening: number | undefined;
/** When the stream playing fails, for `drops` URLs. */
let dropAt: number | null = null;
let state: PlaybackState = 'idle';
let position = 0;
let duration: number | null = null;
let volume = 1;
let muted = false;
let tracks: MediaTrack[] = [];
let chapters: Chapter[] = [];
let audioTrackId: string | null = null;
let subtitleTrackId: string | null = null;
/** Subtitle files added so far, for unique track ids. */
let added = 0;
let subtitleDelay = 0;
let audioDelay = 0;
let speed = 1;
let subtitleStyle: SubtitleStyle = { size: 100, color: '#ffffff', edge: 'outline', offset: 0 };
let stillShown = false;

function emit(event: NativePlayerEvent) {
  channel?.onmessage(event);
}

function emitTiming() {
  emit({ event: 'timingChange', payload: { subtitleDelay, audioDelay, speed } });
}

function setState(next: PlaybackState) {
  state = next;
  emit({ event: 'stateChange', payload: { state } });
  window.clearInterval(clock);
  if (state === 'playing') {
    clock = window.setInterval(() => {
      position = Math.min(position + speed, DURATION);
      emit({ event: 'timeUpdate', payload: { position, duration } });
      if (dropAt !== null && position >= dropAt) {
        fail('The connection was lost');
        return;
      }
      if (position >= DURATION) {
        emit({ event: 'ended', payload: {} });
        setState('ended');
      }
    }, 1000);
  }
}

/**
 * A caption where native subtitles would be: under the webview's content
 * (behind the controls' gradients), over the still.
 */
function renderCaption() {
  const id = 'kiro-preview-caption';
  document.getElementById(id)?.remove();
  if (!stillShown || subtitleTrackId === null) return;
  const caption = document.createElement('p');
  caption.id = id;
  caption.textContent =
    subtitleDelay === 0
      ? 'Preview subtitles, styled from Settings.\nThe player draws real ones.'
      : `Preview subtitles, shown ${Math.abs(subtitleDelay)} s ${subtitleDelay > 0 ? 'later' : 'earlier'}.\nThe player draws real ones.`;
  for (const [key, value] of Object.entries(captionCss(subtitleStyle, window.innerHeight))) {
    caption.style.setProperty(
      key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
      String(value),
    );
  }
  Object.assign(caption.style, { position: 'fixed', zIndex: '-1', pointerEvents: 'none' });
  document.body.append(caption);
}
window.addEventListener('resize', renderCaption);

function showStill(on: boolean) {
  const id = 'kiro-preview-still';
  stillShown = on;
  renderCaption();
  document.getElementById(id)?.remove();
  if (!on) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = `html.kiro-video-mode { background: #000 url(${STILL}) center / cover no-repeat !important; }`;
  document.head.append(style);
}

/** Like mpv's failed `end-file`: an error, then the error state (which sticks). */
function fail(message: string) {
  dropAt = null;
  showStill(false);
  emit({ event: 'error', payload: { error: { code: 'NETWORK', message, recoverable: false } } });
  setState('error');
}

function snapshot(): PlayerSnapshot {
  return {
    state,
    position,
    duration,
    buffering: false,
    tracks,
    chapters,
    audioTrackId,
    subtitleTrackId,
    volume,
    muted,
    maxVolume: 1.3,
    subtitleDelay,
    audioDelay,
    speed,
  };
}

const STATS: PlayerStats = {
  width: 3840,
  height: 2160,
  videoCodec: 'hevc',
  hwdec: 'videotoolbox',
  primaries: 'bt.2020',
  gamma: 'pq',
  fps: 23.976,
  droppedFrames: 0,
  cacheSeconds: 42.5,
  audioCodec: 'eac3',
  audioMode: 'decoded',
  audioOutput: 'coreaudio',
  framesRendered: 1_204,
  samplePixel: '—',
  contentsScale: 2,
};

export const playerHandlers: Record<string, (args: Args) => unknown> = {
  player_attach: ({ onEvent }) => {
    channel = onEvent as Channel;
    return snapshot();
  },
  player_detach: () => {
    window.clearInterval(clock);
    window.clearTimeout(opening);
    channel = null;
    state = 'idle';
    showStill(false);
  },
  player_load: ({ url, startPosition }) => {
    window.clearTimeout(opening);
    position = typeof startPosition === 'number' ? startPosition : 0;
    duration = null;
    const source = new URL(String(url));
    dropAt = source.searchParams.has('drops') ? position + 6 : null;
    if (chapters.length > 0) {
      chapters = [];
      emit({ event: 'chaptersChange', payload: { chapters } });
    }
    setState('loading');
    if (source.searchParams.has('dead')) {
      showStill(false);
      opening = window.setTimeout(() => fail('Failed to open the stream (HTTP 404)'), 900);
      return;
    }
    opening = window.setTimeout(() => {
      duration = DURATION;
      tracks = TRACKS;
      audioTrackId = 'a1';
      subtitleTrackId = null;
      chapters = fileChapters();
      emit({ event: 'tracksChange', payload: { tracks } });
      emit({ event: 'chaptersChange', payload: { chapters } });
      emit({ event: 'trackSelect', payload: { kind: 'audio', trackId: audioTrackId } });
      emit({ event: 'timeUpdate', payload: { position, duration } });
      showStill(true);
      setState('playing');
    }, 700);
  },
  player_set_paused: ({ paused }) => setState(paused ? 'paused' : 'playing'),
  player_seek: ({ seconds }) => {
    position = Math.min(Math.max(Number(seconds), 0), DURATION);
    emit({ event: 'timeUpdate', payload: { position, duration } });
  },
  player_set_volume: ({ volume: next }) => {
    volume = Number(next);
    emit({ event: 'volumeChange', payload: { volume, muted } });
  },
  player_set_muted: ({ muted: next }) => {
    muted = Boolean(next);
    emit({ event: 'volumeChange', payload: { volume, muted } });
  },
  // Discord Rich Presence lives in the core; nothing to imitate.
  player_set_now_playing: () => null,
  player_stop: () => {
    window.clearTimeout(opening);
    showStill(false);
    setState('idle');
  },
  player_select_audio_track: ({ id }) => {
    audioTrackId = id as string;
    emit({ event: 'trackSelect', payload: { kind: 'audio', trackId: audioTrackId } });
  },
  player_select_subtitle_track: ({ id }) => {
    subtitleTrackId = (id as string | null) ?? null;
    emit({ event: 'trackSelect', payload: { kind: 'subtitle', trackId: subtitleTrackId } });
    renderCaption();
  },
  // Clamped like the Rust commands, and reported back like mpv's properties.
  player_set_subtitle_delay: ({ seconds }) => {
    subtitleDelay = Math.min(Math.max(Number(seconds), -60), 60);
    emitTiming();
    renderCaption();
  },
  player_set_audio_delay: ({ seconds }) => {
    audioDelay = Math.min(Math.max(Number(seconds), -10), 10);
    emitTiming();
  },
  player_set_speed: ({ speed: next }) => {
    speed = Math.min(Math.max(Number(next), 0.25), 4);
    emitTiming();
  },
  player_set_subtitle_style: ({ style }) => {
    subtitleStyle = style as SubtitleStyle;
    renderCaption();
  },
  // Like mpv's `sub-add <url> select`: downloads the file, then shows it.
  // URLs with `broken` in them fail, as a file that won't download does.
  player_add_subtitle: async ({ url, label, language }) => {
    await new Promise((resolve) => window.setTimeout(resolve, 400));
    if (String(url).includes('broken')) {
      throw Object.assign(new Error('The subtitle file could not be loaded'), {
        code: 'BACKEND',
      });
    }
    added += 1;
    const track: MediaTrack = {
      id: `x${added}`,
      kind: 'subtitle',
      label: (label as string | undefined) ?? 'Added subtitles',
      language: language as string | undefined,
      isExternal: true,
    };
    tracks = [...tracks, track];
    subtitleTrackId = track.id;
    emit({ event: 'tracksChange', payload: { tracks } });
    emit({ event: 'trackSelect', payload: { kind: 'subtitle', trackId: subtitleTrackId } });
    renderCaption();
    return track;
  },
  player_stats: () => STATS,
};
