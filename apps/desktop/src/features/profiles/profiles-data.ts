/**
 * Profiles: their avatars, limits and checks, mirroring the core's rules
 * (`src-tauri/src/profiles`) so a form can refuse a bad value before saving.
 */
import type { Profile, ProfilesOverview } from '@/services/native';

/** Most profiles one computer can have (`profiles::MAX_PROFILES`). */
export const MAX_PROFILES = 8;
/** Longest profile name, in characters (`profiles::MAX_NAME_CHARS`). */
export const MAX_NAME_CHARS = 20;
/** A PIN is this many digits (`profiles::pin::PIN_DIGITS`). */
export const PIN_DIGITS = 4;

export interface AvatarStyle {
  id: string;
  label: string;
  /** Tailwind classes for the avatar's background (a gradient) and its letter. */
  className: string;
}

/**
 * The built-in avatars: a colour each, with the name's first letter on it.
 * Mirrors `profiles::AVATARS`; the first is the first profile's.
 */
export const AVATARS: readonly AvatarStyle[] = [
  { id: 'violet', label: 'Violet', className: 'from-[#a879ff] to-[#6a2fd6] text-white' },
  { id: 'blue', label: 'Blue', className: 'from-[#6aa8ff] to-[#2f5fd6] text-white' },
  { id: 'teal', label: 'Teal', className: 'from-[#4fe0cf] to-[#0f8f8a] text-white' },
  { id: 'green', label: 'Green', className: 'from-[#8fe36b] to-[#2f9a3c] text-white' },
  { id: 'amber', label: 'Amber', className: 'from-[#ffd66b] to-[#e08a12] text-ink-950' },
  { id: 'orange', label: 'Orange', className: 'from-[#ff9f6b] to-[#e0491f] text-white' },
  { id: 'rose', label: 'Rose', className: 'from-[#ff7aa8] to-[#c92c6a] text-white' },
  { id: 'slate', label: 'Slate', className: 'from-[#9aa3b8] to-[#4a5268] text-white' },
];

export function avatarStyle(id: string): AvatarStyle {
  return AVATARS.find((avatar) => avatar.id === id) ?? (AVATARS[0] as AvatarStyle);
}

/** An avatar no profile uses yet, for a new profile (the first if all are taken). */
export function unusedAvatar(profiles: readonly Profile[]): string {
  const used = new Set(profiles.map((profile) => profile.avatar));
  return (AVATARS.find((avatar) => !used.has(avatar.id)) ?? AVATARS[0])?.id ?? 'violet';
}

/** The name's first letter (a whole emoji or accented letter), capitalised. */
export function initialOf(name: string): string {
  const trimmed = name.trim();
  const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(trimmed);
  const first = segments[Symbol.iterator]().next().value?.segment ?? '';
  return first.toLocaleUpperCase();
}

/** Characters that are invisible or reorder text (as the core refuses them). */
const FORBIDDEN =
  // eslint-disable-next-line no-control-regex -- control characters are what this finds
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/u;

/**
 * Why `name` can't be a profile's name, or `null` if it can. `except`: the
 * profile being renamed, whose own name doesn't count as taken.
 */
export function nameProblem(
  name: string,
  profiles: readonly Profile[],
  except?: number,
): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Give the profile a name.';
  if ([...trimmed].length > MAX_NAME_CHARS) {
    return `Names can be at most ${MAX_NAME_CHARS} characters.`;
  }
  if (FORBIDDEN.test(trimmed)) return 'Names can’t contain control characters.';
  const lower = trimmed.toLocaleLowerCase();
  if (
    profiles.some((profile) => profile.id !== except && profile.name.toLocaleLowerCase() === lower)
  ) {
    return 'Another profile already has that name.';
  }
  return null;
}

export function isPin(pin: string): boolean {
  return new RegExp(`^[0-9]{${PIN_DIGITS}}$`).test(pin);
}

export function activeProfile(overview: ProfilesOverview): Profile | undefined {
  return overview.profiles.find((profile) => profile.id === overview.active);
}

/**
 * Whether "Who’s watching?" shows at launch: with more than one profile,
 * unless turned off, and always when the profile used last has a PIN (so
 * opening the app unlocks it, like switching into it). With one profile and
 * no PIN, the app opens straight away, as before profiles.
 */
export function showsPickerAtLaunch(overview: ProfilesOverview): boolean {
  if (activeProfile(overview)?.hasPin) return true;
  return overview.profiles.length > 1 && overview.showPicker;
}

/** What the core's profile commands return, checked before the app relies on it. */
export function parseOverview(value: unknown): ProfilesOverview {
  const record = (value ?? {}) as Partial<ProfilesOverview>;
  const profiles = Array.isArray(record.profiles)
    ? record.profiles.filter(
        (profile): profile is Profile =>
          typeof profile === 'object' &&
          profile !== null &&
          typeof profile.id === 'number' &&
          typeof profile.name === 'string',
      )
    : [];
  return {
    profiles: profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      avatar: avatarStyle(String(profile.avatar)).id,
      hasPin: profile.hasPin === true,
      createdAt: Number(profile.createdAt) || 0,
    })),
    active: typeof record.active === 'number' ? record.active : (profiles[0]?.id ?? 1),
    showPicker: record.showPicker !== false,
  };
}
