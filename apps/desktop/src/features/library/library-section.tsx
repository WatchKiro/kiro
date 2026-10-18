import { Badge, buttonVariants } from '@kiro/ui';
import type { LucideIcon } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { Link } from 'react-router';

import { InlineError } from '@/features/discovery/catalog-row';
import type { LibraryList } from '@/features/library/library-store';

/** A Library list with its heading, count, load states and errors. */
export function LibrarySection<T>({
  title,
  list,
  error,
  action,
  onRetry,
  placeholder,
  children,
}: {
  title: string;
  list: LibraryList<T>;
  /** An error from the last action on the list. */
  error: string | null;
  action?: ReactNode;
  onRetry: () => void;
  /** Shown while the list first loads. */
  placeholder?: ReactNode;
  children: ReactNode;
}) {
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="space-y-4">
      <div className="flex min-h-8 items-center gap-3">
        <h2 id={headingId} className="text-[19px] font-semibold tracking-[-0.015em] text-ink-50">
          {title}
        </h2>
        {list.status === 'ready' && list.items.length > 0 && <Badge>{list.items.length}</Badge>}
        <div className="ml-auto">{action}</div>
      </div>
      {error && (
        <p role="alert" className="text-[13px] text-rose-300">
          {error}
        </p>
      )}
      {list.status === 'error' && list.items.length === 0 ? (
        <InlineError
          message={`Couldn’t load your ${title.toLowerCase()}. ${list.error ?? ''}`}
          onRetry={onRetry}
        />
      ) : list.status === 'ready' ? (
        children
      ) : (
        (placeholder ?? (
          <div aria-hidden className="h-24 animate-pulse rounded-card bg-white/[0.03]" />
        ))
      )}
    </section>
  );
}

export function LibraryEmpty({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-card border border-dashed border-white/[0.1] bg-white/[0.015] px-5 py-12 text-center">
      <Icon aria-hidden className="size-5 text-accent-strong" />
      <p className="mt-3 text-sm text-ink-400">{children}</p>
      <Link to="/" className={buttonVariants({ variant: 'ghost', size: 'sm', className: 'mt-3' })}>
        Browse Discover
      </Link>
    </div>
  );
}
