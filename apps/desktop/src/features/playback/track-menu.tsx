import type { MediaTrack } from '@kiro/player-core';
import { Button } from '@kiro/ui';
import { cx } from '@kiro/utils';
import { Captions, Check, ChevronRight, Loader2 } from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type FormEvent,
  type ReactNode,
  type Ref,
} from 'react';

import type { AddonSubtitle, SubtitleGroup } from '@/features/playback/addon-subtitles';
import type { SubtitleSourcesState } from '@/features/playback/subtitle-sources';
import { describeTrack } from '@/features/playback/track-labels';
import { isTextField } from '@/features/remote/keys';
import { focusWithKeys, startOfLayer } from '@/features/remote/remote-navigation';

/** Addon subtitles for the Subtitles column. */
export interface AddonSubtitlesMenu {
  groups: readonly SubtitleGroup[];
  state: Pick<SubtitleSourcesState, 'searching' | 'loaded' | 'loading' | 'failed'>;
}

interface TracksMenuProps {
  audioTracks: readonly MediaTrack[];
  /** The stream's own subtitles, and files added by URL. */
  subtitleTracks: readonly MediaTrack[];
  addonSubtitles: AddonSubtitlesMenu;
  audioTrackId: string | null;
  subtitleTrackId: string | null;
  onSelectAudio: (trackId: string) => void;
  onSelectSubtitle: (trackId: string | null) => void;
  onSelectAddonSubtitle: (subtitle: AddonSubtitle) => void;
  /** Loads an https subtitle file; rejects with a message to show. */
  onAddSubtitle: (url: string) => Promise<void>;
  /** Reports whether the panel is open, so the controls stay up meanwhile. */
  onOpenChange?: (open: boolean) => void;
}

/**
 * The control bar's subtitles and audio button: one panel with a column for
 * each, opening above the button (see {@link ControlPopover}).
 */
export function TracksMenu({
  audioTracks,
  subtitleTracks,
  addonSubtitles,
  audioTrackId,
  subtitleTrackId,
  onSelectAudio,
  onSelectSubtitle,
  onSelectAddonSubtitle,
  onAddSubtitle,
  onOpenChange,
}: TracksMenuProps) {
  return (
    <ControlPopover
      label="Subtitles and audio"
      icon={<Captions aria-hidden className="size-5.5" />}
      onOpenChange={onOpenChange}
      className="grid w-[38rem] grid-cols-[3fr_2fr] divide-x divide-white/[0.08]"
    >
      <Column title="Subtitles">
        <Option
          selected={subtitleTrackId === null}
          title="Off"
          onSelect={() => onSelectSubtitle(null)}
        />
        {subtitleTracks.map((track) => (
          <Option
            key={track.id}
            selected={track.id === subtitleTrackId}
            {...describeTrack(track)}
            onSelect={() => onSelectSubtitle(track.id)}
          />
        ))}
        <AddonSubtitles
          {...addonSubtitles}
          subtitleTrackId={subtitleTrackId}
          onSelect={onSelectAddonSubtitle}
        />
        <AddSubtitle onAdd={onAddSubtitle} />
      </Column>
      <Column title="Audio">
        {audioTracks.length === 0 ? (
          <p className="px-3 py-2 text-sm text-ink-500">No audio tracks</p>
        ) : (
          audioTracks.map((track) => (
            <Option
              key={track.id}
              selected={track.id === audioTrackId}
              {...describeTrack(track)}
              onSelect={() => onSelectAudio(track.id)}
            />
          ))
        )}
      </Column>
    </ControlPopover>
  );
}

/**
 * A control bar button with a panel opening above it. Escape (or Backspace)
 * or a click outside closes it. Opened with the keys, focus moves to the
 * panel's selected option (or its `data-nav-start`) and arrows stay in the
 * panel; closing it with the keys returns to the button.
 */
