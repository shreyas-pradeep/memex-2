import type { MemexNode } from "./types";

/**
 * Pure card geometry shared by magnetic snapping (Spec 09) and cassette frames.
 * No React, no DOM, no clock.
 */

/** Default card box (px) for cards that carry no size of their own. */
export const DEFAULT_CARD_SIZE = { width: 340, height: 230 } as const;

/** Coordinates beyond this magnitude are treated as invalid, so float spacing never erodes padding. */
export const MAX_GEOMETRY_COORDINATE = 1e9;

/** Axis-aligned rectangle in flow coordinates (top-left origin). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function isCoordinate(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= MAX_GEOMETRY_COORDINATE;
}

/** True for a rect whose four numbers are usable (finite, bounded, non-negative size). */
export function isValidRect(r: Rect): boolean {
  return isCoordinate(r.x) && isCoordinate(r.y) && isCoordinate(r.width) && isCoordinate(r.height) && r.width >= 0 && r.height >= 0;
}

function positiveSize(n: unknown): number | undefined {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Real rectangle of a card: `style` size first (the single source of truth the
 * resizer writes), then React Flow's `width`/`height` attributes, then the
 * measured size, then `DEFAULT_CARD_SIZE`. `null` when the position is not finite.
 */
export function nodeRect(
  node: Pick<MemexNode, "position" | "style" | "width" | "height" | "measured">,
): Rect | null {
  const { x, y } = node.position;
  if (!isCoordinate(x) || !isCoordinate(y)) return null;
  const width =
    positiveSize(node.style?.width) ??
    positiveSize(node.width) ??
    positiveSize(node.measured?.width) ??
    DEFAULT_CARD_SIZE.width;
  const height =
    positiveSize(node.style?.height) ??
    positiveSize(node.height) ??
    positiveSize(node.measured?.height) ??
    DEFAULT_CARD_SIZE.height;
  return { x, y, width, height };
}

/**
 * Shortest Euclidean gap between two rectangles: `0` when they overlap or
 * touch, otherwise the distance between their nearest edges (or corners).
 * Symmetric and never negative.
 */
export function rectGap(a: Rect, b: Rect): number {
  const dx = Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width), 0);
  const dy = Math.max(a.y - (b.y + b.height), b.y - (a.y + a.height), 0);
  return Math.hypot(dx, dy);
}
