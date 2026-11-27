import {
  CONCEPT_LEXICON,
  conceptIdsOf,
  normalizedTags,
  scoreGhostPairs,
} from "./ghost-engine";
import { getEdgePolarity, singleLine } from "./synthesis-engine";
import { TRAIL_EPOCH, getChronologicalNodes, getEventSortKey, getEventYear } from "./trail-engine";
import type { AssociativeEdge, GhostDiscovery, MemexNode, Trail } from "./types";

/**
 * AI Auto-Trail Genesis (Spec 07). Pure and deterministic: no React, no clock,
 * no randomness. Builds up to three narrative trails from the graph itself and
 * only when the data supports them; it never invents content or pads a trail
 * with unrelated cards.
 *
 * Determinism: inputs are copied and sorted by id (nodes), by
 * `(source, target, id)` (edges) and by `id` (discoveries) before any rule runs,
 * so the output does not depend on input array order. The one exception is a
 * repeated node id (invalid in a real graph; `addNode` rejects it): which of the
 * duplicates is kept then depends on input order.
 */

export type AutoTrailKind = "lineage" | "debate" | "nexus";

/** Trail id prefix shared by every auto-generated trail. */
export const AUTO_TRAIL_PREFIX = "t-auto-";

/** Fewest cards in an auto trail. */
export const AUTO_TRAIL_MIN_STEPS = 3;
/** Most cards in an auto trail (and the default for `maxSteps`). */
export const AUTO_TRAIL_MAX_STEPS = 8;

/**
 * Minimum affinity (`GhostPairScore.base`, 0..1) for the Dense Conceptual Nexus.
 * It gates the seed pair and the mean affinity of every card that joins, so the
 * cluster's mean pairwise affinity is never below it. The ghost threshold for
 * a suggested bridge is 0.3; 0.25 is slightly looser because a cluster is
 * judged on its mean, not on one pair.
 */
export const NEXUS_MIN_AFFINITY = 0.25;
/** Added to a candidate's mean affinity when an existing edge or discovery links it to the cluster. Never lifts a card past the minimum. */
export const NEXUS_LINK_BOOST = 0.05;

export const LINEAGE_TITLE = "Lineage Arc";
export const DEBATE_TITLE = "Dialectical Debate";
export const NEXUS_TITLE = "Dense Conceptual Nexus";

export interface AutoTrailOptions {
  /** ISO-8601 timestamp for every trail. Default: the newest `createdAt` among the trail's own cards. */
  createdAt?: string;
  /** Most cards per trail, clamped to `[3, 8]` (default 8). */
  maxSteps?: number;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** FNV-1a over the ordered ids, as 8 lowercase hex digits. */
export function hashIds(ids: readonly string[]): string {
  const text = ids.join("\u0000");
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Deterministic id of an auto trail: `t-auto-<kind>-<8 hex of the ordered node ids>`. */
export function autoTrailId(kind: AutoTrailKind, nodeIds: readonly string[]): string {
  return `${AUTO_TRAIL_PREFIX}${kind}-${hashIds(nodeIds)}`;
}

/** The kind encoded in an auto trail id, or `null` for any other trail. */
export function autoTrailKind(trailId: string): AutoTrailKind | null {
  const m = /^t-auto-(lineage|debate|nexus)-[0-9a-f]{8}$/.exec(trailId);
  return m ? (m[1] as AutoTrailKind) : null;
}

/** True for ids produced by `autoTrailId`. */
export function isAutoTrailId(trailId: string): boolean {
  return autoTrailKind(trailId) !== null;
}

/** `maxSteps` clamped into `[AUTO_TRAIL_MIN_STEPS, AUTO_TRAIL_MAX_STEPS]`; non-finite becomes the maximum. */
export function clampMaxSteps(maxSteps: number | undefined): number {
  if (typeof maxSteps !== "number" || !Number.isFinite(maxSteps)) return AUTO_TRAIL_MAX_STEPS;
  return Math.min(AUTO_TRAIL_MAX_STEPS, Math.max(AUTO_TRAIL_MIN_STEPS, Math.floor(maxSteps)));
}

function uniqueSortedNodes(nodes: readonly MemexNode[]): MemexNode[] {
  const seen = new Set<string>();
  return [...nodes]
    .sort((a, b) => cmp(a.id, b.id))
    .filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true)));
}

