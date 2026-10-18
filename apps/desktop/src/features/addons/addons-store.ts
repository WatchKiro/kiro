import { parseManifest, type AddonManifest } from '@kiro/addon-sdk';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

import { normalizeAddonUrl } from '@/features/addons/addon-url';
import { addonCommands, describeError, type InstalledAddonRecord } from '@/services/native';

/** An installed addon whose manifest has passed validation. */
export interface InstalledAddon {
  transportUrl: string;
  manifest: AddonManifest;
}

/** An installed addon as Settings → Addons lists it, enabled or not. */
export interface ManagedAddon extends InstalledAddon {
  enabled: boolean;
}

export type InstallResult = { ok: true; addon: InstalledAddon } | { ok: false; message: string };

/** The native commands the store depends on; a fake is injected in tests. */
export type AddonsBackend = Pick<
  typeof addonCommands,
  | 'list'
  | 'fetchManifest'
  | 'install'
  | 'uninstall'
  | 'setEnabled'
  | 'move'
  | 'defaults'
  | 'restoreDefaults'
>;

export interface AddonsState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  /**
   * The enabled addons, in priority order: the ones to query. Catalogs,
   * streams, subtitles and search all read this, so a disabled addon is
   * never asked for anything.
   */
  addons: InstalledAddon[];
  /** Every installed addon, enabled or not, in priority order. */
  installed: ManagedAddon[];
  /**
   * The addons a new profile starts with that are not installed now: the
   * ones "Restore default addons" would put back.
   */
  missingDefaults: InstalledAddon[];

  /** Reads the installed addons. Does nothing once loaded unless `force` is set. */
  load: (options?: { force?: boolean }) => Promise<void>;
  /** Fetches, validates and installs the addon at a user-entered URL. */
  install: (input: string) => Promise<InstallResult>;
  uninstall: (transportUrl: string) => Promise<void>;
  /** Turns an addon on or off without uninstalling it. */
  setEnabled: (transportUrl: string, enabled: boolean) => Promise<void>;
  /** Moves an addon to `index` in the priority order. */
  move: (transportUrl: string, index: number) => Promise<void>;
  /** Installs the missing default addons, at the end of the list. */
  restoreDefaults: () => Promise<void>;
}

/**
 * Stored manifests are re-validated on every read: the file is on disk and
 * the validation rules may have tightened since the addon was installed.
 * After a change that can't alter manifests (enabling, reordering), the
 * known ones are kept as they are, so nothing treats them as updated.
 */
function fromRecords(
  records: InstalledAddonRecord[],
  known: readonly ManagedAddon[] = [],
): Pick<AddonsState, 'addons' | 'installed'> {
  const installed = records.flatMap((record): ManagedAddon[] => {
    const enabled = record.enabled !== false;
    const existing = known.find((addon) => addon.transportUrl === record.transportUrl);
    if (existing) {
      return [existing.enabled === enabled ? existing : { ...existing, enabled }];
    }
    const manifest = parseManifest(record.manifest);
    return manifest.ok
      ? [{ transportUrl: record.transportUrl, manifest: manifest.value, enabled }]
      : [];
  });
  return {
    installed,
    addons: installed
      .filter((addon) => addon.enabled)
      .map(({ transportUrl, manifest }) => ({ transportUrl, manifest })),
  };
}

function parseRecords(records: readonly InstalledAddonRecord[]): InstalledAddon[] {
  return records.flatMap((record) => {
    const manifest = parseManifest(record.manifest);
    return manifest.ok ? [{ transportUrl: record.transportUrl, manifest: manifest.value }] : [];
  });
}

export function createAddonsStore(backend: AddonsBackend) {
  /** The defaults, read once with the list; they don't change while Kiro runs. */
  let defaults: InstalledAddon[] = [];

  /** The new list, and which defaults it lacks. */
  const withRecords = (records: InstalledAddonRecord[], known?: readonly ManagedAddon[]) => {
    const next = fromRecords(records, known);
    return {
      ...next,
      missingDefaults: defaults.filter(
        (addon) => !next.installed.some((other) => other.transportUrl === addon.transportUrl),
      ),
    };
  };

  return createStore<AddonsState>()((set, get) => ({
    status: 'idle',
    error: null,
    addons: [],
    installed: [],
    missingDefaults: [],

    async load({ force = false } = {}) {
      const { status } = get();
      if (status === 'loading' || (status === 'ready' && !force)) return;
      set({ status: 'loading', error: null });
      try {
        const [records, defaultRecords] = await Promise.all([backend.list(), backend.defaults()]);
        defaults = parseRecords(defaultRecords);
        set({ status: 'ready', ...withRecords(records) });
      } catch (error) {
        set({ status: 'error', error: describeError(error) });
      }
    },

    async install(input) {
      const normalized = normalizeAddonUrl(input);
      if (!normalized.ok) return normalized;
      const transportUrl = normalized.url;

      let raw: unknown;
      try {
        raw = await backend.fetchManifest(transportUrl);
      } catch (error) {
        return { ok: false, message: describeError(error) };
      }

      const parsed = parseManifest(raw);
      if (!parsed.ok) {
        const issue = parsed.issues[0];
        return {
          ok: false,
          message: `That URL did not return a valid addon manifest${
            issue ? ` (${issue.path || 'manifest'}: ${issue.message})` : ''
          }.`,
        };
      }
      const manifest = parsed.value;
      if (manifest.behaviorHints?.configurationRequired) {
        return {
          ok: false,
          message: `${manifest.name} must be configured first. Paste the URL of a configured install.`,
        };
      }

      try {
        const records = await backend.install({ transportUrl, manifest });
        set({ status: 'ready', ...withRecords(records) });
      } catch (error) {
        return { ok: false, message: describeError(error) };
      }
      return { ok: true, addon: { transportUrl, manifest } };
    },

    async uninstall(transportUrl) {
      const records = await backend.uninstall(transportUrl);
      set(withRecords(records, get().installed));
    },

    async setEnabled(transportUrl, enabled) {
      const records = await backend.setEnabled(transportUrl, enabled);
      set(withRecords(records, get().installed));
    },

    async move(transportUrl, index) {
      const records = await backend.move(transportUrl, index);
      set(withRecords(records, get().installed));
    },

    async restoreDefaults() {
      const records = await backend.restoreDefaults();
      set(withRecords(records, get().installed));
    },
  }));
}

export const addonsStore = createAddonsStore(addonCommands);

export function useAddonsStore<T>(selector: (state: AddonsState) => T): T {
  return useStore(addonsStore, selector);
}
