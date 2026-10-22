/**
 * Full-window native player: libmpv video under the webview, with HTML
 * controls composited over it.
 *
 * The video is drawn by a native layer *below* the webview, so this page (and
 * the document behind it) must be transparent wherever the video should show.
 */
import type { NetworkMediaSource } from '@kiro/player-core';
import { Badge, Button } from '@kiro/ui';
import { clamp, cx, formatDuration } from '@kiro/utils';
import {
  ArrowLeft,
  ChevronLeft,
  Layers,
  Loader2,
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  SkipForward,
  Volume1,
  Volume2,
  VolumeX,
} from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate } from 'react-router';

import type { PlaybackSample } from '@/features/library/progress-tracker';
import { ResumedNotice, ResumePrompt } from '@/features/library/resume-prompt';
import { usePlaybackLibrary } from '@/features/library/use-playback-library';
import { groupSubtitles } from '@/features/playback/addon-subtitles';
import { describeAudio } from '@/features/playback/audio-mode';
import { DEV_EXERCISE, pauseOncePlaying, runDevExercise } from '@/features/playback/dev-exercise';
import type { NativePlayer, NativePlayerView } from '@/features/playback/native-player';
import {
  nowPlayingFor,
  parsePlaybackRequest,
  type PlaybackArtwork,
  type PlaybackRequest,
} from '@/features/playback/playback-request';
import {
  describeChapters,
  type OnlineLookup,
  type SkipSegment,
} from '@/features/playback/chapter-skip';
import { AutoSkippedNotice, SkipButton } from '@/features/playback/skip-button';
import {
  bufferedAhead,
  dragStep,
  keyScrubPosition,
  type DragState,
} from '@/features/playback/seek-bar';
import type { PreviewFrame } from '@/features/playback/seek-preview';
import { fallbackNotice } from '@/features/playback/stream-fallback';
import { StreamChoices, StreamsMenu } from '@/features/playback/stream-menu';
import type { SubtitleSources, SubtitleSourcesState } from '@/features/playback/subtitle-sources';
import { TimingMenu } from '@/features/playback/timing-menu';
import { ControlButton, TracksMenu } from '@/features/playback/track-menu';
import { UpNextCard } from '@/features/playback/up-next-card';
import { useChapterSkip } from '@/features/playback/use-chapter-skip';
import { useFullscreen, type Fullscreen } from '@/features/playback/use-fullscreen';
import { keyAction } from '@/features/remote/keys';
import { useNativePlayer, type NativePlayerHandle } from '@/features/playback/use-native-player';
import { usePlayerPreferences } from '@/features/playback/use-player-preferences';
import {
  usePlayerTiming,
  type PlayerTiming,
  type TimingNotice,
} from '@/features/playback/use-player-timing';
import { useSeekPreview, type SeekPreview } from '@/features/playback/use-seek-preview';
import { useSkipParts } from '@/features/playback/use-skip-parts';
import { useStreamSwitching, type StreamSwitching } from '@/features/playback/use-stream-switching';
import { useSubtitleSources } from '@/features/playback/use-subtitle-sources';
import { useUpNext } from '@/features/playback/use-up-next';
import { useSettingsStore } from '@/features/settings/settings-store';
import { useAppInfo } from '@/hooks/use-app-info';
import { isNativeRuntime } from '@/services/native';
import { tauriPlayerBridge, type PlayerStats } from '@/services/player';

