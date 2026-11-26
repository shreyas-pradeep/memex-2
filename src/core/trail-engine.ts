import type { AssociativeEdge, LinkOrigin, Trail } from "./types";

/**
 * Pure Vannevar Bush trail operations. No React, no clock, no randomness:
 * every function returns the same output for the same input.
 */

/** Timestamp used by `forgeCustomTrail` when the caller supplies none. */
export const TRAIL_EPOCH = "1945-07-01T00:00:00.000Z";

/** Removes repeated IDs, keeping the first occurrence of each. */
function dedupe(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/** FNV-1a hash rendered as base-36, used for deterministic trail IDs. */
function hashString(value: string): string {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** Builds a trail. Repeated node IDs are dropped (first occurrence wins). */
export function createTrail(
  id: string,
  title: string,
  description: string,
  nodeIds: readonly string[],
  origin: LinkOrigin,
  createdAt: string = TRAIL_EPOCH,
): Trail {
  return { id, title, description, origin, nodeIds: dedupe(nodeIds), createdAt };
}

/**
 * Removes a node from a trail while keeping the order of the rest
 * (a subsequence of the original). Returns the same reference when the node
 * is not part of the trail.
 */
export function removeNodeFromTrail(trail: Trail, nodeId: string): Trail {
  if (!trail.nodeIds.includes(nodeId)) return trail;
  return { ...trail, nodeIds: trail.nodeIds.filter((id) => id !== nodeId) };
}

/**
 * Edges that connect consecutive stops of the trail, in either direction.
 * Result order follows `edges`.
 */
export function getTrailEdges(
  trail: Trail,
  edges: readonly AssociativeEdge[],
): AssociativeEdge[] {
  const pairs = new Set<string>();
  for (let i = 0; i + 1 < trail.nodeIds.length; i++) {
    const a = trail.nodeIds[i];
    const b = trail.nodeIds[i + 1];
    pairs.add(`${a}\u0000${b}`);
    pairs.add(`${b}\u0000${a}`);
  }
  return edges.filter((e) => pairs.has(`${e.source}\u0000${e.target}`));
}

/** Clamps `index` into `[0, length - 1]`; `-1` for an empty trail. */
export function clampTrailIndex(index: number, length: number): number {
  if (!Number.isFinite(length) || length <= 0) return -1;
  const i = Number.isFinite(index) ? Math.trunc(index) : 0;
  return Math.min(Math.max(i, 0), Math.floor(length) - 1);
}

/** Next stop, held at the last stop. `-1` when the trail is empty. */
export function getNextTrailIndex(current: number, length: number): number {
  const base = clampTrailIndex(current, length);
  return base === -1 ? -1 : clampTrailIndex(base + 1, length);
}

/** Previous stop, held at the first stop. `-1` when the trail is empty. */
export function getPrevTrailIndex(current: number, length: number): number {
  const base = clampTrailIndex(current, length);
  return base === -1 ? -1 : clampTrailIndex(base - 1, length);
}

/**
 * Forges a trail from an ordered selection. The ID is derived from the inputs
 * so the result is deterministic; callers that need uniqueness pass `meta.id`.
 */
export function forgeCustomTrail(
  title: string,
  description: string,
  nodeIds: readonly string[],
  origin: LinkOrigin,
  meta: { id?: string; createdAt?: string } = {},
): Trail {
  const cleanTitle = title.trim() || "Untitled Trail";
  const id =
    meta.id ?? `t-${origin}-${hashString(`${cleanTitle}\u0000${nodeIds.join("\u0000")}`)}`;
  return createTrail(
    id,
    cleanTitle,
    description.trim(),
    nodeIds,
    origin,
    meta.createdAt ?? TRAIL_EPOCH,
  );
}
