import { isValidRect, nodeRect, type Rect } from "./card-geometry";
import type { MemexNode } from "./types";

/**
 * Microfiche cassettes (Spec 09): cards distilled from one ingested source
 * share a `cassetteId`. This module groups them, frames them and moves them as
 * one unit. Pure: no React, no store, no clock.
 */

/** Padding (px) between the member cards and the cassette frame. */
export const CASSETTE_PADDING = 24;
export const CASSETTE_ID_PREFIX = "cassette-";
/** Longest cassette title kept (code units). */
export const CASSETTE_TITLE_MAX = 80;

export interface Cassette {
  id: string;
  title: string;
  /** Member card ids, sorted. */
  memberIds: string[];
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Cassettes present on the canvas: one per distinct `cassetteId`, only those
 * with at least one member, sorted by id. The title is the first non-empty
 * `cassetteTitle` among the members (in member-id order), else the id.
 */
export function groupCassettes(nodes: readonly Pick<MemexNode, "id" | "data">[]): Cassette[] {
  const groups = new Map<string, { id: string; title: string | undefined }[]>();
  for (const n of nodes) {
    const cid = n.data.cassetteId;
    if (typeof cid !== "string" || cid === "") continue;
    const list = groups.get(cid) ?? [];
    list.push({ id: n.id, title: n.data.cassetteTitle });
    groups.set(cid, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => cmp(a, b))
    .map(([id, members]) => {
      members.sort((x, y) => cmp(x.id, y.id));
      const title = members.find((m) => typeof m.title === "string" && m.title.trim() !== "")?.title;
      return { id, title: title ?? id, memberIds: members.map((m) => m.id) };
    });
}

/**
 * Frame around member rectangles: the union of every valid rect, grown by
 * `padding` on all four sides, so each rect (corners included) lies inside
 * with `padding` to spare. Rects with non-finite, out-of-range or negative
 * numbers are ignored; `null` when none is valid. Negative or non-finite
 * `padding` counts as 0. Width and height are never negative.
 */
export function cassetteBounds(rects: readonly Rect[], padding: number = CASSETTE_PADDING): Rect | null {
  const pad = Number.isFinite(padding) && padding > 0 ? padding : 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    if (!isValidRect(r)) continue;
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  if (minX === Infinity) return null;
  return {
    x: minX - pad,
    y: minY - pad,
    width: maxX - minX + 2 * pad,
    height: maxY - minY + 2 * pad,
  };
}

/** Frame of one cassette on the canvas (`null` when it has no member with a usable position). */
export function cassetteFrame(
  nodes: readonly MemexNode[],
  cassetteId: string,
  padding: number = CASSETTE_PADDING,
): Rect | null {
  const rects: Rect[] = [];
  for (const n of nodes) {
    if (n.data.cassetteId !== cassetteId) continue;
    const r = nodeRect(n);
    if (r !== null) rects.push(r);
  }
  return cassetteBounds(rects, padding);
}

/**
 * Shifts every member of a cassette by `(dx, dy)`. Non-members keep their
 * object identity. A non-finite delta, a zero delta or an unknown cassette
 * returns the same array. Relative offsets between members are preserved.
 */
export function moveCassette(
  nodes: readonly MemexNode[],
  cassetteId: string,
  dx: number,
  dy: number,
): MemexNode[] {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) {
    return nodes as MemexNode[];
  }
  let changed = false;
  const next = nodes.map((n) => {
    if (n.data.cassetteId !== cassetteId) return n;
    changed = true;
    return { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } };
  });
  return changed ? next : (nodes as MemexNode[]);
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/** Cassette id for an arXiv paper: `cassette-1706.03762` (version suffix dropped, unsafe characters become `-`). */
export function arxivCassetteId(arxivId: string): string {
  const base = arxivId.replace(/v\d+$/i, "").replace(/[^A-Za-z0-9._-]+/g, "-");
  return `${CASSETTE_ID_PREFIX}${base}`;
}

/** Cassette id for a text source, from the 8-hex hash that also prefixes its card ids. */
export function hashCassetteId(hash8: string): string {
  return `${CASSETTE_ID_PREFIX}${hash8}`;
}

export interface CassetteRef {
  id: string;
  title: string;
}

/** `{ id, title }` of every cassette present in `nodes` (one per id, sorted). */
export function cassetteRefs(nodes: readonly Pick<MemexNode, "id" | "data">[]): CassetteRef[] {
  return groupCassettes(nodes).map((c) => ({ id: c.id, title: c.title }));
}

/**
 * Collision-safe cassette id. When `baseId` is free it is used. When an
 * existing cassette has the same id AND the same title it is the same source,
 * and the id is reused (the new cards join it). Otherwise `-2`, `-3`, ... is
 * appended until the id is free or belongs to the same source. Deterministic.
 */
export function resolveCassetteId(
  baseId: string,
  title: string,
  existing: Iterable<CassetteRef>,
): string {
  const byId = new Map<string, string>();
  for (const e of existing) byId.set(e.id, e.title);
  let id = baseId;
  for (let k = 2; byId.has(id) && byId.get(id) !== title; k++) id = `${baseId}-${k}`;
  return id;
}
