"use client";
import { useEffect } from "react";
import { useOptionsStore, useReactFlowStoreApi } from "@xyflow/react";
import { shouldIsolateDrag } from "@/core/drag-isolation";
import { useMemexStore } from "@/store/useMemexStore";

/** Elements that handle their own pointer input: pressing them must not touch the selection. */
const INTERACTIVE = ".nodrag, .react-flow__handle, .react-flow__resize-control, input, textarea, select, button, a, [contenteditable='true']";
const NODE = ".react-flow__node";
const SELECTION_RECT = ".react-flow__nodesselection-rect";

/**
 * Id of the card a press landed on. A press on a card reaches it directly. After
 * a box selection React Flow lays a transparent rectangle (`.react-flow__nodesselection-rect`)
 * over the selected cards and the press hits that instead, so the cards under
 * the pointer are looked up by position. `null` for a press on empty canvas, on
 * the gap inside the selection rectangle, or on a control inside the card.
 */
function pressedCardId(event: PointerEvent): string | null {
  const target = event.target;
  if (!(target instanceof Element) || target.closest(INTERACTIVE) !== null) return null;
  const direct = target.closest(NODE);
  if (direct !== null) return direct.getAttribute("data-id");
  if (target.closest(SELECTION_RECT) === null) return null;
  for (const element of document.elementsFromPoint(event.clientX, event.clientY)) {
    const card = element.closest(NODE);
    if (card !== null) return element.closest(INTERACTIVE) === null ? card.getAttribute("data-id") : null;
  }
  return null;
}

/**
 * Single-card drag isolation (Spec 09, see `shouldIsolateDrag`). React Flow drags
 * every selected card together, so magnetic snapping would never get a lone
 * dragged card. This listens on the React Flow container in the CAPTURE phase,
 * ahead of d3-drag's `mousedown` handler on the card (which is bound to the
 * card element and runs later), and for a plain primary-button press on an
 * already selected card, while more than one card is selected, collapses the
 * selection to that card through React Flow's own `addSelectedNodes`.
 *
 * The change reaches `onNodesChange`, hence the store, synchronously; React Flow's
 * node lookup follows when React commits that update, which finishes in the same
 * task, before the pointer moves the 4 px (`nodeDragThreshold`) after which
 * XYDrag reads the lookup to choose what to drag. With Shift, Cmd or Ctrl held
 * the selection stays and the group moves together (no magnetic target).
 *
 * Renders nothing; it must sit inside `<ReactFlow>`.
 */
export function SingleCardDragIsolation(): null {
  const { optionsStore } = useReactFlowStoreApi();
  const root = useOptionsStore((s) => s.domNode);
  useEffect(() => {
    if (root === null || root === undefined) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0 || !event.isPrimary) return;
      const id = pressedCardId(event);
      if (id === null) return;
      const nodes = useMemexStore.getState().nodes;
      let selectedCount = 0;
      let nodeSelected = false;
      for (const node of nodes) {
        if (node.selected !== true) continue;
        selectedCount++;
        if (node.id === id) nodeSelected = true;
      }
      const isolate = shouldIsolateDrag({
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        selectedCount,
        nodeSelected,
      });
      if (isolate) optionsStore.getState().addSelectedNodes([id]);
    };
    root.addEventListener("pointerdown", onPointerDown, { capture: true });
    return () => root.removeEventListener("pointerdown", onPointerDown, { capture: true });
  }, [root, optionsStore]);
  return null;
}
