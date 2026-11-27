"use client";

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ViewportPortal, useReactFlow, useViewportStore, type ViewportStore } from "@xyflow/react";
import {
  accumulateDelta,
  cassetteAriaLabel,
  cassetteDragDelta,
  cassetteLabelText,
  cassetteNudge,
  parseCassetteFramesSignature,
  type CassetteFrameModel,
} from "@/core/cassette-drag";
import { selectCassetteFramesSignature } from "@/store/dock-selectors";
import { useMemexStore } from "@/store/useMemexStore";

/**
 * Z-order inside the flow viewport. `ViewportPortal` renders into
 * `.react-flow__viewport-portal`, the LAST child of the viewport: after the
 * edges and the nodes, so by default its content paints above the cards. The
 * viewport is a stacking context (it carries the pan/zoom transform), and the
 * portal element itself creates none, so a child with a negative `z-index`
 * paints below every card and edge (they sit at z-index 0 or higher) but still
 * above the Background. The plate therefore uses -1. The label tab uses 5:
 * above idle cards (0) and below selected ones (1000), so it stays clickable.
 */
const PLATE_Z = -1;
const TAB_Z = 5;

/** Counter-scale for the tab so it stays readable when zoomed out (quarter-step buckets, capped at 3x). */
function selectTabScale(s: ViewportStore): number {
  const bucket = Math.max(0.25, Math.round(s.transform[2] * 4) / 4);
  return Math.min(3, Math.max(1, 1 / bucket));
}

interface DragState {
  pointerId: number;
  lastX: number;
  lastY: number;
  pending: { dx: number; dy: number };
  raf: number | null;
}

function CassetteTab({ frame, scale }: { frame: CassetteFrameModel; scale: number }) {
  const { getZoom } = useReactFlow();
  const drag = useRef<DragState | null>(null);
  const cassetteId = frame.id;

  const flush = useCallback(() => {
    const d = drag.current;
    if (d === null) return;
    d.raf = null;
    const { dx, dy } = cassetteDragDelta(d.pending.dx, d.pending.dy, getZoom());
    d.pending = { dx: 0, dy: 0 };
    if (dx !== 0 || dy !== 0) useMemexStore.getState().moveCassette(cassetteId, dx, dy);
  }, [cassetteId, getZoom]);

  // The final commit: pointer up, cancel and lost capture all end here, once.
  const finish = useCallback(() => {
    const d = drag.current;
    if (d === null) return;
    if (d.raf !== null) cancelAnimationFrame(d.raf);
    flush();
    drag.current = null;
    useMemexStore.getState().moveCassette(cassetteId, 0, 0, { commit: true });
  }, [cassetteId, flush]);

  // Unmounting mid-drag (the cassette vanished) must not leave a frame queued.
  useEffect(
    () => () => {
      const d = drag.current;
      if (d?.raf != null) cancelAnimationFrame(d.raf);
      drag.current = null;
    },
    [],
  );

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 || drag.current !== null) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY, pending: { dx: 0, dy: 0 }, raf: null };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (d === null || d.pointerId !== e.pointerId) return;
    d.pending = accumulateDelta(d.pending, e.clientX - d.lastX, e.clientY - d.lastY);
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    // One store write per animation frame, however fast the pointer reports.
    if (d.raf === null) d.raf = requestAnimationFrame(flush);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    // Backspace and Delete delete the selected cards (React Flow listens on the document).
    if (e.key === "Backspace" || e.key === "Delete") {
      e.stopPropagation();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const nudge = cassetteNudge(e.key, e.shiftKey);
    if (nudge === null) return;
    e.preventDefault();
    e.stopPropagation();
    // One persisted move per key press (10 px, 50 px with Shift, in flow units).
    useMemexStore.getState().moveCassette(cassetteId, nudge.dx, nudge.dy, { commit: true });
  };

  return (
    <button
      type="button"
      // `nopan nodrag nowheel`: React Flow neither pans, drags a card nor zooms from here.
      className="nopan nodrag nowheel max-w-[360px] cursor-grab truncate rounded-t-lg border border-b-0 bg-[#141721] px-2.5 py-1 text-left font-mono text-[11px] font-semibold tracking-[0.06em] text-[#FFB236] active:cursor-grabbing focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[#FFB236]"
      style={{
        position: "absolute",
        left: frame.x,
        top: frame.y,
        transform: `translateY(-100%) scale(${scale})`,
        transformOrigin: "left bottom",
        borderColor: "rgba(255, 178, 54, 0.35)",
        pointerEvents: "auto",
        touchAction: "none",
        userSelect: "none",
        zIndex: TAB_Z,
      }}
      title={frame.title}
      aria-label={cassetteAriaLabel(frame.title, frame.count)}
      data-cassette-tab={cassetteId}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onKeyDown={onKeyDown}
    >
      {cassetteLabelText(frame.title)}
    </button>
  );
}

/**
 * Microfiche cassette frames (Spec 09): one subtle dark plate behind the cards
 * of each ingested source, with a label tab that moves them all together.
 *
 * - The plate is `pointer-events: none` and sits below the cards (see `PLATE_Z`),
 *   so it never hides or blocks a card; only the tab takes pointer events.
 * - Frames come from one primitive string (`selectCassetteFramesSignature`):
 *   dragging a card that is not a member leaves it unchanged, so this overlay
 *   does not re-render; moving a member updates the frame live.
 * - Dragging the tab sends rAF-batched deltas (divided by the zoom) to
 *   `moveCassette`, then one commit on release; arrow keys nudge a focused tab.
 */
export const MicroficheCassetteOverlay = memo(function MicroficheCassetteOverlay() {
  const signature = useMemexStore(selectCassetteFramesSignature);
  const scale = useViewportStore(selectTabScale);
  const frames = useMemo(() => parseCassetteFramesSignature(signature), [signature]);
  if (frames.length === 0) return null;
  return (
    <ViewportPortal>
      {frames.map((f) => (
        <div
          key={`plate-${f.id}`}
          aria-hidden="true"
          data-cassette-plate={f.id}
          style={{
            position: "absolute",
            left: f.x,
            top: f.y,
            width: f.width,
            height: f.height,
            borderRadius: 18,
            border: "1px dashed rgba(255, 178, 54, 0.2)",
            background: "rgba(20, 23, 33, 0.35)",
            pointerEvents: "none",
            zIndex: PLATE_Z,
          }}
        />
      ))}
      {frames.map((f) => (
        <CassetteTab key={`tab-${f.id}`} frame={f} scale={scale} />
      ))}
    </ViewportPortal>
  );
});
