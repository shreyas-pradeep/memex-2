import { getEdgePolarity, singleLine, yamlQuote } from "./synthesis-engine";
import { createZip } from "./zip";
import type { AssociativeEdge, MemexNode } from "./types";

/**
 * Obsidian vault export (Spec 09): one Markdown file per card, YAML front
 * matter, and bidirectional `[[wikilinks]]` for every edge. Pure and
 * deterministic: files are ordered by card id and the archive timestamp is an
 * option.
 */

export interface ObsidianFile {
  /** Relative path inside the archive, e.g. `Memex Vault/As We May Think.md`. */
  path: string;
  content: string;
}

export interface ObsidianExportOptions {
  /** Top-level folder inside the archive (default `Memex Vault`). Must be a plain name. */
  folder?: string;
  /** ISO timestamp stored for every file (default 1980-01-01T00:00:00Z). */
  modified?: string;
}

export const OBSIDIAN_FOLDER = "Memex Vault";
export const OBSIDIAN_NAME_MAX = 100;
const RESERVED_WINDOWS = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A file name (without extension) that is safe in Obsidian and on every OS:
 * `/ \ :` become `-`; `* ? " < > | # ^ [ ]`, control and bidi characters are
 * removed; whitespace is collapsed; leading and trailing dots and spaces are
 * trimmed; reserved Windows names (`CON`, `NUL`, `COM1`...) get a `_`; the
 * length is capped at 100 characters (never splitting a character). Never
 * empty (`fallback`, then `Untitled`), never contains a path separator or `..`.
 */
