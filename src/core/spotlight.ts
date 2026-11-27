import type { MemexCardType, MemexNode, MemexNodeData } from "./types";

/**
 * Spotlight & filter (Spec 09): deterministic fuzzy search over cards, type
 * and tag filters that combine with AND, and a tag cloud. Pure: no React, no
 * store, no clock, no randomness.
 */

/** Opacity of a card the spotlight filtered out. */
export const SPOTLIGHT_DIM_OPACITY = 0.15;
/** Opacity of a card outside the playing trail (same value as `DIM_OPACITY` in the trail selectors). */
export const TRAIL_DIM_OPACITY = 0.2;
/** Fuzzy typo and subsequence matching only apply to texts up to this length (long bodies would match anything). */
export const LOOSE_MATCH_MAX_CHARS = 200;
export const TAG_CLOUD_CAP = 40;

export type SpotlightType = "all" | MemexCardType;

export interface SpotlightFilters {
  query: string;
  type: SpotlightType;
  /** A card must carry ALL of these tags (case-insensitive). */
  tags: readonly string[];
}

export type SpotlightDim = "match" | "dim" | "off";

// ---------------------------------------------------------------------------
// Fuzzy scoring
// ---------------------------------------------------------------------------

/** Lowercase, diacritics removed (NFD without combining marks). */
export function foldText(text: string): string {
  return text.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
}

/** Query tokens: folded, split on whitespace, empty ones dropped. */
export function tokenizeQuery(query: string): string[] {
  return foldText(query).split(/\s+/).filter((t) => t !== "");
}

const WORD_SPLIT = /[^\p{L}\p{N}]+/u;

/** True when `a` and `b` differ by at most one insertion, deletion, substitution or adjacent swap. */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i++;
  if (la === lb) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true; // substitution
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2); // swap
  }
  return la > lb ? a.slice(i + 1) === b.slice(i) : b.slice(i + 1) === a.slice(i);
}

/** Span (in characters) of a greedy in-order match of `token` in `text`, or 0 when it is not a subsequence. */
function subsequenceSpan(token: string, text: string): number {
  let at = 0;
  let first = -1;
  let last = -1;
  for (let i = 0; i < text.length && at < token.length; i++) {
    if (text[i] === token[at]) {
      if (first === -1) first = i;
      last = i;
      at++;
    }
  }
  return at === token.length ? last - first + 1 : 0;
}

/**
 * Score of one folded token against one folded text, in `[0, 1]`:
 * exact text 1, exact word 0.9, prefix of the text 0.8, prefix of a word 0.7,
 * substring 0.5, then (short texts only) one typo on a word of 5+ letters 0.35
 * and an in-order subsequence of 3+ letters 0.1 to 0.3. 0 means no match.
 */
function tokenScore(token: string, text: string): number {
  if (token === "" || text === "") return 0;
  if (text === token) return 1;
  const words = text.split(WORD_SPLIT).filter((w) => w !== "");
  if (words.includes(token)) return 0.9;
  if (text.startsWith(token)) return 0.8;
  if (words.some((w) => w.startsWith(token))) return 0.7;
  if (text.includes(token)) return 0.5;
  if (text.length > LOOSE_MATCH_MAX_CHARS) return 0;
  if (token.length >= 5 && words.some((w) => w.length >= 4 && withinOneEdit(token, w))) return 0.35;
  if (token.length >= 3) {
    const span = subsequenceSpan(token, text);
    if (span > 0) return 0.1 + 0.2 * (token.length / span);
  }
  return 0;
}

/**
 * Fuzzy score of `query` against `text`, in `[0, 1]`; 0 means no match.
 * Case and diacritics are ignored. Every whitespace-separated query token must
 * match (AND); the score is the mean of the token scores, so an exact hit
 * outranks a prefix, a word-boundary hit and a loose subsequence. An empty
 * query scores 1 (it matches everything). Deterministic.
 */
