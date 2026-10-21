import { Button } from '@kiro/ui';
import { cx } from '@kiro/utils';
import { Check, Lock, Pencil, Plus, Trash2 } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';

import { PinPad } from '@/features/profiles/pin-pad';
import { ProfileAvatar } from '@/features/profiles/profile-avatar';
import { ProfileDialog } from '@/features/profiles/profile-dialog';
import {
  AVATARS,
  MAX_NAME_CHARS,
  MAX_PROFILES,
  activeProfile,
  nameProblem,
  unusedAvatar,
} from '@/features/profiles/profiles-data';
import { useProfilesStore } from '@/features/profiles/profiles-store';
import { Section, ToggleSetting } from '@/features/settings/settings-controls';
import { describeError, type Profile } from '@/services/native';

/** What the section has open: adding, editing or deleting a profile. */
type Open =
  | { kind: 'create' }
  | { kind: 'edit'; profile: Profile }
  | { kind: 'delete'; profile: Profile }
  | null;

/**
 * Settings → Profiles: everyone sharing the computer, with their own library
 * and settings. Add, rename, recolour, lock with a PIN, or delete a profile,
 * and choose whether "Who’s watching?" shows at launch.
 */
export function ProfilesSection() {
  const overview = useProfilesStore((state) => state.overview);
  const setShowPicker = useProfilesStore((state) => state.setShowPicker);
  const [open, setOpen] = useState<Open>(null);
  const [error, setError] = useState<string | null>(null);

  if (!overview) return null;
  const current = activeProfile(overview);
  const full = overview.profiles.length >= MAX_PROFILES;

  return (
    <Section
      id="profiles"
      title="Profiles"
      description="Everyone using Kiro on this computer can have their own library and settings. Addons are shared."
    >
      <ul className="divide-y divide-white/[0.05]">
        {overview.profiles.map((profile) => {
          const isCurrent = profile.id === current?.id;
          // A locked profile is changed from inside it (its PIN unlocks it).
          const lockedOut = profile.hasPin && !isCurrent;
          return (
            <li key={profile.id} className="flex items-center gap-4 px-5 py-3.5">
              <ProfileAvatar name={profile.name} avatar={profile.avatar} locked={profile.hasPin} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink-100">{profile.name}</p>
                <p className="text-xs text-ink-400">
                  {[
                    isCurrent && 'In use',
                    profile.hasPin && 'PIN',
                    lockedOut && 'Switch to it to change it',
                  ]
                    .filter(Boolean)
                    .join(' · ') || 'No PIN'}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                disabled={lockedOut}
                aria-label={`Edit ${profile.name}`}
                onClick={() => setOpen({ kind: 'edit', profile })}
              >
                <Pencil aria-hidden className="size-3.5" />
                Edit
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={isCurrent || overview.profiles.length === 1}
                aria-label={`Delete ${profile.name}`}
                title={isCurrent ? 'Switch to another profile to delete this one' : undefined}
                onClick={() => setOpen({ kind: 'delete', profile })}
              >
                <Trash2 aria-hidden className="size-3.5" />
              </Button>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-3 border-t border-white/[0.05] px-5 py-4">
        <Button
          variant="secondary"
          size="sm"
          disabled={full}
          onClick={() => setOpen({ kind: 'create' })}
        >
          <Plus aria-hidden className="size-4" />
          Add profile
        </Button>
        <p className="text-xs text-ink-400">
          {full
            ? `That’s the most profiles one computer can have (${MAX_PROFILES}).`
            : `Up to ${MAX_PROFILES} profiles.`}
        </p>
      </div>
      <div className="border-t border-white/[0.05]">
        <ToggleSetting
          label="Ask who’s watching"
          hint={
            overview.profiles.length > 1
              ? 'Show “Who’s watching?” when Kiro opens. Off: Kiro opens the profile used last (one with a PIN still asks for it).'
              : 'Once there’s more than one profile, Kiro asks who’s watching when it opens.'
          }
          checked={overview.showPicker}
          disabled={false}
          onChange={(show) =>
            void setShowPicker(show).catch((failure: unknown) => setError(describeError(failure)))
          }
        />
      </div>
      {error && (
        <p role="alert" className="border-t border-white/[0.05] px-5 py-3 text-sm text-red-300">
          {error}
        </p>
      )}

      {open?.kind === 'create' && (
        <ProfileEditor profiles={overview.profiles} onClose={() => setOpen(null)} />
      )}
      {open?.kind === 'edit' && (
        <ProfileEditor
          // Shows its changes (a new PIN) as they're saved.
          profile={overview.profiles.find((p) => p.id === open.profile.id) ?? open.profile}
          profiles={overview.profiles}
          onClose={() => setOpen(null)}
        />
      )}
      {open?.kind === 'delete' && (
        <DeleteProfile profile={open.profile} onClose={() => setOpen(null)} />
      )}
    </Section>
  );
}

/** Adding a profile (no `profile`), or changing one. */
function ProfileEditor({
  profile,
  profiles,
  onClose,
}: {
  profile?: Profile;
  profiles: Profile[];
  onClose: () => void;
}) {
  const create = useProfilesStore((state) => state.create);
  const rename = useProfilesStore((state) => state.rename);
  const setAvatar = useProfilesStore((state) => state.setAvatar);
  const setPin = useProfilesStore((state) => state.setPin);
  const nameId = useId();
  const avatarsId = useId();
  const [name, setName] = useState(profile?.name ?? '');
  const [avatar, setAvatarChoice] = useState(profile?.avatar ?? unusedAvatar(profiles));
  /** A new profile's PIN, until it's created. Kept only while this is open. */
  const [newPin, setNewPin] = useState<string | null>(null);
  const [choosingPin, setChoosingPin] = useState(false);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const problem = nameProblem(name, profiles, profile?.id);
  const hasPin = profile ? profile.hasPin : newPin !== null;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      return true;
    } catch (failure) {
      setError(describeError(failure));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (problem) return;
    const done = await run(async () => {
      if (!profile) return create(name.trim(), avatar, newPin);
      if (name.trim() !== profile.name) await rename(profile.id, name.trim());
      if (avatar !== profile.avatar) await setAvatar(profile.id, avatar);
    });
    if (done) onClose();
  };

  if (choosingPin) {
    return (
      <ProfileDialog
        title={profile?.hasPin ? 'Change the PIN' : 'Lock with a PIN'}
        description="A PIN stops others opening this profile by accident. It’s a convenience lock, not security: anyone using this computer could still find its files."
        onClose={() => setChoosingPin(false)}
      >
        {() => (
          <ChoosePin
            onChosen={async (pin) => {
              if (!profile) {
                setNewPin(pin);
                setChoosingPin(false);
                return null;
              }
              try {
                await setPin(profile.id, pin);
                setChoosingPin(false);
                return null;
              } catch (failure) {
                return describeError(failure);
              }
            }}
          />
        )}
      </ProfileDialog>
    );
  }

  return (
    <ProfileDialog title={profile ? `Edit ${profile.name}` : 'Add a profile'} onClose={onClose}>
      {() => (
        <form onSubmit={(event) => void submit(event)} className="space-y-5 px-6 pt-4 pb-6">
          <div className="flex justify-center">
            <ProfileAvatar name={name || '?'} avatar={avatar} size="lg" locked={hasPin} />
          </div>
          <div>
            <label htmlFor={nameId} className="text-sm font-medium text-ink-100">
              Name
            </label>
            <input
              id={nameId}
              autoFocus
              value={name}
              maxLength={MAX_NAME_CHARS * 2}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setName(event.target.value)}
              onBlur={() => setTouched(true)}
              aria-invalid={touched && problem !== null}
              aria-describedby={`${nameId}-problem`}
              className="mt-1.5 h-10 w-full rounded-[10px] border border-white/10 bg-white/[0.04] px-3 text-sm text-ink-50 placeholder:text-ink-500 focus-visible:focus-ring aria-invalid:border-red-400/50"
              placeholder="Who’s this for?"
            />
            <p id={`${nameId}-problem`} className="mt-1 min-h-4 text-xs text-red-300">
              {touched ? problem : null}
            </p>
          </div>
          <div>
            <p id={avatarsId} className="text-sm font-medium text-ink-100">
              Colour
            </p>
            <div
              role="radiogroup"
              aria-labelledby={avatarsId}
              data-nav-group
              className="mt-2 flex flex-wrap gap-2.5"
            >
              {AVATARS.map((choice) => (
                <button
                  key={choice.id}
                  type="button"
                  role="radio"
                  aria-checked={choice.id === avatar}
                  aria-label={choice.label}
                  title={choice.label}
                  onClick={() => setAvatarChoice(choice.id)}
                  className={cx(
                    'flex size-9 cursor-pointer items-center justify-center rounded-[11px] bg-linear-to-br transition-transform hover:scale-105 focus-visible:focus-ring',
                    choice.className,
                    choice.id === avatar && 'ring-2 ring-white ring-offset-2 ring-offset-ink-900',
                  )}
                >
                  {choice.id === avatar && <Check aria-hidden className="size-4" />}
                </button>
              ))}
            </div>
          </div>
          <div className="rounded-[12px] border border-white/[0.07] bg-white/[0.025] px-4 py-3">
            <div className="flex items-center gap-3">
              <Lock aria-hidden className="size-4 shrink-0 text-ink-400" />
              <p className="flex-1 text-sm text-ink-100">
                {hasPin ? 'Locked with a PIN' : 'No PIN'}
              </p>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setChoosingPin(true)}
              >
                {hasPin ? 'Change' : 'Add a PIN'}
              </Button>
              {hasPin && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    profile ? void run(() => setPin(profile.id, null)) : setNewPin(null)
                  }
                >
                  Remove
                </Button>
              )}
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-ink-400">
              Asked for when switching to this profile. A convenience lock, not security.
            </p>
          </div>
          {error && (
            <p role="alert" className="text-sm text-red-300">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || (touched && problem !== null)}>
              {profile ? 'Save' : 'Add profile'}
            </Button>
          </div>
        </form>
      )}
    </ProfileDialog>
  );
}