function titleOf(node: MemexNode, max = 70): string {
  const raw = singleLine(node.data.title).trim() || node.data.archivalId || node.id;
  return raw.length <= max ? raw : `${raw.slice(0, max - 1).trimEnd()}…`;
}

function quoted(node: MemexNode): string {
  return `"${titleOf(node)}"`;
}

function withYear(node: MemexNode): string {
  const year = getEventYear(node.data);
  return year === null ? quoted(node) : `${quoted(node)} (${year})`;
}

function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Newest `createdAt` among the cards (ISO strings sort lexicographically), or the trail epoch. */
function newestCreatedAt(nodes: readonly MemexNode[]): string {
  let best = "";
  for (const n of nodes) if (n.data.createdAt > best) best = n.data.createdAt;
  return best === "" ? TRAIL_EPOCH : best;
}

/** Labels of the concepts that at least two of the cards touch, most shared first (ties by label). */
function recurringConcepts(nodes: readonly MemexNode[], limit = 3): string[] {
  const counts = new Map<string, number>();
  for (const n of nodes) {
    for (const id of conceptIdsOf(n.data)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts]
    .filter(([, c]) => c >= 2)
    .map(([id, c]) => ({ label: CONCEPT_LEXICON[id]?.label ?? id, count: c }))
    .sort((a, b) => b.count - a.count || cmp(a.label, b.label))
    .slice(0, limit)
    .map((c) => c.label);
}

/** Tags that at least two of the cards carry, most shared first (ties alphabetical). */
function recurringTags(nodes: readonly MemexNode[], limit = 3): string[] {
  const counts = new Map<string, number>();
  for (const n of nodes) for (const t of normalizedTags(n.data)) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))
    .slice(0, limit)
    .map(([t]) => t);
}

function recurringSentence(nodes: readonly MemexNode[]): string {
  const concepts = recurringConcepts(nodes);
  return concepts.length === 0 ? "" : ` Recurring concepts: ${joinList(concepts)}.`;
}

interface Context {
  nodes: MemexNode[];
  byId: Map<string, MemexNode>;
  /** Edges between two distinct existing cards, sorted by `(source, target, id)`. */
  edges: AssociativeEdge[];
  /** Undirected neighbours from real edges and discoveries. */
  neighbours: Map<string, Set<string>>;
  maxSteps: number;
  createdAt: string | undefined;
}

function buildContext(
  nodesIn: readonly MemexNode[],
  edgesIn: readonly AssociativeEdge[],
  discoveries: readonly GhostDiscovery[],
  options: AutoTrailOptions,
): Context {
  const nodes = uniqueSortedNodes(nodesIn);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = edgesIn
    .filter((e) => e.source !== e.target && byId.has(e.source) && byId.has(e.target))
    .sort((a, b) => cmp(a.source, b.source) || cmp(a.target, b.target) || cmp(a.id, b.id));
  const neighbours = new Map<string, Set<string>>(nodes.map((n) => [n.id, new Set<string>()]));
  const link = (a: string, b: string) => {
    if (a === b || !byId.has(a) || !byId.has(b)) return;
    neighbours.get(a)?.add(b);
    neighbours.get(b)?.add(a);
  };
  for (const e of edges) link(e.source, e.target);
  for (const d of [...discoveries].sort((a, b) => cmp(a.id, b.id))) link(d.sourceId, d.targetId);
  return {
    nodes,
    byId,
    edges,
    neighbours,
    maxSteps: clampMaxSteps(options.maxSteps),
    createdAt: options.createdAt,
  };
}

