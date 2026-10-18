import { cx } from '@kiro/utils';
import type { ImgHTMLAttributes } from 'react';

/**
 * Path at which every app serves the mark from its `public/` directory.
 * Generated from `brand/kiro-icon.webp` by `brand/generate.sh`.
 */
export const KIRO_MARK_SRC = '/brand/kiro-mark.webp';

/** The Kiro app mark (the Kiro robot). Decorative by default (`alt=""`). */
export function KiroMark({
  className,
  src = KIRO_MARK_SRC,
  alt = '',
  ...props
}: ImgHTMLAttributes<HTMLImageElement>) {
  return (
    <img
      src={src}
      alt={alt}
      width={64}
      height={64}
      decoding="async"
      draggable={false}
      className={cx('size-8 shrink-0 rounded-[24%] select-none', className)}
      {...props}
    />
  );
}

export interface KiroLogoProps {
  className?: string;
  markClassName?: string;
}

/** Mark plus wordmark. */
export function KiroLogo({ className, markClassName }: KiroLogoProps) {
  return (
    <span className={cx('inline-flex items-center gap-2.5', className)}>
      <KiroMark className={markClassName} />
      <span className="text-lg font-semibold tracking-tight text-ink-50">Kiro</span>
    </span>
  );
}
