/**
 * Importing a Stremio account, once the core has read it
 * (`stremioCommands.fetch`): the library through the core, then each new
 * addon through the usual install path, in Stremio's order, so they land
 * after Kiro's defaults. Kept free of React so it can be tested.
 */
import type { InstallResult } from '@/features/addons/addons-store';
import type { StremioAddon, StremioImportPreview, StremioLibrarySummary } from '@/services/native';
import { describeError } from '@/services/native';

/** What the user chose to import. */
export interface ImportChoice {
  addons: boolean;
  libraryItems: boolean;
  progress: boolean;
}

/** Where an import is up to, for its progress bar. */
export type ImportStage =
  { kind: 'library' } | { kind: 'addons'; done: number; total: number; current: string };

export interface AddonOutcome {
  name: string;
  transportUrl: string;
  result: 'added' | 'skipped' | 'failed';
  /** Why it was skipped or failed. */
  reason?: string;
}

export interface ImportReport {
  /** `null` when addons weren't chosen. */
  addons: AddonOutcome[] | null;
  /** `null` when neither part of the library was chosen, or it failed. */
  library: StremioLibrarySummary | null;
  libraryError: string | null;
}

/** What the import needs from the app; fakes stand in for tests. */
export interface ImportBackend {
  /** Fetches, validates and installs an addon (`addonsStore.install`). */
  installAddon: (transportUrl: string) => Promise<InstallResult>;
  /** Manifest URLs installed now. */
  installedUrls: () => readonly string[];
  importLibrary: (choice: {
    libraryItems: boolean;
    progress: boolean;
  }) => Promise<StremioLibrarySummary>;
  /** Forgets the account the core read. */
  discard: () => Promise<void>;
}

const UNSUPPORTED = 'Kiro can’t use it (not served over https, or Stremio’s own local server).';

export async function runImport(
  preview: StremioImportPreview,
  choice: ImportChoice,
  backend: ImportBackend,
  onStage: (stage: ImportStage) => void = () => {},
): Promise<ImportReport> {
  const report: ImportReport = { addons: null, library: null, libraryError: null };

  if (choice.libraryItems || choice.progress) {
    onStage({ kind: 'library' });
    try {
      report.library = await backend.importLibrary({
        libraryItems: choice.libraryItems,
        progress: choice.progress,
      });
    } catch (error) {
      report.libraryError = describeError(error);
    }
  } else {
    // Nothing to take from the core's copy: let it go now.
    await backend.discard().catch(() => {});
  }

  if (choice.addons) {
    report.addons = [];
    const toInstall = preview.addons.filter((addon) => addon.status === 'new');
    let done = 0;
    for (const addon of preview.addons) {
      report.addons.push(
        await importAddon(addon, backend, () => {
          onStage({ kind: 'addons', done, total: toInstall.length, current: addon.name });
          done += 1;
        }),
      );
    }
  }
  return report;
}

async function importAddon(
  addon: StremioAddon,
  backend: ImportBackend,
  starting: () => void,
): Promise<AddonOutcome> {
  const outcome = { name: addon.name, transportUrl: addon.transportUrl };
  if (addon.status === 'unsupported') {
    return { ...outcome, result: 'skipped', reason: UNSUPPORTED };
  }
  if (addon.status === 'installed') {
    return { ...outcome, result: 'skipped', reason: 'Already in Kiro.' };
  }
  starting();
  // Installed meanwhile (e.g. by an earlier entry with the same URL).
  if (backend.installedUrls().includes(addon.transportUrl)) {
    return { ...outcome, result: 'skipped', reason: 'Already in Kiro.' };
  }
  const result = await backend.installAddon(addon.transportUrl);
  return result.ok
    ? { ...outcome, name: result.addon.manifest.name, result: 'added' }
    : { ...outcome, result: 'failed', reason: result.message };
}

/** e.g. `1 addon`, `12 addons`. */
export function plural(count: number, one: string, many = `${one}s`) {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

/** e.g. `12 addons, 140 library items, 38 in progress`. */
export function previewHeadline(preview: StremioImportPreview): string {
  return [
    plural(preview.addons.length, 'addon'),
    plural(preview.libraryItems, 'library item'),
    `${preview.inProgress.toLocaleString()} in progress`,
  ].join(', ');
}

/** The addons an import would install, and how many it would leave out. */
export function addonCounts(preview: StremioImportPreview) {
  const count = (status: StremioAddon['status']) =>
    preview.addons.filter((addon) => addon.status === status).length;
  return { new: count('new'), installed: count('installed'), unsupported: count('unsupported') };
}

/** One line for an addon choice, e.g. `9 new · 2 already in Kiro · 1 Kiro can’t use`. */
export function addonsDetail(preview: StremioImportPreview): string {
  const counts = addonCounts(preview);
  return [
    `${counts.new.toLocaleString()} new`,
    counts.installed > 0 && `${counts.installed.toLocaleString()} already in Kiro`,
    counts.unsupported > 0 && `${counts.unsupported.toLocaleString()} Kiro can’t use`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** How many addons the report added, skipped and failed. */
export function addonTotals(outcomes: readonly AddonOutcome[]) {
  const count = (result: AddonOutcome['result']) =>
    outcomes.filter((outcome) => outcome.result === result).length;
  return { added: count('added'), skipped: count('skipped'), failed: count('failed') };
}
