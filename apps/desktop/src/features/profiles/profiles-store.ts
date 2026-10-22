import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

import { libraryStore } from '@/features/library/library-store';
import {
  activeProfile,
  parseOverview,
  showsPickerAtLaunch,
} from '@/features/profiles/profiles-data';
import { settingsStore } from '@/features/settings/settings-store';
import {
  describeError,
  profileCommands,
  type CommandError,
  type ProfilesOverview,
} from '@/services/native';

/** The native commands the store depends on; a fake is injected in tests. */
export type ProfilesBackend = typeof profileCommands;

/**
 * Where "Who’s watching?" is: `closed`, at `launch` (it can't be dismissed:
 * choosing a profile opens the app), or opened to `switch` from the sidebar.
 */
export type PickerState = 'closed' | 'launch' | 'switch';

/** How a switch went. A PIN problem is an answer for the PIN pad, not an error. */
export type SwitchResult = 'switched' | 'pinRequired' | 'wrongPin';

export interface ProfilesState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** `null` until loaded. */
  overview: ProfilesOverview | null;
  error: string | null;
  picker: PickerState;
  /** A profile with a PIN the picker opened on, asking for its PIN. */
  pickerTarget: number | null;

  /** Reads the profiles once, opening the picker if it shows at launch. */
  load: () => Promise<void>;
  /** Opens the picker to switch; with `pinFor`, on that profile's PIN pad. */
  openPicker: (pinFor?: number) => void;
  /** Closes a picker opened to switch; the launch picker stays until a profile is chosen. */
  closePicker: () => void;
  /**
   * Switches to profile `id`, with its PIN if it has one. On success the
   * library and settings are read again for it and the picker closes.
   */
  switchTo: (id: number, pin?: string) => Promise<SwitchResult>;
  /**
   * The managing commands. Each updates `overview` and rejects with the
   * core's error (shown by the form that called it).
   */
  create: (name: string, avatar: string, pin: string | null) => Promise<void>;
  rename: (id: number, name: string, pin?: string) => Promise<void>;
  setAvatar: (id: number, avatar: string, pin?: string) => Promise<void>;
  setPin: (id: number, newPin: string | null, pin?: string) => Promise<void>;
  remove: (id: number) => Promise<void>;
  setShowPicker: (show: boolean) => Promise<void>;
  /**
   * Records how the active profile's first-run setup ended. Only while it's
   * pending: reopening the setup from Settings changes nothing.
   */
  finishFirstRun: (outcome: 'completed' | 'skipped') => Promise<void>;
}

/** What else changes with the profile; the app's stores by default. */
export interface ProfileSwitchHooks {
  /** The active profile changed: forget its library and read its settings. */
  onSwitched: () => Promise<void>;
}

export const APP_SWITCH_HOOKS: ProfileSwitchHooks = {
  async onSwitched() {
    libraryStore.getState().clear();
    await settingsStore.getState().reload();
  },
};

export function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as CommandError).code)
    : undefined;
}

export function createProfilesStore(
  backend: ProfilesBackend,
  hooks: ProfileSwitchHooks = APP_SWITCH_HOOKS,
) {
  let loading: Promise<void> | null = null;

  return createStore<ProfilesState>()((set, get) => {
    const apply = (overview: unknown) => set({ overview: parseOverview(overview), error: null });

    return {
      status: 'idle',
      overview: null,
      error: null,
      picker: 'closed',
      pickerTarget: null,

      async load() {
        loading ??= (async () => {
          set({ status: 'loading', error: null });
          try {
            const overview = parseOverview(await backend.list());
            set({
              status: 'ready',
              overview,
              picker: showsPickerAtLaunch(overview) ? 'launch' : 'closed',
            });
          } catch (error) {
            // The app still opens, on whichever profile the core has active.
            loading = null;
            set({ status: 'error', error: describeError(error) });
          }
        })();
        await loading;
      },

      openPicker(pinFor) {
        if (get().overview) set({ picker: 'switch', pickerTarget: pinFor ?? null });
      },

      closePicker() {
        if (get().picker === 'switch') set({ picker: 'closed', pickerTarget: null });
      },

      async switchTo(id, pin) {
        const before = get().overview;
        const target = before?.profiles.find((profile) => profile.id === id);
        // Already in it, and nothing to unlock: just carry on.
        if (before && before.active === id && !target?.hasPin) {
          set({ picker: 'closed', pickerTarget: null });
          return 'switched';
        }
        let overview: ProfilesOverview;
        try {
          overview = parseOverview(await backend.switchTo(id, pin));
        } catch (error) {
          const code = errorCode(error);
          if (code === 'PIN_REQUIRED') return 'pinRequired';
          if (code === 'WRONG_PIN') return 'wrongPin';
          throw error;
        }
        if (overview.active !== before?.active) await hooks.onSwitched();
        set({ overview, picker: 'closed', pickerTarget: null, error: null });
        return 'switched';
      },

      create: async (name, avatar, pin) => apply(await backend.create(name, avatar, pin)),
      rename: async (id, name, pin) => apply(await backend.rename(id, name, pin)),
      setAvatar: async (id, avatar, pin) => apply(await backend.setAvatar(id, avatar, pin)),
      setPin: async (id, newPin, pin) => apply(await backend.setPin(id, newPin, pin)),
      remove: async (id) => apply(await backend.remove(id)),
      setShowPicker: async (show) => apply(await backend.setShowPicker(show)),
      async finishFirstRun(outcome) {
        const overview = get().overview;
        if (overview && activeProfile(overview)?.firstRun !== 'pending') return;
        apply(await backend.finishFirstRun(outcome));
      },
    };
  });
}

export const profilesStore = createProfilesStore(profileCommands);

export function useProfilesStore<T>(selector: (state: ProfilesState) => T): T {
  return useStore(profilesStore, selector);
}
