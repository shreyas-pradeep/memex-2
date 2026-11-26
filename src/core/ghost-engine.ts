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

/**
 * Minimum raw score for a pair of cards to become a discovery. The score
 * blends keyword, concept and tag overlap (see `detectGhostSynapses`); at 0.3
 * the 8-card demo seed yields exactly three bridges between unconnected cards.
 */
export const DEFAULT_GHOST_THRESHOLD = 0.3;

/** Default cap on discoveries returned by one scan, so the canvas is never flooded. */
export const DEFAULT_GHOST_MAX_RESULTS = 3;

/** Calibrated confidence range of locally discovered synapses. */
export const GHOST_CONFIDENCE_MIN = 0.78;
export const GHOST_CONFIDENCE_MAX = 0.96;
/** Raw score at (and above) which calibrated confidence reaches its maximum. */
const SCORE_FOR_MAX_CONFIDENCE = 0.6;

/** Fixed timestamp used when the caller supplies none (keeps output deterministic). */
export const GHOST_EPOCH = "1945-07-01T00:00:00.000Z";

const COSINE_WEIGHT = 0.3;
const CONCEPT_WEIGHT = 0.5;
const TAG_WEIGHT = 0.2;
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

/**
 * Small deterministic stemmer: folds plurals, then strips one `-ing`, `-ed` or
 * `-ly` suffix from longer words ("linking", "linked" and "links" all become "link").
 */
function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(?:ss|x|ch|sh)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) {
    w = w.slice(0, -1);
  }
  if (w.length > 6 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 5 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 5 && w.endsWith("ly")) w = w.slice(0, -2);
  return w;
}

/**
 * Curated concept lexicon: each concept groups related terms, so cards that
 * use different words for the same idea still meet ("hypertext" and "trail"
 * and "memex" all point at associative linking). Terms are stemmed at load.
 */
export const CONCEPT_LEXICON: Readonly<Record<string, { label: string; terms: readonly string[] }>> = {
  association: {
    label: "associative linking",
    terms: [
      "hypertext", "hyperlink", "association", "associative", "associate", "link", "trail",
      "memex", "network", "nonlinear", "web", "connection", "connect", "path", "mind",
    ],
  },
  machines: {
    label: "computing machines",
    terms: [
      "analog", "differential", "analyzer", "mechanical", "mechanized", "computing", "computer",
      "computation", "vacuum", "tube", "eniac", "digital", "electronic", "integrator", "calculator",
      "programmable", "programmed", "machine", "gear", "shaft", "stored",
    ],
  },
  augmentation: {
    label: "human augmentation and interfaces",
    terms: [
      "engelbart", "demo", "demonstration", "mouse", "augment", "augmentation", "collaboration",
      "interactive", "interface", "screen", "legacy", "pioneer", "nls", "user",
    ],
  },
  knowledge: {
    label: "organizing knowledge",
    terms: [
      "knowledge", "information", "organize", "organizing", "essay", "think", "thinking",
      "synthesis", "hierarchy", "folder", "mass", "index", "atlantic", "scholar", "idea",
    ],
  },
  memory: {
    label: "memory and storage",
    terms: [
      "memory", "memex", "microfilm", "store", "storage", "record", "archive", "book", "desk",
      "supplement", "device", "stored", "retrieval",
    ],
  },
  wartime: {
    label: "wartime science",
    terms: [
      "war", "wwii", "wartime", "radar", "fuze", "manhattan", "navy", "military", "weapon",
      "osrd", "scientist", "scientific", "science", "policy",
    ],
  },
  institutions: {
    label: "research institutions",
    terms: [
      "mit", "university", "upenn", "pennsylvania", "laboratory", "institute", "research",
      "foundation", "engineer", "engineering", "colleague",
    ],
  },
};

/** term (stemmed) -> concept ids, built once from `CONCEPT_LEXICON`. */
const TERM_CONCEPTS: ReadonlyMap<string, readonly string[]> = (() => {
  const map = new Map<string, string[]>();
  for (const id of Object.keys(CONCEPT_LEXICON).sort()) {
    for (const raw of CONCEPT_LEXICON[id].terms) {
      const term = stem(raw);
      const list = map.get(term) ?? [];
      if (!list.includes(id)) list.push(id);
      map.set(term, list);
    }
  }
  return map;
})();

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

