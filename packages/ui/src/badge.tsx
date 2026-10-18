import { cx } from '@kiro/utils';
import type { HTMLAttributes } from 'react';

export type BadgeTone = 'neutral' | 'accent';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

const TONES: Record<BadgeTone, string> = {
  neutral: 'border-white/10 bg-white/[0.04] text-ink-300',
  accent: 'border-accent/30 bg-accent/10 text-accent-strong',
};

export function Badge({ tone = 'neutral', className, ...props }: BadgeProps) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium tracking-wide',
        TONES[tone],
        className,
      )}
      {...props}
    />
  );
}
