import { createTrail, getEventYear } from "./trail-engine";
import type {
  AssociativeEdge,
  GhostDiscovery,
  MemexNode,
  MemexNodeData,
  Trail,
} from "./types";

/**
 * Deterministic client-side semantic engine ("the Ghost"). Pure functions
 * only: no React, no clock, no randomness, no network. The same cards, edges
 * and options always produce the same discoveries in the same order.
 */

/** Minimum score for a pair of cards to become a discovery. */
export const DEFAULT_GHOST_THRESHOLD = 0.12;

/** Fixed timestamp used when the caller supplies none (keeps output deterministic). */
export const GHOST_EPOCH = "1945-07-01T00:00:00.000Z";

const COSINE_WEIGHT = 0.75;
const TAG_WEIGHT = 0.25;
/** Term-frequency weight of a term found in a title or a tag. */
const TITLE_TAG_TF = 3;

const STOP_WORDS: ReadonlySet<string> = new Set(
  (
    "a about above after again all also an and any are as at be because been before being below between " +
    "both but by can could did do does doing down during each few for from further had has have having he " +
    "her here hers him his how into its itself just may more most much must not now off once only other " +
    "our out over own same she should some such than that the their them then there these they this those " +
    "through too under until up very was were what when where which while who whom why will with would you " +
    "your one two three about around among upon within without whose via per yet still even ever many " +
    "every made make makes used use uses using new first last early late"
  ).split(" "),
);

/** Sparse term-weight vector. */
export type TermVector = ReadonlyMap<string, number>;

function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(?:ss|x|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("us")) {
    return word.slice(0, -1);
  }
  return word;
}

/**
 * Lowercase keywords of `text`: alphanumeric tokens of 3+ characters that are
 * not purely numeric and not stop words, with plurals folded. Returned sorted
 * and unique.
 */
export function extractKeywords(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || /^\d+$/.test(raw) || STOP_WORDS.has(raw)) continue;
    const word = stem(raw);
    if (word.length >= 3 && !STOP_WORDS.has(word)) out.add(word);
  }
  return [...out].sort();
}

/** Weighted term frequencies for one card: title and tags count 3x content. */
function termFrequencies(data: MemexNodeData): Map<string, number> {
  const tf = new Map<string, number>();
  const add = (text: string, weight: number) => {
    for (const term of extractKeywords(text)) tf.set(term, (tf.get(term) ?? 0) + weight);
  };
  add(data.title, TITLE_TAG_TF);
  add(data.tags.join(" "), TITLE_TAG_TF);
  add(data.content, 1);
  return tf;
}

function normalizedTags(data: MemexNodeData): Set<string> {
  return new Set(data.tags.map((t) => t.trim().toLowerCase()).filter((t) => t !== ""));
}

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}

/**
 * Cosine similarity of two sparse vectors, always within `[0, 1]`. Zero when
 * either vector is empty (or has no positive weight). Negative or non-finite
 * weights are treated as 0.
 */
export function computeCosineSimilarity(a: TermVector, b: TermVector): number {
  const weight = (w: number) => (Number.isFinite(w) && w > 0 ? w : 0);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [term, wa] of a) {
    const x = weight(wa);
    normA += x * x;
    const y = weight(b.get(term) ?? 0);
    dot += x * y;
  }
  for (const wb of b.values()) {
    const y = weight(wb);
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return clamp01(dot / (Math.sqrt(normA) * Math.sqrt(normB)));
}

/** Jaccard index of two sets; 0 when both are empty. */
function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared / (a.size + b.size - shared);
}

/** Order-independent key for a pair of card IDs. */
export function ghostPairKey(idA: string, idB: string): string {
  const [lo, hi] = idA <= idB ? [idA, idB] : [idB, idA];
  return `${lo.length}:${lo}:${hi}`;
}

