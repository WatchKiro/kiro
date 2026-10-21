import { cx } from '@kiro/utils';
import { Delete } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { PIN_DIGITS } from '@/features/profiles/profiles-data';
import { focusWithKeys } from '@/features/remote/remote-navigation';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'delete'] as const;

/**
 * Four-digit PIN entry for a keyboard, a remote or the pointer: digits typed
 * anywhere, or the on-screen keys (arrows and OK). Backspace deletes a digit;
 * with none left, it and Escape cancel. Once four are in, `onComplete`
 * checks them: an error message clears the dots to try again.
 *
 * The PIN is kept only here, while it's typed. Never store or log it.
 */
export function PinPad({
  labelledBy,
  onComplete,
  onCancel,
  className,
}: {
  /** The heading saying what the PIN is for. */
  labelledBy: string;
  /** Resolves with why the PIN was refused, or `null` when it was taken. */
  onComplete: (pin: string) => Promise<string | null>;
  onCancel?: () => void;
  className?: string;
}) {
  const [digits, setDigits] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(0);
  const firstKey = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (firstKey.current) focusWithKeys(firstKey.current);
  }, []);

  const press = useCallback(
    (key: string) => {
      if (busy) return;
      if (key === 'delete') {
        setDigits((current) => current.slice(0, -1));
        return;
      }
      const next = (digits + key).slice(0, PIN_DIGITS);
      setDigits(next);
      setError(null);
      if (next.length < PIN_DIGITS) return;
      setBusy(true);
      void onComplete(next)
        .catch((failure: unknown) => String((failure as Error).message ?? failure))
        .then((problem) => {
          setBusy(false);
          if (problem === null) return;
          setError(problem);
          setDigits('');
          setShake((count) => count + 1);
        });
    },
    [busy, digits, onComplete],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (/^[0-9]$/.test(event.key)) press(event.key);
      else if (event.key === 'Backspace' && digits) press('delete');
      else if ((event.key === 'Backspace' || event.key === 'Escape') && onCancel) onCancel();
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    // Capture: before a dialog around it closes on Escape.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [press, digits, onCancel]);

  return (
    <div className={cx('flex flex-col items-center', className)}>
      <div
        key={shake}
        role="status"
        aria-label={`${digits.length} of ${PIN_DIGITS} digits entered`}
        className={cx('flex gap-4', shake > 0 && 'animate-[kiro-shake_360ms_ease-in-out]')}
      >
        {Array.from({ length: PIN_DIGITS }, (_, index) => (
          <span
            key={index}
            className={cx(
              'size-3.5 rounded-full border transition-colors duration-150',
              index < digits.length
                ? 'border-accent-strong bg-accent-strong shadow-[0_0_14px_rgb(166_123_255/0.6)]'
                : 'border-white/25 bg-transparent',
            )}
          />
        ))}
      </div>
      <p role="alert" className="mt-4 h-5 text-sm text-red-300">
        {error}
      </p>
      <div
        role="group"
        aria-labelledby={labelledBy}
        data-nav-group
        className="mt-3 grid grid-cols-3 gap-3"
      >
        {KEYS.map((key) =>
          key === '' ? (
            <span key="blank" />
          ) : (
            <button
              key={key}
              ref={key === '1' ? firstKey : undefined}
              type="button"
              disabled={busy}
              aria-label={key === 'delete' ? 'Delete a digit' : key}
              onClick={() => press(key)}
              className={cx(
                'flex size-16 cursor-pointer items-center justify-center rounded-full text-2xl font-medium text-ink-50 tabular-nums transition-colors duration-150',
                'border border-white/[0.08] bg-white/[0.04] hover:bg-white/[0.1] active:bg-white/[0.16]',
                'focus-visible:focus-ring disabled:cursor-wait',
                key === 'delete' && 'border-transparent bg-transparent text-ink-300',
              )}
            >
              {key === 'delete' ? <Delete aria-hidden className="size-6" /> : key}
            </button>
          ),
        )}
      </div>
    </div>
  );
}
