"use client";

import { memo, useState } from "react";
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
import { EDGE_COLORS, type AssociativeEdge } from "@/core/types";

const SPRING = { type: "spring", stiffness: 300, damping: 28 } as const;

/** Fallback card size before React Flow has measured the node. */
const DEFAULT_W = 280;
const DEFAULT_H = 160;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function boxOf(node: InternalNode | undefined): Box | null {
  if (!node) return null;
  return {
    x: node.internals.positionAbsolute.x,
    y: node.internals.positionAbsolute.y,
    w: node.measured.width ?? DEFAULT_W,
    h: node.measured.height ?? DEFAULT_H,
  };
}

function anchor(b: Box, side: Position): { x: number; y: number } {
  switch (side) {
    case Position.Top:
      return { x: b.x + b.w / 2, y: b.y };
    case Position.Bottom:
      return { x: b.x + b.w / 2, y: b.y + b.h };
    case Position.Left:
      return { x: b.x, y: b.y + b.h / 2 };
    default:
      return { x: b.x + b.w, y: b.y + b.h / 2 };
  }
}

/** Picks the facing sides of two cards from their relative placement. */
function facingSides(s: Box, t: Box): [Position, Position] {
  const dx = t.x + t.w / 2 - (s.x + s.w / 2);
  const dy = t.y + t.h / 2 - (s.y + s.h / 2);
  const horizontal = Math.abs(dx) / (s.w + t.w) >= Math.abs(dy) / (s.h + t.h);
  if (horizontal) {
    return dx >= 0 ? [Position.Right, Position.Left] : [Position.Left, Position.Right];
  }
  return dy >= 0 ? [Position.Bottom, Position.Top] : [Position.Top, Position.Bottom];
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
    [sp, tp] = facingSides(sb, tb);
    ({ x: sx, y: sy } = anchor(sb, sp));
    ({ x: tx, y: ty } = anchor(tb, tp));
  }

  const [path, labelX, labelY] = getBezierPath({
    sourceX: sx,
    sourceY: sy,
    sourcePosition: sp,
    targetX: tx,
    targetY: ty,
    targetPosition: tp,
    curvature: 0.35,
  });

  const origin = data?.origin ?? "human";
  const color = EDGE_COLORS[origin];
  const glow = origin === "ghost" ? "url(#violet-glow)" : "url(#amber-glow)";
  const strength = Math.min(1, Math.max(0, data?.strength ?? 0.5));
  const rationale = data?.rationale?.trim() ?? "";
  // Stronger associations pulse faster (4.2s down to 1.8s per traverse).
  const pulseSeconds = 4.2 - 2.4 * strength;
  const active = hovered || selected === true;

  return (
    <g
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      data-edge-id={id}
    >
      {/* Soft halo underlay. */}
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeOpacity={active ? 0.55 : 0.28}
        filter={glow}
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
          transition: "stroke-width 150ms ease, stroke-opacity 150ms ease",
        }}
      />
      {/* Thought pulse: a short bright dash travelling along the stroke. */}
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth={2.5}
        strokeLinecap="round"
        pathLength={100}
        strokeDasharray="5 95"
        className="memex-edge-pulse"
        style={{ animationDuration: `${pulseSeconds}s` }}
        pointerEvents="none"
      />

      <EdgeLabelRenderer>
        <div
          className="nodrag nopan"
          style={{
            position: "absolute",
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: "none",
            zIndex: 1000,
          }}
        >
          <AnimatePresence>
            {active ? (
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
