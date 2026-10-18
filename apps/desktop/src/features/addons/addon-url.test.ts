import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeAddonUrl } from '@/features/addons/addon-url';

function url(input: string) {
  const result = normalizeAddonUrl(input);
  assert.ok(result.ok, `expected ${input} to be accepted`);
  return result.url;
}

describe('normalizeAddonUrl', () => {
  it('keeps manifest URLs as they are', () => {
    assert.equal(
      url('  https://v3-cinemeta.strem.io/manifest.json '),
      'https://v3-cinemeta.strem.io/manifest.json',
    );
  });

  it('accepts Stremio install links and bare hosts', () => {
    assert.equal(
      url('stremio://addon.example.com/cfg/manifest.json'),
      'https://addon.example.com/cfg/manifest.json',
    );
    assert.equal(url('addon.example.com'), 'https://addon.example.com/manifest.json');
  });

  it('appends /manifest.json to addon base URLs', () => {
    assert.equal(
      url('https://addon.example.com/cfg/'),
      'https://addon.example.com/cfg/manifest.json',
    );
    assert.equal(url('https://addon.example.com/#x'), 'https://addon.example.com/manifest.json');
  });

  it('allows http only on loopback', () => {
    assert.equal(url('http://localhost:7000'), 'http://localhost:7000/manifest.json');
    assert.equal(url('http://[::1]:7000/manifest.json'), 'http://[::1]:7000/manifest.json');
    for (const input of [
      '',
      'http://addon.example.com/manifest.json',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'https://user:secret@addon.example.com/manifest.json',
      'https://',
    ]) {
      assert.equal(normalizeAddonUrl(input).ok, false, `expected ${input} to be rejected`);
    }
  });
});
