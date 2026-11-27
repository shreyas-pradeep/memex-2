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
 * blends keyword, concept and tag overlap plus the cross-era lineage boost
 * (see `detectGhostSynapses`). At 0.3 the 7-card demo seed yields five bridges
 * between unconnected cards, all spanning 1945-1968 to 2024-2026. The value
 * is deliberately not raised to 0.5: this score scale tops out near 0.65, so
 * 0.5 would keep only the two strongest pairs.
 */
export const DEFAULT_GHOST_THRESHOLD = 0.3;

/** Default cap on discoveries returned by one scan, so the canvas is never flooded. */
export const DEFAULT_GHOST_MAX_RESULTS = 6;

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

export const STOP_WORDS: ReadonlySet<string> = new Set(
  (
    "a about above after again all also an and any are as at be because been before being below between " +
    "both but by can could did do does doing down during each few for from further had has have having he " +
    "her here hers him his how into its itself just may more most much must not now off once only other " +
    "our out over own same she should some such than that the their them then there these they this those " +
    "through too under until up very was were what when where which while who whom why will with would you " +
    "your one two three about around among upon within without whose via per yet still even ever many " +
    "every made make makes used use uses using new first last early late source"
  ).split(" "),
);

/** Sparse term-weight vector. */
export type TermVector = ReadonlyMap<string, number>;

/**
 * Small deterministic stemmer: folds plurals, then strips one `-ing`, `-ed` or
 * `-ly` suffix from longer words ("linking", "linked" and "links" all become "link").
 */
export function stem(word: string): string {
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
export interface ConceptDefinition {
  /** Human-readable theme name used in rationales. */
  label: string;
  /**
   * Distinctive terms. One distinct match is enough for a card to touch the
   * concept. Hyphenated terms ("dot-product") match both the hyphenated and the
   * split form ("dot product") as well as the joined form ("dotproduct").
   */
  terms: readonly string[];
  /**
   * Over-generic terms ("values", "nodes", "features"). Each counts for half a
   * match, so a card needs two distinct generic terms (or one distinctive
   * term) before it touches the concept: one stray word never creates a bridge.
   */
  weakTerms?: readonly string[];
}

export const CONCEPT_LEXICON: Readonly<Record<string, ConceptDefinition>> = {
  association: {
    label: "associative linking",
    terms: [
      "hypertext", "hyperlink", "association", "associative", "associate", "trail",
      "memex", "network", "nonlinear", "web", "connection", "connect", "path", "mind",
    ],
    weakTerms: ["link"],
  },
  machines: {
    label: "computing machines",
    terms: [
      "analog", "differential", "analyzer", "mechanical", "mechanized", "computing", "computer",
      "computation", "vacuum", "tube", "eniac", "digital", "electronic", "integrator", "calculator",
      "programmable", "programmed", "machine", "gear", "shaft",
    ],
    weakTerms: ["stored"],
  },
  // COGNITIVE_AUGMENTATION: extends the original augmentation concept.
  augmentation: {
    label: "cognitive augmentation",
    terms: [
      "engelbart", "demo", "demonstration", "augment", "augmentation", "collaboration",
      "interactive", "interface", "screen", "legacy", "pioneer", "nls", "user",
      "working-memory", "spatial-gestalt", "hci", "keyset", "intellect",
    ],
    weakTerms: ["mouse", "bandwidth"],
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
      "supplement", "device", "retrieval",
    ],
    weakTerms: ["stored"],
  },
  // RETRIEVAL_ATTENTION: extends the original retrieval concept.
  retrieval: {
    label: "attention and retrieval",
    terms: [
      "attention", "query", "retrieval", "retrieve", "rag", "search", "lookup",
      "transformer", "selection", "select", "benchmark", "memex", "dot-product",
    ],
    weakTerms: ["key", "value", "index", "scaled", "associative", "trail"],
  },
  // LATENT_GEOMETRY: extends the original latent concept.
  latent: {
    label: "latent geometry",
    terms: [
      "latent", "representation", "embedding", "autoencoder", "interpretability",
      "interpretable", "superposition", "superposed", "neuron", "parametric", "geometry",
      "monosemanticity", "latent-space", "sparse-autoencoders", "manifold",
    ],
    weakTerms: ["feature", "model"],
  },
  // GRAPH_HYPERTEXT: new concept; hypertext/link terms alias into `association`
  // and graph/community terms alias into `graph`, but only this concept joins
  // hypertext cards to graph-retrieval cards.
  hypergraph: {
    label: "hypertext and knowledge graphs",
    terms: ["hypertext", "xanadu", "graphrag", "knowledge-graph", "non-linear"],
    weakTerms: ["link", "node", "community", "hierarchical"],
  },
  // Split from the former "graphs and spatial structure" concept: a spatial
  // canvas is not a knowledge graph, and merging them let an HCI card bridge to
  // GraphRAG on the word "spatial" alone.
  graph: {
    label: "graphs and structure",
    terms: ["graph", "entity", "cluster", "structure"],
    weakTerms: ["community"],
  },
  spatial: {
    label: "spatial layout",
    terms: ["spatial", "canvas", "landmark", "layout", "gestalt", "zoomable", "map"],
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

const STRONG_TERM_WEIGHT = 1;
const WEAK_TERM_WEIGHT = 0.5;
/** Summed weight of distinct matched terms a card needs to touch a concept. */
const CONCEPT_TOUCH_WEIGHT = 1;
/** Longest phrase (in words) a lexicon term may have. */
const MAX_PHRASE_WORDS = 3;

interface TermEntry {
  concept: string;
  /** Raw lexicon term, so one term counts once however many forms matched. */
  termId: string;
  weight: number;
}

/** Splits `text` into lowercase alphanumeric tokens, each stemmed (stop words kept, for adjacency). */
function stemmedTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t !== "")
    .map(stem);
}

