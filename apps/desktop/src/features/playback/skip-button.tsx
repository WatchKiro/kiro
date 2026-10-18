import { Button } from '@kiro/ui';
import { cx } from '@kiro/utils';
import { ChevronsRight, RotateCcw, X } from 'lucide-react';

import { skipLabel, type SkipSegment } from '@/features/playback/chapter-skip';

/** "Skip intro" / "Skip credits" over the video, while playback is in that part. */
export function SkipButton({
  segment,
  onSkip,
  className,
}: {
  segment: SkipSegment;
  onSkip: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      // Where the keys start while it shows over hidden controls.
      data-nav-start
      onClick={onSkip}
      className={cx(
        'flex animate-[kiro-fade-in_300ms_ease-out] cursor-pointer items-center gap-2 rounded-full border border-white/25 bg-ink-950/70 py-2.5 pr-4 pl-5 text-[15px] font-semibold text-ink-50 shadow-2xl shadow-black/50 backdrop-blur-xl transition-colors hover:border-ink-50 hover:bg-ink-50 hover:text-ink-950 focus-visible:focus-ring',
        className,
      )}
    >
      {skipLabel(segment.kind)}
      <ChevronsRight aria-hidden className="size-5" />
    </button>
  );
}

const SKIPPED: Record<SkipSegment['kind'], [notice: string, undo: string]> = {
  intro: ['Skipped intro', 'Watch intro'],
  recap: ['Skipped recap', 'Watch recap'],
  credits: ['Skipped credits', 'Watch credits'],
  preview: ['Skipped preview', 'Watch preview'],
};

/** After an automatic skip: what was skipped, and a way back to it. */
export function AutoSkippedNotice({
  segment,
  onUndo,
  onDismiss,
  className,
}: {
  segment: SkipSegment;
  onUndo: () => void;
  onDismiss: () => void;
  className?: string;
}) {
  const [notice, undo] = SKIPPED[segment.kind];
  return (
    <div
      role="status"
      className={cx(
        'flex animate-[kiro-fade-in_300ms_ease-out] items-center gap-1 rounded-full border border-white/10 bg-ink-900/90 py-1.5 pr-1.5 pl-4 text-sm text-ink-100 shadow-2xl shadow-black/50 backdrop-blur',
        className,
      )}
    >
      <span>{notice}</span>
      <Button variant="ghost" size="sm" onClick={onUndo} className="ml-2">
        <RotateCcw aria-hidden className="size-3.5" />
        {undo}
      </Button>
      <Button variant="ghost" size="sm" onClick={onDismiss} aria-label="Dismiss">
        <X aria-hidden className="size-3.5" />
      </Button>
    </div>
  );
}
