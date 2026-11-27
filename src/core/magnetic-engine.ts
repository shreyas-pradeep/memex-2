import { nodeRect, rectGap, type Rect } from "./card-geometry";
import {
  CONCEPT_LEXICON,
  buildAffinityContext,
  extractKeywords,
  ghostPairKey,
  normalizedTags,
  pairAffinity,
  synthesizeBridgeRationale,
} from "./ghost-engine";
import type { AssociativeEdge, MemexNode } from "./types";

/**
 * Magnetic associative snapping (Spec 09). While a card is dragged, an
 * unconnected card the Ghost engine considers related pulls it in; dropping
 * inside the pull connects them.
 *
 * Two phases keep the drag at 60 fps:
 * 1. `buildMagneticCandidates` runs ONCE at drag start. It scores the dragged
 *    card against every other card (TF-IDF, concepts, tags) and keeps the
 *    unconnected pairs with a calibrated affinity of at least
 *    `MAGNETIC_MIN_AFFINITY`.
 * 2. `findMagneticTarget` runs per frame and only measures the rectangle gap to
 *    each candidate: O(candidates), no text analysis.
 *
 * Pure: no React, no store, no clock, no randomness.
 */

/** A target pulls when the gap between the two card rectangles is below this (px). */
export const MAGNETIC_RANGE_PX = 260;

/**
 * Minimum calibrated affinity (the X% shown on synapse pills). Calibrated
 * confidence is 0 below the detection threshold and within [0.78, 0.96] above
 * it, so in practice every pair the Ghost engine would discover qualifies and
 * nothing below the threshold ever snaps.
 */
export const MAGNETIC_MIN_AFFINITY = 0.7;

/** What the dragged card would connect to if dropped now. `sourceId` is the dragged card. */
export interface MagneticTarget {
  sourceId: string;
  targetId: string;
  /** Calibrated affinity in `[0.78, 0.96]` (see `MAGNETIC_MIN_AFFINITY`). */
  affinity: number;
  /** Human-readable theme the two cards share, e.g. "associative linking". */
  concept: string;
  /** Synthesized bridge rationale, stored on the edge when the snap happens. */
  rationale: string;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Best label for what two cards share: a concept, else a tag, else a keyword. */
function sharedTheme(a: MemexNode, b: MemexNode, conceptIds: readonly string[]): string {
  if (conceptIds.length > 0) return CONCEPT_LEXICON[conceptIds[0]].label;
  const tagsB = normalizedTags(b.data);
  const tag = [...normalizedTags(a.data)].filter((t) => tagsB.has(t)).sort()[0];
  if (tag !== undefined) return tag;
  const wordsB = new Set(extractKeywords(`${b.data.title} ${b.data.content}`));
  const word = extractKeywords(`${a.data.title} ${a.data.content}`).find((w) => wordsB.has(w));
  return word ?? "related ideas";
}

/**
 * Candidates for dragging `draggedId`: every other card that is not connected
 * to it (real edges, either direction) and whose calibrated affinity with it
 * is at least `MAGNETIC_MIN_AFFINITY`. Sorted by affinity (desc) then id. Empty
 * when the dragged card does not exist. A pair that is only a pending ghost
 * discovery still qualifies (the snap then consumes the discovery).
 */
export function buildMagneticCandidates(
  draggedId: string,
  nodes: readonly MemexNode[],
  edges: readonly Pick<AssociativeEdge, "source" | "target">[],
): MagneticTarget[] {
  const dragged = nodes.find((n) => n.id === draggedId);
  if (dragged === undefined) return [];
  const connected = new Set(edges.map((e) => ghostPairKey(e.source, e.target)));
  const ctx = buildAffinityContext(nodes);
  const seen = new Set<string>();
  const out: MagneticTarget[] = [];
  for (const other of nodes) {
    if (other.id === draggedId || seen.has(other.id)) continue;
    seen.add(other.id);
    if (connected.has(ghostPairKey(draggedId, other.id))) continue;
    const { affinity, sharedConcepts } = pairAffinity(dragged, other, ctx);
    if (affinity < MAGNETIC_MIN_AFFINITY) continue;
    out.push({
      sourceId: draggedId,
      targetId: other.id,
      affinity,
      concept: sharedTheme(dragged, other, sharedConcepts),
      rationale: synthesizeBridgeRationale(dragged, other),
    });
  }
  return out.sort((x, y) => y.affinity - x.affinity || cmp(x.targetId, y.targetId));
}

/** Lookup of card rectangles by id; either a list (one-shot use) or a prebuilt map (per frame). */
export type MagneticNodeLookup = readonly MemexNode[] | ReadonlyMap<string, MemexNode>;

function lookupOf(nodes: MagneticNodeLookup): ReadonlyMap<string, MemexNode> {
  return nodes instanceof Map ? nodes : new Map((nodes as readonly MemexNode[]).map((n) => [n.id, n]));
}

/**
 * The candidate the dragged rectangle is nearest to, if any is closer than
 * `range` (strictly, measured as the rectangle gap). Ties go to the higher
 * affinity, then the smaller id. Per-frame cost is O(candidates): one gap
 * check each. Candidates whose card is missing or has an invalid position are
 * skipped. `null` when nothing is in range.
 */
export function findMagneticTarget(
  dragged: Rect,
  candidates: readonly MagneticTarget[],
  nodes: MagneticNodeLookup,
  range: number = MAGNETIC_RANGE_PX,
): MagneticTarget | null {
  const byId = lookupOf(nodes);
  let best: MagneticTarget | null = null;
  let bestGap = Infinity;
  for (const candidate of candidates) {
    const node = byId.get(candidate.targetId);
    const rect = node === undefined ? null : nodeRect(node);
    if (rect === null) continue;
    const gap = rectGap(dragged, rect);
    if (!(gap < range)) continue;
    if (
      best === null ||
      gap < bestGap ||
      (gap === bestGap &&
        (candidate.affinity > best.affinity ||
          (candidate.affinity === best.affinity && cmp(candidate.targetId, best.targetId) < 0)))
    ) {
      best = candidate;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * One-shot composition of both phases, for tests and non-drag callers: the
 * target `draggedId` would snap to at its current position, or `null`.
 */
export function computeMagneticTarget(
  draggedId: string,
  nodes: readonly MemexNode[],
  edges: readonly Pick<AssociativeEdge, "source" | "target">[],
  range: number = MAGNETIC_RANGE_PX,
): MagneticTarget | null {
  const dragged = nodes.find((n) => n.id === draggedId);
  const rect = dragged === undefined ? null : nodeRect(dragged);
  if (rect === null) return null;
  return findMagneticTarget(rect, buildMagneticCandidates(draggedId, nodes, edges), nodes, range);
}

/** True when two targets are the same offer (so the store skips a redundant update). */
export function sameMagneticTarget(a: MagneticTarget | null, b: MagneticTarget | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.sourceId === b.sourceId &&
    a.targetId === b.targetId &&
    a.affinity === b.affinity &&
    a.concept === b.concept &&
    a.rationale === b.rationale
  );
}
