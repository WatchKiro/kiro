import { Badge, buttonVariants } from '@kiro/ui';
import { cx } from '@kiro/utils';
import { Download } from 'lucide-react';

import { assetsFor, formatBytes, type DownloadAsset, type Release } from '@/lib/downloads';
import { archLabel, PACKAGE_LABEL, PLATFORM_BY_ID, type Platform } from '@/lib/platform';

import { PlatformIcon } from './platform-icon';

interface PlatformCardProps {
  platform: Platform;
  release: Release | null;
  /** Show every package (download page) rather than just the preferred one (landing page). */
  detailed?: boolean;
  className?: string;
}

function assetLabel(asset: DownloadAsset, detailed: boolean): string {
  const arch = archLabel(asset.platform, asset.arch);
  return detailed ? `${PACKAGE_LABEL[asset.kind]} · ${arch}` : arch;
}

export function PlatformCard({
  platform,
  release,
  detailed = false,
  className,
}: PlatformCardProps) {
  const info = PLATFORM_BY_ID[platform];
  const assets = release ? assetsFor(release, platform) : [];
  const available = assets.length > 0;
  // On the landing page show one button per architecture, not every package format.
  const shown = detailed
    ? assets
    : assets.filter((asset, index) => assets.findIndex((a) => a.arch === asset.arch) === index);

  return (
    <li
      className={cx(
        'flex flex-col rounded-card border border-white/[0.07] bg-white/[0.02] p-6 text-left transition duration-300 ease-out-soft',
        available && 'hover:border-white/[0.14] hover:bg-white/[0.035]',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl border border-white/10 bg-linear-to-b from-white/[0.08] to-transparent text-ink-100">
            <PlatformIcon platform={platform} className="size-5" />
          </div>
          <div>
            <h3 className="font-medium text-ink-50">{info.label}</h3>
            <p className="text-xs text-ink-400">{info.requirements}</p>
          </div>
        </div>
        {!available && <Badge className="shrink-0 whitespace-nowrap">Coming soon</Badge>}
      </div>

      {available ? (
        <ul className="mt-5 flex flex-col gap-2">
          {shown.map((asset) => (
            <li key={asset.name}>
              <a
                href={asset.url}
                download
                className={buttonVariants({
                  variant: 'secondary',
                  size: 'md',
                  className: 'w-full justify-between',
                })}
              >
                <span className="flex items-center gap-2">
                  <Download aria-hidden className="size-4 text-ink-300" />
                  {assetLabel(asset, detailed)}
                </span>
                <span className="text-xs text-ink-400">{formatBytes(asset.size)}</span>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-5 text-sm leading-relaxed text-ink-400">
          A native {info.label} build is in progress. Check back soon.
        </p>
      )}
    </li>
  );
}
