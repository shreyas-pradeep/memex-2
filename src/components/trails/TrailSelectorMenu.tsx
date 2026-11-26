"use client";

import { useCallback, useState } from "react";
import { Panel } from "@xyflow/react";
import { AnimatePresence, motion } from "framer-motion";
import { EDGE_COLORS, type Trail } from "@/core/types";
import { useMemexStore, type MemexStore } from "@/store/useMemexStore";

const SPRING = { type: "spring", stiffness: 300, damping: 28 } as const;

const selectTrails = (s: MemexStore) => s.trails;
const selectActiveId = (s: MemexStore) => s.activeTrailId;

function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function TrailRow({ trail, active }: { trail: Trail; active: boolean }) {
  const accent = EDGE_COLORS[trail.origin];
  const disabled = trail.nodeIds.length === 0;
  return (
    <li>
      <button
        type="button"
        disabled={disabled}
        aria-pressed={active}
        onClick={() => {
          const { setActiveTrail } = useMemexStore.getState();
          setActiveTrail(active ? null : trail.id);
        }}
        className="flex w-full cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-left transition-[border-color,background-color] duration-100 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2"
        style={{
          borderColor: active ? accent : rgba(accent, 0.3),
          background: active ? rgba(accent, 0.1) : "#161922",
          outlineColor: accent,
        }}
      >
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: accent, boxShadow: `0 0 8px 2px ${rgba(accent, 0.6)}` }}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-serif text-[14px] font-semibold text-text-primary">
            {trail.title}
          </span>
          <span className="block font-mono text-[10px] uppercase tracking-wider text-text-muted">
            {trail.origin === "ghost" ? "Ghost" : "Human"} · {trail.nodeIds.length} stops
          </span>
        </span>
        <span className="font-mono text-[10px] uppercase" style={{ color: accent }}>
          {active ? "Stop" : "Play"}
        </span>
      </button>
    </li>
  );
}

/** Top HUD: browse and launch trails, or forge one from the selected cards. */
export function TrailSelectorMenu() {
  const trails = useMemexStore(selectTrails);
  const activeId = useMemexStore(selectActiveId);
  const [open, setOpen] = useState(false);
  const [forging, setForging] = useState(false);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);

  const closeForge = useCallback(() => {
    setForging(false);
    setTitle("");
    setError(null);
  }, []);

  const submitForge = useCallback(() => {
    const { nodes, forgeTrail, setActiveTrail } = useMemexStore.getState();
    // Reading order: left to right, then top to bottom.
    const selected = nodes
      .filter((n) => n.selected === true)
      .sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y)
      .map((n) => n.id);
    if (selected.length < 2) {
      setError("Select at least 2 cards on the canvas first.");
      return;
    }
    const id = forgeTrail(title || "Untitled Trail", "", selected);
    if (id === null) {
      setError("Could not forge a trail from that selection.");
      return;
    }
    closeForge();
    setActiveTrail(id);
  }, [title, closeForge]);

  const humanBtn =
    "cursor-pointer rounded-xl border px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-[0.16em] transition-[color,border-color] duration-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2";

  return (
    <Panel position="top-center" className="!m-4">
      <div className="w-[320px] rounded-2xl border border-white/10 bg-[#141721] p-3 shadow-[0_12px_36px_rgba(0,0,0,0.55)]">
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            className={`${humanBtn} flex-1 border-accent-human/50 bg-[#161922] text-accent-human hover:border-accent-human focus-visible:outline-accent-human`}
          >
            Trails · {trails.length} {open ? "▴" : "▾"}
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(true);
              setForging((f) => !f);
              setError(null);
            }}
            className={`${humanBtn} border-accent-ghost/50 bg-[#161922] text-accent-ghost hover:border-accent-ghost focus-visible:outline-accent-ghost`}
          >
            + Forge Trail
          </button>
        </div>

        <AnimatePresence initial={false}>
          {open ? (
            <motion.div
              key="menu"
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={SPRING}
              className="mt-3"
            >
              {forging ? (
                <form
                  className="mb-3 rounded-xl border border-white/10 bg-[#090A0F]/80 p-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    submitForge();
                  }}
                >
                  <label className="block font-mono text-[10px] uppercase tracking-[0.16em] text-text-muted">
                    Trail title
                    <input
                      autoFocus
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      onKeyDown={(e) => e.stopPropagation()}
                      placeholder="Untitled Trail"
                      className="mt-1 w-full rounded-xl border border-accent-human/40 bg-[#141721] px-2.5 py-1.5 font-serif text-[14px] normal-case tracking-normal text-text-primary outline-none focus:border-accent-human"
                    />
                  </label>
                  <p className="mt-2 text-[11px] text-text-muted">
                    Uses the selected cards, ordered left to right.
                  </p>
                  {error ? (
                    <p role="alert" className="mt-1 text-[11px] text-[#ff6b6b]">
                      {error}
                    </p>
                  ) : null}
                  <div className="mt-2 flex gap-2">
                    <button
                      type="submit"
                      className={`${humanBtn} flex-1 border-accent-human/60 bg-[#161922] text-accent-human hover:border-accent-human focus-visible:outline-accent-human`}
                    >
                      Forge
                    </button>
                    <button
                      type="button"
                      onClick={closeForge}
                      className={`${humanBtn} border-white/10 bg-[#161922] text-text-muted hover:text-text-primary focus-visible:outline-accent-human`}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : null}

              {trails.length === 0 ? (
                <p className="text-[12px] text-text-muted">No trails yet.</p>
              ) : (
                <ul className="flex max-h-[280px] flex-col gap-2 overflow-y-auto">
                  {trails.map((t) => (
                    <TrailRow key={t.id} trail={t} active={t.id === activeId} />
                  ))}
                </ul>
              )}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </Panel>
  );
}
