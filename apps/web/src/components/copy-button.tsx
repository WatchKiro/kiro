'use client';

import { cx } from '@kiro/utils';
import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';

export function CopyButton({
  value,
  label,
  className,
}: {
  value: string;
  label: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => setCopied(true));
      }}
      className={cx(
        'inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-ink-400 transition-colors hover:bg-white/[0.06] hover:text-ink-50 focus-visible:focus-ring',
        className,
      )}
    >
      {copied ? (
        <Check aria-hidden className="size-3.5 text-accent-strong" />
      ) : (
        <Copy aria-hidden className="size-3.5" />
      )}
    </button>
  );
}
