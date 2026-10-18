import { Button, buttonVariants } from '@kiro/ui';
import { formatDuration } from '@kiro/utils';
import { Play, RotateCcw, X } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';

/** Shown after playback resumed from saved progress, with a way to start over. */
export function ResumedNotice({
  position,
  onStartOver,
  onDismiss,
  className,
}: {
  position: number;
  onStartOver: () => void;
  onDismiss: () => void;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={`flex items-center gap-1 rounded-full border border-white/10 bg-ink-900/90 py-1.5 pr-1.5 pl-4 text-sm text-ink-100 shadow-2xl shadow-black/50 backdrop-blur ${className ?? ''}`}
    >
      <span>
        Resumed from <span className="tabular-nums">{formatDuration(position)}</span>
      </span>
      <Button variant="ghost" size="sm" onClick={onStartOver} className="ml-2">
        <RotateCcw aria-hidden className="size-3.5" />
        Start over
      </Button>
      <Button variant="ghost" size="sm" onClick={onDismiss} aria-label="Dismiss">
        <X aria-hidden className="size-3.5" />
      </Button>
    </div>
  );
}

/**
 * Asks whether to resume from saved progress before the stream opens
 * (Settings → Playback → Resume playback: Ask). Resume has focus, so Enter
 * resumes.
 */
export function ResumePrompt({
  position,
  onAnswer,
  className,
}: {
  position: number;
  onAnswer: (resume: boolean) => void;
  className?: string;
}) {
  const headingId = useId();
  const resumeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => resumeRef.current?.focus(), []);

  return (
    <div
      role="dialog"
      aria-labelledby={headingId}
      // Arrows stay on its two buttons (rather than seeking behind it).
      data-nav-layer
      className={`flex flex-col items-center gap-4 rounded-card border border-white/10 bg-ink-900/90 px-6 py-5 text-center shadow-2xl shadow-black/50 backdrop-blur ${className ?? ''}`}
    >
      <p id={headingId} className="text-[15px] font-medium text-ink-50">
        Resume from <span className="tabular-nums">{formatDuration(position)}</span>?
      </p>
      <div className="flex gap-2">
        <button
          ref={resumeRef}
          type="button"
          onClick={() => onAnswer(true)}
          className={buttonVariants({ size: 'sm' })}
        >
          <Play aria-hidden className="size-3.5 fill-current" />
          Resume
        </button>
        <Button variant="secondary" size="sm" onClick={() => onAnswer(false)}>
          <RotateCcw aria-hidden className="size-3.5" />
          Start from the beginning
        </Button>
      </div>
    </div>
  );
}
