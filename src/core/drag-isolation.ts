/**
 * Single-card drag isolation (Spec 09). React Flow drags every selected card
 * together, so a card pressed while several are selected would never offer a
 * magnetic target. A plain press (no group modifier) on an already selected card
 * therefore collapses the selection to that card before the drag begins; a press
 * with Shift, Cmd or Ctrl held keeps the group. Pure: no React, no DOM.
 */

/** What the pointer-down handler knows about the press. */
export interface DragIsolationInput {
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  /** Number of selected cards at the moment of the press. */
  selectedCount: number;
  /** Whether the pressed card is one of them. */
  nodeSelected: boolean;
}

/** True when the user holds a key that means "work on a group" (Shift, Cmd/Meta or Ctrl). */
export function isGroupModifierHeld(input: Pick<DragIsolationInput, "shiftKey" | "metaKey" | "ctrlKey">): boolean {
  return input.shiftKey || input.metaKey || input.ctrlKey;
}

/**
 * Whether to collapse the selection to the pressed card: no group modifier is
 * held, the card is selected, and more than one card is. Anything else already
 * drags one card (an unselected card is dragged alone by React Flow) or is a
 * deliberate group drag.
 */
export function shouldIsolateDrag(input: DragIsolationInput): boolean {
  return !isGroupModifierHeld(input) && input.nodeSelected && input.selectedCount > 1;
}
