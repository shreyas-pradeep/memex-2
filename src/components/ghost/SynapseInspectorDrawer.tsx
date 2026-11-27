"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { confidencePercent } from "@/core/ghost-engine";
import { EDGE_COLORS, type MemexNodeData } from "@/core/types";
import { selectNodeData, selectSelectedDiscovery } from "@/store/ghost-selectors";
import { useMemexStore } from "@/store/useMemexStore";
import { rgba, skinFor } from "../canvas/card-skins";

const SPRING = { type: "spring", stiffness: 300, damping: 28 } as const;
const GHOST = EDGE_COLORS.ghost;
const HUMAN = EDGE_COLORS.human;

function snippet(text: string, max = 150): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 40)).trimEnd()}…`;
}

function CardSnippet({
  label,
  data,
  accent,
}: {
  label: string;
  data: MemexNodeData | undefined;
  accent: string;
}) {
  const skin = data ? skinFor(data.cardType) : null;
  return (
    <section
      aria-label={label}
      className="rounded-xl border border-white/10 bg-[#090A0F]/80 p-3 shadow-[inset_0_2px_6px_rgba(0,0,0,0.5)]"
      style={skin ? { borderLeft: `3px solid ${skin.accent}` } : undefined}
    >
      <div
        className="font-mono text-[10px] uppercase tracking-[0.2em]"
        style={{ color: accent }}
      >
        {label}
        {data ? ` · ${data.archivalId}` : ""}
      </div>
      {data ? (
        <>
          <h3 className="mt-1 font-serif text-[15px] font-semibold leading-snug text-text-primary">
            {data.title}
          </h3>
          <p className="mt-1 font-serif text-[12px] leading-snug text-text-muted">
            {snippet(data.content)}
          </p>
          <div className="mt-2 font-mono text-[10px] uppercase tracking-wider text-text-muted">
            <span
              className="mr-1 rounded-full px-1.5 py-px font-semibold"
              style={{
                color: skin?.accent,
                border: `1px solid ${skin ? rgba(skin.accent, 0.5) : "transparent"}`,
              }}
            >
              {skin?.label}
            </span>
            {data.tags.length > 0 ? ` ${data.tags.slice(0, 4).join(" / ")}` : ""}
          </div>
        </>
      ) : (
        <p className="mt-1 font-mono text-[11px] text-text-muted">Card unavailable.</p>
      )}
    </section>
  );
}

const btn =
  "cursor-pointer rounded-xl border px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-[0.16em] shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_2px_0_rgba(0,0,0,0.65)] transition-[color,border-color,transform] duration-100 active:translate-y-[2px] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2";

/** Side drawer that explains one ghost discovery and lets the user act on it. */
export function SynapseInspectorDrawer() {
  const discovery = useMemexStore(selectSelectedDiscovery);
  const sourceSelector = useMemo(() => selectNodeData(discovery?.sourceId), [discovery?.sourceId]);
  const targetSelector = useMemo(() => selectNodeData(discovery?.targetId), [discovery?.targetId]);
  const source = useMemexStore(sourceSelector);
  const target = useMemexStore(targetSelector);
  const panelRef = useRef<HTMLElement | null>(null);

  const open = discovery !== null;
  const discoveryId = discovery?.id ?? null;

  const close = useCallback(() => useMemexStore.getState().selectGhostDiscovery(null), []);
  const accept = useCallback(() => {
    if (discoveryId !== null) useMemexStore.getState().acceptGhostDiscovery(discoveryId);
  }, [discoveryId]);
  const dismiss = useCallback(() => {
    if (discoveryId !== null) useMemexStore.getState().dismissGhostDiscovery(discoveryId);
  }, [discoveryId]);
  const walk = useCallback(() => {
    if (discoveryId !== null) useMemexStore.getState().convertDiscoveryToTrail(discoveryId);
  }, [discoveryId]);

  // Escape closes the drawer while it is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  // Move focus into the drawer when it opens so keyboard users land on it.
  useEffect(() => {
    if (discoveryId !== null) panelRef.current?.focus({ preventScroll: true });
  }, [discoveryId]);

  const percent = discovery ? confidencePercent(discovery.confidence) : 0;

  return (
    <AnimatePresence>
      {discovery ? (
        <motion.aside
          key="synapse-drawer"
          ref={panelRef}
          role="dialog"
          aria-modal="false"
          aria-labelledby="synapse-drawer-title"
          tabIndex={-1}
          initial={{ x: "110%", opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: "110%", opacity: 0 }}
          transition={SPRING}
          className="absolute top-4 right-4 bottom-4 z-30 flex w-[min(360px,calc(100vw-2rem))] flex-col gap-3 overflow-y-auto rounded-2xl border bg-[#141721] p-4 outline-none"
          style={{
            borderColor: `${GHOST}66`,
            boxShadow: `inset 0 1px 0 rgba(255,255,255,0.07), 0 12px 36px rgba(0,0,0,0.6), 0 0 22px ${GHOST}33`,
          }}
        >
          <header className="flex items-start justify-between gap-2">
            <div>
              <div
                className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em]"
                style={{ color: GHOST }}
              >
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: GHOST, boxShadow: `0 0 8px 2px ${GHOST}99` }}
                />
                Ghost Synapse
              </div>
              <h2
                id="synapse-drawer-title"
                className="mt-1 font-serif text-lg font-semibold text-text-primary"
              >
                Synapse Inspector
              </h2>
            </div>
            <button
              type="button"
              onClick={close}
              aria-label="Close synapse inspector"
              className="cursor-pointer rounded-lg border border-white/10 px-2 py-1 font-mono text-[11px] text-text-muted hover:border-accent-ghost/60 hover:text-accent-ghost focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent-ghost"
            >
              Esc
            </button>
          </header>

          <CardSnippet label="Source" data={source} accent={HUMAN} />
          <div
            aria-hidden="true"
            className="text-center font-mono text-[11px] tracking-[0.3em]"
            style={{ color: GHOST }}
          >
            ⚡ ─ ─ ─ ⚡
          </div>
          <CardSnippet label="Target" data={target} accent={HUMAN} />

          <section aria-label="Bridge rationale">
            <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-muted">
              Bridge rationale
            </div>
            <p className="mt-1 font-serif text-[13px] leading-snug text-text-primary">
              {discovery.rationale}
            </p>
          </section>

          <section aria-label="Confidence telemetry">
            <div className="flex items-baseline justify-between font-mono text-[10px] uppercase tracking-[0.2em] text-text-muted">
              <span>Confidence</span>
              <span className="text-[13px] font-semibold" style={{ color: GHOST }}>
                {percent}%
              </span>
            </div>
            <div
              role="meter"
              aria-label="Synapse confidence"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              className="mt-1 h-2 overflow-hidden rounded-full bg-[#090A0F] shadow-[inset_0_1px_3px_rgba(0,0,0,0.7)]"
            >
              <motion.div
                key={discovery.id}
                initial={{ scaleX: 0 }}
                animate={{ scaleX: percent / 100 }}
                transition={SPRING}
                className="h-full w-full origin-left rounded-full"
                style={{ background: GHOST, boxShadow: `0 0 10px ${GHOST}99` }}
              />
            </div>
          </section>

          <div className="mt-auto flex flex-col gap-2">
            <button
              type="button"
              onClick={accept}
              className={`${btn} border-accent-human/60 bg-[#161922] text-accent-human hover:border-accent-human focus-visible:outline-accent-human`}
            >
              Accept Connection
            </button>
            <button
              type="button"
              onClick={walk}
              className={`${btn} border-accent-ghost/60 bg-[#161922] text-accent-ghost hover:border-accent-ghost focus-visible:outline-accent-ghost`}
            >
              Walk Ghost Trail
            </button>
            <button
              type="button"
              onClick={dismiss}
              className={`${btn} border-white/10 bg-[#090A0F] text-text-muted hover:border-white/30 hover:text-text-primary focus-visible:outline-white/60`}
            >
              Dismiss
            </button>
          </div>
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
}
