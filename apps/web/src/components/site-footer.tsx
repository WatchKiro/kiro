import { KiroLogo } from '@kiro/ui';
import Link from 'next/link';

import type { Release } from '@/lib/downloads';
import { siteConfig } from '@/lib/site';

const linkClass = 'text-sm text-ink-400 transition-colors hover:text-ink-100';

export function SiteFooter({ release }: { release: Release | null }) {
  const product = [
    { href: '/#features', label: 'Features' },
    { href: '/#how-it-works', label: 'How it works' },
    { href: '/download', label: 'Download' },
    { href: '/#faq', label: 'FAQ' },
  ];
  const project = [
    siteConfig.githubUrl && {
      href: siteConfig.githubUrl,
      label: 'Source on GitHub',
      external: true,
    },
    release && { href: release.url, label: 'Release notes', external: true },
    siteConfig.githubUrl && {
      href: `${siteConfig.githubUrl}/issues`,
      label: 'Report an issue',
      external: true,
    },
  ].filter((item): item is { href: string; label: string; external: true } => Boolean(item));

  return (
    <footer className="relative border-t border-white/[0.06]">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-64 bg-[radial-gradient(ellipse_at_bottom,rgb(132_60_251/0.12),transparent_70%)]"
      />
      <div className="relative mx-auto grid max-w-6xl gap-10 px-6 py-14 sm:grid-cols-[1.5fr_1fr_1fr]">
        <div>
          <KiroLogo markClassName="size-7" />
          <p className="mt-4 max-w-xs text-sm leading-relaxed text-ink-400">
            {siteConfig.tagline} A lightweight, open-source media app for the desktop.
          </p>
        </div>

        <nav aria-label="Product">
          <h2 className="text-xs font-medium tracking-wider text-ink-500 uppercase">Product</h2>
          <ul className="mt-4 space-y-2.5">
            {product.map((item) => (
              <li key={item.href}>
                <Link href={item.href} className={linkClass}>
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <nav aria-label="Project">
          <h2 className="text-xs font-medium tracking-wider text-ink-500 uppercase">Project</h2>
          <ul className="mt-4 space-y-2.5">
            {project.length > 0 ? (
              project.map((item) => (
                <li key={item.href}>
                  <a
                    href={item.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={linkClass}
                  >
                    {item.label}
                  </a>
                </li>
              ))
            ) : (
              <li className="text-sm text-ink-500">Source coming soon</li>
            )}
          </ul>
        </nav>
      </div>

      <div className="relative border-t border-white/[0.06]">
        <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-2 px-6 py-6 text-xs text-ink-500 sm:flex-row sm:items-center">
          <span>© {new Date().getFullYear()} Kiro contributors. Open-source software.</span>
          <span>
            {release ? `v${release.version}` : 'Pre-release'} · Kiro does not host or provide any
            media content.
          </span>
        </div>
      </div>
    </footer>
  );
}
