import { cx } from '@kiro/utils';
import { Gauge, Minus, Plus, RotateCcw } from 'lucide-react';
import type { ReactNode } from 'react';

import { ControlPopover } from '@/features/playback/track-menu';
import {
  SPEED_PRESETS,
  describeDelay,
  formatDelay,
  formatSpeed,
  type DelayKind,
} from '@/features/playback/timing';
import type { PlayerTiming } from '@/features/playback/use-player-timing';

/**
 * The control bar's "Sync & speed" button: subtitle and audio delay in
 * 0.1 s steps, each with a reset, and the speed presets. Z/X, J/K and [/]
 * do the same from anywhere in the player.
 */
export function TimingMenu({
  timing,
  onOpenChange,
}: {
  timing: PlayerTiming;
  onOpenChange?: (open: boolean) => void;
}) {
  const { speed } = timing;
  return (
    <ControlPopover
      label="Sync and speed"
      icon={<Gauge aria-hidden className="size-5.5" />}
      badge={Math.abs(speed - 1) > 1e-6 ? formatSpeed(speed) : undefined}
      onOpenChange={onOpenChange}
      className="w-[23rem] divide-y divide-white/[0.08]"
    >
      <DelayRow
        kind="subtitle"
        title="Subtitle delay"
        keys="Z X"
        seconds={timing.subtitleDelay}
        disabled={!timing.subtitlesOn}
        hint={timing.subtitlesOn ? undefined : 'Turn subtitles on to shift them'}
        timing={timing}
      />
      <DelayRow
        kind="audio"
        title="Audio delay"
        keys="J K"
        seconds={timing.audioDelay}
        timing={timing}
      />
      <section className="p-4">
        <Heading title="Speed" keys="[ ]" />
        <div
          role="radiogroup"
          aria-label="Speed"
          data-nav-group
          className="mt-3 grid grid-cols-6 gap-1"
        >
          {SPEED_PRESETS.map((preset) => {
            const selected = Math.abs(preset - speed) < 1e-6;
            return (
              <button
                key={preset}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => timing.setSpeed(preset)}
                className={cx(
                  'h-9 cursor-pointer rounded-lg text-sm tabular-nums transition-colors focus-visible:focus-ring',
                  selected
                    ? 'bg-ink-50 font-semibold text-ink-950'
                    : 'text-ink-300 hover:bg-white/[0.08] hover:text-ink-50',
                )}
              >
                {formatSpeed(preset)}
              </button>
            );
          })}
        </div>
      </section>
    </ControlPopover>
  );
}

function Heading({ title, keys }: { title: string; keys: string }) {
  return (
    <p className="flex items-center justify-between text-xs font-semibold tracking-[0.08em] text-ink-400 uppercase">
      {title}
      <span className="font-mono text-[11px] font-normal tracking-normal text-ink-500 normal-case">
        {keys}
      </span>
    </p>
  );
}

function DelayRow({
  kind,
  title,
  keys,
  seconds,
  disabled = false,
  hint,
  timing,
}: {
  kind: DelayKind;
  title: string;
  /** The keys that do the same, shown beside the title. */
  keys: string;
  seconds: number;
  disabled?: boolean;
  hint?: string | undefined;
  timing: PlayerTiming;
}) {
  const subject = kind === 'subtitle' ? 'subtitles' : 'audio';
  return (
    <section className="p-4">
      <Heading title={title} keys={keys} />
      <div data-nav-group className="mt-3 flex items-center gap-2">
        <StepButton
          label={`Show ${subject} earlier`}
          disabled={disabled}
          // Where the keys start in the panel (the first enabled one).
          data-nav-start
          onClick={() => timing.nudge(kind, -1)}
        >
          <Minus aria-hidden className="size-4" />
        </StepButton>
        <output
          aria-label={title}
          className={cx(
            'w-20 text-center font-mono text-base tabular-nums',
            disabled ? 'text-ink-500' : 'text-ink-50',
          )}
        >
          {formatDelay(seconds)}
        </output>
        <StepButton
          label={`Show ${subject} later`}
          disabled={disabled}
          onClick={() => timing.nudge(kind, 1)}
        >
          <Plus aria-hidden className="size-4" />
        </StepButton>
        <button
          type="button"
          disabled={disabled}
          onClick={() => timing.resetDelay(kind)}
          className={cx(
            'ml-auto flex h-9 cursor-pointer items-center gap-1.5 rounded-full px-3 text-xs transition-colors hover:bg-white/[0.08] focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-40',
            seconds === 0 ? 'text-ink-500' : 'text-ink-200',
          )}
        >
          <RotateCcw aria-hidden className="size-3.5" />
          Reset
        </button>
      </div>
      <p className="mt-2 text-xs text-ink-500">{hint ?? describeDelay(kind, seconds)}</p>
    </section>
  );
}

function StepButton({
  label,
  disabled,
  onClick,
  children,
  ...data
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
  'data-nav-start'?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-9 cursor-pointer items-center justify-center rounded-full bg-white/[0.08] text-ink-50 transition-colors hover:bg-white/15 focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-40"
      {...data}
    >
      {children}
    </button>
  );
}
