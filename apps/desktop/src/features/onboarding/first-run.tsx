import { Button, KiroMark } from '@kiro/ui';
import { ArrowRight, Download, Link2, X } from 'lucide-react';
import { useEffect, useEffectEvent, useId, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';

import { AddonUrlForm } from '@/features/addons/addon-url-form';
import { useAddonsStore } from '@/features/addons/addons-store';
import { firstRunAtLaunch } from '@/features/onboarding/first-run-data';
import { useSetupStore } from '@/features/onboarding/setup-store';
import { activeProfile } from '@/features/profiles/profiles-data';
import { useProfilesStore } from '@/features/profiles/profiles-store';
import { isTextField, keyAction } from '@/features/remote/keys';
import { focusWithKeys } from '@/features/remote/remote-navigation';
import { IS_ANDROID } from '@/lib/platform';
import { isNativeRuntime } from '@/services/native';

/**
 * Opens the first-run setup at launch when the active profile's is pending
 * and nothing provides streams yet (`firstRunAtLaunch`), and shows it while
 * open. Rendered once per profile (keyed by it), beside the app shell.
 */
export function FirstRunGate() {
  const native = isNativeRuntime();
  const profile = useProfilesStore((state) => state.overview && activeProfile(state.overview));
  const addonsStatus = useAddonsStore((state) => state.status);
  const addons = useAddonsStore((state) => state.addons);
  const loadAddons = useAddonsStore((state) => state.load);
  const open = useSetupStore((state) => state.open);
  const show = useSetupStore((state) => state.show);
  const atLaunch = firstRunAtLaunch(profile ?? undefined, { status: addonsStatus, addons });
  // Decided once: adding a stream addon in the setup doesn't close it.
  const decided = useRef(false);

  useEffect(() => {
    if (native) void loadAddons();
  }, [native, loadAddons]);

  useEffect(() => {
    if (decided.current || atLaunch === 'wait') return;
    decided.current = true;
    if (atLaunch === 'show') show('launch');
  }, [atLaunch, show]);

  return open ? <FirstRunSetup atLaunch={open === 'launch'} /> : null;
}

/**
 * Welcome, and the ways to get something to watch: add an addon by its link,
 * or import from Stremio. Kiro recommends no addons of its own: none serving
 * only licensed or public-domain content could be verified (docs/first-run.md).
 *
 * A full-screen layer for the pointer, keys or a remote. Escape or Back (or
 * the close button) skips it; once something is added, it's Done.
 */
function FirstRunSetup({ atLaunch }: { atLaunch: boolean }) {
  const finish = useSetupStore((state) => state.finish);
  const defaultsInstalled = useAddonsStore(
    (state) => state.status === 'ready' && state.missingDefaults.length === 0,
  );
  const native = isNativeRuntime();
  const navigate = useNavigate();
  const headingId = useId();
  const inputId = useId();
  const hintId = useId();
  const [done, setDone] = useState(false);
  const close = () => finish(done ? 'completed' : 'skipped');
  const onBack = useEffectEvent(close);

  // Starts on the link field, ready for a paste. Not on a TV, where a
  // focused field opens the on-screen keyboard and takes the D-pad.
  useEffect(() => {
    if (IS_ANDROID) return;
    const field = document.getElementById(inputId);
    if (field) focusWithKeys(field);
  }, [inputId]);

  // Escape and Back close it, except while typing a link.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || keyAction(event)?.kind !== 'back') return;
      if (isTextField(event.target instanceof HTMLElement ? event.target : null)) return;
      event.preventDefault();
      onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const importFromStremio = () => {
    finish('completed');
    void navigate('/settings/import#stremio');
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      data-nav-layer
      className="fixed inset-0 z-40 flex flex-col overflow-y-auto bg-ink-950 text-ink-100 tv:px-12 tv:py-7"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_0%,rgb(132_60_251/0.22),transparent_70%),radial-gradient(40%_40%_at_80%_100%,rgb(93_123_255/0.10),transparent_70%)]"
      />
      <header className="relative flex h-20 shrink-0 items-center justify-between px-8">
        <KiroMark className="size-8 shadow-[0_6px_20px_-6px_rgb(132_60_251/0.8)]" />
        <button
          type="button"
          aria-label={done ? 'Done' : atLaunch ? 'Skip setup' : 'Close'}
          title={done ? 'Done' : atLaunch ? 'Skip setup' : 'Close'}
          onClick={close}
          className="flex size-10 cursor-pointer items-center justify-center rounded-full text-ink-300 transition-colors hover:bg-white/[0.08] hover:text-ink-50 focus-visible:focus-ring"
        >
          <X aria-hidden className="size-5" />
        </button>
      </header>

      <div className="relative mx-auto flex w-full max-w-2xl flex-1 animate-[kiro-rise_320ms_ease-out] flex-col px-8 pt-4 pb-16">
        <h1
          id={headingId}
          className="text-[2.5rem] leading-tight font-semibold tracking-[-0.03em] text-ink-50"
        >
          Welcome to Kiro
        </h1>
        <p className="mt-4 text-[15px] leading-relaxed text-ink-300">
          Kiro plays content from addons.
          {defaultsInstalled &&
            ' Cinemeta (catalogues) and OpenSubtitles (subtitles) are installed.'}{' '}
          Add addons to watch things.
        </p>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-500">
          Addons are made and run by others, not by Kiro, and you choose which to add.
        </p>

        <div className="mt-10 space-y-3">
          <Way
            icon={<Link2 aria-hidden className="size-5" />}
            title={<label htmlFor={inputId}>Add an addon by its link</label>}
            description={
              <span id={hintId}>
                Paste the link to a Stremio-compatible addon’s manifest. Kiro never runs addon code;
                it only reads what the addon serves.
              </span>
            }
          >
            <AddonUrlForm
              inputId={inputId}
              hintId={hintId}
              disabled={!native}
              submitLabel="Add"
              onInstalled={() => setDone(true)}
            />
          </Way>
          <Way
            icon={<Download aria-hidden className="size-5" />}
            title="Import from Stremio"
            description="Bring the addons, library and watch progress of a Stremio account."
          >
            <Button
              variant="secondary"
              disabled={!native}
              onClick={importFromStremio}
              className="mt-4"
            >
              Import from Stremio
              <ArrowRight aria-hidden className="size-4" />
            </Button>
          </Way>
        </div>

        <div className="mt-10 flex flex-wrap items-center justify-end gap-4">
          {!done && atLaunch && (
            <p className="text-[13px] text-ink-500">You can open this again from Settings.</p>
          )}
          <Button variant={done ? 'primary' : 'secondary'} onClick={close}>
            {done ? 'Done' : atLaunch ? 'Skip for now' : 'Close'}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** One way forward: an icon, what it does, and its controls. */
function Way({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: ReactNode;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex gap-5 rounded-card border border-white/[0.07] bg-white/[0.025] px-6 py-5">
      <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-linear-to-b from-white/[0.08] to-white/[0.02] text-accent-strong">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <h2 className="text-[15px] font-semibold text-ink-50">{title}</h2>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-400">{description}</p>
        {children}
      </div>
    </section>
  );
}
