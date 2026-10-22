/**
 * The building blocks of the Settings page: a section, the groups in it, a
 * labelled row with its hint and reset, and the controls that go in a row.
 */
import { cx } from '@kiro/utils';
import { ChevronRight, RotateCcw } from 'lucide-react';
import {
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { settingElementId } from '@/features/settings/settings-sections';

/**
 * One section of Settings, shown on its own (`/settings/playback`): its
 * heading, a line about it and a reset for the whole section, then its
 * {@link Group}s.
 */
export function Section({
  title,
  description,
  onReset,
  resetLabel = 'Reset to defaults',
  resetDisabled,
  children,
}: {
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
    <section aria-labelledby={headingId}>
      <div className="mb-6 flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <h2 id={headingId} className="text-xl font-semibold tracking-[-0.01em] text-ink-50">
            {title}
          </h2>
          {description && (
            <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-ink-400">{description}</p>
          )}
        </div>
        {onReset && (
          <button
            type="button"
            onClick={onReset}
            disabled={resetDisabled}
            // Coming into the section, focus starts on its first setting.
            data-nav-forget
            className="mt-0.5 flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-white/10 px-3 py-1.5 text-xs font-medium text-ink-200 transition-colors hover:bg-white/[0.06] hover:text-ink-50 focus-visible:focus-ring disabled:cursor-not-allowed disabled:border-transparent disabled:text-ink-500 disabled:hover:bg-transparent"
          >
            <RotateCcw aria-hidden className="size-3.5" />
            {resetLabel}
          </button>
        )}
      </div>
      <div className="space-y-8">{children}</div>
    </section>
  );
}

/**
 * Settings that belong together within a section, under a small heading, in
 * one card. Rows are divided by hairlines.
 */
export function Group({
  title,
  description,
  aside,
  children,
}: {
  title: string;
  /** A line under the heading, about all of the group. */
  description?: ReactNode;
  /** Beside the heading, e.g. a link to a related page. */
  aside?: ReactNode;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId}>
      <div className="mb-2 flex items-end gap-4 px-1">
        <div className="min-w-0 flex-1">
          <h3
            id={headingId}
            className="text-xs font-semibold tracking-[0.08em] text-ink-400 uppercase"
          >
            {title}
          </h3>
          {description && <p className="mt-1 text-xs text-ink-500">{description}</p>}
        </div>
        {aside}
      </div>
      <div className="divide-y divide-white/[0.05] overflow-hidden rounded-card border border-white/[0.07] bg-white/[0.025]">
        {children}
      </div>
    </section>
  );
}

/**
 * Less-used settings in a group, folded away until asked for. Open from the
 * start when one of them has been changed, so nothing set is out of sight;
 * a link to a setting inside opens it (see `useSettingAnchor`).
 */
export function Disclosure({
  label,
  summary,
  defaultOpen,
  children,
}: {
  label: string;
  /** What's inside, shown beside the label, e.g. `File size, codecs, keywords`. */
  summary?: string;
  defaultOpen: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className="group">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-3.5 text-sm font-medium text-ink-200 transition-colors hover:bg-white/[0.03] hover:text-ink-50 focus-visible:focus-ring focus-visible:-outline-offset-2 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden
          className="size-4 text-ink-400 transition-transform group-open:rotate-90"
        />
        {label}
        {summary && !open && (
          <span className="truncate text-xs font-normal text-ink-500">{summary}</span>
        )}
      </summary>
      <div className="divide-y divide-white/[0.05] border-t border-white/[0.05]">{children}</div>
    </details>
  );
}

/**
 * A setting: its label and hint on the left, the control on the right (or
 * below, `stacked`, for lists and wide controls), and, once changed from the
 * default, a button that puts it back.
 */
export function SettingRow({
  id,
  label,
  hint,
  labelId,
  disabled,
  stacked,
  onReset,
  children,
}: {
  /** Its anchor, for links and search (`/settings/playback#resume`). */
  id?: string;
  label: string;
  hint: ReactNode;
  /** Labels the control (`aria-labelledby`). */
  labelId: string;
  disabled?: boolean;
  /** The control goes under the label, full width. */
  stacked?: boolean;
  /** Present while the value differs from its default. */
  onReset?: (() => void) | undefined;
  children: ReactNode;
}) {
  const hintId = `${labelId}-hint`;
  return (
    <div
      id={id === undefined ? undefined : settingElementId(id)}
      role="group"
      aria-labelledby={labelId}
      aria-describedby={hintId}
      className={cx(
        'flex scroll-mt-28 gap-x-8 gap-y-3 px-5 py-4 transition-colors duration-700 data-highlight:bg-accent/[0.12] data-highlight:duration-150',
        stacked ? 'flex-col' : 'flex-wrap items-center',
      )}
    >
      <div className={cx('min-w-0', !stacked && 'flex-1 basis-64', disabled && 'opacity-60')}>
        <div className="flex min-h-5 items-start gap-1">
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
              className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full text-ink-500 transition-colors hover:bg-white/10 hover:text-ink-50 focus-visible:focus-ring disabled:cursor-not-allowed"
            >
              <RotateCcw aria-hidden className="size-3" />
            </button>
          )}
        </div>
        <p id={hintId} className="mt-0.5 max-w-prose text-xs leading-relaxed text-ink-400">
          {hint}
        </p>
      </div>
      <div
        data-setting-control
        className={cx(
          'flex min-w-0 items-center',
          stacked ? 'w-full' : 'ml-auto shrink-0 justify-end',
          disabled && 'opacity-60',
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function ToggleSetting({
  id,
  label,
  hint,
  checked,
  disabled,
  onChange,
  onReset,
}: {
  id?: string;
  label: string;
  hint: ReactNode;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
  onReset?: (() => void) | undefined;
}) {
  const labelId = useId();
  return (
    <SettingRow
      id={id}
      label={label}
      hint={hint}
      labelId={labelId}
      disabled={disabled}
      onReset={onReset}
    >
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
    <div className="flex w-72 max-w-full items-center gap-3">
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
