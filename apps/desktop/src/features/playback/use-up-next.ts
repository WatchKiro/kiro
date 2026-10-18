import { parseStreamQuality, type Video } from '@kiro/addon-sdk';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';

import { useAddonsStore } from '@/features/addons/addons-store';
import { creditsStart, type SkipSegment } from '@/features/playback/chapter-skip';
import type { NativePlayerView } from '@/features/playback/native-player';
import { streamPlaybackRequest, type PlaybackRequest } from '@/features/playback/playback-request';
import { isCountingDown, isNearEnd, upNextAction } from '@/features/playback/up-next';
import { useSettingsStore } from '@/features/settings/settings-store';
import {
  episodeAfter,
  episodeLabel,
  episodeMedia,
  groupSeasons,
  metaAddons,
  metaKey,
  streamsKey,
  titlePath,
} from '@/features/title/title-data';
import { describeStream, rankedPlaybackRequest } from '@/features/title/stream-ranking';
import { useTitleStore } from '@/features/title/title-store';
import { useRankedStreams } from '@/features/title/use-ranked-streams';

export interface UpNext {
  video: Video;
  /** e.g. `S1 E4 · Title`. */
  label: string;
  /** Whether the card is showing (near the end, not cancelled). */
  visible: boolean;
  /** Seconds left before the next episode plays. */
  secondsLeft: number;
  /** The countdown's full length, in seconds. */
  countdown: number;
  /** Whether the countdown plays the next episode (Settings → Playback). Off: Play now only. */
  autoplay: boolean;
  /** Whether the countdown is paused (playback is). */
  paused: boolean;
  /** The countdown finished or Play now was chosen; finding the stream. */
  starting: boolean;
  /** Plays the next episode now (the card's button, or the control bar's). */
  playNow: () => void;
  /** Hides the card for this episode, until playback goes back from the end. */
  cancel: () => void;
}

/**
 * The episode after the one playing, for series streams opened from a title
 * page. Uses the title's metadata (normally cached by the title page), and
 * fetches the next episode's streams from the same addon once the card shows.
 * Returns `null` for movies, the last episode, or while metadata loads.
 */
