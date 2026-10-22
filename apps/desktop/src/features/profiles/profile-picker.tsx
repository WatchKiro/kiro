import { Button, KiroMark } from '@kiro/ui';
import { cx } from '@kiro/utils';
import { ArrowLeft, Settings2, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import { PinPad } from '@/features/profiles/pin-pad';
import { ProfileAvatar } from '@/features/profiles/profile-avatar';
import { useProfilesStore } from '@/features/profiles/profiles-store';
import { focusWithKeys } from '@/features/remote/remote-navigation';
import { Switch } from '@/features/settings/settings-controls';
import { describeError, type Profile } from '@/services/native';

/**
 * "Who’s watching?": every profile as a large tile, TV-style, for the
 * pointer, a keyboard or a remote. At launch it stands in for the app until
 * a profile is chosen; opened from the sidebar it covers the app and Escape
 * or Back closes it. A profile with a PIN asks for it first.
 */
export function ProfilePicker() {
  const overview = useProfilesStore((state) => state.overview);
  const picker = useProfilesStore((state) => state.picker);
  const target = useProfilesStore((state) => state.pickerTarget);
  const closePicker = useProfilesStore((state) => state.closePicker);
  const switchTo = useProfilesStore((state) => state.switchTo);
  const setShowPicker = useProfilesStore((state) => state.setShowPicker);
  const navigate = useNavigate();
  const headingId = useId();
  const startupId = useId();
  const [unlocking, setUnlocking] = useState<Profile | null>(
    () => overview?.profiles.find((profile) => profile.id === target && profile.hasPin) ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const atLaunch = picker === 'launch';

  // Escape and Back close it when opened to switch (the PIN pad handles its own).
  useEffect(() => {
    if (atLaunch || unlocking) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape' || event.key === 'Backspace') {
        event.preventDefault();
        closePicker();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [atLaunch, unlocking, closePicker]);

  if (!overview) return null;
  const { profiles, active } = overview;

  /** Switches, then opens Discover for the profile (unless it stayed the same). */
  const enter = async (profile: Profile, pin?: string): Promise<string | null> => {
    setError(null);
    try {
      const result = await switchTo(profile.id, pin);
      if (result === 'wrongPin') return 'That PIN isn’t right. Try again.';
      if (result === 'pinRequired') {
        setUnlocking(profile);
        return null;
      }
      if (profile.id !== active) void navigate('/');
      return null;
    } catch (failure) {
      const message = describeError(failure);
      setError(message);
      return message;
    }
  };

  const choose = (profile: Profile) => {
    if (profile.hasPin) setUnlocking(profile);
    else void enter(profile);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={unlocking ? undefined : headingId}
      aria-label={unlocking ? `Enter the PIN for ${unlocking.name}` : undefined}
      // Arrows stay on the picker; Back is its own.
      data-nav-layer
      className="fixed inset-0 z-50 flex flex-col overflow-y-auto bg-ink-950 text-ink-100"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_0%,rgb(132_60_251/0.22),transparent_70%),radial-gradient(40%_40%_at_80%_100%,rgb(93_123_255/0.10),transparent_70%)]"
      />
      <header className="relative flex h-20 shrink-0 items-center justify-between px-8">
        <KiroMark className="size-8 shadow-[0_6px_20px_-6px_rgb(132_60_251/0.8)]" />
        {!atLaunch && (
          <button
            type="button"
            aria-label="Close"
            onClick={closePicker}
            className="flex size-10 cursor-pointer items-center justify-center rounded-full text-ink-300 transition-colors hover:bg-white/[0.08] hover:text-ink-50 focus-visible:focus-ring"
          >
            <X aria-hidden className="size-5" />
          </button>
        )}
      </header>

      <div className="relative flex flex-1 flex-col items-center justify-center px-8 pb-16">
        {unlocking ? (
          <UnlockProfile
            key={unlocking.id}
            profile={unlocking}
            onPin={(pin) => enter(unlocking, pin)}
            onBack={() => {
              setUnlocking(null);
              setError(null);
            }}
          />
        ) : (
          <div className="flex w-full max-w-5xl animate-[kiro-rise_320ms_ease-out] flex-col items-center">
            <h1
              id={headingId}
              className="text-center text-[2.5rem] leading-tight font-semibold tracking-[-0.03em] text-ink-50"
            >
              Who’s watching?
            </h1>
            <ul
              data-nav-group
              className="mt-12 flex flex-wrap items-start justify-center gap-x-8 gap-y-10"
            >
              {profiles.map((profile) => (
                <li key={profile.id}>
                  <ProfileTile
                    profile={profile}
                    current={!atLaunch && profile.id === active}
                    start={profile.id === active}
                    onChoose={() => choose(profile)}
                  />
                </li>
              ))}
            </ul>
            <p role="alert" className="mt-8 min-h-5 text-sm text-red-300">
              {error}
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-x-8 gap-y-4">
              {!atLaunch && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    closePicker();
                    void navigate('/settings/profiles');
                  }}
                >
                  <Settings2 aria-hidden className="size-4" />
                  Manage profiles
                </Button>
              )}
              {profiles.length > 1 && (
                <div className="flex items-center gap-3">
                  <Switch
                    labelledBy={startupId}
                    checked={overview.showPicker}
                    onChange={(show) => {
                      void setShowPicker(show).catch((failure: unknown) =>
                        setError(describeError(failure)),
                      );
                    }}
                  />
                  <span id={startupId} className="text-sm text-ink-300">
                    Show this at startup
                  </span>
                </div>
              )}
            </div>
            {profiles.length > 1 && !overview.showPicker && (
              <p className="mt-3 max-w-md text-center text-xs leading-relaxed text-ink-500">
                Kiro will open the profile used last. A profile with a PIN still asks for it.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ProfileTile({
  profile,
  current,
  start,
  onChoose,
}: {
  profile: Profile;
  /** The profile in use (when switching). */
  current: boolean;
  /** Where focus starts. */
  start: boolean;
  onChoose: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (start && ref.current) focusWithKeys(ref.current);
  }, [start]);

  return (
    <button
      ref={ref}
      type="button"
      onClick={onChoose}
      data-nav-start={start || undefined}
      aria-current={current || undefined}
      aria-label={`${profile.name}${profile.hasPin ? ', locked with a PIN' : ''}${current ? ', in use' : ''}`}
      className="group flex w-36 cursor-pointer flex-col items-center gap-4 rounded-[2rem] p-2 outline-none sm:w-40"
    >
      <ProfileAvatar
        name={profile.name}
        avatar={profile.avatar}
        size="xl"
        locked={profile.hasPin}
        className={cx(
          'transition-[scale,box-shadow,filter] duration-200 ease-out group-hover:scale-105 group-hover:brightness-110',
          'group-focus-visible:focus-lift',
          current && 'ring-2 ring-white/70 ring-offset-4 ring-offset-ink-950',
        )}
      />
      <span className="max-w-full truncate text-base font-medium text-ink-300 transition-colors group-hover:text-ink-50 group-focus-visible:text-ink-50">
        {profile.name}
      </span>
    </button>
  );
}

function UnlockProfile({
  profile,
  onPin,
  onBack,
}: {
  profile: Profile;
  onPin: (pin: string) => Promise<string | null>;
  onBack: () => void;
}) {
  const headingId = useId();
  return (
    <div className="flex w-full max-w-sm animate-[kiro-rise_240ms_ease-out] flex-col items-center text-center">
      <ProfileAvatar name={profile.name} avatar={profile.avatar} size="lg" />
      <h1
        id={headingId}
        className="mt-5 text-2xl font-semibold tracking-[-0.02em] text-balance text-ink-50"
      >
        Enter the PIN for {profile.name}
      </h1>
      <PinPad labelledBy={headingId} onComplete={onPin} onCancel={onBack} className="mt-8" />
      <Button variant="ghost" size="sm" onClick={onBack} className="mt-6">
        <ArrowLeft aria-hidden className="size-4" />
        Back to profiles
      </Button>
      <p className="mt-6 text-xs leading-relaxed text-ink-500">
        A PIN stops others opening this profile by accident. It’s a convenience lock, not security.
        Forgot it? Another profile can delete this one in Settings → Profiles.
      </p>
    </div>
  );
}