export function fuzzyScore(query: string, text: string): number {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return 1;
  const folded = foldText(text).trim();
  let sum = 0;
  for (const token of tokens) {
    const s = tokenScore(token, folded);
    if (s === 0) return 0;
    sum += s;
  }
  return sum / tokens.length;
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/** Trimmed lowercase tag, the form used for matching and for the tag cloud. */
export function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

/** True when any of query, type or tags narrows the canvas. */
export function isSpotlightActive(f: SpotlightFilters): boolean {
  return tokenizeQuery(f.query).length > 0 || f.type !== "all" || f.tags.some((t) => normalizeTag(t) !== "");
}

const FIELD_WEIGHTS = { title: 1, tag: 0.9, author: 0.85, source: 0.8, content: 0.6 } as const;

/**
 * How well a card matches the query tokens: each token takes its best weighted
 * field (title, tags, authors, source, content), every token must match
 * somewhere, and the result is the mean. 1 for an empty token list; 0 for no match.
 */
export function scoreNodeQuery(data: Pick<MemexNodeData, "title" | "content" | "tags" | "authors" | "source">, tokens: readonly string[]): number {
  if (tokens.length === 0) return 1;
  const fields: { text: string; weight: number }[] = [
    { text: foldText(data.title).trim(), weight: FIELD_WEIGHTS.title },
    ...data.tags.map((t) => ({ text: foldText(t).trim(), weight: FIELD_WEIGHTS.tag })),
    ...(data.authors ?? []).map((a) => ({ text: foldText(a).trim(), weight: FIELD_WEIGHTS.author })),
    { text: foldText(data.source ?? "").trim(), weight: FIELD_WEIGHTS.source },
    { text: foldText(data.content).trim(), weight: FIELD_WEIGHTS.content },
  ];
  let sum = 0;
  for (const token of tokens) {
    let best = 0;
    for (const f of fields) best = Math.max(best, tokenScore(token, f.text) * f.weight);
    if (best === 0) return 0;
    sum += best;
  }
  return sum / tokens.length;
}

/**
 * Whether a card passes the filters: its type matches (or is `all`), it carries
 * EVERY selected tag, and the query matches its title, content, tags, authors
 * or source. An empty query matches every card.
 */
export function matchNode(node: Pick<MemexNode, "data">, filters: SpotlightFilters): boolean {
  const data = node.data;
  if (filters.type !== "all" && data.cardType !== filters.type) return false;
  const wanted = filters.tags.map(normalizeTag).filter((t) => t !== "");
  if (wanted.length > 0) {
    const own = new Set(data.tags.map(normalizeTag));
    if (!wanted.every((t) => own.has(t))) return false;
  }
  return scoreNodeQuery(data, tokenizeQuery(filters.query)) > 0;
}

/** Ids of the cards that match, or `null` when no filter is active (nothing is dimmed). */
export function computeMatchSet(nodes: readonly MemexNode[], filters: SpotlightFilters): Set<string> | null {
  if (!isSpotlightActive(filters)) return null;
  const out = new Set<string>();
  for (const n of nodes) if (matchNode(n, filters)) out.add(n.id);
  return out;
}

/** Stable string for a filter set: equal for filters that match the same way (folded query, sorted unique tags). */
export function filterSignature(filters: SpotlightFilters): string {
  const tags = [...new Set(filters.tags.map(normalizeTag).filter((t) => t !== ""))].sort();
  return JSON.stringify([tokenizeQuery(filters.query).join(" "), filters.type, tags]);
}

const MEMO = new WeakMap<object, { signature: string; match: boolean }>();

/**
 * `matchNode` memoized per `node.data` object and filter signature. A card drag
 * replaces the node object but keeps `data`, so the per-frame cost is a
 * WeakMap lookup and a string compare. A new signature recomputes and replaces
 * the entry; the result always equals `matchNode`.
 */
export function matchNodeMemo(
  node: Pick<MemexNode, "data">,
  filters: SpotlightFilters,
  signature: string = filterSignature(filters),
): boolean {
  const hit = MEMO.get(node.data);
  if (hit !== undefined && hit.signature === signature) return hit.match;
  const match = matchNode(node, filters);
  MEMO.set(node.data, { signature, match });
  return match;
}

// ---------------------------------------------------------------------------
// Tag cloud
// ---------------------------------------------------------------------------

export interface TagCount {
  tag: string;
  count: number;
}

/**
 * Tags in use as `{ tag, count }`: the tag is trimmed and lowercased, the count
 * is the number of cards carrying it (once per card). Sorted by count
 * descending then tag ascending, cut to `cap` entries.
 */
export function buildTagCloud(nodes: readonly Pick<MemexNode, "data">[], cap: number = TAG_CLOUD_CAP): TagCount[] {
  const counts = new Map<string, number>();
  for (const n of nodes) {
    for (const tag of new Set(n.data.tags.map(normalizeTag))) {
      if (tag !== "") counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  const limit = Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : 0;
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Composition with trail dimming
// ---------------------------------------------------------------------------

/** How the playing trail presents a card (the `TrailVisualState` of the trail selectors). */
export type TrailDimState = "idle" | "current" | "active" | "dim";

/**
 * Opacity of a card under both dimmers. Each contributes its own opacity (the
 * trail's 0.2 when the card is outside the playing trail, the spotlight's 0.15
 * when it is filtered out, 1 otherwise) and the result is the minimum, so a card
 * dimmed by both shows at 0.15 and a card dimmed by neither at 1.
 */
export function combinedDimOpacity(trail: TrailDimState, spotlight: SpotlightDim): number {
  return Math.min(trail === "dim" ? TRAIL_DIM_OPACITY : 1, spotlight === "dim" ? SPOTLIGHT_DIM_OPACITY : 1);
}