const JELLYFIN = 'https://repo.jellyfin.org/test-videos';
/** Test streams for the source picker (development builds). */
const PRESETS = [
  { label: '1080p H.264', url: `${JELLYFIN}/SDR/AVC/Test%20Jellyfin%201080p%20AVC%203M.mp4` },
  {
    label: '4K HEVC HDR10',
    url: `${JELLYFIN}/HDR/HDR10/HEVC/Test%20Jellyfin%204K%20HEVC%20HDR10%2040M.mp4`,
  },
  {
    label: 'MKV, 2 audio + 8 subtitles',
    url: 'https://github.com/ietf-wg-cellar/matroska-test-files/raw/master/test_files/test5.mkv',
  },
  { label: 'HLS (adaptive)', url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8' },
];

/** Dev only: `VITE_KIRO_SPIKE_AUTOPLAY=<url> pnpm dev:desktop` loads <url> on open. */
const DEV_AUTOPLAY_URL = import.meta.env.DEV
  ? (import.meta.env.VITE_KIRO_SPIKE_AUTOPLAY as string | undefined)
  : undefined;

/**
 * Dev only: `VITE_KIRO_SPIKE_MEDIA=<PlaybackMedia JSON>` treats the autoplay
 * stream as that library title, so progress saving can be exercised.
 */
const DEV_REQUEST = devAutoplayRequest(import.meta.env.VITE_KIRO_SPIKE_MEDIA as string | undefined);

function devAutoplayRequest(media: string | undefined): PlaybackRequest | null {
  if (!DEV_AUTOPLAY_URL || !media) return null;
  try {
    return parsePlaybackRequest({
      url: DEV_AUTOPLAY_URL,
      title: 'Dev autoplay',
      media: JSON.parse(media) as unknown,
    });
  } catch {
    return null;
  }
}

const VIDEO_MODE_CLASS = 'kiro-video-mode';
/** Double-clicks on these don't toggle fullscreen. */
const INTERACTIVE = 'button, input, select, a, form, section, [role="dialog"], [role="status"]';
/** Controls hide after this long without input while playing. */
const IDLE_MS = 3000;
/** How long the "Resumed from" notice stays during playback. */
const RESUMED_NOTICE_MS = 10_000;
/** How long a notice such as "Subtitles +0.3 s" stays. */
const TIMING_NOTICE_MS = 1500;
/** How long "trying the next one (2 of 5)" stays once the stream plays. */
const FALLBACK_NOTICE_MS = 4000;

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** Keys the player handles itself, unless typing or using a shortcut. */
function isPlayerKey(event: KeyboardEvent) {
  return !(event.target instanceof HTMLInputElement || event.metaKey || event.ctrlKey);
}

/** Whether `event` was pressed on the seek bar, where ←/→ seek as everywhere else. */
function onSeekBar(event: KeyboardEvent) {
  return event.target instanceof HTMLElement && event.target.dataset.seekBar !== undefined;
}

/**
 * Owns what outlives one stream: the native player's attachment, the
 * transparent document and fullscreen. Each stream (a new request, such as
 * Up next replacing the history entry) gets a fresh {@link PlaybackSession},
 * so progress is saved for the old one and looked up for the new one.
 */
export function PlayerPage() {
  const native = isNativeRuntime();
  const appInfo = useAppInfo();
  // The libmpv commands are only compiled into `--features libmpv` builds.
  const available = appInfo.status === 'ready' && appInfo.info.nativePlayer;
  const location = useLocation();
  const navigate = useNavigate();
  const handle = useNativePlayer(available);
  const { player, ready } = handle;
  const fullscreen = useFullscreen(available);
  /** Subtitle look and remembered volume, for every stream while attached. */
  usePlayerPreferences(player, ready, handle.view);

  // Make the document transparent so the native video shows through.
  useEffect(() => {
    if (!available) return;
    document.documentElement.classList.add(VIDEO_MODE_CLASS);
    return () => document.documentElement.classList.remove(VIDEO_MODE_CLASS);
  }, [available]);

  // CI's check of an installed build (`KIRO_SMOKE_TEST_URL`) or, in
  // development, a scripted run for checking the player from the terminal.
  const smokeTestUrl = appInfo.status === 'ready' ? appInfo.info.smokeTestUrl : null;
  useEffect(() => {
    if (!ready || !player) return;
    if (smokeTestUrl) void pauseOncePlaying(player);
    else if (DEV_EXERCISE) void runDevExercise(player, navigate, fullscreen.toggle);
  }, [ready, player, smokeTestUrl, navigate, fullscreen.toggle]);

  // Back to the title the stream was chosen on, when there is one.
  const goBack = () =>
    void (parsePlaybackRequest(location.state) && location.key !== 'default'
      ? navigate(-1)
      : navigate('/'));

  if (!native) {
    return (
      <Unavailable onBack={goBack}>
        <p className="text-ink-300">The native player only runs inside the desktop app.</p>
        <p className="text-sm text-ink-500">
          Start it with <code className="text-ink-200">pnpm dev</code>.
        </p>
      </Unavailable>
    );
  }
  if (appInfo.status === 'loading') return <div className="h-dvh bg-ink-950" />;
  if (!available) {
    return (
      <Unavailable onBack={goBack}>
        <p className="text-lg font-medium text-ink-100">
          The player isn’t available in this build.
        </p>
        <p className="max-w-md text-sm leading-relaxed text-ink-400">
          Playback needs libmpv. Install it (<code className="text-ink-200">brew install mpv</code>{' '}
          on macOS, <code className="text-ink-200">libmpv-dev</code> on Linux, or set{' '}
          <code className="text-ink-200">KIRO_LIBMPV_DIR</code> to a folder with{' '}
          <code className="text-ink-200">libmpv-2.dll</code> on Windows), then restart{' '}
          <code className="text-ink-200">pnpm dev</code>: the player is turned on automatically when
          libmpv is found.
        </p>
      </Unavailable>
    );
  }
  return (
    <PlaybackSession
      key={location.key}
      {...handle}
      fullscreen={fullscreen}
      smokeTestUrl={smokeTestUrl}
      onBack={goBack}
    />
  );
}

/** One stream: loading it, its controls, progress saving, track preferences and Up next. */
function PlaybackSession({
  player,
  ready,
  attachError,
  view: liveView,
  fullscreen,
  smokeTestUrl,
  onBack,
}: NativePlayerHandle & {
  fullscreen: Fullscreen;
  smokeTestUrl: string | null;
  onBack: () => void;
}) {
  const location = useLocation();
  /** A stream chosen on a title page (see `features/title/stream-list.tsx`). */
  const request = useMemo(
    () => parsePlaybackRequest(location.state) ?? DEV_REQUEST,
    [location.state],
  );
  const [url, setUrl] = useState(PRESETS[0]?.url ?? '');
  const [error, setError] = useState<string | null>(null);
  const [showStats, setShowStats] = useState(false);
  const [scrub, setScrub] = useState<number | null>(null);
  /** The source last loaded from the picker, to retry after a failure. */
  const [picked, setPicked] = useState<NetworkMediaSource | null>(null);
  /** The requested stream couldn't be loaded at all (e.g. refused by the player). */
  const [loadFailed, setLoadFailed] = useState(false);
  /** The stream list shown with the error, to pick another stream. */
  const [choosing, setChoosing] = useState(false);

  // A session replacing another one (Up next) starts while the player still
  // reports the previous stream; ignore that until this session's stream
  // starts loading.
  const [opened, setOpened] = useState(false);
  useEffect(
    () =>
      player?.on('stateChange', ({ state }) => {
        if (state === 'loading' || state === 'error') setOpened(true);
      }),
    [player],
  );
  /** Preferred languages, and subtitles from addons once the stream has loaded. */
  const subtitles = useSubtitleSources(player, request, opened);
  const view = request === null || opened ? liveView : null;

  // Progress saving runs on the player's events: a new sample only when the
  // state changes or a (throttled) `timeUpdate` arrives. No polling. While a
  // stream loads, the position can still be the previous stream's.
  const playbackState = view?.state === 'loading' ? null : (view?.state ?? null);
  const position = view?.position ?? null;
  const duration = view?.duration ?? null;
  const sample = useMemo<PlaybackSample | null>(
    () =>
      playbackState === null
        ? null
        : {
            // Stopped after starting: finished (keep-open), failed or unloaded.
            idle:
              playbackState === 'ended' || playbackState === 'error' || playbackState === 'idle',
            paused: playbackState !== 'playing',
            position,
            duration,
          },
    [playbackState, position, duration],
  );
  /** Saves progress for library titles and offers to resume (unless switching streams). */
  const handoff = request?.handoff;
  const library = usePlaybackLibrary(
    request?.media,
    sample,
    handoff && { position: handoff.startPosition, resumed: handoff.resumed },
  );
  /** What can be skipped: the file's chapters, or times looked up online (Settings). */
  const lookUpSkipTimes = useSettingsStore(
    (state) => state.status === 'ready' && state.settings.playback.onlineSkipTimes,
  );
  const skipParts = useSkipParts(view, request?.media, lookUpSkipTimes);
  const upNext = useUpNext(request, view, view !== null, skipParts.segments);
  /** How far ←/→ and the skip buttons jump (Settings → Playback). */
  const seekStep = useSettingsStore((settings) => settings.settings.playback.seekSeconds);

  // Surface playback failures reported by the backend.
  useEffect(() => player?.on('error', ({ error }) => setError(error.message)), [player]);

  const run = (action: Promise<unknown> | undefined) => {
    setError(null);
    action?.catch((reason: unknown) => setError(errorMessage(reason)));
  };

  /** Subtitle and audio delay for this stream, and the speed. */
  const timing = usePlayerTiming(player, view, (reason) => setError(errorMessage(reason)));
  const { nudge, stepSpeed } = timing;

  /** Skip intro / Skip credits, from the file's chapters or looked up. */
  const autoSkipIntros = useSettingsStore(
    (state) => state.status === 'ready' && state.settings.playback.skipIntros,
  );
  const chapterSkip = useChapterSkip(player, view, skipParts.segments, run, autoSkipIntros);

  const open = (next: NetworkMediaSource) => {
    setPicked(next);
    run(player?.load(next));
  };
  /** Opens the stream again after it failed. */
  const retry = (next: NetworkMediaSource) => {
    setLoadFailed(false);
    setChoosing(false);
    open(next);
  };

  // Discord Rich Presence (Settings → General): the title, episode and
  // poster, never the stream. Rust clears it when the player closes.
  useEffect(() => {
    if (!ready || !player) return;
    player.setNowPlaying(nowPlayingFor(request)).catch(() => undefined);
  }, [ready, player, request]);

  // Open the requested stream once the player is attached.
  const autoplayUrl = request?.url ?? DEV_AUTOPLAY_URL ?? smokeTestUrl ?? undefined;
  const source: NetworkMediaSource | null =
    picked ?? (autoplayUrl ? { kind: 'network', url: autoplayUrl } : null);
  // Waits for the saved-progress lookup, then starts there (resuming) or at 0.
  const { ready: libraryReady, takeStartPosition } = library;
  const autoplayed = useRef(false);
  useEffect(() => {
    if (!ready || !player || !autoplayUrl || !libraryReady || autoplayed.current) return;
    autoplayed.current = true;
    const startPosition = takeStartPosition();
    player
      .load({
        kind: 'network',
        url: autoplayUrl,
        ...(startPosition !== null && { startPosition }),
      })
      .catch((reason: unknown) => {
        setError(errorMessage(reason));
        setLoadFailed(true);
      });
  }, [ready, player, autoplayUrl, libraryReady, takeStartPosition]);

  const state = view?.state ?? 'idle';
  const active = state === 'playing' || state === 'paused' || state === 'ended';
  // The opening screen stays up until the first frame: mpv can report
  // `playing` while it is still buffering the start of the stream.
  const showingVideo = active && !(view?.buffering && (view.position ?? 0) < 0.5);
  /** The first frame has shown: a failure from now on isn't a dead stream. */
  const [started, setStarted] = useState(false);
  if (showingVideo && !started) setStarted(true);
  /** Falls back to the next stream when this one fails before playing; the Streams panel. */
  const streams = useStreamSwitching(request, {
    failedBeforeStart: !started && (state === 'error' || loadFailed),
    started,
    position: view?.position ?? null,
    startPosition: library.startPosition,
    resumed: library.resumedFrom !== null,
  });
  const fallbackAttempt = handoff?.reason === 'fallback' ? handoff.attempt : undefined;
  const [fallbackNoticeDone, setFallbackNoticeDone] = useState(false);
  useEffect(() => {
    if (!showingVideo || !fallbackAttempt) return;
    const timer = window.setTimeout(() => setFallbackNoticeDone(true), FALLBACK_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [showingVideo, fallbackAttempt]);

  // Controls (and the cursor) hide while playing without input, as in any
  // player, and when the cursor leaves the window. H hides or shows them.
  const [idle, setIdle] = useState(false);
  const [manualHidden, setManualHidden] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuOpenRef = useRef(menuOpen);
  useEffect(() => {
    menuOpenRef.current = menuOpen;
  }, [menuOpen]);
  const canHide = state === 'playing' && !menuOpen;
  const hidden = (idle && canHide) || manualHidden;
  /** A frame of the video above the seek bar while hovering (Settings → Playback). */
  const seekPreviews = useSettingsStore((state) => state.settings.playback.seekPreviews);
  const previewStarts = useMemo(
    () => [
      ...(view?.chapters ?? []).map((chapter) => chapter.start),
      ...chapterSkip.segments.map((part) => part.start),
    ],
    [view?.chapters, chapterSkip.segments],
  );
  const preview = useSeekPreview({
    enabled: seekPreviews,
    url: request?.url ?? null,
    duration: view?.duration ?? null,
    active: active && !hidden,
    position: view?.position ?? 0,
    starts: previewStarts,
  });
  /** While a seek lands: the frame nearest its target, over the video. */
  const seekFrame =
    view && view.seekTarget !== null && showingVideo ? preview.frameAt(view.seekTarget) : undefined;

  // Keyboard: Space plays/pauses, ←/→ seek, M mutes, S skips the intro or
  // credits (so does Enter, a remote's OK, with nothing focused), Z/X shift
  // the subtitles and J/K the audio by 0.1 s, [/] change the speed, F
  // toggles fullscreen, Escape leaves it or else goes back (unless closing a
  // panel), and Backspace goes back. Media keys play/pause, skip to the next
  // episode and start over. Arrows that moved focus between controls (the
  // app's navigation, see `data-nav-keys`) arrive already handled.
  const { toggle: toggleFullscreen, exit: exitFullscreen, active: isFullscreen } = fullscreen;
  const { segment: skipSegment, skip } = chapterSkip;
  const playNext = upNext?.playNow;
  /** Whether the Skip button is on screen, for Enter. */
  const skipShownRef = useRef(false);
  /**
   * ← or → held down (`seek-bar.ts`): where its first press landed, and
   * from the first repeat on, where the scrub has reached and since when.
   */
  const keyHold = useRef<{
    key: string;
    direction: -1 | 1;
    from: number;
    since: number | null;
    position: number | null;
  } | null>(null);
  const { setHover } = preview;
  useEffect(() => {
    const onKeyUp = (event: KeyboardEvent) => {
      const hold = keyHold.current;
      if (!hold || event.key !== hold.key) return;
      keyHold.current = null;
      if (hold.position === null) return;
      // The scrub ends: one seek, where it got to.
      setScrub(null);
      setHover(null);
      if (player) run(player.seek(hold.position));
    };
    // The window lost the key: a scrub ends where it is.
    const onBlur = () => {
      const hold = keyHold.current;
      keyHold.current = null;
      if (hold?.position === null || hold === null) return;
      setScrub(null);
      setHover(null);
      if (player) run(player.seek(hold.position));
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const action = keyAction(event);
      const media = action?.kind === 'media' ? action.command : undefined;
      if (!media && !isPlayerKey(event) && !onSeekBar(event)) return;
      if (event.key === 'f' || event.key === 'F') {
        event.preventDefault();
        toggleFullscreen();
      } else if (action?.kind === 'back' && !menuOpenRef.current) {
        event.preventDefault();
        if (event.key === 'Escape' && isFullscreen) exitFullscreen();
        else onBack();
        return;
      } else if (media === 'stop') {
        event.preventDefault();
        onBack();
        return;
      }
      if (!player || !view || !active) return;
      const paused = state === 'paused' || state === 'ended';
      const nothingFocused = event.target === document.body;
      const letter = event.key.toLowerCase();
      if (
        event.code === 'Space' ||
        media === 'playPause' ||
        (media === 'play' && paused) ||
        (media === 'pause' && !paused)
      ) {
        event.preventDefault();
        run(paused ? player.play() : player.pause());
      } else if (
        event.key === 'ArrowLeft' ||
        event.key === 'ArrowRight' ||
        media === 'rewind' ||
        media === 'fastForward'
      ) {
        event.preventDefault();
        const direction = event.key === 'ArrowLeft' || media === 'rewind' ? -1 : 1;
        const hold = keyHold.current;
        if (event.repeat && hold?.key === event.key && view.duration) {
          // Held: scrub from where the first press landed, faster the longer
          // it's held, with the thumb and the preview card following.
          const now = performance.now();
          hold.since ??= now;
          hold.position = keyScrubPosition(hold.from, direction, now - hold.since, view.duration);
          setScrub(hold.position);
          setHover({ position: hold.position, pressed: true });
        } else if (!event.repeat) {
          // A tap: a step, as before.
          const target = clamp(view.position + direction * seekStep, 0, view.duration ?? Infinity);
          keyHold.current = {
            key: event.key,
            direction,
            from: target,
            since: null,
            position: null,
          };
          run(player.seek(target));
        }
      } else if (media === 'next' && playNext) {
        event.preventDefault();
        playNext();
      } else if (media === 'previous') {
        event.preventDefault();
        run(player.seek(0));
      } else if (event.key === 'm' && !onSeekBar(event)) {
        run(player.setMuted(!view.muted));
      } else if (event.key === '[' || event.key === ']') {
        event.preventDefault();
        stepSpeed(event.key === ']' ? 1 : -1);
      } else if (letter === 'z' || letter === 'x') {
        event.preventDefault();
        nudge('subtitle', letter === 'x' ? 1 : -1);
      } else if (letter === 'j' || letter === 'k') {
        event.preventDefault();
        nudge('audio', letter === 'k' ? 1 : -1);
      } else if (
        skipSegment &&
        (event.key === 's' ||
          event.key === 'S' ||
          (event.key === 'Enter' && nothingFocused && skipShownRef.current))
      ) {
        event.preventDefault();
        skip();
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [
    player,
    view,
    active,
    state,
    seekStep,
    setHover,
    toggleFullscreen,
    exitFullscreen,
    isFullscreen,
    onBack,
    playNext,
    skipSegment,
    skip,
    nudge,
    stepSpeed,
  ]);

  const idleTimer = useRef<number>(undefined);
  useEffect(() => {
    const restart = () => {
      window.clearTimeout(idleTimer.current);
      if (canHide) idleTimer.current = window.setTimeout(() => setIdle(true), IDLE_MS);
    };
    const wake = () => {
      setIdle(false);
      setManualHidden(false);
      restart();
    };
    const onKey = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (isPlayerKey(event) && key === 'h') {
        window.clearTimeout(idleTimer.current);
        setIdle(false);
        setManualHidden((hidden) => {
          if (hidden) restart();
          return !hidden;
        });
        return;
      }
      // Toggling fullscreen keeps the controls as they are.
      if (isPlayerKey(event) && (key === 'f' || key === 'escape')) return;
      wake();
    };
    const onLeave = () => {
      window.clearTimeout(idleTimer.current);
      if (canHide) setIdle(true);
    };
    restart();
    window.addEventListener('pointermove', wake);
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', onKey);
    document.documentElement.addEventListener('mouseleave', onLeave);
    return () => {
      window.clearTimeout(idleTimer.current);
      window.removeEventListener('pointermove', wake);
      window.removeEventListener('pointerdown', wake);
      window.removeEventListener('keydown', onKey);
      document.documentElement.removeEventListener('mouseleave', onLeave);
    };
  }, [canHide]);
  // Idle only counts while hiding is allowed (e.g. pausing shows the controls).

  // Hidden controls give up focus, so keys can't press what can't be seen:
  // ←/→ seek again, and ↑/↓ start from Play once the controls are back.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const focused = document.activeElement;
    if (!hidden || !(focused instanceof HTMLElement)) return;
    if (rootRef.current?.contains(focused) && focused.closest('[data-nav-skip]')) focused.blur();
  }, [hidden]);

  // The "resumed" notice goes away after a while of playback.
  const { resumedFrom, dismissResumed } = library;
  useEffect(() => {
    if (resumedFrom === null || !active) return;
    const timer = window.setTimeout(dismissResumed, RESUMED_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [resumedFrom, active, dismissResumed]);

  const onLoad = (event: FormEvent) => {
    event.preventDefault();
    open({ kind: 'network', url: url.trim() });
  };

  const shownError = attachError ?? error;
  const failed = state === 'error' || loadFailed;
  const opening = !failed && (state === 'loading' || (request !== null && state === 'idle'));
  /** Saved progress to ask about before opening (Resume playback: Ask). */
  const { asking, answer } = library;
  const artwork = request?.artwork;
  const upNextShown = Boolean(active && upNext?.visible);
  // Up next takes the place of Skip credits; the tracks panel opens there too.
  const { autoSkipped } = chapterSkip;
  const skipShown =
    skipSegment !== undefined &&
    !autoSkipped &&
    !upNextShown &&
    !menuOpen &&
    (!hidden || chapterSkip.lingering);
  useEffect(() => {
    skipShownRef.current = skipShown;
  }, [skipShown]);
  /** Where cards over the video sit: above the controls, or low when they're hidden. */
  const cornerClass = cx(
    'absolute right-8 z-10 transition-[bottom] duration-500',
    hidden ? 'bottom-8' : 'bottom-36',
  );

  return (
    <div
      ref={rootRef}
      // Back, Space and ←/→ (seeking) are the player's own keys.
      data-nav-keys="back space sideways"
      className={cx(
        'relative h-dvh overflow-hidden text-ink-50 select-none',
        hidden && 'cursor-none',
      )}
      onDoubleClick={(event) => {
        // Double-clicking the video (not a control) toggles fullscreen.
        if (!(event.target as Element).closest(INTERACTIVE)) toggleFullscreen();
      }}
    >
      {artwork && request && (
        <OpeningArtwork
          artwork={artwork}
          title={request.title}
          streamLabel={request.streamLabel}
          visible={!showingVideo}
          opening={opening && !shownError && asking === null}
        />
      )}

      {asking !== null && !shownError && (
        <ResumePrompt
          position={asking}
          onAnswer={answer}
          className={cx(
            'absolute left-1/2 z-10 -translate-x-1/2 -translate-y-1/2',
            artwork ? 'top-[66%]' : 'top-1/2',
          )}
        />
      )}

      {/* The seek's target, until the picture is there */}
      {view && <SeekOverlay frame={seekFrame} target={view.seekTarget} />}

      {/* Top bar */}
      <div
        data-nav-skip={hidden || undefined}
        className={cx(
          'absolute inset-x-0 top-0 flex items-center gap-4 bg-linear-to-b from-black/75 via-black/30 to-transparent px-6 pt-5 pb-16 transition-opacity duration-500',
          hidden && 'pointer-events-none opacity-0',
        )}
      >
        <ControlButton label="Back" onClick={onBack} className="bg-black/30 backdrop-blur">
          <ChevronLeft aria-hidden className="size-6" />
        </ControlButton>
        {request ? (
          <div className="min-w-0">
            <p className="truncate text-[17px] font-semibold tracking-[-0.01em] drop-shadow">
              {request.title}
            </p>
            {request.subtitle && (
              <p className="truncate text-[13px] text-ink-200 drop-shadow">{request.subtitle}</p>
            )}
          </div>
        ) : (
          <Badge tone="accent">libmpv</Badge>
        )}
        <div className="ml-auto">
          <Button variant="ghost" size="sm" onClick={() => setShowStats((value) => !value)}>
            {showStats ? 'Hide stats' : 'Stats'}
          </Button>
        </div>
      </div>

      {/* Moving on from a stream that didn't play */}
      {fallbackAttempt && !fallbackNoticeDone && !failed && (
        <p
          role="status"
          className="pointer-events-none absolute top-20 left-1/2 z-20 max-w-[80vw] -translate-x-1/2 rounded-full bg-black/70 px-4 py-1.5 text-sm text-ink-100 backdrop-blur"
        >
          {fallbackNotice(fallbackAttempt)}
        </p>
      )}

      {/* A requested stream failed: while another one is being found, nothing
          to do; otherwise try again, or choose another stream */}
      {request && failed && streams?.fallback === 'finding' && (
        <p
          role="status"
          className={cx(
            'absolute left-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 text-sm text-ink-200',
            artwork ? 'top-[62%]' : 'top-1/2',
          )}
        >
          <Loader2 aria-hidden className="size-4 animate-spin" />
          That stream didn’t work, looking for another one…
        </p>
      )}
      {request && failed && streams?.fallback !== 'finding' && (
        <div
          className={cx(
            'absolute left-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-3 text-sm text-ink-200',
            artwork && !choosing ? 'top-[62%]' : 'top-1/2',
          )}
        >
          <p>
            {streams && handoff?.reason !== 'picked' && streams.failed.length > 1
              ? `Couldn’t play any of the ${streams.failed.length} streams tried.`
              : 'Couldn’t play this stream.'}
          </p>
          <div className="flex gap-2">
            {source && (
              <Button variant="secondary" size="sm" onClick={() => retry(source)}>
                <RotateCcw aria-hidden className="size-4" />
                Try again
              </Button>
            )}
            {streams && (
              <Button
                variant="secondary"
                size="sm"
                aria-expanded={choosing}
                onClick={() => setChoosing((value) => !value)}
              >
                <Layers aria-hidden className="size-4" />
                Choose another stream
              </Button>
            )}
          </div>
          {streams && choosing && (
            <div className="w-[min(32rem,90vw)] overflow-hidden rounded-2xl border border-white/10 bg-ink-900/90 shadow-2xl shadow-black/60 backdrop-blur-xl">
              <StreamChoices streams={streams} />
            </div>
          )}
        </div>
      )}

      {opening && !shownError && !artwork && asking === null && (
        <div className="absolute top-1/2 left-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2 text-sm text-ink-200">
          <p className="flex items-center gap-2">
            <Loader2 aria-hidden className="size-4 animate-spin" />
            Opening stream…
          </p>
          {request?.streamLabel && <p className="text-xs text-ink-400">{request.streamLabel}</p>}
        </div>
      )}

      {/* Source picker (no requested stream, nothing playing) */}
      {!request && !active && !opening && (
        <form
          onSubmit={onLoad}
          className="absolute top-1/2 left-1/2 w-[min(40rem,90vw)] -translate-x-1/2 -translate-y-1/2 space-y-4 rounded-card border border-white/10 bg-ink-900/90 p-6 backdrop-blur"
        >
          <h1 className="text-lg font-semibold">Play a stream with libmpv</h1>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((preset) => (
              <button
                key={preset.url}
                type="button"
                onClick={() => setUrl(preset.url)}
                className={cx(
                  'cursor-pointer rounded-full border px-3 py-1 text-xs transition-colors',
                  url === preset.url
                    ? 'border-accent/50 bg-accent/15 text-accent-strong'
                    : 'border-white/10 text-ink-300 hover:text-ink-100',
                )}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://…"
              className="h-10 min-w-0 flex-1 rounded-full border border-white/10 bg-white/5 px-4 text-sm text-ink-100 placeholder:text-ink-500 focus:outline-2 focus:outline-accent"
            />
            <Button type="submit" disabled={!ready}>
              <Play aria-hidden className="size-4" />
              Load
            </Button>
          </div>
          {!ready && !shownError && (
            <p className="text-xs text-ink-400">Attaching native player…</p>
          )}
        </form>
      )}

      {showStats && ready && (
        <div
          data-nav-skip={hidden || undefined}
          className={cx(
            'transition-opacity duration-500',
            hidden && 'pointer-events-none opacity-0',
          )}
        >
          <StatsOverlay view={view} segments={chapterSkip.segments} online={skipParts.online} />
        </div>
      )}

      {/* Error */}
      {shownError && (
        <p className="absolute top-16 left-1/2 max-w-[80vw] -translate-x-1/2 rounded-full bg-red-500/90 px-4 py-1.5 text-sm text-white">
          {shownError}
        </p>
      )}

      {/* Bottom controls */}
      {active && player && view && subtitles.sources && (
        <Controls
          player={player}
          view={view}
          subtitles={subtitles.sources}
          subtitlesState={subtitles.state}
          position={scrub ?? view.position}
          onScrub={setScrub}
          preview={preview}
          run={run}
          hidden={hidden}
          onMenuOpenChange={setMenuOpen}
          fullscreen={fullscreen.active}
          onToggleFullscreen={toggleFullscreen}
          next={upNext && { label: upNext.label, play: upNext.playNow }}
          streams={streams}
          seekStep={seekStep}
          segments={chapterSkip.segments}
          timing={timing}
        />
      )}

      {/* "Subtitles +0.3 s", "Speed 1.5×" after a change */}
      {active && <TimingNoticeView notice={timing.notice} />}

      {/* The next episode, near the end of this one */}
      {upNext && upNextShown && <UpNextCard upNext={upNext} className={cornerClass} />}

      {/* Skip intro / Skip credits (after the controls, so it sits on top of
          their gradient and stays clickable) */}
      {skipShown && <SkipButton segment={skipSegment} onSkip={skip} className={cornerClass} />}
      {autoSkipped && !upNextShown && !menuOpen && (
        <AutoSkippedNotice
          segment={autoSkipped}
          onUndo={chapterSkip.undoAutoSkip}
          onDismiss={chapterSkip.dismissAutoSkipped}
          className={cornerClass}
        />
      )}

      {/* Resumed from saved progress (after the controls, so it sits on top of
          them), out of the way while the tracks panel is open */}
      {active && player && resumedFrom !== null && !upNextShown && !menuOpen && (
        <ResumedNotice
          position={resumedFrom}
          onStartOver={() => run(player.seek(library.startOver()))}
          onDismiss={dismissResumed}
          className="absolute bottom-36 left-1/2 z-10 -translate-x-1/2"
        />
      )}
    </div>
  );
}

interface ControlsProps {
  player: NativePlayer;
  view: NativePlayerView;
  /** Subtitle choice and addon subtitles for this stream. */
  subtitles: SubtitleSources;
  subtitlesState: SubtitleSourcesState;
  position: number;
  onScrub: (seconds: number | null) => void;
  /** Seek-bar previews (`use-seek-preview.ts`). */
  preview: SeekPreview;
  run: (action: Promise<unknown>) => void;
  /** Faded out while playing without input. */
  hidden: boolean;
  onMenuOpenChange: (open: boolean) => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  /** The next episode of a series, if there is one. */
  next: { label: string; play: () => void } | null;
  /** Seconds the skip buttons jump. */
  seekStep: number;
  /** Parts that can be skipped, marked on the seek bar. */
  segments: SkipSegment[];
  timing: PlayerTiming;
  /** The video's other streams, for a title's stream. */
  streams: StreamSwitching | null;
}

function Controls({
  player,
  view,
  subtitles,
  subtitlesState,
  position,
  onScrub,
  preview,
  run,
  hidden,
  onMenuOpenChange,
  fullscreen,
  onToggleFullscreen,
  next,
  seekStep,
  segments,
  timing,
  streams,
}: ControlsProps) {
  const duration = view.duration ?? 0;
  const paused = view.state !== 'playing';
  const audioTracks = view.tracks.filter((track) => track.kind === 'audio');
  // Addon subtitles loaded into the player are listed with their addon.
  const addonTrackIds = new Set(Object.values(subtitlesState.loaded));
  const subtitleTracks = view.tracks.filter(
    (track) => track.kind === 'subtitle' && !addonTrackIds.has(track.id),
  );
  const preferredLanguages = useSettingsStore((state) => state.settings.playback.subtitleLanguages);
  const groups = useMemo(
    () => groupSubtitles(subtitlesState.subtitles, preferredLanguages),
    [subtitlesState.subtitles, preferredLanguages],
  );
  const seekBy = (delta: number) =>
    run(player.seek(clamp(view.position + delta, 0, view.duration ?? Infinity)));
  /** Dragging the seek bar (`seek-bar.ts`): one seek, on release. */
  const dragging = useRef(false);
  const drag = useRef<DragState>({ position: null });
  const trackHover = (event: PointerEvent<HTMLDivElement>) => {
    if (!view.duration) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const fraction = clamp((event.clientX - bounds.left) / bounds.width, 0, 1);
    preview.setHover({ position: fraction * view.duration, pressed: event.buttons !== 0 });
  };
  const level = view.muted ? 0 : view.volume;
  const VolumeIcon = level === 0 ? VolumeX : level < 0.5 ? Volume1 : Volume2;

  return (
    <div
      data-nav-skip={hidden || undefined}
      className={cx(
        'absolute inset-x-0 bottom-0 bg-linear-to-t from-black/85 via-black/45 to-transparent px-8 pt-24 pb-6 transition-opacity duration-500',
        hidden && 'pointer-events-none opacity-0',
      )}
    >
      <div className="flex items-center gap-4">
        <span className="w-16 text-right font-mono text-xs text-ink-100 tabular-nums">
          {formatDuration(position)}
        </span>
        <div
          className="relative flex-1"
          onPointerMove={trackHover}
          onPointerDown={trackHover}
          onPointerLeave={() => preview.setHover(null)}
        >
          {preview.hover && view.duration && (
            <SeekPreviewCard
              position={preview.hover.position}
              duration={view.duration}
              frame={preview.frame}
              stale={preview.stale}
              loading={preview.loading}
            />
          )}
          <Range
            label="Seek"
            seekBar
            max={duration || 1}
            step={0.1}
            value={Math.min(position, duration || 1)}
            disabled={!view.duration}
            onChange={(seconds) => {
              // A drag moves the thumb and the preview; the seek comes on
              // release. A click, or a key the bar handles itself (Home,
              // End, Page Up/Down), seeks at once.
              if (dragging.current) {
                const next = dragStep(drag.current, { type: 'move', position: seconds });
                drag.current = next.drag;
                onScrub(seconds);
              } else {
                run(player.seek(seconds));
              }
            }}
            onPointerDown={() => {
              dragging.current = true;
            }}
            onRelease={() => {
              dragging.current = false;
              const next = dragStep(drag.current, { type: 'release' });
              drag.current = next.drag;
              onScrub(null);
              if (next.seek !== null) run(player.seek(next.seek));
            }}
            onCancel={() => {
              dragging.current = false;
              drag.current = dragStep(drag.current, { type: 'cancel' }).drag;
              onScrub(null);
            }}
            className="w-full"
          />
          <SeekBarMarks
            chapters={view.chapters}
            buffered={view.buffered}
            duration={view.duration}
            position={position}
            segments={segments}
          />
        </div>
        <span className="w-16 font-mono text-xs text-ink-300 tabular-nums">
          {view.duration === null ? 'Live' : `-${formatDuration(Math.max(duration - position, 0))}`}
        </span>
      </div>

      <div className="mt-3 flex items-center gap-1">
        <button
          type="button"
          aria-label={paused ? 'Play' : 'Pause'}
          data-nav-start
          onClick={() => run(paused ? player.play() : player.pause())}
          className="mr-2 flex size-12 cursor-pointer items-center justify-center rounded-full bg-ink-50 text-ink-950 shadow-[0_8px_30px_-8px_rgb(132_60_251/0.7)] transition hover:scale-105 focus-visible:focus-ring"
        >
          {paused ? (
            <Play aria-hidden className="ml-0.5 size-5 fill-current" />
          ) : (
            <Pause aria-hidden className="size-5 fill-current" />
          )}
        </button>
        <ControlButton label={`Back ${seekStep} seconds`} onClick={() => seekBy(-seekStep)}>
          <SkipIcon icon={RotateCcw} seconds={seekStep} />
        </ControlButton>
        <ControlButton label={`Forward ${seekStep} seconds`} onClick={() => seekBy(seekStep)}>
          <SkipIcon icon={RotateCw} seconds={seekStep} />
        </ControlButton>
        <div className="group/volume flex items-center">
          <ControlButton
            label={view.muted ? 'Unmute' : 'Mute'}
            onClick={() => run(player.setMuted(!view.muted))}
          >
            <VolumeIcon aria-hidden className="size-5.5" />
          </ControlButton>
          {/* Arrows pass it by (it only shows on hover); Tab still reaches it. */}
          <Range
            label="Volume"
            skipNav
            max={player.capabilities.maxVolume}
            step={0.01}
            value={level}
            onChange={(volume) => {
              run(player.setVolume(volume));
              if (view.muted && volume > 0) run(player.setMuted(false));
            }}
            className="w-0 opacity-0 transition-[width,opacity] duration-300 group-focus-within/volume:w-28 group-focus-within/volume:opacity-100 group-hover/volume:w-28 group-hover/volume:opacity-100"
          />
        </div>
        {view.buffering && (
          <Badge className="ml-3">
            Buffering
            {view.bufferingProgress !== null && ` ${Math.round(view.bufferingProgress * 100)}%`}
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-1">
          {next && (
            <ControlButton label={`Next episode: ${next.label}`} onClick={next.play}>
              <SkipForward aria-hidden className="size-5.5" />
            </ControlButton>
          )}
          {streams && <StreamsMenu streams={streams} onOpenChange={onMenuOpenChange} />}
          <TracksMenu
            audioTracks={audioTracks}
            subtitleTracks={subtitleTracks}
            addonSubtitles={{ groups, state: subtitlesState }}
            audioTrackId={view.audioTrackId}
            subtitleTrackId={view.subtitleTrackId}
            onSelectAudio={(id) => run(player.selectAudioTrack(id))}
            onSelectSubtitle={(id) => run(subtitles.pickTrack(id))}
            onSelectAddonSubtitle={(subtitle) => run(subtitles.pick(subtitle))}
            onAddSubtitle={async (url) => {
              subtitles.picked(await player.addExternalSubtitle({ url }));
            }}
            onOpenChange={onMenuOpenChange}
          />
          <TimingMenu timing={timing} onOpenChange={onMenuOpenChange} />
          <ControlButton
            label={fullscreen ? 'Exit full screen' : 'Full screen'}
            onClick={onToggleFullscreen}
          >
            {fullscreen ? (
              <Minimize aria-hidden className="size-5" />
            ) : (
              <Maximize aria-hidden className="size-5" />
            )}
          </ControlButton>
        </div>
      </div>
    </div>
  );
}

/** A seek still going after this long shows its frame: sooner would flash on seeks served from the buffer. */
const SEEK_OVERLAY_DELAY_MS = 120;
/** A seek that hasn't landed by then shows its frame no longer: something is wrong. */
const SEEK_OVERLAY_MAX_MS = 3000;

/**
 * Over the video from a seek until the player's picture is at the new
 * position: the nearest frame the seek bar has for the target, softened,
 * so the old picture isn't left hanging while the stream is read.
 */
function SeekOverlay({
  frame,
  target,
}: {
  frame: PreviewFrame | undefined;
  target: number | null;
}) {
  // Shown for `target` between the delay and the limit.
  const [shown, setShown] = useState<number | null>(null);
  useEffect(() => {
    if (target === null) return;
    const show = window.setTimeout(() => setShown(target), SEEK_OVERLAY_DELAY_MS);
    const hide = window.setTimeout(() => setShown(null), SEEK_OVERLAY_MAX_MS);
    return () => {
      window.clearTimeout(show);
      window.clearTimeout(hide);
    };
  }, [target]);
  if (!frame || target === null || shown !== target) return null;
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden bg-black">
      <img
        src={frame.image}
        alt=""
        draggable={false}
        className="size-full scale-105 animate-[kiro-fade-in_150ms_ease-out] object-contain blur-[2px]"
      />
    </div>
  );
}

/**
 * Above the seek bar while the pointer is over it: the time under the
 * pointer, with a frame from there once one has been made
 * (`use-seek-preview.ts`). While it is, a nearby frame stands in, dimmed,
 * or an empty card shimmers. Kept inside the bar's ends.
 */
function SeekPreviewCard({
  position,
  duration,
  frame,
  stale,
  loading,
}: {
  position: number;
  duration: number;
  frame: PreviewFrame | undefined;
  stale: boolean;
  loading: boolean;
}) {
  const percent = clamp((position / duration) * 100, 0, 100);
  const shimmer = loading && (
    <span
      aria-hidden
      className="absolute inset-0 animate-[kiro-shimmer_1.2s_ease-in-out_infinite] bg-linear-to-r from-transparent via-white/15 to-transparent"
    />
  );
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute bottom-full z-20 mb-3 flex -translate-x-1/2 flex-col items-center gap-1.5"
      style={{ left: `clamp(6rem, ${percent}%, calc(100% - 6rem))` }}
    >
      {frame ? (
        <span className="relative block w-48 overflow-hidden rounded-lg bg-black shadow-[0_12px_40px_-12px_rgb(0_0_0/0.9)] ring-1 ring-white/15">
          <img
            src={frame.image}
            alt=""
            draggable={false}
            className={cx('block w-full transition-opacity duration-150', stale && 'opacity-50')}
          />
          {shimmer}
        </span>
      ) : (
        loading && (
          <span className="relative block aspect-video w-48 overflow-hidden rounded-lg bg-black/70 shadow-[0_12px_40px_-12px_rgb(0_0_0/0.9)] ring-1 ring-white/15">
            {shimmer}
          </span>
        )
      )}
      <span className="rounded-md bg-black/75 px-2 py-0.5 font-mono text-xs text-ink-50 tabular-nums backdrop-blur">
        {formatDuration(position)}
      </span>
    </div>
  );
}

/**
 * A brief notice over the video after the subtitle delay, audio delay or
 * speed changes, shown whether or not the controls are.
 */
function TimingNoticeView({ notice }: { notice: TimingNotice | null }) {
  const [hiddenId, setHiddenId] = useState<number | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setHiddenId(notice.id), TIMING_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const shown = notice !== null && hiddenId !== notice.id;
  return (
    <p
      role="status"
      className={cx(
        'pointer-events-none absolute top-20 left-1/2 z-20 -translate-x-1/2 rounded-full bg-black/70 px-4 py-1.5 font-medium text-ink-50 tabular-nums backdrop-blur transition-opacity duration-300',
        shown ? 'opacity-100' : 'opacity-0',
      )}
    >
      {notice?.text}
    </p>
  );
}

/** A circular arrow with the skip length in it. */
function SkipIcon({ icon: Icon, seconds }: { icon: typeof RotateCcw; seconds: number }) {
  return (
    <span className="relative flex size-6 items-center justify-center">
      <Icon aria-hidden className="size-6" strokeWidth={1.75} />
      <span aria-hidden className="absolute pt-px text-[8px] font-bold">
        {seconds}
      </span>
    </span>
  );
}

/** A slider whose filled part shows the value (styled by `.kiro-range`). */
function Range({
  label,
  seekBar = false,
  skipNav = false,
  max,
  step,
  value,
  disabled,
  onChange,
  onPointerDown,
  onRelease,
  onCancel,
  className,
}: {
  label: string;
  /** The seek bar: ←/→ seek by the player's step rather than the slider's. */
  seekBar?: boolean;
  skipNav?: boolean;
  max: number;
  step: number;
  value: number;
  disabled?: boolean;
  onChange: (value: number) => void;
  onPointerDown?: () => void;
  onRelease?: () => void;
  onCancel?: () => void;
  className?: string;
}) {
  return (
    <input
      type="range"
      aria-label={label}
      data-seek-bar={seekBar || undefined}
      data-nav-skip={skipNav || undefined}
      min={0}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(Number(event.target.value))}
      onPointerDown={onPointerDown}
      onPointerUp={onRelease}
      onPointerCancel={onCancel}
      style={{ '--fill': `${max > 0 ? (value / max) * 100 : 0}%` } as CSSProperties}
      className={cx('kiro-range', className)}
    />
  );
}

/**
 * Over the seek bar: what the player has buffered (a lighter band, where
 * seeking is instant), the parts that can be skipped (intro, credits)
 * tinted, including times looked up online for a file without chapters, and
 * a gap where each chapter starts. A plain bar is how to tell why Skip intro
 * never appears.
 */
function SeekBarMarks({
  chapters,
  buffered,
  duration,
  position,
  segments,
}: {
  chapters: NativePlayerView['chapters'];
  buffered: NativePlayerView['buffered'];
  duration: number | null;
  position: number;
  segments: SkipSegment[];
}) {
  if (!duration) return null;
  const at = (seconds: number) => `${clamp((seconds / duration) * 100, 0, 100)}%`;
  // Up to the position the track is filled anyway: only the part ahead.
  const ahead = bufferedAhead(buffered, position, duration);
  if (ahead.length === 0 && segments.length === 0 && chapters.length < 2) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 top-1/2 h-1 -translate-y-1/2"
    >
      {ahead.map((range) => (
        <span
          key={range.start}
          className="absolute inset-y-0 rounded-full bg-white/20"
          style={{
            left: at(range.start),
            width: `calc(${at(range.end)} - ${at(range.start)})`,
          }}
        />
      ))}
      {segments.map((segment) => (
        <span
          key={segment.start}
          className="absolute inset-y-0 rounded-full bg-amber-300/55"
          style={{
            left: at(segment.start),
            width: `calc(${at(segment.end)} - ${at(segment.start)})`,
          }}
        />
      ))}
      {(chapters.length < 2 ? [] : chapters)
        .filter((chapter) => chapter.start > 0 && chapter.start < duration)
        .map((chapter) => (
          <span
            key={chapter.start}
            className="absolute -inset-y-px w-0.5 -translate-x-1/2 bg-ink-950/80"
            style={{ left: at(chapter.start) }}
          />
        ))}
    </div>
  );
}

const STATS_POLL_MS = 1000;

/**
 * Decoder and renderer details. These are not part of the event stream, so
 * the overlay reads them once a second while it is open.
 */
function StatsOverlay({
  view,
  segments,
  online,
}: {
  view: NativePlayerView | null;
  segments: SkipSegment[];
  /** An online lookup's progress, when the file's chapters mark nothing. */
  online: OnlineLookup | undefined;
}) {
  const [stats, setStats] = useState<PlayerStats | null>(null);
  useEffect(() => {
    let active = true;
    const read = () =>
      tauriPlayerBridge.stats().then(
        (next) => active && setStats(next),
        () => undefined,
      );
    void read();
    const timer = window.setInterval(read, STATS_POLL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const rows: [string, string][] = [
    ['state', view ? (view.buffering ? `${view.state} (buffering)` : view.state) : '—'],
    ['decoder', stats?.hwdec ?? '—'],
    ['codec', stats?.videoCodec ?? '—'],
    ['size', stats?.width ? `${stats.width}×${stats.height}` : '—'],
    ['colour', stats?.primaries ? `${stats.primaries} / ${stats.gamma}` : '—'],
    ['fps', stats?.fps ? stats.fps.toFixed(2) : '—'],
    ['dropped', String(stats?.droppedFrames ?? 0)],
    ['cache', stats?.cacheSeconds != null ? `${stats.cacheSeconds.toFixed(1)} s` : '—'],
    ['audio', describeAudio(stats)],
    ['rendered', String(stats?.framesRendered ?? 0)],
    ['scale', stats?.contentsScale ? `${stats.contentsScale}×` : '—'],
    ['chapters', view ? describeChapters(view.chapters.length, segments, online) : '—'],
  ];
  return (
    <dl className="absolute top-16 right-5 grid grid-cols-[auto_auto] gap-x-4 gap-y-1 rounded-xl bg-black/60 px-4 py-3 font-mono text-[11px] text-ink-200 backdrop-blur">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-ink-500">{label}</dt>
          <dd className="text-right">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Unavailable({ children, onBack }: { children: ReactNode; onBack: () => void }) {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-ink-950 px-8 text-center">
      {children}
      <Button variant="secondary" onClick={onBack}>
        <ArrowLeft aria-hidden className="size-4" />
        Back
      </Button>
    </div>
  );
}

/**
 * Opening screen: the title's backdrop and logo behind a spinner while the
 * stream opens, fading out once video is on screen. It sits in the webview
 * above the native video layer, so it must stay out of the way afterwards.
 */
function OpeningArtwork({
  artwork,
  title,
  streamLabel,
  visible,
  opening,
}: {
  artwork: PlaybackArtwork;
  title: string;
  /** The chosen stream, e.g. `Example · 4K · HDR · Cached`. */
  streamLabel: string | undefined;
  visible: boolean;
  opening: boolean;
}) {
  const [backdropFailed, setBackdropFailed] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);

  return (
    <div
      aria-hidden={!visible}
      className={cx(
        'pointer-events-none absolute inset-0 bg-ink-950 transition-opacity duration-700 ease-out',
        visible ? 'opacity-100' : 'opacity-0',
      )}
    >
      {artwork.background && !backdropFailed && (
        <img
          src={artwork.background}
          alt=""
          decoding="async"
          fetchPriority="high"
          referrerPolicy="no-referrer"
          onError={() => setBackdropFailed(true)}
          className="size-full scale-105 animate-[kiro-fade-in_600ms_ease-out] object-cover"
        />
      )}
      <div className="absolute inset-0 bg-black/45" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_30%,rgb(8_7_13/0.85)_100%)]" />

      <div className="absolute inset-0 flex flex-col items-center justify-center gap-8 px-10 pb-16">
        {artwork.logo && !logoFailed ? (
          <img
            src={artwork.logo}
            alt={title}
            decoding="async"
            referrerPolicy="no-referrer"
            onError={() => setLogoFailed(true)}
            className="max-h-36 max-w-[min(32rem,70%)] object-contain drop-shadow-[0_8px_30px_rgb(0_0_0/0.7)]"
          />
        ) : (
          <p className="max-w-2xl text-center text-5xl font-semibold tracking-[-0.035em] text-balance text-ink-50 drop-shadow-[0_4px_24px_rgb(0_0_0/0.7)]">
            {title}
          </p>
        )}
        {opening && (
          <div className="flex flex-col items-center gap-2 drop-shadow">
            <p className="flex items-center gap-2 text-sm text-ink-200">
              <Loader2 aria-hidden className="size-4 animate-spin" />
              Opening stream…
            </p>
            {streamLabel && <p className="text-xs text-ink-300">{streamLabel}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