function makeTrail(
  ctx: Context,
  kind: AutoTrailKind,
  title: string,
  description: string,
  ids: readonly string[],
): Trail {
  const cards = ids.map((id) => ctx.byId.get(id)).filter((n): n is MemexNode => n !== undefined);
  return {
    id: autoTrailId(kind, ids),
    title,
    description,
    origin: "ghost",
    nodeIds: [...ids],
    createdAt: ctx.createdAt ?? newestCreatedAt(cards),
  };
}

// ---------------------------------------------------------------------------
// 1. Lineage Arc
// ---------------------------------------------------------------------------

/**
 * Order in which indices `0..count-1` are visited by repeated midpoint
 * bisection (middle first, then the middles of each half, breadth first). Taking
 * a prefix of it gives an evenly spread subset.
 */
export function bisectionOrder(count: number): number[] {
  const out: number[] = [];
  const queue: Array<[number, number]> = count > 0 ? [[0, count - 1]] : [];
  for (let i = 0; i < queue.length; i++) {
    const [lo, hi] = queue[i];
    if (lo > hi) continue;
    const mid = Math.floor((lo + hi) / 2);
    out.push(mid);
    queue.push([lo, mid - 1], [mid + 1, hi]);
  }
  return out;
}

/**
 * Chooses `limit` cards from a chronological list: always the first and the
 * last, then the middle cards ranked by degree (existing edges and discoveries,
 * most connected first), with ties broken by the bisection order (an even
 * spread over the timeline) and then by id. Returned in the original
 * chronological order, so years stay non-decreasing.
 */
export function selectLineageCards(
  chronological: readonly MemexNode[],
  neighbours: ReadonlyMap<string, ReadonlySet<string>>,
  limit: number,
): MemexNode[] {
  if (chronological.length <= limit) return [...chronological];
  const first = chronological[0];
  const last = chronological[chronological.length - 1];
  const middle = chronological.slice(1, -1);
  const rank = new Map<number, number>(bisectionOrder(middle.length).map((idx, r) => [idx, r]));
  const picked = middle
    .map((node, index) => ({
      node,
      index,
      degree: neighbours.get(node.id)?.size ?? 0,
      spread: rank.get(index) ?? index,
    }))
    .sort((a, b) => b.degree - a.degree || a.spread - b.spread || cmp(a.node.id, b.node.id))
    .slice(0, Math.max(0, limit - 2))
    .sort((a, b) => a.index - b.index)
    .map((p) => p.node);
  return [first, ...picked, last];
}

function lineageArc(ctx: Context): Trail | null {
  const dated = getChronologicalNodes(ctx.nodes);
  if (dated.length < AUTO_TRAIL_MIN_STEPS) return null;
  const cards = selectLineageCards(dated, ctx.neighbours, ctx.maxSteps);
  const first = cards[0];
  const last = cards[cards.length - 1];
  const y0 = getEventYear(first.data);
  const yN = getEventYear(last.data);
  const middle = cards.slice(1, -1);
  const span = y0 === yN ? `all dated ${y0}` : `from ${y0} to ${yN}`;
  let text =
    `A chronological arc of ${cards.length} dated cards ${span}. ` +
    `It opens with ${withYear(first)} and closes with ${withYear(last)}.`;
  if (middle.length > 0) text += ` Intermediate stops: ${joinList(middle.map(withYear))}.`;
  if (dated.length > cards.length) {
    text += ` Chosen from ${dated.length} dated cards: the first, the last, the most connected and an even spread between.`;
  }
  text += recurringSentence(cards);
  return makeTrail(ctx, "lineage", LINEAGE_TITLE, text, cards.map((c) => c.id));
}

// ---------------------------------------------------------------------------
// 2. Dialectical Debate
// ---------------------------------------------------------------------------

