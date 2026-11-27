import {
  WEAVE_MIN_CARDS,
  canStartWeave,
  type WeaveGateInput,
} from "./sprocket-motion";
import { forgeCustomTrail, getEventYear, normalizeTrailColor } from "./trail-engine";
import { autoTrailKind, isAutoTrailId } from "./trail-genesis";
import { EDGE_COLORS, type LinkOrigin, type MemexNode, type Trail } from "./types";

/**
 * The Curator's Index (Spec 08): pure logic behind the left-hand trail drawer.
 * No React, no store, no clock, no randomness: every function returns the same
 * output for the same input, so fast-check can test it directly.
 */

// ---------------------------------------------------------------------------
// Constants and copy
// ---------------------------------------------------------------------------

/** A trail needs at least this many existing cards. */
export const MIN_TRAIL_CARDS = 2;
/** Breadcrumb pills shown per trail card before the "+N" overflow pill. */
export const BREADCRUMB_MAX_VISIBLE = 6;
/** Characters of a card title kept in a breadcrumb pill (the full title stays in `fullLabel`). */
export const BREADCRUMB_TITLE_MAX = 26;
/** Shown when a card has no usable title. */
export const UNTITLED_CARD = "Untitled card";
/** Shown when a trail has no usable title. */
export const UNTITLED_TRAIL = "Untitled Trail";
/** Id of the top-bar trigger, so focus can return to it when the drawer closes. */
export const CURATOR_TRIGGER_ID = "curators-index-trigger";
/** Id of the drawer, for the trigger's `aria-controls`. */
export const CURATOR_DRAWER_ID = "curators-index-drawer";

export const CURATOR_TITLE = "THE CURATOR'S INDEX // REEL ARCHIVE";
export const CURATOR_EMPTY_TEXT =
  "The reel archive is empty. Blaze a trail from selected cards, or let Sprocket weave one.";
export const BLAZE_ORDER_HINT =
  "Stops follow canvas position, left to right, then top to bottom. The canvas does not record the order you click cards.";

export type TrailArchetype = "lineage" | "debate" | "nexus" | "manual" | "ghost";

export const ARCHETYPE_LABELS: Readonly<Record<TrailArchetype, string>> = {
  lineage: "AI Lineage Arc",
  debate: "Dialectical Debate",
  nexus: "Conceptual Nexus",
  manual: "Manual Trail",
  ghost: "Ghost Trail",
};

// ---------------------------------------------------------------------------
// Small list helpers
// ---------------------------------------------------------------------------

