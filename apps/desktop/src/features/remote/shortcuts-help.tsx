import { cx } from '@kiro/utils';
import { Keyboard, X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { focusWithKeys } from '@/features/remote/remote-navigation';
import { useShortcutsHelpStore } from '@/features/remote/shortcuts-store';
import { usesCommandKey } from '@/lib/platform';

interface Shortcut {
  keys: string[];
  action: string;
}

function everywhere(): Shortcut[] {
  return [
    { keys: ['↑', '↓', '←', '→'], action: 'Move between items' },
    { keys: ['Enter', 'Space'], action: 'Open or press' },
    { keys: ['Esc', '⌫'], action: 'Go back' },
    { keys: [usesCommandKey() ? '⌘K' : 'Ctrl K'], action: 'Search' },
    { keys: ['?'], action: 'Show these shortcuts' },
  ];
}

const PLAYER: Shortcut[] = [
  { keys: ['Space'], action: 'Play or pause' },
  { keys: ['←', '→'], action: 'Skip back or forward' },
  { keys: ['↑', '↓'], action: 'Reach the controls (then ← → move)' },
  { keys: ['M'], action: 'Mute' },
  { keys: ['F'], action: 'Full screen' },
  { keys: ['H'], action: 'Hide or show the controls' },
  { keys: ['S'], action: 'Skip the intro or credits' },
  { keys: ['Z', 'X'], action: 'Subtitles 0.1 s earlier or later' },
  { keys: ['J', 'K'], action: 'Audio 0.1 s earlier or later' },
  { keys: ['[', ']'], action: 'Slower or faster' },
  { keys: ['Esc'], action: 'Leave full screen, or go back' },
  { keys: ['⏯', '⏭', '⏮'], action: 'Media keys: play, next episode, start over' },
];

/**
 * The keyboard shortcuts, over whatever is showing. `?` opens and closes it;
 * Escape, Backspace or a click outside closes it. While open, keys don't
 * reach the page behind (the player's Space, for one).
 */
export function ShortcutsHelp() {
  const open = useShortcutsHelpStore((state) => state.open);
  const setOpen = useShortcutsHelpStore((state) => state.setOpen);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const returnTo = document.activeElement;
    // A modal: the app behind can't be reached with Tab, a reader or arrows.
    const app = document.getElementById('root');
    app?.setAttribute('inert', '');
    if (closeRef.current) focusWithKeys(closeRef.current);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Backspace') {
        event.preventDefault();
        setOpen(false);
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
  }, [open, setOpen]);

  if (!open) return null;
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex animate-[kiro-fade-in_150ms_ease-out] items-center justify-center bg-ink-950/70 p-6 backdrop-blur-sm"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-nav-layer
        className="w-full max-w-3xl overflow-hidden rounded-2xl border border-white/10 bg-ink-900/95 shadow-2xl shadow-black/60"
      >
        <div className="flex items-center gap-3 border-b border-white/[0.08] px-6 py-4">
          <Keyboard aria-hidden className="size-5 text-accent-strong" />
          <h2 id={titleId} className="flex-1 text-base font-semibold text-ink-50">
            Keyboard shortcuts
          </h2>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close"
            onClick={() => setOpen(false)}
            className="flex size-9 cursor-pointer items-center justify-center rounded-full text-ink-300 transition-colors hover:bg-white/[0.08] hover:text-ink-50 focus-visible:focus-ring"
          >
            <X aria-hidden className="size-4.5" />
          </button>
        </div>
        <div className="grid gap-x-10 gap-y-6 px-6 py-5 sm:grid-cols-2">
          <ShortcutList title="Everywhere" shortcuts={everywhere()} />
          <ShortcutList title="Player" shortcuts={PLAYER} />
        </div>
        <p className="border-t border-white/[0.08] px-6 py-3.5 text-xs leading-relaxed text-ink-400">
          A remote control works the same way: arrows to move, OK to press and Back to go back.
        </p>
      </div>
    </div>,
    document.body,
  );
}

function ShortcutList({ title, shortcuts }: { title: string; shortcuts: Shortcut[] }) {
  return (
    <section>
      <h3 className="mb-2.5 text-xs font-semibold tracking-[0.08em] text-ink-400 uppercase">
        {title}
      </h3>
      <dl className="space-y-2">
        {shortcuts.map(({ keys, action }) => (
          <div key={action} className="flex items-center justify-between gap-4 text-sm">
            <dt className="text-ink-200">{action}</dt>
            <dd className="flex shrink-0 gap-1">
              {keys.map((key) => (
                <Key key={key}>{key}</Key>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Key({ children }: { children: ReactNode }) {
  return (
    <kbd
      className={cx(
        'inline-flex h-6 min-w-6 items-center justify-center rounded-md border border-white/12 bg-white/[0.06] px-1.5 font-sans text-xs font-medium text-ink-100',
        'shadow-[inset_0_-1px_0_rgb(255_255_255/0.08)]',
      )}
    >
      {children}
    </kbd>
  );
}
