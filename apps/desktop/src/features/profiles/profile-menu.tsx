import { cx } from '@kiro/utils';
import { Check, ChevronsUpDown, Lock, Settings2, Users } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import { ProfileAvatar } from '@/features/profiles/profile-avatar';
import { activeProfile } from '@/features/profiles/profiles-data';
import { useProfilesStore } from '@/features/profiles/profiles-store';
import { isTextField } from '@/features/remote/keys';
import { focusWithKeys, startOfLayer } from '@/features/remote/remote-navigation';
import { describeError, type Profile } from '@/services/native';

/**
 * The sidebar's profile button: the active profile's avatar and name. It
 * opens a menu to switch to another profile (one with a PIN opens its PIN
 * pad), see them all on "Who’s watching?", or manage them in Settings.
 */
export function ProfileMenu({ collapsed }: { collapsed: boolean }) {
  const overview = useProfilesStore((state) => state.overview);
  const switchTo = useProfilesStore((state) => state.switchTo);
  const openPicker = useProfilesStore((state) => state.openPicker);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // Opened with the keys: start on the active profile.
    if (trigger.current?.matches(':focus-visible, [data-nav-focus]') && panel.current) {
      const start = startOfLayer(panel.current);
      if (start) focusWithKeys(start);
    }
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      const back =
        event.key === 'Escape' ||
        (event.key === 'Backspace' && !isTextField(document.activeElement));
      if (!back) return;
      event.preventDefault();
      if (panel.current?.contains(document.activeElement) && trigger.current) {
        focusWithKeys(trigger.current);
      }
      setOpen(false);
    };
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const current = overview && activeProfile(overview);
  if (!overview || !current) return null;

  const choose = async (profile: Profile) => {
    setError(null);
    if (profile.id === current.id) return setOpen(false);
    if (profile.hasPin) {
      setOpen(false);
      return openPicker(profile.id);
    }
    try {
      await switchTo(profile.id);
      setOpen(false);
      void navigate('/');
    } catch (failure) {
      setError(describeError(failure));
    }
  };

  const item =
    'flex h-10 w-full cursor-pointer items-center gap-3 rounded-[10px] px-2.5 text-left text-sm text-ink-200 transition-colors hover:bg-white/[0.06] hover:text-ink-50 focus-visible:focus-ring';

  return (
    <div ref={root} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Profile: ${current.name}. Switch or manage profiles`}
        title={collapsed ? current.name : undefined}
        onClick={() => setOpen(!open)}
        className={cx(
          'flex h-11 w-full cursor-pointer items-center gap-3 rounded-[10px] px-2 text-sm text-ink-200 transition-colors hover:bg-white/[0.04] hover:text-ink-50 focus-visible:focus-ring',
          open && 'bg-white/[0.06] text-ink-50',
          collapsed && 'justify-center px-0',
        )}
      >
        <ProfileAvatar name={current.name} avatar={current.avatar} size="sm" />
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1 truncate text-left font-medium">{current.name}</span>
            <ChevronsUpDown aria-hidden className="size-4 shrink-0 text-ink-500" />
          </>
        )}
      </button>
      {open && (
        <div
          ref={panel}
          role="dialog"
          aria-label="Profiles"
          data-nav-layer
          className={cx(
            'absolute z-50 w-60 animate-[kiro-fade-in_120ms_ease-out] overflow-hidden rounded-2xl border border-white/10 bg-ink-900/95 p-1.5 shadow-2xl shadow-black/60 backdrop-blur-xl',
            collapsed ? 'bottom-0 left-full ml-3' : 'bottom-full left-0 mb-2',
          )}
        >
          <p className="px-2.5 pt-2 pb-1.5 text-[11px] font-semibold tracking-[0.08em] text-ink-500 uppercase">
            Switch profile
          </p>
          <ul data-nav-group>
            {overview.profiles.map((profile) => {
              const isCurrent = profile.id === current.id;
              return (
                <li key={profile.id}>
                  <button
                    type="button"
                    aria-current={isCurrent || undefined}
                    onClick={() => void choose(profile)}
                    className={cx(item, isCurrent && 'text-ink-50')}
                  >
                    <ProfileAvatar name={profile.name} avatar={profile.avatar} size="sm" />
                    <span className="min-w-0 flex-1 truncate">{profile.name}</span>
                    {isCurrent ? (
                      <Check aria-label="In use" className="size-4 text-accent-strong" />
                    ) : (
                      profile.hasPin && (
                        <Lock aria-label="Locked with a PIN" className="size-3.5 text-ink-500" />
                      )
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          {error && (
            <p role="alert" className="px-2.5 py-1.5 text-xs text-red-300">
              {error}
            </p>
          )}
          <div aria-hidden className="mx-1 my-1.5 h-px bg-white/[0.07]" />
          <button
            type="button"
            className={item}
            onClick={() => {
              setOpen(false);
              openPicker();
            }}
          >
            <Users aria-hidden className="size-[18px] text-ink-400" />
            Who’s watching?
          </button>
          <button
            type="button"
            className={item}
            onClick={() => {
              setOpen(false);
              void navigate('/settings#profiles');
            }}
          >
            <Settings2 aria-hidden className="size-[18px] text-ink-400" />
            Manage profiles
          </button>
        </div>
      )}
    </div>
  );
}
