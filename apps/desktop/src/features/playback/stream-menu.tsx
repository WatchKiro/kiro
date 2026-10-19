import { Loader2, Layers } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { Column, ControlPopover, Option } from '@/features/playback/track-menu';
import type { StreamSwitching } from '@/features/playback/use-stream-switching';
import { describeStream, type RankedStream } from '@/features/title/stream-ranking';

/**
 * The control bar's Streams button: this video's streams, ranked as
 * one-click Play ranks them, with the one playing checked. Picking another
 * carries on from the current position.
 */
export function StreamsMenu({
  streams,
  onOpenChange,
}: {
  streams: StreamSwitching;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <ControlPopover
      label="Streams"
      icon={<Layers aria-hidden className="size-5" />}
      onOpenChange={onOpenChange}
      className="w-[32rem]"
    >
      <StreamChoices streams={streams} />
    </ControlPopover>
  );
}

/**
 * The streams to choose from: the ranked ones, then those the stream
 * settings filter out (they can still be picked, as on the title page).
 */
export function StreamChoices({ streams }: { streams: StreamSwitching }) {
  const { ranking, settled, current, failed, pick } = streams;
  // Open on the stream playing, wherever it ranks.
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const column = list.current;
    const option = column?.querySelector('[aria-checked="true"]');
    if (!column || !option) return;
    // Scrolls the list only (scrollIntoView would also move the player).
    const { top, height } = option.getBoundingClientRect();
    const box = column.getBoundingClientRect();
    column.scrollTop += top - box.top - (box.height - height) / 2;
  }, []);
  const row = (choice: RankedStream, reasons?: string[]) => {
    const playing = choice.url === current && !failed.includes(current);
    return (
      <Option
        key={`${choice.addon.transportUrl}#${choice.index}`}
        selected={choice.url === current}
        title={describeStream(choice)}
        detail={
          failed.includes(choice.url)
            ? 'Didn’t play'
            : [playing ? 'Playing' : undefined, reasons?.join(', '), releaseName(choice)]
                .filter(Boolean)
                .join(' · ')
        }
        onSelect={() => pick(choice)}
      />
    );
  };
  return (
    <Column ref={list} title="Streams">
      {ranking.playable.map((choice) => row(choice))}
      {ranking.playable.length === 0 && settled && (
        <p className="px-3 py-2 text-sm text-ink-500">No streams found</p>
      )}
      {!settled && (
        <p role="status" className="flex items-center gap-2 px-3 py-2 text-xs text-ink-500">
          <Loader2 aria-hidden className="size-3 animate-spin" />
          Looking for more streams…
        </p>
      )}
      {ranking.filtered.length > 0 && (
        <div className="mt-2 border-t border-white/[0.08] pt-2">
          <p className="px-3 pt-1 pb-1 text-xs text-ink-400">
            Filtered out by your stream settings
          </p>
          {ranking.filtered.map((choice) => row(choice, choice.reasons))}
        </div>
      )}
    </Column>
  );
}

/** The release's name as the addon gives it, e.g. `Film.2024.2160p.WEB-DL…`. */
function releaseName({ stream }: Pick<RankedStream, 'stream'>) {
  const text = stream.description ?? stream.title ?? stream.behaviorHints?.filename;
  return text?.split('\n')[0]?.trim() || stream.name?.split('\n')[0]?.trim();
}
