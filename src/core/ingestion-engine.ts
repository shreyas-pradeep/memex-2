import { CONCEPT_LEXICON, STOP_WORDS, stem } from "./ghost-engine";
import { CASSETTE_TITLE_MAX, hashCassetteId, resolveCassetteId, type CassetteRef } from "./cassette-engine";
import { edgeId } from "./graph-engine";
import { TRAIL_EPOCH } from "./trail-engine";
import type { AssociativeEdge, MemexCardType, MemexNode } from "./types";

/**
 * The Platen Scanner: pure, deterministic document ingestion. No React, no
 * clock, no randomness. Uniqueness against the live graph comes from the
 * injectable `IngestContext` (the store supplies it).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum accepted source size: 1 MB of UTF-8. */
export const MAX_SOURCE_BYTES = 1_048_576;
/** Only this much text is analysed; the rest of an oversized paste is ignored by the distiller. */
export const MAX_DISTILL_CHARS = 200_000;
export const MIN_YEAR = 1890;
export const MAX_YEAR = 2026;
export const MAX_TAGS = 6;
export const UNTITLED_SOURCE = "Untitled Source";
export const SUPPORTED_EXTENSIONS = [".txt", ".md", ".markdown", ".json"] as const;

/** Card box (px); equals the store's `DEFAULT_CARD_SIZE`. */
export const CARD_WIDTH = 340;
export const CARD_HEIGHT = 230;
/** Distance from the Note's center to each satellite card's center (px). */
export const RING_RADIUS = 460;
/** Guaranteed minimum distance between any two card centers (px). */
export const MIN_CENTER_DISTANCE = 380;
/** Base coordinates are clamped to this range so float precision never erodes spacing. */
export const MAX_COORDINATE = 1_000_000;

const MAX_QUOTES = 2;
const NOTE_CHARS = 520;
const QUOTE_CHARS = 400;
const ARTIFACT_CHARS = 520;
const MAX_ARTIFACT_LINES = 4;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SourceFormat = "txt" | "md" | "json" | "text";
export type IngestErrorCode = "unsupported-type" | "empty" | "too-large" | "malformed-json";

export type ParsedSource =
  | { ok: true; title: string; text: string; format: SourceFormat }
  | { ok: false; code: IngestErrorCode; message: string };

export interface Point {
  x: number;
  y: number;
}

/** Injectable context: what the caller knows and the pure engine cannot. */
export interface IngestContext {
  /** Prefix of generated card IDs. Default: `src-<hash of title and text>`. */
  idPrefix?: string;
  /** ISO-8601 `createdAt` for all cards. Default: `TRAIL_EPOCH`. */
  createdAt?: string;
  /** IDs already on the canvas; generated IDs never collide with them. */
  existingIds?: Iterable<string>;
  /** First archival number to use (`MEM-1945-XXXX`). Default 1. */
  archivalStart?: number;
  /**
   * Base cassette id (Spec 09), e.g. `cassette-1706.03762` for an arXiv paper.
   * Default `cassette-<8-hex hash of title and text>`, the hash that also
   * prefixes the card ids.
   */
  cassetteId?: string;
  /** Cassettes already on the canvas; the generated id is made collision-safe against them. */
  existingCassettes?: Iterable<CassetteRef>;
}

export interface DistilledSource {
  nodes: MemexNode[];
  edges: AssociativeEdge[];
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** Line endings to `\n`, control characters to spaces, runs of blanks collapsed, trimmed. */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, " ")
    .replace(/[ \t\u00A0]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Truncates at a word boundary and appends an ellipsis when text was cut. */
export function truncateAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, Math.max(1, max - 1));
  const space = cut.lastIndexOf(" ");
  const base = space > max * 0.5 ? cut.slice(0, space) : cut;
  return `${base.replace(/[\s,;:.\-–—]+$/, "")}…`;
}

function utf8Length(text: string): number {
  // UTF-16 length never exceeds the UTF-8 byte length, so this check is exact for rejection.
  if (text.length > MAX_SOURCE_BYTES) return text.length;
  return new TextEncoder().encode(text).length;
}

