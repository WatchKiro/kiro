/**
 * Release/download types and pure helpers. Safe for client and server code.
 * Fetching lives in `releases.ts` (server only).
 */

import {
  PREFERRED_PACKAGE,
  type Arch,
  type DetectedPlatform,
  type PackageKind,
  type Platform,
} from './platform';

export interface DownloadAsset {
  platform: Platform;
  arch: Arch;
  kind: PackageKind;
  name: string;
  url: string;
  /** Bytes. */
  size: number;
  /** Hex SHA-256, when the release publishes a checksum file. */
  sha256: string | null;
}

export interface Release {
  version: string;
  tag: string;
  /** ISO 8601. */
  publishedAt: string;
  /** Human-readable release page (notes, full asset list). */
  url: string;
  assets: DownloadAsset[];
}

function archRank(arch: Arch): number {
  // Universal first, then Apple Silicon / ARM, then x64.
  return arch === 'universal' ? 0 : arch === 'arm64' ? 1 : 2;
}

/** Assets for a platform, in the order they should be offered. */
export function assetsFor(release: Release, platform: Platform): DownloadAsset[] {
  const order = PREFERRED_PACKAGE[platform];
  return release.assets
    .filter((asset) => asset.platform === platform)
    .sort(
      (a, b) =>
        order.indexOf(a.kind) - order.indexOf(b.kind) || archRank(a.arch) - archRank(b.arch),
    );
}

/**
 * The single best download for a detected platform, or `null` when there is
 * nothing suitable (so the UI can send the visitor to the full list instead).
 *
 * When the architecture is unknown (Safari hides it) prefer universal, then
 * arm64: every Mac sold since 2020 is Apple Silicon, and Intel users can pick
 * from the full list. When the architecture *is* known, never hand out a
 * build for a different one.
 */
export function pickAsset(
  release: Release,
  detected: DetectedPlatform | null,
): DownloadAsset | null {
  if (!detected) return null;
  const candidates = assetsFor(release, detected.platform);
  if (candidates.length === 0) return null;
  if (detected.arch) {
    return candidates.find((a) => a.arch === detected.arch || a.arch === 'universal') ?? null;
  }
  return candidates[0] ?? null;
}

export function availablePlatforms(release: Release | null): ReadonlySet<Platform> {
  return new Set(release?.assets.map((asset) => asset.platform) ?? []);
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function formatReleaseDate(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(iso));
}