/** A new PIN, typed twice. */
function ChoosePin({ onChosen }: { onChosen: (pin: string) => Promise<string | null> }) {
  const headingId = useId();
  const [first, setFirst] = useState<string | null>(null);
  return (
    <div className="px-6 pt-4 pb-6">
      <p id={headingId} className="text-center text-sm font-medium text-ink-100" aria-live="polite">
        {first === null ? 'Choose 4 digits' : 'Enter them again'}
      </p>
      <PinPad
        key={first === null ? 'first' : 'again'}
        labelledBy={headingId}
        className="mt-5"
        onComplete={async (pin) => {
          if (first === null) {
            setFirst(pin);
            return null;
          }
          if (pin !== first) {
            setFirst(null);
            return 'Those didn’t match. Choose the PIN again.';
          }
          return onChosen(pin);
        }}
      />
    </div>
  );
}

/**
 * Deleting a profile, with its library and settings. One with a PIN needs
 * its name typed: deleting it doesn't need the PIN (how a forgotten one is
 * got rid of), so it shouldn't be one click.
 */
function DeleteProfile({ profile, onClose }: { profile: Profile; onClose: () => void }) {
  const remove = useProfilesStore((state) => state.remove);
  const confirmId = useId();
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const confirmed =
    !profile.hasPin || typed.trim().toLocaleLowerCase() === profile.name.toLocaleLowerCase();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!confirmed) return;
    setBusy(true);
    try {
      await remove(profile.id);
      onClose();
    } catch (failure) {
      setError(describeError(failure));
      setBusy(false);
    }
  };

  return (
    <ProfileDialog
      title={`Delete ${profile.name}?`}
      description={`${profile.name}’s watchlist, watch history and settings are deleted from this computer. This can’t be undone.`}
      onClose={onClose}
    >
      {() => (
        <form onSubmit={(event) => void submit(event)} className="space-y-4 px-6 pt-4 pb-6">
          {profile.hasPin && (
            <div>
              <label htmlFor={confirmId} className="text-sm text-ink-200">
                Type <span className="font-semibold text-ink-50">{profile.name}</span> to delete it
              </label>
              <input
                id={confirmId}
                autoFocus
                value={typed}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setTyped(event.target.value)}
                className="mt-1.5 h-10 w-full rounded-[10px] border border-white/10 bg-white/[0.04] px-3 text-sm text-ink-50 focus-visible:focus-ring"
              />
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-red-300">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose} data-nav-start>
              Cancel
            </Button>
            <button
              type="submit"
              disabled={busy || !confirmed}
              className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-full bg-red-500/90 px-4 text-sm font-medium text-white transition-colors hover:bg-red-500 focus-visible:focus-ring disabled:pointer-events-none disabled:opacity-50"
            >
              <Trash2 aria-hidden className="size-4" />
              Delete profile
            </button>
          </div>
        </form>
      )}
    </ProfileDialog>
  );
}