function clampCoordinate(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(MAX_COORDINATE, Math.max(-MAX_COORDINATE, n));
}

export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// Publication year
// ---------------------------------------------------------------------------

const YEAR_CANDIDATE = /(?<![\w.,\-/$])(1[89]\d\d|20[0-2]\d)(?!\w|\.\d|,\d)/g;
const YEAR_CONTEXT_BEFORE =
  /(?:published|publication|publ\.|copyright|copr\.|©|\(c\)|written|issued|appeared|released|since|\bin|\bof|\bby|\bfrom)\W{0,3}(?:\w+ ){0,2}$/i;

/**
 * Best-guess publication year of `text`, or `undefined`. A year is a standalone
 * four-digit number in [1890, 2026]. Candidates in publication contexts
 * ("published", "©", "In 1968", "(1945)") outrank bare ones; ties go to the
 * earliest position. Never throws.
 */
export function extractPublicationYear(text: string): number | undefined {
  const sample = text.length > MAX_DISTILL_CHARS ? text.slice(0, MAX_DISTILL_CHARS) : text;
  let best: { year: number; score: number } | undefined;
  for (const m of sample.matchAll(YEAR_CANDIDATE)) {
    const year = Number(m[1]);
    if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) continue;
    const start = m.index ?? 0;
    const before = sample.slice(Math.max(0, start - 40), start);
    let score = 1;
    if (/\(\s*$/.test(before) && sample[start + 4] === ")") score += 3;
    if (/(?:published|publication|publ\.|copyright|copr\.|©|\(c\))\W{0,3}(?:\w+ ){0,2}$/i.test(before)) {
      score += 4;
    } else if (YEAR_CONTEXT_BEFORE.test(before)) {
      score += 2;
    }
    if (best === undefined || score > best.score) best = { year, score };
  }
  return best?.year;
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

/** Research taxonomy: tag -> trigger terms (stemmed at load by the Ghost stemmer). */
const TAXONOMY: Readonly<Record<string, readonly string[]>> = {
  attention: ["attention", "transformer", "self-attention"],
  augmentation: ["augment", "augmentation", "collaboration", "engelbart", "assistant"],
  benchmark: ["benchmark", "accuracy", "evaluation", "baseline", "dataset"],
  cognition: ["cognitive", "cognition", "mind", "thinking", "reasoning"],
  computing: ["computer", "computing", "digital", "machine", "computation"],
  "deep-learning": ["neural", "training", "learning", "model", "pretrained"],
  graph: ["graph", "node", "entity", "network", "community"],
  hci: ["hci", "interface", "interaction", "usability", "user", "mouse", "interactive"],
  hypertext: ["hypertext", "hyperlink", "link", "trail", "nonlinear", "xanadu", "web"],
  interpretability: ["interpretability", "interpretable", "feature", "neuron", "superposition"],
  latent: ["latent", "embedding", "representation", "autoencoder", "vector"],
  memory: ["memory", "storage", "archive", "recall", "microfilm", "memex"],
  retrieval: ["retrieval", "retrieve", "rag", "search", "query", "lookup", "index"],
  spatial: ["spatial", "canvas", "map", "layout", "landmark"],
};

const TAXONOMY_STEMS: ReadonlyMap<string, readonly string[]> = (() => {
  const map = new Map<string, string[]>();
  for (const tag of Object.keys(TAXONOMY).sort()) {
    for (const term of TAXONOMY[tag]) {
      for (const part of term.split("-")) {
        const s = stem(part);
        const list = map.get(s) ?? [];
        if (!list.includes(tag)) list.push(tag);
        map.set(s, list);
      }
    }
  }
  return map;
})();

/** Stems of every concept-lexicon term, used to rank salient sentences. */
const LEXICON_STEMS: ReadonlySet<string> = new Set(
  Object.values(CONCEPT_LEXICON).flatMap((c) => c.terms.map((t) => stem(t))),
);

function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || /^\d+$/.test(raw)) continue;
    out.push(raw);
  }
  return out;
}

