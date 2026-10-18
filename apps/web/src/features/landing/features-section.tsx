import { cx } from '@kiro/utils';
import {
  AudioLines,
  Captions,
  Check,
  Feather,
  Gauge,
  Keyboard,
  Library,
  MonitorPlay,
  Plus,
  Puzzle,
  ShieldCheck,
  SkipForward,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';

function Card({
  icon: Icon,
  title,
  description,
  children,
  className,
  horizontal = false,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  children?: ReactNode;
  className?: string;
  /** Place the illustration beside the copy on large screens instead of below it. */
  horizontal?: boolean;
}) {
  return (
    <li
      className={cx(
        'group relative flex flex-col overflow-hidden rounded-card border border-white/[0.07] bg-white/[0.02] p-6 transition duration-300 ease-out-soft hover:border-white/[0.14] hover:bg-white/[0.035]',
        horizontal && 'lg:flex-row lg:items-center lg:gap-12',
        className,
      )}
    >
      <div>
        <div className="flex size-10 items-center justify-center rounded-xl border border-white/10 bg-linear-to-b from-white/[0.08] to-transparent text-accent-strong transition-colors group-hover:text-glow">
          <Icon aria-hidden className="size-5" />
        </div>
        <h3 className="mt-5 text-lg font-medium text-ink-50">{title}</h3>
        <p className="mt-2 max-w-md text-sm leading-relaxed text-ink-400">{description}</p>
      </div>
      {children && (
        <div className={cx('mt-6 flex-1', horizontal && 'lg:mt-0 lg:flex lg:justify-end')}>
          {children}
        </div>
      )}
    </li>
  );
}

/* Mini illustrations. Pure CSS, aria-hidden, no real content. */

function PlaybackVisual() {
  const chips = [
    { icon: Gauge, label: '2160p · HDR10' },
    { icon: AudioLines, label: 'English 5.1' },
    { icon: Captions, label: 'English (SDH)' },
    { icon: SkipForward, label: 'Skip intro' },
  ];
  return (
    <div aria-hidden className="relative">
      <div className="relative h-36 overflow-hidden rounded-xl bg-linear-to-br from-[#1b1540] via-[#0f0c22] to-[#0b1420] ring-1 ring-white/[0.06]">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_30%,rgb(132_60_251/0.35),transparent_55%)]" />
        <div className="absolute inset-x-0 bottom-0 p-3">
          <div className="h-1 overflow-hidden rounded-full bg-white/10">
            <div className="h-full w-[62%] rounded-full bg-accent-strong" />
          </div>
          <div className="mt-2 flex justify-between text-[10px] text-ink-400">
            <span>1:12:40</span>
            <span>1:58:02</span>
          </div>
        </div>
      </div>
      <ul className="mt-3 flex flex-wrap gap-2">
        {chips.map(({ icon: Icon, label }) => (
          <li
            key={label}
            className="flex items-center gap-1.5 rounded-full border border-white/10 bg-ink-900 px-2.5 py-1 text-xs text-ink-200"
          >
            <Icon className="size-3 text-accent-strong" />
            {label}
          </li>
        ))}
      </ul>
    </div>
  );
}

function AddonsVisual() {
  const addons = [
    { name: 'Cinemeta', kind: 'Catalogue · Metadata', on: true },
    { name: 'OpenSubtitles', kind: 'Subtitles', on: true },
    { name: 'Your addon', kind: 'Streams', on: false },
  ];
  return (
    <ul aria-hidden className="space-y-2">
      {addons.map(({ name, kind, on }) => (
        <li
          key={name}
          className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-ink-900 px-3 py-2"
        >
          <div>
            <div className="text-xs font-medium text-ink-100">{name}</div>
            <div className="text-[10px] text-ink-500">{kind}</div>
          </div>
          <span
            className={cx(
              'relative h-4 w-7 rounded-full transition-colors',
              on ? 'bg-accent' : 'bg-white/10',
            )}
          >
            <span
              className={cx(
                'absolute top-0.5 size-3 rounded-full bg-white transition-transform',
                on ? 'left-3.5' : 'left-0.5',
              )}
            />
          </span>
        </li>
      ))}
      <li className="flex items-center gap-2 rounded-lg border border-dashed border-white/10 px-3 py-2 text-xs text-ink-400">
        <Plus className="size-3.5" /> Add by URL
      </li>
    </ul>
  );
}

