import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assetsFor, availablePlatforms, formatBytes, pickAsset, type Release } from './downloads';
import { classifyAsset, parseChecksums } from './releases';

describe('classifyAsset: Tauri bundle filenames', () => {
  const cases: Array<[string, ReturnType<typeof classifyAsset>]> = [
    ['Kiro_0.1.0_aarch64.dmg', { platform: 'macos', arch: 'arm64', kind: 'dmg' }],
    ['Kiro_0.1.0_x64.dmg', { platform: 'macos', arch: 'x64', kind: 'dmg' }],
    ['Kiro_0.1.0_universal.dmg', { platform: 'macos', arch: 'universal', kind: 'dmg' }],
    ['Kiro_0.1.0_x64-setup.exe', { platform: 'windows', arch: 'x64', kind: 'exe' }],
    ['Kiro_0.1.0_arm64-setup.exe', { platform: 'windows', arch: 'arm64', kind: 'exe' }],
    ['Kiro_0.1.0_x64_en-US.msi', { platform: 'windows', arch: 'x64', kind: 'msi' }],
    ['Kiro_0.1.0_amd64.AppImage', { platform: 'linux', arch: 'x64', kind: 'appimage' }],
    ['Kiro_0.1.0_amd64.deb', { platform: 'linux', arch: 'x64', kind: 'deb' }],
    ['Kiro-0.1.0-1.x86_64.rpm', { platform: 'linux', arch: 'x64', kind: 'rpm' }],
    ['Kiro_0.1.0_aarch64.app.tar.gz', null],
    ['Kiro_0.1.0_aarch64.app.tar.gz.sig', null],
    ['Kiro_0.1.0_aarch64.dmg.sha256', null],
    ['latest.json', null],
    ['Kiro_0.1.0.dmg', null],
  ];

  for (const [name, expected] of cases) {
    it(name, () => assert.deepEqual(classifyAsset(name), expected));
  }
});

describe('parseChecksums', () => {
  it('reads sha256sum output with binary markers and paths', () => {
    const hash = 'a'.repeat(64);
    const text = `${hash}  Kiro_0.1.0_aarch64.dmg\n${'b'.repeat(64)} *dist/Kiro_0.1.0_x64.dmg\n\nnot a hash line\n`;
    const map = parseChecksums(text);
    assert.equal(map.get('Kiro_0.1.0_aarch64.dmg'), hash);
    assert.equal(map.get('Kiro_0.1.0_x64.dmg'), 'b'.repeat(64));
    assert.equal(map.size, 2);
  });

  it('attributes a bare hash to the sidecar file name', () => {
    const hash = 'C'.repeat(64);
    const map = parseChecksums(`${hash}\n`, 'Kiro_0.1.0_aarch64.dmg');
    assert.equal(map.get('Kiro_0.1.0_aarch64.dmg'), hash.toLowerCase());
  });
});

const release: Release = {
  version: '0.1.0',
  tag: 'v0.1.0',
  publishedAt: '2026-10-17T00:00:00Z',
  url: 'https://github.com/example/kiro/releases/tag/v0.1.0',
  assets: [
    asset('Kiro_0.1.0_x64_en-US.msi', 'windows', 'x64', 'msi'),
    asset('Kiro_0.1.0_x64-setup.exe', 'windows', 'x64', 'exe'),
    asset('Kiro_0.1.0_x64.dmg', 'macos', 'x64', 'dmg'),
    asset('Kiro_0.1.0_aarch64.dmg', 'macos', 'arm64', 'dmg'),
  ],
};

function asset(
  name: string,
  platform: Release['assets'][number]['platform'],
  arch: Release['assets'][number]['arch'],
  kind: Release['assets'][number]['kind'],
): Release['assets'][number] {
  return { name, platform, arch, kind, url: `https://dl.example/${name}`, size: 1, sha256: null };
}

describe('assetsFor', () => {
  it('orders by preferred package, then architecture', () => {
    assert.deepEqual(
      assetsFor(release, 'windows').map((a) => a.name),
      ['Kiro_0.1.0_x64-setup.exe', 'Kiro_0.1.0_x64_en-US.msi'],
    );
    assert.deepEqual(
      assetsFor(release, 'macos').map((a) => a.name),
      ['Kiro_0.1.0_aarch64.dmg', 'Kiro_0.1.0_x64.dmg'],
    );
    assert.deepEqual(assetsFor(release, 'linux'), []);
  });
});

describe('pickAsset', () => {
  it('matches the detected architecture exactly', () => {
    assert.equal(
      pickAsset(release, { platform: 'macos', arch: 'x64' })?.name,
      'Kiro_0.1.0_x64.dmg',
    );
  });

  it('defaults to Apple Silicon when the browser hides the architecture', () => {
    assert.equal(
      pickAsset(release, { platform: 'macos', arch: null })?.name,
      'Kiro_0.1.0_aarch64.dmg',
    );
  });

  it('never offers a build for a different architecture', () => {
    assert.equal(pickAsset(release, { platform: 'windows', arch: 'arm64' }), null);
  });

  it('returns null for unsupported platforms and unknown visitors', () => {
    assert.equal(pickAsset(release, { platform: 'linux', arch: 'x64' }), null);
    assert.equal(pickAsset(release, null), null);
  });
});

describe('availablePlatforms and formatBytes', () => {
  it('lists only platforms with at least one asset', () => {
    assert.deepEqual([...availablePlatforms(release)].sort(), ['macos', 'windows']);
    assert.equal(availablePlatforms(null).size, 0);
  });

  it('formats sizes for humans', () => {
    assert.equal(formatBytes(17_800_000), '17 MB');
    assert.equal(formatBytes(1_500_000_000), '1.4 GB');
    assert.equal(formatBytes(512), '1 KB');
  });
});
