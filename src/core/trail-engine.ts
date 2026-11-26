import type { AssociativeEdge, LinkOrigin, MemexNode, MemexNodeData, Trail } from "./types";

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

// ---------------------------------------------------------------------------
// Chronological timeline (Requirement 5)
// ---------------------------------------------------------------------------

const DATE_PATTERN = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Parsed `YYYY`, `YYYY-MM` or `YYYY-MM-DD`; `month`/`day` are 0 when absent. `null` if invalid. */
function parseDateParts(date: string): { year: number; month: number; day: number } | null {
  const m = DATE_PATTERN.exec(date.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = m[2] === undefined ? 0 : Number(m[2]);
  const day = m[3] === undefined ? 0 : Number(m[3]);
  if (m[2] !== undefined && (month < 1 || month > 12)) return null;
  if (m[3] !== undefined && (day < 1 || day > daysInMonth(year, month))) return null;
  return { year, month, day };
}

/**
 * The sortable value of a card's event date, or `null` when it has none.
 *
 * `year` wins when it is a finite integer. Otherwise `date` is parsed
 * (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`). The value is `year * 10000 + month * 100 +
 * day`, with missing month/day as 0, so a bare year sorts before dated entries
 * within that year. Missing or unparseable input yields `null`: no date is ever
 * invented.
 */
export function getEventSortKey(data: Pick<MemexNodeData, "year" | "date">): number | null {
  if (typeof data.year === "number" && Number.isInteger(data.year)) return data.year * 10000;
  if (typeof data.date === "string") {
    const p = parseDateParts(data.date);
    if (p) return p.year * 10000 + p.month * 100 + p.day;
  }
  return null;
}

/** Calendar year of a card's effective event date, or `null` when undated. */
export function getEventYear(data: Pick<MemexNodeData, "year" | "date">): number | null {
  const key = getEventSortKey(data);
  return key === null ? null : Math.trunc(key / 10000);
}

/** Display text for the event date (`1945`, `1945-07`, `1945-07-02`), or `null` when undated. */
export function formatEventDate(data: Pick<MemexNodeData, "year" | "date">): string | null {
  if (getEventSortKey(data) === null) return null;
  if (typeof data.year === "number" && Number.isInteger(data.year)) return String(data.year);
  return typeof data.date === "string" ? data.date.trim() : null;
}

export type EventDateParse =
  | { ok: true; year?: number; date?: string }
  | { ok: false };

/**
 * Parses user input for the event date field. Empty input is valid and means
 * "no date". `1945` becomes `{ year: 1945 }`; `1945-07` / `1945-07-02` become
 * `{ date }`. Anything else (including impossible dates like `2023-02-30`) is
 * rejected.
 */
export function parseEventDateInput(input: string): EventDateParse {
  const text = input.trim();
  if (text === "") return { ok: true };
  if (/^\d{1,4}$/.test(text)) return { ok: true, year: Number(text) };
  if (parseDateParts(text) === null) return { ok: false };
  return { ok: true, date: text };
}

/**
 * Dated cards only, ascending by effective event date. Ties break by
 * `createdAt` then `id` (string order), so the result is deterministic and
 * independent of input order. Undated or unparseable cards are excluded.
 * Does not mutate the input.
 */
export function getChronologicalNodes(nodes: readonly MemexNode[]): MemexNode[] {
  const dated: { node: MemexNode; key: number }[] = [];
  for (const node of nodes) {
    const key = getEventSortKey(node.data);
    if (key !== null) dated.push({ node, key });
  }
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  dated.sort(
    (a, b) =>
      a.key - b.key ||
      cmp(a.node.data.createdAt, b.node.data.createdAt) ||
      cmp(a.node.id, b.node.id),
  );
  return dated.map((d) => d.node);
}