/** Concept ids touched by a card's terms. */
function conceptsOf(terms: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const term of terms) for (const c of TERM_CONCEPTS.get(term) ?? []) out.add(c);
  return out;
}

/** Ochiai coefficient `|A ∩ B| / sqrt(|A| |B|)`; 0 when either set is empty. */
function ochiai(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared / Math.sqrt(a.size * b.size);
}

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}

/**
 * Maps a raw pair score to the confidence shown for a local discovery:
 * linear from 0.78 (score 0) to 0.96 (score >= 0.6), rounded to 3 decimals.
 * Monotone non-decreasing in `score` and always within `[0.78, 0.96]`.
 */
export function calibrateGhostConfidence(score: number): number {
  const t = clamp01(score / SCORE_FOR_MAX_CONFIDENCE);
  const c = GHOST_CONFIDENCE_MIN + (GHOST_CONFIDENCE_MAX - GHOST_CONFIDENCE_MIN) * t;
  return Math.round(c * 1000) / 1000;
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
 * Explains a bridge: names the shared concepts and keywords, the shared tags
 * and the temporal gap between the two cards. Deterministic and symmetric in
 * its two arguments.
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
  const conceptsB = conceptsOf(tfB.keys());
  const sharedConcepts = [...conceptsOf(tfA.keys())]
    .filter((c) => conceptsB.has(c))
    .sort()
    .slice(0, 3)
    .map((c) => CONCEPT_LEXICON[c].label);

  const titleA = a.data.title.trim() || a.data.archivalId;
  const titleB = b.data.title.trim() || b.data.archivalId;
  const parts: string[] = [];
  if (sharedConcepts.length > 0) {
    parts.push(
      `"${titleA}" and "${titleB}" were never linked, yet both draw on ${joinList(sharedConcepts)}.`,
    );
    if (shared.length > 0) parts.push(`Shared terms: ${joinList(shared)}.`);
  } else if (shared.length > 0) {
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
    const lo = Math.min(yearA, yearB);
    const hi = Math.max(yearA, yearB);
    const gap = hi - lo;
    if (gap === 0) parts.push(`Temporal link: both date from ${lo}.`);
    else if (gap <= 10) {
      parts.push(`Temporal link: ${gap} ${gap === 1 ? "year" : "years"} apart (${lo} to ${hi}), the same era of work.`);
    } else {
      parts.push(`Temporal link: the idea travels ${gap} years, from ${lo} to ${hi}.`);
    }
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
  /** Keep only the top N discoveries (default `DEFAULT_GHOST_MAX_RESULTS`). */
  maxResults?: number;
}

/**
 * Scans every unordered pair of cards and returns one discovery for each pair
 * that (a) is not joined by any existing edge in either direction, (b) was not
 * dismissed and (c) scores at least `threshold`.
 *
 * Raw score = `0.3 * sqrt(cosine(TF-IDF of stemmed keywords))
 * + 0.5 * ochiai(concept sets from CONCEPT_LEXICON) + 0.2 * jaccard(tags)`,
 * clamped to `[0, 1]`. Confidence is the calibrated score
 * (`calibrateGhostConfidence`, within `[0.78, 0.96]`). Output is sorted by
 * score (desc) then ID (asc) and capped at `maxResults`; the result does not
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
  const concepts = tfs.map((tf) => conceptsOf(tf.keys()));

  const found: { discovery: GhostDiscovery; score: number }[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = sorted[i];
      const b = sorted[j];
      const id = ghostDiscoveryId(a.id, b.id);
      if (connected.has(ghostPairKey(a.id, b.id)) || dismissed.has(id)) continue;
      const score = clamp01(
        COSINE_WEIGHT * Math.sqrt(computeCosineSimilarity(vectors[i], vectors[j])) +
          CONCEPT_WEIGHT * ochiai(concepts[i], concepts[j]) +
          TAG_WEIGHT * jaccard(tags[i], tags[j]),
      );
      if (score <= 0 || score < threshold) continue;
      found.push({
        score,
        discovery: {
          id,
          sourceId: a.id,
          targetId: b.id,
          rationale: synthesizeBridgeRationale(a, b),
          confidence: calibrateGhostConfidence(score),
          discoveredAt,
        },
      });
    }
  }
  const limit = Math.max(0, Math.floor(options.maxResults ?? DEFAULT_GHOST_MAX_RESULTS));
  return found
    .sort((x, y) => y.score - x.score || cmp(x.discovery.id, y.discovery.id))
    .slice(0, limit)
    .map((f) => f.discovery);
}

/** Longest rationale kept from a live (LLM) suggestion. */
export const MAX_RATIONALE_CHARS = 400;
/** Longest bridge theme kept from a live (LLM) suggestion. */
export const MAX_THEME_CHARS = 60;
/** Confidence used when a live suggestion carries none that is usable. */
const DEFAULT_LIVE_CONFIDENCE = 0.8;
/** Most live discoveries kept from one response. */
export const MAX_LIVE_DISCOVERIES = 4;

/** Untrusted suggestion shape returned by the live model. */
export interface RawGhostSuggestion {
  sourceId?: unknown;
  targetId?: unknown;
  rationale?: unknown;
  confidence?: unknown;
  bridgeTheme?: unknown;
}

export interface SanitizeGhostOptions {
  dismissed?: Iterable<string>;
  discoveredAt?: string;
  maxResults?: number;
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  // Collapse control characters and whitespace runs; keeps rationales single-paragraph.
  let text = "";
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    text += code < 32 || code === 127 ? " " : ch;
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Turns untrusted model output into `GhostDiscovery` objects. Drops entries
 * that are not objects, reference unknown cards, link a card to itself,
 * repeat an unordered pair, join cards that already share an edge (any
 * direction), were dismissed, or carry no rationale. Confidence is clamped to
 * `[0, 1]` (missing or non-numeric becomes 0.8), the theme is prefixed to the
 * rationale, and lengths are trimmed. Source is the lexicographically smaller
 * card ID, matching local discoveries. Sorted by confidence desc then ID asc,
 * and capped. Pure and deterministic.
 */
export function sanitizeGhostSuggestions(
  raw: unknown,
  nodes: readonly Pick<MemexNode, "id">[],
  existingEdges: readonly Pick<AssociativeEdge, "source" | "target">[],
  options: SanitizeGhostOptions = {},
): GhostDiscovery[] {
  if (!Array.isArray(raw)) return [];
  const known = new Set(nodes.map((n) => n.id));
  const connected = new Set(existingEdges.map((e) => ghostPairKey(e.source, e.target)));
  const dismissed = new Set(options.dismissed ?? []);
  const discoveredAt = options.discoveredAt ?? GHOST_EPOCH;
  const limit = Math.max(0, Math.floor(options.maxResults ?? MAX_LIVE_DISCOVERIES));
  const out = new Map<string, GhostDiscovery>();
  for (const item of raw as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as RawGhostSuggestion;
    if (typeof r.sourceId !== "string" || typeof r.targetId !== "string") continue;
    if (r.sourceId === r.targetId || !known.has(r.sourceId) || !known.has(r.targetId)) continue;
    const key = ghostPairKey(r.sourceId, r.targetId);
    const id = ghostDiscoveryId(r.sourceId, r.targetId);
    if (connected.has(key) || dismissed.has(id) || out.has(id)) continue;
    const theme = cleanText(r.bridgeTheme, MAX_THEME_CHARS);
    const reason = cleanText(r.rationale, MAX_RATIONALE_CHARS);
    if (reason === "") continue;
    const rationale = cleanText(theme === "" ? reason : `${theme}: ${reason}`, MAX_RATIONALE_CHARS);
    const confidence =
      typeof r.confidence === "number" && Number.isFinite(r.confidence)
        ? clamp01(r.confidence)
        : DEFAULT_LIVE_CONFIDENCE;
    const [lo, hi] = cmp(r.sourceId, r.targetId) <= 0 ? [r.sourceId, r.targetId] : [r.targetId, r.sourceId];
    out.set(id, {
      id,
      sourceId: lo,
      targetId: hi,
      rationale,
      confidence: Math.round(confidence * 1000) / 1000,
      discoveredAt,
    });
  }
  return [...out.values()]
    .sort((x, y) => y.confidence - x.confidence || cmp(x.id, y.id))
    .slice(0, limit);
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
