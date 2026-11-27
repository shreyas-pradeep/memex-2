"use client";

import { useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { IDLE_THRESHOLD_MS, getGuidanceMessage } from "@/core/sprocket-engine";
import { selectIsGhostScanning } from "@/store/ghost-selectors";
import { useMemexStore, type MemexStore } from "@/store/useMemexStore";
import { useIdleFlag } from "./activity-tracker";

const VIOLET = "#B388FF";
const OBSIDIAN = "#090A0F";

// Primitive selectors: the beacon re-renders only when one of these values
// changes. A card drag changes none of them (the count is the array length).
const selectCardCount = (s: MemexStore) => s.nodes?.length ?? 0;
const selectTrailCount = (s: MemexStore) => s.trails?.length ?? 0;
const selectDiscoveryCount = (s: MemexStore) => s.ghostDiscoveries?.length ?? 0;
const selectActiveTrailId = (s: MemexStore) => s.activeTrailId;
const selectIsPlayingAuto = (s: MemexStore) => s.isPlayingAuto;

/** A pulsing phosphor eye wrapped in slow violet mist (radial gradients, opacity and transform only). */
function PhosphorEyeMist({ still }: { still: boolean }) {
  const mist = (delay: number, from: number, to: number) => ({
    initial: false as const,
    animate: still
      ? { opacity: (from + to) / 2, scale: 1 }
      : { opacity: [from, to, from], scale: [1, 1.18, 1] },
    transition: still
      ? { duration: 0 }
      : { duration: 4.2, delay, repeat: Infinity, ease: "easeInOut" as const },
  });
  return (
    <div aria-hidden="true" className="relative h-9 w-9 shrink-0">
      <motion.div
        {...mist(0, 0.25, 0.6)}
        className="absolute inset-0 rounded-full"
        style={{
          background: "radial-gradient(circle at 50% 50%, rgba(179,136,255,0.55) 0%, rgba(179,136,255,0.16) 45%, rgba(179,136,255,0) 72%)",
        }}
      />
      <motion.div
        {...mist(-2.1, 0.15, 0.45)}
        className="absolute -inset-px rounded-full"
        style={{
          background: "radial-gradient(circle at 40% 60%, rgba(255,178,54,0.2) 0%, rgba(179,136,255,0.1) 50%, rgba(179,136,255,0) 75%)",
        }}
      />
      <svg viewBox="0 0 36 36" className="absolute inset-0 h-full w-full" focusable="false">
        <path
          d="M5 18 C11 10 25 10 31 18 C25 26 11 26 5 18 Z"
          fill={OBSIDIAN}
          stroke={VIOLET}
          strokeWidth="1"
          strokeLinejoin="round"
        />
        <motion.circle
          cx="18"
          cy="18"
          r="4.6"
          fill={VIOLET}
          initial={false}
          animate={still ? { opacity: 0.95, scale: 1 } : { opacity: [0.7, 1, 0.7], scale: [1, 1.12, 1] }}
          transition={still ? { duration: 0 } : { duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
          style={{ transformBox: "fill-box", transformOrigin: "center" }}
        />
        <circle cx="18" cy="18" r="1.7" fill={OBSIDIAN} />
        <circle cx="19.6" cy="16.4" r="0.8" fill="#F4F1EA" />
      </svg>
    </div>
  );
}

/**
 * Context-aware hint bubble in the top-left HUD. The text comes from the pure
 * `getGuidanceMessage`; the bubble re-renders only when the guidance state
 * changes, and its live region announces only that change. Collapsing it is a
 * session-only choice that keeps it quiet until the user brings it back.
 */
export function GhostGuidanceBeacon() {
  const reduce = useReducedMotion() === true;
  const cardCount = useMemexStore(selectCardCount);
  const trailCount = useMemexStore(selectTrailCount);
  const discoveryCount = useMemexStore(selectDiscoveryCount);
  const activeTrailId = useMemexStore(selectActiveTrailId);
  const isPlayingAuto = useMemexStore(selectIsPlayingAuto);
  const isGhostScanning = useMemexStore(selectIsGhostScanning);
  const idle = useIdleFlag();
  const [collapsed, setCollapsed] = useState(false);

  const message = getGuidanceMessage({
    cardCount,
    activeTrailId,
    isPlayingAuto,
    discoveryCount,
    isGhostScanning,
    idleMs: idle ? IDLE_THRESHOLD_MS + 1 : 0,
    trailCount,
  });

  if (collapsed) {
    return (
      <button
        type="button"
        aria-expanded={false}
        onClick={() => setCollapsed(false)}
        className="mt-2 flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-white/10 bg-[#090A0F]/80 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-text-muted transition-colors hover:border-accent-ghost/50 hover:text-accent-ghost focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent-ghost"
      >
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent-ghost" />
        Show ghost hints
      </button>
    );
  }

  return (
    <section
      aria-label="Ghost guidance"
      data-guidance-state={message.id}
      className="mt-2 flex items-start gap-2 rounded-xl border border-accent-ghost/25 bg-[#090A0F]/80 p-2"
    >
      <PhosphorEyeMist still={reduce} />
      <div role="status" aria-live="polite" aria-atomic="true" className="min-w-0 flex-1 pt-0.5">
        <motion.p
          key={message.id}
          initial={reduce ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: reduce ? 0 : 0.25 }}
          className="break-words font-mono text-[11px] leading-snug text-text-primary"
        >
          {message.text}
        </motion.p>
      </div>
      <button
        type="button"
        aria-label="Hide ghost hints"
        title="Hide hints"
        onClick={() => setCollapsed(true)}
        className="shrink-0 cursor-pointer rounded-full border border-white/10 px-1.5 py-0.5 font-mono text-[10px] leading-none text-text-muted transition-colors hover:border-accent-ghost/60 hover:text-accent-ghost focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent-ghost"
      >
        ✕
      </button>
    </section>
  );
}
