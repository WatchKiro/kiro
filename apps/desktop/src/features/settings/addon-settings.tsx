import { cx } from '@kiro/utils';
import { ArrowDown, ArrowUp, GripVertical } from 'lucide-react';
import { useEffect, useState, type DragEvent } from 'react';
import { Link } from 'react-router';

import { AddonLogo } from '@/features/addons/addons-page';
import { useAddonsStore, type ManagedAddon } from '@/features/addons/addons-store';
import { SetupAgain } from '@/features/onboarding/setup-again';
import { ChipButton, Section, Switch } from '@/features/settings/settings-controls';
import { describeError } from '@/services/native';

/**
 * Installed addons in priority order, each with a switch. Reorder by
 * dragging or with the arrow buttons; disabled addons stay installed (and in
 * place) but aren't asked for anything. Both are saved by the core.
 */
export function AddonsSection() {
  const status = useAddonsStore((state) => state.status);
  const installed = useAddonsStore((state) => state.installed);
  const load = useAddonsStore((state) => state.load);
  const setEnabled = useAddonsStore((state) => state.setEnabled);
  const move = useAddonsStore((state) => state.move);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Read out after a move, for screen readers. */
  const [announcement, setAnnouncement] = useState('');
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  useEffect(() => void load(), [load]);

  const run = (action: Promise<void>, message?: string) => {
    setBusy(true);
    setError(null);
    action
      .then(() => message && setAnnouncement(message))
      .catch((reason: unknown) => setError(describeError(reason)))
      .finally(() => setBusy(false));
  };
  const moveTo = (addon: ManagedAddon, index: number) =>
    run(
      move(addon.transportUrl, index),
      `${addon.manifest.name} moved to position ${index + 1} of ${installed.length}.`,
    );
  const disabledCount = installed.filter((addon) => !addon.enabled).length;

  const onDrop = (event: DragEvent, index: number) => {
    event.preventDefault();
    const addon = installed.find((candidate) => candidate.transportUrl === dragging);
    setDragging(null);
    setDropIndex(null);
    if (!addon) return;
    const from = installed.indexOf(addon);
    // Dropping below itself means one place less once it's taken out.
    const to = index > from ? index - 1 : index;
    if (to !== from) moveTo(addon, to);
  };

  return (
    <Section
      id="addons"
      title="Addons"
      description="The first addon wins when two streams are otherwise equal, and lists come in this order. Turned-off addons stay installed but aren’t asked for anything."
      onReset={() =>
        run(
          Promise.all(
            installed
              .filter((addon) => !addon.enabled)
              .map((addon) => setEnabled(addon.transportUrl, true)),
          ).then(() => undefined),
          'All addons turned on.',
        )
      }
      resetLabel="Turn all on"
      resetDisabled={busy || disabledCount === 0}
    >
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {status === 'error' ? (
        <p className="px-5 py-4 text-sm text-ink-400">Installed addons could not be loaded.</p>
      ) : status !== 'ready' ? (
        <p className="px-5 py-4 text-sm text-ink-400">Loading…</p>
      ) : installed.length === 0 ? (
        <p className="px-5 py-4 text-sm text-ink-400">
          No addons installed yet.{' '}
          <Link to="/addons" className="text-accent-strong hover:underline">
            Install one
          </Link>
          .
        </p>
      ) : (
        <ol aria-label="Addons, in priority order" className="divide-y divide-white/[0.05]">
          {installed.map((addon, index) => (
            <li
              key={addon.transportUrl}
              draggable={!busy}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', addon.transportUrl);
                setDragging(addon.transportUrl);
              }}
              onDragEnd={() => {
                setDragging(null);
                setDropIndex(null);
              }}
              onDragOver={(event) => {
                if (dragging === null) return;
                event.preventDefault();
                const box = event.currentTarget.getBoundingClientRect();
                setDropIndex(event.clientY < box.top + box.height / 2 ? index : index + 1);
              }}
              onDrop={(event) => onDrop(event, dropIndex ?? index)}
              className={cx(
                'relative flex items-center gap-3 px-5 py-3 transition-colors',
                dragging === addon.transportUrl && 'opacity-40',
                dropIndex === index && 'shadow-[inset_0_2px_0_var(--color-accent)]',
                dropIndex === index + 1 &&
                  index === installed.length - 1 &&
                  'shadow-[inset_0_-2px_0_var(--color-accent)]',
              )}
            >
              <GripVertical
                aria-hidden
                className="size-4 shrink-0 cursor-grab text-ink-500 active:cursor-grabbing"
              />
              <span className="w-5 text-right text-xs text-ink-500 tabular-nums">{index + 1}</span>
              <div className={cx('scale-75', !addon.enabled && 'opacity-50 grayscale')}>
                <AddonLogo src={addon.manifest.logo} />
              </div>
              <div className={cx('min-w-0 flex-1', !addon.enabled && 'opacity-60')}>
                <p className="truncate text-sm font-medium text-ink-50">{addon.manifest.name}</p>
                <p className="truncate text-xs text-ink-500">{provides(addon)}</p>
              </div>
              <ChipButton
                label={`Move ${addon.manifest.name} up`}
                disabled={busy || index === 0}
                onClick={() => moveTo(addon, index - 1)}
              >
                <ArrowUp aria-hidden className="size-3.5" />
              </ChipButton>
              <ChipButton
                label={`Move ${addon.manifest.name} down`}
                disabled={busy || index === installed.length - 1}
                onClick={() => moveTo(addon, index + 1)}
              >
                <ArrowDown aria-hidden className="size-3.5" />
              </ChipButton>
              <span className="ml-2">
                <Switch
                  label={`Use ${addon.manifest.name}`}
                  checked={addon.enabled}
                  disabled={busy}
                  onChange={(enabled) =>
                    run(
                      setEnabled(addon.transportUrl, enabled),
                      `${addon.manifest.name} turned ${enabled ? 'on' : 'off'}.`,
                    )
                  }
                />
              </span>
            </li>
          ))}
        </ol>
      )}
      {error && (
        <p role="alert" className="border-t border-white/[0.06] px-5 py-3 text-sm text-red-300">
          Couldn’t save that change. {error}
        </p>
      )}
      <SetupAgain />
    </Section>
  );
}

const RESOURCE_LABELS: Record<string, string> = {
  addon_catalog: 'Addon catalogue',
  catalog: 'Catalogues',
  meta: 'Details',
  stream: 'Streams',
  subtitles: 'Subtitles',
};

/** What an addon provides, e.g. `Catalogues · Details`. */
function provides({ manifest }: ManagedAddon) {
  const names = manifest.resources.map((resource) =>
    typeof resource === 'string' ? resource : resource.name,
  );
  return [...new Set(names.map((name) => RESOURCE_LABELS[name] ?? name))].join(' · ');
}