/** Stable discovery ID derived from the sorted pair of card IDs. */
export function ghostDiscoveryId(idA: string, idB: string): string {
  return `gd-${ghostPairKey(idA, idB)}`;
}

/** Display id of the derived canvas edge that renders a discovery. */
export function ghostSynapseEdgeId(discoveryId: string): string {
  return `ghost-synapse-${discoveryId}`;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Names the shared concepts of two cards, plus a temporal note when both are
 * dated. Deterministic: shared terms are ranked by combined weight, then
 * alphabetically, and symmetric in its two arguments.
 */
export function synthesizeBridgeRationale(nodeA: MemexNode, nodeB: MemexNode): string {
  const [a, b] = cmp(nodeA.id, nodeB.id) <= 0 ? [nodeA, nodeB] : [nodeB, nodeA];
  const tfA = termFrequencies(a.data);
  const tfB = termFrequencies(b.data);
  const shared = [...tfA.keys()]
    .filter((t) => tfB.has(t))
    .map((t) => ({ term: t, weight: (tfA.get(t) ?? 0) + (tfB.get(t) ?? 0) }))
    .sort((x, y) => y.weight - x.weight || cmp(x.term, y.term))
    .slice(0, 4)
    .map((x) => x.term);

  const titleA = a.data.title.trim() || a.data.archivalId;
  const titleB = b.data.title.trim() || b.data.archivalId;
  const parts: string[] = [];
  if (shared.length > 0) {
    parts.push(
      `"${titleA}" and "${titleB}" were never linked, yet both circle ${joinList(shared)}.`,
    );
  } else {
    parts.push(`"${titleA}" and "${titleB}" were never linked but read as related.`);
  }

  const sharedTags = [...normalizedTags(a.data)].filter((t) => normalizedTags(b.data).has(t)).sort();
  if (sharedTags.length > 0) parts.push(`They share the tag ${joinList(sharedTags)}.`);

  const yearA = getEventYear(a.data);
  const yearB = getEventYear(b.data);
  if (yearA !== null && yearB !== null) {
    const gap = Math.abs(yearA - yearB);
    parts.push(
      gap === 0
        ? `Both date from ${yearA}.`
        : `${gap} ${gap === 1 ? "year" : "years"} separate them (${Math.min(yearA, yearB)} to ${Math.max(yearA, yearB)}).`,
    );
  }
  if (a.data.cardType !== b.data.cardType) {
    parts.push(`${withArticle(a.data.cardType, true)} meets ${withArticle(b.data.cardType, false)}.`);
  }
  return parts.join(" ");
}

function withArticle(word: string, capital: boolean): string {
  const article = /^[aeiou]/.test(word) ? "an" : "a";
  return capital ? `${article[0].toUpperCase()}${article.slice(1)} ${word}` : `${article} ${word}`;
}

function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export interface DetectGhostOptions {
  /** Discovery IDs (see `ghostDiscoveryId`) the user dismissed; never suggested again. */
  dismissed?: Iterable<string>;
  /** Timestamp stamped on every discovery (default `GHOST_EPOCH`). */
  discoveredAt?: string;
}

/**
 * Scans every unordered pair of cards and returns one discovery for each pair
 * that (a) is not joined by any existing edge in either direction, (b) was not
 * dismissed and (c) scores at least `threshold`.
 *
 * Score = `0.75 * cosine(TF-IDF) + 0.25 * jaccard(tags)`, clamped to `[0, 1]`.
 * Output is sorted by confidence (desc) then ID (asc); the result does not
 * depend on the order of `nodes` or `existingEdges`. Inputs are not mutated.
 */
export function detectGhostSynapses(
  nodes: readonly MemexNode[],
  existingEdges: readonly Pick<AssociativeEdge, "source" | "target">[],
  threshold: number = DEFAULT_GHOST_THRESHOLD,
  options: DetectGhostOptions = {},
): GhostDiscovery[] {
  const discoveredAt = options.discoveredAt ?? GHOST_EPOCH;
  const dismissed = new Set(options.dismissed ?? []);
  const connected = new Set(existingEdges.map((e) => ghostPairKey(e.source, e.target)));

  // Sort by id (first occurrence wins for duplicate ids) so output is order-independent.
  const seen = new Set<string>();
  const sorted = [...nodes]
    .sort((x, y) => cmp(x.id, y.id))
    .filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true)));
  const n = sorted.length;
  if (n < 2) return [];

  const tfs = sorted.map((node) => termFrequencies(node.data));
  const df = new Map<string, number>();
  for (const tf of tfs) for (const term of tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  const vectors: TermVector[] = tfs.map(
    (tf) =>
      new Map([...tf].map(([term, f]) => [term, f * Math.log(1 + n / (df.get(term) ?? 1))])),
  );
  const tags = sorted.map((node) => normalizedTags(node.data));

  const found: GhostDiscovery[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = sorted[i];
      const b = sorted[j];
      const id = ghostDiscoveryId(a.id, b.id);
      if (connected.has(ghostPairKey(a.id, b.id)) || dismissed.has(id)) continue;
      const score = clamp01(
        COSINE_WEIGHT * Math.sqrt(computeCosineSimilarity(vectors[i], vectors[j])) +
          TAG_WEIGHT * jaccard(tags[i], tags[j]),
      );
      if (score <= 0 || score < threshold) continue;
      found.push({
        id,
        sourceId: a.id,
        targetId: b.id,
        rationale: synthesizeBridgeRationale(a, b),
        confidence: clamp01(Math.round(score * 1000) / 1000),
        discoveredAt,
      });
    }
  }
  return found.sort((x, y) => y.confidence - x.confidence || cmp(x.id, y.id));
}

