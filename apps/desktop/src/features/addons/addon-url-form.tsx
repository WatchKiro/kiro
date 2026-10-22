import { Button } from '@kiro/ui';
import { Loader2, Plus } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';

import { useAddonsStore, type InstalledAddon } from '@/features/addons/addons-store';

/**
 * A field for an addon's manifest URL and its Install button: fetches,
 * validates and installs through the addons store, and says how it went.
 * The label and hint are the caller's (`inputId`, `hintId`).
 */
export function AddonUrlForm({
  inputId,
  hintId,
  disabled = false,
  submitLabel = 'Install',
  onInstalled,
}: {
  inputId: string;
  hintId: string;
  disabled?: boolean;
  submitLabel?: string;
  onInstalled?: (addon: InstalledAddon) => void;
}) {
  const install = useAddonsStore((state) => state.install);
  const [url, setUrl] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installed, setInstalled] = useState<string | null>(null);
  const errorId = useId();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setInstalled(null);
    const result = await install(url);
    setPending(false);
    if (result.ok) {
      setUrl('');
      setInstalled(result.addon.manifest.name);
      onInstalled?.(result.addon);
    } else {
      setError(result.message);
    }
  }

  return (
    <>
      <form onSubmit={(event) => void onSubmit(event)} className="mt-4 flex gap-2">
        <input
          id={inputId}
          type="text"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          disabled={disabled || pending}
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://example.com/manifest.json"
          aria-describedby={error ? `${hintId} ${errorId}` : hintId}
          aria-invalid={error ? true : undefined}
          className="h-11 min-w-0 flex-1 rounded-full border border-white/10 bg-ink-950/50 px-5 text-sm text-ink-100 placeholder:text-ink-500 focus-visible:border-accent/60 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
        />
        <Button size="lg" type="submit" disabled={disabled || pending || url.trim() === ''}>
          {pending ? (
            <Loader2 aria-hidden className="size-4 animate-spin" />
          ) : (
            <Plus aria-hidden className="size-4" />
          )}
          {pending ? 'Installing…' : submitLabel}
        </Button>
      </form>
      <div aria-live="polite" className="text-[13px]">
        {error && (
          <p id={errorId} className="mt-3 text-rose-300">
            {error}
          </p>
        )}
        {installed && <p className="mt-3 text-ink-300">Installed {installed}.</p>}
      </div>
    </>
  );
}
