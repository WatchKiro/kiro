import { create } from 'zustand';

/** A short notice at the bottom of the window, such as "Removed …" with Undo. */
export interface Toast {
  id: number;
  message: string;
  /** A button beside the message, such as Undo. Pressing it closes the notice. */
  action?: { label: string; run: () => unknown };
  /** An error: shown longer, in the error colour. */
  error?: boolean;
  /**
   * Put focus on the action (the change was made with the keys, so the
   * button can be reached without a mouse). When the notice closes with
   * focus inside, focus goes to `returnFocus()`.
   */
  focus?: boolean;
  returnFocus?: () => HTMLElement | null | undefined;
}

interface ToastState {
  /** One at a time: a new notice replaces the one showing. */
  toast: Toast | null;
  show: (toast: Omit<Toast, 'id'>) => void;
  /** Closes the notice `id`, if it is still the one showing. */
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToastStore = create<ToastState>()((set) => ({
  toast: null,
  show: (toast) => set({ toast: { ...toast, id: nextId++ } }),
  dismiss: (id) => set((state) => (state.toast?.id === id ? { toast: null } : state)),
}));

export function showToast(toast: Omit<Toast, 'id'>) {
  useToastStore.getState().show(toast);
}
