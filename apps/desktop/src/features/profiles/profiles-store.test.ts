import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createLibraryStore, type LibraryBackend } from '@/features/library/library-store';
import {
  createProfilesStore,
  type ProfilesBackend,
  type ProfileSwitchHooks,
} from '@/features/profiles/profiles-store';
import { DEFAULT_SETTINGS } from '@/features/settings/settings-data';
import { createSettingsStore, type SettingsBackend } from '@/features/settings/settings-store';
import type { Profile, ProfilesOverview, Settings, WatchlistItem } from '@/services/native';

function commandError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

/** The core's profile rules, in memory: PINs, the active profile, the last one. */
function fakeBackend(profiles: (Partial<Profile> & { pin?: string })[], showPicker = true) {
  let list = profiles.map((profile, index) => ({
    id: index + 1,
    name: `Profile ${index + 1}`,
    avatar: 'violet',
    createdAt: 0,
    ...profile,
    hasPin: Boolean(profile.pin),
  }));
  let active = 1;
  const calls: string[] = [];
  const view = (): ProfilesOverview => ({
    profiles: list.map(({ pin: _pin, ...profile }) => profile),
    active,
    showPicker,
  });
  const unlock = (id: number, pin?: string) => {
    const profile = list.find((p) => p.id === id);
    if (!profile) throw commandError('INVALID_ARGUMENT', 'That profile doesn’t exist');
    if (profile.pin && !pin) throw commandError('PIN_REQUIRED', 'Enter this profile’s PIN');
    if (profile.pin && pin !== profile.pin) throw commandError('WRONG_PIN', 'That PIN isn’t right');
  };
  const backend: ProfilesBackend = {
    list: () => Promise.resolve(view()),
    create: (name, avatar, pin) => {
      calls.push(`create ${name}`);
      list = [
        ...list,
        { id: list.length + 1, name, avatar, createdAt: 0, hasPin: pin !== null, pin: pin ?? '' },
      ];
      return Promise.resolve(view());
    },
    rename: (id, name) => {
      list = list.map((p) => (p.id === id ? { ...p, name } : p));
      return Promise.resolve(view());
    },
    setAvatar: (id, avatar) => {
      list = list.map((p) => (p.id === id ? { ...p, avatar } : p));
      return Promise.resolve(view());
    },
    setPin: (id, newPin) => {
      list = list.map((p) => (p.id === id ? { ...p, pin: newPin ?? '', hasPin: !!newPin } : p));
      return Promise.resolve(view());
    },
    remove: (id) => {
      if (id === active || list.length === 1) {
        return Promise.reject(commandError('INVALID_ARGUMENT', 'Can’t delete that one'));
      }
      list = list.filter((p) => p.id !== id);
      return Promise.resolve(view());
    },
    switchTo: async (id, pin) => {
      calls.push(`switch ${id}`);
      await Promise.resolve();
      unlock(id, pin);
      active = id;
      return view();
    },
    setShowPicker: (show) => {
      showPicker = show;
      return Promise.resolve(view());
    },
  };
  return { backend, calls };
}

function countingHooks() {
  const hooks = { switched: 0 } as ProfileSwitchHooks & { switched: number };
  hooks.onSwitched = () => {
    hooks.switched += 1;
    return Promise.resolve();
  };
  return hooks;
}

