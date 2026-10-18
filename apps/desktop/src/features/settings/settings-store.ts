import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

import {
  DEFAULT_SETTINGS,
  parseSettings,
  withDefaults,
  withGeneral,
  withPlayback,
  withRows,
  withStreams,
  withSubtitles,
  type SettingsSection,
} from '@/features/settings/settings-data';
import {
  describeError,
  settingsCommands,
  type CatalogRowSetting,
  type GeneralSettings,
  type PlaybackSettings,
  type RowSettings,
  type Settings,
  type StreamSettings,
  type SubtitleSettings,
} from '@/services/native';

/** The native commands the store depends on; a fake is injected in tests. */
export type SettingsBackend = typeof settingsCommands;

export interface SettingsState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** The defaults until loaded. */
  settings: Settings;
  /** Why loading or the last save failed. */
  error: string | null;

  /** Reads the settings once; later calls return them without asking again. */
  load: () => Promise<Settings>;
  /**
   * Changes playback settings at once and saves them. A save the core refuses
   * puts back what was there before and sets `error`.
   */
  updatePlayback: (patch: Partial<PlaybackSettings>) => Promise<void>;
  /** Changes what Kiro shares outside the app (Discord), as {@link updatePlayback}. */
  updateGeneral: (patch: Partial<GeneralSettings>) => Promise<void>;
  /** Changes how subtitles look and which type is picked, as {@link updatePlayback}. */
  updateSubtitles: (patch: Partial<SubtitleSettings>) => Promise<void>;
  /** Changes how Play chooses a stream, as {@link updatePlayback}. */
  updateStreams: (patch: Partial<StreamSettings>) => Promise<void>;
  /**
   * Saves a page's catalogue rows (`null`: back to the default), as
   * {@link updatePlayback}.
   */
  updateRows: (page: keyof RowSettings, layout: CatalogRowSetting[] | null) => Promise<void>;
  /** Puts one section back to its defaults, as {@link updatePlayback}. */
  reset: (section: SettingsSection) => Promise<void>;
}

export function createSettingsStore(backend: SettingsBackend) {
  let loading: Promise<void> | null = null;
  /** Latest save, so a slow earlier response can't overwrite a newer change. */
  let saves = 0;

  return createStore<SettingsState>()((set, get) => {
    /** Shows the change at once and saves it, putting back what was there if refused. */
    const save = async (change: (settings: Settings) => Settings) => {
      const previous = get().settings;
      const next = change(previous);
      const attempt = ++saves;
      set({ settings: next, error: null });
      try {
        const stored = parseSettings(await backend.set(next));
        if (attempt === saves) set({ settings: stored, status: 'ready' });
      } catch (error) {
        if (attempt === saves) set({ settings: previous, error: describeError(error) });
      }
    };

    return {
      status: 'idle',
      settings: DEFAULT_SETTINGS,
      error: null,

      async load() {
        loading ??= (async () => {
          set({ status: 'loading', error: null });
          try {
            set({ status: 'ready', settings: parseSettings(await backend.get()) });
          } catch (error) {
            // Playback still works with the defaults; let a later call retry.
            loading = null;
            set({ status: 'error', error: describeError(error) });
          }
        })();
        await loading;
        // Changes saved since loading are in the store, not in the first response.
        return get().settings;
      },

      updateGeneral: (patch) => save((settings) => withGeneral(settings, patch)),
      updatePlayback: (patch) => save((settings) => withPlayback(settings, patch)),
      updateSubtitles: (patch) => save((settings) => withSubtitles(settings, patch)),
      updateStreams: (patch) => save((settings) => withStreams(settings, patch)),
      updateRows: (page, layout) => save((settings) => withRows(settings, page, layout)),
      reset: (section) => save((settings) => withDefaults(settings, section)),
    };
  });
}

export const settingsStore = createSettingsStore(settingsCommands);

export function useSettingsStore<T>(selector: (state: SettingsState) => T): T {
  return useStore(settingsStore, selector);
}
