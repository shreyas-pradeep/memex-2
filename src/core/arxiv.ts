import type { MemexNode } from "./types";

/**
 * Pure arXiv helpers: strict id parsing, a defensive Atom extractor and the
 * metadata stamp for ingested cards. No network, no React, no XML dependency.
 */

/** The only upstream the resolver ever contacts. */
export const ARXIV_QUERY_URL = "https://export.arxiv.org/api/query";

export interface ArxivPaper {
  title: string;
  authors: string[];
  /** Publication year of the first version; absent when the feed has no valid date. */
  year?: number;
  abstract: string;
  /** Canonical id, as requested (with the version when one was given). */
  arxivId: string;
  /** https link to the PDF on arxiv.org. */
  pdfUrl: string;
}

// ---------------------------------------------------------------------------
// Id parsing
// ---------------------------------------------------------------------------

const VERSION = "(?:v[1-9][0-9]{0,2})?";
/** `YYMM.NNNN` (to 2014) or `YYMM.NNNNN` (from 2015); month 01 to 12. */
const NEW_STYLE = new RegExp(`^[0-9]{2}(?:0[1-9]|1[0-2])\\.[0-9]{4,5}${VERSION}$`);
/** `archive/YYMMNNN`, e.g. `cs/0112017`, `hep-th/9901001`, `math.GT/0309136`. */
const OLD_STYLE = new RegExp(
  `^[a-z]+(?:-[a-z]+)*(?:\\.[A-Za-z]{2})?\\/[0-9]{2}(?:0[1-9]|1[0-2])[0-9]{3}${VERSION}$`,
);
const ARXIV_URL =
  /^https?:\/\/(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf)\/([^?#\s]+?)(?:\.pdf)?\/?(?:[?#].*)?$/i;
const MAX_INPUT_CHARS = 200;

/**
 * Normalizes a user-supplied arXiv reference to its canonical id, or returns
 * `undefined`. Accepts `1706.03762`, `1706.03762v5`, `arXiv:1706.03762`,
 * `cs/0112017`, and `abs`/`pdf` URLs on arxiv.org (http or https, optional
 * `.pdf`, query or fragment). Everything else, including other hosts, is
 * rejected by anchored regular expressions.
 */
export function parseArxivId(input: string): string | undefined {
  if (typeof input !== "string") return undefined;
  const text = input.trim();
  if (text === "" || text.length > MAX_INPUT_CHARS) return undefined;
  let candidate = text;
  const url = ARXIV_URL.exec(text);
  if (url) {
    candidate = url[1];
  } else {
    const prefixed = /^arxiv:\s*(.+)$/i.exec(text);
    if (prefixed) candidate = prefixed[1].trim();
  }
  return NEW_STYLE.test(candidate) || OLD_STYLE.test(candidate) ? candidate : undefined;
}

/** True for input that looks like a DOI (`10.1000/xyz`, `doi:...`, `https://doi.org/...`). */
export function isDoiLike(input: string): boolean {
  return /^(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)?10\.\d{4,9}\/\S+$/i.test(input.trim());
}

/** Upstream query URL for a canonical id. Throws unless `id` is exactly what `parseArxivId` returns. */
export function buildArxivQueryUrl(id: string): string {
  if (parseArxivId(id) !== id) throw new Error("Invalid arXiv id");
  const query = new URLSearchParams({ id_list: id, max_results: "1" });
  return `${ARXIV_QUERY_URL}?${query.toString()}`;
}

// ---------------------------------------------------------------------------
// Atom parsing
// ---------------------------------------------------------------------------

export type ArxivParseResult =
  | { kind: "ok"; paper: ArxivPaper }
  | { kind: "not-found" }
  | { kind: "malformed" };

const MAX_TITLE = 500;
const MAX_ABSTRACT = 10_000;
const MAX_AUTHORS = 100;
const MAX_AUTHOR_CHARS = 200;

function decodeEntities(text: string): string {
  // One pass, so `&amp;lt;` becomes `&lt;` and never `<`.
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/g, (match, body: string) => {
    switch (body) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
    }
    const code = body[1] === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    const valid = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
    return valid ? String.fromCodePoint(code) : match;
  });
}

