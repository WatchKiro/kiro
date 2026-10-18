import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { InstallResult } from '@/features/addons/addons-store';
import {
  addonTotals,
  addonsDetail,
  previewHeadline,
  runImport,
  type ImportBackend,
  type ImportStage,
} from '@/features/stremio-import/stremio-import';
import type { StremioImportPreview, StremioLibrarySummary } from '@/services/native';

const preview: StremioImportPreview = {
  addons: [
    {
      transportUrl: 'https://cinemeta.example/manifest.json',
      name: 'Cinemeta',
      status: 'installed',
    },
    {
      transportUrl: 'http://127.0.0.1:11470/manifest.json',
      name: 'Local Files',
      status: 'unsupported',
    },
    { transportUrl: 'https://a.example/manifest.json', name: 'A', status: 'new' },
    { transportUrl: 'https://broken.example/manifest.json', name: 'Broken', status: 'new' },
    { transportUrl: 'https://b.example/manifest.json', name: 'B', status: 'new' },
  ],
  libraryItems: 140,
  watched: 95,
  inProgress: 38,
  skipped: 2,
};

const summary: StremioLibrarySummary = {
  libraryItems: { added: 139, updated: 0, skipped: 1, failed: 0 },
  progress: { added: 90, updated: 2, skipped: 3, failed: 0 },
};

function fakeBackend({ libraryFails = false } = {}) {
  const installed: string[] = ['https://cinemeta.example/manifest.json'];
  const calls: string[] = [];
  const backend: ImportBackend = {
    installAddon: (url): Promise<InstallResult> => {
      calls.push(`install ${url}`);
      if (url.includes('broken')) {
        return Promise.resolve({ ok: false, message: 'The addon could not be reached' });
      }
      installed.push(url);
      return Promise.resolve({
        ok: true,
        addon: {
          transportUrl: url,
          manifest: { name: `${url.slice(8, 9).toUpperCase()} (from manifest)` },
        },
      } as InstallResult);
    },
    installedUrls: () => installed,
    importLibrary: (choice) => {
      calls.push(`library ${choice.libraryItems} ${choice.progress}`);
      return libraryFails
        ? // Tauri rejects with the command's serialised `{ code, message }` error.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          Promise.reject({
            code: 'INVALID_ARGUMENT',
            message: 'Sign in to Stremio again to import.',
          })
        : Promise.resolve(summary);
    },
    discard: () => {
      calls.push('discard');
      return Promise.resolve();
    },
  };
  return { backend, calls, installed };
}

describe('runImport', () => {
  it('imports the library, then new addons in Stremio’s order, reporting each', async () => {
    const { backend, calls, installed } = fakeBackend();
    const stages: ImportStage[] = [];
    const report = await runImport(
      preview,
      { addons: true, libraryItems: true, progress: true },
      backend,
      (stage) => stages.push(stage),
    );

    assert.deepEqual(calls, [
      'library true true',
      'install https://a.example/manifest.json',
      'install https://broken.example/manifest.json',
      'install https://b.example/manifest.json',
    ]);
    // After what was there already, in Stremio's order.
    assert.deepEqual(installed.slice(1), [
      'https://a.example/manifest.json',
      'https://b.example/manifest.json',
    ]);
    assert.deepEqual(report.library, summary);
    assert.equal(report.libraryError, null);
    assert.deepEqual(
      report.addons?.map(({ name, result }) => [name, result]),
      [
        ['Cinemeta', 'skipped'],
        ['Local Files', 'skipped'],
        ['A (from manifest)', 'added'],
        ['Broken', 'failed'],
        ['B (from manifest)', 'added'],
      ],
    );
    assert.equal(report.addons?.[3]?.reason, 'The addon could not be reached');
    assert.deepEqual(addonTotals(report.addons ?? []), { added: 2, skipped: 2, failed: 1 });

    assert.deepEqual(stages, [
      { kind: 'library' },
      { kind: 'addons', done: 0, total: 3, current: 'A' },
      { kind: 'addons', done: 1, total: 3, current: 'Broken' },
      { kind: 'addons', done: 2, total: 3, current: 'B' },
    ]);
  });

  it('imports only the chosen parts', async () => {
    const { backend, calls } = fakeBackend();
    const report = await runImport(
      preview,
      { addons: false, libraryItems: false, progress: true },
      backend,
    );
    assert.deepEqual(calls, ['library false true']);
    assert.equal(report.addons, null);

    const addonsOnly = fakeBackend();
    const addonsReport = await runImport(
      preview,
      { addons: true, libraryItems: false, progress: false },
      addonsOnly.backend,
    );
    // The core's copy of the account is let go at once.
    assert.equal(addonsOnly.calls[0], 'discard');
    assert.equal(addonsReport.library, null);
  });

  it('skips addons that were installed meanwhile', async () => {
    const { backend, calls } = fakeBackend();
    const twice: StremioImportPreview = {
      ...preview,
      addons: [preview.addons[2]!, { ...preview.addons[2]!, name: 'A again' }],
    };
    const report = await runImport(
      twice,
      { addons: true, libraryItems: false, progress: false },
      backend,
    );
    assert.equal(calls.filter((call) => call.startsWith('install')).length, 1);
    assert.deepEqual(
      report.addons?.map(({ result }) => result),
      ['added', 'skipped'],
    );
  });

  it('carries on with addons when the library import fails', async () => {
    const { backend } = fakeBackend({ libraryFails: true });
    const report = await runImport(
      preview,
      { addons: true, libraryItems: true, progress: true },
      backend,
    );
    assert.equal(report.library, null);
    assert.equal(report.libraryError, 'Sign in to Stremio again to import.');
    assert.equal(addonTotals(report.addons ?? []).added, 2);
  });
});

describe('preview text', () => {
  it('counts what the account holds', () => {
    assert.equal(previewHeadline(preview), '5 addons, 140 library items, 38 in progress');
    assert.equal(
      previewHeadline({ ...preview, addons: [preview.addons[0]!], libraryItems: 1, inProgress: 0 }),
      '1 addon, 1 library item, 0 in progress',
    );
    assert.equal(addonsDetail(preview), '3 new · 1 already in Kiro · 1 Kiro can’t use');
    assert.equal(addonsDetail({ ...preview, addons: [] }), '0 new');
  });
});
