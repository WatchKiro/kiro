export type NormalizedAddonUrl = { ok: true; url: string } | { ok: false; message: string };

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Turns what a user pastes into an addon manifest URL:
 *
 * - `stremio://host/…` (Stremio's install links) becomes `https://host/…`
 * - a missing scheme defaults to `https://`
 * - `/manifest.json` is appended when the path does not end with it
 *
 * The URL policy here mirrors `AddonUrl` in Rust only to give early, friendly
 * errors; the Rust core enforces it.
 */
export function normalizeAddonUrl(input: string): NormalizedAddonUrl {
  let text = input.trim();
  if (text === '') return { ok: false, message: 'Enter an addon URL.' };

  if (/^stremio:\/\//i.test(text)) text = `https://${text.slice('stremio://'.length)}`;
  else if (!/^[a-z][a-z\d+.-]*:/i.test(text)) text = `https://${text}`;

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, message: 'That is not a valid URL.' };
  }

  const secure =
    url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
  if (!secure) {
    return { ok: false, message: 'Addon URLs must use https (http only for localhost).' };
  }
  if (url.username || url.password) {
    return { ok: false, message: 'Addon URLs must not contain a username or password.' };
  }

  url.hash = '';
  if (!url.pathname.endsWith('/manifest.json')) {
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/manifest.json`;
  }
  return { ok: true, url: url.href };
}
