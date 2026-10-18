import { buttonVariants } from '@kiro/ui';
import { ArrowRight } from 'lucide-react';
import Link from 'next/link';

import { DownloadButton } from '@/components/download-button';
import { Mascot } from '@/components/mascot';
import { PlatformCard } from '@/components/platform-card';
import { formatReleaseDate, type Release } from '@/lib/downloads';
import { PLATFORMS } from '@/lib/platform';

export function PlatformsSection({ release }: { release: Release | null }) {
  return (
    <section id="download" className="scroll-mt-20 py-28">
      <div className="mx-auto max-w-6xl px-6">
        <div className="relative overflow-hidden rounded-[1.75rem] border border-white/[0.07] bg-linear-to-b from-ink-850 to-ink-900 px-6 py-16 sm:px-16">
          <div
            aria-hidden
            className="pointer-events-none absolute -top-40 left-1/2 h-80 w-[40rem] -translate-x-1/2 rounded-full bg-accent/20 blur-[100px]"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-dots mask-[radial-gradient(ellipse_at_bottom,black,transparent_70%)] opacity-60"
          />

          {/* The mascot peeks in from the corner on wide screens. */}
          <div
            aria-hidden
            className="pointer-events-none absolute -right-10 -bottom-16 hidden w-56 opacity-90 lg:block"
          >
            <Mascot id="download" stage={false} track className="aspect-square" />
          </div>

          <div className="relative text-center">
            <p className="text-sm font-medium text-accent-strong">Download</p>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance text-ink-50 sm:text-4xl">
              {release ? 'Get Kiro for your desktop.' : 'Made for your desktop.'}
            </h2>
            <p className="mx-auto mt-4 max-w-lg text-pretty text-ink-300">
              {release ? (
                <>
                  Free and open source. Version {release.version}, released{' '}
                  {formatReleaseDate(release.publishedAt)}.
                </>
              ) : (
                'Native builds for every major desktop platform are on the way. The first public release is coming soon.'
              )}
            </p>

            <div className="mt-8 flex justify-center">
              <DownloadButton release={release} size="lg" showMeta />
            </div>
          </div>

          <ul className="relative mx-auto mt-12 grid gap-4 sm:grid-cols-3">
            {PLATFORMS.map((platform) => (
              <PlatformCard key={platform.id} platform={platform.id} release={release} />
            ))}
          </ul>

          {release && (
            <div className="relative mt-8 flex justify-center">
              <Link href="/download" className={buttonVariants({ variant: 'ghost', size: 'md' })}>
                All downloads, checksums and install notes
                <ArrowRight aria-hidden className="size-4" />
              </Link>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
