import { rectGap, type Rect } from "./card-geometry";

/**
 * Geometry and copy for the magnetic arc overlay (Spec 09, phase B). Pure: no
 * React, no DOM, no clock.
 */

export interface Point {
  x: number;
  y: number;
}

/** The arc bows by this fraction of its chord length (design.md section 4). */
export const ARC_BOW = 0.2;
/** Longest concept text kept in the whisper pill (characters). */
export const ARC_CONCEPT_MAX = 32;
/** Longest card title kept in announcements (characters). */
export const ARC_TITLE_MAX = 60;

export interface ArcGeometry {
  from: Point;
  to: Point;
  /** Quadratic Bezier control point. */
  control: Point;
  /** Point of the curve at t = 0.5, where the whisper pill sits. */
  mid: Point;
  /** Straight distance between `from` and `to`; equals `rectGap` when the rectangles are apart. */
  length: number;
  /** SVG path `M from Q control to`, or `""` when the rectangles touch or overlap (nothing to draw). */
  path: string;
  /** The rectangles overlap or touch: there is no gap to bridge. */
  touching: boolean;
}

/** Coordinate on one axis: the facing sides when the intervals are apart, the middle of the overlap otherwise. */
function facingCoordinates(aStart: number, aEnd: number, bStart: number, bEnd: number): [number, number] {
  if (aEnd <= bStart) return [aEnd, bStart];
  if (bEnd <= aStart) return [aStart, bEnd];
  const mid = (Math.max(aStart, bStart) + Math.min(aEnd, bEnd)) / 2;
  return [mid, mid];
}

/**
 * Closest facing points of two rectangles. When the rectangles are apart on an
 * axis, the point sits on the facing side; when their ranges overlap on that
 * axis, it sits at the middle of the overlap. So for disjoint rectangles both
 * points lie ON the rectangle borders (a corner pair when they are diagonal)
 * and their distance equals `rectGap`. Overlapping rectangles give the same
 * point twice (the middle of the overlap).
 */
export function facingPoints(a: Rect, b: Rect): { from: Point; to: Point } {
  const [ax, bx] = facingCoordinates(a.x, a.x + a.width, b.x, b.x + b.width);
  const [ay, by] = facingCoordinates(a.y, a.y + a.height, b.y, b.y + b.height);
  return { from: { x: ax, y: ay }, to: { x: bx, y: by } };
}

const fmt = (n: number): string => String(Math.round(n * 100) / 100);

/**
 * The arc between two cards: a quadratic Bezier from the closest point of `a`
 * to the closest point of `b`. The control point is the chord midpoint pushed
 * `ARC_BOW` of the chord length along the left-hand normal, so the arc always
 * bows the same way for the same direction.
 */
export function arcGeometry(a: Rect, b: Rect): ArcGeometry {
  const { from, to } = facingPoints(a, b);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  const touching = length < 1e-6;
  const chordMid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const normal = touching ? { x: 0, y: 0 } : { x: -dy / length, y: dx / length };
  const control = {
    x: chordMid.x + normal.x * ARC_BOW * length,
    y: chordMid.y + normal.y * ARC_BOW * length,
  };
  const mid = {
    x: 0.25 * from.x + 0.5 * control.x + 0.25 * to.x,
    y: 0.25 * from.y + 0.5 * control.y + 0.25 * to.y,
  };
  return {
    from,
    to,
    control,
    mid,
    length,
    touching,
    path: touching
      ? ""
      : `M ${fmt(from.x)} ${fmt(from.y)} Q ${fmt(control.x)} ${fmt(control.y)} ${fmt(to.x)} ${fmt(to.y)}`,
  };
}

/** Pan and zoom of the canvas, as React Flow keeps them: a flow point `p` is drawn at `p * zoom + (x, y)`. */
export interface ViewTransform {
  x: number;
  y: number;
  zoom: number;
}

/** Screen position (relative to the canvas element) of a point in flow coordinates. */
export function flowToScreen(point: Point, view: ViewTransform): Point {
  return { x: point.x * view.zoom + view.x, y: point.y * view.zoom + view.y };
}

/** SVG `transform` attribute that maps flow coordinates to screen coordinates for everything inside it. */
export function viewTransformAttribute(view: ViewTransform): string {
  return `translate(${fmt(view.x)} ${fmt(view.y)}) scale(${view.zoom})`;
}

/** Gap between the two rectangles; re-exported so the overlay does not import two modules for one number. */
export const arcGap = rectGap;

// ---------------------------------------------------------------------------
// Signature: one primitive string the overlay selector returns
// ---------------------------------------------------------------------------

/** `x,y,w,h|x,y,w,h` as one string, so zustand's `Object.is` skips frames where nothing moved. */
export function arcSignature(a: Rect, b: Rect): string {
  return `${a.x},${a.y},${a.width},${a.height}|${b.x},${b.y},${b.width},${b.height}`;
}

/** Inverse of `arcSignature`; `null` for anything that is not two finite rectangles. */
export function parseArcSignature(signature: string): [Rect, Rect] | null {
  const parts = signature.split("|");
  if (parts.length !== 2) return null;
  const rects = parts.map((p) => {
    const n = p.split(",").map(Number);
    return n.length === 4 && n.every(Number.isFinite) ? { x: n[0], y: n[1], width: n[2], height: n[3] } : null;
  });
  const [a, b] = rects;
  return a !== null && b !== null ? [a, b] : null;
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

function ellipsize(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, Math.max(1, max - 1)).join("").trimEnd()}…`;
}

/** Readable concept: separators become spaces, whitespace collapses, long text is cut. Never empty. */
export function humanizeConcept(concept: string): string {
  const text = concept.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return text === "" ? "related ideas" : ellipsize(text, ARC_CONCEPT_MAX);
}

/** `⚡ 87% Nexus: associative linking — Drop to Snap Synapse`. */
export function magneticPillText(target: { affinity: number; concept: string }): string {
  const a = Number.isFinite(target.affinity) ? Math.min(1, Math.max(0, target.affinity)) : 0;
  return `⚡ ${Math.round(a * 100)}% Nexus: ${humanizeConcept(target.concept)} — Drop to Snap Synapse`;
}

function titleOf(title: string): string {
  const t = title.replace(/\s+/g, " ").trim();
  return t === "" ? "Untitled card" : ellipsize(t, ARC_TITLE_MAX);
}

/** Screen-reader line announced once per new target. */
export function magneticAnnouncement(sourceTitle: string, targetTitle: string): string {
  return `Magnetic link available between ${titleOf(sourceTitle)} and ${titleOf(targetTitle)}. Release to connect.`;
}

/** Toast text after a snap: `Synapse snapped: A ↔ B`. */
export function snapToastMessage(sourceTitle: string, targetTitle: string): string {
  return `Synapse snapped: ${titleOf(sourceTitle)} ↔ ${titleOf(targetTitle)}`;
}
