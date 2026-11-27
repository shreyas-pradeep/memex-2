"use client";

import { useCallback, useMemo } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { confidencePercent } from "@/core/ghost-engine";
import { cyclePolarity, getEdgePolarity } from "@/core/synthesis-engine";
import {
  EDGE_COLORS,
  POLARITY_COLORS,
  type AssociativeEdge,
  type EdgePolarity,
  type MemexNodeData,
} from "@/core/types";
import { selectNodeData, selectSelectedDiscovery } from "@/store/ghost-selectors";
import { selectInspectedEdge } from "@/store/dock-selectors";
import { useMemexStore, type MemexStore } from "@/store/useMemexStore";
import { rgba, skinFor } from "./card-skins";

const SPRING = { type: "spring", stiffness: 300, damping: 28 } as const;
const GHOST = EDGE_COLORS.ghost;
const HUMAN = EDGE_COLORS.human;

/** Empty-state copy: how to put something into the inspector. */
export const SYNAPSE_EMPTY_TEXT =
  "Nothing selected. Click an edge badge or a ⚡ synapse pill on the canvas to inspect it here.";

const POLARITY_WORDS: Record<EdgePolarity, string> = {
  supports: "supports",
  refutes: "refutes",
  synthesizes: "synthesizes",
};

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
      className="rounded-xl border border-white/10 bg-[#090A0F] p-3 shadow-[inset_0_2px_6px_rgba(0,0,0,0.5)]"
      style={skin ? { borderLeft: `3px solid ${skin.accent}` } : undefined}
    >
      <div className="font-mono text-[10px] uppercase tracking-[0.2em]" style={{ color: accent }}>
        {label}
        {data ? ` · ${data.archivalId}` : ""}
      </div>
      {data ? (
        <>
          <h3 className="mt-1 font-serif text-[15px] font-semibold leading-snug text-text-primary">{data.title}</h3>
          <p className="mt-1 font-serif text-[12px] leading-snug text-text-muted">{snippet(data.content)}</p>
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

/** A 0..100 meter whose fill animates with `scaleX` (transform only). */
function Meter({ label, caption, percent, color, resetKey }: { label: string; caption: string; percent: number; color: string; resetKey: string }) {
  const reduce = useReducedMotion() === true;
  const value = Math.min(100, Math.max(0, percent));
  return (
    <section aria-label={`${label} telemetry`}>
      <div className="flex items-baseline justify-between font-mono text-[10px] uppercase tracking-[0.2em] text-text-muted">
        <span>{caption}</span>
        <span className="text-[13px] font-semibold" style={{ color }}>
          {value}%
        </span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        className="mt-1 h-2 overflow-hidden rounded-full bg-[#090A0F] shadow-[inset_0_1px_3px_rgba(0,0,0,0.7)]"
      >
        <motion.div
          key={resetKey}
          initial={reduce ? false : { scaleX: 0 }}
          animate={{ scaleX: value / 100 }}
          transition={reduce ? { duration: 0 } : SPRING}
          className="h-full w-full origin-left rounded-full"
          style={{ background: color, boxShadow: `0 0 10px ${color}99` }}
        />
      </div>
    </section>
  );
}

const BTN =
  "cursor-pointer rounded-xl border px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-[0.16em] shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_2px_0_rgba(0,0,0,0.65)] transition-[color,border-color,transform] duration-100 active:translate-y-[2px] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2";

function Header({ kicker, title, color }: { kicker: string; title: string; color: string }) {
  return (
    <header>
      <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em]" style={{ color }}>
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: color, boxShadow: `0 0 8px 2px ${color}99` }}
        />
        {kicker}
      </div>
      <h2 className="mt-1 font-serif text-lg font-semibold text-text-primary">{title}</h2>
    </header>
  );
}

function DiscoveryView() {
  const discovery = useMemexStore(selectSelectedDiscovery);
  const sourceSelector = useMemo(() => selectNodeData(discovery?.sourceId), [discovery?.sourceId]);
  const targetSelector = useMemo(() => selectNodeData(discovery?.targetId), [discovery?.targetId]);
  const source = useMemexStore(sourceSelector);
  const target = useMemexStore(targetSelector);
  const id = discovery?.id ?? null;

  const accept = useCallback(() => {
    if (id !== null) useMemexStore.getState().acceptGhostDiscovery(id);
  }, [id]);
  const dismiss = useCallback(() => {
    if (id !== null) useMemexStore.getState().dismissGhostDiscovery(id);
  }, [id]);
  const walk = useCallback(() => {
    if (id !== null) useMemexStore.getState().convertDiscoveryToTrail(id);
  }, [id]);

  if (discovery === null) return null;
  const percent = confidencePercent(discovery.confidence);
  return (
    <>
      <Header kicker="Ghost Synapse" title="Synapse Inspector" color={GHOST} />
      <CardSnippet label="Source" data={source} accent={HUMAN} />
      <div aria-hidden="true" className="text-center font-mono text-[11px] tracking-[0.3em]" style={{ color: GHOST }}>
        ⚡ ─ ─ ─ ⚡
      </div>
      <CardSnippet label="Target" data={target} accent={HUMAN} />
      <section aria-label="Bridge rationale">
        <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-muted">Bridge rationale</div>
        <p className="mt-1 font-serif text-[13px] leading-snug text-text-primary">{discovery.rationale}</p>
      </section>
      <Meter label="Synapse confidence" caption="Confidence" percent={percent} color={GHOST} resetKey={discovery.id} />
      <div className="mt-auto flex flex-col gap-2">
        <button
          type="button"
          onClick={accept}
          className={`${BTN} border-accent-human/60 bg-[#141721] text-accent-human hover:border-accent-human focus-visible:outline-accent-human`}
        >
          Accept Connection
        </button>
        <button
          type="button"
          onClick={walk}
          className={`${BTN} border-accent-ghost/60 bg-[#141721] text-accent-ghost hover:border-accent-ghost focus-visible:outline-accent-ghost`}
        >
          Walk Ghost Trail
        </button>
        <button
          type="button"
          onClick={dismiss}
          className={`${BTN} border-white/10 bg-[#090A0F] text-text-muted hover:border-white/30 hover:text-text-primary focus-visible:outline-white/60`}
        >
          Dismiss
        </button>
      </div>
    </>
  );
}