/**
 * Compiled lexicon, built once. Single-word terms go to `unigrams`
 * (stemmed word -> entries). Multi-word terms ("dot-product") register their
 * space-joined stems in `phrases` ("dot product") and their concatenation in
 * `unigrams` ("dotproduct"), so hyphenated, split and glued spellings all match.
 */
const COMPILED_LEXICON: {
  unigrams: ReadonlyMap<string, readonly TermEntry[]>;
  phrases: ReadonlyMap<string, readonly TermEntry[]>;
} = (() => {
  const unigrams = new Map<string, TermEntry[]>();
  const phrases = new Map<string, TermEntry[]>();
  const register = (map: Map<string, TermEntry[]>, key: string, entry: TermEntry) => {
    const list = map.get(key) ?? [];
    const at = list.findIndex((e) => e.concept === entry.concept && e.termId === entry.termId);
    if (at === -1) list.push(entry);
    else if (list[at].weight < entry.weight) list[at] = entry;
    map.set(key, list);
  };
  for (const concept of Object.keys(CONCEPT_LEXICON).sort()) {
    const def = CONCEPT_LEXICON[concept];
    const groups: [readonly string[], number][] = [
      [def.terms, STRONG_TERM_WEIGHT],
      [def.weakTerms ?? [], WEAK_TERM_WEIGHT],
    ];
    for (const [terms, weight] of groups) {
      for (const raw of terms) {
        const parts = stemmedTokens(raw);
        if (parts.length === 0 || parts.length > MAX_PHRASE_WORDS) continue;
        const entry: TermEntry = { concept, termId: raw, weight };
        if (parts.length === 1) register(unigrams, parts[0], entry);
        else {
          register(phrases, parts.join(" "), entry);
          register(unigrams, parts.join(""), entry);
        }
      }
    }
  }
  return { unigrams, phrases };
})();

/** Adjacent-word windows (2 to `MAX_PHRASE_WORDS` words) of a token list, space-joined. */
function phraseWindows(tokens: readonly string[]): string[] {
  const out: string[] = [];
  for (let n = 2; n <= MAX_PHRASE_WORDS; n++) {
    for (let i = 0; i + n <= tokens.length; i++) out.push(tokens.slice(i, i + n).join(" "));
  }
  return out;
}

/**
 * Concept ids a card touches. A concept is touched when the distinct lexicon
 * terms found in the card sum to at least 1: one distinctive term, or two
 * generic ones (weight 0.5 each). Phrases are matched per field (title, each
 * tag, content), so words from neighbouring tags never join into a phrase.
 */
