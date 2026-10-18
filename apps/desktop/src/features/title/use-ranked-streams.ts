import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/shallow';

import type { InstalledAddon } from '@/features/addons/addons-store';
import { useSettingsStore } from '@/features/settings/settings-store';
import {
  STREAM_BUDGET_MS,
  rankStreams,
  readyToStart,
  type StreamRanking,
} from '@/features/title/stream-ranking';
import { streamAddons, streamsKey } from '@/features/title/title-data';
import { useTitleStore, type StreamsEntry } from '@/features/title/title-store';

export interface AddonStreamsStatus {
  addon: InstalledAddon;
  /** Undefined until the request starts. */
  entry: StreamsEntry | undefined;
}

export interface RankedStreams {
  /** Each stream addon for the video, in install order, with its answer. */
  sources: AddonStreamsStatus[];
  /** Every addon has answered or failed, and the settings are known. */
  settled: boolean;
  /**
   * Whether a caller that is `waiting` can act on the ranking now: settled,
   * or the time budget is spent and the best stream so far is good enough
   * (`readyToStart`).
   */
  ready: boolean;
  /** How many of `sources` have answered or failed. */
  answered: number;
  ranking: StreamRanking;
}

/** The system's language, for when no audio languages are set. */
const SYSTEM_LANGUAGES = (() => {
  try {
    return [new Intl.Locale(navigator.language).language];
  } catch {
    return [];
  }
})();

/**
 * Loads the streams for a movie or episode (`id`) from every stream addon and
 * ranks them with the stream settings. Streams that name only languages
 * outside the preferred audio languages (or the system's, when none are set)
 * go later. Nothing loads without an `id`.
 *
 * While `waiting` (Play was pressed), the time budget runs: once it is spent,
 * a good stream that has arrived is `ready` without waiting for slower addons.
 */
export function useRankedStreams(
  addons: InstalledAddon[],
  type: string,
  id: string | undefined,
  { waiting = false }: { waiting?: boolean } = {},
): RankedStreams {
  const loadStreams = useTitleStore((state) => state.loadStreams);
  const settingsStatus = useSettingsStore((state) => state.status);
  const streamSettings = useSettingsStore((state) => state.settings.streams);
  const audioLanguages = useSettingsStore((state) => state.settings.playback.audioLanguages);
  const loadSettings = useSettingsStore((state) => state.load);
  const addonsForVideo = useMemo(
    () => (id === undefined ? [] : streamAddons(addons, type, id)),
    [addons, type, id],
  );
  const entries = useTitleStore(
    useShallow((state) =>
      addonsForVideo.map((addon) =>
        id === undefined ? undefined : state.streams[streamsKey(addon.transportUrl, type, id)],
      ),
    ),
  );

  useEffect(() => {
    if (id !== undefined) void loadStreams(addons, type, id);
  }, [addons, type, id, loadStreams]);
  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);
  // Settings that fail to load leave the defaults, which still rank.
  const settingsKnown = settingsStatus === 'ready' || settingsStatus === 'error';

  // The budget starts again each time waiting starts.
  const [budgetSpent, setBudgetSpent] = useState(false);
  if (!waiting && budgetSpent) setBudgetSpent(false);
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setTimeout(() => setBudgetSpent(true), STREAM_BUDGET_MS);
    return () => window.clearTimeout(timer);
  }, [waiting]);

  return useMemo(() => {
    const sources = addonsForVideo.map((addon, index) => ({ addon, entry: entries[index] }));
    const options = {
      ...streamSettings,
      languages: audioLanguages.length > 0 ? audioLanguages : SYSTEM_LANGUAGES,
    };
    const ranking = rankStreams(
      sources.flatMap(({ addon, entry }) =>
        entry?.status === 'ready' ? [{ addon, streams: entry.streams }] : [],
      ),
      options,
    );
    const answered = sources.filter(({ entry }) => entry && entry.status !== 'loading').length;
    const settled = settingsKnown && answered === sources.length;
    // The maximum resolution and languages must be known to judge a stream.
    const ready = readyToStart(ranking, settled, budgetSpent && settingsKnown, options);
    return { sources, settled, ready, answered, ranking };
  }, [addonsForVideo, entries, streamSettings, audioLanguages, settingsKnown, budgetSpent]);
}
