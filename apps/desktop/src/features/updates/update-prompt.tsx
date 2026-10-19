import { ArrowDownToLine, RotateCw, X } from 'lucide-react';

import { offeredVersion, useUpdatePolling, useUpdateStore } from '@/features/updates/update-store';

/**
 * "Update available, restart to update", at the foot of the sidebar once the
 * core has downloaded a new version. Installs that can't update themselves
 * (the Linux .deb) get a download link instead. Later hides it until Kiro
 * next starts. Also keeps the update status current (`useUpdatePolling`).
 */
export function UpdatePrompt({ collapsed }: { collapsed: boolean }) {
  useUpdatePolling();
  const status = useUpdateStore((state) => state.status);
  const dismissed = useUpdateStore((state) => state.dismissed);
  const error = useUpdateStore((state) => state.error);
  const install = useUpdateStore((state) => state.install);
  const openDownload = useUpdateStore((state) => state.openDownload);
  const dismiss = useUpdateStore((state) => state.dismiss);

  const version = offeredVersion(status);
  if (!version || version === dismissed) return null;
  const ready = status?.state === 'ready';
  const action = ready ? 'Restart to update' : 'Download the new version';
  const run = () => void (ready ? install() : openDownload());
  const Icon = ready ? RotateCw : ArrowDownToLine;

  if (collapsed) {
    return (
      <div className="flex justify-center px-3 pb-2">
        <button
          type="button"
          onClick={run}
          title={`Kiro ${version}: ${action.toLowerCase()}`}
          aria-label={`Update available: Kiro ${version}. ${action}`}
          className="relative flex size-9.5 cursor-pointer items-center justify-center rounded-[10px] text-accent-strong transition-colors hover:bg-white/[0.06] focus-visible:focus-ring"
        >
          <Icon aria-hidden className="size-[18px]" />
          <span aria-hidden className="absolute top-2 right-2 size-1.5 rounded-full bg-accent" />
        </button>
      </div>
    );
  }

  return (
    <div className="px-3 pb-3">
      <section
        aria-label="Update available"
        className="relative rounded-[12px] border border-accent/25 bg-linear-to-b from-accent/[0.14] to-accent/[0.04] p-3"
      >
        <button
          type="button"
          onClick={dismiss}
          aria-label="Later"
          title="Later"
          className="absolute top-2 right-2 flex size-6 cursor-pointer items-center justify-center rounded-full text-ink-400 transition-colors hover:bg-white/10 hover:text-ink-50 focus-visible:focus-ring"
        >
          <X aria-hidden className="size-3.5" />
        </button>
        <p className="pr-6 text-[13px] font-semibold text-ink-50">Update available</p>
        <p className="mt-0.5 text-xs leading-relaxed text-ink-300">
          {ready ? `Kiro ${version} is ready.` : `Kiro ${version} is out.`}
        </p>
        {error && (
          <p role="alert" className="mt-1 text-xs leading-relaxed text-red-300">
            {error}
          </p>
        )}
        <button
          type="button"
          onClick={run}
          className="mt-2.5 flex h-8 w-full cursor-pointer items-center justify-center gap-1.5 rounded-full bg-ink-50 text-[13px] font-medium text-ink-950 transition-colors hover:bg-white focus-visible:focus-ring"
        >
          <Icon aria-hidden className="size-3.5" />
          {action}
        </button>
      </section>
    </div>
  );
}
