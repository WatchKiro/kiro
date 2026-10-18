import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

/**
 * App-shell UI preferences. Feature state (playback, library, addons, ...)
 * lives in feature-scoped stores next to the feature, not here.
 */
interface UiState {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
    }),
    {
      name: 'kiro.ui',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: ({ sidebarCollapsed }) => ({ sidebarCollapsed }),
    },
  ),
);
