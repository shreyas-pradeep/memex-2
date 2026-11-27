"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { motion, useReducedMotion } from "framer-motion";
import { useReactFlow } from "@xyflow/react";
import { restoreSummary, restoreToastMessage } from "@/core/vault-ui";
import type { AssociativeEdge, MemexNode } from "@/core/types";
import { useMemexStore } from "@/store/useMemexStore";
import { showToast } from "@/store/useToastStore";
import {
  incomingCounts,
  selectPendingRestore,
  useVaultSession,
  type PendingRestore,
} from "@/store/useVaultSession";
import { downloadBackup } from "./vault-io";

const SPRING = { type: "spring", stiffness: 300, damping: 28 } as const;
const CAMERA_MS = 800;

const BUTTON =
  "cursor-pointer rounded-xl border px-4 py-2 font-mono text-[11px] font-semibold uppercase tracking-[0.16em] transition-[color,border-color,box-shadow] duration-100 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[#FFB236]";

function DialogBody({ pending }: { pending: PendingRestore }) {
  const reduce = useReducedMotion() === true;
  const { fitView } = useReactFlow<MemexNode, AssociativeEdge>();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descId = useId();
  const [savedBackup, setSavedBackup] = useState(false);
  const [failure, setFailure] = useState<string[] | null>(null);

  const { result } = pending;
  const incoming = incomingCounts(result);

  // Initial focus lands on the safe choice; focus returns to what had it when the dialog closes.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus({ preventScroll: true });
    return () => previous?.focus({ preventScroll: true });
  }, []);

  const cancel = useCallback(() => useVaultSession.getState().cancel(), []);

  const backup = useCallback(() => {
    if (downloadBackup()) setSavedBackup(true);
  }, []);

  const confirm = useCallback(() => {
    const outcome = useMemexStore.getState().importBundle(pending.text);
    if (!outcome.ok) {
      setFailure(outcome.errors);
      return;
    }
    useVaultSession.getState().cancel();
    const counts = {
      cards: outcome.state.nodes.length,
      edges: outcome.state.edges.length,
      trails: outcome.state.trails.length,
    };
    showToast("VAULT", restoreToastMessage(counts));
    // Wait a frame so React Flow has the restored nodes before the camera glides.
    requestAnimationFrame(() => void fitView({ padding: 0.2, duration: CAMERA_MS }));
  }, [pending.text, fitView]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // Keep canvas and dock shortcuts (I, T, /, Delete, arrows) away from the dialog.
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
      return;
    }
    if (e.key === "Tab" && dialogRef.current) {
      const items = [...dialogRef.current.querySelectorAll<HTMLElement>("button:not([disabled])")];
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === dialogRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  const errors = failure ?? (result.ok ? null : result.errors);
  const warnings = result.ok ? result.warnings : [];

  return (
    <div
      className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/70 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
      onKeyDown={onKeyDown}
    >
      <motion.div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        tabIndex={-1}
        initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
        animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1 }}
        transition={reduce ? { duration: 0.15 } : SPRING}
        className="relative flex max-h-full w-full max-w-[560px] flex-col gap-3 overflow-y-auto rounded-2xl border border-[rgba(255,178,54,0.2)] bg-[#141721] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_24px_60px_rgba(0,0,0,0.8)] outline-none"
      >
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-text-muted">Vault · Restore</div>
          <h2 id={titleId} className="font-serif text-xl font-semibold text-text-primary">
            {errors === null ? "Replace the canvas with this vault?" : "This file cannot be restored"}
          </h2>
          <div className="mt-0.5 break-all font-mono text-[11px] text-text-muted">{pending.fileName}</div>
        </div>

        {errors === null && incoming !== null ? (
          <p id={descId} className="font-serif text-[14px] leading-snug text-text-primary">
            {restoreSummary(pending.current, incoming)} The current canvas cannot be recovered afterwards, unless you
            save a backup first.
          </p>
        ) : (
          <p id={descId} className="font-serif text-[14px] leading-snug text-text-muted">
            Nothing was changed. Fix the problems below, or choose another file.
          </p>
        )}

        {errors !== null ? (
          <div role="alert" className="rounded-xl border border-[#B388FF]/50 bg-[#090A0F] p-3">
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#B388FF]">
              {errors.length} {errors.length === 1 ? "problem" : "problems"}
            </div>
            <ul className="mt-1 max-h-48 list-inside list-disc overflow-y-auto font-mono text-[12px] leading-snug text-text-primary">
              {errors.map((message, i) => (
                <li key={`${i}-${message}`} className="break-words">
                  {message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {warnings.length > 0 ? (
          <div className="rounded-xl border border-[#FFB236]/40 bg-[#090A0F] p-3">
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#FFB236]">
              {warnings.length} {warnings.length === 1 ? "warning" : "warnings"}
            </div>
            <ul
              aria-label="Import warnings"
              className="mt-1 max-h-36 list-inside list-disc overflow-y-auto font-mono text-[12px] leading-snug text-text-primary"
            >
              {warnings.map((message, i) => (
                <li key={`${i}-${message}`} className="break-words">
                  {message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          {errors === null ? (
            <>
              <button
                type="button"
                onClick={backup}
                className={`${BUTTON} border-[#FFB236]/50 bg-[#141721] text-[#FFB236] hover:border-[#FFB236]`}
              >
                [Download current backup first]
              </button>
              <span role="status" aria-live="polite" className="font-mono text-[11px] font-semibold text-[#FFB236]">
                {savedBackup ? "✓ BACKUP SAVED" : ""}
              </span>
            </>
          ) : null}
          <span className="ml-auto flex gap-2">
            <button
              ref={cancelRef}
              type="button"
              onClick={cancel}
              className={`${BUTTON} border-white/10 text-text-muted hover:text-text-primary`}
            >
              {errors === null ? "[CANCEL]" : "[CLOSE]"}
            </button>
            {errors === null ? (
              <button
                type="button"
                onClick={confirm}
                className={`${BUTTON} border-[#FFB236] bg-[#FFB236] text-[#090A0F] shadow-[0_2px_0_rgba(0,0,0,0.65)] hover:brightness-110`}
              >
                [REPLACE CANVAS]
              </button>
            ) : null}
          </span>
        </div>
      </motion.div>
    </div>
  );
}

/**
 * The restore confirmation (Spec 09): a modal `alertdialog` shown whenever a
 * `.memex` file is staged (from the Vault menu or a drop). Replacing the canvas
 * is destructive, so the dialog states the counts on both sides, lists the
 * importer's warnings and errors, recommends a backup first, and applies the
 * bundle only on `[REPLACE CANVAS]`. An invalid file shows its errors and no
 * confirm button. No `window.confirm`; Escape and a backdrop click cancel;
 * focus starts on `[CANCEL]`, is kept inside while open and returns afterwards.
 * Mounted inside the React Flow provider so a restore can fit the camera.
 */
export function BundleImportDialog() {
  const pending = useVaultSession(selectPendingRestore);
  if (pending === null || typeof document === "undefined") return null;
  return createPortal(<DialogBody key={`${pending.fileName}:${pending.text.length}`} pending={pending} />, document.body);
}