export function useUpNext(
  request: PlaybackRequest | null,
  view: NativePlayerView | null,
  /** Whether the view describes this request's stream yet. */
  current: boolean,
  /** The parts that can be skipped (`useSkipParts`); credits running to the end count as the end. */
  segments: readonly SkipSegment[],
): UpNext | null {
  const navigate = useNavigate();
  const media = request?.media;
  const episodic = media !== undefined && media.video.season !== null;
  const type = media?.title.type ?? '';
  const id = media?.title.id ?? '';

  const addonsStatus = useAddonsStore((state) => state.status);
  const addons = useAddonsStore((state) => state.addons);
  const loadAddons = useAddonsStore((state) => state.load);
  const sources = useMemo(() => metaAddons(addons, type, id), [addons, type, id]);
  const metaEntry = useTitleStore((state) => state.metas[metaKey(type, id, sources)]);
  const loadMeta = useTitleStore((state) => state.loadMeta);
  const loadAddonStreams = useTitleStore((state) => state.loadAddonStreams);

  useEffect(() => {
    if (episodic) void loadAddons();
  }, [episodic, loadAddons]);
  useEffect(() => {
    if (episodic && addonsStatus === 'ready') void loadMeta(addons, type, id);
  }, [episodic, addonsStatus, addons, type, id, loadMeta]);

  const meta = metaEntry?.status === 'ready' ? metaEntry.meta : undefined;
  const next = useMemo(
    () =>
      meta && media ? episodeAfter(groupSeasons(meta.videos ?? []), media.video.id) : undefined,
    [meta, media],
  );
  const addon = addons.find((candidate) => candidate.transportUrl === request?.source?.addon);
  const bingeGroup = request?.source?.bingeGroup;
  const streams = useTitleStore((state) =>
    addon && next ? state.streams[streamsKey(addon.transportUrl, type, next.id)] : undefined,
  );

  const autoplay = useSettingsStore((settings) => settings.settings.playback.autoplayNext);
  const countdown = useSettingsStore((settings) => settings.settings.playback.upNextSeconds);
  const loadSettings = useSettingsStore((settings) => settings.load);
  useEffect(() => void loadSettings(), [loadSettings]);

  const state = view?.state ?? 'idle';
  // Closing credits (marked by chapters, or looked up) bring the card forward.
  const duration = view?.duration ?? null;
  const creditsFrom = useMemo(() => creditsStart(segments, duration), [segments, duration]);
  const nearEnd =
    current && view !== null && isNearEnd(state, view.position, view.duration, creditsFrom);
  const [cancelled, setCancelled] = useState(false);
  /** Seconds counted down so far. */
  const [elapsed, setElapsed] = useState(0);
  const secondsLeft = Math.max(countdown - elapsed, 0);
  const [requested, setRequested] = useState(false);
  const visible = Boolean(next) && nearEnd && !cancelled;
  const starting = requested || (visible && autoplay && secondsLeft === 0);

  // Going back from the end (seeking) resets the card for when it comes again.
  const [wasNearEnd, setWasNearEnd] = useState(nearEnd);
  if (nearEnd !== wasNearEnd) {
    setWasNearEnd(nearEnd);
    if (!nearEnd) {
      setCancelled(false);
      setElapsed(0);
    }
  }

  // Fetch the next episode's streams from the same addon ahead of time, and
  // from every addon in case that one has nothing from the same release.
  const wanted = Boolean(next && addon && bingeGroup) && (visible || starting);
  useEffect(() => {
    if (wanted && addon && next) void loadAddonStreams(addon, type, next.id);
  }, [wanted, addon, next, type, loadAddonStreams]);
  const ranked = useRankedStreams(
    addons,
    type,
    next && (visible || starting) ? next.id : undefined,
    { waiting: starting },
  );
  const rankedNext = useMemo(
    () => ({ ready: ranked.ready, best: ranked.ranking.playable[0] }),
    [ranked],
  );

  // Count down while playing (or ended), then start.
  const counting = visible && !starting && isCountingDown(state, autoplay);
  useEffect(() => {
    if (!counting) return;
    const timer = window.setInterval(() => setElapsed((seconds) => seconds + 1), 1000);
    return () => window.clearInterval(timer);
  }, [counting]);

  // Once starting: play the matching stream, or open the episode's streams.
  useEffect(() => {
    if (!starting || !next || !request || !media) return;
    const action = upNextAction(streams, bingeGroup, addon !== undefined, rankedNext);
    if (action.kind === 'wait') return;
    const context = {
      title: request.title,
      subtitle: episodeLabel(next),
      media: episodeMedia(media.title, next),
      ...(request.artwork && { artwork: request.artwork }),
    };
    const state =
      action.kind === 'best'
        ? rankedPlaybackRequest(action.choice, context)
        : action.kind === 'play' && addon
          ? {
              ...streamPlaybackRequest({
                url: action.url,
                stream: action.stream,
                addon,
                ...context,
              }),
              streamLabel: describeStream({ addon, quality: parseStreamQuality(action.stream) }),
            }
          : undefined;
    if (state) {
      // Replace, so Back from the next episode returns to the title.
      void navigate('/player', { state, replace: true });
    } else {
      const query = new URLSearchParams({ episode: next.id, tab: 'streams' });
      void navigate(`${titlePath(type, id)}?${query}`, { replace: true });
    }
  }, [starting, next, request, media, streams, bingeGroup, addon, rankedNext, type, id, navigate]);

  const playNow = useCallback(() => setRequested(true), []);
  const cancel = useCallback(() => setCancelled(true), []);

  if (!episodic || !next) return null;
  return {
    video: next,
    label: episodeLabel(next),
    visible: visible || starting,
    secondsLeft,
    countdown,
    autoplay,
    paused: !isCountingDown(state),
    starting,
    playNow,
    cancel,
  };
}
