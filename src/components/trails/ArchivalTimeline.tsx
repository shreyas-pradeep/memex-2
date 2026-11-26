"use client";

import { useCallback, useMemo } from "react";
import { Panel, useReactFlow } from "@xyflow/react";
import { AnimatePresence, motion } from "framer-motion";
import {
  formatEventDate,
  getChronologicalNodes,
  getEventYear,
} from "@/core/trail-engine";
import { EDGE_COLORS, type AssociativeEdge, type MemexCardType, type MemexNode } from "@/core/types";
import { DEFAULT_CARD_SIZE, useMemexStore, type MemexStore } from "@/store/useMemexStore";
import { TRAIL_CAMERA_MS, TRAIL_ZOOM } from "./TrailCameraDirector";

const SPRING = { type: "spring", stiffness: 300, damping: 28 } as const;

interface Milestone {
  id: string;
  label: string;
  year: number;
  title: string;
  cardType: MemexCardType;
}

/**
 * One primitive string describing the timeline. Zustand compares it with
 * `Object.is`, so card drags (which replace `nodes` at 60fps) do not re-render
 * the timeline unless a dated card's date, title or type actually changed.
 */
const selectTimelineSignature = (s: MemexStore): string =>
  JSON.stringify(
    getChronologicalNodes(s.nodes).map((n) => [
      n.id,
      formatEventDate(n.data),
      getEventYear(n.data),
      n.data.title,
      n.data.cardType,
    ]),
  );
const selectTrailActive = (s: MemexStore) => s.activeTrailId !== null;
const selectOpen = (s: MemexStore) => s.isTimelineOpen;
const selectToggle = (s: MemexStore) => s.toggleTimeline;
const selectHighlightedId = (s: MemexStore) => s.highlightedNodeId;

function parseSignature(signature: string): Milestone[] {
  const rows = JSON.parse(signature) as [string, string, number, string, MemexCardType][];
  return rows.map(([id, label, year, title, cardType]) => ({ id, label, year, title, cardType }));
}

function toNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * Floating chronological ticker along the bottom of the canvas. Plots every
 * dated card in ascending order; undated cards are never shown here. Hidden
 * while a trail plays (the dock owns that space); the user's open/closed
 * choice is kept in the store and returns on exit.
 */
export function ArchivalTimeline() {
  const signature = useMemexStore(selectTimelineSignature);
  const trailActive = useMemexStore(selectTrailActive);
  const open = useMemexStore(selectOpen);
  const toggle = useMemexStore(selectToggle);
  const highlightedId = useMemexStore(selectHighlightedId);
  const { setCenter, getInternalNode } = useReactFlow<MemexNode, AssociativeEdge>();

  const milestones = useMemo(() => parseSignature(signature), [signature]);

  const jumpTo = useCallback(
    (nodeId: string) => {
      const { nodes, highlightNode } = useMemexStore.getState();
      const node = nodes.find((n) => n.id === nodeId);
      if (!node) return;
      const internal = getInternalNode(nodeId);
      const width =
        internal?.measured.width ??
        toNumber(node.width) ??
        toNumber(node.style?.width) ??
        DEFAULT_CARD_SIZE.width;
      const height =
        internal?.measured.height ??
        toNumber(node.height) ??
        toNumber(node.style?.height) ??
        DEFAULT_CARD_SIZE.height;
      const origin = internal?.internals.positionAbsolute ?? node.position;
      void setCenter(origin.x + width / 2, origin.y + height / 2, {
        zoom: TRAIL_ZOOM,
        duration: TRAIL_CAMERA_MS,
      });
      highlightNode(nodeId);
    },
    [setCenter, getInternalNode],
  );

  if (trailActive) return null;

  const hasMilestones = milestones.length > 0;
  const first = hasMilestones ? milestones[0].year : 0;
  const last = hasMilestones ? milestones[milestones.length - 1].year : 0;
  const range = !hasMilestones ? "" : first === last ? String(first) : `${first} – ${last}`;

  return (
    <Panel position="bottom-center" className="!mb-4 !mx-0">
      <div
        className="flex flex-col items-center gap-2"
        style={{ maxWidth: "min(760px, calc(100vw - 520px))", minWidth: 220 }}
      >
        <AnimatePresence initial={false}>
          {open ? (
            <motion.div
              key="bar"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 16 }}
              transition={SPRING}
              className="w-full rounded-2xl border border-white/10 bg-[#141721]/95 px-3 pt-2 pb-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_12px_36px_rgba(0,0,0,0.55)]"
            >
              <div className="mb-1 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.2em] text-text-muted">
                <span>Chronology</span>
                <span style={{ color: EDGE_COLORS.human }}>{range}</span>
              </div>
              {hasMilestones ? null : (
                <p className="py-3 text-center font-mono text-[11px] text-text-muted">
                  No dated cards yet. Add an Event Date / Year to a card to plot it here.
                </p>
              )}
              <div
                className="nowheel nopan overflow-x-auto overflow-y-hidden"
                role="list"
                aria-label="Chronological milestones"
              >
                <div className={`relative w-max min-w-full items-start gap-1 pt-3 pb-1 ${hasMilestones ? "flex" : "hidden"}`}>
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute top-[17px] right-0 left-0 h-px bg-white/15"
                  />
                  {milestones.map((m) => {
                    const accent = m.cardType === "ghost" ? EDGE_COLORS.ghost : EDGE_COLORS.human;
                    const isHot = highlightedId === m.id;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        role="listitem"
                        onClick={() => jumpTo(m.id)}
                        title={`${m.label} · ${m.title}`}
                        className="group relative flex w-[120px] shrink-0 cursor-pointer flex-col items-start gap-1 rounded-xl px-2 pb-1 text-left focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2"
                        style={{ outlineColor: accent }}
                      >
                        <span
                          aria-hidden="true"
                          className="relative z-10 h-2.5 w-2.5 rounded-full transition-transform duration-150 group-hover:scale-125"
                          style={{
                            background: accent,
                            transform: isHot ? "scale(1.5)" : undefined,
                            boxShadow: `0 0 ${isHot ? 12 : 6}px 1px ${rgba(accent, isHot ? 0.95 : 0.6)}`,
                          }}
                        />
                        <span
                          className="font-mono text-[12px] font-semibold tracking-wider"
                          style={{ color: accent }}
                        >
                          {m.label}
                        </span>
                        <span className="line-clamp-2 font-serif text-[12px] leading-snug text-text-primary">
                          {m.title}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>

        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="cursor-pointer rounded-xl border border-[#FFB236]/50 bg-gradient-to-b from-[#161922] to-[#141721] px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-[#FFB236] shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_2px_0_rgba(0,0,0,0.65),0_6px_14px_rgba(0,0,0,0.4)] transition-[color,border-color,box-shadow,transform] duration-100 hover:border-[#FFB236] active:translate-y-[2px] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[#FFB236]"
        >
          [ ⏱️ TIMELINE ]
        </button>
      </div>
    </Panel>
  );
}
