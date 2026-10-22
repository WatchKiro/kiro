import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_SETTINGS } from '@/features/settings/settings-data';
import { createSettingsStore, type SettingsBackend } from '@/features/settings/settings-store';
import type { Settings } from '@/services/native';

const JAPANESE: Settings = {
  ...DEFAULT_SETTINGS,
  playback: { ...DEFAULT_SETTINGS.playback, audioLanguages: ['ja'], subtitleLanguages: ['en'] },
};

function fakeBackend(stored: unknown = JAPANESE) {
  const calls = { get: 0, set: [] as Settings[] };
  let value = stored;
  const backend: SettingsBackend = {
    get: () => {
      calls.get += 1;
      return Promise.resolve(value as Settings);
    },
    set: (settings) => {
      calls.set.push(settings);
      value = settings;
      return Promise.resolve(settings);
    },
  };
  return { backend, calls };
}

describe('settings store', () => {
  it('loads once and validates what the core returns', async () => {
    const { backend, calls } = fakeBackend({ playback: { audioLanguages: ['ja'], bad: 1 } });
    const store = createSettingsStore(backend);
    const [first, second] = await Promise.all([store.getState().load(), store.getState().load()]);
    assert.deepEqual(first.playback.audioLanguages, ['ja']);
    assert.deepEqual(second, first);
    assert.equal(calls.get, 1);
    assert.equal(store.getState().status, 'ready');
  });

  it('keeps the defaults when loading fails, and retries later', async () => {
    let fail = true;
    const store = createSettingsStore({
      get: () =>
        fail
          ? Promise.reject(Object.assign(new Error('disk'), { code: 'IO_ERROR' }))
          : Promise.resolve(JAPANESE),
      set: (settings) => Promise.resolve(settings),
    });
    assert.deepEqual(await store.getState().load(), DEFAULT_SETTINGS);
    assert.equal(store.getState().status, 'error');
    assert.equal(store.getState().error, 'disk');
    fail = false;
    assert.deepEqual(await store.getState().load(), JAPANESE);
  });

  it('saves changes normalised, and later loads see them', async () => {
    const { backend, calls } = fakeBackend();
    const store = createSettingsStore(backend);
    await store.getState().load();
    await store.getState().updatePlayback({ audioLanguages: ['jpn', 'eng'], subtitlesOff: true });
    assert.deepEqual(calls.set[0]?.playback, {
      ...DEFAULT_SETTINGS.playback,
      audioLanguages: ['ja', 'en'],
      subtitleLanguages: ['en'],
      subtitlesOff: true,
    });
    assert.deepEqual((await store.getState().load()).playback.audioLanguages, ['ja', 'en']);
    assert.equal(calls.get, 1);
  });

  it('saves stream settings alongside playback settings', async () => {
    const { backend, calls } = fakeBackend();
    const store = createSettingsStore(backend);
    await store.getState().load();
    await store.getState().updateStreams({ maxResolution: 1080, preferHdr: false });
    assert.deepEqual(calls.set[0], {
      ...JAPANESE,
      streams: { ...DEFAULT_SETTINGS.streams, maxResolution: 1080, preferHdr: false },
    });
    assert.equal(store.getState().settings.streams.maxResolution, 1080);
  });

  it('saves general settings alongside the others', async () => {
    const { backend, calls } = fakeBackend();
    const store = createSettingsStore(backend);
    await store.getState().load();
    await store.getState().updateGeneral({ discordPresence: true, discordShowEpisode: false });
    assert.deepEqual(calls.set[0], {
      ...JAPANESE,
      general: { discordPresence: true, discordShowTitle: true, discordShowEpisode: false },
    });
    await store.getState().reset('general');
    assert.deepEqual(calls.set[1], JAPANESE);
  });

  it('saves subtitle settings, normalising the colour', async () => {
    const { backend, calls } = fakeBackend();
    const store = createSettingsStore(backend);
    await store.getState().load();
    await store.getState().updateSubtitles({ color: '#FFE45C', edge: 'background' });
    assert.deepEqual(calls.set[0]?.subtitles, {
      ...DEFAULT_SETTINGS.subtitles,
      color: '#ffe45c',
      edge: 'background',
    });
    assert.deepEqual(calls.set[0]?.playback, JAPANESE.playback);
  });

  it('resets one section to its defaults, leaving the others', async () => {
    const { backend, calls } = fakeBackend({
      ...JAPANESE,
      streams: { ...DEFAULT_SETTINGS.streams, excludeCam: true, excludedKeywords: ['GROUP'] },
    });
    const store = createSettingsStore(backend);
    await store.getState().load();
    await store.getState().reset('streams');
    assert.deepEqual(calls.set[0], JAPANESE);
  });

  it('resets some fields of several sections in one save', async () => {
    const { backend, calls } = fakeBackend({
      ...JAPANESE,
      subtitles: { ...DEFAULT_SETTINGS.subtitles, size: 150 },
    });
    const store = createSettingsStore(backend);
    await store.getState().load();
    await store
      .getState()
      .resetFields({ playback: ['subtitleLanguages'], subtitles: ['size', 'color'] });
    assert.equal(calls.set.length, 1);
    assert.deepEqual(calls.set[0], {
      ...JAPANESE,
      playback: { ...JAPANESE.playback, subtitleLanguages: [] },
    });
  });

  it('puts back the previous settings when a save is refused', async () => {
    const store = createSettingsStore({
      get: () => Promise.resolve(JAPANESE),
      set: () =>
        Promise.reject(
          Object.assign(new Error('Invalid audio language code'), { code: 'INVALID_ARGUMENT' }),
        ),
    });
    await store.getState().load();
    const saving = store.getState().updatePlayback({ subtitlesOff: true });
    assert.equal(store.getState().settings.playback.subtitlesOff, true, 'shown at once');
    await saving;
    assert.deepEqual(store.getState().settings, JAPANESE);
    assert.equal(store.getState().error, 'Invalid audio language code');
  });

  it('ignores a slow earlier save’s response', async () => {
    const pending: ((settings: Settings) => void)[] = [];
    const store = createSettingsStore({
      get: () => Promise.resolve(DEFAULT_SETTINGS),
      set: (settings) =>
        new Promise((resolve) => {
          pending.push(() => resolve(settings));
        }),
    });
    await store.getState().load();
    const first = store.getState().updatePlayback({ audioLanguages: ['fr'] });
    const second = store.getState().updatePlayback({ audioLanguages: ['de'] });
    pending[1]?.(DEFAULT_SETTINGS);
    await second;
    pending[0]?.(DEFAULT_SETTINGS);
    await first;
    assert.deepEqual(store.getState().settings.playback.audioLanguages, ['de']);
  });
});
