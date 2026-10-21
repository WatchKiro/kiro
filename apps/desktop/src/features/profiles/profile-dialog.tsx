import { cx } from '@kiro/utils';
import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { isTextField } from '@/features/remote/keys';
import { focusWithKeys, startOfLayer } from '@/features/remote/remote-navigation';

/**
 * A modal over the app for managing profiles. Arrows stay inside it;
 * Escape, Back (Backspace outside a text field) or a click outside closes
 * it, and focus returns to what opened it.
 */
export function ProfileDialog({
  title,
  description,
  onClose,
  className,
  children,
}: {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  className?: string;
  children: (ids: { titleId: string }) => ReactNode;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const returnTo = document.activeElement;
    const app = document.getElementById('root');
    app?.setAttribute('inert', '');
    // Its first item, or its `data-nav-start`, unless a field took focus.
    const dialog = dialogRef.current;
    const start = dialog && !dialog.contains(document.activeElement) && startOfLayer(dialog);
    if (start) focusWithKeys(start);
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const field = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (event.key === 'Escape' || (event.key === 'Backspace' && !isTextField(field))) {
        event.preventDefault();
        close.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      app?.removeAttribute('inert');
      if (returnTo instanceof HTMLElement && returnTo.isConnected) {
        returnTo.focus({ preventScroll: true });
      }
    };
  }, []);

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
        className={cx(
          'max-h-full w-full max-w-md overflow-y-auto rounded-2xl border border-white/10 bg-ink-900/95 shadow-2xl shadow-black/60',
          className,
        )}
      >
        <div className="flex items-start gap-3 px-6 pt-5">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-base font-semibold text-ink-50">
              {title}
            </h2>
            {description && (
              <p className="mt-1 text-[13px] leading-relaxed text-ink-400">{description}</p>
            )}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="-mt-1 -mr-2 flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-ink-300 transition-colors hover:bg-white/[0.08] hover:text-ink-50 focus-visible:focus-ring"
          >
            <X aria-hidden className="size-4.5" />
          </button>
        </div>
        {children({ titleId })}
      </div>
    </div>,
    document.body,
  );
}
