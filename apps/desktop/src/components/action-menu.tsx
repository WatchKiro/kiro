import { cx } from '@kiro/utils';
import { Ellipsis, type LucideIcon } from 'lucide-react';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import { keyAction } from '@/features/remote/keys';
import { focusWithKeys, startOfLayer } from '@/features/remote/remote-navigation';
import { describeError } from '@/services/native';
import { showToast } from '@/stores/toast-store';

/** One entry of a menu. */
export interface MenuAction {
  label: string;
  icon: LucideIcon;
  /** Errors (a rejected promise) show as a notice. */
  run: () => unknown;
  /** Asks first, in the menu: the question, and the button that goes ahead. */
  confirm?: { question: string; label: string };
}

/** Where a menu opens, in viewport pixels: its top left (`start`) or top right (`end`) corner. */
interface Anchor {
  x: number;
  y: number;
  align: 'start' | 'end';
}

interface OpenMenu {
  anchor: Anchor;
  /** Opened with the keys: focus starts in it and returns when it closes. */
  keys: boolean;
  returnTo: HTMLElement | null;
}

/** Margin kept between a menu and the window's edges. */
const EDGE = 8;

/**
 * Opens with a right click, a long press, or the Menu key (Shift F10) on
 * whatever is focused inside it: the keyboard navigation sends those as a
 * `contextmenu` event (see features/remote).
 */
function fromContextMenu(event: ReactMouseEvent<HTMLElement>): OpenMenu {
  // A right click is button 2; the keys (and our own event) come as button 0,
  // without Ctrl (a Mac's Ctrl click is a right click too).
  const keys = event.button !== 2 && !event.ctrlKey;
  const active = document.activeElement;
  return {
    anchor: { x: event.clientX, y: event.clientY, align: keys ? 'end' : 'start' },
    keys,
    returnTo:
      active instanceof HTMLElement && event.currentTarget.contains(active)
        ? active
        : event.currentTarget.querySelector<HTMLElement>('a[href], button'),
  };
}

function fromButton(button: HTMLElement, keys: boolean): OpenMenu {
  const rect = button.getBoundingClientRect();
  return { anchor: { x: rect.right, y: rect.bottom + 6, align: 'end' }, keys, returnTo: button };
}

/** Whether `element` has focus from the keys (not a click). */
function keyFocused(element: Element) {
  return element.matches(':focus-visible, [data-nav-focus]');
}

/**
 * A card with a menu of actions, opened from a "⋯" button over its top
 * right corner (shown on hover and focus), a right click, or the Menu key
 * while something in it is focused. The button is passed by with the arrows
 * (a row's Left and Right go card to card); the Menu key reaches the same
 * actions. With no actions there is no menu.
 */
export function CardMenu({
  label,
  actions,
  children,
  className,
  buttonClassName,
}: {
  /** Names the menu, e.g. "Breaking Bad". */
  label: string;
  actions: MenuAction[];
  children: ReactNode;
  className?: string;
  /** Where the button sits, instead of the top right corner. */
  buttonClassName?: string;
}) {
  const [open, setOpen] = useState<OpenMenu | null>(null);

  if (actions.length === 0) return <div className={cx('relative', className)}>{children}</div>;
  return (
    <div
      className={cx('group/menu relative', className)}
      onContextMenu={(event) => {
        event.preventDefault();
        if (!open) setOpen(fromContextMenu(event));
      }}
    >
      {children}
      <button
        type="button"
        data-nav-skip
        aria-haspopup="menu"
        aria-expanded={Boolean(open)}
        aria-label={`More for ${label}`}
        title="More"
        onClick={(event) =>
          setOpen(fromButton(event.currentTarget, keyFocused(event.currentTarget)))
        }
        className={cx(
          'absolute z-10 flex size-8 cursor-pointer items-center justify-center rounded-full bg-black/70 text-ink-100 opacity-0 backdrop-blur transition group-focus-within/menu:opacity-100 group-hover/menu:opacity-100 hover:bg-black/85 hover:text-ink-50 focus-visible:opacity-100 focus-visible:focus-ring',
          open && 'opacity-100',
          buttonClassName ?? 'top-2 right-2',
        )}
      >
        <Ellipsis aria-hidden className="size-4" />
      </button>
      {open && (
        <ActionMenu label={label} actions={actions} {...open} onClose={() => setOpen(null)} />
      )}
    </div>
  );
}

