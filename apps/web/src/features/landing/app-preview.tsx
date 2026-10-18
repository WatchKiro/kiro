import { KiroMark } from '@kiro/ui';
import {
  Captions,
  Compass,
  Film,
  Library,
  Maximize2,
  Pause,
  Puzzle,
  Search,
  SkipForward,
  Tv,
  Volume2,
} from 'lucide-react';

const NAV = [
  { icon: Compass, label: 'Discover', active: true },
  { icon: Film, label: 'Movies' },
  { icon: Tv, label: 'TV Shows' },
  { icon: Library, label: 'Library' },
  { icon: Puzzle, label: 'Addons' },
];

/** Decorative poster palettes. No real artwork is shipped with the site. */
const POSTERS = [
  { g: 'from-[#4b3a8f] via-[#2a2152] to-[#120f24]', p: 62 },
  { g: 'from-[#1f5f6b] via-[#143840] to-[#0a1517]', p: 0 },
  { g: 'from-[#7a3b52] via-[#3d1f2c] to-[#150b10]', p: 18 },
  { g: 'from-[#3a4f86] via-[#1f2a4a] to-[#0c1020]', p: 0 },
  { g: 'from-[#6b5a2a] via-[#3a3118] to-[#15120a]', p: 85 },
  { g: 'from-[#2e6b4f] via-[#183a2b] to-[#0a1510]', p: 0 },
  { g: 'from-[#6b2e5e] via-[#3a1833] to-[#150a12]', p: 40 },
  { g: 'from-[#2e4f6b] via-[#182d3a] to-[#0a1015]', p: 0 },
];

function PosterRow() {
  return (
    <div className="relative overflow-hidden mask-[linear-gradient(to_right,transparent,black_6%,black_94%,transparent)]">
      <div className="flex w-max gap-3 motion-safe:animate-marquee">
        {[...POSTERS, ...POSTERS].map(({ g, p }, index) => (
          <div
            key={index}
            className={`relative aspect-[2/3] w-24 shrink-0 overflow-hidden rounded-lg bg-linear-to-b ring-1 ring-white/[0.06] sm:w-28 ${g}`}
          >
            <div className="absolute inset-x-2 top-2 h-1.5 w-10 rounded-full bg-white/20" />
            {p > 0 && (
              <div className="absolute inset-x-0 bottom-0 h-0.5 bg-white/15">
                <div className="h-full bg-accent-strong" style={{ width: `${p}%` }} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Image-free rendering of the desktop app: discover rows above, the player bar below. */
export function AppPreview() {
  return (
    <div aria-hidden className="relative mx-auto max-w-5xl">
      <div className="absolute -inset-px rounded-[1.35rem] bg-linear-to-b from-white/15 via-white/5 to-transparent" />
      <div className="relative overflow-hidden rounded-[1.3rem] bg-ink-900 text-left shadow-[0_40px_120px_-30px_rgb(132_60_251/0.45)]">
        {/* Title bar */}
        <div className="flex h-10 items-center gap-2 border-b border-white/[0.06] px-4">
          <span className="size-3 rounded-full bg-white/10" />
          <span className="size-3 rounded-full bg-white/10" />
          <span className="size-3 rounded-full bg-white/10" />
          <div className="mx-auto flex h-6 w-64 items-center gap-2 rounded-md bg-white/[0.05] px-2 text-[11px] text-ink-400">
            <Search className="size-3" />
            Search movies and shows
            <kbd className="ml-auto rounded border border-white/10 px-1 font-sans text-[10px]">
              ⌘K
            </kbd>
          </div>
        </div>

        <div className="flex">
          {/* Sidebar */}
          <div className="hidden w-44 shrink-0 flex-col gap-1 border-r border-white/[0.06] bg-ink-950/60 p-3 sm:flex">
            <div className="mb-3 flex items-center gap-2 px-2 py-1">
              <KiroMark className="size-5" />
              <span className="text-sm font-semibold text-ink-50">Kiro</span>
            </div>
            {NAV.map(({ icon: Icon, label, active }) => (
              <div
                key={label}
                className={
                  active
                    ? 'flex items-center gap-2.5 rounded-lg bg-white/[0.07] px-2.5 py-1.5 text-[13px] text-ink-50'
                    : 'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] text-ink-400'
                }
              >
                <Icon className="size-3.5" />
                {label}
              </div>
            ))}
          </div>

          {/* Content */}
          <div className="flex min-w-0 flex-1 flex-col gap-4 p-4 sm:p-5">
            <div className="relative h-36 shrink-0 overflow-hidden rounded-xl bg-linear-to-br from-[#2b2160] via-[#161233] to-[#0b1a24] sm:h-44">
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_80%_20%,rgb(93_123_255/0.3),transparent_55%)]" />
              <div className="absolute bottom-4 left-4 space-y-2.5">
                <div className="flex gap-1.5">
                  <span className="rounded bg-accent-strong/80 px-1.5 py-0.5 text-[9px] font-semibold tracking-wider text-ink-950 uppercase">
                    4K HDR
                  </span>
                  <span className="rounded bg-white/15 px-1.5 py-0.5 text-[9px] font-medium tracking-wider text-ink-100 uppercase">
                    Continue
                  </span>
                </div>
                <div className="h-4 w-44 rounded-full bg-white/85" />
                <div className="h-2 w-64 max-w-[55vw] rounded-full bg-white/25" />
              </div>
            </div>

            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-ink-200">Continue watching</span>
                <span className="text-[10px] text-ink-500">See all</span>
              </div>
              <PosterRow />
            </div>
          </div>
        </div>

        {/* Player bar */}
        <div className="relative border-t border-white/[0.06] bg-ink-950/80 px-4 py-3 backdrop-blur">
          <div className="absolute -top-9 right-4 flex items-center gap-1.5 rounded-full border border-white/10 bg-ink-900/90 px-3 py-1 text-[11px] text-ink-100 shadow-lg">
            <SkipForward className="size-3 text-accent-strong" />
            Skip intro
          </div>
          <div className="flex items-center gap-3 sm:gap-4">
            <div className="size-10 shrink-0 rounded-md bg-linear-to-br from-[#4b3a8f] to-[#120f24] ring-1 ring-white/10" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <div className="h-2.5 w-28 rounded-full bg-white/80" />
                <span className="hidden text-[10px] text-ink-500 sm:inline">S2 · E4</span>
              </div>
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10">
                <div className="h-full origin-left rounded-full bg-accent-strong motion-safe:animate-progress" />
              </div>
            </div>
            <div className="flex items-center gap-2 text-ink-300 sm:gap-3">
              <Pause className="size-4 text-ink-50" />
              <SkipForward className="size-4" />
              <Volume2 className="hidden size-4 sm:block" />
              <span className="hidden items-center gap-1 rounded-md border border-white/10 px-1.5 py-0.5 text-[10px] sm:flex">
                <Captions className="size-3" /> EN
              </span>
              <Maximize2 className="hidden size-4 sm:block" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
