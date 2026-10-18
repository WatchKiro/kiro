import { Badge, buttonVariants } from '@kiro/ui';
import { cx } from '@kiro/utils';
import { ArrowRight, Check } from 'lucide-react';
import Link from 'next/link';

import { DownloadButton } from '@/components/download-button';
import { Mascot } from '@/components/mascot';
import { PlatformIcon } from '@/components/platform-icon';
import { availablePlatforms, type Release } from '@/lib/downloads';
import { PLATFORMS } from '@/lib/platform';

import { AppPreview } from './app-preview';

export function Hero({ release }: { release: Release | null }) {
  const available = availablePlatforms(release);

  return (
    <section className="relative isolate overflow-hidden">
      {/* Ambient light and dot grid */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute top-[-20rem] left-[20%] h-[40rem] w-[60rem] -translate-x-1/2 rounded-full bg-accent/20 blur-[130px]" />
        <div className="absolute top-[2rem] right-[-10rem] h-[30rem] w-[36rem] rounded-full bg-glow/15 blur-[120px]" />
        <div className="absolute inset-0 bg-dots mask-[radial-gradient(ellipse_at_top,black_10%,transparent_65%)]" />
      </div>

      <div className="mx-auto max-w-6xl px-6 pt-[calc(var(--header-h)+3.5rem)] pb-20 sm:pt-[calc(var(--header-h)+5rem)]">
        <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,0.75fr)] lg:gap-10">
          {/* Copy */}
          <div className="text-center lg:text-left">
            <div className="motion-safe:animate-fade-up">
              <Badge tone="accent">
                <span className="size-1.5 rounded-full bg-accent-strong motion-safe:animate-pulse-soft" />
                {release
                  ? `Version ${release.version} is out`
                  : 'Open source · In early development'}
              </Badge>
            </div>

            <h1 className="mt-7 text-5xl font-semibold tracking-[-0.04em] text-balance text-ink-50 motion-safe:animate-fade-up motion-safe:[animation-delay:80ms] sm:text-6xl xl:text-7xl">
              Your entertainment.{' '}
              <span className="bg-linear-to-r from-accent-strong via-[#cdb6ff] to-glow bg-clip-text text-transparent">
                One place.
              </span>
            </h1>

            <p className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-pretty text-ink-300 motion-safe:animate-fade-up motion-safe:[animation-delay:160ms] lg:mx-0">
              Kiro brings movies and shows from every source you add into one fast, beautiful
              desktop app, with a native player that handles 4K, HDR and every subtitle you throw at
              it.
            </p>

            <div className="mt-9 flex flex-col items-center gap-3 motion-safe:animate-fade-up motion-safe:[animation-delay:240ms] sm:flex-row sm:justify-center lg:justify-start">
              <DownloadButton release={release} size="lg" />
              <Link
                href="/download"
                className={buttonVariants({ variant: 'secondary', size: 'lg' })}
              >
                All platforms
                <ArrowRight aria-hidden className="size-4" />
              </Link>
            </div>

            <ul className="mt-7 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm text-ink-400 motion-safe:animate-fade-up motion-safe:[animation-delay:300ms] lg:justify-start">
              {['Free and open source', 'No account needed', 'Local-first'].map((item) => (
                <li key={item} className="flex items-center gap-1.5">
                  <Check aria-hidden className="size-3.5 text-accent-strong" />
                  {item}
                </li>
              ))}
            </ul>

            <ul
              aria-label="Platforms"
              className="mt-6 flex items-center justify-center gap-2 motion-safe:animate-fade-up motion-safe:[animation-delay:340ms] lg:justify-start"
            >
              {PLATFORMS.map((platform) => {
                const ready = available.has(platform.id);
                return (
                  <li
                    key={platform.id}
                    title={
                      ready ? `${platform.label} build available` : `${platform.label} coming soon`
                    }
                    className={cx(
                      'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs',
                      ready
                        ? 'border-white/15 bg-white/[0.06] text-ink-100'
                        : 'border-white/[0.06] text-ink-500',
                    )}
                  >
                    <PlatformIcon platform={platform.id} className="size-3.5" />
                    {platform.label}
                    {!ready && <span className="sr-only"> (coming soon)</span>}
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Mascot */}
          <div className="relative mx-auto w-[14rem] motion-safe:animate-fade-up motion-safe:[animation-delay:200ms] sm:w-[17rem] lg:w-[19rem] xl:w-[22rem]">
            <Mascot id="hero" className="aspect-square" />
          </div>
        </div>

        <div className="mt-20 motion-safe:animate-fade-up motion-safe:[animation-delay:420ms] sm:mt-24">
          <AppPreview />
        </div>
      </div>
    </section>
  );
}
