import { cx } from '@kiro/utils';
import { useEffect, useRef, useState } from 'react';

import { keyAction } from '@/features/remote/keys';
import { focusWithKeys } from '@/features/remote/remote-navigation';
import { useToastStore, type Toast } from '@/stores/toast-store';

/** How long a notice shows (while not hovered or focused). */
const SHOW_MS = 6_000;
const ERROR_SHOW_MS = 9_000;

/**
 * The notice from `showToast`, at the bottom of the window. It closes by
 * itself after a few seconds, but not while the pointer is over it or focus
 * is in it; Back closes it from its button.
 */
export function Toaster() {
  const toast = useToastStore((state) => state.toast);
  return toast ? <ToastNotice key={toast.id} toast={toast} /> : null;
}

function ToastNotice({ toast }: { toast: Toast }) {
  const dismiss = useToastStore((state) => state.dismiss);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);

  const close = () => {
    if (root.current?.contains(document.activeElement)) {
      const next = toast.returnFocus?.();
      if (next?.isConnected) focusWithKeys(next);
      else (document.activeElement as HTMLElement | null)?.blur();
    }
    dismiss(toast.id);
  };

  useEffect(() => {
    if (toast.focus && button.current) focusWithKeys(button.current);
  }, [toast.focus]);

  useEffect(() => {
    if (hovered || focused) return;
    const timer = window.setTimeout(close, toast.error ? ERROR_SHOW_MS : SHOW_MS);
    return () => window.clearTimeout(timer);
    // `close` reads refs and the toast, which are stable for this notice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hovered, focused]);

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-6">
      <div
        ref={root}
        role={toast.error ? 'alert' : 'status'}
        data-nav-own="back"
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
        }}
        onKeyDown={(event) => {
          if (event.defaultPrevented || keyAction(event)?.kind !== 'back') return;
          event.preventDefault();
          close();
        }}
        className={cx(
          'pointer-events-auto flex max-w-xl animate-[kiro-rise_180ms_ease-out] items-center gap-4 rounded-2xl border bg-ink-900/95 py-2.5 pr-2.5 pl-5 text-sm shadow-2xl shadow-black/60 backdrop-blur-xl',
          toast.error ? 'border-rose-400/30 text-rose-200' : 'border-white/10 text-ink-100',
          !toast.action && 'pr-5',
        )}
      >
        <p className="min-w-0 flex-1 py-1">{toast.message}</p>
        {toast.action && (
          <button
            ref={button}
            type="button"
            onClick={() => {
              void toast.action?.run();
              close();
            }}
            className="h-8 shrink-0 cursor-pointer rounded-full px-3.5 text-sm font-semibold text-accent-strong transition-colors hover:bg-white/[0.06] hover:text-ink-50 focus-visible:focus-ring"
          >
            {toast.action.label}
          </button>
        )}
      </div>
    </div>
  );
}
