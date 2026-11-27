/**
 * The Research Command Dock (Spec 09): one right-hand dock with three tabs
 * (Trails, Synapse, Spotlight) that replaces the Curator's Index drawer
 * (Spec 08) and the Synapse Inspector drawer (Spec 03). This module holds its
 * state machine and keyboard rules as plain data, testable without a DOM.
 * Pure: no React, no store, no clock.
 */

export type DockTab = "trails" | "synapse" | "spotlight";
export const DOCK_TABS: readonly DockTab[] = ["trails", "synapse", "spotlight"];

/** Session-only; never persisted or exported. `tab` is remembered while the dock is collapsed. */
export interface DockState {
  open: boolean;
  tab: DockTab;
}

export const INITIAL_DOCK: DockState = { open: false, tab: "trails" };

/**
 * A key press as plain data. The listener fills the three DOM-derived booleans
 * (`targetIsEditable`, `targetInsideDock`, `modalOpen`).
 */
export interface DockKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  defaultPrevented: boolean;
  /** The target is a text field, select or contenteditable element. */
  targetIsEditable: boolean;
  /** The target sits inside the dock. */
  targetInsideDock: boolean;
  /** A blocking modal dialog (`aria-modal="true"`) is open. */
  modalOpen: boolean;
}

/** What a key press did. The listener applies `preventDefault` / `stopPropagation` and moves focus. */
export interface DockKeyResult {
  state: DockState;
  /** The key was consumed (state changed or focus was requested). */
  handled: boolean;
  preventDefault: boolean;
  /** Escape closed the dock: stop it so playback and other Escape handlers do not also act. */
  stopPropagation: boolean;
  /** `/` was pressed: focus the Spotlight search field. */
  focusSpotlightInput: boolean;
}

function isModifierFree(e: DockKeyEvent): boolean {
  return !e.ctrlKey && !e.metaKey && !e.altKey;
}

/** Plain letter and slash shortcuts: no Ctrl/Meta/Alt, no auto-repeat, nothing took the event, not typing, no modal. */
function shortcutAllowed(e: DockKeyEvent): boolean {
  return isModifierFree(e) && !e.repeat && !e.defaultPrevented && !e.targetIsEditable && !e.modalOpen;
}

/** `T` or `t` (Shift allowed, for Caps Lock). */
export function isTrailsHotkey(e: DockKeyEvent): boolean {
  return (e.key === "t" || e.key === "T") && shortcutAllowed(e);
}

/** `/`: opens Spotlight. */
export function isSpotlightHotkey(e: DockKeyEvent): boolean {
  return e.key === "/" && shortcutAllowed(e);
}

/**
 * Escape collapses the dock, only when it is open. A modal dialog keeps its own
 * Escape. A text field outside the dock (an inline card editor) keeps Escape
 * too; a text field inside the dock (the Spotlight search) does not.
 */
export function isDockEscape(e: DockKeyEvent, open: boolean): boolean {
  return e.key === "Escape" && open && !e.modalOpen && (!e.targetIsEditable || e.targetInsideDock);
}

const unhandled = (state: DockState): DockKeyResult => ({
  state,
  handled: false,
  preventDefault: false,
  stopPropagation: false,
  focusSpotlightInput: false,
});

function openTab(state: DockState, tab: DockTab): DockState {
  return state.open && state.tab === tab ? state : { open: true, tab };
}

function toggleTab(state: DockState, tab: DockTab): DockState {
  return state.open && state.tab === tab ? { open: false, tab } : { open: true, tab };
}

/**
 * Resolves a key press against the dock state.
 * - `T`: the Trails tab toggles (open on Trails collapses; closed or on another tab opens Trails).
 * - `/`: opens Spotlight and asks for input focus; the slash is never typed (`preventDefault`).
 * - `Escape`: collapses an open dock (see `isDockEscape`).
 * Every other key, and every blocked case, changes nothing and prevents nothing.
 */
export function resolveDockKey(state: DockState, e: DockKeyEvent): DockKeyResult {
  if (e.key === "Escape") {
    if (!isDockEscape(e, state.open)) return unhandled(state);
    return { ...unhandled({ open: false, tab: state.tab }), handled: true, preventDefault: true, stopPropagation: true };
  }
  if (isTrailsHotkey(e)) {
    return { ...unhandled(toggleTab(state, "trails")), handled: true, preventDefault: true };
  }
  if (isSpotlightHotkey(e)) {
    return {
      ...unhandled(openTab(state, "spotlight")),
      handled: true,
      preventDefault: true,
      focusSpotlightInput: true,
    };
  }
  return unhandled(state);
}

export type DockEvent =
  | { type: "openTab"; tab: DockTab }
  | { type: "toggleTab"; tab: DockTab }
  | { type: "collapse" }
  | { type: "expand" }
  | { type: "key"; event: DockKeyEvent };

/** The dock reducer. Returns the same object when nothing changes. */
export function dockReducer(state: DockState, event: DockEvent): DockState {
  switch (event.type) {
    case "openTab":
      return openTab(state, event.tab);
    case "toggleTab":
      return toggleTab(state, event.tab);
    case "collapse":
      return state.open ? { open: false, tab: state.tab } : state;
    case "expand":
      return state.open ? state : { open: true, tab: state.tab };
    case "key": {
      const next = resolveDockKey(state, event.event).state;
      return next.open === state.open && next.tab === state.tab ? state : next;
    }
  }
}

/**
 * Synapse tab auto-activation: a selected ghost discovery or an inspected real
 * edge opens the dock on the Synapse tab. Clearing the selection never closes it.
 */
export function dockForSelection(
  state: DockState,
  selection: { selectedGhostDiscoveryId: string | null; inspectedEdgeId: string | null },
): DockState {
  return selection.selectedGhostDiscoveryId !== null || selection.inspectedEdgeId !== null
    ? openTab(state, "synapse")
    : state;
}

/** The Spec 08 view of the dock: the Curator's Index counts as open when the dock shows Trails. */
export function isTrailsOpen(state: DockState): boolean {
  return state.open && state.tab === "trails";
}

export type DockEscapeOwner = "modal" | "command-dock" | "playback" | "none";

/**
 * Who handles an Escape press. First match wins: an open modal dialog, then the
 * command dock, then trail playback (which exits the trail). Extends Spec 08's
 * `resolveEscapeOwner`, with the dock in place of the drawer.
 */
export function resolveDockEscapeOwner(input: {
  modalOpen: boolean;
  dockOpen: boolean;
  trailActive: boolean;
}): DockEscapeOwner {
  if (input.modalOpen) return "modal";
  if (input.dockOpen) return "command-dock";
  return input.trailActive ? "playback" : "none";
}

/** Trail playback reacts to arrows and Escape only when nothing above it wants the keys. */
export function shouldPlaybackHandleKeys(input: {
  dockOpen: boolean;
  modalOpen: boolean;
  targetIsEditable: boolean;
}): boolean {
  return !input.dockOpen && !input.modalOpen && !input.targetIsEditable;
}
