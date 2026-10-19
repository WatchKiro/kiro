import { useEffect } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

import {
  describeError,
  isNativeRuntime,
  updateCommands,
  type UpdateStatus,
} from '@/services/native';

/** The native commands the store depends on; a fake is injected in tests. */
export type UpdateBackend = typeof updateCommands;

export interface UpdateState {
  /** `null` until first read from the core. */
  status: UpdateStatus | null;
  /** The version whose prompt was put off with Later, for this session. */
  dismissed: string | null;
  /** Why installing or opening the download page failed. */
  error: string | null;

  /** Reads where updating stands. */
  refresh: () => Promise<void>;
  /** Checks for a newer version now (Settings → Check for updates). */
  check: () => Promise<void>;
  /** Installs the downloaded update and restarts Kiro. */
  install: () => Promise<void>;
  /** Opens the new version's download page (installs that can't update themselves). */
  openDownload: () => Promise<void>;
  /** Hides the prompt for the current version until Kiro next starts. */
  dismiss: () => void;
}

/** The version a prompt would offer, if any. */
export function offeredVersion(status: UpdateStatus | null): string | null {
  return status?.state === 'ready' || status?.state === 'available' ? status.version : null;
}

/** How long until the status is read again: soon while the core is busy, otherwise rarely. */
export function pollDelay(status: UpdateStatus | null): number | null {
  switch (status?.state) {
    case 'disabled':
      return null;
    case 'checking':
    case 'downloading':
      return 3_000;
    default:
      // The core checks once a day; this only notices when it has.
      return 5 * 60_000;
  }
}

/** One line on where updating stands, for Settings. */
export function describeUpdate(status: UpdateStatus | null): string {
  switch (status?.state) {
    case undefined:
      return 'Loading…';
    case 'disabled':
      return 'Development builds don’t update themselves.';
    case 'idle':
      return 'Kiro looks for a new version when it starts and once a day.';
    case 'checking':
      return 'Checking for updates…';
    case 'upToDate':
      return 'You have the latest version.';
    case 'downloading':
      return `Downloading Kiro ${status.version}…`;
    case 'ready':
      return `Kiro ${status.version} is ready. Restart to update.`;
    case 'available':
      return `Kiro ${status.version} is available. This install doesn’t update itself, so download the new version.`;
    case 'failed':
      return status.message;
  }
}

export function createUpdateStore(backend: UpdateBackend) {
  return createStore<UpdateState>()((set, get) => ({
    status: null,
    dismissed: null,
    error: null,

    refresh: async () => {
      try {
        set({ status: await backend.status() });
      } catch (error) {
        set({ error: describeError(error) });
      }
    },

    check: async () => {
      // Show it straight away; the core reports the same while it checks.
      const current = get().status;
      if (current?.state !== 'ready') set({ status: { state: 'checking' } });
      set({ error: null });
      try {
        set({ status: await backend.check() });
      } catch (error) {
        set({ status: current, error: describeError(error) });
      }
    },

    install: async () => {
      set({ error: null });
      try {
        // Kiro restarts, so this only returns if installing failed.
        await backend.install();
      } catch (error) {
        set({ error: describeError(error) });
        await get().refresh();
      }
    },

    openDownload: async () => {
      const version = offeredVersion(get().status);
      if (!version) return;
      set({ error: null });
      try {
        await backend.openDownload(version);
      } catch (error) {
        set({ error: describeError(error) });
      }
    },

    dismiss: () => set({ dismissed: offeredVersion(get().status) }),
  }));
}

export const updateStore = createUpdateStore(updateCommands);

export function useUpdateStore<T>(selector: (state: UpdateState) => T): T {
  return useStore(updateStore, selector);
}

/**
 * Keeps the update status current while mounted: read at once, then again
 * every {@link pollDelay}. Mount it once, in the app shell.
 */
export function useUpdatePolling() {
  const status = useUpdateStore((state) => state.status);
  const refresh = useUpdateStore((state) => state.refresh);

  useEffect(() => {
    if (isNativeRuntime()) void refresh();
  }, [refresh]);

  const delay = pollDelay(status);
  useEffect(() => {
    if (!isNativeRuntime() || delay === null) return;
    const timer = window.setInterval(() => void refresh(), delay);
    return () => window.clearInterval(timer);
  }, [delay, refresh]);
}
