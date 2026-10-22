import { Badge, Button } from '@kiro/ui';
import { Puzzle, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router';

import { Page } from '@/components/page';
import { AddonUrlForm } from '@/features/addons/addon-url-form';
import { useAddonsStore, type ManagedAddon } from '@/features/addons/addons-store';
import { displayableImage } from '@/features/addons/catalog';
import { describeError, isNativeRuntime } from '@/services/native';

export function AddonsPage() {
  const status = useAddonsStore((state) => state.status);
  const error = useAddonsStore((state) => state.error);
  const addons = useAddonsStore((state) => state.installed);
  const missingDefaults = useAddonsStore((state) => state.missingDefaults.length);
  const load = useAddonsStore((state) => state.load);
  const native = isNativeRuntime();

  useEffect(() => {
    if (native) void load();
  }, [native, load]);

  return (
    <Page
      title="Addons"
      description="Catalogues, details and streams all come from the addons you install."
      className="max-w-4xl space-y-6"
    >
      <InstallForm disabled={!native} />

      <section className="overflow-hidden rounded-card border border-white/[0.07] bg-white/[0.025]">
        <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
          <div className="flex items-center gap-2">
            <h2 className="text-[15px] font-semibold text-ink-50">Installed</h2>
            {status === 'ready' && <Badge>{addons.length}</Badge>}
          </div>
          <div className="flex items-center gap-4">
            {status === 'ready' && addons.length > 0 && missingDefaults > 0 && <RestoreDefaults />}
            {status === 'ready' && addons.length > 0 && (
              <Link
                to="/settings#addons"
                className="rounded text-[13px] text-accent-strong hover:underline focus-visible:focus-ring"
              >
                Order and turn off
              </Link>
            )}
          </div>
        </div>
        {!native ? (
          <p className="px-5 py-4 text-sm text-ink-400">
            Addons are only available inside the desktop app.
          </p>
        ) : status === 'error' ? (
          <div className="flex items-center justify-between gap-4 px-5 py-4 text-sm">
            <p className="text-ink-400">Installed addons could not be loaded: {error}</p>
            <Button variant="secondary" size="sm" onClick={() => void load({ force: true })}>
              Retry
            </Button>
          </div>
        ) : status !== 'ready' ? (
          <p className="px-5 py-4 text-sm text-ink-400">Loading…</p>
        ) : addons.length === 0 ? (
          <div className="flex flex-col items-center px-5 py-12 text-center">
            <Puzzle aria-hidden className="size-6 text-ink-500" />
            <p className="mt-3 text-sm text-ink-300">No addons installed yet.</p>
            <p className="mt-1 text-[13px] text-ink-500">
              Install one above to see its catalogues on Discover.
            </p>
            {missingDefaults > 0 && (
              <div className="mt-4">
                <RestoreDefaults />
              </div>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-white/[0.05]">
            {addons.map((addon) => (
              <AddonRow key={addon.transportUrl} addon={addon} />
            ))}
          </ul>
        )}
      </section>
    </Page>
  );
}

function InstallForm({ disabled }: { disabled: boolean }) {
  const inputId = useId();
  const hintId = useId();

  return (
    <section className="relative overflow-hidden rounded-card border border-white/[0.08] bg-linear-to-br from-accent/[0.12] via-white/[0.025] to-glow/[0.06] px-6 py-6">
      <label htmlFor={inputId} className="text-[15px] font-semibold text-ink-50">
        Install an addon
      </label>
      <p id={hintId} className="mt-1 text-[13px] leading-relaxed text-ink-400">
        Paste the manifest URL of a Stremio-compatible addon. Kiro never runs addon code; it only
        reads the catalogues and metadata an addon serves.
      </p>
      <AddonUrlForm inputId={inputId} hintId={hintId} disabled={disabled} />
    </section>
  );
}

/** Reinstalls the default addons that were removed (Cinemeta, OpenSubtitles). */
function RestoreDefaults() {
  const missing = useAddonsStore((state) => state.missingDefaults);
  const restoreDefaults = useAddonsStore((state) => state.restoreDefaults);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const names = missing.map((addon) => addon.manifest.name).join(', ');

  function onRestore() {
    setPending(true);
    setError(null);
    restoreDefaults()
      .catch((reason: unknown) => setError(describeError(reason)))
      .finally(() => setPending(false));
  }

  return (
    <div className="flex flex-col items-center gap-1">
      <Button
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={onRestore}
        title={`Reinstall ${names}`}
      >
        <RotateCcw aria-hidden className="size-4" />
        Restore default addons
      </Button>
      {error && (
        <p role="alert" className="text-[13px] text-rose-300">
          {error}
        </p>
      )}
    </div>
  );
}

function AddonRow({ addon }: { addon: ManagedAddon }) {
  const uninstall = useAddonsStore((state) => state.uninstall);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { manifest } = addon;
  const host = new URL(addon.transportUrl).host;

  function onRemove() {
    setPending(true);
    setError(null);
    uninstall(addon.transportUrl).catch((reason: unknown) => {
      setError(describeError(reason));
      setPending(false);
    });
  }

  return (
    <li className="flex gap-4 px-5 py-4 transition-colors hover:bg-white/[0.02]">
      <AddonLogo src={manifest.logo} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h3 className="text-sm font-medium text-ink-50">{manifest.name}</h3>
          <span className="text-xs text-ink-500 tabular-nums">v{manifest.version}</span>
          <span className="truncate text-xs text-ink-500">{host}</span>
          {!addon.enabled && <Badge>Off</Badge>}
        </div>
        {manifest.description && (
          <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-ink-400">
            {manifest.description}
          </p>
        )}
        <div className="mt-2 flex flex-wrap gap-1.5">
          {manifest.types.slice(0, 6).map((type) => (
            <Badge key={type}>{type}</Badge>
          ))}
          {manifest.catalogs.length > 0 && (
            <Badge tone="accent">
              {manifest.catalogs.length} catalogue{manifest.catalogs.length === 1 ? '' : 's'}
            </Badge>
          )}
        </div>
        {error && <p className="mt-2 text-[13px] text-rose-300">{error}</p>}
      </div>
      <Button
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={onRemove}
        aria-label={`Remove ${manifest.name}`}
        className="self-start"
      >
        <Trash2 aria-hidden className="size-4" />
        Remove
      </Button>
    </li>
  );
}

export function AddonLogo({ src }: { src: string | undefined }) {
  const [failed, setFailed] = useState(false);
  const url = displayableImage(src);
  return (
    <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.05]">
      {url && !failed ? (
        <img
          src={url}
          alt=""
          referrerPolicy="no-referrer"
          decoding="async"
          onError={() => setFailed(true)}
          className="size-full object-contain p-1.5"
        />
      ) : (
        <Puzzle aria-hidden className="size-5 text-accent-strong" />
      )}
    </div>
  );
}
