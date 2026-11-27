import { create } from "zustand";
import {
  EMPTY_TOAST_STATE,
  dismissToast,
  pushToast,
  type ToastEntry,
  type ToastKind,
} from "@/core/sprocket-engine";

/**
 * Retro toasts. Session-only: this store is separate from `useMemexStore`, so
 * toasts are never persisted to localStorage or written to the exported JSON.
 * All rules (dedupe, stack limit) live in the pure reducer in `sprocket-engine`.
 */
interface ToastStore {
  toasts: readonly ToastEntry[];
  nextId: number;
  show: (kind: ToastKind) => void;
  dismiss: (id: number) => void;
  /** Removes every toast (used by tests and unmount cleanup). */
  clear: () => void;
}

export const useToastStore = create<ToastStore>()((set, get) => ({
  ...EMPTY_TOAST_STATE,
  show: (kind) => {
    const { toasts, nextId } = get();
    const next = pushToast({ toasts, nextId }, kind);
    if (next.toasts !== toasts) set({ toasts: next.toasts, nextId: next.nextId });
  },
  dismiss: (id) => {
    const { toasts, nextId } = get();
    const next = dismissToast({ toasts, nextId }, id);
    if (next.toasts !== toasts) set({ toasts: next.toasts });
  },
  clear: () => set({ ...EMPTY_TOAST_STATE }),
}));

/** Shows a retro toast from anywhere (event handlers, effects). */
export function showToast(kind: ToastKind): void {
  useToastStore.getState().show(kind);
}

export const selectToasts = (s: ToastStore) => s.toasts;
export const selectDismissToast = (s: ToastStore) => s.dismiss;
