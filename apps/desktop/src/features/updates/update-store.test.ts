import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createUpdateStore,
  describeUpdate,
  offeredVersion,
  pollDelay,
  type UpdateBackend,
} from '@/features/updates/update-store';
import type { UpdateStatus } from '@/services/native';

function fakeBackend(status: UpdateStatus, checked: UpdateStatus = status) {
  const calls = { install: 0, opened: [] as string[] };
  const backend: UpdateBackend = {
    status: () => Promise.resolve(status),
    check: () => Promise.resolve(checked),
    install: () => {
      calls.install += 1;
      return Promise.reject(Object.assign(new Error('read-only'), { code: 'INTERNAL_ERROR' }));
    },
    openDownload: (version) => {
      calls.opened.push(version);
      return Promise.resolve();
    },
  };
  return { backend, calls };
}

describe('update store', () => {
  it('reads the status, and checks on request', async () => {
    const { backend } = fakeBackend({ state: 'idle' }, { state: 'upToDate' });
    const store = createUpdateStore(backend);
    await store.getState().refresh();
    assert.deepEqual(store.getState().status, { state: 'idle' });

    const checking = store.getState().check();
    assert.deepEqual(store.getState().status, { state: 'checking' });
    await checking;
    assert.deepEqual(store.getState().status, { state: 'upToDate' });
  });

  it('keeps offering a downloaded update while checking again', async () => {
    const ready: UpdateStatus = { state: 'ready', version: '0.2.0' };
    const store = createUpdateStore(fakeBackend(ready).backend);
    await store.getState().refresh();
    const checking = store.getState().check();
    assert.deepEqual(store.getState().status, ready);
    await checking;
    assert.deepEqual(store.getState().status, ready);
  });

  it('reports an install that failed', async () => {
    const { backend, calls } = fakeBackend({ state: 'ready', version: '0.2.0' });
    const store = createUpdateStore(backend);
    await store.getState().refresh();
    await store.getState().install();
    assert.equal(calls.install, 1);
    assert.equal(store.getState().error, 'read-only');
  });

  it('opens the download page of the offered version only', async () => {
    const { backend, calls } = fakeBackend({ state: 'available', version: '0.2.0' });
    const store = createUpdateStore(backend);
    await store.getState().openDownload();
    assert.deepEqual(calls.opened, []);
    await store.getState().refresh();
    await store.getState().openDownload();
    assert.deepEqual(calls.opened, ['0.2.0']);
  });

  it('puts off the prompt for one version', async () => {
    const store = createUpdateStore(fakeBackend({ state: 'ready', version: '0.2.0' }).backend);
    await store.getState().refresh();
    store.getState().dismiss();
    assert.equal(store.getState().dismissed, '0.2.0');
  });
});

describe('update status', () => {
  it('offers a version only once it can be installed or downloaded', () => {
    assert.equal(offeredVersion({ state: 'downloading', version: '0.2.0' }), null);
    assert.equal(offeredVersion({ state: 'ready', version: '0.2.0' }), '0.2.0');
    assert.equal(offeredVersion({ state: 'available', version: '0.2.0' }), '0.2.0');
    assert.equal(offeredVersion(null), null);
  });

  it('polls soon only while the core is busy, and never in development builds', () => {
    assert.equal(pollDelay({ state: 'disabled' }), null);
    assert.ok((pollDelay({ state: 'checking' }) ?? 0) < 10_000);
    assert.ok((pollDelay({ state: 'upToDate' }) ?? 0) >= 60_000);
  });

  it('describes every state', () => {
    assert.equal(
      describeUpdate({ state: 'ready', version: '0.2.0' }),
      'Kiro 0.2.0 is ready. Restart to update.',
    );
    assert.equal(describeUpdate({ state: 'failed', message: 'Offline.' }), 'Offline.');
    assert.match(describeUpdate({ state: 'disabled' }), /Development builds/);
  });
});
