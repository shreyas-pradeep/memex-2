"use client";
import { memo, useMemo } from "react";
import { useViewportStore } from "@xyflow/react";
import { useReducedMotion } from "framer-motion";
import {
  arcGeometry,
  flowToScreen,
  magneticAnnouncement,
  magneticPillText,
  parseArcSignature,
  viewTransformAttribute,
} from "@/core/magnetic-arc";
import {
  selectMagneticArcSignature,
  selectMagneticTarget,
  selectMagneticTitles,
} from "@/store/dock-selectors";
import { useMemexStore } from "@/store/useMemexStore";
const VIOLET = "#B388FF";
/**
 * Both layers use z-index 50 inside the `.react-flow` element, which is its own
 * stacking context (React Flow gives it `position: relative; z-index: 0`). Inside
 * it the canvas (`.react-flow__renderer`) is z 4 and the panels are z 5, so 50 is
 * above everything React Flow draws, the dragged card (z 1000, but only inside
 * the viewport's own stacking context) included. The pill therefore never hides
 * behind a card that touches or overlaps its partner. The command dock, toasts and
 * modals are outside that context and stay above.
 */
const LAYER_Z = 50;
const NO_POINTER = { pointerEvents: "none" } as const;
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
 * whisper pill at its midpoint.
 *
 * Placement: a plain child of `<ReactFlow>` (a sibling of the canvas inside
 * `.react-flow`), not a `ViewportPortal`. A portal child lives inside
 * `.react-flow__viewport` (z 2, a stacking context because of its transform),
 * where selected cards are z 1000, so a portal layer could only be above the
 * dragged card with z > 1000. Here the filament draws in an SVG whose inner
 * `<g>` carries the viewport's pan and zoom (`viewTransformAttribute`), so it
 * still moves with the cards; the pill is placed at the screen position of the
 * arc midpoint (`flowToScreen`), which also keeps it at a constant readable size
 * at any zoom. The filament never crosses a card interior (its ends sit on the
 * facing borders), so drawing it above the cards hides nothing.
 *
 * Pointer events: every wrapper (the SVG, its group, the pill and its inner box)
 * sets `pointer-events: none` both as the Tailwind class and inline, so the
 * layers can never swallow a pointerup, a hover or a click.
 *
 * Re-render budget: it reads primitive strings and numbers (the pair's rectangles,
 * the offer's titles, the pan and zoom), so it updates per drag frame while an
 * offer exists and never otherwise; the canvas and the dock do not re-render.
 *
 * Motion: layered plain strokes (wide translucent underlayer, crisp 1px core
 * with a marching dash), a 1 px transform jitter on the group. No filters.
 * Under `prefers-reduced-motion` the line is steady and solid.
 */
export const MagneticArcOverlay = memo(function MagneticArcOverlay() {
  const reduce = useReducedMotion() === true;
  const panX = useViewportStore((s) => s.transform[0]);
  const panY = useViewportStore((s) => s.transform[1]);
  const zoom = useViewportStore((s) => s.transform[2]);
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
  const view = { x: panX, y: panY, zoom };
  const pill = geometry === null ? null : flowToScreen(geometry.mid, view);
  return (
    <>
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-magnetic-status>
        {announcement}
      </div>
      {target !== null && geometry !== null && pill !== null ? (
        <>
          <svg
            aria-hidden="true"
            data-magnetic-arc=""
            className="pointer-events-none absolute top-0 left-0 h-full w-full overflow-visible"
            style={{ ...NO_POINTER, zIndex: LAYER_Z }}
          >
            <g className="pointer-events-none" style={NO_POINTER} transform={viewTransformAttribute(view)}>
              <g className={`pointer-events-none${reduce ? "" : " memex-arc-jitter"}`} style={NO_POINTER}>
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
            </g>
          </svg>
          <div
            data-magnetic-pill=""
            className="pointer-events-none absolute top-0 left-0"
            style={{
              ...NO_POINTER,
              transform: `translate(${pill.x}px, ${pill.y}px) translate(-50%, -50%)`,
              zIndex: LAYER_Z,
            }}
          >
            <div
              className="pointer-events-none max-w-[360px] whitespace-nowrap rounded-full border bg-[#141721] px-3 py-1 font-mono text-[11px] font-semibold tracking-[0.06em]"
              style={{
                ...NO_POINTER,
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
    </>
  );
});