/**
 * Up to 6 taxonomy tags for `text`, unprefixed lowercase like the demo seed,
 * ranked by hit count and returned sorted alphabetically. Falls back to the
 * most frequent plain keywords when no taxonomy term matches. Deterministic.
 */
export function extractTags(text: string): string[] {
  const sample = text.length > MAX_DISTILL_CHARS ? text.slice(0, MAX_DISTILL_CHARS) : text;
  const hits = new Map<string, number>();
  const plain = new Map<string, number>();
  for (const raw of tokenize(sample)) {
    const s = stem(raw);
    for (const tag of TAXONOMY_STEMS.get(s) ?? []) hits.set(tag, (hits.get(tag) ?? 0) + 1);
    if (raw.length >= 4 && !STOP_WORDS.has(raw) && !STOP_WORDS.has(s)) {
      plain.set(s, (plain.get(s) ?? 0) + 1);
    }
  }
  const rank = (m: ReadonlyMap<string, number>, limit: number): string[] =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, limit)
      .map(([k]) => k);
  const chosen = hits.size > 0 ? rank(hits, MAX_TAGS) : rank(plain, 3);
  return [...new Set(chosen)].sort();
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function fail(code: IngestErrorCode, message: string): ParsedSource {
  return { ok: false, code, message };
}

function validateRaw(text: string): ParsedSource | null {
  if (utf8Length(text) > MAX_SOURCE_BYTES) {
    return fail("too-large", `Source is too large. The limit is ${MAX_SOURCE_BYTES / 1_048_576} MB.`);
  }
  if (text.trim() === "") return fail("empty", "The source is empty. Add some text to scan.");
  return null;
}

function titleFromFileName(name: string): string {
  const base = name.replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "");
  return base.replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Strips Markdown syntax while keeping the readable text (table pipes stay). */
