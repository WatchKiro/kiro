/**
 * Desktop platform model shared by the download UI and the release parser.
 * Pure data and pure functions only, so it is safe in both server and client code.
 */

export type Platform = 'macos' | 'windows' | 'linux';
export type Arch = 'arm64' | 'x64' | 'universal';
export type PackageKind = 'dmg' | 'exe' | 'msi' | 'appimage' | 'deb' | 'rpm';

export interface PlatformInfo {
  id: Platform;
  label: string;
  /** Minimum supported OS, shown next to download links. */
  requirements: string;
}

export const PLATFORMS: readonly PlatformInfo[] = [
  { id: 'macos', label: 'macOS', requirements: 'macOS 12 Monterey or later' },
  { id: 'windows', label: 'Windows', requirements: 'Windows 10 or later (64-bit)' },
  { id: 'linux', label: 'Linux', requirements: 'Most modern 64-bit distributions' },
] as const;

export const PLATFORM_BY_ID: Readonly<Record<Platform, PlatformInfo>> = Object.fromEntries(
  PLATFORMS.map((platform) => [platform.id, platform]),
) as Record<Platform, PlatformInfo>;

export const ARCH_LABEL: Readonly<Record<Arch, string>> = {
  arm64: 'Apple Silicon',
  x64: 'Intel',
  universal: 'Universal',
};

/** Architecture labels are platform specific: "Apple Silicon" only makes sense on a Mac. */
export function archLabel(platform: Platform, arch: Arch): string {
  if (platform === 'macos') return ARCH_LABEL[arch];
  return arch === 'arm64' ? 'ARM64' : arch === 'x64' ? 'x64' : 'Universal';
}

export const PACKAGE_LABEL: Readonly<Record<PackageKind, string>> = {
  dmg: 'Disk image (.dmg)',
  exe: 'Installer (.exe)',
  msi: 'Windows Installer (.msi)',
  appimage: 'AppImage',
  deb: 'Debian package (.deb)',
  rpm: 'RPM package (.rpm)',
};

/** Preferred package per platform when a visitor just wants "the download". */
export const PREFERRED_PACKAGE: Readonly<Record<Platform, readonly PackageKind[]>> = {
  macos: ['dmg'],
  windows: ['exe', 'msi'],
  linux: ['appimage', 'deb', 'rpm'],
};

export interface DetectedPlatform {
  platform: Platform;
  /** `null` when the browser does not expose the CPU architecture. */
  arch: Arch | null;
}

interface NavigatorUAData {
  platform?: string;
  getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string; bitness?: string }>;
}

/**
 * Best-effort detection of the visitor's desktop platform.
 *
 * Uses User-Agent Client Hints where available (Chromium), falling back to the
 * UA string. Safari reports Apple Silicon Macs as Intel, so `arch` is left
 * `null` there and the caller decides on a sensible default.
 */
export async function detectPlatform(): Promise<DetectedPlatform | null> {
  if (typeof navigator === 'undefined') return null;

  const uaData = (navigator as Navigator & { userAgentData?: NavigatorUAData }).userAgentData;
  const ua = navigator.userAgent;

  let platform: Platform | null = null;
  const hintedPlatform = uaData?.platform?.toLowerCase() ?? '';
  if (hintedPlatform.includes('mac')) platform = 'macos';
  else if (hintedPlatform.includes('win')) platform = 'windows';
  else if (hintedPlatform.includes('linux')) platform = 'linux';
  else if (/iphone|ipad|ipod|android/i.test(ua)) return null;
  else if (/macintosh|mac os x/i.test(ua)) platform = 'macos';
  else if (/windows/i.test(ua)) platform = 'windows';
  else if (/linux|x11/i.test(ua)) platform = 'linux';

  if (!platform) return null;

  let arch: Arch | null = null;
  try {
    const hints = await uaData?.getHighEntropyValues?.(['architecture', 'bitness']);
    if (hints?.architecture === 'arm') arch = 'arm64';
    else if (hints?.architecture === 'x86' && hints.bitness === '64') arch = 'x64';
  } catch {
    // Client Hints unavailable or denied; fall through with arch unknown.
  }
  if (!arch && /\b(arm64|aarch64)\b/i.test(ua)) arch = 'arm64';
  if (!arch && /\b(x86_64|x64|win64|wow64|amd64)\b/i.test(ua)) arch = 'x64';

  return { platform, arch };
}
