"use client";

import { memo, useCallback, useMemo, useState } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  Position,
  getBezierPath,
  useInternalNode,
  type EdgeProps,
  type InternalNode,
} from "@xyflow/react";
import { AnimatePresence, motion } from "framer-motion";
import { confidencePercent } from "@/core/ghost-engine";
import {
  EDGE_CURVATURE,
  EDGE_FALLBACK_CARD_SIZE,
  getEdgeGeometry,
  type EdgeSide,
  type Rect,
} from "@/core/sprocket-engine";
import { cyclePolarity, getEdgePolarity } from "@/core/synthesis-engine";
import {
  EDGE_COLORS,
  POLARITY_COLORS,
  type AssociativeEdge,
  type EdgePolarity,
} from "@/core/types";
import { combinedDimOpacity } from "@/core/spotlight";
import { selectIsSnapEdge } from "@/store/dock-selectors";
import { selectEdgeSpotlightDim } from "@/store/spotlight-selectors";
import { useEdgeTrailState } from "@/store/trail-selectors";
import { useMemexStore, type MemexStore } from "@/store/useMemexStore";

const SPRING = { type: "spring", stiffness: 300, damping: 28 } as const;

const selectSelectGhost = (s: MemexStore) => s.selectGhostDiscovery;
const selectInspectEdge = (s: MemexStore) => s.inspectEdge;

/**
 * Polarity badges on real edges. Deliberately unlike the ghost "⚡ X% SYNAPSE"
 * pill (fully rounded, with a confidence percentage, only on derived discovery
 * edges): these are square-cornered stamps without a percentage.
 */
const POLARITY_BADGE: Record<EdgePolarity, { label: string; word: string }> = {
  supports: { label: "→ SUPPORTS", word: "supports" },
  refutes: { label: "≠ REFUTES", word: "refutes" },
  synthesizes: { label: "⚡ SYNAPSE", word: "synthesizes" },
};

/** React Flow handle positions for the core's side names (the string values are identical). */
const SIDE_TO_POSITION: Record<EdgeSide, Position> = {
  top: Position.Top,
  bottom: Position.Bottom,
  left: Position.Left,
  right: Position.Right,
};

/** Card rectangle of an internal node, or null before it exists. */
function boxOf(node: InternalNode | undefined): Rect | null {
  if (!node) return null;
  return {
    x: node.internals.positionAbsolute.x,
    y: node.internals.positionAbsolute.y,
    width: node.measured.width ?? EDGE_FALLBACK_CARD_SIZE.width,
    height: node.measured.height ?? EDGE_FALLBACK_CARD_SIZE.height,
  };
}