function EdgeView({ edge }: { edge: AssociativeEdge }) {
  const sourceSelector = useMemo(() => selectNodeData(edge.source), [edge.source]);
  const targetSelector = useMemo(() => selectNodeData(edge.target), [edge.target]);
  const source = useMemexStore(sourceSelector);
  const target = useMemexStore(targetSelector);
  const trailId = edge.data?.trailId;
  const trailTitle = useMemexStore(
    useCallback((s: MemexStore) => (trailId === undefined ? null : (s.trails.find((t) => t.id === trailId)?.title ?? null)), [trailId]),
  );

  const polarity: EdgePolarity = getEdgePolarity({ data: edge.data });
  const next = cyclePolarity(polarity);
  const color = polarity === "supports" ? EDGE_COLORS[edge.data?.origin ?? "human"] : POLARITY_COLORS[polarity];
  const strength = Math.round(Math.min(1, Math.max(0, edge.data?.strength ?? 0.5)) * 100);
  const rationale = edge.data?.rationale?.trim() ?? "";
  const edgeId = edge.id;

  const cycle = useCallback(() => useMemexStore.getState().toggleEdgePolarity(edgeId), [edgeId]);
  const openTrail = useCallback(() => {
    if (trailId !== undefined) useMemexStore.getState().loadTrailIntoLever(trailId);
  }, [trailId]);

  return (
    <>
      <Header kicker="Associative Link" title="Synapse Inspector" color={color} />
      <CardSnippet label="Source" data={source} accent={HUMAN} />
      <div aria-hidden="true" className="text-center font-mono text-[11px] tracking-[0.3em]" style={{ color }}>
        ─ ─ ─ {POLARITY_WORDS[polarity]} ─ ─ ─
      </div>
      <CardSnippet label="Target" data={target} accent={HUMAN} />
      <section aria-label="Link rationale">
        <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-muted">Rationale</div>
        <p className="mt-1 font-serif text-[13px] leading-snug text-text-primary">
          {rationale === "" ? "No rationale recorded." : rationale}
        </p>
      </section>
      <Meter label="Link strength" caption="Strength" percent={strength} color={color} resetKey={edge.id} />
      <section aria-label="Polarity" className="flex items-center justify-between gap-3">
        <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-muted">
          Polarity
          <div className="mt-0.5 text-[13px] font-semibold tracking-[0.14em]" style={{ color }} data-polarity={polarity}>
            {POLARITY_WORDS[polarity]}
          </div>
        </div>
        <button
          type="button"
          onClick={cycle}
          aria-label={`Edge polarity: ${POLARITY_WORDS[polarity]}. Activate to change to ${POLARITY_WORDS[next]}.`}
          title={`Change to ${POLARITY_WORDS[next]}`}
          className={`${BTN} bg-[#141721] hover:brightness-125 focus-visible:outline-[#FFB236]`}
          style={{ color, borderColor: rgba(color, 0.6) }}
        >
          <span aria-hidden="true">[↻ {POLARITY_WORDS[next]}]</span>
        </button>
      </section>
      {trailId !== undefined && trailTitle !== null ? (
        <div className="mt-auto">
          <button
            type="button"
            onClick={openTrail}
            aria-label={`Walk the trail this link belongs to: ${trailTitle}`}
            className={`${BTN} w-full border-accent-ghost/60 bg-[#141721] text-accent-ghost hover:border-accent-ghost focus-visible:outline-accent-ghost`}
          >
            <span aria-hidden="true">[▶ WALK TRAIL]</span>
          </button>
          <p className="mt-1 truncate text-center font-mono text-[10px] text-text-muted" title={trailTitle}>
            {trailTitle}
          </p>
        </div>
      ) : null}
    </>
  );
}

/**
 * "Synapse Inspect": explains one ghost discovery (accept, dismiss, walk its
 * trail) or one real edge (rationale, strength, polarity cycle, and the trail
 * it belongs to when it has one). Both selections live in the store
 * (`selectedGhostDiscoveryId`, `inspectedEdgeId`; selecting one clears the
 * other), and clearing either never closes the dock.
 */
export function SynapsePanel() {
  const discovery = useMemexStore(selectSelectedDiscovery);
  const edge = useMemexStore(selectInspectedEdge);
  const clear = useCallback(() => {
    const s = useMemexStore.getState();
    s.selectGhostDiscovery(null);
    s.inspectEdge(null);
  }, []);

  if (discovery === null && edge === null) {
    return (
      <p
        data-synapse-empty
        className="rounded-2xl border border-dashed border-white/15 p-4 text-center font-serif text-[13px] leading-snug text-text-muted"
      >
        {SYNAPSE_EMPTY_TEXT}
      </p>
    );
  }
  return (
    <>
      {discovery !== null ? <DiscoveryView /> : edge !== null ? <EdgeView edge={edge} /> : null}
      <button
        type="button"
        onClick={clear}
        className={`${BTN} border-white/10 bg-[#090A0F] text-text-muted hover:text-text-primary focus-visible:outline-[#FFB236]`}
      >
        Clear selection
      </button>
    </>
  );
}
