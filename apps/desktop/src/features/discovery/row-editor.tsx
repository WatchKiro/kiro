import { Button, buttonVariants } from '@kiro/ui';
import { cx } from '@kiro/utils';
import { ArrowDown, ArrowUp, EyeOff, GripVertical, RotateCcw, Rows3, X } from 'lucide-react';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import { AddonLogo } from '@/features/addons/addons-page';
import type { InstalledAddon } from '@/features/addons/addons-store';
import { moveRow, setHidden, type LaidOutRow } from '@/features/discovery/row-layout';
import type { RowLayout } from '@/features/discovery/use-row-layout';
import { focusWithKeys } from '@/features/remote/remote-navigation';
import { Switch } from '@/features/settings/settings-controls';
import { useSettingsStore } from '@/features/settings/settings-store';

interface RowEditorProps {
  /** The page's name: "Discover", "Movies". */
  pageTitle: string;
  layout: RowLayout;
  /** A row's name in the editor, as its heading reads on the page. */
  label: (row: LaidOutRow) => string;
  onClose: () => void;
}

/** Where focus goes once a change has rendered: a control of a row. */
interface FocusTarget {
  key: string;
  control: 'up' | 'down' | 'hide' | 'switch';
}

/**
 * Chooses and arranges a page's catalogue rows: the shown rows in order
 * (drag, or the arrow buttons), and every catalogue by addon with a switch.
 * Changes are saved as they're made. A modal like the shortcuts overlay:
 * the page behind is inert, arrows stay inside, Escape or Back closes it.
 */