describe('profiles store', () => {
  it('opens the app straight away with one profile', async () => {
    const { backend } = fakeBackend([{ name: 'Me' }]);
    const store = createProfilesStore(backend, countingHooks());
    await store.getState().load();
    assert.equal(store.getState().status, 'ready');
    assert.equal(store.getState().picker, 'closed');
  });

  it('opens on the picker with more than one, and choosing closes it', async () => {
    const { backend, calls } = fakeBackend([{ name: 'Me' }, { name: 'Sam' }]);
    const hooks = countingHooks();
    const store = createProfilesStore(backend, hooks);
    await store.getState().load();
    assert.equal(store.getState().picker, 'launch');
    // The launch picker can't be dismissed without choosing.
    store.getState().closePicker();
    assert.equal(store.getState().picker, 'launch');

    // Choosing the profile already active (no PIN) just goes in.
    assert.equal(await store.getState().switchTo(1), 'switched');
    assert.equal(store.getState().picker, 'closed');
    assert.deepEqual(calls, []);
    assert.equal(hooks.switched, 0);
  });

  it('switches, re-reading the library and settings for the new profile', async () => {
    const { backend } = fakeBackend([{ name: 'Me' }, { name: 'Sam' }], false);
    const hooks = countingHooks();
    const store = createProfilesStore(backend, hooks);
    await store.getState().load();
    assert.equal(store.getState().picker, 'closed');
    store.getState().openPicker();
    assert.equal(store.getState().picker, 'switch');

    assert.equal(await store.getState().switchTo(2), 'switched');
    assert.equal(store.getState().overview?.active, 2);
    assert.equal(store.getState().picker, 'closed');
    assert.equal(hooks.switched, 1);
  });

  it('asks for a PIN, and a wrong one changes nothing', async () => {
    const { backend } = fakeBackend([{ name: 'Me' }, { name: 'Parent', pin: '4321' }]);
    const hooks = countingHooks();
    const store = createProfilesStore(backend, hooks);
    await store.getState().load();
    store.getState().openPicker(2);
    assert.equal(store.getState().pickerTarget, 2);

    assert.equal(await store.getState().switchTo(2), 'pinRequired');
    assert.equal(await store.getState().switchTo(2, '1111'), 'wrongPin');
    assert.equal(store.getState().overview?.active, 1);
    assert.equal(store.getState().picker, 'switch', 'still asking');
    assert.equal(hooks.switched, 0);

    assert.equal(await store.getState().switchTo(2, '4321'), 'switched');
    assert.equal(store.getState().overview?.active, 2);
    assert.equal(hooks.switched, 1);
  });

  it('unlocks the profile used last when it has a PIN', async () => {
    const { backend, calls } = fakeBackend([{ name: 'Me', pin: '0000' }]);
    const hooks = countingHooks();
    const store = createProfilesStore(backend, hooks);
    await store.getState().load();
    assert.equal(store.getState().picker, 'launch');
    // Already active, but locked: the core checks the PIN.
    assert.equal(await store.getState().switchTo(1), 'pinRequired');
    assert.equal(await store.getState().switchTo(1, '0000'), 'switched');
    assert.deepEqual(calls, ['switch 1', 'switch 1']);
    assert.equal(store.getState().picker, 'closed');
    // Same profile: nothing to read again.
    assert.equal(hooks.switched, 0);
  });

  it('passes other failures to the caller', async () => {
    const { backend } = fakeBackend([{ name: 'Me' }]);
    const store = createProfilesStore(backend, countingHooks());
    await store.getState().load();
    await assert.rejects(store.getState().switchTo(9), /doesn’t exist/);
    await assert.rejects(store.getState().remove(1), /Can’t delete/);
  });

  it('keeps the overview current as profiles are managed', async () => {
    const { backend } = fakeBackend([{ name: 'Me' }]);
    const store = createProfilesStore(backend, countingHooks());
    await store.getState().load();
    await store.getState().create('Sam', 'teal', '2468');
    const sam = store.getState().overview?.profiles[1];
    assert.equal(sam?.name, 'Sam');
    assert.equal(sam?.hasPin, true);
    assert.ok(!JSON.stringify(store.getState()).includes('2468'), 'no PIN in the store');

    await store.getState().rename(2, 'Samuel');
    await store.getState().setAvatar(2, 'rose');
    await store.getState().setPin(2, null);
    assert.deepEqual(store.getState().overview?.profiles[1], {
      id: 2,
      name: 'Samuel',
      avatar: 'rose',
      hasPin: false,
      createdAt: 0,
    });
    await store.getState().setShowPicker(false);
    assert.equal(store.getState().overview?.showPicker, false);
    await store.getState().remove(2);
    assert.equal(store.getState().overview?.profiles.length, 1);
  });
});

describe('switching profiles', () => {
  const item = (id: string): WatchlistItem => ({
    title: { type: 'movie', id, name: id, poster: null },
    addedAt: 0,
  });

  it('forgets the library, ignoring the old profile’s answers still on their way', async () => {
    let answer: (items: WatchlistItem[]) => void = () => undefined;
    const backend = {
      watchlist: () =>
        new Promise<WatchlistItem[]>((resolve) => {
          answer = resolve;
        }),
    } as unknown as LibraryBackend;
    const library = createLibraryStore(backend);
    const loading = library.getState().load('watchlist');
    library.getState().clear();
    answer([item('theirs')]);
    await loading;
    assert.deepEqual(library.getState().watchlist, { status: 'idle', items: [], error: null });
  });

  it('reads the settings again for the new profile', async () => {
    let profile = 'me';
    const stored: Record<string, Settings> = {
      me: DEFAULT_SETTINGS,
      sam: { ...DEFAULT_SETTINGS, playback: { ...DEFAULT_SETTINGS.playback, volume: 30 } },
    };
    const backend: SettingsBackend = {
      get: () => Promise.resolve(stored[profile] as Settings),
      set: (settings) => Promise.resolve(settings),
    };
    const settings = createSettingsStore(backend);
    assert.equal((await settings.getState().load()).playback.volume, 100);
    profile = 'sam';
    // `load` alone keeps what it read.
    assert.equal((await settings.getState().load()).playback.volume, 100);
    assert.equal((await settings.getState().reload()).playback.volume, 30);
    assert.equal(settings.getState().status, 'ready');
  });

  it('doesn’t let a slow read for the old profile land after the new one', async () => {
    const answers: ((settings: Settings) => void)[] = [];
    const backend: SettingsBackend = {
      get: () => new Promise<Settings>((resolve) => answers.push(resolve)),
      set: (settings) => Promise.resolve(settings),
    };
    const settings = createSettingsStore(backend);
    const first = settings.getState().load();
    const second = settings.getState().reload();
    const sam = { ...DEFAULT_SETTINGS, playback: { ...DEFAULT_SETTINGS.playback, volume: 30 } };
    answers[1]?.(sam);
    answers[0]?.(DEFAULT_SETTINGS);
    await Promise.all([first, second]);
    assert.equal(settings.getState().settings.playback.volume, 30);
  });
});
