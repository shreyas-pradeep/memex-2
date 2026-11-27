"use client";

import { memo, useMemo } from "react";
import { ViewportPortal, useViewportStore, type ViewportStore } from "@xyflow/react";
import { useReducedMotion } from "framer-motion";
import { arcGeometry, magneticAnnouncement, magneticPillText, parseArcSignature } from "@/core/magnetic-arc";
import {
  selectMagneticArcSignature,
  selectMagneticTarget,
  selectMagneticTitles,
} from "@/store/dock-selectors";
import { useMemexStore } from "@/store/useMemexStore";

const VIOLET = "#B388FF";

/** Above every unselected card and edge (z 0) and below the dragged, selected card (z 1000). */
const ARC_Z = 900;
/** Above the dragged card, so the whisper is never hidden. */
const PILL_Z = 1100;

/**
 * Counter-scale for the whisper pill so it stays readable when zoomed out
 * (bucketed to quarter steps so it re-renders rarely, capped at 3x).
 */
function selectPillScale(s: ViewportStore): number {
  const bucket = Math.max(0.25, Math.round(s.transform[2] * 4) / 4);
  return Math.min(3, Math.max(1, 1 / bucket));
}

/** Registration `+` mark at an arc end (plain 1px strokes). */
function Cross({ x, y }: { x: number; y: number }) {
  return (
    <path
      d={`M ${x - 5} ${y} H ${x + 5} M ${x} ${y - 5} V ${y + 5}`}
      stroke={VIOLET}
      strokeWidth={1}
      fill="none"
      shapeRendering="crispEdges"
    />
  );
}

/**
 * The magnetic arc (Spec 09): while a dragged card is in range of a related,
 * unconnected card, a violet electric line joins the two facing sides, with a
 * whisper pill at its midpoint. It lives in flow coordinates inside React
 * Flow's `ViewportPortal`, so it pans and zooms with the cards.
 *
 * Z-order: `ViewportPortal` renders into `.react-flow__viewport-portal`, the
 * last child of the viewport, after the edges and the nodes. Cards are
 * positioned with z-index 0 (1000 when selected), so this overlay (z 900)
 * paints above idle cards and edges and below the dragged card; its pill
 * (z 1100) sits above everything. Pointer events stay off (the viewport
 * inherits `pointer-events: none`, and the layers set it explicitly), so the
 * drag is never blocked.
 *
 * Re-render budget: it reads two primitive strings (the pair's rectangles and
 * the offer's titles), so it updates per drag frame while an offer exists and
 * never otherwise; the canvas and the dock do not re-render.
 *
 * Motion: layered plain strokes (wide translucent underlayer, crisp 1px core
 * with a marching dash), a 1 px transform jitter on the group. No filters.
 * Under `prefers-reduced-motion` the line is steady and solid.
 */
export const MagneticArcOverlay = memo(function MagneticArcOverlay() {
  const reduce = useReducedMotion() === true;
  const pillScale = useViewportStore(selectPillScale);
  const target = useMemexStore(selectMagneticTarget);
  const signature = useMemexStore(selectMagneticArcSignature);
  const titlesSignature = useMemexStore(selectMagneticTitles);

  const geometry = useMemo(() => {
    const rects = signature === "" ? null : parseArcSignature(signature);
    return rects === null ? null : arcGeometry(rects[0], rects[1]);
  }, [signature]);

  const titles = useMemo(() => {
    if (titlesSignature === "") return null;
    try {
      const raw: unknown = JSON.parse(titlesSignature);
      return Array.isArray(raw) && typeof raw[0] === "string" && typeof raw[1] === "string"
        ? ([raw[0], raw[1]] as const)
        : null;
    } catch {
      return null;
    }
  }, [titlesSignature]);

  // The announcement changes only with the offer (pair and titles), never per frame.
  const announcement =
    target !== null && titles !== null ? magneticAnnouncement(titles[0], titles[1]) : "";

  return (
    <>
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-magnetic-status>
        {announcement}
      </div>
      <ViewportPortal>
        {target !== null && geometry !== null ? (
          <>
            <svg
              aria-hidden="true"
              width={1}
              height={1}
              data-magnetic-arc=""
              style={{ position: "absolute", left: 0, top: 0, overflow: "visible", pointerEvents: "none", zIndex: ARC_Z }}
            >
              <g className={reduce ? undefined : "memex-arc-jitter"}>
                {geometry.touching ? null : (
                  <>
                    {/* Underlayer: a wide translucent stroke (a plain stroke, no filter). */}
                    <path d={geometry.path} fill="none" stroke={VIOLET} strokeOpacity={0.25} strokeWidth={6} strokeLinecap="round" />
                    {/* Core: crisp 1px line, marching dash unless motion is reduced. */}
                    <path
                      d={geometry.path}
                      fill="none"
                      stroke={VIOLET}
                      strokeWidth={1}
                      strokeLinecap="round"
                      className={reduce ? undefined : "memex-arc-core"}
                    />
                    <Cross x={geometry.from.x} y={geometry.from.y} />
                    <Cross x={geometry.to.x} y={geometry.to.y} />
                  </>
                )}
              </g>
            </svg>
            <div
              data-magnetic-pill=""
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                transform: `translate(${geometry.mid.x}px, ${geometry.mid.y}px) translate(-50%, -50%) scale(${pillScale})`,
                pointerEvents: "none",
                zIndex: PILL_Z,
              }}
            >
              <div
                className="max-w-[360px] whitespace-nowrap rounded-full border bg-[#141721] px-3 py-1 font-mono text-[11px] font-semibold tracking-[0.06em]"
                style={{
                  color: VIOLET,
                  borderColor: VIOLET,
                  boxShadow: "0 6px 20px rgba(0,0,0,0.7), 0 0 14px rgba(179,136,255,0.35)",
                }}
              >
                {magneticPillText(target)}
              </div>
            </div>
          </>
        ) : null}
      </ViewportPortal>
    </>
  );
});