/** A button that opens a menu of actions below it. */
export function MenuButton({
  label,
  actions,
  className,
  children,
}: {
  /** Names the menu and the button. */
  label: string;
  actions: MenuAction[];
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState<OpenMenu | null>(null);

  return (
    <>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={Boolean(open)}
        aria-label={label}
        title={label}
        onClick={(event) =>
          setOpen(open ? null : fromButton(event.currentTarget, keyFocused(event.currentTarget)))
        }
        className={className}
      >
        {children}
      </button>
      {open && actions.length > 0 && (
        <ActionMenu label={label} actions={actions} {...open} onClose={() => setOpen(null)} />
      )}
    </>
  );
}

/**
 * The menu itself, over everything (in a portal, so a scrolling row doesn't
 * clip it). Arrows stay inside it (`data-nav-layer`); Back, a click outside,
 * scrolling or choosing an action closes it.
 */
function ActionMenu({
  label,
  actions,
  anchor,
  keys,
  returnTo,
  onClose,
}: OpenMenu & { label: string; actions: MenuAction[]; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const [asking, setAsking] = useState<MenuAction | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  const close = (refocus = keys) => {
    if (refocus && returnTo?.isConnected) focusWithKeys(returnTo);
    onClose();
  };

  const run = (action: MenuAction) => {
    close();
    Promise.resolve()
      .then(action.run)
      .catch((error: unknown) => showToast({ message: describeError(error), error: true }));
  };

  // Placed beside the anchor, kept inside the window (above it when there's
  // no room below).
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    const left = anchor.align === 'end' ? anchor.x - width : anchor.x;
    const below = anchor.y + height <= window.innerHeight - EDGE;
    setPosition({
      left: Math.min(Math.max(left, EDGE), window.innerWidth - width - EDGE),
      top: Math.max(below ? anchor.y : anchor.y - height, EDGE),
    });
  }, [anchor, asking]);

  // With the keys, focus starts on the first item (on Cancel, after a question).
  useEffect(() => {
    if (keys && panel.current) {
      const start = startOfLayer(panel.current);
      if (start) focusWithKeys(start);
    }
  }, [keys, asking]);

  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node)) close(false);
    };
    // Scrolling the page or row away from where it opened closes it (not the
    // nudge a row gives a card coming into focus).
    const from = returnTo?.getBoundingClientRect();
    const onScroll = () => {
      const now = returnTo?.getBoundingClientRect();
      if (!from || !now || Math.hypot(now.left - from.left, now.top - from.top) > 24) close();
    };
    const onResize = () => close();
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
    // Set up once: `close` only reads what the menu opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const item =
    'flex h-10 w-full cursor-pointer items-center gap-3 rounded-[10px] px-2.5 text-left text-sm text-ink-200 transition-colors hover:bg-white/[0.06] hover:text-ink-50 focus-visible:focus-ring';

  return createPortal(
    <div
      ref={panel}
      role="menu"
      aria-label={label}
      data-nav-layer
      // Its own keys and right clicks don't reach the page behind.
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.defaultPrevented || keyAction(event)?.kind !== 'back') return;
        event.preventDefault();
        if (asking) setAsking(null);
        else close(true);
      }}
      style={position ?? { left: -9999, top: 0 }}
      className="fixed z-50 w-72 animate-[kiro-fade-in_120ms_ease-out] overflow-hidden rounded-2xl border border-white/10 bg-ink-900/95 p-1.5 shadow-2xl shadow-black/60 backdrop-blur-xl"
    >
      {asking?.confirm ? (
        <div className="p-1">
          <p className="px-1.5 pt-1 pb-3 text-sm text-ink-200">{asking.confirm.question}</p>
          <div data-nav-group className="flex justify-end gap-2">
            <button
              type="button"
              role="menuitem"
              data-nav-start
              onClick={() => setAsking(null)}
              className="h-8 cursor-pointer rounded-full px-3 text-sm font-medium text-ink-300 transition-colors hover:bg-white/[0.06] hover:text-ink-50 focus-visible:focus-ring"
            >
              Cancel
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => run(asking)}
              className="h-8 cursor-pointer rounded-full bg-ink-50 px-3.5 text-sm font-medium text-ink-950 transition-colors hover:bg-white focus-visible:focus-ring"
            >
              {asking.confirm.label}
            </button>
          </div>
        </div>
      ) : (
        <ul data-nav-group>
          {actions.map((action) => (
            <li key={action.label}>
              <button
                type="button"
                role="menuitem"
                onClick={() => (action.confirm ? setAsking(action) : run(action))}
                className={item}
              >
                <action.icon aria-hidden className="size-[18px] shrink-0 text-ink-400" />
                <span className="min-w-0 flex-1 truncate">{action.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>,
    document.body,
  );
}
