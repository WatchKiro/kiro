import { create } from 'zustand';

/** Whether the keyboard shortcuts overlay (`?`) is open. */
interface ShortcutsHelpState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

export const useShortcutsHelpStore = create<ShortcutsHelpState>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((state) => ({ open: !state.open })),
}));
