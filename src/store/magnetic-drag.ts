import { snapToastMessage } from "@/core/magnetic-arc";
import { useMemexStore } from "./useMemexStore";
import { showToast } from "./useToastStore";

/**
 * Glue between React Flow's drag callbacks and the magnetic session in
 * `useMemexStore` (Spec 09). Kept out of the component so the rules are testable.
 *
 * Only single-card drags take part: when React Flow drags a selection together,
 * `draggedCount` is greater than one and the session is cancelled. React Flow
 * writes the new position to the store BEFORE it calls `onNodeDrag` (and before
 * `onNodeDragStop`), so `updateMagneticDrag` and `endMagneticDrag` read it fresh.
 */

export function magneticDragStart(nodeId: string, draggedCount: number): void {
  const store = useMemexStore.getState();
  if (draggedCount !== 1) return store.cancelMagneticDrag();
  store.beginMagneticDrag(nodeId);
}

export function magneticDragMove(nodeId: string, draggedCount: number): void {
  const store = useMemexStore.getState();
  if (draggedCount !== 1) return store.cancelMagneticDrag();
  store.updateMagneticDrag(nodeId);
}

/** Drop: connects to the offered card (if any) and says so in a toast. Returns whether a synapse snapped. */
export function magneticDragStop(nodeId: string, draggedCount: number): boolean {
  const store = useMemexStore.getState();
  if (draggedCount !== 1) {
    store.cancelMagneticDrag();
    return false;
  }
  const offer = store.magneticTarget;
  const titleOf = (id: string): string => store.nodes.find((n) => n.id === id)?.data.title ?? "";
  const names = offer === null ? null : ([titleOf(offer.sourceId), titleOf(offer.targetId)] as const);
  const result = store.endMagneticDrag(nodeId);
  if (result.snapped && names !== null) showToast("SNAP", snapToastMessage(names[0], names[1]));
  return result.snapped;
}
