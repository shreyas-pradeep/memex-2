"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { generateTrailBriefing } from "@/core/synthesis-engine";
import { EDGE_COLORS } from "@/core/types";
import { ExportBriefingModal } from "../canvas/ExportBriefingModal";
import { selectActiveTrail } from "@/store/trail-selectors";
import { useMemexStore, type MemexStore } from "@/store/useMemexStore";
import { rgba, skinFor } from "../canvas/card-skins";

const SPRING = { type: "spring", stiffness: 300, damping: 28 } as const;

/** Time on each stop while auto-playing. */
export const AUTO_PLAY_MS = 5000;

const selectIndex = (s: MemexStore) => s.activeTrailIndex;
const selectPlaying = (s: MemexStore) => s.isPlayingAuto;
const selectNextStep = (s: MemexStore) => s.nextTrailStep;
const selectPrevStep = (s: MemexStore) => s.prevTrailStep;
const selectToggle = (s: MemexStore) => s.toggleAutoPlay;
const selectExit = (s: MemexStore) => s.exitTrailPlayback;


/** Truncates to `max` characters on a word boundary. */
function preview(text: string, max = 140): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 40)).trimEnd()}…`;
}

/** Looks up the title and content of the card at the active stop. */
function useCurrentCard(nodeId: string | undefined) {
  const node = useMemexStore((s) =>
    nodeId === undefined ? undefined : s.nodes.find((n) => n.id === nodeId),
  );
  return node?.data;
}

/** "The 1945 Lever": the floating bottom dock for cinematic trail playback. */
export function TrailPlaybackDock() {
  const trail = useMemexStore(selectActiveTrail);
  const index = useMemexStore(selectIndex);
  const playing = useMemexStore(selectPlaying);
  const next = useMemexStore(selectNextStep);
  const prev = useMemexStore(selectPrevStep);
  const toggle = useMemexStore(selectToggle);
  const exit = useMemexStore(selectExit);

  // Briefing snapshot taken when the export button is pressed (not on every store change).
  const [briefing, setBriefing] = useState<{ trailId: string; markdown: string } | null>(null);
  const exportOpen = briefing !== null;
  const closeExport = useCallback(() => setBriefing(null), []);
  const openExport = useCallback(() => {
    const { trails, nodes, edges, activeTrailId } = useMemexStore.getState();
    const active = trails.find((t) => t.id === activeTrailId);
    if (!active) return;
    setBriefing({
      trailId: active.id,
      markdown: generateTrailBriefing(active, nodes, edges, {
        generatedDate: new Date().toISOString().slice(0, 10),
      }),
    });
  }, []);
  const total = trail?.nodeIds.length ?? 0;
  const card = useCurrentCard(trail?.nodeIds[index]);
  const accent = trail ? EDGE_COLORS[trail.origin] : EDGE_COLORS.human;
  const atEnd = index >= total - 1;

  // Auto-play: one timer per stop. The progress bar animates over the same
  // duration; completion advances the trail (the store stops auto-play at the end).
  useEffect(() => {
    if (!playing || trail === null) return;
    const timer = window.setTimeout(next, AUTO_PLAY_MS);
    return () => window.clearTimeout(timer);
  }, [playing, index, trail, next]);

  // Keyboard: arrows step, Escape exits (ignored while typing or while the export modal is open).
  useEffect(() => {
    if (trail === null || exportOpen) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target;
      if (
        el instanceof HTMLElement &&
        (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))
      ) {
        return;
      }
      if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowLeft") prev();
      else if (e.key === "Escape") exit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [trail, exportOpen, next, prev, exit]);

  const buttonClass = useMemo(
    () =>
      "cursor-pointer rounded-xl border px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-[0.16em] transition-[color,border-color,opacity] duration-100 disabled:cursor-not-allowed disabled:opacity-35 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2",
    [],
  );

  return (
    <>
      <AnimatePresence>
        {trail !== null && total > 0 ? (
          <motion.section
            key="trail-dock"
            aria-label={`Trail playback: ${trail.title}`}
            initial={{ opacity: 0, y: 40 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 40 }}
            transition={SPRING}
            className="pointer-events-auto absolute bottom-6 left-1/2 z-20 w-[min(640px,calc(100vw-2rem))] -translate-x-1/2"
          >
            <div
              className="relative overflow-hidden rounded-2xl bg-[#141721] p-4"
              style={{
                border: `1px solid ${accent}`,
                boxShadow: `0 0 28px 1px ${rgba(accent, 0.28)}, 0 16px 40px rgba(0, 0, 0, 0.65)`,
              }}
            >
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div
                    className="font-mono text-[10px] uppercase tracking-[0.2em]"
                    style={{ color: accent }}
                  >
                    {trail.origin === "ghost" ? "Ghost Trail" : "Human Trail"} · Stop{" "}
                    {index + 1} of {total}
                  </div>
                  <h2 className="mt-0.5 truncate font-serif text-lg font-semibold text-text-primary">
                    {trail.title}
                  </h2>
                </div>
                <button
                  type="button"
                  aria-label="Exit trail playback"
                  title="Exit (Esc)"
                  onClick={exit}
                  className="cursor-pointer rounded-full border border-white/10 px-2 py-1 font-mono text-xs leading-none text-text-muted transition-colors hover:border-[#ff6b6b] hover:text-[#ff6b6b] focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent-human"
                >
                  ✕
                </button>
              </div>

              <div
                className="mt-3 rounded-xl bg-[#090A0F]/80 px-3 py-2"
                style={{
                  border: `1px solid ${rgba(accent, 0.25)}`,
                  ...(card ? { borderLeft: `3px solid ${skinFor(card.cardType).accent}` } : {}),
                }}
              >
                {card ? (
                  <>
                    <div className="flex items-center gap-2 font-mono text-[10px] tracking-wider text-text-muted">
                      <span>{card.archivalId}</span>
                      <span
                        className="rounded-full px-1.5 py-px font-semibold uppercase"
                        style={{
                          color: skinFor(card.cardType).accent,
                          border: `1px solid ${rgba(skinFor(card.cardType).accent, 0.5)}`,
                        }}
                      >
                        {skinFor(card.cardType).label}
                      </span>
                    </div>
                    <div className="font-serif text-[15px] font-semibold text-text-primary">
                      {card.title}
                    </div>
                    {card.content ? (
                      <p className="mt-0.5 text-[12px] leading-relaxed text-text-muted">
                        {preview(card.content)}
                      </p>
                    ) : null}
                  </>
                ) : (
                  <div className="text-[12px] text-text-muted">Card unavailable.</div>
                )}
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className={`${buttonClass} border-white/10 bg-[#161922] text-text-primary hover:border-white/30 focus-visible:outline-accent-human`}
                  onClick={prev}
                  disabled={index <= 0}
                >
                  ◀ Prev
                </button>
                <button
                  type="button"
                  className={`${buttonClass} border-white/10 bg-[#161922] text-text-primary hover:border-white/30 focus-visible:outline-accent-human`}
                  onClick={next}
                  disabled={atEnd}
                >
                  Next ▶
                </button>
                <button
                  type="button"
                  aria-haspopup="dialog"
                  className={`${buttonClass} bg-[#161922] hover:border-[#B388FF] focus-visible:outline-accent-ghost`}
                  style={{ color: EDGE_COLORS.ghost, borderColor: rgba(EDGE_COLORS.ghost, 0.45) }}
                  onClick={openExport}
                >
                  [⚡ Export Briefing]
                </button>
                <button
                  type="button"
                  aria-pressed={playing}
                  className={`${buttonClass} ml-auto bg-[#161922]`}
                  style={{
                    color: accent,
                    borderColor: playing ? accent : rgba(accent, 0.4),
                  }}
                  onClick={toggle}
                  disabled={!playing && atEnd}
                >
                  {playing ? "❚❚ Auto-Play" : "▶ Auto-Play"}
                </button>
              </div>

              {/* Countdown: animates transform only; remounts per stop to restart. */}
              <div
                className="absolute inset-x-0 bottom-0 h-[3px] overflow-hidden"
                style={{ background: rgba(accent, 0.12) }}
                aria-hidden="true"
              >
                {playing ? (
                  <motion.div
                    key={`${trail.id}-${index}`}
                    className="h-full w-full origin-left"
                    style={{ background: accent }}
                    initial={{ scaleX: 0 }}
                    animate={{ scaleX: 1 }}
                    transition={{ duration: AUTO_PLAY_MS / 1000, ease: "linear" }}
                  />
                ) : null}
              </div>
            </div>
          </motion.section>
        ) : null}
      </AnimatePresence>
      {briefing !== null ? (
        <ExportBriefingModal
          markdown={briefing.markdown}
          trailId={briefing.trailId}
          onClose={closeExport}
        />
      ) : null}
    </>
  );
}
