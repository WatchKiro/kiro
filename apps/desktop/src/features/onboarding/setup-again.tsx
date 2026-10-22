import { Button } from '@kiro/ui';
import { Sparkles } from 'lucide-react';

import { useSetupStore } from '@/features/onboarding/setup-store';

/** Settings' way back into the first-run setup. */
export function SetupAgain() {
  const show = useSetupStore((state) => state.show);
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-5 py-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink-100">First-run setup</p>
        <p className="mt-0.5 text-[13px] text-ink-400">
          The ways to add addons Kiro offered when it was new.
        </p>
      </div>
      <Button variant="secondary" size="sm" onClick={() => show('again')}>
        <Sparkles aria-hidden className="size-4" />
        Open setup
      </Button>
    </div>
  );
}