/** Element text: nested tags removed, entities decoded, whitespace collapsed. */
function textOf(inner: string): string {
  return decodeEntities(inner.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

function firstElement(xml: string, name: string): string | undefined {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? m[1] : undefined;
}

function attributesOf(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of tag.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attrs[m[1]] = decodeEntities(m[2] ?? m[3] ?? "");
  }
  return attrs;
}

function firstEntry(xml: string): string | null | undefined {
  if (!/<feed[\s>]/.test(xml)) return undefined; // not an Atom feed
  const match = /<entry[\s>]/.exec(xml);
  if (!match) return null; // a feed without entries
  const end = xml.indexOf("</entry>", match.index);
  return end === -1 ? undefined : xml.slice(match.index, end);
}

const ARXIV_PDF_URL = /^https?:\/\/(?:www\.|export\.)?arxiv\.org\/pdf\/[^\s"'<>]+$/i;

/**
 * Extracts the first `<entry>` of an arXiv Atom response. Tolerant by design:
 * it reads only the few elements it needs and never throws. An entry titled
 * "Error" (arXiv's answer to a bad id) and a feed without entries are
 * `not-found`; anything that is not an Atom feed with a titled entry is
 * `malformed`.
 */
export function parseArxivAtom(xml: string): ArxivParseResult {
  const entry = typeof xml === "string" ? firstEntry(xml) : undefined;
  if (entry === undefined) return { kind: "malformed" };
  if (entry === null) return { kind: "not-found" };
  const rawId = textOf(firstElement(entry, "id") ?? "");
  const title = textOf(firstElement(entry, "title") ?? "");
  if (title === "Error" || /arxiv\.org\/api\/errors/i.test(rawId)) return { kind: "not-found" };
  if (title === "") return { kind: "malformed" };
  const idMatch = /^https?:\/\/arxiv\.org\/abs\/(.+)$/i.exec(rawId);
  const arxivId = parseArxivId(idMatch ? idMatch[1] : rawId);
  if (arxivId === undefined) return { kind: "malformed" };

  const authors: string[] = [];
  for (const m of entry.matchAll(/<author(?:\s[^>]*)?>([\s\S]*?)<\/author>/g)) {
    const name = textOf(firstElement(m[1], "name") ?? "").slice(0, MAX_AUTHOR_CHARS);
    if (name !== "") authors.push(name);
    if (authors.length >= MAX_AUTHORS) break;
  }

  const published = /^(\d{4})-\d{2}-\d{2}/.exec(textOf(firstElement(entry, "published") ?? ""));
  const yearValue = published ? Number(published[1]) : NaN;
  const year = yearValue >= 1991 && yearValue <= 2100 ? yearValue : undefined;

  let pdfHref: string | undefined;
  for (const m of entry.matchAll(/<link\b([^>]*)>/g)) {
    const attrs = attributesOf(m[1]);
    if (attrs.title === "pdf" || attrs.type === "application/pdf") {
      pdfHref = attrs.href;
      break;
    }
  }
  const pdfUrl =
    pdfHref !== undefined && ARXIV_PDF_URL.test(pdfHref)
      ? pdfHref.replace(/^http:/i, "https:")
      : `https://arxiv.org/pdf/${arxivId}`;

  return {
    kind: "ok",
    paper: {
      title: title.slice(0, MAX_TITLE),
      authors,
      ...(year !== undefined ? { year } : {}),
      abstract: textOf(firstElement(entry, "summary") ?? "").slice(0, MAX_ABSTRACT),
      arxivId,
      pdfUrl,
    },
  };
}

/** Type guard for the route's JSON body, applied by the client before use. */
export function isArxivPaper(value: unknown): value is ArxivPaper {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.title === "string" &&
    v.title !== "" &&
    Array.isArray(v.authors) &&
    v.authors.every((a) => typeof a === "string") &&
    (v.year === undefined || (typeof v.year === "number" && Number.isInteger(v.year))) &&
    typeof v.abstract === "string" &&
    typeof v.arxivId === "string" &&
    parseArxivId(v.arxivId) === v.arxivId &&
    typeof v.pdfUrl === "string" &&
    ARXIV_PDF_URL.test(v.pdfUrl)
  );
}

/**
 * Stamps cards distilled from a resolved paper with its citation metadata:
 * `source` (`arXiv:<id>`), `pdfUrl`, `authors` (when known) and the
 * authoritative published `year`, which overrides the text heuristic.
 */
export function applyArxivMetadata(nodes: readonly MemexNode[], paper: ArxivPaper): MemexNode[] {
  return nodes.map((n) => ({
    ...n,
    data: {
      ...n.data,
      source: `arXiv:${paper.arxivId}`,
      pdfUrl: paper.pdfUrl,
      ...(paper.authors.length > 0 ? { authors: [...paper.authors] } : {}),
      ...(paper.year !== undefined ? { year: paper.year } : {}),
    },
  }));
}
