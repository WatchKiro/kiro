import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseManifest } from '@kiro/addon-sdk';

import type { InstalledAddon } from '@/features/addons/addons-store';
import { firstRunAtLaunch } from '@/features/onboarding/first-run-data';
import { providesStreams, streamAvailability } from '@/features/title/title-data';
import type { FirstRun } from '@/services/native';

function addon(name: string, resources: unknown[], idPrefixes?: string[]): InstalledAddon {
  const manifest = parseManifest({
    id: `org.${name.toLowerCase()}`,
    version: '1.0.0',
    name,
    types: ['movie', 'series'],
    resources,
    idPrefixes,
  });
  assert.ok(manifest.ok);
  return {
    transportUrl: `https://${name.toLowerCase()}.example/manifest.json`,
    manifest: manifest.value,
  };
}

// What a new install has: catalogues and details, subtitles, no streams.
const CINEMETA = addon('Cinemeta', ['catalog', 'meta'], ['tt']);
const SUBTITLES = addon('Subtitles', ['subtitles'], ['tt']);
const FRESH = [CINEMETA, SUBTITLES];
const STREAMS = addon('Streams', [{ name: 'stream', types: ['movie'], idPrefixes: ['tt'] }]);
const ANIME_STREAMS = addon('Anime', ['stream'], ['kitsu:']);

const ready = (addons: InstalledAddon[]) => ({ status: 'ready' as const, addons });
const profile = (firstRun: FirstRun) => ({ firstRun });

describe('the first-run setup at launch', () => {
  it('shows for a pending profile with nothing that provides streams', () => {
    assert.equal(firstRunAtLaunch(profile('pending'), ready(FRESH)), 'show');
    assert.equal(firstRunAtLaunch(profile('pending'), ready([])), 'show');
  });

  it('never shows again once completed or skipped', () => {
    assert.equal(firstRunAtLaunch(profile('completed'), ready(FRESH)), 'hide');
    assert.equal(firstRunAtLaunch(profile('skipped'), ready(FRESH)), 'hide');
  });

  it('is per profile: each profile’s own state decides', () => {
    // On one computer (shared addons), Me skipped it and Sam is new.
    assert.equal(firstRunAtLaunch(profile('skipped'), ready(FRESH)), 'hide');
    assert.equal(firstRunAtLaunch(profile('pending'), ready(FRESH)), 'show');
  });

  it('isn’t needed when an addon already provides streams', () => {
    // A profile added on a computer that is set up, or one from before the setup.
    assert.equal(firstRunAtLaunch(profile('pending'), ready([...FRESH, STREAMS])), 'hide');
  });

  it('waits for the addons, and leaves it for next time if they can’t be read', () => {
    assert.equal(firstRunAtLaunch(profile('pending'), { status: 'idle', addons: [] }), 'wait');
    assert.equal(firstRunAtLaunch(profile('pending'), { status: 'loading', addons: [] }), 'wait');
    assert.equal(firstRunAtLaunch(profile('pending'), { status: 'error', addons: [] }), 'hide');
  });

  it('doesn’t show without a profile (outside the desktop app)', () => {
    assert.equal(firstRunAtLaunch(undefined, ready(FRESH)), 'hide');
  });
});

describe('telling apart why a title has no streams', () => {
  it('knows which addons provide streams at all', () => {
    assert.deepEqual([CINEMETA, SUBTITLES, STREAMS, ANIME_STREAMS].map(providesStreams), [
      false,
      false,
      true,
      true,
    ]);
  });

  it('has no addon to ask when none provides streams', () => {
    assert.equal(streamAvailability(FRESH, 'movie', 'tt0032138'), 'none');
    assert.equal(streamAvailability([], 'movie', 'tt0032138'), 'none');
  });

  it('has stream addons, just none for this title', () => {
    // A series (STREAMS serves only movies), and an id no addon knows.
    assert.equal(streamAvailability([...FRESH, STREAMS], 'series', 'tt0903747:1:1'), 'other');
    assert.equal(streamAvailability([...FRESH, ANIME_STREAMS], 'movie', 'tt0032138'), 'other');
  });

  it('has addons to ask (which may still find nothing)', () => {
    assert.equal(streamAvailability([...FRESH, STREAMS], 'movie', 'tt0032138'), 'available');
  });
});
