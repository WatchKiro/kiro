const OS_NAMES: Record<string, string> = {
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
  android: 'Android',
  ios: 'iOS',
};

/** Human-readable name for a Rust `std::env::consts::OS` value. */
export function formatOs(os: string): string {
  return OS_NAMES[os] ?? os;
}

/** Whether shortcuts use ⌘ rather than Ctrl (macOS and iPadOS). */
export function usesCommandKey(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.userAgent);
}