function conceptsOfCard(data: MemexNodeData, unigramTerms: Iterable<string>): Set<string> {
  const matched = new Map<string, Map<string, number>>();
  const hit = (entries: readonly TermEntry[] | undefined) => {
    for (const e of entries ?? []) {
      const terms = matched.get(e.concept) ?? new Map<string, number>();
      terms.set(e.termId, Math.max(terms.get(e.termId) ?? 0, e.weight));
      matched.set(e.concept, terms);
    }
  };
  for (const term of unigramTerms) hit(COMPILED_LEXICON.unigrams.get(term));
  const fields = [data.title, ...data.tags, data.content];
  for (const field of fields) {
    const tokens = stemmedTokens(field);
    for (const window of phraseWindows(tokens)) hit(COMPILED_LEXICON.phrases.get(window));
  }
  const out = new Set<string>();
  for (const [concept, terms] of matched) {
    let sum = 0;
    for (const w of terms.values()) sum += w;
    if (sum >= CONCEPT_TOUCH_WEIGHT) out.add(concept);
  }
  return out;
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

/** Sorted ids of the lexicon concepts a card touches (see `conceptsOfCard`). */
export function conceptIdsOf(data: MemexNodeData): string[] {
  return [...conceptsOfCard(data, termFrequencies(data).keys())].sort();
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

// ---------------------------------------------------------------------------
// Cross-era lineage boost
// ---------------------------------------------------------------------------

/** A card dated this year or earlier counts as an early origin. */
export const CROSS_ERA_EARLY_MAX_YEAR = 1970;
/** A card dated this year or later counts as a modern implementation. */
export const CROSS_ERA_LATE_MIN_YEAR = 2015;
/** Added to the raw affinity score of a cross-era pair that shares a concept. */
export const CROSS_ERA_BOOST = 0.2;

/**
 * True when one year is `<= 1970` and the other `>= 2015` (either order).
 * Undated cards (`null`) never qualify.
 */
export function isCrossEraPair(yearA: number | null, yearB: number | null): boolean {
  if (yearA === null || yearB === null) return false;
  return Math.min(yearA, yearB) <= CROSS_ERA_EARLY_MAX_YEAR && Math.max(yearA, yearB) >= CROSS_ERA_LATE_MIN_YEAR;
}

/**
 * Lineage boost added to a raw pair score before calibration: `0.2` for a
 * cross-era pair that shares at least one concept, otherwise `0`.
 */
export function crossEraBoost(
  yearA: number | null,
  yearB: number | null,
  sharedConceptCount: number,
): number {
  return sharedConceptCount > 0 && isCrossEraPair(yearA, yearB) ? CROSS_ERA_BOOST : 0;
}

/** Concept ids shared by two cards, sorted. */
function sharedConceptIds(a: ReadonlySet<string>, b: ReadonlySet<string>): string[] {
  return [...a].filter((c) => b.has(c)).sort();
}

// ---------------------------------------------------------------------------
// Contextual lineage rationales (pure rule table)
// ---------------------------------------------------------------------------

/** Landmark ideas that have a curated bridge sentence. */
export type LineageRole = "memex" | "hypertext" | "attention" | "graph-retrieval";

/** Seed cards recognized by archival ID (user-made equivalents match by signals below). */
const LINEAGE_ROLE_BY_ID: Readonly<Record<string, LineageRole>> = {
  "MEM-1945-01": "memex",
  "MEM-1965-02": "hypertext",
  "MEM-2017-04": "attention",
  "MEM-2024-05": "graph-retrieval",
};

/** Lowercased card text with hyphens as spaces, so "dot-product" and "dot product" read alike. */
function cardText(data: MemexNodeData): string {
  return `${data.title} ${data.tags.join(" ")} ${data.content}`.toLowerCase().replace(/[-_]+/g, " ");
}

/**
 * Roles a card plays. Matches the seed card by archival ID, or any card by
 * year plus vocabulary (so a user-made "Attention Is All You Need" note, dated
 * 2017, is recognized too). Signal roles require a known year.
 */
export function lineageRolesOf(node: Pick<MemexNode, "id" | "data">): LineageRole[] {
  const roles = new Set<LineageRole>();
  for (const id of [node.id, node.data.archivalId]) {
    const byId = LINEAGE_ROLE_BY_ID[id];
    if (byId) roles.add(byId);
  }
  const year = getEventYear(node.data);
  if (year !== null) {
    const text = cardText(node.data);
    if (year <= 1955 && /memex|as we may think/.test(text)) roles.add("memex");
    if (year >= 1960 && year <= 1975 && /hypertext|xanadu/.test(text)) roles.add("hypertext");
    if (
      year >= CROSS_ERA_LATE_MIN_YEAR &&
      /attention/.test(text) &&
      /transformer|dot product|scaled|\bquer(?:y|ies)\b|\bkeys?\b/.test(text)
    ) {
      roles.add("attention");
    }
    if (
      year >= CROSS_ERA_LATE_MIN_YEAR &&
      (/graph ?rag/.test(text) || (/knowledge graph/.test(text) && /communit/.test(text)))
    ) {
      roles.add("graph-retrieval");
    }
  }
  return [...roles].sort();
}

export interface LineageRationaleRule {
  id: string;
  /** Unordered pair of roles the rule applies to. */
  roles: readonly [LineageRole, LineageRole];
  text: string;
}

/**
 * Curated bridge sentences, first match wins. The first is worded as an
 * interpretation, like the seed attention card ("Read as retrieval..."), and
 * deliberately states no model dimensions.
 */
export const LINEAGE_RATIONALE_RULES: readonly LineageRationaleRule[] = [
  {
    id: "bush-attention",
    roles: ["memex", "attention"],
    text:
      "Direct theoretical realization (an interpretation): Bush's associative trail selection reads as scaled dot-product key-value lookup in Transformer attention.",
  },
  {
    id: "bush-graphrag",
    roles: ["memex", "graph-retrieval"],
    text:
      "Hierarchical graph community traversal operationalizes Bush's non-linear associative web for LLM memory retrieval.",
  },
  {
    id: "nelson-graphrag",
    roles: ["hypertext", "graph-retrieval"],
    text: "Non-linear hypertext topology realized as multi-hop associative graph retrieval.",
  },
  {
    id: "nelson-attention",
    roles: ["hypertext", "attention"],
    text: "Non-linear hypertext topology realized as multi-hop associative graph retrieval.",
  },
];

/** The curated rule that applies to a pair of cards, or `null`. Symmetric. */
export function matchLineageRule(
  nodeA: Pick<MemexNode, "id" | "data">,
  nodeB: Pick<MemexNode, "id" | "data">,
): LineageRationaleRule | null {
  const rolesA = lineageRolesOf(nodeA);
  const rolesB = lineageRolesOf(nodeB);
  for (const rule of LINEAGE_RATIONALE_RULES) {
    const [x, y] = rule.roles;
    if ((rolesA.includes(x) && rolesB.includes(y)) || (rolesA.includes(y) && rolesB.includes(x))) {
      return rule;
    }
  }
  return null;
}

/**
 * Explains a bridge: names the shared concepts and keywords, the shared tags
 * and the temporal gap between the two cards. Cross-era pairs that share a
 * concept get the "high-affinity conceptual nexus" sentence, and recognized
 * landmark pairs (see `LINEAGE_RATIONALE_RULES`) get their curated sentence.
 * Deterministic and symmetric in its two arguments.
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
  const sharedIds = sharedConceptIds(
    conceptsOfCard(a.data, tfA.keys()),
    conceptsOfCard(b.data, tfB.keys()),
  );
  const sharedConcepts = sharedIds.slice(0, 3).map((c) => CONCEPT_LEXICON[c].label);

  const yearA = getEventYear(a.data);
  const yearB = getEventYear(b.data);
  const crossEra = crossEraBoost(yearA, yearB, sharedIds.length) > 0;
  const rule = matchLineageRule(a, b);

  const titleA = a.data.title.trim() || a.data.archivalId;
  const titleB = b.data.title.trim() || b.data.archivalId;
  const parts: string[] = [];
  if (rule !== null) {
    parts.push(`"${titleA}" and "${titleB}" were never linked. ${rule.text}`);
    if (shared.length > 0) parts.push(`Shared terms: ${joinList(shared)}.`);
  } else if (crossEra) {
    parts.push(
      `"${titleA}" and "${titleB}" were never linked. Cards share a high-affinity conceptual nexus across ${joinList(sharedConcepts)} bridging theoretical origins with modern empirical implementations.`,
    );
    if (shared.length > 0) parts.push(`Shared terms: ${joinList(shared)}.`);
  } else if (sharedConcepts.length > 0) {
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

/** Raw affinity of one unordered pair of cards, before the threshold. */
export interface GhostPairScore {
  /** Lexicographically smaller card id. */
  sourceId: string;
  targetId: string;
  /** Score before the lineage boost, in `[0, 1]`. */
  base: number;
  /** `0` or `CROSS_ERA_BOOST`. */
  boost: number;
  /** `clamp01(base + boost)`. */
  score: number;
  /** Concept ids both cards touch, sorted. */
  sharedConcepts: string[];
}

/** Cards sorted by id with duplicate ids dropped (first wins), so output is order-independent. */
function sortedUniqueNodes(nodes: readonly MemexNode[]): MemexNode[] {
  const seen = new Set<string>();
  return [...nodes]
    .sort((x, y) => cmp(x.id, y.id))
    .filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true)));
}

