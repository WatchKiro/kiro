/**
 * The building blocks of the Settings page: a section card, a labelled row
 * with its hint and reset, and the controls that go in a row.
 */
import { cx } from '@kiro/utils';
import { RotateCcw } from 'lucide-react';
import { useId, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';

export function Section({
  id,
  title,
  description,
  onReset,
  resetLabel = 'Reset to defaults',
  resetDisabled,
  children,
}: {
  /** The anchor other pages link to, e.g. `/settings#streams`. */
  id?: string;
  title: string;
  description?: string;
  /** Puts the whole section back to its defaults. */
  onReset?: () => void;
  resetLabel?: string;
  /** Nothing to reset, or not ready. */
  resetDisabled?: boolean;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className="scroll-mt-24 overflow-hidden rounded-card border border-white/[0.07] bg-white/[0.025]"
    >
      <div className="flex items-start gap-4 border-b border-white/[0.06] px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 id={headingId} className="text-[15px] font-semibold text-ink-50">
            {title}
          </h2>
          {description && <p className="mt-0.5 text-[13px] text-ink-400">{description}</p>}
        </div>
        {onReset && (
          <button
            type="button"
            onClick={onReset}
            disabled={resetDisabled}
            className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium text-ink-300 transition-colors hover:bg-white/[0.06] hover:text-ink-50 focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <RotateCcw aria-hidden className="size-3.5" />
            {resetLabel}
          </button>
        )}
      </div>
      {children}
    </section>
  );
}

/**
 * A setting: its label and hint on the left, the control on the right, and,
 * once changed from the default, a button that puts it back.
 */
export function SettingRow({
  label,
  hint,
  labelId,
  disabled,
  onReset,
  children,
}: {
  label: string;
  hint: ReactNode;
  /** Labels the control (`aria-labelledby`). */
  labelId: string;
  disabled?: boolean;
  /** Present while the value differs from its default. */
  onReset?: (() => void) | undefined;
  children: ReactNode;
}) {
  const hintId = `${labelId}-hint`;
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      aria-describedby={hintId}
      className={cx('flex flex-wrap gap-x-8 gap-y-3 px-5 py-4', disabled && 'opacity-60')}
    >
      <div className="w-56 shrink-0">
        <div className="flex h-5 items-center gap-1">
          <p id={labelId} className="text-sm font-medium text-ink-100">
            {label}
          </p>
          {onReset && (
            <button
              type="button"
              onClick={onReset}
              disabled={disabled}
              aria-label={`Reset ${label.toLowerCase()} to its default`}
              title="Reset to default"
              className="flex size-5 cursor-pointer items-center justify-center rounded-full text-ink-500 transition-colors hover:bg-white/10 hover:text-ink-50 focus-visible:focus-ring disabled:cursor-not-allowed"
            >
              <RotateCcw aria-hidden className="size-3" />
            </button>
          )}
        </div>
        <p id={hintId} className="mt-0.5 text-xs leading-relaxed text-ink-400">
          {hint}
        </p>
      </div>
      <div className="flex min-w-60 flex-1 items-center">{children}</div>
    </div>
  );
}

export function ToggleSetting({
  label,
  hint,
  checked,
  disabled,
  onChange,
  onReset,
}: {
  label: string;
  hint: ReactNode;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
  onReset?: (() => void) | undefined;
}) {
  const labelId = useId();
  return (
    <SettingRow label={label} hint={hint} labelId={labelId} disabled={disabled} onReset={onReset}>
      <Switch labelledBy={labelId} checked={checked} disabled={disabled} onChange={onChange} />
    </SettingRow>
  );
}

export function Switch({
  labelledBy,
  label,
  checked,
  disabled,
  onChange,
}: {
  labelledBy?: string;
  label?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors focus-visible:focus-ring disabled:cursor-not-allowed',
        checked ? 'bg-accent' : 'bg-white/15',
      )}
    >
      <span
        className={cx(
          'size-5 rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-5.5' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

/**
 * One choice of a few, as a row of pills: a radio group with arrow-key
 * navigation and a single tab stop.
 */
export function Segmented<T extends string | number>({
  labelledBy,
  options,
  value,
  disabled,
  onChange,
}: {
  labelledBy: string;
  options: readonly { value: T; label: string }[];
  value: T;
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = Math.max(
    options.findIndex((option) => option.value === value),
    0,
  );

  const onKeyDown = (event: KeyboardEvent) => {
    // Up and Down already moved focus on (the app's keyboard navigation).
    if (event.defaultPrevented) return;
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    const target =
      step !== undefined
        ? (selected + step + options.length) % options.length
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? options.length - 1
            : undefined;
    const option = target === undefined ? undefined : options[target];
    if (target === undefined || !option) return;
    event.preventDefault();
    buttons.current[target]?.focus();
    onChange(option.value);
  };

  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      // Left and Right change the choice (roving focus); Up and Down move on.
      data-nav-own="sideways"
      onKeyDown={onKeyDown}
      className="inline-flex flex-wrap gap-1 rounded-full bg-white/[0.05] p-1"
    >
      {options.map((option, index) => (
        <button
          key={option.value}
          ref={(button) => {
            buttons.current[index] = button;
          }}
          type="button"
          role="radio"
          aria-checked={index === selected}
          tabIndex={index === selected ? 0 : -1}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={cx(
            'cursor-pointer rounded-full px-3 py-1 text-xs font-medium transition-colors focus-visible:focus-ring disabled:cursor-not-allowed',
            index === selected ? 'bg-accent text-white' : 'text-ink-300 hover:text-ink-50',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** A slider with its value shown beside it. */
export function Slider({
  labelledBy,
  min,
  max,
  step,
  value,
  disabled,
  format,
  onChange,
}: {
  labelledBy: string;
  min: number;
  max: number;
  step: number;
  value: number;
  disabled?: boolean;
  /** The value as shown and announced, e.g. `90%`. */
  format: (value: number) => string;
  onChange: (value: number) => void;
}) {
  const fill = ((value - min) / (max - min)) * 100;
  return (
    <div className="flex w-full max-w-80 items-center gap-3">
      <input
        type="range"
        aria-labelledby={labelledBy}
        aria-valuetext={format(value)}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        style={{ '--fill': `${fill}%` } as CSSProperties}
        className="kiro-range kiro-range-thumb flex-1"
      />
      <output aria-hidden className="w-12 text-right text-sm text-ink-100 tabular-nums">
        {format(value)}
      </output>
    </div>
  );
}

export function ChipButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-6 cursor-pointer items-center justify-center rounded-full text-ink-400 transition-colors hover:bg-white/10 hover:text-ink-50 focus-visible:focus-ring disabled:cursor-not-allowed"
    >
      {children}
    </button>
  );
}