export function ControlPopover({
  label,
  icon,
  badge,
  onOpenChange,
  className,
  children,
}: {
  /** Names the button and the panel. */
  label: string;
  icon: ReactNode;
  /** A short value over the button's corner, such as a speed. */
  badge?: string | undefined;
  /** Reports whether the panel is open, so the controls stay up meanwhile. */
  onOpenChange?: ((open: boolean) => void) | undefined;
  /** The panel's size and layout. */
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpenState] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const setOpen = (next: boolean) => {
    setOpenState(next);
    onOpenChange?.(next);
  };

  useEffect(() => {
    if (!open) return;
    // Opened from the button with the keys: start on the selected option.
    if (trigger.current?.matches(':focus-visible, [data-nav-focus]') && panel.current) {
      const start = startOfLayer(panel.current);
      if (start) focusWithKeys(start);
    }
    const close = () => {
      setOpenState(false);
      onOpenChange?.(false);
    };
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      const back =
        event.key === 'Escape' ||
        (event.key === 'Backspace' && !isTextField(document.activeElement));
      if (!back) return;
      if (panel.current?.contains(document.activeElement) && trigger.current) {
        focusWithKeys(trigger.current);
      }
      close();
    };
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onOpenChange]);

  return (
    <div ref={root} className="relative">
      <ControlButton
        ref={trigger}
        label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {icon}
        {badge && (
          <span
            aria-hidden
            className="absolute -top-0.5 -right-1 rounded-full bg-accent px-1.5 py-px text-[10px] leading-4 font-semibold text-white tabular-nums"
          >
            {badge}
          </span>
        )}
      </ControlButton>
      {open && (
        <div
          ref={panel}
          role="dialog"
          aria-label={label}
          data-nav-layer
          className={cx(
            'absolute right-0 bottom-full mb-4 overflow-hidden rounded-2xl border border-white/10 bg-ink-900/90 shadow-2xl shadow-black/60 backdrop-blur-xl',
            className,
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/** A round icon button on the player's control bar. */
export function ControlButton({
  label,
  className,
  children,
  ref,
  ...props
}: {
  label: string;
  className?: string;
  children: ReactNode;
  ref?: Ref<HTMLButtonElement>;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'>) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      className={cx(
        'relative flex size-11 cursor-pointer items-center justify-center rounded-full text-ink-50 transition-colors hover:bg-white/12 focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-40',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

function Column({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div
      role="radiogroup"
      aria-label={title}
      data-nav-group
      className="max-h-[55vh] overflow-y-auto p-2"
    >
      <p className="px-3 pt-2 pb-2 text-xs font-semibold tracking-[0.08em] text-ink-400 uppercase">
        {title}
      </p>
      {children}
    </div>
  );
}

/**
 * Subtitles from addons, a section per language: preferred languages (and
 * the one showing) open, the rest closed until clicked.
 */
function AddonSubtitles({
  groups,
  state,
  subtitleTrackId,
  onSelect,
}: AddonSubtitlesMenu & {
  subtitleTrackId: string | null;
  onSelect: (subtitle: AddonSubtitle) => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  if (groups.length === 0 && !state.searching) return null;

  const isShowing = (subtitle: AddonSubtitle) =>
    subtitleTrackId !== null && state.loaded[subtitle.url] === subtitleTrackId;

  return (
    <div className="mt-2 border-t border-white/[0.08] pt-2">
      <p className="flex items-center gap-2 px-3 pt-1 pb-1 text-xs text-ink-400">
        From addons
        {state.searching && (
          <span className="flex items-center gap-1 text-ink-500" role="status">
            <Loader2 aria-hidden className="size-3 animate-spin" />
            Searching…
          </span>
        )}
      </p>
      {groups.map((group) => {
        const key = group.code ?? '';
        const open =
          expanded[key] ??
          (group.preferred ||
            groups.length <= 2 ||
            group.options.some((option) => isShowing(option.subtitle)));
        return (
          <div key={key}>
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setExpanded((current) => ({ ...current, [key]: !open }))}
              className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-sm text-ink-200 transition-colors hover:bg-white/[0.08] focus-visible:bg-white/[0.08] focus-visible:focus-ring focus-visible:-outline-offset-2"
            >
              <ChevronRight
                aria-hidden
                className={cx(
                  'size-4 shrink-0 text-ink-500 transition-transform',
                  open && 'rotate-90',
                )}
              />
              <span className="min-w-0 flex-1 truncate">{group.name}</span>
              <span className="text-xs text-ink-500 tabular-nums">{group.options.length}</span>
            </button>
            {open &&
              group.options.map(({ subtitle, title, detail }) => {
                const loading = state.loading.includes(subtitle.url);
                const failed = state.failed.includes(subtitle.url);
                return (
                  <Option
                    key={subtitle.url}
                    selected={isShowing(subtitle)}
                    title={title}
                    detail={loading ? 'Loading…' : failed ? 'Couldn’t load — try again' : detail}
                    busy={loading}
                    onSelect={() => onSelect(subtitle)}
                  />
                );
              })}
          </div>
        );
      })}
    </div>
  );
}

function Option({
  selected,
  title,
  detail,
  busy = false,
  onSelect,
}: {
  selected: boolean;
  title: string;
  detail?: string | undefined;
  /** Being loaded: a spinner in place of the check. */
  busy?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cx(
        'flex w-full cursor-pointer items-start gap-2.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-white/[0.08] focus-visible:bg-white/[0.08] focus-visible:focus-ring focus-visible:-outline-offset-2',
        selected ? 'text-ink-50' : 'text-ink-300',
      )}
    >
      {busy ? (
        <Loader2 aria-hidden className="mt-0.5 size-4 shrink-0 animate-spin text-ink-400" />
      ) : (
        <Check
          aria-hidden
          className={cx('mt-0.5 size-4 shrink-0 text-accent-strong', !selected && 'invisible')}
        />
      )}
      <span className="min-w-0">
        <span className={cx('block truncate text-sm', selected && 'font-medium')}>{title}</span>
        {detail && <span className="block truncate text-xs text-ink-500">{detail}</span>}
      </span>
    </button>
  );
}

function AddSubtitle({ onAdd }: { onAdd: (url: string) => Promise<void> }) {
  const [url, setUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setAdding(true);
    setError(null);
    onAdd(url.trim()).then(
      () => {
        setUrl('');
        setAdding(false);
      },
      (reason: unknown) => {
        setAdding(false);
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };

  return (
    <form onSubmit={submit} className="mt-2 space-y-2 border-t border-white/[0.08] px-3 pt-3 pb-2">
      <label className="block text-xs text-ink-400" htmlFor="subtitle-url">
        Add a subtitle file (https)
      </label>
      <div className="flex gap-2">
        <input
          id="subtitle-url"
          type="url"
          required
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://…/subtitles.srt"
          className="h-8 min-w-0 flex-1 rounded-full border border-white/10 bg-white/5 px-3 text-xs text-ink-100 placeholder:text-ink-500 focus:outline-2 focus:outline-accent"
        />
        <Button type="submit" size="sm" disabled={adding || !url.trim()}>
          {adding ? 'Adding…' : 'Add'}
        </Button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </form>
  );
}
