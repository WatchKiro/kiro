import { useEffect, useRef } from 'react';

import type { NativePlayer, NativePlayerView } from '@/features/playback/native-player';
import { subtitleStyle } from '@/features/playback/subtitle-appearance';
import { useSettingsStore } from '@/features/settings/settings-store';

/** How long the volume has to stay put before it's remembered. */
const SAVE_VOLUME_MS = 800;
/** How long to wait for the player to report a restored volume. */
const RESTORE_GRACE_MS = 3000;

/**
 * Applies the settings that belong to the player rather than one stream,
 * once per attachment: how subtitles look (again whenever they change), and
 * the remembered volume (Settings → Playback → Remember volume), saving each
 * volume the viewer settles on.
 */
export function usePlayerPreferences(
  player: NativePlayer | null,
  ready: boolean,
  view: NativePlayerView | null,
) {
  const status = useSettingsStore((state) => state.status);
  const subtitles = useSettingsStore((state) => state.settings.subtitles);
  const remember = useSettingsStore((state) => state.settings.playback.rememberVolume);
  const savedVolume = useSettingsStore((state) => state.settings.playback.volume);
  const loadSettings = useSettingsStore((state) => state.load);
  const updatePlayback = useSettingsStore((state) => state.updatePlayback);
  useEffect(() => void loadSettings(), [loadSettings]);
  // Settings that fail to load leave the defaults, which are still applied.
  const known = status === 'ready' || status === 'error';
  const attached = known && ready && player !== null;

  // Only the look matters here, not the rest of the subtitle settings.
  const { size, color, edge, offset } = subtitleStyle(subtitles);
  useEffect(() => {
    if (attached) player.setSubtitleStyle({ size, color, edge, offset }).catch(() => undefined);
  }, [attached, player, size, color, edge, offset]);

  /**
   * The volume restored on attach, until the player reports it: volumes seen
   * before then are the player's own default, not the viewer's choice.
   */
  const restoring = useRef<{ volume: number; until: number } | null>(null);
  const restoredFor = useRef<NativePlayer | null>(null);
  useEffect(() => {
    if (!attached || restoredFor.current === player) return;
    restoredFor.current = player;
    if (!remember) return;
    restoring.current = { volume: savedVolume, until: Date.now() + RESTORE_GRACE_MS };
    player.setVolume(savedVolume / 100).catch(() => {
      restoring.current = null;
    });
  }, [attached, player, remember, savedVolume]);

  const volume = view === null ? null : Math.round(view.volume * 100);
  useEffect(() => {
    if (!attached || !remember || volume === null || restoredFor.current !== player) return;
    const pending = restoring.current;
    if (pending) {
      if (volume !== pending.volume && Date.now() < pending.until) return;
      restoring.current = null;
    }
    if (volume === savedVolume) return;
    const timer = window.setTimeout(() => void updatePlayback({ volume }), SAVE_VOLUME_MS);
    return () => window.clearTimeout(timer);
  }, [attached, player, remember, volume, savedVolume, updatePlayback]);
}
