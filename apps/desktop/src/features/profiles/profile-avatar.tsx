import { cx } from '@kiro/utils';
import { Lock } from 'lucide-react';

import { avatarStyle, initialOf } from '@/features/profiles/profiles-data';

const SIZES = {
  /** The sidebar and menus. */
  sm: 'size-7 rounded-[9px] text-[13px]',
  /** Settings rows. */
  md: 'size-10 rounded-xl text-base',
  /** The PIN pad. */
  lg: 'size-20 rounded-[22px] text-3xl',
  /** "Who’s watching?". */
  xl: 'size-28 rounded-[30px] text-5xl sm:size-32 sm:rounded-[34px]',
} as const;

/** A profile's avatar: its colour with the first letter of its name. Decorative. */
export function ProfileAvatar({
  name,
  avatar,
  size = 'md',
  locked = false,
  className,
}: {
  name: string;
  avatar: string;
  size?: keyof typeof SIZES;
  /** Marks a profile with a PIN. */
  locked?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cx(
        'relative inline-flex shrink-0 items-center justify-center bg-linear-to-br font-semibold tracking-[-0.02em] shadow-[inset_0_1px_0_rgb(255_255_255/0.25),0_8px_24px_-10px_rgb(0_0_0/0.6)] select-none',
        avatarStyle(avatar).className,
        SIZES[size],
        className,
      )}
    >
      {initialOf(name)}
      {locked && (
        <span
          className={cx(
            'absolute -right-1 -bottom-1 flex items-center justify-center rounded-full border-2 border-ink-950 bg-ink-800 text-ink-100',
            size === 'xl' ? 'size-9' : size === 'lg' ? 'size-7' : 'size-4.5 border',
          )}
        >
          <Lock className={size === 'xl' ? 'size-4' : size === 'lg' ? 'size-3.5' : 'size-2.5'} />
        </span>
      )}
    </span>
  );
}
