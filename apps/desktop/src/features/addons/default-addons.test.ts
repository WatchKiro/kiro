import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { parseManifest } from '@kiro/addon-sdk';

/** The manifest snapshots the core installs into a new profile (`addons::defaults`). */
const SNAPSHOTS = new URL('../../../src-tauri/src/addons/defaults/', import.meta.url);

describe('default addons', () => {
  const files = readdirSync(SNAPSHOTS).filter((file) => file.endsWith('.json'));

  it('bundles Cinemeta and OpenSubtitles v3', () => {
    assert.deepEqual(files.sort(), ['cinemeta.json', 'opensubtitles-v3.json']);
  });

  for (const file of files) {
    it(`${file} passes manifest validation and needs no configuration`, () => {
      const parsed = parseManifest(JSON.parse(readFileSync(new URL(file, SNAPSHOTS), 'utf8')));
      assert.ok(parsed.ok, JSON.stringify(parsed.ok ? null : parsed.issues));
      assert.notEqual(parsed.value.behaviorHints?.configurationRequired, true);
    });
  }
});
