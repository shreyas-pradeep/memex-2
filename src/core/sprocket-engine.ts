/**
 * Pure logic for "The Ghost & Sprocket" (Spec 06): edge wire geometry, Sprocket's
 * position along a wire, quips, the ghost-inspection target, the guidance state
 * machine and the retro toast catalog and reducer.
 *
 * No React, no clock, no randomness: time and idle values are injected by the
 * caller, so every function returns the same output for the same input.
 */

import type { GhostDiscovery } from "./types";

// ---------------------------------------------------------------------------
// Geometry primitives
// ---------------------------------------------------------------------------

export interface Point {
  x: number;
  y: number;
}

/** A card rectangle in flow coordinates. Width and height may be negative or zero (see `rectToBounds`). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Axis-aligned box with `minX <= maxX` and `minY <= maxY`. */
export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export type EdgeSide = "top" | "bottom" | "left" | "right";

/** A cubic Bezier segment: start, two control points, end. */
export interface CubicCurve {
  p0: Point;
  p1: Point;
  p2: Point;
  p3: Point;
}

/** Largest magnitude a coordinate may have; keeps all arithmetic finite. */
export const MAX_COORDINATE = 1e12;

/** Curvature the associative edge passes to React Flow's `getBezierPath`. */
export const EDGE_CURVATURE = 0.35;

/** Card size the edge assumes before React Flow has measured the node. */
export const EDGE_FALLBACK_CARD_SIZE = { width: 280, height: 160 } as const;

/** Sprocket sprite size (px, flow units). */
export const SPROCKET_SIZE = 24;

/** Distance from a card's right edge to the perch center. Keeps the corner resize handle free. */
export const PERCH_INSET_X = 48;

/** Fraction of a traversal spent hopping from/to the perch at each end (the wire gets the rest). */
export const TRAVERSAL_HOP_FRACTION = 0.15;

/** Replaces NaN with 0 and clamps to `[-MAX_COORDINATE, MAX_COORDINATE]`. */
export function sane(value: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  return Math.min(MAX_COORDINATE, Math.max(-MAX_COORDINATE, value));
}