function AssociativePulseEdgeImpl({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps<AssociativeEdge>) {
  const [hovered, setHovered] = useState(false);
  const trailState = useEdgeTrailState(source, target);
  // Ghost synapses are display edges derived from a `GhostDiscovery`.
  const discoveryId = data?.discoveryId;
  const isSynapse = discoveryId !== undefined;
  const synapseSelected = useMemexStore(
    useCallback(
      (s: MemexStore) => discoveryId !== undefined && s.selectedGhostDiscoveryId === discoveryId,
      [discoveryId],
    ),
  );
  const selectGhost = useMemexStore(selectSelectGhost);
  const inspectEdge = useMemexStore(selectInspectEdge);
  // Spotlight (Spec 09): the edge fades when BOTH of its cards are filtered out. A primitive per edge.
  const spotlightSelector = useMemo(() => selectEdgeSpotlightDim(source, target), [source, target]);
  const bothDimmed = useMemexStore(spotlightSelector);
  // The edge a magnetic snap just created pulses once (opacity only; the store clears the id after 1.2 s).
  const snapSelector = useMemo(() => selectIsSnapEdge(id), [id]);
  const justSnapped = useMemexStore(snapSelector);
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);

  // Floating anchors: the edge leaves from whichever card side faces the other
  // card, so links look right wherever the cards are dragged.
  let sx = sourceX;
  let sy = sourceY;
  let tx = targetX;
  let ty = targetY;
  let sp = sourcePosition;
  let tp = targetPosition;
  const sb = boxOf(sourceNode);
  const tb = boxOf(targetNode);
  if (sb && tb) {
    // Shared with Sprocket (`sprocket-engine`), so the crawler follows this exact wire.
    const g = getEdgeGeometry(sb, tb);
    sp = SIDE_TO_POSITION[g.sourceSide];
    tp = SIDE_TO_POSITION[g.targetSide];
    ({ x: sx, y: sy } = g.source);
    ({ x: tx, y: ty } = g.target);
  }

  const [path, labelX, labelY] = getBezierPath({
    sourceX: sx,
    sourceY: sy,
    sourcePosition: sp,
    targetX: tx,
    targetY: ty,
    targetPosition: tp,
    curvature: EDGE_CURVATURE,
  });

  const origin = data?.origin ?? "human";
  // Derived ghost discovery edges never carry a polarity; real edges default to "supports".
  const polarity: EdgePolarity = isSynapse ? "supports" : getEdgePolarity({ data });
  // "supports" keeps the origin color (amber human, violet ghost), so edges
  // without a polarity look exactly as before.
  const color = polarity === "supports" ? EDGE_COLORS[origin] : POLARITY_COLORS[polarity];
  const refutes = polarity === "refutes";
  const synthesizes = polarity === "synthesizes";
  const badgeVisible = !isSynapse && (polarity !== "supports" || hovered || selected === true || justSnapped);
  const badge = POLARITY_BADGE[polarity];
  const nextWord = POLARITY_BADGE[cyclePolarity(polarity)].word;
  const strength = Math.min(1, Math.max(0, data?.strength ?? 0.5));
  const rationale = data?.rationale?.trim() ?? "";
  // Stronger associations pulse faster (4.2s down to 1.8s per traverse).
  const pulseSeconds = 4.2 - 2.4 * strength;
  const trailActive = trailState === "active";
  const edgeOpacity = combinedDimOpacity(trailState, bothDimmed ? "dim" : "off");
  const active = hovered || selected === true || trailActive || synapseSelected;

  return (
    <g
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      data-edge-id={id}
      style={{
        opacity: edgeOpacity,
        transition: "opacity 300ms ease",
      }}
    >
      {justSnapped ? (
        <path
          d={path}
          fill="none"
          stroke={EDGE_COLORS.human}
          strokeWidth={8}
          strokeLinecap="round"
          className="memex-snap-pulse"
          data-snap-pulse=""
          style={{ opacity: 0.4 }}
          pointerEvents="none"
        />
      ) : null}
      {/* Glow: a wide translucent stroke under the crisp line. Plain strokes
          composite on the GPU, unlike an SVG blur filter. */}
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth={trailActive ? 12 : active ? 9 : 6}
        strokeOpacity={trailActive ? 0.4 : active ? 0.22 : 0.1}
        strokeLinecap="round"
        pointerEvents="none"
      />
      {/* Crisp 1px trail plus the wide invisible hover/click target. */}
      <BaseEdge
        id={id}
        path={path}
        interactionWidth={28}
        style={{
          stroke: color,
          strokeWidth: active ? 1.75 : 1,
          strokeOpacity: active ? 1 : 0.7,
          ...(refutes ? { strokeDasharray: "7 5" } : {}),
          transition: "stroke-width 150ms ease, stroke-opacity 150ms ease",
        }}
      />
      {/* Thought pulse: a short bright dash travelling along the stroke.
          supports: forward. refutes: counter-flow. synthesizes: two offset pulses. */}
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth={2.5}
        strokeLinecap="round"
        pathLength={100}
        strokeDasharray="5 95"
        className={refutes ? "memex-edge-pulse-reverse" : "memex-edge-pulse"}
        style={{ animationDuration: `${pulseSeconds}s` }}
        pointerEvents="none"
      />
      {synthesizes ? (
        <path
          d={path}
          fill="none"
          stroke={color}
          strokeWidth={2.5}
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray="5 95"
          className="memex-edge-pulse"
          style={{ animationDuration: `${pulseSeconds}s`, animationDelay: `${-pulseSeconds / 2}s` }}
          pointerEvents="none"
        />
      ) : null}
      <EdgeLabelRenderer>
        {isSynapse ? (
          <div
            className="nodrag nopan"
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "none",
              zIndex: 1001,
              opacity: edgeOpacity,
            }}
          >
            <motion.button
              type="button"
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: synapseSelected ? 1.08 : 1 }}
              whileHover={{ scale: 1.08 }}
              whileTap={{ scale: 0.96 }}
              transition={SPRING}
              onClick={() => selectGhost(discoveryId)}
              onMouseEnter={() => setHovered(true)}
              onMouseLeave={() => setHovered(false)}
              aria-label={`Ghost synapse, ${confidencePercent(strength)} percent confidence. Open inspector.`}
              aria-pressed={synapseSelected}
              className="cursor-pointer whitespace-nowrap bg-card-surface px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent-ghost"
              style={{
                pointerEvents: "all",
                color,
                border: `1px solid ${color}`,
                borderRadius: 999,
                boxShadow: synapseSelected
                  ? `0 6px 20px rgba(0, 0, 0, 0.7), 0 0 18px ${color}99`
                  : `0 4px 14px rgba(0, 0, 0, 0.65), 0 0 10px ${color}44`,
              }}
            >
              ⚡ {confidencePercent(strength)}% SYNAPSE
            </motion.button>
          </div>
        ) : null}
        {!isSynapse ? (
          <div
            className="nodrag nopan"
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "none",
              zIndex: 1002,
              opacity: edgeOpacity,
            }}
          >
            <AnimatePresence>
              {badgeVisible ? (
                <motion.button
                  key="polarity-badge"
                  type="button"
                  initial={{ opacity: 0, scale: 0.85 }}
                  animate={{ opacity: polarity === "supports" ? 0.85 : 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.85 }}
                  whileHover={{ scale: 1.08 }}
                  whileTap={{ scale: 0.92 }}
                  transition={SPRING}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    inspectEdge(id);
                  }}
                  onMouseEnter={() => setHovered(true)}
                  onMouseLeave={() => setHovered(false)}
                  aria-label={`Edge polarity: ${badge.word}. Activate to inspect this link and change it to ${nextWord}.`}
                  title={`${badge.word}. Click to inspect this link (next polarity: ${nextWord})`}
                  data-polarity={polarity}
                  className="cursor-pointer whitespace-nowrap bg-card-surface px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2"
                  style={{
                    pointerEvents: "all",
                    color,
                    border: `1px solid ${color}`,
                    borderRadius: 2,
                    outlineColor: color,
                    boxShadow:
                      polarity === "supports"
                        ? "0 4px 14px rgba(0, 0, 0, 0.65)"
                        : `0 4px 14px rgba(0, 0, 0, 0.65), 0 0 10px ${color}55`,
                  }}
                >
                  <motion.span
                    key={polarity}
                    initial={{ scale: 0.7 }}
                    animate={{ scale: 1 }}
                    transition={SPRING}
                    style={{ display: "inline-block" }}
                  >
                    {badge.label}
                  </motion.span>
                </motion.button>
              ) : null}
            </AnimatePresence>
          </div>
        ) : null}
        <div
          className="nodrag nopan"
          style={{
            position: "absolute",
            // Anchored just below the midpoint so it never covers the polarity badge.
            transform: `translate(-50%, 0) translate(${labelX}px, ${labelY + 18}px)`,
            pointerEvents: "none",
            zIndex: 1000,
          }}
        >
          <AnimatePresence>
            {!isSynapse && (hovered || selected === true) ? (
              <motion.div
                key="pill"
                initial={{ opacity: 0, scale: 0.92 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.92 }}
                transition={SPRING}
                className="flex max-w-[260px] items-start gap-2 bg-card-surface px-2.5 py-1.5"
                style={{
                  border: `1px solid ${color}`,
                  borderRadius: 2,
                  boxShadow: `0 6px 20px rgba(0, 0, 0, 0.7), 0 0 14px ${color}33`,
                }}
              >
                <span
                  className="mt-px shrink-0 font-mono text-[10px] uppercase tracking-wider px-1 py-px"
                  style={{ color, border: `1px solid ${color}`, borderRadius: 1 }}
                >
                  {origin === "ghost" ? "GHOST" : "HUMAN"} {strength.toFixed(2)}
                </span>
                <span className="font-serif text-[12px] leading-snug text-text-primary">
                  {rationale || "No rationale recorded."}
                </span>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </EdgeLabelRenderer>
    </g>
  );
}

export const AssociativePulseEdge = memo(AssociativePulseEdgeImpl);
