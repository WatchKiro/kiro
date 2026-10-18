import { Badge, buttonVariants } from '@kiro/ui';
import { ExternalLink } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';

import { DownloadButton } from '@/components/download-button';
import { Mascot } from '@/components/mascot';
import { PlatformCard } from '@/components/platform-card';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import { Checksums } from '@/features/download/checksums';
import { InstallGuide } from '@/features/download/install-guide';
import { availablePlatforms, formatReleaseDate } from '@/lib/downloads';
import { PLATFORMS } from '@/lib/platform';
import { allReleasesUrl, getLatestRelease } from '@/lib/releases';
import { siteConfig } from '@/lib/site';

export const metadata: Metadata = {
  title: 'Download',
  description: `Download ${siteConfig.name} for macOS, Windows and Linux. Free and open source.`,
  alternates: { canonical: '/download' },
};

/** Re-check GitHub Releases at most once an hour. */
export const revalidate = 3600;

export default async function DownloadPage() {
  const release = await getLatestRelease();
  const available = availablePlatforms(release);
  const releasesUrl = allReleasesUrl();

  return (
    <>
      <SiteHeader release={release} />
      <main className="relative isolate overflow-hidden">
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
          <div className="absolute top-[-16rem] left-1/2 h-[30rem] w-[56rem] -translate-x-1/2 rounded-full bg-accent/15 blur-[120px]" />
        </div>

        <div className="mx-auto max-w-6xl px-6 pt-[calc(var(--header-h)+4rem)] pb-28 sm:pt-[calc(var(--header-h)+5rem)]">
          <header className="grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_auto]">
            <div className="max-w-2xl">
              {release ? (
                <Badge tone="accent">
                  Latest release · v{release.version} · {formatReleaseDate(release.publishedAt)}
                </Badge>
              ) : (
                <Badge tone="accent">In early development</Badge>
              )}
              <h1 className="mt-5 text-4xl font-semibold tracking-[-0.03em] text-balance text-ink-50 sm:text-5xl">
                Download {siteConfig.name}
              </h1>
              <p className="mt-4 text-lg text-pretty text-ink-300">
                {release
                  ? 'Free, open source and local-first. Pick the build for your computer below.'
                  : 'There is no public build yet. Native builds for macOS, Windows and Linux are on the way.'}
              </p>

              <div className="mt-8 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
                <DownloadButton release={release} size="lg" />
                {release && (
                  <a
                    href={release.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={buttonVariants({ variant: 'secondary', size: 'lg' })}
                  >
                    Release notes
                    <ExternalLink aria-hidden className="size-4" />
                  </a>
                )}
              </div>
            </div>
            <div aria-hidden className="hidden w-44 lg:block xl:w-52">
              <Mascot id="download-page" className="aspect-square" />
            </div>
          </header>

          <section aria-labelledby="builds-heading" className="mt-16">
            <h2 id="builds-heading" className="text-2xl font-semibold tracking-tight text-ink-50">
              All builds
            </h2>
            <ul className="mt-6 grid gap-4 lg:grid-cols-3">
              {PLATFORMS.map((platform) => (
                <PlatformCard key={platform.id} platform={platform.id} release={release} detailed />
              ))}
            </ul>
            {releasesUrl && (
              <p className="mt-4 text-sm text-ink-400">
                Looking for an older version?{' '}
                <a
                  href={releasesUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-ink-200 underline-offset-4 hover:underline"
                >
                  Browse all releases
                </a>
                .
              </p>
            )}
          </section>

          <InstallGuide available={available} />
          {release && <Checksums release={release} />}

          <section className="mt-20 rounded-card border border-white/[0.07] bg-white/[0.02] p-6 sm:p-8">
            <h2 className="text-xl font-semibold tracking-tight text-ink-50">Good to know</h2>
            <ul className="mt-4 grid gap-4 text-sm leading-relaxed text-ink-300 sm:grid-cols-2">
              <li>
                <strong className="font-medium text-ink-100">No account needed.</strong> Kiro works
                the moment you open it. Your library and history stay on your device.
              </li>
              <li>
                <strong className="font-medium text-ink-100">Bring your own sources.</strong> Kiro
                ships with a small set of default addons; add more from the Addons page inside the
                app.
              </li>
              <li>
                <strong className="font-medium text-ink-100">Lightweight.</strong> Built with Rust
                and Tauri rather than a bundled browser, so the download is small and it starts
                fast.
              </li>
              <li>
                <strong className="font-medium text-ink-100">Open source.</strong>{' '}
                {siteConfig.githubUrl ? (
                  <>
                    Read the code, report issues or contribute on{' '}
                    <a
                      href={siteConfig.githubUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-ink-100 underline-offset-4 hover:underline"
                    >
                      GitHub
                    </a>
                    .
                  </>
                ) : (
                  'Built in the open by Kiro contributors.'
                )}
              </li>
            </ul>
            <p className="mt-6 text-sm text-ink-400">
              <Link href="/#features" className="text-ink-200 underline-offset-4 hover:underline">
                See everything Kiro can do
              </Link>
            </p>
          </section>
        </div>
      </main>
      <SiteFooter release={release} />
    </>
  );
}
