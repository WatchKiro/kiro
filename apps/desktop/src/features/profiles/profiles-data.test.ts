import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AVATARS,
  MAX_NAME_CHARS,
  avatarStyle,
  initialOf,
  isPin,
  nameProblem,
  parseOverview,
  showsPickerAtLaunch,
  unusedAvatar,
} from '@/features/profiles/profiles-data';
import type { Profile, ProfilesOverview } from '@/services/native';

function profile(id: number, name: string, extra: Partial<Profile> = {}): Profile {
  return { id, name, avatar: 'violet', hasPin: false, createdAt: 0, firstRun: 'pending', ...extra };
}

function overview(profiles: Profile[], extra: Partial<ProfilesOverview> = {}): ProfilesOverview {
  return { profiles, active: profiles[0]?.id ?? 1, showPicker: true, ...extra };
}

describe('the picker at launch', () => {
  it('goes straight in with one profile, as before profiles', () => {
    assert.equal(showsPickerAtLaunch(overview([profile(1, 'Me')])), false);
  });

  it('asks who’s watching with more than one, unless turned off', () => {
    const two = [profile(1, 'Me'), profile(2, 'Sam')];
    assert.equal(showsPickerAtLaunch(overview(two)), true);
    assert.equal(showsPickerAtLaunch(overview(two, { showPicker: false })), false);
  });

  it('always asks when the profile used last has a PIN', () => {
    const locked = [profile(1, 'Me', { hasPin: true }), profile(2, 'Sam')];
    assert.equal(showsPickerAtLaunch(overview(locked, { showPicker: false })), true);
    assert.equal(showsPickerAtLaunch(overview([profile(1, 'Me', { hasPin: true })])), true);
    // Another profile's PIN doesn't matter until it's switched to.
    const other = [profile(1, 'Me'), profile(2, 'Sam', { hasPin: true })];
    assert.equal(showsPickerAtLaunch(overview(other, { showPicker: false })), false);
  });
});

describe('profile names', () => {
  const profiles = [profile(1, 'Me'), profile(2, 'Grandma')];

  it('accepts names the core accepts', () => {
    for (const name of ['Sam', '  Zoë ', '👩‍👧 Kids', 'x'.repeat(MAX_NAME_CHARS)]) {
      assert.equal(nameProblem(name, profiles), null, name);
    }
  });

  it('refuses empty, long, invisible and taken names', () => {
    for (const name of [
      '',
      '   ',
      'x'.repeat(MAX_NAME_CHARS + 1),
      'a\nb',
      '\u202eevil',
      'zero\u200bwidth',
      'grandma',
      ' ME ',
    ]) {
      assert.notEqual(nameProblem(name, profiles), null, JSON.stringify(name));
    }
  });

  it('lets a profile keep its own name', () => {
    assert.equal(nameProblem('GRANDMA', profiles, 2), null);
    assert.notEqual(nameProblem('Me', profiles, 2), null);
  });
});

describe('avatars and PINs', () => {
  it('shows the first letter, a whole emoji or accented letter', () => {
    assert.equal(initialOf('sam'), 'S');
    assert.equal(initialOf('  émile'), 'É');
    assert.equal(initialOf('👩‍👧 Kids'), '👩‍👧');
    assert.equal(initialOf(''), '');
  });

  it('picks a colour no profile uses yet', () => {
    assert.equal(unusedAvatar([profile(1, 'Me')]), 'blue');
    const all = AVATARS.map((avatar, index) =>
      profile(index + 1, avatar.id, { avatar: avatar.id }),
    );
    assert.equal(unusedAvatar(all), 'violet');
    assert.equal(avatarStyle('nope').id, 'violet');
  });

  it('takes exactly four digits', () => {
    assert.equal(isPin('0420'), true);
    for (const pin of ['', '123', '12345', '12a4', '١٢٣٤', '12 4']) assert.equal(isPin(pin), false);
  });

  it('checks what the core returns', () => {
    const parsed = parseOverview({
      profiles: [
        { id: 1, name: 'Me', avatar: 'gold', hasPin: 'yes', createdAt: 5, firstRun: 'pending' },
        { id: 3, name: 'Sam', avatar: 'teal', hasPin: true, createdAt: 6, firstRun: 'later' },
        { id: 'x', name: 2 },
      ],
      active: 1,
    });
    assert.deepEqual(parsed, {
      profiles: [
        { id: 1, name: 'Me', avatar: 'violet', hasPin: false, createdAt: 5, firstRun: 'pending' },
        // An unknown first-run state counts as done, as in the core.
        { id: 3, name: 'Sam', avatar: 'teal', hasPin: true, createdAt: 6, firstRun: 'completed' },
      ],
      active: 1,
      showPicker: true,
    });
    assert.deepEqual(parseOverview(null), { profiles: [], active: 1, showPicker: true });
  });
});