/**
 * Drops every discovery that references a deleted card. Returns the same
 * array reference when nothing is removed; keeps the order of the rest.
 */
export function removeNodeFromDiscoveries(
  discoveries: readonly GhostDiscovery[],
  deletedIds: Iterable<string>,
): GhostDiscovery[] {
  const doomed = new Set(deletedIds);
  if (doomed.size === 0) return discoveries as GhostDiscovery[];
  const kept = discoveries.filter((d) => !doomed.has(d.sourceId) && !doomed.has(d.targetId));
  return kept.length === discoveries.length ? (discoveries as GhostDiscovery[]) : kept;
}

/**
 * Canvas edges that render discoveries as ghost synapses. Display-only: they
 * are derived from discoveries and never stored in `MemexGraphState.edges`.
 */
export function buildGhostEdges(discoveries: readonly GhostDiscovery[]): AssociativeEdge[] {
  return discoveries.map((d) => ({
    id: ghostSynapseEdgeId(d.id),
    source: d.sourceId,
    target: d.targetId,
    type: "associative" as const,
    selectable: false,
    focusable: false,
    deletable: false,
    data: {
      origin: "ghost" as const,
      rationale: d.rationale,
      strength: d.confidence,
      discoveryId: d.id,
    },
  }));
}

/** Percentage label of a confidence, e.g. `0.724` becomes `72`. */
export function confidencePercent(confidence: number): number {
  return Math.round(clamp01(confidence) * 100);
}

/**
 * Builds the ghost-origin trail for a discovery: source card, then target
 * card. The ID derives from the discovery so repeating the walk reuses it.
 */
export function forgeGhostTrail(
  discovery: GhostDiscovery,
  nodes: readonly MemexNode[],
  createdAt: string = GHOST_EPOCH,
): Trail {
  const title = (id: string) => nodes.find((n) => n.id === id)?.data.title.trim() || id;
  return createTrail(
    `t-ghost-${discovery.id}`,
    `Ghost Trail: ${title(discovery.sourceId)} → ${title(discovery.targetId)}`,
    discovery.rationale,
    [discovery.sourceId, discovery.targetId],
    "ghost",
    createdAt,
  );
}
