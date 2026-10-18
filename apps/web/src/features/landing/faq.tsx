import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';

import { availablePlatforms, type Release } from '@/lib/downloads';
import { PLATFORMS } from '@/lib/platform';
import { siteConfig } from '@/lib/site';

interface Question {
  q: string;
  a: ReactNode;
}

const listFormat = new Intl.ListFormat('en-GB');

function questions(release: Release | null): Question[] {
  const available = availablePlatforms(release);
  const ready = PLATFORMS.filter((p) => available.has(p.id)).map((p) => p.label);
  const pending = PLATFORMS.filter((p) => !available.has(p.id)).map((p) => p.label);

  return [
    {
      q: 'Is Kiro free?',
      a: 'Yes. Kiro is free and open source, built by contributors in the open. There is no paid tier, no account and no subscription.',
    },
    {
      q: 'Where do the movies and shows come from?',
      a: 'From addons you choose to install. Kiro does not host or provide any content itself. It ships with a catalogue addon (Cinemeta) and a subtitle addon (OpenSubtitles); stream sources are up to you.',
    },
    {
      q: 'Which platforms does it run on?',
      a:
        ready.length > 0
          ? `Kiro is available today for ${listFormat.format(ready)}.${
              pending.length > 0 ? ` Builds for ${listFormat.format(pending)} are in progress.` : ''
            }`
          : 'Kiro is a desktop app for macOS, Windows and Linux. The first public builds are coming soon.',
    },
    {
      q: 'Do I need an account?',
      a: 'No. Your watchlist, history and settings are stored on your device in a local database. Nothing is uploaded.',
    },
    {
      q: 'Why does macOS warn me when I open it?',
      a: 'Early builds are not yet notarised by Apple, so Gatekeeper shows a warning the first time. Control-click Kiro in Applications and choose Open to run it. This happens once.',
    },
    {
      q: 'Can I contribute?',
      a: siteConfig.githubUrl ? (
        <>
          Please do. Issues, pull requests and addon ideas are welcome on{' '}
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
        'Please do. The source will be published on GitHub alongside the first release.'
      ),
    },
  ];
}

export function Faq({ release }: { release: Release | null }) {
  return (
    <section id="faq" className="relative scroll-mt-20 py-28">
      <div aria-hidden className="absolute inset-x-0 top-0 h-px hairline-glow" />
      <div className="mx-auto grid max-w-6xl gap-10 px-6 lg:grid-cols-[0.8fr_1.2fr]">
        <div>
          <p className="text-sm font-medium text-accent-strong">FAQ</p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance text-ink-50 sm:text-4xl">
            Questions, answered.
          </h2>
        </div>

        <div className="divide-y divide-white/[0.07] border-y border-white/[0.07]">
          {questions(release).map(({ q, a }) => (
            <details key={q} className="group">
              <summary className="flex cursor-pointer items-center justify-between gap-6 py-5 text-left font-medium text-ink-100 transition-colors hover:text-ink-50 focus-visible:focus-ring">
                {q}
                <ChevronDown
                  aria-hidden
                  className="size-4 shrink-0 text-ink-400 transition-transform group-open:rotate-180"
                />
              </summary>
              <div className="pb-5 text-sm leading-relaxed text-ink-300">{a}</div>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
