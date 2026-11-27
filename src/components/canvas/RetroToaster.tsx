"use client";

import { useEffect } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { TOAST_DURATION_MS, type ToastEntry } from "@/core/sprocket-engine";
import { selectDismissToast, selectToasts, useToastStore } from "@/store/useToastStore";
import { useMemexStore, type MemexStore } from "@/store/useMemexStore";

const SPRING = { type: "spring", stiffness: 300, damping: 28 } as const;

// True while the Synapse Inspector drawer (top-right, 360px) is open.
const selectDrawerOpen = (s: MemexStore) => s.selectedGhostDiscoveryId !== null;

function ToastCard({
  toast,
  onDismiss,
  reduce,
}: {
  toast: ToastEntry;
  onDismiss: (id: number) => void;
  reduce: boolean;
}) {
  const { id } = toast;
  // One timer per toast; cleared when the toast goes away for any reason.
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(id), TOAST_DURATION_MS);
    return () => clearTimeout(timer);
  }, [id, onDismiss]);

  const violet = toast.kind === "ARXIV_INVALID" || toast.kind === "NO_AUTO_TRAIL";
  const accent = violet ? "#B388FF" : "#FFB236";
  return (
    <motion.div
      layout={reduce ? false : "position"}
      initial={{ opacity: 0, x: reduce ? 0 : 32 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: reduce ? 0 : 32 }}
      transition={reduce ? { duration: 0.15 } : SPRING}
      data-toast-kind={toast.kind}
      className="pointer-events-auto relative rounded-xl bg-[#141721] p-3 pr-9"
      style={{
        border: `1px solid ${accent}66`,
        borderLeft: `3px solid ${accent}`,
        boxShadow: `inset 0 1px 0 rgba(255,255,255,0.06), 0 10px 28px rgba(0,0,0,0.7), 0 0 14px ${accent}22`,
      }}
    >
      <div className="font-mono text-[10px] uppercase tracking-[0.2em]" style={{ color: accent }}>
        {toast.label}
      </div>
      <p className="mt-1 font-serif text-[13px] leading-snug text-text-primary">{toast.message}</p>
      <button
        type="button"
        aria-label="Dismiss notice"
        onClick={() => onDismiss(id)}
        className="absolute right-2 top-2 cursor-pointer rounded-full border border-white/10 px-1.5 py-0.5 font-mono text-[10px] leading-none text-text-muted transition-colors hover:border-accent-human hover:text-accent-human focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent-human"
      >
        ✕
      </button>
    </motion.div>
  );
}

/**
 * Brass-and-phosphor toast stack, mounted once. Fixed at the top-right (above
 * modals, so a toast raised by the Platen dialog is visible) and moved left of
 * the Synapse Inspector drawer while that is open. The container ignores
 * pointer events; only the toasts take them. Live region: polite.
 */
export function RetroToaster() {
  const reduce = useReducedMotion() === true;
  const toasts = useToastStore(selectToasts);
  const dismiss = useToastStore(selectDismissToast);
  const drawerOpen = useMemexStore(selectDrawerOpen);

  return (
    <div
      aria-live="polite"
      aria-relevant="additions text"
      aria-label="Notices"
      role="region"
      className={`pointer-events-none fixed z-[2100] flex w-[min(340px,calc(100vw-2rem))] flex-col gap-2 right-4 ${
        drawerOpen
          ? "top-4 min-[900px]:right-[calc(min(360px,100vw-2rem)+2rem)] min-[900px]:top-24"
          : "top-4"
      }`}
    >
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <ToastCard key={t.id} toast={t} onDismiss={dismiss} reduce={reduce} />
        ))}
      </AnimatePresence>
    </div>
  );
}