export function sanitizeObsidianFilename(title: string, fallback: string = "Untitled"): string {
  const clean = (text: string): string => {
    const s = text
      .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
      .replace(/[\\/:]/g, "-")
      .replace(/[*?"<>|#^[\]]/g, "")
      .replace(/\s+/g, " ")
      .replace(/^[\s.]+|[\s.]+$/g, "");
    const capped = Array.from(s).slice(0, OBSIDIAN_NAME_MAX).join("").replace(/^[\s.]+|[\s.]+$/g, "");
    return RESERVED_WINDOWS.test(capped) ? `${capped}_` : capped;
  };
  const name = clean(title);
  if (name !== "") return name;
  const alt = clean(fallback);
  return alt !== "" ? alt : "Untitled";
}

/** Card id to unique file name (no extension). Cards sorted by id; the lowest id keeps the plain name. */
function assignNames(cards: readonly MemexNode[]): Map<string, string> {
  const names = new Map<string, string>();
  const used = new Set<string>();
  const claim = (name: string): boolean => {
    const key = name.toLowerCase();
    if (used.has(key)) return false;
    used.add(key);
    return true;
  };
  for (const card of [...cards].sort((a, b) => cmp(a.id, b.id))) {
    if (names.has(card.id)) continue;
    const base = sanitizeObsidianFilename(card.data.title, card.data.archivalId);
    let name = base;
    if (!claim(name)) {
      const tag = sanitizeObsidianFilename(card.data.archivalId, card.id);
      name = `${base} (${tag})`;
      for (let k = 2; !claim(name); k++) name = `${base} (${tag}) ${k}`;
    }
    names.set(card.id, name);
  }
  return names;
}

/** Plain-text escape for rationales: no wikilinks, tags, HTML, emphasis, math or comments can form. */
export function escapeObsidianText(text: string): string {
  return singleLine(text)
    .replace(/[\\[\]|<>#*_`~$&]/g, "\\$&")
    .replace(/==/g, "\\=\\=")
    .replace(/%%/g, "\\%\\%")
    .replace(/\s+/g, " ")
    .trim();
}

function frontMatter(card: MemexNode): string[] {
  const d = card.data;
  const lines = ["---", `title: ${yamlQuote(d.title)}`, `archivalId: ${yamlQuote(d.archivalId)}`, `type: ${d.cardType}`];
  if (typeof d.year === "number" && Number.isFinite(d.year)) lines.push(`year: ${Math.trunc(d.year)}`);
  if (d.date !== undefined) lines.push(`date: ${yamlQuote(d.date)}`);
  if (d.tags.length === 0) lines.push("tags: []");
  else lines.push("tags:", ...d.tags.map((t) => `  - ${yamlQuote(t)}`));
  if (d.source !== undefined) lines.push(`source: ${yamlQuote(d.source)}`);
  if (d.authors !== undefined && d.authors.length > 0) {
    lines.push("authors:", ...d.authors.map((a) => `  - ${yamlQuote(a)}`));
  }
  if (d.pdfUrl !== undefined) lines.push(`pdfUrl: ${yamlQuote(d.pdfUrl)}`);
  if (d.cassetteId !== undefined) lines.push(`cassette: ${yamlQuote(d.cassetteId)}`);
  if (d.cassetteTitle !== undefined) lines.push(`cassetteTitle: ${yamlQuote(d.cassetteTitle)}`);
  lines.push(`createdAt: ${yamlQuote(d.createdAt)}`, "---");
  return lines;
}

interface LinkLine {
  name: string;
  out: boolean;
  edgeId: string;
  text: string;
}

/**
 * Markdown files for a set of cards. Each file holds the front matter, the card
 * content verbatim and an "Associative Links" section. For every edge between
 * two present cards, BOTH cards get a `[[wikilink]]` to the other, with the
 * polarity and the rationale as escaped plain text; `→` marks the card the
 * edge leaves, `←` the card it arrives at. Edges that name a missing card, and
 * self-loops, are skipped. A card without links gets a placeholder line.
 */
export function buildObsidianFiles(
  cards: readonly MemexNode[],
  edges: readonly AssociativeEdge[],
  options: Pick<ObsidianExportOptions, "folder"> = {},
): ObsidianFile[] {
  const folder = sanitizeObsidianFilename(options.folder ?? OBSIDIAN_FOLDER, OBSIDIAN_FOLDER);
  const names = assignNames(cards);
  const links = new Map<string, LinkLine[]>();
  for (const e of edges) {
    const from = names.get(e.source);
    const to = names.get(e.target);
    if (from === undefined || to === undefined || e.source === e.target) continue;
    const rationale = escapeObsidianText(e.data?.rationale ?? "");
    const tail = ` · ${getEdgePolarity(e)}${rationale === "" ? "" : ` · ${rationale}`}`;
    const add = (cardId: string, line: LinkLine) => links.set(cardId, [...(links.get(cardId) ?? []), line]);
    add(e.source, { name: to, out: true, edgeId: e.id, text: `- → [[${to}]]${tail}` });
    add(e.target, { name: from, out: false, edgeId: e.id, text: `- ← [[${from}]]${tail}` });
  }

  const seen = new Set<string>();
  const files: ObsidianFile[] = [];
  for (const card of [...cards].sort((a, b) => cmp(a.id, b.id))) {
    if (seen.has(card.id)) continue;
    seen.add(card.id);
    const own = [...(links.get(card.id) ?? [])].sort(
      (a, b) =>
        cmp(a.name.toLowerCase(), b.name.toLowerCase()) ||
        Number(b.out) - Number(a.out) ||
        cmp(a.edgeId, b.edgeId),
    );
    const content = [
      ...frontMatter(card),
      "",
      card.data.content,
      "",
      "## Associative Links",
      "",
      ...(own.length > 0 ? own.map((l) => l.text) : ["_No associative links yet._"]),
      "",
    ].join("\n");
    files.push({ path: `${folder}/${names.get(card.id)}.md`, content });
  }
  return files;
}

/** The vault as a ZIP archive (STORE, UTF-8 names). Throws for an archive the writer cannot represent. */
export async function exportObsidianVaultZip(
  cards: readonly MemexNode[],
  edges: readonly AssociativeEdge[],
  options: ObsidianExportOptions = {},
): Promise<Blob> {
  const encoder = new TextEncoder();
  const entries = buildObsidianFiles(cards, edges, options).map((f) => ({
    path: f.path,
    data: encoder.encode(f.content),
  }));
  const bytes = createZip(entries, { modified: options.modified });
  return new Blob([bytes], { type: "application/zip" });
}
