/**
 * Layout and keyboard glue for the Research Command Dock (Spec 09, phase B).
 * Pure numbers and plain-object conversions, so the rules are testable without
 * a DOM. No React, no store, no clock.
 */
import { DOCK_TABS, type DockKeyEvent, type DockTab } from "./command-dock";

/** Width of the open panel (px), capped at 90% of the viewport. */
export const DOCK_PANEL_WIDTH = 400;
/** Width of the always-visible rail (px). */
export const DOCK_RAIL_WIDTH = 48;
/** Below this viewport width the open panel overlays the canvas instead of making room for it. */
export const DOCK_OVERLAY_BREAKPOINT = 900;
/** Gap kept between right-anchored canvas elements and the dock (px). */
export const DOCK_GAP = 16;

/** Used before the first measurement (server render). */
const FALLBACK_VIEWPORT = 1440;

function safeWidth(viewportWidth: number): number {
  return Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : FALLBACK_VIEWPORT;
}

/** Real width of the open panel: 400 px, or 90% of the viewport when that is narrower. */
export function dockPanelWidth(viewportWidth: number): number {
  return Math.min(DOCK_PANEL_WIDTH, Math.floor(safeWidth(viewportWidth) * 0.9));
}

export interface DockInsets {
  /** Space (px) other right-anchored elements must leave on the right edge. */
  inset: number;
  /** True when the open panel covers the canvas instead of making room (narrow viewport). */
  overlay: boolean;
  panelWidth: number;
}

/**
 * How much of the right edge the dock occupies. Collapsed: the rail only.
 * Open on a wide viewport: panel plus rail. Open below `DOCK_OVERLAY_BREAKPOINT`:
 * the panel overlays the canvas, so the inset stays at the rail (elements keep
 * their place and the panel covers them, like any dialog).
 */
export function dockInsets(input: { open: boolean; viewportWidth: number }): DockInsets {
  const width = safeWidth(input.viewportWidth);
  const panelWidth = dockPanelWidth(width);
  const overlay = input.open && width < DOCK_OVERLAY_BREAKPOINT;
  const inset = input.open && !overlay ? DOCK_RAIL_WIDTH + panelWidth : DOCK_RAIL_WIDTH;
  return { inset, overlay, panelWidth };
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

/** The parts of a DOM `KeyboardEvent` the dock rules read (a plain object is enough in tests). */
export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  defaultPrevented: boolean;
}

/** The three readings only the DOM can give (see `components/trails/key-context.ts`). */
export interface DockKeyContext {
  targetIsEditable: boolean;
  targetInsideDock: boolean;
  modalOpen: boolean;
}

/** Combines a key event with the DOM readings into the plain `DockKeyEvent` the core rules take. */
export function toDockKeyEvent(e: KeyEventLike, ctx: DockKeyContext): DockKeyEvent {
  return {
    key: e.key,
    ctrlKey: e.ctrlKey,
    metaKey: e.metaKey,
    altKey: e.altKey,
    shiftKey: e.shiftKey,
    repeat: e.repeat,
    defaultPrevented: e.defaultPrevented,
    targetIsEditable: ctx.targetIsEditable,
    targetInsideDock: ctx.targetInsideDock,
    modalOpen: ctx.modalOpen,
  };
}

/**
 * Tab to focus after an arrow-key press on a tab button (WAI-ARIA tabs, automatic
 * activation): Left/Up go back, Right/Down go forward (both wrap), Home and End
 * jump. `null` for any other key, so the caller leaves it alone.
 */
export function nextDockTab(current: DockTab, key: string): DockTab | null {
  const i = DOCK_TABS.indexOf(current);
  const n = DOCK_TABS.length;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return DOCK_TABS[(i + 1) % n];
    case "ArrowLeft":
    case "ArrowUp":
      return DOCK_TABS[(i - 1 + n) % n];
    case "Home":
      return DOCK_TABS[0];
    case "End":
      return DOCK_TABS[n - 1];
    default:
      return null;
  }
}

/** Visible names of the tabs. */
export const DOCK_TAB_LABELS: Readonly<Record<DockTab, string>> = {
  trails: "REELS & TRAILS",
  synapse: "SYNAPSE INSPECT",
  spotlight: "SPOTLIGHT & FILTER",
};

export function dockTabId(tab: DockTab): string {
  return `command-dock-tab-${tab}`;
}

export function dockPanelId(tab: DockTab): string {
  return `command-dock-panel-${tab}`;
}

export const COMMAND_DOCK_ID = "command-dock";

// ---------------------------------------------------------------------------
// Rail copy
// ---------------------------------------------------------------------------

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function count(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

export interface RailButtonCopy {
  /** Short visible text, e.g. `3`. */
  badge: string;
  /** Accessible name and tooltip. */
  label: string;
}

export function trailsRailCopy(trailCount: number, open: boolean): RailButtonCopy {
  const n = count(trailCount);
  return {
    badge: String(n),
    label: `${open ? "Close" : "Open"} reels and trails: ${n} ${plural(n, "trail", "trails")} (T)`,
  };
}

export function synapseRailCopy(discoveryCount: number, open: boolean): RailButtonCopy {
  const n = count(discoveryCount);
  return {
    badge: String(n),
    label: `${open ? "Close" : "Open"} synapse inspector: ${n} ${plural(n, "discovery", "discoveries")}${n > 0 ? " to review" : ""}`,
  };
}

export function spotlightRailCopy(open: boolean): RailButtonCopy {
  return { badge: "", label: `${open ? "Close" : "Open"} spotlight and filter (/)` };
}
