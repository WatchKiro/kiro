import { cx } from '@kiro/utils';
import type { ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonVariantOptions {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-ink-50 text-ink-950 shadow-[0_0_0_1px_rgb(255_255_255/0.1),0_8px_24px_-8px_rgb(132_60_251/0.55)] hover:bg-white',
  secondary:
    'border border-white/12 bg-white/[0.06] text-ink-50 backdrop-blur-md hover:border-white/20 hover:bg-white/[0.12]',
  ghost: 'text-ink-300 hover:bg-white/[0.06] hover:text-ink-50',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 gap-1.5 px-3 text-sm',
  md: 'h-10 gap-2 px-4 text-sm',
  lg: 'h-12 gap-2.5 px-6 text-base',
};

/**
 * Class names for button styling. Use with framework link components
 * (`next/link`, React Router `Link`) so links and buttons look identical.
 */
export function buttonVariants({
  variant = 'primary',
  size = 'md',
  className,
}: ButtonVariantOptions = {}) {
  return cx(
    'inline-flex shrink-0 cursor-pointer items-center justify-center rounded-full font-medium whitespace-nowrap transition-colors duration-200 select-none',
    'focus-visible:focus-ring',
    'disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50',
    VARIANTS[variant],
    SIZES[size],
    className,
  );
}

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, Omit<ButtonVariantOptions, 'className'> {}

export function Button({ variant, size, className, type = 'button', ...props }: ButtonProps) {
  return <button type={type} className={buttonVariants({ variant, size, className })} {...props} />;
}
