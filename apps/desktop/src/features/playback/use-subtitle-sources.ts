import { useEffect, useMemo, useSyncExternalStore } from 'react';

import { useAddonsStore } from '@/features/addons/addons-store';
import { subtitleAddons, subtitlesRequest } from '@/features/playback/addon-subtitles';
import type { NativePlayer } from '@/features/playback/native-player';
import type { PlaybackRequest } from '@/features/playback/playback-request';
import { SubtitleSources, type SubtitleSourcesState } from '@/features/playback/subtitle-sources';
import { settingsStore } from '@/features/settings/settings-store';
import { addonCommands } from '@/services/native';

const NO_SOURCES: SubtitleSourcesState = {
  subtitles: [],
  searching: false,
  loaded: {},
  loading: [],
  failed: [],
};
const noSubscription = () => () => undefined;
const noSources = () => NO_SOURCES;

const readTrackSettings = () =>
  settingsStore
    .getState()
    .load()
    .then((settings) => ({
      ...settings.playback,
      preferredSubtitleType: settings.subtitles.preferredType,
    }));

/**
 * Track preferences and addon subtitles for one stream (see
 * {@link SubtitleSources}). Subtitle addons are asked once this stream starts
 * opening (`opened`), and the requests are cancelled when it is left.
 */
export function useSubtitleSources(
  player: NativePlayer | null,
  request: PlaybackRequest | null,
  opened: boolean,
): { sources: SubtitleSources | null; state: SubtitleSourcesState } {
  const sources = useMemo(
    () => player && new SubtitleSources(player, readTrackSettings, request?.subtitles),
    [player, request],
  );
  useEffect(() => sources?.connect(), [sources]);
  // Read early, so choosing tracks doesn't wait for the file.
  useEffect(() => void settingsStore.getState().load(), []);

  const media = request?.media;
  const addonsStatus = useAddonsStore((state) => state.status);
  const addons = useAddonsStore((state) => state.addons);
  const loadAddons = useAddonsStore((state) => state.load);
  useEffect(() => {
    if (media) void loadAddons();
  }, [media, loadAddons]);

  const type = media?.title.type;
  const videoId = media?.video.id;
  const file = request?.file;
  useEffect(() => {
    if (!sources || !opened || addonsStatus !== 'ready' || !type || !videoId) return;
    return sources.search(
      subtitleAddons(addons, type, videoId),
      subtitlesRequest(type, videoId, file),
      addonCommands.fetchResource,
    );
  }, [sources, opened, addonsStatus, addons, type, videoId, file]);

  const state = useSyncExternalStore(
    sources?.subscribe ?? noSubscription,
    sources?.getState ?? noSources,
  );
  return { sources, state };
}