/** Removes repeated ids, keeping the first occurrence of each and the original order. */
export function dedupeKeepOrder(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/** `dedupeKeepOrder`, then drops every id that is not in `known`. Order is preserved. */
export function sanitizeCardIds(ids: readonly string[], known: Iterable<string>): string[] {
  const set = new Set(known);
  return dedupeKeepOrder(ids).filter((id) => set.has(id));
}

/**
 * `candidate` when no existing id equals it, else `candidate-2`, `candidate-3`
 * and so on until one is free. Always terminates because `existing` is finite.
 */
export function uniqueTrailId(existing: Iterable<string>, candidate: string): string {
  const taken = new Set(existing);
  if (!taken.has(candidate)) return candidate;
  for (let n = 2; ; n++) {
    const next = `${candidate}-${n}`;
    if (!taken.has(next)) return next;
  }
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function finiteOrZero(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

/**
 * The ids of the selected cards in reading order: left to right, then top to
 * bottom (ties by id). The canvas keeps no record of the order the user
 * clicked, so position is the only order available.
 */
export function orderSelectedCardIds(
  nodes: readonly { id: string; position: { x: number; y: number }; selected?: boolean }[],
): string[] {
  return nodes
    .filter((n) => n.selected === true)
    .sort(
      (a, b) =>
        finiteOrZero(a.position.x) - finiteOrZero(b.position.x) ||
        finiteOrZero(a.position.y) - finiteOrZero(b.position.y) ||
        cmp(a.id, b.id),
    )
    .map((n) => n.id);
}

// ---------------------------------------------------------------------------
// Manual trail creation
// ---------------------------------------------------------------------------

export interface ManualTrailInput {
  title: string;
  description: string;
  /** Ordered card ids as the user gave them. */
  cardIds: readonly string[];
  /** Ids of the cards that exist. Anything else is dropped. */
  knownNodeIds: Iterable<string>;
  existingTrailIds: Iterable<string>;
  /** Random-looking suffix for the id (the store passes a UUID slice); only uniqueness handling lives here. */
  idSeed: string;
  createdAt: string;
  /** Optional `#RRGGBB`; ignored when invalid. */
  color?: string;
}

/**
 * Builds a human trail on top of `forgeCustomTrail` (Spec 02): the exact order
 * of `cardIds` is kept, repeats are dropped (first occurrence wins), unknown
 * ids are dropped, and the title is trimmed with the "Untitled Trail" fallback.
 * Returns `null` when fewer than `MIN_TRAIL_CARDS` valid cards remain.
 *
 * The id is `t-<idSeed>`, made unique against `existingTrailIds`, and never
 * looks like an auto trail id, so `buildTrailCardModel` can never mistake a
 * manual trail for a generated one.
 */
export function buildManualTrail(input: ManualTrailInput): Trail | null {
  const valid = sanitizeCardIds(input.cardIds, input.knownNodeIds);
  if (valid.length < MIN_TRAIL_CARDS) return null;
  const base = `t-${input.idSeed}`;
  const candidate = isAutoTrailId(base) ? `t-m-${input.idSeed}` : base;
  // A `-N` suffix cannot turn a non-auto id into an auto one (those end in 8 hex digits).
  const id = uniqueTrailId(input.existingTrailIds, candidate);
  return forgeCustomTrail(input.title, input.description, valid, "human", {
    id,
    createdAt: input.createdAt,
    color: input.color,
  });
}

export interface BlazeFormState {
  /** The submit button is usable. */
  canSubmit: boolean;
  /** Inline hint that explains what is missing, or `null` when the form is ready. */
  hint: string | null;
}

/** Validation for the "Blaze new trail" form. The name is optional (it falls back to "Untitled Trail"). */
export function blazeFormState(selectedCount: number): BlazeFormState {
  const n = Number.isFinite(selectedCount) ? Math.max(0, Math.floor(selectedCount)) : 0;
  if (n >= MIN_TRAIL_CARDS) return { canSubmit: true, hint: null };
  return {
    canSubmit: false,
    hint:
      n === 0
        ? "Select at least 2 cards on the canvas to blaze a trail."
        : `Select at least 2 cards on the canvas to blaze a trail (${n} selected).`,
  };
}

// ---------------------------------------------------------------------------
// Loading into the lever
// ---------------------------------------------------------------------------

export interface LeverState {
  activeTrailId: string;
  activeTrailIndex: 0;
  isPlayingAuto: false;
}

/**
 * The playback state for loading a trail into the 1945 Lever: that trail, stop
 * 0, auto-play off. `null` for an unknown id or a trail with no cards, so the
 * caller leaves playback alone.
 */
export function loadTrailState(
  trails: readonly Pick<Trail, "id" | "nodeIds">[],
  trailId: string,
): LeverState | null {
  const trail = trails.find((t) => t.id === trailId);
  if (!trail || trail.nodeIds.length === 0) return null;
  return { activeTrailId: trail.id, activeTrailIndex: 0, isPlayingAuto: false };
}

// ---------------------------------------------------------------------------
// Trail card view-model
// ---------------------------------------------------------------------------

export interface Breadcrumb {
  nodeId: string;
  /** Truncated title, plus the first author's surname when the card has authors. */
  label: string;
  /** The untruncated label, for tooltips. */
  fullLabel: string;
}

export interface EraSpan {
  from: number;
  to: number;
}

export interface TrailCardModel {
  id: string;
  title: string;
  description: string;
  origin: LinkOrigin;
  archetype: TrailArchetype;
  archetypeLabel: string;
  /** `#RRGGBB`: the trail's own valid color, else the origin color. */
  accent: string;
  /** True when `accent` comes from the trail's `color` field. */
  hasCustomColor: boolean;
  /** Stops whose card still exists. */
  stopCount: number;
  eraSpan: EraSpan | null;
  /** `1945 → 2026`, `1945` for a single year, `null` when no stop has a year. */
  eraLabel: string | null;
  /** `5 stops • 1945 → 2026`; the era part is left out when unknown. */
  summaryLine: string;
  /** Visible pills in trail order, at most `BREADCRUMB_MAX_VISIBLE`; stops whose card is missing are skipped. */
  breadcrumbs: Breadcrumb[];
  /** Stops that exist but are not shown as pills (render as "+N"). */
  overflowCount: number;
}

export interface TrailCardOptions {
  maxBreadcrumbs?: number;
  maxTitleChars?: number;
}

/** `text` with whitespace collapsed, cut to at most `max` code points and ended with `…` when cut. */
export function truncateLabel(text: string, max: number): string {
  const clean = text.trim().replace(/\s+/g, " ");
  const limit = Number.isFinite(max) ? Math.max(1, Math.floor(max)) : BREADCRUMB_TITLE_MAX;
  const chars = [...clean];
  if (chars.length <= limit) return clean;
  return `${chars.slice(0, limit - 1).join("").trimEnd()}…`;
}

const NAME_SUFFIX = /^(?:jr|sr|ii|iii|iv)\.?$/i;

/**
 * Family name read off an author string. `Vaswani, Ashish` gives `Vaswani`;
 * `Ashish Vaswani` gives `Vaswani` (last word, skipping `Jr.`, `III` and the
 * like). `null` when nothing letter-like can be read. Nothing is invented: the
 * result is always a piece of the input.
 */
export function authorSurname(author: string): string | null {
  const text = author.trim();
  if (text === "") return null;
  const head = text.includes(",") ? text.slice(0, text.indexOf(",")) : null;
  let candidate: string | undefined;
  if (head !== null && head.trim() !== "") {
    candidate = head.trim().split(/\s+/).pop();
  } else {
    const words = text.split(/\s+/).filter((w) => w !== "");
    while (words.length > 1 && NAME_SUFFIX.test(words[words.length - 1])) words.pop();
    candidate = words.pop();
  }
  const cleaned = (candidate ?? "").replace(/^[.,;:()[\]"']+|[.,;:()[\]"']+$/g, "");
  return /\p{L}/u.test(cleaned) ? cleaned : null;
}

/** `Vaswani et al.` for several authors, `Vaswani` for one, `null` without authors. */
export function authorSuffix(authors: readonly string[] | undefined): string | null {
  const names = (authors ?? []).filter((a) => typeof a === "string" && a.trim() !== "");
  if (names.length === 0) return null;
  const surname = authorSurname(names[0]);
  if (surname === null) return null;
  return names.length > 1 ? `${surname} et al.` : surname;
}

/** Which archetype a trail shows: generated kind from the id, else by origin. */
export function trailArchetype(trail: Pick<Trail, "id" | "origin">): TrailArchetype {
  const kind = autoTrailKind(trail.id);
  if (kind !== null) return kind;
  return trail.origin === "ghost" ? "ghost" : "manual";
}

type NodeLike = Pick<MemexNode, "id" | "data">;

function cardModel(
  trail: Trail,
  byId: ReadonlyMap<string, NodeLike>,
  options: TrailCardOptions,
): TrailCardModel {
  const requested = options.maxBreadcrumbs;
  const maxCrumbs =
    typeof requested === "number" && Number.isFinite(requested)
      ? Math.max(0, Math.floor(requested))
      : BREADCRUMB_MAX_VISIBLE;
  const maxTitle = options.maxTitleChars ?? BREADCRUMB_TITLE_MAX;
  const stops: Breadcrumb[] = [];
  let from = Infinity;
  let to = -Infinity;
  for (const nodeId of trail.nodeIds) {
    const node = byId.get(nodeId);
    if (!node) continue;
    const rawTitle = node.data.title.trim() === "" ? UNTITLED_CARD : node.data.title.trim();
    const suffix = authorSuffix(node.data.authors);
    const tail = suffix === null ? "" : ` · ${suffix}`;
    stops.push({
      nodeId,
      label: `${truncateLabel(rawTitle, maxTitle)}${tail}`,
      fullLabel: `${rawTitle.replace(/\s+/g, " ")}${tail}`,
    });
    const year = getEventYear(node.data);
    if (year !== null) {
      from = Math.min(from, year);
      to = Math.max(to, year);
    }
  }
  const eraSpan: EraSpan | null = Number.isFinite(from) && Number.isFinite(to) ? { from, to } : null;
  const eraLabel = eraSpan === null ? null : eraSpan.from === eraSpan.to ? String(eraSpan.from) : `${eraSpan.from} → ${eraSpan.to}`;
  const archetype = trailArchetype(trail);
  const customColor = normalizeTrailColor(trail.color);
  const stopCount = stops.length;
  const base = `${stopCount} ${stopCount === 1 ? "stop" : "stops"}`;
  const shown = stops.slice(0, maxCrumbs);
  return {
    id: trail.id,
    title: trail.title.trim() === "" ? UNTITLED_TRAIL : trail.title.trim(),
    description: trail.description.trim(),
    origin: trail.origin,
    archetype,
    archetypeLabel: ARCHETYPE_LABELS[archetype],
    accent: customColor ?? EDGE_COLORS[trail.origin],
    hasCustomColor: customColor !== undefined,
    stopCount,
    eraSpan,
    eraLabel,
    summaryLine: eraLabel === null ? base : `${base} • ${eraLabel}`,
    breadcrumbs: shown,
    overflowCount: stopCount - shown.length,
  };
}

/** View-model of one trail for the Curator's Index card. Stops whose card is gone are skipped. */
export function buildTrailCardModel(
  trail: Trail,
  nodes: readonly NodeLike[],
  options: TrailCardOptions = {},
): TrailCardModel {
  return cardModel(trail, new Map(nodes.map((n) => [n.id, n])), options);
}

/**
 * View-models for every trail in display order: most recently added first, so
 * a freshly blazed trail sits at the top. Builds the card lookup once.
 */
export function buildTrailCardModels(
  trails: readonly Trail[],
  nodes: readonly NodeLike[],
  options: TrailCardOptions = {},
): TrailCardModel[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return trails.map((t) => cardModel(t, byId, options)).reverse();
}

/** The models as one string. A store selector returns it so zustand's `Object.is` skips unchanged lists. */
export function serializeTrailCardModels(models: readonly TrailCardModel[]): string {
  return JSON.stringify(models);
}

/** Inverse of `serializeTrailCardModels`; an invalid string gives `[]`. */
export function parseTrailCardModels(signature: string): TrailCardModel[] {
  if (signature === "") return [];
  try {
    const raw: unknown = JSON.parse(signature);
    return Array.isArray(raw) ? (raw as TrailCardModel[]) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Auto-weave quick action
// ---------------------------------------------------------------------------

export interface WeaveQuickAction {
  enabled: boolean;
  /** Tooltip and screen-reader text: what the button does, or why it is disabled. */
  hint: string;
}

/** Mirrors the HUD button: usable with 3+ cards, no active trail and no weave running. */
export function weaveQuickAction(input: WeaveGateInput): WeaveQuickAction {
  if (input.isWeaving) {
    return { enabled: false, hint: "Sprocket is weaving. Press Esc or click Sprocket to stop." };
  }
  if (input.activeTrailId !== null) {
    return { enabled: false, hint: "Exit the playing trail to weave a new one." };
  }
  if (!canStartWeave(input)) {
    return {
      enabled: false,
      hint: `Sprocket needs at least ${WEAVE_MIN_CARDS} cards to weave a trail.`,
    };
  }
  return {
    enabled: true,
    hint: "Sprocket generates a trail from your cards and scampers along it.",
  };
}

// ---------------------------------------------------------------------------
// Drawer state machine and keyboard rules
// ---------------------------------------------------------------------------

/**
 * A key press as plain data, so the rules can be tested without a DOM. The
 * component fills it from a `KeyboardEvent`: the three booleans at the end come
 * from the DOM (`isContentEditable` or input/textarea/select, containment in
 * the drawer, any `[aria-modal="true"]` dialog).
 */
export interface CuratorKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  defaultPrevented: boolean;
  /** The target is a text field or contenteditable element. */
  targetIsEditable: boolean;
  /** The target sits inside the drawer. */
  targetInsideDrawer: boolean;
  /** A blocking modal dialog (platen, add card, AI settings, briefing) is open. */
  modalOpen: boolean;
}

/**
 * `T` (or `t`) toggles the drawer. Not with Ctrl, Meta or Alt (Shift is fine:
 * Caps Lock gives `T`), not for auto-repeat, not when another handler already
 * took the event, not while typing, and not while a modal dialog is open.
 */
export function isCuratorHotkey(e: CuratorKeyEvent): boolean {
  return (
    (e.key === "t" || e.key === "T") &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.altKey &&
    !e.repeat &&
    !e.defaultPrevented &&
    !e.targetIsEditable &&
    !e.modalOpen
  );
}

/**
 * `Escape` closes the drawer, and only when it is open. A modal dialog keeps
 * its own Escape. A text field outside the drawer (an inline card editor) keeps
 * Escape too; a text field inside the drawer (the blaze form) does not.
 */
export function isCuratorEscape(e: CuratorKeyEvent, open: boolean): boolean {
  return (
    e.key === "Escape" && open && !e.modalOpen && (!e.targetIsEditable || e.targetInsideDrawer)
  );
}

export type CuratorDrawerEvent =
  | { type: "toggle" }
  | { type: "open" }
  | { type: "close" }
  /** An Escape key press; closes only when `isCuratorEscape` allows it. */
  | { type: "escape"; event: CuratorKeyEvent }
  /** A `T` key press; toggles only when `isCuratorHotkey` allows it. */
  | { type: "hotkey"; event: CuratorKeyEvent }
  /** Any key press: routed to `escape` or `hotkey`, anything else changes nothing. */
  | { type: "key"; event: CuratorKeyEvent };

/** Whether the drawer is open. Session-only; never persisted or exported. */
export type CuratorDrawerState = boolean;

export function curatorDrawerReducer(
  open: CuratorDrawerState,
  action: CuratorDrawerEvent,
): CuratorDrawerState {
  switch (action.type) {
    case "toggle":
      return !open;
    case "open":
      return true;
    case "close":
      return false;
    case "escape":
      return isCuratorEscape(action.event, open) ? false : open;
    case "hotkey":
      return isCuratorHotkey(action.event) ? !open : open;
    case "key":
      return curatorDrawerReducer(open, {
        type: action.event.key === "Escape" ? "escape" : "hotkey",
        event: action.event,
      });
  }
}

export type EscapeOwner = "modal" | "curator-drawer" | "dock" | "none";

/**
 * Who handles an Escape press. First match wins: an open modal dialog, then the
 * Curator's Index, then the playback dock (which exits the trail). So Escape in
 * the drawer closes the drawer and leaves playback running.
 */
export function resolveEscapeOwner(input: {
  modalOpen: boolean;
  drawerOpen: boolean;
  trailActive: boolean;
}): EscapeOwner {
  if (input.modalOpen) return "modal";
  if (input.drawerOpen) return "curator-drawer";
  return input.trailActive ? "dock" : "none";
}

/**
 * The playback dock reacts to arrows and Escape only when nothing above it
 * wants the keys: not while the drawer is open, a modal is open or the user is
 * typing.
 */
export function shouldDockHandleKeys(input: {
  drawerOpen: boolean;
  modalOpen: boolean;
  targetIsEditable: boolean;
}): boolean {
  return !input.drawerOpen && !input.modalOpen && !input.targetIsEditable;
}