/** Connected components (sorted card ids) of an undirected edge list. */
function components(pairs: ReadonlyArray<readonly [string, string]>): string[][] {
  const adj = new Map<string, string[]>();
  for (const [a, b] of pairs) {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a)?.push(b);
    adj.get(b)?.push(a);
  }
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const start of [...adj.keys()].sort(cmp)) {
    if (seen.has(start)) continue;
    const group: string[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      group.push(cur);
      for (const next of adj.get(cur) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    out.push(group.sort(cmp));
  }
  return out;
}

/**
 * Orders cards: chronologically (event key, `createdAt`, id) when every card is
 * dated, otherwise by first appearance in `appearance` (the sorted edge list).
 */
function orderCards(
  ids: readonly string[],
  ctx: Context,
  appearance: ReadonlyMap<string, number>,
): string[] {
  const cards = ids.map((id) => ctx.byId.get(id)).filter((n): n is MemexNode => n !== undefined);
  const keys = cards.map((c) => getEventSortKey(c.data));
  if (keys.every((k) => k !== null)) {
    return [...cards]
      .sort(
        (a, b) =>
          (getEventSortKey(a.data) as number) - (getEventSortKey(b.data) as number) ||
          cmp(a.data.createdAt, b.data.createdAt) ||
          cmp(a.id, b.id),
      )
      .map((c) => c.id);
  }
  return [...cards]
    .sort((a, b) => (appearance.get(a.id) ?? 1e9) - (appearance.get(b.id) ?? 1e9) || cmp(a.id, b.id))
    .map((c) => c.id);
}

/**
 * Dialectical component: cards joined by `refutes` edges, plus the cards that
 * `synthesizes` edges attach to them (the synthesis). Needs at least one
 * `refutes` edge and three distinct cards. The largest component wins (ties:
 * smallest first id). Order: refuting cards first (thesis, antithesis), then the
 * synthesis cards; each group by year when all its cards are dated, otherwise
 * by first appearance in the sorted edge list. Over `maxSteps`, the synthesis
 * group keeps at most `max(1, floor(maxSteps / 4))` cards and the refuting group
 * is cut from its end to make room.
 */
function dialecticalDebate(ctx: Context): Trail | null {
  const refutes = ctx.edges.filter((e) => getEdgePolarity(e) === "refutes");
  if (refutes.length === 0) return null;
  const synth = ctx.edges.filter((e) => getEdgePolarity(e) === "synthesizes");
  const groups = components(refutes.map((e) => [e.source, e.target] as const));

  const appearance = new Map<string, number>();
  let seq = 0;
  for (const e of [...refutes, ...synth]) {
    for (const id of [e.source, e.target]) if (!appearance.has(id)) appearance.set(id, seq++);
  }

  interface Candidate {
    core: string[];
    tail: string[];
    size: number;
  }
  let best: Candidate | null = null;
  for (const group of groups) {
    const inGroup = new Set(group);
    const tailSet = new Set<string>();
    for (const e of synth) {
      if (inGroup.has(e.source) && !inGroup.has(e.target)) tailSet.add(e.target);
      else if (inGroup.has(e.target) && !inGroup.has(e.source)) tailSet.add(e.source);
    }
    const size = group.length + tailSet.size;
    if (size < AUTO_TRAIL_MIN_STEPS) continue;
    const cand: Candidate = {
      core: orderCards(group, ctx, appearance),
      tail: orderCards([...tailSet], ctx, appearance),
      size,
    };
    if (best === null || cand.size > best.size) best = cand;
  }
  if (best === null) return null;

  const tailKeep = Math.min(best.tail.length, Math.max(1, Math.floor(ctx.maxSteps / 4)));
  const tail = best.tail.slice(0, tailKeep);
  const core = best.core.slice(0, Math.max(0, ctx.maxSteps - tail.length));
  const ids = [...core, ...tail];
  if (ids.length < AUTO_TRAIL_MIN_STEPS) return null;

  const inTrail = new Set(ids);
  const tensions = refutes.filter((e) => inTrail.has(e.source) && inTrail.has(e.target));
  const resolutions = synth.filter((e) => inTrail.has(e.source) && inTrail.has(e.target));
  const cards = ids.map((id) => ctx.byId.get(id) as MemexNode);
  let text = `A dialectical sequence of ${ids.length} cards, from thesis to synthesis.`;
  if (tensions.length > 0) {
    const shown = tensions.slice(0, 3).map((e) => {
      const a = ctx.byId.get(e.source) as MemexNode;
      const b = ctx.byId.get(e.target) as MemexNode;
      return `${quoted(a)} and ${quoted(b)}`;
    });
    text += ` Recorded tensions (refutes links): ${joinList(shown)}.`;
  }
  if (resolutions.length > 0) {
    const shown = resolutions.slice(0, 2).map((e) => {
      const a = ctx.byId.get(e.source) as MemexNode;
      const b = ctx.byId.get(e.target) as MemexNode;
      return `${quoted(a)} and ${quoted(b)}`;
    });
    text += ` Recorded syntheses (synthesizes links): ${joinList(shown)}.`;
  }
  text += recurringSentence(cards);
  return makeTrail(ctx, "debate", DEBATE_TITLE, text, ids);
}

// ---------------------------------------------------------------------------
// 3. Dense Conceptual Nexus
// ---------------------------------------------------------------------------

function pairKey(a: string, b: string): string {
  return a <= b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

/**
 * The densest group of 3 to `maxSteps` cards by affinity. Affinity of a pair is
 * `GhostPairScore.base` from the ghost engine (keyword cosine, concept overlap
 * and tag overlap, without the cross-era boost). Growth is greedy: start from
 * the best-scoring pair (ties: smaller ids) that reaches `NEXUS_MIN_AFFINITY`,
 * then repeatedly add the card whose mean affinity to the cluster is highest,
 * considering only cards whose mean is at least `NEXUS_MIN_AFFINITY`. A card
 * linked to the cluster by an existing edge or discovery gets `NEXUS_LINK_BOOST`
 * in the ranking (never in the gate). Fewer than three cards: no trail.
 *
 * Order: chronological when every card is dated; otherwise an affinity chain
 * from the card with the highest total affinity inside the cluster, each next
 * card being the unvisited one closest in affinity to the previous.
 */
function conceptualNexus(ctx: Context): Trail | null {
  if (ctx.nodes.length < AUTO_TRAIL_MIN_STEPS) return null;
  const affinity = new Map<string, number>();
  let seed: { a: string; b: string; value: number } | null = null;
  for (const p of scoreGhostPairs(ctx.nodes)) {
    affinity.set(pairKey(p.sourceId, p.targetId), p.base);
    if (p.base >= NEXUS_MIN_AFFINITY && (seed === null || p.base > seed.value)) {
      seed = { a: p.sourceId, b: p.targetId, value: p.base };
    }
  }
  if (seed === null) return null;
  const aff = (a: string, b: string) => affinity.get(pairKey(a, b)) ?? 0;

  const cluster = [seed.a, seed.b];
  const member = new Set(cluster);
  while (cluster.length < ctx.maxSteps) {
    let best: { id: string; rank: number } | null = null;
    for (const node of ctx.nodes) {
      if (member.has(node.id)) continue;
      let sum = 0;
      for (const m of cluster) sum += aff(node.id, m);
      const mean = sum / cluster.length;
      if (mean < NEXUS_MIN_AFFINITY) continue;
      const linked = cluster.some((m) => ctx.neighbours.get(node.id)?.has(m) === true);
      const rank = mean + (linked ? NEXUS_LINK_BOOST : 0);
      // `ctx.nodes` is sorted by id, so a strict comparison keeps the smaller id on ties.
      if (best === null || rank > best.rank) best = { id: node.id, rank };
    }
    if (best === null) break;
    cluster.push(best.id);
    member.add(best.id);
  }
  if (cluster.length < AUTO_TRAIL_MIN_STEPS) return null;

  const cards = cluster.map((id) => ctx.byId.get(id) as MemexNode);
  let ids: string[];
  if (cards.every((c) => getEventSortKey(c.data) !== null)) {
    ids = orderCards(cluster, ctx, new Map());
  } else {
    const total = (id: string) => cluster.reduce((s, o) => (o === id ? s : s + aff(id, o)), 0);
    const rest = [...cluster].sort((a, b) => total(b) - total(a) || cmp(a, b));
    ids = [rest.shift() as string];
    while (rest.length > 0) {
      const last = ids[ids.length - 1];
      let bestAt = 0;
      for (let i = 1; i < rest.length; i++) {
        const better = aff(last, rest[i]) - aff(last, rest[bestAt]);
        if (better > 0 || (better === 0 && cmp(rest[i], rest[bestAt]) < 0)) bestAt = i;
      }
      ids.push(rest.splice(bestAt, 1)[0]);
    }
  }

  const ordered = ids.map((id) => ctx.byId.get(id) as MemexNode);
  let text = `A dense conceptual cluster of ${ordered.length} cards: ${joinList(ordered.map(withYear))}.`;
  text += recurringSentence(ordered);
  const tags = recurringTags(ordered);
  if (tags.length > 0) text += ` Shared tags: ${joinList(tags)}.`;
  return makeTrail(ctx, "nexus", NEXUS_TITLE, text, ids);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Up to three trails the data genuinely supports, in the order Lineage Arc,
 * Dialectical Debate, Dense Conceptual Nexus. Each has 3 to
 * `min(nodes.length, maxSteps)` distinct existing cards, origin `ghost`, a
 * description built only from its own cards and a deterministic id (see
 * `autoTrailId`). A later trail with the same ordered card sequence as an
 * earlier one is dropped. Returns `[]` when nothing qualifies. Does not mutate
 * its inputs.
 */
export function generateAutoTrails(
  nodes: readonly MemexNode[],
  edges: readonly AssociativeEdge[],
  discoveries: readonly GhostDiscovery[],
  options: AutoTrailOptions = {},
): Trail[] {
  const ctx = buildContext(nodes, edges, discoveries, options);
  if (ctx.nodes.length < AUTO_TRAIL_MIN_STEPS) return [];
  const out: Trail[] = [];
  const seen = new Set<string>();
  for (const build of [lineageArc, dialecticalDebate, conceptualNexus]) {
    const trail = build(ctx);
    if (trail === null) continue;
    const sequence = trail.nodeIds.join("\u0000");
    if (seen.has(sequence)) continue;
    seen.add(sequence);
    out.push(trail);
  }
  return out;
}

/** True when a trail with the same id or the same ordered card sequence already exists. */
export function isDuplicateTrail(candidate: Trail, existing: readonly Trail[]): boolean {
  const sequence = candidate.nodeIds.join("\u0000");
  return existing.some((t) => t.id === candidate.id || t.nodeIds.join("\u0000") === sequence);
}

export interface WeaveChoice {
  trail: Trail | null;
  /** Session cycle counter to store for the next call. */
  nextCursor: number;
}

/**
 * Which trail the weaving show plays.
 * 1. Trails added just now: the Lineage Arc when present, else the first.
 * 2. Nothing new: the existing auto trails (ids from `autoTrailId`, at least
 *    two cards) in id order, taking index `cursor` (wrapped), so repeated
 *    requests visit them in turn.
 * 3. No auto trail at all: `trail` is `null`.
 * `nextCursor` is the position after the trail that was chosen.
 */
export function chooseWeaveTrail(
  added: readonly Trail[],
  trails: readonly Trail[],
  cursor: number,
): WeaveChoice {
  const autos = trails
    .filter((t) => isAutoTrailId(t.id) && t.nodeIds.length >= 2)
    .sort((a, b) => cmp(a.id, b.id));
  const safeCursor = Number.isFinite(cursor) ? Math.max(0, Math.floor(cursor)) : 0;
  const pickedFromAdded =
    added.find((t) => autoTrailKind(t.id) === "lineage" && t.nodeIds.length >= 2) ??
    added.find((t) => t.nodeIds.length >= 2);
  if (pickedFromAdded !== undefined) {
    const at = autos.findIndex((t) => t.id === pickedFromAdded.id);
    return { trail: pickedFromAdded, nextCursor: at === -1 ? safeCursor : at + 1 };
  }
  if (autos.length === 0) return { trail: null, nextCursor: safeCursor };
  const at = safeCursor % autos.length;
  return { trail: autos[at], nextCursor: at + 1 };
}
