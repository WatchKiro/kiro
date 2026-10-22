import { create } from 'zustand';

import { profilesStore } from '@/features/profiles/profiles-store';

/**
 * Whether the first-run setup is open: at `launch` (the active profile's
 * setup is pending), or `again` from Settings. Closing it records how it
 * ended for the active profile while that is still pending.
 */
interface SetupState {
  open: 'launch' | 'again' | null;
  show: (from: 'launch' | 'again') => void;
  finish: (outcome: 'completed' | 'skipped') => void;
}

export const useSetupStore = create<SetupState>()((set) => ({
  open: null,
  show: (from) => set({ open: from }),
  finish(outcome) {
    set({ open: null });
    // If this fails, the profile is still pending and the setup shows next launch.
    void profilesStore
      .getState()
      .finishFirstRun(outcome)
      .catch(() => undefined);
  },
}));