function LibraryVisual() {
  const items = [
    { g: 'from-[#4b3a8f] to-[#120f24]', p: 62, label: 'S2 · E4' },
    { g: 'from-[#7a3b52] to-[#150b10]', p: 18, label: '0:21 left' },
    { g: 'from-[#1f5f6b] to-[#0a1517]', p: 85, label: 'S1 · E9' },
  ];
  return (
    <ul aria-hidden className="grid grid-cols-3 gap-2.5">
      {items.map(({ g, p, label }) => (
        <li key={g} className="space-y-1.5">
          <div
            className={`relative aspect-[2/3] overflow-hidden rounded-lg bg-linear-to-b ring-1 ring-white/[0.06] ${g}`}
          >
            <div className="absolute inset-x-0 bottom-0 h-1 bg-white/15">
              <div className="h-full bg-accent-strong" style={{ width: `${p}%` }} />
            </div>
          </div>
          <div className="text-[10px] text-ink-500">{label}</div>
        </li>
      ))}
    </ul>
  );
}

function RemoteVisual() {
  const keys = ['⌘K', 'Space', '←', '→', 'F', '?'];
  return (
    <ul aria-hidden className="flex flex-wrap gap-2">
      {keys.map((key) => (
        <li
          key={key}
          className="flex h-8 min-w-8 items-center justify-center rounded-md border border-white/10 bg-ink-900 px-2 font-mono text-xs text-ink-200 shadow-[inset_0_-2px_0_rgb(255_255_255/0.06)]"
        >
          {key}
        </li>
      ))}
    </ul>
  );
}

function PrivateVisual() {
  const lines = ['No account to create', 'Library stored on your device', 'Addon code never runs'];
  return (
    <ul aria-hidden className="space-y-2 text-xs text-ink-300">
      {lines.map((line) => (
        <li key={line} className="flex items-center gap-2">
          <Check className="size-3.5 text-accent-strong" />
          {line}
        </li>
      ))}
    </ul>
  );
}

function LightweightVisual() {
  return (
    <div aria-hidden className="space-y-2.5 text-xs">
      <div>
        <div className="mb-1 flex justify-between text-ink-400">
          <span>Kiro</span>
          <span className="text-ink-200">Rust + Tauri</span>
        </div>
        <div className="h-1.5 w-[18%] rounded-full bg-accent-strong" />
      </div>
      <div>
        <div className="mb-1 flex justify-between text-ink-500">
          <span>Typical Electron app</span>
        </div>
        <div className="h-1.5 w-full rounded-full bg-white/10" />
      </div>
    </div>
  );
}

export function FeaturesSection({ released }: { released: boolean }) {
  return (
    <section id="features" className="scroll-mt-20 py-28">
      <div className="mx-auto max-w-6xl px-6">
        <div className="max-w-2xl">
          <p className="text-sm font-medium text-accent-strong">Features</p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance text-ink-50 sm:text-4xl">
            Everything you watch, beautifully organised.
          </h2>
          <p className="mt-4 text-lg text-pretty text-ink-300">
            {released
              ? 'Kiro is young and moving quickly. Here is what it does today.'
              : 'Kiro is in early development. Here is what we are building.'}
          </p>
        </div>

        <ul className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
          <Card
            icon={MonitorPlay}
            title="A player that just plays"
            description="A libmpv engine handles 4K, HDR, MKV, multiple audio tracks and every subtitle format. Chapters power skip intro and skip credits."
            className="sm:col-span-2 lg:col-span-4"
          >
            <PlaybackVisual />
          </Card>
          <Card
            icon={Puzzle}
            title="Open addon ecosystem"
            description="Add catalogues, metadata, streams and subtitles from Stremio-compatible addons. Two are included to get you started."
            className="lg:col-span-2"
          >
            <AddonsVisual />
          </Card>
          <Card
            icon={Library}
            title="Pick up where you left off"
            description="Continue watching, watchlists and history, with Up Next lined up when an episode ends."
            className="lg:col-span-2"
          >
            <LibraryVisual />
          </Card>
          <Card
            icon={Keyboard}
            title="Keyboard and remote friendly"
            description="Full spatial navigation. Sit back with a remote or a controller, or fly through it with shortcuts."
            className="lg:col-span-2"
          >
            <RemoteVisual />
          </Card>
          <Card
            icon={ShieldCheck}
            title="Private by default"
            description="Streams never pass through our servers. Addon responses are validated and never executed."
            className="lg:col-span-2"
          >
            <PrivateVisual />
          </Card>
          <Card
            icon={Feather}
            title="Lightweight by design"
            description="Built with Rust and Tauri instead of a bundled browser. A small download, a fast start and a light memory footprint."
            className="sm:col-span-2 lg:col-span-6"
            horizontal
          >
            <div className="lg:w-80">
              <LightweightVisual />
            </div>
          </Card>
        </ul>
      </div>
    </section>
  );
}