export function stripMarkdown(md: string): string {
  return md
    .replace(/\r\n?/g, "\n")
    .replace(/^ {0,3}(?:`{3,}|~{3,}).*$/gm, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^ {0,3}(?:[-*_]\s*){3,}$/gm, "")
    .replace(/^ {0,3}#{1,6}\s+/gm, "")
    .replace(/^ {0,3}>\s?/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>\n]+>/g, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(\*|_)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`([^`\n]*)`/g, "$1");
}

function firstMarkdownHeading(md: string): string | undefined {
  const m = /^ {0,3}#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(md);
  const heading = m ? stripMarkdown(m[1]).trim() : "";
  return heading === "" ? undefined : heading;
}

const JSON_BODY_FIELDS = ["abstract", "content", "text", "body"] as const;
const MAX_JSON_DEPTH = 20;

interface JsonText {
  title?: string;
  text: string;
}

function scalarToString(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v) ?? "";
}

function jsonToText(value: unknown, depth: number): JsonText {
  if (typeof value === "string") return { text: value };
  if (value === null || typeof value !== "object" || depth > MAX_JSON_DEPTH) {
    return { text: scalarToString(value) };
  }
  if (Array.isArray(value)) {
    const parts = value.map((item) => jsonToText(item, depth + 1));
    const title = parts.find((p) => p.title !== undefined)?.title;
    const text = parts
      .map((p) => (p.title !== undefined && p.text !== "" ? `${p.title}. ${p.text}` : p.text))
      .filter((t) => t.trim() !== "")
      .join("\n\n");
    return title !== undefined ? { title, text } : { text };
  }
  const obj = value as Record<string, unknown>;
  const title = typeof obj.title === "string" && obj.title.trim() !== "" ? obj.title.trim() : undefined;
  const bodies = JSON_BODY_FIELDS.map((k) => obj[k]).filter(
    (v): v is string => typeof v === "string" && v.trim() !== "",
  );
  if (bodies.length > 0) return title !== undefined ? { title, text: bodies.join("\n\n") } : { text: bodies.join("\n\n") };
  const lines = Object.entries(obj)
    .filter(([k]) => k !== "title")
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : scalarToString(v)}`);
  return title !== undefined ? { title, text: lines.join("\n") } : { text: lines.join("\n") };
}

/**
 * Parses an uploaded file by extension. Every failure is returned as
 * `{ ok: false, code, message }`; this function never throws.
 */
export function parseSourceFile(name: string, text: string): ParsedSource {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name.trim())?.[0].toLowerCase() ?? "";
  if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) {
    return fail(
      "unsupported-type",
      `Unsupported file type${ext ? ` "${ext}"` : ""}. Use ${SUPPORTED_EXTENSIONS.filter((e) => e !== ".markdown").join(", ")}.`,
    );
  }
  const invalid = validateRaw(text);
  if (invalid) return invalid;
  const fileTitle = titleFromFileName(name);

  let result: { title: string; body: string; format: SourceFormat };
  if (ext === ".json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "invalid syntax";
      return fail("malformed-json", `Malformed JSON: ${reason}`);
    }
    const j = jsonToText(parsed, 0);
    result = { title: j.title ?? fileTitle, body: j.text, format: "json" };
  } else if (ext === ".txt") {
    result = { title: fileTitle, body: text, format: "txt" };
  } else {
    result = {
      title: firstMarkdownHeading(text) ?? fileTitle,
      body: stripMarkdown(text),
      format: "md",
    };
  }
  const body = normalizeText(result.body);
  if (body === "") return fail("empty", "The source has no readable text.");
  return { ok: true, title: result.title.trim(), text: body, format: result.format };
}

/** Validates pasted text. A blank title is allowed (the distiller derives one). */
export function parsePastedText(title: string, text: string): ParsedSource {
  const invalid = validateRaw(text);
  if (invalid) return invalid;
  const body = normalizeText(text);
  if (body === "") return fail("empty", "The source has no readable text.");
  return { ok: true, title: title.trim(), text: body, format: "text" };
}

// ---------------------------------------------------------------------------
// Distillation
// ---------------------------------------------------------------------------

function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    for (const part of line.split(/(?<=[.!?])\s+/)) {
      const s = part.trim();
      if (s !== "") out.push(s);
      if (out.length >= 2000) return out;
    }
  }
  return out;
}

function salience(sentence: string, index: number): number {
  let hits = 0;
  for (const raw of tokenize(sentence)) {
    const s = stem(raw);
    if (TAXONOMY_STEMS.has(s) || LEXICON_STEMS.has(s)) hits++;
  }
  return hits + Math.min(sentence.length, 200) / 200 + (index === 0 ? 1.5 : 0);
}

function shortWords(text: string, count: number): string {
  const words = text.split(/\s+/).filter((w) => w !== "");
  const head = words.slice(0, count).join(" ").replace(/[\s,;:.\-–—"“”]+$/, "");
  return words.length > count ? `${head}…` : head;
}

const STAT_PATTERN =
  /\d(?:[\d,]*\.?\d*)\s?%|\b\d[\d,]*(?:\.\d+)?(?:ms|x|×|kb|mb|gb|tb|k|m|b|hz|mhz|ghz|fps)\b|\b\d[\d,]*(?:\.\d+)?\s(?:percent|tokens?|parameters|params|users|seconds|ms|gb|mb|points)\b|\b\d+(?:\.\d+)?\s?(?:x|×)\s+(?:faster|slower|better|worse|more|less|larger|smaller|cheaper)/i;

function isTableLine(line: string): boolean {
  return (line.match(/\|/g)?.length ?? 0) >= 2;
}

function statLines(text: string, sentences: readonly string[]): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const add = (s: string) => {
    if (!seen.has(s) && found.length < MAX_ARTIFACT_LINES) {
      seen.add(s);
      found.push(s);
    }
  };
  const lines = text.split("\n");
  const tableLines = lines.filter(isTableLine);
  if (tableLines.length >= 2) for (const l of tableLines) add(l.trim());
  for (const s of sentences) if (!isTableLine(s) && STAT_PATTERN.test(s)) add(s);
  return found;
}

function findQuotations(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/[“"]([^“”"\n]{20,400}?)[”"]/g)) {
    const q = m[1].trim();
    if (q.length >= 20 && !out.includes(q)) out.push(q);
    if (out.length >= MAX_QUOTES) break;
  }
  return out;
}

/** Top-left positions for `count` cards: the first at the base (card center), the rest on a ring. */
export function radialPlacement(base: Point, count: number): Point[] {
  const cx = clampCoordinate(base.x);
  const cy = clampCoordinate(base.y);
  const satellites = Math.max(0, count - 1);
  const angles: number[] =
    satellites === 1 ? [30] : satellites === 2 ? [30, 210] : [-90, 30, 150].slice(0, satellites);
  const centers: Point[] = [{ x: cx, y: cy }];
  for (const deg of angles) {
    const rad = (deg * Math.PI) / 180;
    centers.push({ x: cx + RING_RADIUS * Math.cos(rad), y: cy + RING_RADIUS * Math.sin(rad) });
  }
  return centers.slice(0, count).map((c) => ({
    x: Math.round(c.x - CARD_WIDTH / 2),
    y: Math.round(c.y - CARD_HEIGHT / 2),
  }));
}

/**
 * Base (center) for a new cluster: right of the current bounding box, vertically
 * centered on it, with a clear gutter. `{0, 0}` for an empty canvas.
 */
export function pickIngestionBase(nodes: readonly MemexNode[]): Point {
  if (nodes.length === 0) return { x: 0, y: 0 };
  let maxRight = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    const w = typeof n.style?.width === "number" ? n.style.width : (n.width ?? CARD_WIDTH);
    const h = typeof n.style?.height === "number" ? n.style.height : (n.height ?? CARD_HEIGHT);
    maxRight = Math.max(maxRight, n.position.x + w);
    minY = Math.min(minY, n.position.y);
    maxY = Math.max(maxY, n.position.y + h);
  }
  const gutter = 80;
  return {
    x: clampCoordinate(Math.round(maxRight + gutter + RING_RADIUS + CARD_WIDTH / 2)),
    y: clampCoordinate(Math.round((minY + maxY) / 2)),
  };
}

interface CardDraft {
  role: "note" | "quote-1" | "quote-2" | "artifact";
  cardType: MemexCardType;
  title: string;
  content: string;
}

/**
 * Distills a source into atomic cards plus chain edges. Always yields at least
 * one valid Note. Quotes are verbatim quotations or labelled excerpts of the
 * source; nothing is invented. IDs are `<prefix>-note|quote-1|quote-2|artifact`
 * where the prefix is `ctx.idPrefix` or `src-<fnv1a(title, text)>`, suffixed
 * `-2`, `-3`, ... until none collides with `ctx.existingIds`. Every card gets
 * the same `cassetteId` / `cassetteTitle` (see `IngestContext.cassetteId`).
 */
export function distillSourceText(
  title: string,
  rawText: string,
  basePosition: Point,
  ctx: IngestContext = {},
): DistilledSource {
  const clipped = rawText.length > MAX_DISTILL_CHARS ? rawText.slice(0, MAX_DISTILL_CHARS) : rawText;
  const text = normalizeText(clipped);
  const sentences = splitSentences(text);
  const year = extractPublicationYear(`${title}\n${text}`);

  // Note: lead sentence plus the most salient others, in source order.
  const scored = sentences.map((s, i) => ({ s, i, score: salience(s, i) }));
  const lead = scored[0];
  const rest = scored
    .slice(1)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, 2);
  const picked = lead ? [lead, ...rest].sort((a, b) => a.i - b.i) : [];
  const usedIdx = new Set(picked.map((p) => p.i));
  const noteBody =
    picked.length > 0 ? truncateAtWord(picked.map((p) => p.s).join(" "), NOTE_CHARS) : "(empty source)";
  const cleanTitle = normalizeText(title).replace(/\n/g, " ");
  const noteTitle =
    cleanTitle !== ""
      ? truncateAtWord(cleanTitle, 80)
      : lead
        ? truncateAtWord(shortWords(lead.s, 9), 80)
        : UNTITLED_SOURCE;

  const drafts: CardDraft[] = [
    { role: "note", cardType: "note", title: noteTitle || UNTITLED_SOURCE, content: noteBody },
  ];

  // Quotes: verbatim quotations first, else labelled excerpts.
  const quotations = findQuotations(text);
  if (quotations.length > 0) {
    quotations.forEach((q, k) =>
      drafts.push({
        role: k === 0 ? "quote-1" : "quote-2",
        cardType: "quote",
        title: `Quote: ${shortWords(q, 6)}`,
        content: `“${q}”`,
      }),
    );
  } else {
    scored
      .filter((c) => !usedIdx.has(c.i) && c.s.length >= 40)
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .slice(0, MAX_QUOTES)
      .sort((a, b) => a.i - b.i)
      .forEach((c, k) =>
        drafts.push({
          role: k === 0 ? "quote-1" : "quote-2",
          cardType: "quote",
          title: `Excerpt: ${shortWords(c.s, 6)}`,
          content: truncateAtWord(c.s, QUOTE_CHARS),
        }),
      );
  }

  // Artifact: only when the source carries data.
  const stats = statLines(text, sentences);
  if (stats.length > 0) {
    drafts.push({
      role: "artifact",
      cardType: "artifact",
      title: `Data: ${truncateAtWord(noteTitle, 60)}`,
      content: truncateAtWord(stats.join("\n"), ARTIFACT_CHARS),
    });
  }

  // IDs: deterministic prefix, bumped until clear of existing IDs.
  const existing = new Set(ctx.existingIds ?? []);
  const basePrefix = ctx.idPrefix ?? `src-${fnv1a(`${title}\u0000${text}`)}`;
  let prefix = basePrefix;
  for (let k = 2; drafts.some((d) => existing.has(`${prefix}-${d.role}`)); k++) {
    prefix = `${basePrefix}-${k}`;
  }

  const createdAt = ctx.createdAt ?? TRAIL_EPOCH;
  const archivalStart = Math.max(1, Math.floor(ctx.archivalStart ?? 1));
  // One cassette for every card of this source. The default id uses the same
  // hash as the card-id prefix, whatever `idPrefix` or collision bumps did.
  const cassetteTitle = truncateAtWord(noteTitle || UNTITLED_SOURCE, CASSETTE_TITLE_MAX);
  const cassetteId = resolveCassetteId(
    ctx.cassetteId ?? hashCassetteId(fnv1a(`${title}\u0000${text}`)),
    cassetteTitle,
    ctx.existingCassettes ?? [],
  );
  const noteTags = extractTags(`${title}\n${text}`);
  const positions = radialPlacement(basePosition, drafts.length);

  const nodes: MemexNode[] = drafts.map((d, i) => {
    const own = d.role === "note" ? noteTags : extractTags(`${d.title}\n${d.content}`);
    return {
      id: `${prefix}-${d.role}`,
      type: "memexCard",
      position: positions[i],
      style: { width: CARD_WIDTH, height: CARD_HEIGHT },
      data: {
        archivalId: `MEM-1945-${String(archivalStart + i).padStart(4, "0")}`,
        title: d.title,
        content: d.content,
        cardType: d.cardType,
        tags: own.length > 0 ? own : noteTags,
        createdAt,
        ...(year !== undefined ? { year } : {}),
        cassetteId,
        cassetteTitle,
      },
    };
  });

  const edges: AssociativeEdge[] = [];
  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i - 1];
    const b = nodes[i];
    const toArtifact = b.data.cardType === "artifact";
    edges.push({
      id: edgeId(a.id, b.id, "human"),
      source: a.id,
      target: b.id,
      type: "associative",
      data: {
        origin: "human",
        strength: toArtifact ? 0.7 : a.data.cardType === "note" ? 0.9 : 0.8,
        rationale: toArtifact
          ? "Quantitative evidence extracted from the same source."
          : a.data.cardType === "note"
            ? "Supporting passage from the source behind this thesis."
            : "Further passage from the same source.",
      },
    });
  }
  return { nodes, edges };
}
