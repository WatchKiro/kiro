import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { createAddonsStore, type AddonsBackend } from '@/features/addons/addons-store';
import type { InstalledAddonRecord } from '@/services/native';

const URL = 'https://addon.example.com/manifest.json';
const DEFAULT = 'https://default.example.com/manifest.json';

const manifest = {
  id: 'org.example',
  version: '1.0.0',
  name: 'Example',
  types: ['movie'],
  resources: ['catalog'],
  catalogs: [
    { type: 'movie', id: 'search', extra: [{ name: 'search', isRequired: true }] },
    { type: 'movie', id: 'top', name: 'Popular' },
  ],
};

/** In-memory stand-in for the Rust commands. */
function fakeBackend() {
  let records: InstalledAddonRecord[] = [];
  const defaults: InstalledAddonRecord[] = [
    { transportUrl: DEFAULT, manifest: { ...manifest, name: 'Default' }, enabled: true },
  ];
  const responses = new Map<string, unknown>([[URL, manifest]]);

  const backend: AddonsBackend = {
    list: () => Promise.resolve(records),
    fetchManifest: (url) =>
      responses.has(url)
        ? Promise.resolve(responses.get(url))
        : // Tauri rejects with the command's serialised `{ code, message }` error.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          Promise.reject({ code: 'ADDON_ERROR', message: 'The addon could not be reached' }),
    install: (addon) => {
      records = [
        ...records.filter((r) => r.transportUrl !== addon.transportUrl),
        { ...addon, enabled: true },
      ];
      return Promise.resolve(records);
    },
    uninstall: (url) => {
      records = records.filter((r) => r.transportUrl !== url);
      return Promise.resolve(records);
    },
    setEnabled: (url, enabled) => {
      records = records.map((r) => (r.transportUrl === url ? { ...r, enabled } : r));
      return Promise.resolve(records);
    },
    move: (url, index) => {
      const record = records.find((r) => r.transportUrl === url);
      const rest = records.filter((r) => r !== record);
      if (record) rest.splice(index, 0, record);
      records = rest;
      return Promise.resolve(records);
    },
    defaults: () => Promise.resolve(defaults),
    restoreDefaults: () => {
      records = [
        ...records,
        ...defaults.filter((d) => !records.some((r) => r.transportUrl === d.transportUrl)),
      ];
      return Promise.resolve(records);
    },
  };
  return {
    backend,
    responses,
    setRecords: (next: InstalledAddonRecord[]) => (records = next),
  };
}

describe('addons store', () => {
  let fake: ReturnType<typeof fakeBackend>;
  beforeEach(() => {
    fake = fakeBackend();
  });

  it('installs a validated manifest from a normalised URL', async () => {
    const store = createAddonsStore(fake.backend);
    const result = await store.getState().install('addon.example.com');
    assert.ok(result.ok);
    assert.equal(result.addon.transportUrl, URL);
    assert.deepEqual(
      store.getState().addons.map((addon) => addon.manifest.name),
      ['Example'],
    );
  });

  it('reports unreachable addons and invalid manifests without installing', async () => {
    const store = createAddonsStore(fake.backend);
    const unreachable = await store.getState().install('https://missing.example/manifest.json');
    assert.deepEqual(unreachable, { ok: false, message: 'The addon could not be reached' });

    fake.responses.set('https://bad.example/manifest.json', { id: 'x', name: 'No version' });
    const invalid = await store.getState().install('https://bad.example/manifest.json');
    assert.equal(invalid.ok, false);
    assert.match(invalid.ok ? '' : invalid.message, /valid addon manifest/);

    fake.responses.set('https://cfg.example/manifest.json', {
      ...manifest,
      behaviorHints: { configurationRequired: true },
    });
    const unconfigured = await store.getState().install('https://cfg.example/manifest.json');
    assert.match(unconfigured.ok ? '' : unconfigured.message, /must be configured/);

    assert.equal(store.getState().addons.length, 0);
  });

  it('re-validates stored manifests when loading', async () => {
    fake.setRecords([
      { transportUrl: URL, manifest, enabled: true },
      {
        transportUrl: 'https://old.example/manifest.json',
        manifest: { id: 'broken' },
        enabled: true,
      },
    ]);
    const store = createAddonsStore(fake.backend);
    await store.getState().load();
    assert.equal(store.getState().status, 'ready');
    assert.deepEqual(
      store.getState().addons.map((addon) => addon.transportUrl),
      [URL],
    );
  });

  it('queries only enabled addons, in priority order', async () => {
    const other = 'https://other.example/manifest.json';
    fake.setRecords([
      { transportUrl: URL, manifest, enabled: true },
      { transportUrl: other, manifest: { ...manifest, name: 'Other' }, enabled: true },
    ]);
    const store = createAddonsStore(fake.backend);
    await store.getState().load();
    const before = store.getState().installed;

    await store.getState().setEnabled(URL, false);
    assert.deepEqual(
      store.getState().addons.map((addon) => addon.transportUrl),
      [other],
    );
    assert.deepEqual(
      store.getState().installed.map((addon) => [addon.transportUrl, addon.enabled]),
      [
        [URL, false],
        [other, true],
      ],
    );

    await store.getState().setEnabled(URL, true);
    await store.getState().move(other, 0);
    assert.deepEqual(
      store.getState().addons.map((addon) => addon.transportUrl),
      [other, URL],
    );
    // Neither change touches manifests, so they're kept as they were (the
    // catalogue feeds of an addon whose manifest changes are thrown away).
    assert.equal(store.getState().installed[0]?.manifest, before[1]?.manifest);
  });

  it('knows which default addons are missing, and restores them', async () => {
    fake.setRecords([{ transportUrl: DEFAULT, manifest, enabled: false }]);
    const store = createAddonsStore(fake.backend);
    await store.getState().load();
    // Installed, even if off, is not missing.
    assert.deepEqual(store.getState().missingDefaults, []);

    await store.getState().install(URL);
    await store.getState().uninstall(DEFAULT);
    assert.deepEqual(
      store.getState().missingDefaults.map((addon) => addon.manifest.name),
      ['Default'],
    );

    await store.getState().restoreDefaults();
    assert.deepEqual(store.getState().missingDefaults, []);
    assert.deepEqual(
      store.getState().installed.map((addon) => [addon.transportUrl, addon.enabled]),
      [
        [URL, true],
        [DEFAULT, true],
      ],
    );
  });

  it('uninstalls an addon', async () => {
    const store = createAddonsStore(fake.backend);
    await store.getState().install(URL);
    await store.getState().uninstall(URL);
    assert.deepEqual(store.getState().addons, []);
  });
});
