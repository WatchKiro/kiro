'use client';

import { buttonVariants, type ButtonSize, type ButtonVariant } from '@kiro/ui';
import { cx } from '@kiro/utils';
import { Download } from 'lucide-react';
import Link from 'next/link';

import { useDetectedPlatform } from '@/hooks/use-detected-platform';
import { formatBytes, pickAsset, type Release } from '@/lib/downloads';
import { archLabel, PLATFORM_BY_ID } from '@/lib/platform';

interface DownloadButtonProps {
  release: Release | null;
  size?: ButtonSize;
  variant?: ButtonVariant;
  className?: string;
  /** Show version, architecture and size under the button. */
  showMeta?: boolean;
}

/**
 * The primary call to action. Server-renders as a link to the download page,
 * then upgrades itself to a direct download for the visitor's platform once
 * the browser has been identified. With no release yet, renders a disabled
 * "coming soon" button instead of linking to a missing file.
 */
export function DownloadButton({
  release,
  size = 'md',
  variant = 'primary',
  className,
  showMeta = false,
}: DownloadButtonProps) {
  const detected = useDetectedPlatform();
  const classes = buttonVariants({ variant, size, className });

  if (!release) {
    return (
      <span
        role="button"
        aria-disabled
        className={cx(classes, 'opacity-50')}
        title="Kiro is in early development — downloads are coming soon"
      >
        <Download aria-hidden className="size-4" />
        Download Kiro
        <span className="sr-only">(coming soon)</span>
      </span>
    );
  }

  const asset = detected ? pickAsset(release, detected) : null;

  if (!asset) {
    return (
      <Link href="/download" className={classes}>
        <Download aria-hidden className="size-4" />
        Download Kiro
      </Link>
    );
  }

  const platform = PLATFORM_BY_ID[asset.platform].label;
  const arch = archLabel(asset.platform, asset.arch);

  const button = (
    <a href={asset.url} download className={classes} data-platform={asset.platform}>
      <Download aria-hidden className="size-4" />
      Download for {platform}
    </a>
  );

  if (!showMeta) return button;

  return (
    <div className="flex flex-col items-center gap-2">
      {button}
      <span className="text-xs text-ink-400">
        v{release.version} · {arch} · {formatBytes(asset.size)} ·{' '}
        <Link href="/download" className="underline-offset-4 hover:text-ink-200 hover:underline">
          Other platforms
        </Link>
      </span>
    </div>
  );
}
