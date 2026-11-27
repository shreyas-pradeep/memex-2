import { formatEventDate, getEventYear, TRAIL_EPOCH } from "./trail-engine";
import { parseArxivId } from "./arxiv";
import type {
  AssociativeEdge,
  AssociativeEdgeData,
  EdgePolarity,
  MemexNode,
  Trail,
} from "./types";

/**
 * Research synthesis: trail briefings (Markdown), BibTeX entries and edge
 * polarity helpers. Pure and deterministic: no React, no clock, no randomness.
 * Briefings are built only from the trail's own cards; nothing is invented.
 */

// ---------------------------------------------------------------------------
// Edge polarity
// ---------------------------------------------------------------------------

/** The three polarities in cycle order. */
export const EDGE_POLARITIES: readonly EdgePolarity[] = ["supports", "refutes", "synthesizes"];

export function isEdgePolarity(value: unknown): value is EdgePolarity {
  return value === "supports" || value === "refutes" || value === "synthesizes";
}

/** Polarity of an edge: `supports` unless it explicitly carries a valid, other polarity. */
export function getEdgePolarity(
  edge: { data?: Pick<AssociativeEdgeData, "polarity"> | undefined } | null | undefined,
): EdgePolarity {
  const p: unknown = edge?.data?.polarity;
  return isEdgePolarity(p) ? p : "supports";
}

/**
 * Next polarity in the cycle supports -> refutes -> synthesizes -> supports.
 * `undefined` (and any unknown value from a hand-edited save) counts as `supports`.
 */
