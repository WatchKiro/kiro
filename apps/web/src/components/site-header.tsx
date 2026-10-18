'use client';

import { KiroLogo } from '@kiro/ui';
import { cx } from '@kiro/utils';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import type { Release } from '@/lib/downloads';
import { siteConfig } from '@/lib/site';

import { DownloadButton } from './download-button';

const NAV = [
  { href: '/#features', label: 'Features' },
  { href: '/#how-it-works', label: 'How it works' },
  { href: '/#faq', label: 'FAQ' },
  { href: '/download', label: 'Download' },
] as const;

const linkClass =
  'rounded-full px-3.5 py-1.5 text-sm text-ink-300 transition-colors hover:bg-white/[0.05] hover:text-ink-50';

/** Scroll distance (px) after which the header switches to its glass treatment. */
const SCROLL_THRESHOLD = 24;

/**
 * Fixed header that sits transparently over the hero and becomes a frosted
 * glass bar once the page is scrolled. Pages add top padding to compensate
 * via the `--header-h` variable set in globals.css.
 */
export function SiteHeader({ release }: { release: Release | null }) {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const update = () => setScrolled(window.scrollY > SCROLL_THRESHOLD);
    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => window.removeEventListener('scroll', update);
  }, []);

  return (
    <header
      data-scrolled={scrolled || undefined}
      className={cx(
        'fixed inset-x-0 top-0 z-50 transition-[background-color,border-color,backdrop-filter,box-shadow] duration-300 ease-out-soft',
        'border-b',
        scrolled
          ? 'border-white/[0.06] bg-ink-950/65 shadow-[0_8px_32px_-12px_rgb(0_0_0/0.6)] backdrop-blur-xl'
          : 'border-transparent bg-transparent',
      )}
    >
      <div className="mx-auto flex h-(--header-h) max-w-6xl items-center justify-between gap-6 px-6">
        <Link
          href="/"
          aria-label="Kiro home"
          className="rounded-lg focus-visible:outline-2 focus-visible:outline-accent"
        >
          <KiroLogo markClassName="size-7" />
        </Link>

        <nav aria-label="Primary" className="hidden items-center gap-1 md:flex">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className={linkClass}>
              {item.label}
            </Link>
          ))}
          {siteConfig.githubUrl && (
            <a
              href={siteConfig.githubUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={linkClass}
            >
              GitHub
            </a>
          )}
        </nav>

        <DownloadButton release={release} size="sm" />
      </div>
    </header>
  );
}