/**
 * Raw score of every unordered pair of cards (ordered by source id, then target
 * id), ignoring edges and thresholds.
 *
 * `base = 0.3 * sqrt(cosine(TF-IDF)) + 0.5 * ochiai(concepts) + 0.2 * jaccard(tags)`;
 * `score = clamp01(base + crossEraBoost)`. Pure; does not mutate its input.
 */
export function scoreGhostPairs(nodes: readonly MemexNode[]): GhostPairScore[] {
  const sorted = sortedUniqueNodes(nodes);
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
  const concepts = sorted.map((node, i) => conceptsOfCard(node.data, tfs[i].keys()));
  const years = sorted.map((node) => getEventYear(node.data));

  const out: GhostPairScore[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const sharedConcepts = sharedConceptIds(concepts[i], concepts[j]);
      const base = clamp01(
        COSINE_WEIGHT * Math.sqrt(computeCosineSimilarity(vectors[i], vectors[j])) +
          CONCEPT_WEIGHT * ochiai(concepts[i], concepts[j]) +
          TAG_WEIGHT * jaccard(tags[i], tags[j]),
      );
      const boost = crossEraBoost(years[i], years[j], sharedConcepts.length);
      out.push({
        sourceId: sorted[i].id,
        targetId: sorted[j].id,
        base,
        boost,
        score: clamp01(base + boost),
        sharedConcepts,
      });
    }
  }
  return out;
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
 * plus the cross-era lineage boost (`crossEraBoost`: +0.2 when one card is
 * dated `<= 1970`, the other `>= 2015`, and they share a concept), clamped to
 * `[0, 1]`. Confidence is the calibrated score (`calibrateGhostConfidence`,
 * within `[0.78, 0.96]`). Output is sorted by score (desc) then ID (asc) and
 * capped at `maxResults`; the result does not depend on the order of `nodes`
 * or `existingEdges`. Inputs are not mutated.
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
  const byId = new Map(sortedUniqueNodes(nodes).map((node) => [node.id, node]));

  const found: { discovery: GhostDiscovery; score: number }[] = [];
  for (const pair of scoreGhostPairs(nodes)) {
    const id = ghostDiscoveryId(pair.sourceId, pair.targetId);
    if (connected.has(ghostPairKey(pair.sourceId, pair.targetId)) || dismissed.has(id)) continue;
    if (pair.score <= 0 || pair.score < threshold) continue;
    const a = byId.get(pair.sourceId);
    const b = byId.get(pair.targetId);
    if (a === undefined || b === undefined) continue;
    found.push({
      score: pair.score,
      discovery: {
        id,
        sourceId: pair.sourceId,
        targetId: pair.targetId,
        rationale: synthesizeBridgeRationale(a, b),
        confidence: calibrateGhostConfidence(pair.score),
        discoveredAt,
      },
    });
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
