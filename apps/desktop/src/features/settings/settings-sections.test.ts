import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_SETTINGS } from '@/features/settings/settings-data';
import {
  SETTINGS_SECTIONS,
  findSetting,
  resolveSettingsLocation,
  searchSettings,
  settingsPath,
} from '@/features/settings/settings-sections';

const ids = (query: string) => searchSettings(query).map((result) => result.setting.id);

describe('settings sections', () => {
  it('give every setting a unique anchor', () => {
    const anchors = SETTINGS_SECTIONS.flatMap((section) => section.settings.map(({ id }) => id));
    assert.equal(new Set(anchors).size, anchors.length);
    // Anchors and section ids share the old `/settings#…` namespace.
    for (const section of SETTINGS_SECTIONS) {
      assert.ok(!anchors.includes(section.id) || findSetting(section.id)?.section === section);
    }
  });

  it('only depend on settings that exist', () => {
    for (const section of SETTINGS_SECTIONS) {
      for (const setting of section.settings) {
        if (setting.shownWith) assert.ok(findSetting(setting.shownWith), setting.id);
      }
    }
  });

  it('reset every stored setting from exactly one section', () => {
    // Settings → Audio and Subtitles show playback settings: between them,
    // the section resets still cover each field once, as the old page did.
    for (const store of ['general', 'playback', 'subtitles', 'streams'] as const) {
      const reset = SETTINGS_SECTIONS.flatMap(
        (section) => (section.fields?.[store] ?? []) as readonly string[],
      );
      assert.deepEqual(reset.toSorted(), Object.keys(DEFAULT_SETTINGS[store]).toSorted(), store);
    }
  });
});

describe('resolveSettingsLocation', () => {
  it('shows General at /settings', () => {
    assert.deepEqual(resolveSettingsLocation(undefined, ''), { section: 'general', setting: null });
  });

  it('shows a section and the setting it links to', () => {
    assert.deepEqual(resolveSettingsLocation('streams', ''), { section: 'streams', setting: null });
    assert.deepEqual(resolveSettingsLocation('playback', '#skip-intros'), {
      section: 'playback',
      setting: 'skip-intros',
    });
  });

  it('sends an unknown section back to /settings', () => {
    assert.deepEqual(resolveSettingsLocation('trakt', ''), { redirect: '/settings' });
  });

  it('moves the old one-page anchors to their section', () => {
    assert.deepEqual(resolveSettingsLocation(undefined, '#streams'), {
      redirect: '/settings/streams',
    });
    assert.deepEqual(resolveSettingsLocation(undefined, '#profiles'), {
      redirect: '/settings/profiles',
    });
    assert.deepEqual(resolveSettingsLocation(undefined, '#stremio'), {
      redirect: '/settings/import#stremio',
    });
    assert.deepEqual(resolveSettingsLocation(undefined, '#keyboard'), {
      redirect: '/settings/general#keyboard',
    });
  });

  it('finds the section of a setting linked without one', () => {
    assert.deepEqual(resolveSettingsLocation(undefined, '#passthrough'), {
      redirect: '/settings/audio#passthrough',
    });
    assert.deepEqual(resolveSettingsLocation(undefined, '#nothing'), {
      section: 'general',
      setting: null,
    });
  });

  it('builds the addresses it reads', () => {
    assert.equal(settingsPath('subtitles'), '/settings/subtitles');
    assert.equal(settingsPath('subtitles', 'subtitle-size'), '/settings/subtitles#subtitle-size');
  });
});

describe('searchSettings', () => {
  it('finds nothing for an empty query', () => {
    assert.deepEqual(searchSettings('   '), []);
  });

  it('matches the starts of words in labels, in any case', () => {
    assert.deepEqual(ids('KEEP SCREEN'), ['keep-screen-on']);
    assert.deepEqual(ids('resol'), ['max-resolution']);
  });

  it('matches the words people use for a setting', () => {
    assert.ok(ids('dolby').includes('passthrough'));
    assert.ok(ids('dolby').includes('prefer-hdr'));
    assert.deepEqual(ids('sdh'), ['subtitle-type']);
    assert.deepEqual(ids('pin'), ['profiles']);
    assert.ok(ids('4k').includes('max-resolution'));
  });

  it('needs every word to match', () => {
    assert.deepEqual(ids('subtitle size'), ['subtitle-size']);
    assert.deepEqual(ids('size zebra'), []);
  });

  it('ranks label matches above keyword and section matches', () => {
    // "Subtitle languages" says it in its label; "Size" is only in Subtitles.
    const results = ids('subtitle');
    assert.equal(results[0], 'subtitles-off');
    assert.ok(results.includes('subtitle-size'));
    assert.ok(results.indexOf('subtitle-languages') < results.indexOf('subtitle-size'));
  });

  it('ignores accents and curly apostrophes', () => {
    assert.deepEqual(ids("who's watching"), ['ask-whos-watching']);
    assert.deepEqual(ids('whos'), ['ask-whos-watching']);
    assert.deepEqual(ids('ÉDGE'), ['subtitle-edge']);
  });

  it('says which section and group a result is in', () => {
    const [first] = searchSettings('autoplay');
    assert.equal(first?.section.id, 'playback');
    assert.equal(first?.setting.group, 'Up next');
  });
});