export function RowEditor({ pageTitle, layout, label, onClose }: RowEditorProps) {
  const { rows, entries, customised, save, reset } = layout;
  const error = useSettingsStore((state) => state.error);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [announcement, setAnnouncement] = useState('');
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const focusNext = useRef<FocusTarget | null>(null);
  // The page passes a new function each render; opening runs once.
  const closeRequested = useRef(onClose);
  useLayoutEffect(() => {
    closeRequested.current = onClose;
  });

  const shown = useMemo(() => rows.filter((row) => !row.hidden), [rows]);
  const shownKeys = useMemo(() => shown.map((row) => row.key), [shown]);
  const groups = useMemo(() => byAddon(rows), [rows]);

  useEffect(() => {
    const returnTo = document.activeElement;
    const app = document.getElementById('root');
    app?.setAttribute('inert', '');
    if (closeRef.current) focusWithKeys(closeRef.current);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || (event.key === 'Backspace' && !event.defaultPrevented)) {
        event.preventDefault();
        closeRequested.current();
      }
      event.stopPropagation();
    };
    // Capture, after the app's navigation (which stays inside this layer).
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      app?.removeAttribute('inert');
      if (returnTo instanceof HTMLElement && returnTo.isConnected) {
        returnTo.focus({ preventScroll: true });
      }
    };
  }, []);

  // A moved row's node may be re-inserted, and a hidden one leaves the list,
  // either of which drops focus: put it back where the keys expect it.
  useLayoutEffect(() => {
    const target = focusNext.current;
    focusNext.current = null;
    if (!target) return;
    const control = dialogRef.current?.querySelector(
      `[data-row-key="${CSS.escape(target.key)}"] [data-row-control="${target.control}"]`,
    );
    const element = control?.matches('button') ? control : control?.querySelector('button');
    if (element instanceof HTMLElement && element !== document.activeElement) {
      focusWithKeys(element);
    }
  });

  const moveTo = (row: LaidOutRow, to: number, control?: FocusTarget['control']) => {
    if (to < 0 || to >= shown.length || shownKeys[to] === row.key) return;
    if (control) focusNext.current = { key: row.key, control };
    save(moveRow(entries, shownKeys, row.key, to));
    setAnnouncement(`${label(row)} moved to position ${to + 1} of ${shown.length}.`);
  };

  const hide = (row: LaidOutRow, from: 'list' | 'switch') => {
    if (from === 'list') {
      // Focus the next row's Hide button, or the previous one's, or the
      // catalogue's switch when this was the last shown row.
      const index = shownKeys.indexOf(row.key);
      const neighbour = shownKeys[index + 1] ?? shownKeys[index - 1];
      focusNext.current = neighbour
        ? { key: neighbour, control: 'hide' }
        : { key: row.key, control: 'switch' };
    }
    save(setHidden(entries, row.key, true));
    setAnnouncement(`${label(row)} hidden.`);
  };

  const show = (row: LaidOutRow) => {
    save(setHidden(entries, row.key, false));
    setAnnouncement(`${label(row)} shown.`);
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    const row = shown.find((candidate) => candidate.key === dragging);
    const index = dropIndex;
    setDragging(null);
    setDropIndex(null);
    if (!row || index === null) return;
    const from = shownKeys.indexOf(row.key);
    // Dropping below itself means one place less once it's taken out.
    moveTo(row, index > from ? index - 1 : index);
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex animate-[kiro-fade-in_150ms_ease-out] items-center justify-center bg-ink-950/70 p-6 backdrop-blur-sm"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-nav-layer
        className="flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-ink-900/95 shadow-2xl shadow-black/60"
      >
        <div className="flex items-start gap-3 border-b border-white/[0.08] px-6 py-4">
          <Rows3 aria-hidden className="mt-0.5 size-5 text-accent-strong" />
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-base font-semibold text-ink-50">
              Customise {pageTitle}
            </h2>
            <p className="mt-0.5 text-[13px] text-ink-400">
              Choose which catalogues appear as rows and in what order. Changes are saved as you go.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex size-9 cursor-pointer items-center justify-center rounded-full text-ink-300 transition-colors hover:bg-white/[0.08] hover:text-ink-50 focus-visible:focus-ring"
          >
            <X aria-hidden className="size-4.5" />
          </button>
        </div>

        <p aria-live="polite" className="sr-only">
          {announcement}
        </p>

        <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          <Column title={`On ${pageTitle}`} count={`${shown.length} of ${rows.length}`}>
            {shown.length === 0 ? (
              <p className="px-6 py-6 text-sm text-ink-400">
                Every row is hidden. Turn catalogues on to show them here.
              </p>
            ) : (
              <ol
                aria-label={`Rows on ${pageTitle}, in order`}
                data-nav-group
                className="px-3 pb-3"
                onDragOver={(event) => dragging !== null && event.preventDefault()}
                onDrop={onDrop}
              >
                {shown.map((row, index) => (
                  <li
                    key={row.key}
                    data-row-key={row.key}
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setData('text/plain', label(row));
                      setDragging(row.key);
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
                    className={cx(
                      'flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-white/[0.035]',
                      dragging === row.key && 'opacity-40',
                      dropIndex === index && 'shadow-[inset_0_2px_0_var(--color-accent)]',
                      dropIndex === index + 1 &&
                        index === shown.length - 1 &&
                        'shadow-[inset_0_-2px_0_var(--color-accent)]',
                    )}
                  >
                    <GripVertical
                      aria-hidden
                      className="size-4 shrink-0 cursor-grab text-ink-500 active:cursor-grabbing"
                    />
                    <span className="w-5 shrink-0 text-right text-xs text-ink-500 tabular-nums">
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-ink-50">{label(row)}</p>
                      <p className="truncate text-xs text-ink-500">
                        {row.source.addon.manifest.name}
                        {row.isNew && <span className="text-accent-strong"> · New</span>}
                      </p>
                    </div>
                    <RowButton
                      control="up"
                      label={`Move ${label(row)} up`}
                      unavailable={index === 0}
                      onClick={() => moveTo(row, index - 1, 'up')}
                    >
                      <ArrowUp aria-hidden className="size-3.5" />
                    </RowButton>
                    <RowButton
                      control="down"
                      label={`Move ${label(row)} down`}
                      unavailable={index === shown.length - 1}
                      onClick={() => moveTo(row, index + 1, 'down')}
                    >
                      <ArrowDown aria-hidden className="size-3.5" />
                    </RowButton>
                    <RowButton
                      control="hide"
                      label={`Hide ${label(row)}`}
                      onClick={() => hide(row, 'list')}
                    >
                      <EyeOff aria-hidden className="size-3.5" />
                    </RowButton>
                  </li>
                ))}
              </ol>
            )}
          </Column>

          <Column
            title="Catalogues"
            count={`${groups.length} ${groups.length === 1 ? 'addon' : 'addons'}`}
            className="border-t border-white/[0.06] md:border-t-0 md:border-l"
          >
            <div data-nav-group className="space-y-5 px-3 pb-4">
              {groups.map(({ addon, rows: addonRows }) => (
                <section key={addon.transportUrl} aria-label={addon.manifest.name}>
                  <div className="flex items-center gap-3 px-3 py-1.5">
                    <div className="-m-2 scale-[0.6]">
                      <AddonLogo src={addon.manifest.logo} />
                    </div>
                    <h4 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink-100">
                      {addon.manifest.name}
                    </h4>
                    <span className="shrink-0 text-xs text-ink-500 tabular-nums">
                      {addonRows.filter((row) => !row.hidden).length} of {addonRows.length} shown
                    </span>
                  </div>
                  <ul>
                    {addonRows.map((row) => (
                      <li
                        key={row.key}
                        data-row-key={row.key}
                        className="flex items-center gap-3 rounded-xl px-3 py-2 hover:bg-white/[0.035]"
                      >
                        <span
                          className={cx(
                            'min-w-0 flex-1 truncate text-sm',
                            row.hidden ? 'text-ink-400' : 'text-ink-100',
                          )}
                        >
                          {label(row)}
                        </span>
                        <span data-row-control="switch" className="contents">
                          <Switch
                            label={`Show ${label(row)} on ${pageTitle}`}
                            checked={!row.hidden}
                            onChange={(checked) => (checked ? show(row) : hide(row, 'switch'))}
                          />
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </Column>
        </div>

        <div className="flex items-center gap-3 border-t border-white/[0.08] px-6 py-3.5">
          <Button
            variant="ghost"
            size="sm"
            disabled={!customised}
            onClick={() => {
              reset();
              setAnnouncement(`${pageTitle} is back to its default rows.`);
              // Reset turns itself off; keep focus in the dialog.
              if (doneRef.current) focusWithKeys(doneRef.current);
            }}
          >
            <RotateCcw aria-hidden className="size-3.5" />
            Reset to default
          </Button>
          {error && (
            <p role="alert" className="min-w-0 flex-1 truncate text-sm text-red-300">
              Couldn’t save that change. {error}
            </p>
          )}
          <button
            ref={doneRef}
            type="button"
            onClick={onClose}
            className={buttonVariants({ className: 'ml-auto' })}
          >
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Column({
  title,
  count,
  className,
  children,
}: {
  title: string;
  count: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className={cx('flex min-h-0 flex-col', className)}>
      <h3 className="flex items-baseline justify-between px-6 pt-4 pb-2 text-xs font-semibold tracking-[0.08em] text-ink-400 uppercase">
        {title}
        <span className="font-normal tracking-normal normal-case tabular-nums">{count}</span>
      </h3>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
    </section>
  );
}

/**
 * A small icon button. At the end of the list Move up or down does nothing
 * but stays focusable, so pressing it again from a remote doesn't lose focus.
 */
function RowButton({
  control,
  label,
  unavailable,
  onClick,
  children,
}: {
  control: FocusTarget['control'];
  label: string;
  unavailable?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-row-control={control}
      aria-label={label}
      title={label}
      aria-disabled={unavailable || undefined}
      onClick={unavailable ? undefined : onClick}
      className={cx(
        'flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-ink-400 transition-colors hover:bg-white/10 hover:text-ink-50 focus-visible:focus-ring',
        unavailable && 'cursor-default opacity-35 hover:bg-transparent hover:text-ink-400',
      )}
    >
      {children}
    </button>
  );
}

/** Rows grouped by addon, in addon order, each in manifest order. */
function byAddon(rows: LaidOutRow[]): { addon: InstalledAddon; rows: LaidOutRow[] }[] {
  const groups = new Map<string, { addon: InstalledAddon; rows: LaidOutRow[] }>();
  const order = [...rows].sort((a, b) => a.order - b.order);
  for (const row of order) {
    const { addon } = row.source;
    const group = groups.get(addon.transportUrl) ?? { addon, rows: [] };
    group.rows.push(row);
    groups.set(addon.transportUrl, group);
  }
  return [...groups.values()];
}