/** Clamps to `[0, 1]`; NaN becomes 0. */
export function clamp01(value: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function saneRect(r: Rect): Rect {
  return { x: sane(r.x), y: sane(r.y), width: sane(r.width), height: sane(r.height) };
}

/**
 * Bounding box of a rectangle. A negative width or height spans the other way
 * (reversed rectangle); NaN and infinite values count as 0 / the coordinate limit.
 */
export function rectToBounds(rect: Rect): Bounds {
  const r = saneRect(rect);
  const x2 = r.x + r.width;
  const y2 = r.y + r.height;
  return {
    minX: Math.min(r.x, x2),
    minY: Math.min(r.y, y2),
    maxX: Math.max(r.x, x2),
    maxY: Math.max(r.y, y2),
  };
}

/** Smallest box containing both. */
export function unionBounds(a: Bounds, b: Bounds): Bounds {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

/** Bounding box of the union of two rectangles. */
export function unionOfRects(a: Rect, b: Rect): Bounds {
  return unionBounds(rectToBounds(a), rectToBounds(b));
}

/** Moves a point into `bounds`. NaN coordinates become 0 first; the result is always finite and inside. */
export function clampToBounds(point: Point, bounds: Bounds): Point {
  return {
    x: Math.min(bounds.maxX, Math.max(bounds.minX, sane(point.x))),
    y: Math.min(bounds.maxY, Math.max(bounds.minY, sane(point.y))),
  };
}

export function lerpPoint(a: Point, b: Point, t: number): Point {
  const k = clamp01(t);
  if (k === 0) return { x: a.x, y: a.y };
  if (k === 1) return { x: b.x, y: b.y };
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
}

/**
 * Point on a cubic Bezier at parameter `t` (clamped to `[0, 1]`, NaN is 0).
 * `t = 0` and `t = 1` return the end points exactly.
 */
export function cubicBezierPoint(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const k = clamp01(t);
  if (k === 0) return { x: p0.x, y: p0.y };
  if (k === 1) return { x: p3.x, y: p3.y };
  const m = 1 - k;
  const a = m * m * m;
  const b = 3 * m * m * k;
  const c = 3 * m * k * k;
  const d = k * k * k;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

/** Point on a `CubicCurve` at parameter `t`. */
export function sampleCurve(curve: CubicCurve, t: number): Point {
  return cubicBezierPoint(curve.p0, curve.p1, curve.p2, curve.p3, t);
}

// ---------------------------------------------------------------------------
// Edge wire geometry (shared with AssociativePulseEdge)
// ---------------------------------------------------------------------------

/** Anchor point of a card side: the middle of that side. */
export function edgeAnchor(rect: Rect, side: EdgeSide): Point {
  const r = saneRect(rect);
  switch (side) {
    case "top":
      return { x: r.x + r.width / 2, y: r.y };
    case "bottom":
      return { x: r.x + r.width / 2, y: r.y + r.height };
    case "left":
      return { x: r.x, y: r.y + r.height / 2 };
    default:
      return { x: r.x + r.width, y: r.y + r.height / 2 };
  }
}

/** Picks the facing sides of two cards from their relative placement. */
export function facingSides(source: Rect, target: Rect): [EdgeSide, EdgeSide] {
  const s = saneRect(source);
  const t = saneRect(target);
  const dx = t.x + t.width / 2 - (s.x + s.width / 2);
  const dy = t.y + t.height / 2 - (s.y + s.height / 2);
  const horizontal = Math.abs(dx) / (s.width + t.width) >= Math.abs(dy) / (s.height + t.height);
  if (horizontal) {
    return dx >= 0 ? ["right", "left"] : ["left", "right"];
  }
  return dy >= 0 ? ["bottom", "top"] : ["top", "bottom"];
}

export interface EdgeGeometry {
  source: Point;
  target: Point;
  sourceSide: EdgeSide;
  targetSide: EdgeSide;
}

/** Where the edge leaves the source card and enters the target card. */
export function getEdgeGeometry(source: Rect, target: Rect): EdgeGeometry {
  const [sourceSide, targetSide] = facingSides(source, target);
  return {
    source: edgeAnchor(source, sourceSide),
    target: edgeAnchor(target, targetSide),
    sourceSide,
    targetSide,
  };
}

/** Same rule as React Flow's `calculateControlOffset`. */
function controlOffset(distance: number, curvature: number): number {
  if (distance >= 0) return 0.5 * distance;
  return curvature * 25 * Math.sqrt(-distance);
}

/** Bezier control point for one end, same rule as React Flow's `getControlWithCurvature`. */
function controlPoint(side: EdgeSide, from: Point, to: Point, curvature: number): Point {
  switch (side) {
    case "left":
      return { x: from.x - controlOffset(from.x - to.x, curvature), y: from.y };
    case "right":
      return { x: from.x + controlOffset(to.x - from.x, curvature), y: from.y };
    case "top":
      return { x: from.x, y: from.y - controlOffset(from.y - to.y, curvature) };
    default:
      return { x: from.x, y: from.y + controlOffset(to.y - from.y, curvature) };
  }
}

/**
 * Bezier through given anchors and sides: the same four points React Flow's
 * `getBezierPath` turns into `M p0 C p1 p2 p3`.
 */
export function getBezierCurve(
  source: Point,
  sourceSide: EdgeSide,
  target: Point,
  targetSide: EdgeSide,
  curvature: number = EDGE_CURVATURE,
): CubicCurve {
  return {
    p0: source,
    p1: controlPoint(sourceSide, source, target, curvature),
    p2: controlPoint(targetSide, target, source, curvature),
    p3: target,
  };
}

/** The wire the associative edge draws between two cards. */
export function getEdgeCurve(
  source: Rect,
  target: Rect,
  curvature: number = EDGE_CURVATURE,
): CubicCurve {
  const g = getEdgeGeometry(source, target);
  return getBezierCurve(g.source, g.sourceSide, g.target, g.targetSide, curvature);
}

// ---------------------------------------------------------------------------
// Sprocket position
// ---------------------------------------------------------------------------

/**
 * Sprocket's center on the wire from `source` to `target` at parameter `t`
 * (clamped to `[0, 1]`). The result is clamped into the union bounding box of
 * both card rectangles, so it never leaves the area the two cards span.
 */
export function getSprocketPosition(source: Rect, target: Rect, t: number): Point {
  const curve = getEdgeCurve(saneRect(source), saneRect(target));
  return clampToBounds(sampleCurve(curve, t), unionOfRects(source, target));
}

/** Midpoint of the wire between two cards (where a synapse's pill sits). */
export function getEdgeMidpoint(source: Rect, target: Rect): Point {
  return getSprocketPosition(source, target, 0.5);
}

/**
 * Sprocket's resting place: the top-right of a card's header, centered on the
 * card's top edge and inset from the corner so the resize handle stays free.
 * Always inside the card's bounding box. The breathing bob is a visual
 * transform only and never changes this value.
 */
export function getPerchPosition(rect: Rect): Point {
  const b = rectToBounds(rect);
  return clampToBounds({ x: b.maxX - PERCH_INSET_X, y: b.minY }, b);
}

export type WireDirection = "forward" | "reverse" | "none";

/**
 * Whether a real edge joins `a` and `b`: `forward` when it runs a to b,
 * `reverse` when it runs b to a, `none` when absent. Forward wins when both exist.
 */
export function findWireDirection(
  edges: readonly { source: string; target: string }[],
  a: string,
  b: string,
): WireDirection {
  let reverse = false;
  for (const e of edges) {
    if (e.source === a && e.target === b) return "forward";
    if (e.source === b && e.target === a) reverse = true;
  }
  return reverse ? "reverse" : "none";
}

/**
 * Sprocket's center while scurrying from card `from` to card `to`, with
 * `progress` in `[0, 1]`: a short hop from the perch to the wire, the wire
 * itself, then a short hop to the new perch. A `reverse` wire (the stored edge
 * runs `to` to `from`) is sampled on the stored curve, walked backwards, so
 * Sprocket follows exactly the line that is drawn. Always inside the union
 * bounding box of the two cards.
 */
export function getTraversalPoint(
  from: Rect,
  to: Rect,
  progress: number,
  direction: WireDirection = "forward",
): Point {
  const p = clamp01(progress);
  const hop = TRAVERSAL_HOP_FRACTION;
  const wire = (t: number): Point =>
    direction === "reverse" ? getSprocketPosition(to, from, 1 - t) : getSprocketPosition(from, to, t);
  const bounds = unionOfRects(from, to);
  let point: Point;
  if (p < hop) {
    point = lerpPoint(getPerchPosition(from), wire(0), p / hop);
  } else if (p > 1 - hop) {
    point = lerpPoint(wire(1), getPerchPosition(to), (p - (1 - hop)) / hop);
  } else {
    point = wire((p - hop) / (1 - 2 * hop));
  }
  return clampToBounds(point, bounds);
}

// ---------------------------------------------------------------------------
// Card rectangles from store nodes
// ---------------------------------------------------------------------------

/** The parts of a store node needed to know its rectangle. `MemexNode` satisfies this. */
export interface RectSource {
  position: { x: number; y: number };
  width?: number | null;
  height?: number | null;
  measured?: { width?: number; height?: number };
  style?: { width?: unknown; height?: unknown };
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Card rectangle in flow coordinates. Size comes from the measured size, then
 * `width`/`height`, then `style`, then `fallback`.
 */
export function resolveCardRect(
  node: RectSource,
  fallback: { width: number; height: number } = EDGE_FALLBACK_CARD_SIZE,
): Rect {
  return {
    x: sane(node.position.x),
    y: sane(node.position.y),
    width:
      positiveNumber(node.measured?.width) ??
      positiveNumber(node.width) ??
      positiveNumber(node.style?.width) ??
      fallback.width,
    height:
      positiveNumber(node.measured?.height) ??
      positiveNumber(node.height) ??
      positiveNumber(node.style?.height) ??
      fallback.height,
  };
}

// ---------------------------------------------------------------------------
// Quips
// ---------------------------------------------------------------------------

/** What Sprocket says when clicked, in order. The em dash in the second quip is intentional. */
export const SPROCKET_QUIPS = [
  "Synapse tensile strength nominal, Professor!",
  "Careful with that 1945 lever—gears haven't been greased since Engelbart's demo.",
  "I found a conceptual bridge! Or maybe it's just lint in the microfilm reel.",
  "Associative trails verified. Vannevar Bush would be proud.",
] as const;

/** Maps any number to a valid quip index in `[0, SPROCKET_QUIPS.length)`. Non-finite values map to 0. */
export function normalizeQuipIndex(index: number): number {
  const n = SPROCKET_QUIPS.length;
  if (typeof index !== "number" || !Number.isFinite(index)) return 0;
  const whole = Math.trunc(index);
  return ((whole % n) + n) % n;
}

/** The quip for a click counter. Wraps modulo the number of quips; never empty. */
export function selectSprocketQuip(index: number): string {
  return SPROCKET_QUIPS[normalizeQuipIndex(index)];
}

/** The click counter after one more click. Wraps, so it never grows without bound. */
export function advanceQuipIndex(index: number): number {
  return (normalizeQuipIndex(index) + 1) % SPROCKET_QUIPS.length;
}

// ---------------------------------------------------------------------------
// Ghost inspection
// ---------------------------------------------------------------------------

function confidenceKey(d: GhostDiscovery): number {
  return typeof d.confidence === "number" && !Number.isNaN(d.confidence)
    ? d.confidence
    : Number.NEGATIVE_INFINITY;
}

/**
 * The highest-confidence discovery in `next` whose id is not in `previous`.
 * Equal confidence is broken by the smaller id, so the pick does not depend on
 * array order. `undefined` when nothing is new.
 */
export function pickInspectionTarget(
  previous: readonly GhostDiscovery[],
  next: readonly GhostDiscovery[],
): GhostDiscovery | undefined {
  const known = new Set(previous.map((d) => d.id));
  let best: GhostDiscovery | undefined;
  for (const d of next) {
    if (known.has(d.id)) continue;
    if (best === undefined) {
      best = d;
      continue;
    }
    const a = confidenceKey(d);
    const b = confidenceKey(best);
    if (a > b || (a === b && d.id < best.id)) best = d;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Timing constants
// ---------------------------------------------------------------------------

/** Matches the camera glide (`TRAIL_CAMERA_MS`). */
export const SPROCKET_SCURRY_MS = 800;
/** How long the "!" shows before Sprocket runs to a new synapse. */
export const SPROCKET_ALERT_MS = 900;
/** Length of the "inspecting" animation at a new synapse. */
export const SPROCKET_INSPECT_MS = 2000;
/** How long a quip bubble stays. */
export const SPROCKET_BUBBLE_MS = 3500;
/** How long the Ghost counts as awake after a scan found new synapses. */
export const GHOST_AFTERGLOW_MS = 2500;

// ---------------------------------------------------------------------------
// Guidance state machine
// ---------------------------------------------------------------------------

/** Idle time after which the beacon whispers a hint. */
export const IDLE_THRESHOLD_MS = 15000;

/** True when `idleMs` is strictly greater than the threshold. NaN and negative values are not idle. */
export function isIdle(idleMs: number): boolean {
  return typeof idleMs === "number" && idleMs > IDLE_THRESHOLD_MS;
}

export type GuidanceStateId =
  | "empty-canvas"
  | "scanning"
  | "trail-playing"
  | "trail-active"
  | "discoveries-pending"
  | "idle-whisper"
  | "no-trails"
  | "cards-no-trail";

/** Every state, in priority order (highest first). */
export const GUIDANCE_STATE_IDS: readonly GuidanceStateId[] = [
  "empty-canvas",
  "scanning",
  "trail-playing",
  "trail-active",
  "discoveries-pending",
  "idle-whisper",
  "no-trails",
  "cards-no-trail",
];

export interface GuidanceInput {
  cardCount: number;
  activeTrailId: string | null;
  isPlayingAuto: boolean;
  discoveryCount: number;
  isGhostScanning: boolean;
  /** Milliseconds since the last pointer or keyboard activity. */
  idleMs: number;
  /** Number of saved trails. Omit when unknown (treated as at least one). */
  trailCount?: number;
}

export interface GuidanceMessage {
  id: GuidanceStateId;
  text: string;
}

/**
 * Hint text per state. Bracketed names match the real controls: `[I]` opens the
 * platen, `[▶]` and `[❚❚ Auto-Play]` are the dock's auto-play button, `[Next]` is
 * "Next ▶", `[⚡ WAKE GHOST ENGINE]` is the HUD's "⚡ Wake Ghost Engine" button (set in
 * capitals by its CSS), the `[📜]` icon on the right-hand rail (or `[T]`) opens the Reels & Trails
 * tab of the command dock (Spec 09; it replaced the Spec 08 top button) and
 * `[+ BLAZE NEW TRAIL]` is that tab's form button.
 */
export const GUIDANCE_TEXT: Readonly<Record<GuidanceStateId, string>> = {
  "empty-canvas": "The microfilm reels are blank. Press [I] to scan a document onto the platen.",
  scanning: "The Ghost Engine is sweeping the archive. Watch for glowing violet ⚡ SYNAPSE links.",
  "trail-playing":
    "Automated walkthrough underway. Press [❚❚ Auto-Play] to pause, or [Esc] to leave the trail.",
  "trail-active": "Press [▶] to begin automated camera walkthrough, or use [Next] to step manually.",
  "discoveries-pending":
    "The Ghost found hidden links. Click a ⚡ SYNAPSE badge on the canvas to open the inspector.",
  "idle-whisper":
    "The archives whisper... tap [⚡ WAKE GHOST ENGINE] to reveal hidden latent connections.",
  "no-trails":
    "No trails charted yet. Select two or more cards, then click the [📜] rail icon or press [T] and choose [+ BLAZE NEW TRAIL].",
  "cards-no-trail":
    "Click the [📜] rail icon or press [T] to pick an associative trail and pull up the 1945 Lever.",
};

/** Every guidance text names a control in brackets or starts an action with one of these verbs. */
export const GUIDANCE_ACTION_PATTERN = /\[[^\]]+\]|\b(?:press|select|click|tap|watch|use)\b/i;

/**
 * Picks the guidance state. Priority, first match wins:
 * 1. no cards: empty-canvas
 * 2. Ghost scanning: scanning
 * 3. a trail is active and auto-playing: trail-playing
 * 4. a trail is active: trail-active
 * 5. synapses are waiting: discoveries-pending
 * 6. idle for more than `IDLE_THRESHOLD_MS`: idle-whisper
 * 7. no trails saved: no-trails
 * 8. otherwise: cards-no-trail
 * Invalid numbers are treated as 0 (no cards, no discoveries, not idle).
 */
export function getGuidanceStateId(input: GuidanceInput): GuidanceStateId {
  const cards = input.cardCount > 0;
  if (!cards) return "empty-canvas";
  if (input.isGhostScanning) return "scanning";
  if (input.activeTrailId !== null) return input.isPlayingAuto ? "trail-playing" : "trail-active";
  if (input.discoveryCount > 0) return "discoveries-pending";
  if (isIdle(input.idleMs)) return "idle-whisper";
  if (input.trailCount !== undefined && !(input.trailCount > 0)) return "no-trails";
  return "cards-no-trail";
}

/** The guidance for the current state of the archive. Always a non-empty, actionable sentence. */
export function getGuidanceMessage(input: GuidanceInput): GuidanceMessage {
  const id = getGuidanceStateId(input);
  return { id, text: GUIDANCE_TEXT[id] };
}

// ---------------------------------------------------------------------------
// Retro toasts
// ---------------------------------------------------------------------------

export const EMPTY_DROP_MESSAGE =
  "Even a 1945 vacuum tube cannot decipher blank parchment, Professor. Feed the platen some ink.";
export const TRAIL_END_MESSAGE =
  "You have arrived at the frontier of human knowledge. Blaze a new trail to proceed.";
export const ARXIV_INVALID_MESSAGE =
  "The signal was lost in the ether. Please check your arXiv identifier.";

export const NO_AUTO_TRAIL_MESSAGE =
  "The reels hold no clear trail yet, Professor. Add a few dated or related cards and try again.";

export const SNAP_MESSAGE = "Synapse snapped. The two cards are now linked.";
export const VAULT_MESSAGE = "The vault is secure, Professor.";
export const VAULT_ERROR_MESSAGE = "The vault would not open. Nothing on the canvas was changed.";

export type ToastKind =
  | "EMPTY_DROP"
  | "TRAIL_END"
  | "ARXIV_INVALID"
  | "NO_AUTO_TRAIL"
  | "SNAP"
  | "VAULT"
  | "VAULT_ERROR";

/** Longest custom toast text kept (characters). */
export const TOAST_MESSAGE_MAX = 200;

/** Message and monospace label for every toast kind. */
export const TOAST_CATALOG: Readonly<Record<ToastKind, { label: string; message: string }>> = {
  EMPTY_DROP: { label: "[ SIGNAL // NOTICE ]", message: EMPTY_DROP_MESSAGE },
  TRAIL_END: { label: "[ SIGNAL // FRONTIER ]", message: TRAIL_END_MESSAGE },
  ARXIV_INVALID: { label: "[ SIGNAL // LOST ]", message: ARXIV_INVALID_MESSAGE },
  NO_AUTO_TRAIL: { label: "[ SIGNAL // STATIC ]", message: NO_AUTO_TRAIL_MESSAGE },
  SNAP: { label: "[ SIGNAL // LINKED ]", message: SNAP_MESSAGE },
  VAULT: { label: "[ SIGNAL // VAULT ]", message: VAULT_MESSAGE },
  VAULT_ERROR: { label: "[ SIGNAL // FAULT ]", message: VAULT_ERROR_MESSAGE },
};

/** Most toasts on screen at once. */
export const MAX_TOASTS = 3;
/** Time before a toast dismisses itself. */
export const TOAST_DURATION_MS = 4500;

export interface ToastEntry {
  id: number;
  kind: ToastKind;
  label: string;
  message: string;
}

export interface ToastState {
  /** Oldest first; the newest toast is last. */
  toasts: readonly ToastEntry[];
  nextId: number;
}

export const EMPTY_TOAST_STATE: ToastState = { toasts: [], nextId: 1 };

/**
 * Adds a toast. An optional `message` replaces the catalog text (whitespace
 * collapsed, cut to `TOAST_MESSAGE_MAX`); a blank one is ignored. A toast whose message equals the newest toast's message is
 * dropped (same state returned). When more than `MAX_TOASTS` would show, the
 * oldest are removed.
 */
export function pushToast(state: ToastState, kind: ToastKind, message?: string): ToastState {
  const base = TOAST_CATALOG[kind];
  // An optional text replaces the catalog message (a toast that names its cards or counts).
  const custom = message === undefined ? "" : message.replace(/\s+/g, " ").trim().slice(0, TOAST_MESSAGE_MAX);
  const copy = custom === "" ? base : { label: base.label, message: custom };
  const newest = state.toasts[state.toasts.length - 1];
  if (newest !== undefined && newest.message === copy.message) return state;
  const entry: ToastEntry = { id: state.nextId, kind, label: copy.label, message: copy.message };
  return {
    toasts: [...state.toasts, entry].slice(-MAX_TOASTS),
    nextId: state.nextId + 1,
  };
}

/** Removes a toast by id. The same state is returned when the id is not showing. */
export function dismissToast(state: ToastState, id: number): ToastState {
  if (!state.toasts.some((t) => t.id === id)) return state;
  return { ...state, toasts: state.toasts.filter((t) => t.id !== id) };
}