export function cyclePolarity(polarity?: EdgePolarity): EdgePolarity {
  switch (isEdgePolarity(polarity) ? polarity : "supports") {
    case "supports":
      return "refutes";
    case "refutes":
      return "synthesizes";
    default:
      return "supports";
  }
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

const LINE_BREAKS = /[\r\n\u000B\u000C\u0085\u2028\u2029]+/g;

/** Replaces every line break with one space, so untrusted text stays on one line. */
export function singleLine(text: string): string {
  return text.replace(LINE_BREAKS, " ");
}

/**
 * Double-quoted YAML scalar. Uses JSON string escaping (a YAML subset) and
 * additionally escapes the characters YAML treats as line breaks or forbids.
 */
export function yamlQuote(value: string): string {
  return JSON.stringify(value).replace(
    /[\u007F-\u009F\u2028\u2029\uFEFF]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** Inline code span that survives backticks inside the text. */
function codeSpan(text: string): string {
  const t = singleLine(text);
  const longest = Math.max(0, ...(t.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(longest + 1);
  const pad = t.startsWith("`") || t.endsWith("`") ? " " : "";
  return `${fence}${pad}${t}${pad}${fence}`;
}

/**
 * Prefixes every line with `> `. The text stays verbatim line by line, but it
 * can no longer form headings, rules or front matter of its own.
 */
function blockquote(text: string): string[] {
  return text
    .replace(/\r\n?|\u2028|\u2029|\u0085/g, "\n")
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`));
}

function endSentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function safeUrl(url: string | undefined): string | undefined {
  return url !== undefined && /^https?:\/\/[^\s<>"'`]+$/i.test(url) ? url : undefined;
}

function displayDate(node: MemexNode): string {
  return formatEventDate(node.data) ?? "undated";
}

function authorList(node: MemexNode): string[] {
  const raw: unknown = node.data.authors;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a): a is string => typeof a === "string")
    .map((a) => singleLine(a).trim())
    .filter((a) => a !== "");
}

// ---------------------------------------------------------------------------
// Trail briefing
// ---------------------------------------------------------------------------

export interface BriefingOptions {
  /** `YYYY-MM-DD` written to the front matter. Default: the date of `trail.createdAt`. */
  generatedDate?: string;
}

const CARD_TYPE_LABEL: Record<MemexNode["data"]["cardType"], [string, string]> = {
  note: ["note", "notes"],
  quote: ["quote", "quotes"],
  artifact: ["artifact", "artifacts"],
  ghost: ["ghost card", "ghost cards"],
};

function defaultGeneratedDate(trail: Trail): string {
  const m = /^\d{4}-\d{2}-\d{2}/.exec(trail.createdAt);
  return m ? m[0] : TRAIL_EPOCH.slice(0, 10);
}

/** Cards of the trail in trail order. Unknown ids and repeats are skipped. */
function resolveTrailCards(trail: Trail, nodes: readonly MemexNode[]): MemexNode[] {
  const byId = new Map<string, MemexNode>();
  for (const n of nodes) if (!byId.has(n.id)) byId.set(n.id, n);
  const seen = new Set<string>();
  const cards: MemexNode[] = [];
  for (const id of trail.nodeIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (node) cards.push(node);
  }
  return cards;
}

function topTags(cards: readonly MemexNode[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const c of cards) {
    const own = new Set<string>();
    for (const t of c.data.tags ?? []) {
      const tag = typeof t === "string" ? singleLine(t).trim() : "";
      if (tag !== "") own.add(tag);
    }
    for (const tag of own) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, limit)
    .map(([tag]) => tag);
}

function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Edges that sit inside the trail (both endpoints are trail cards), deduplicated by id. */
function innerEdges(
  cards: readonly MemexNode[],
  edges: readonly AssociativeEdge[],
): AssociativeEdge[] {
  const ids = new Set(cards.map((c) => c.id));
  const seen = new Set<string>();
  const out: AssociativeEdge[] = [];
  for (const e of edges) {
    if (e.data?.discoveryId !== undefined) continue; // display-only ghost synapses
    if (!ids.has(e.source) || !ids.has(e.target)) continue;
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

function arcSection(trail: Trail, cards: readonly MemexNode[], inner: readonly AssociativeEdge[]): string[] {
  const lines = ["## Thematic Arc & Thesis", ""];
  if (cards.length === 0) {
    lines.push("This trail has no resolvable cards, so no thesis can be derived.");
    return lines;
  }
  const years = cards.map((c) => getEventYear(c.data)).filter((y): y is number => y !== null);
  const tags = topTags(cards, 3);
  const n = cards.length;
  const subject = tags.length > 0 ? `${n === 1 ? "covers" : "connect"} ${joinList(tags)}` : n === 1 ? "stands alone" : "form this trail";
  const count = plural(n, "card", "cards");
  if (years.length > 0) {
    const lo = Math.min(...years);
    const hi = Math.max(...years);
    lines.push(
      lo === hi
        ? `In ${lo}, ${count} ${subject}.`
        : `From ${lo} to ${hi}, ${count} ${subject}.`,
    );
  } else {
    lines.push(`${n === 1 ? "1 undated card" : `${n} undated cards`} ${subject}.`);
  }
  lines.push("");
  const label = (c: MemexNode) => {
    const d = formatEventDate(c.data);
    return `"${singleLine(c.data.title)}"${d ? ` (${d})` : ""}`;
  };
  if (n >= 2) {
    lines.push(`- Opens with: ${label(cards[0])}`);
    lines.push(`- Closes with: ${label(cards[n - 1])}`);
  }
  const typeCounts = new Map<string, number>();
  for (const c of cards) typeCounts.set(c.data.cardType, (typeCounts.get(c.data.cardType) ?? 0) + 1);
  const composition = (Object.keys(CARD_TYPE_LABEL) as (keyof typeof CARD_TYPE_LABEL)[])
    .filter((t) => typeCounts.has(t))
    .map((t) => plural(typeCounts.get(t) ?? 0, CARD_TYPE_LABEL[t][0], CARD_TYPE_LABEL[t][1]));
  if (composition.length > 0) lines.push(`- Composition: ${composition.join(", ")}`);
  const refutes = inner.filter((e) => e.data?.polarity === "refutes").length;
  const syntheses = inner.filter((e) => e.data?.polarity === "synthesizes").length;
  if (refutes + syntheses > 0) {
    lines.push(
      `- Dialectical record: ${plural(refutes, "tension (refutes)", "tensions (refutes)")}, ${plural(syntheses, "synthesis", "syntheses")}`,
    );
  }
  const description = singleLine(trail.description).trim();
  if (description !== "") lines.push(`- Trail description: ${description}`);
  return lines;
}

/**
 * Markdown research briefing for one trail.
 *
 * Structure: YAML front matter (title, generatedDate, trailId, cardCount),
 * then the sections "Thematic Arc & Thesis", "Chronological Lineage",
 * "Empirical Evidence & Quotations", "Dialectical Tensions" and
 * "Archival Bibliography". Trail ids that point at missing cards are skipped
 * (and counted in `missingCards`); `cardCount` is the number of cards listed.
 *
 * Untrusted text: front matter values are double-quoted YAML scalars; titles,
 * tags and rationales are forced onto one line; card content is emitted as a
 * block quote, so it cannot add headings, rules or front matter. Every listed
 * card's archival ID and title appear verbatim.
 */
export function generateTrailBriefing(
  trail: Trail,
  nodes: readonly MemexNode[],
  edges: readonly AssociativeEdge[],
  options: BriefingOptions = {},
): string {
  const cards = resolveTrailCards(trail, nodes);
  const missing = new Set(trail.nodeIds).size - cards.length;
  const generatedDate = options.generatedDate ?? defaultGeneratedDate(trail);
  const inner = innerEdges(cards, edges);
  const out: string[] = [
    "---",
    `title: ${yamlQuote(trail.title)}`,
    `generatedDate: ${yamlQuote(generatedDate)}`,
    `trailId: ${yamlQuote(trail.id)}`,
    `cardCount: ${cards.length}`,
    ...(missing > 0 ? [`missingCards: ${missing}`] : []),
    "---",
    "",
    "# Executive Research Briefing",
    "",
    `**Trail:** ${singleLine(trail.title)}`,
    "",
    ...arcSection(trail, cards, inner),
    "",
    "## Chronological Lineage",
    "",
  ];

  // Lineage: every card in trail order.
  if (cards.length === 0) out.push("_This trail has no resolvable cards._", "");
  const pairEdge = (a: MemexNode, b: MemexNode) =>
    inner.find((e) => (e.source === a.id && e.target === b.id) || (e.source === b.id && e.target === a.id));
  cards.forEach((card, i) => {
    out.push(`### ${i + 1}. ${singleLine(card.data.title)}`, "");
    out.push(`- Archival ID: ${codeSpan(card.data.archivalId)}`);
    if (card.id !== card.data.archivalId) out.push(`- Card ID: ${codeSpan(card.id)}`);
    out.push(`- Date: ${displayDate(card)}`);
    out.push(`- Type: ${card.data.cardType}`);
    const tags = (card.data.tags ?? []).map((t) => singleLine(String(t)).trim()).filter((t) => t !== "");
    if (tags.length > 0) out.push(`- Tags: ${tags.join(", ")}`);
    if (card.data.source) out.push(`- Source: ${singleLine(card.data.source)}`);
    const next = cards[i + 1];
    if (next) {
      const link = pairEdge(card, next);
      if (link) {
        const rationale = singleLine(link.data?.rationale ?? "").trim();
        out.push(
          `- Link to next stop: ${getEdgePolarity(link)} (${link.data?.origin ?? "human"})${rationale ? `. ${rationale}` : ""}`,
        );
      } else {
        out.push("- Link to next stop: none recorded");
      }
    }
    out.push("");
    if (card.data.content !== "") out.push(...blockquote(card.data.content), "");
  });

  // Evidence: quote and artifact cards.
  out.push("## Empirical Evidence & Quotations", "");
  const evidence = cards.filter((c) => c.data.cardType === "quote" || c.data.cardType === "artifact");
  if (evidence.length === 0) out.push("_No quote or artifact cards in this trail._", "");
  for (const card of evidence) {
    const kind = card.data.cardType === "quote" ? "Quote" : "Artifact";
    out.push(`### ${kind}: ${singleLine(card.data.title)}`, "");
    out.push(`- Archival ID: ${codeSpan(card.data.archivalId)}`);
    out.push(`- Date: ${displayDate(card)}`, "");
    if (card.data.content !== "") out.push(...blockquote(card.data.content), "");
  }

  // Tensions: refutes edges inside the trail.
  out.push("## Dialectical Tensions", "");
  const position = new Map(cards.map((c, i) => [c.id, i]));
  const byId = new Map(cards.map((c) => [c.id, c]));
  const tensions = inner
    .filter((e) => e.data?.polarity === "refutes")
    .sort(
      (a, b) =>
        (position.get(a.source) ?? 0) - (position.get(b.source) ?? 0) ||
        (position.get(a.target) ?? 0) - (position.get(b.target) ?? 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  if (tensions.length === 0) {
    out.push('- None recorded: no "refutes" links connect cards in this trail.', "");
  }
  for (const e of tensions) {
    const a = byId.get(e.source);
    const b = byId.get(e.target);
    if (!a || !b) continue;
    out.push(
      `- **${singleLine(a.data.title)}** (${codeSpan(a.data.archivalId)}) ≠ **${singleLine(b.data.title)}** (${codeSpan(b.data.archivalId)})`,
    );
    const rationale = singleLine(e.data?.rationale ?? "").trim();
    out.push(`  - Rationale: ${rationale !== "" ? rationale : "none recorded"}`, "");
  }

  // Bibliography.
  out.push("## Archival Bibliography", "");
  if (cards.length === 0) out.push("_No cards to cite._", "");
  cards.forEach((card, i) => {
    const authors = authorList(card);
    const year = getEventYear(card.data);
    const url = safeUrl(card.data.pdfUrl);
    const parts = [
      authors.length > 0 ? authors.join(", ") : "",
      year !== null ? `(${year}).` : "",
      endSentence(singleLine(card.data.title)),
      card.data.source ? endSentence(singleLine(card.data.source)) : "",
      url ?? "",
      `[Memex archival ID: ${singleLine(card.data.archivalId)}]`,
    ].filter((p) => p !== "");
    out.push(`${i + 1}. ${parts.join(" ")}`);
  });
  out.push("");
  return out.join("\n");
}

/** `memex-briefing-<trailId>.md` with the id reduced to filename-safe characters. */
export function briefingFilename(trailId: string): string {
  const safe = trailId
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80);
  return `memex-briefing-${safe === "" ? "trail" : safe}.md`;
}

// ---------------------------------------------------------------------------
// BibTeX
// ---------------------------------------------------------------------------

/**
 * Escapes the BibTeX/LaTeX special characters `{ } \ & % $ # _ ^ ~` and turns
 * control characters and line breaks into spaces. Braces in the result are
 * always balanced.
 */
export function escapeBibTeX(text: string): string {
  let out = "";
  for (const ch of text.replace(/[\u0000-\u001F\u007F\u0085\u2028\u2029]+/g, " ")) {
    switch (ch) {
      case "\\":
        out += "\\textbackslash{}";
        break;
      case "^":
        out += "\\textasciicircum{}";
        break;
      case "~":
        out += "\\textasciitilde{}";
        break;
      case "{":
      case "}":
      case "&":
      case "%":
      case "$":
      case "#":
      case "_":
        out += `\\${ch}`;
        break;
      default:
        out += ch;
    }
  }
  return out;
}

/** Cite key: the archival ID reduced to `[A-Za-z0-9_:-]` (other characters become `_`). */
export function bibtexKey(archivalId: string): string {
  const key = archivalId.replace(/[^A-Za-z0-9_:-]/g, "_");
  return key === "" ? "memex" : key;
}

const JOURNAL_LIKE = /\b(journal|transactions|review|letters|quarterly|monthly|magazine)\b/i;

/** URL for a `url = {...}` field: http(s) only, with characters that would unbalance braces percent-encoded. */
function bibtexUrl(url: string | undefined): string | undefined {
  const u = safeUrl(url);
  return u?.replace(/[{}\\]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * BibTeX entry for a card. `@article` when the source is an arXiv or
 * journal-like reference, otherwise `@misc`. The cite key derives from the
 * archival ID; the archival ID is always recorded in `note`. Output is
 * syntactically valid: entry type, key, comma-separated `name = {value}`
 * fields and balanced braces.
 */
export function generateBibTeX(node: MemexNode): string {
  const d = node.data;
  const source = typeof d.source === "string" ? singleLine(d.source).trim() : "";
  const arxivMatch = /^arxiv:\s*(.+)$/i.exec(source);
  const arxivId = arxivMatch ? parseArxivId(arxivMatch[1]) : undefined;
  const isArticle = /^arxiv:/i.test(source) || (source !== "" && JOURNAL_LIKE.test(source));
  const fields: string[] = [`  title = {{${escapeBibTeX(d.title)}}}`];
  const authors = authorList(node);
  if (authors.length > 0) fields.push(`  author = {${authors.map(escapeBibTeX).join(" and ")}}`);
  if (isArticle) {
    fields.push(
      `  journal = {${escapeBibTeX(arxivId !== undefined ? `arXiv preprint arXiv:${arxivId}` : source)}}`,
    );
  } else if (source !== "") {
    fields.push(`  howpublished = {${escapeBibTeX(source)}}`);
  }
  const year = getEventYear(d);
  if (year !== null) fields.push(`  year = {${year}}`);
  if (arxivId !== undefined) {
    fields.push(`  eprint = {${escapeBibTeX(arxivId)}}`, "  archivePrefix = {arXiv}");
  }
  const url = bibtexUrl(d.pdfUrl);
  if (url !== undefined) fields.push(`  url = {${url}}`);
  fields.push(`  note = {Memex archival ID: ${escapeBibTeX(d.archivalId)}}`);
  return `@${isArticle ? "article" : "misc"}{${bibtexKey(d.archivalId)},\n${fields.join(",\n")}\n}`;
}
