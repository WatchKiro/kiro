import { cx } from '@kiro/utils';
import type { ReactNode } from 'react';

interface PageProps {
  title: string;
  /** Shown beside the title, e.g. a count or an action. */
  aside?: ReactNode;
  /** A line under the title. */
  description?: ReactNode;
  className?: string;
  children: ReactNode;
}

/** A page without artwork: clear of the floating header, with a large title. */
export function Page({ title, aside, description, className, children }: PageProps) {
  return (
    <div className={cx('px-10 pt-24 pb-16', className)}>
      <div className="mb-8 flex flex-wrap items-end gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-[2rem] leading-tight font-semibold tracking-[-0.03em] text-ink-50">
            {title}
          </h1>
          {description && <p className="mt-1.5 text-sm text-ink-400">{description}</p>}
        </div>
        {aside && <div className="ml-auto">{aside}</div>}
      </div>
      {children}
    </div>
  );
}

/** A centred message filling the page: an empty, unavailable or failed state. */
export function PageMessage({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-[calc(100dvh-4rem)] flex-col items-center justify-center gap-3 px-8 pt-16 pb-16 text-center">
      <div className="mb-2 flex size-12 items-center justify-center rounded-2xl border border-white/10 bg-linear-to-b from-white/[0.08] to-white/[0.02] text-accent-strong">
        {icon}
      </div>
      <p className="text-[15px] font-medium text-ink-100">{title}</p>
      {children}
    </div>
  );
}
