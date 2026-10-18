import { cache } from 'react';

import type { DownloadAsset, Release } from './downloads';
import type { Arch, PackageKind, Platform } from './platform';
import { siteConfig } from './site';

/*
 * Server-only. Reads the latest GitHub Release and turns Tauri's bundle
 * filenames into a platform/architecture download table for the website.
 *
 * Never import this from a client component: it reads a server-side token
 * and talks to the GitHub API. Pass the resulting `Release` down as props.
 */

interface GitHubAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface GitHubRelease {
  tag_name: string;
  html_url: string;
  published_at: string;
  draft: boolean;
  prerelease: boolean;
  assets: GitHubAsset[];
}

/** Revalidate the release table at most once an hour. */
const REVALIDATE_SECONDS = 60 * 60;

const GITHUB_API_URL = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');

/** `owner/name` of the repository that publishes releases. */
export function releasesRepo(): string | null {
  const override = process.env.KIRO_RELEASES_REPO?.trim();
  if (override) return override;
  if (!siteConfig.githubUrl) return null;
  try {
    const path = new URL(siteConfig.githubUrl).pathname
      .replace(/^\/|\/$/g, '')
      .replace(/\.git$/, '');
    return path.split('/').length === 2 ? path : null;
  } catch {
    return null;
  }
}

/** Web page listing every release, for "older versions" links. */
export function allReleasesUrl(): string | null {
  const repo = releasesRepo();
  return repo ? `https://github.com/${repo}/releases` : null;
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'kiro-website',
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * Map a Tauri bundle filename to a platform/arch/package triple.
 * Returns `null` for signatures, updater bundles, checksums and anything unknown.
 *
 * Examples produced by `tauri build`:
 *   Kiro_0.1.0_aarch64.dmg       Kiro_0.1.0_x64.dmg         Kiro_0.1.0_universal.dmg
 *   Kiro_0.1.0_x64-setup.exe     Kiro_0.1.0_x64_en-US.msi   Kiro_0.1.0_arm64-setup.exe
 *   Kiro_0.1.0_amd64.AppImage    Kiro_0.1.0_amd64.deb       Kiro-0.1.0-1.x86_64.rpm
 */
export function classifyAsset(
  name: string,
): Pick<DownloadAsset, 'platform' | 'arch' | 'kind'> | null {
  const lower = name.toLowerCase();

  let platform: Platform;
  let kind: PackageKind;
  if (lower.endsWith('.dmg')) [platform, kind] = ['macos', 'dmg'];
  else if (lower.endsWith('.exe')) [platform, kind] = ['windows', 'exe'];
  else if (lower.endsWith('.msi')) [platform, kind] = ['windows', 'msi'];
  else if (lower.endsWith('.appimage')) [platform, kind] = ['linux', 'appimage'];
  else if (lower.endsWith('.deb')) [platform, kind] = ['linux', 'deb'];
  else if (lower.endsWith('.rpm')) [platform, kind] = ['linux', 'rpm'];
  else return null;

  let arch: Arch;
  if (lower.includes('universal')) arch = 'universal';
  else if (/aarch64|arm64/.test(lower)) arch = 'arm64';
  else if (/x86_64|x64|amd64/.test(lower)) arch = 'x64';
  else return null;

  return { platform, arch, kind };
}

/**
 * Parse `sha256sum`-style output (`<hex>  <filename>` per line) into a
 * filename → hash map. A file containing a bare hash is attributed to
 * `defaultName` (for `Foo.dmg.sha256` sidecar files).
 */
export function parseChecksums(text: string, defaultName?: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const match = /^([a-f0-9]{64})\s+\*?(.+?)$/i.exec(line);
    const [, hash, file] = match ?? [];
    if (hash && file) {
      map.set(file.replace(/^.*\//, ''), hash.toLowerCase());
    } else if (defaultName && /^[a-f0-9]{64}$/i.test(line)) {
      map.set(defaultName, line.toLowerCase());
    }
  }
  return map;
}

function isChecksumFile(name: string): boolean {
  return /\.sha256$|^sha256sums?(\.txt)?$|^checksums?\.txt$/i.test(name);
}

async function fetchChecksums(assets: GitHubAsset[]): Promise<Map<string, string>> {
  const files = assets.filter((asset) => isChecksumFile(asset.name) && asset.size < 64 * 1024);
  const results = await Promise.allSettled(
    files.map(async (file) => {
      const response = await fetch(file.browser_download_url, {
        next: { revalidate: REVALIDATE_SECONDS },
      });
      if (!response.ok) throw new Error(`${file.name}: HTTP ${response.status}`);
      return parseChecksums(await response.text(), file.name.replace(/\.sha256$/i, ''));
    }),
  );
  const merged = new Map<string, string>();
  for (const result of results) {
    if (result.status === 'fulfilled') {
      for (const [name, hash] of result.value) merged.set(name, hash);
    }
  }
  return merged;
}

function toRelease(data: GitHubRelease, checksums: Map<string, string>): Release {
  const assets: DownloadAsset[] = [];
  for (const asset of data.assets) {
    const classified = classifyAsset(asset.name);
    if (!classified) continue;
    assets.push({
      ...classified,
      name: asset.name,
      url: asset.browser_download_url,
      size: asset.size,
      sha256: checksums.get(asset.name) ?? null,
    });
  }
  return {
    version: data.tag_name.replace(/^v/i, ''),
    tag: data.tag_name,
    publishedAt: data.published_at,
    url: data.html_url,
    assets,
  };
}

/**
 * The latest published, non-prerelease GitHub Release, or `null` when no
 * repository is configured, nothing has been released yet, or GitHub is
 * unreachable. Callers must render a sensible "coming soon" state for `null`.
 *
 * Wrapped in `cache()` so every component in a request shares one fetch.
 */
export const getLatestRelease = cache(async (): Promise<Release | null> => {
  const repo = releasesRepo();
  if (!repo) return null;

  try {
    const response = await fetch(`${GITHUB_API_URL}/repos/${repo}/releases/latest`, {
      headers: githubHeaders(),
      next: { revalidate: REVALIDATE_SECONDS },
    });
    if (!response.ok) {
      if (response.status !== 404) {
        console.warn(`[releases] GitHub responded ${response.status} for ${repo}`);
      }
      return null;
    }
    const data = (await response.json()) as GitHubRelease;
    if (data.draft || data.prerelease) return null;
    const release = toRelease(data, await fetchChecksums(data.assets));
    return release.assets.length > 0 ? release : null;
  } catch (error) {
    console.warn('[releases] Failed to load latest release:', error);
    return null;
  }
});
