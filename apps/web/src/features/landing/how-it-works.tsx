import { Download, Play, Puzzle, type LucideIcon } from 'lucide-react';

interface Step {
  icon: LucideIcon;
  title: string;
  description: string;
}

const STEPS: Step[] = [
  {
    icon: Download,
    title: 'Install Kiro',
    description:
      'Download the build for your computer and open it. There is no account to create and nothing to configure.',
  },
  {
    icon: Puzzle,
    title: 'Add your sources',
    description:
      'Kiro ships with catalogue and subtitle addons. Paste the URL of any Stremio-compatible addon to add streams and more.',
  },
  {
    icon: Play,
    title: 'Press play',
    description:
      'Search with ⌘K, pick the best stream with one click, and let Kiro remember where you left off.',
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="relative scroll-mt-20 py-28">
      <div aria-hidden className="absolute inset-x-0 top-0 h-px hairline-glow" />
      <div className="mx-auto max-w-6xl px-6">
        <div className="max-w-2xl">
          <p className="text-sm font-medium text-accent-strong">How it works</p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance text-ink-50 sm:text-4xl">
            Up and running in a minute.
          </h2>
        </div>

        <ol className="mt-14 grid gap-4 md:grid-cols-3">
          {STEPS.map(({ icon: Icon, title, description }, index) => (
            <li
              key={title}
              className="relative rounded-card border border-white/[0.07] bg-white/[0.02] p-6"
            >
              <div className="flex items-center justify-between">
                <div className="flex size-10 items-center justify-center rounded-xl border border-white/10 bg-linear-to-b from-white/[0.08] to-transparent text-accent-strong">
                  <Icon aria-hidden className="size-5" />
                </div>
                <span className="font-mono text-sm text-ink-500">0{index + 1}</span>
              </div>
              <h3 className="mt-5 font-medium text-ink-50">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-400">{description}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
