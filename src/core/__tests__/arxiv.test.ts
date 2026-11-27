import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  applyArxivMetadata,
  buildArxivQueryUrl,
  isArxivPaper,
  isDoiLike,
  parseArxivAtom,
  parseArxivId,
} from "../arxiv";
import { distillSourceText } from "../ingestion-engine";

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="html">ArXiv Query: search_query=&amp;id_list=1706.03762</title>
  <id>http://arxiv.org/api/abc</id>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <updated>2023-08-02T00:41:18Z</updated>
    <published>2017-06-12T17:57:34Z</published>
    <title>Attention Is All
  You Need</title>
    <summary>  The dominant sequence transduction models &amp; more.
  We propose the Transformer, &lt;b&gt;based&lt;/b&gt; on attention &amp;amp; nothing else. &#945; &#x3B2;
    </summary>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name><arxiv:affiliation xmlns:arxiv="http://arxiv.org/schemas/atom">Google</arxiv:affiliation></author>
    <link href="http://arxiv.org/abs/1706.03762v7" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/1706.03762v7" rel="related" type="application/pdf"/>
  </entry>
</feed>`;

const ERROR_FEED = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
<id>http://arxiv.org/api/errors#incorrect_id_format_for_1234</id>
<title>Error</title><summary>incorrect id format</summary></entry></feed>`;

describe("parseArxivId", () => {
  it.each([
    ["1706.03762", "1706.03762"],
    [" 1706.03762v5 ", "1706.03762v5"],
    ["arXiv:1706.03762", "1706.03762"],
    ["ARXIV: 1706.03762v2", "1706.03762v2"],
    ["0704.0001", "0704.0001"],
    ["cs/0112017", "cs/0112017"],
    ["hep-th/9901001v2", "hep-th/9901001v2"],
    ["math.GT/0309136", "math.GT/0309136"],
    ["arXiv:cs/0112017", "cs/0112017"],
    ["https://arxiv.org/abs/1706.03762", "1706.03762"],
    ["http://arxiv.org/abs/1706.03762v5", "1706.03762v5"],
    ["https://www.arxiv.org/pdf/1706.03762.pdf", "1706.03762"],
    ["https://arxiv.org/pdf/1706.03762v1.pdf?download=1#x", "1706.03762v1"],
    ["https://arxiv.org/abs/cs/0112017", "cs/0112017"],
    ["https://export.arxiv.org/abs/1706.03762/", "1706.03762"],
  ])("accepts %s", (input, expected) => {
    expect(parseArxivId(input)).toBe(expected);
  });

  it.each([
    "",
    "   ",
    "1706.376",
    "1706.037621",
    "1713.03762",
    "1700.03762",
    "17063.03762",
    "1706.03762v0",
    "1706.03762v",
    "1706.03762 extra",
    "cs/012017",
    "CS/0112017",
    "/0112017",
    "https://evil.com/abs/1706.03762",
    "https://arxiv.org.evil.com/abs/1706.03762",
    "https://arxiv.org@evil.com/abs/1706.03762",
    "https://arxiv.org/list/1706.03762",
    "javascript:alert(1)",
    "../../etc/passwd",
    "1706.03762&id_list=other",
    "1706.03762;rm -rf",
    "10.1000/xyz123",
    "a".repeat(500),
  ])("rejects %j", (input) => {
    expect(parseArxivId(input)).toBeUndefined();
  });

  it("returns only canonical ids that round-trip, for arbitrary input", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (s) => {
        const id = parseArxivId(s);
        if (id !== undefined) {
          expect(id).toMatch(/^[A-Za-z0-9./-]+$/);
          expect(parseArxivId(id)).toBe(id);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("recognizes DOIs without resolving them", () => {
    expect(isDoiLike("10.1145/3292500.3330701")).toBe(true);
    expect(isDoiLike("doi:10.1000/xyz")).toBe(true);
    expect(isDoiLike("https://doi.org/10.1000/xyz")).toBe(true);
    expect(isDoiLike("1706.03762")).toBe(false);
    expect(parseArxivId("10.1145/3292500.3330701")).toBeUndefined();
  });

  it("builds a fixed-host query URL for canonical ids only", () => {
    expect(buildArxivQueryUrl("1706.03762")).toBe(
      "https://export.arxiv.org/api/query?id_list=1706.03762&max_results=1",
    );
    expect(buildArxivQueryUrl("cs/0112017")).toBe(
      "https://export.arxiv.org/api/query?id_list=cs%2F0112017&max_results=1",
    );
    expect(() => buildArxivQueryUrl("https://evil.com")).toThrow();
    expect(() => buildArxivQueryUrl("arXiv:1706.03762")).toThrow();
  });
});

describe("parseArxivAtom", () => {
  it("extracts title, authors, year, abstract, id and pdf link, decoding entities once", () => {
    const r = parseArxivAtom(FEED);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.paper).toEqual({
      title: "Attention Is All You Need",
      authors: ["Ashish Vaswani", "Noam Shazeer"],
      year: 2017,
      abstract:
        "The dominant sequence transduction models & more. We propose the Transformer, <b>based</b> on attention &amp; nothing else. α β",
      arxivId: "1706.03762v7",
      pdfUrl: "https://arxiv.org/pdf/1706.03762v7",
    });
  });

  it("treats arXiv's Error entry and empty feeds as not-found", () => {
    expect(parseArxivAtom(ERROR_FEED)).toEqual({ kind: "not-found" });
    expect(
      parseArxivAtom('<feed xmlns="http://www.w3.org/2005/Atom"><title>x</title></feed>'),
    ).toEqual({ kind: "not-found" });
  });

  it("flags non-Atom or broken input as malformed and never throws", () => {
    for (const bad of ["", "<html></html>", "not xml", "<feed><entry><title>t</title>", "<feed><entry><id>x</id><title>t</title></entry></feed>"]) {
      expect(parseArxivAtom(bad)).toEqual({ kind: "malformed" });
    }
    fc.assert(fc.property(fc.string({ maxLength: 200 }), (s) => void parseArxivAtom(s)), { numRuns: 300 });
  });

  it("replaces a foreign pdf link with the canonical arxiv.org URL and ignores out-of-range dates", () => {
    const tweaked = FEED.replace("http://arxiv.org/pdf/1706.03762v7", "https://evil.example/x.pdf").replace(
      "2017-06-12",
      "1066-06-12",
    );
    const r = parseArxivAtom(tweaked);
    expect(r.kind === "ok" && r.paper.pdfUrl).toBe("https://arxiv.org/pdf/1706.03762v7");
    expect(r.kind === "ok" && r.paper.year).toBeUndefined();
  });

  it("does not decode invalid numeric entities", () => {
    const r = parseArxivAtom(FEED.replace("&#945;", "&#1114112;"));
    expect(r.kind === "ok" && r.paper.abstract).toContain("&#1114112;");
  });
});

describe("paper guard and card stamping", () => {
  const paper = {
    title: "Attention Is All You Need",
    authors: ["A", "B"],
    year: 2017,
    abstract: "We propose the Transformer, based solely on attention mechanisms. It is 2.5x faster.",
    arxivId: "1706.03762",
    pdfUrl: "https://arxiv.org/pdf/1706.03762",
  };

  it("validates response bodies", () => {
    expect(isArxivPaper(paper)).toBe(true);
    expect(isArxivPaper({ ...paper, year: undefined })).toBe(true);
    expect(isArxivPaper({ ...paper, arxivId: "bad" })).toBe(false);
    expect(isArxivPaper({ ...paper, pdfUrl: "javascript:alert(1)" })).toBe(false);
    expect(isArxivPaper({ ...paper, authors: [1] })).toBe(false);
    expect(isArxivPaper(null)).toBe(false);
  });

  it("stamps every card with source, pdfUrl, authors and the authoritative year", () => {
    const { nodes } = distillSourceText(paper.title, `${paper.abstract} Published 1999.`, { x: 0, y: 0 });
    expect(nodes.length).toBeGreaterThan(0);
    const stamped = applyArxivMetadata(nodes, paper);
    for (const n of stamped) {
      expect(n.data.source).toBe("arXiv:1706.03762");
      expect(n.data.pdfUrl).toBe(paper.pdfUrl);
      expect(n.data.authors).toEqual(["A", "B"]);
      expect(n.data.year).toBe(2017);
    }
    expect(nodes[0].data.source).toBeUndefined(); // input untouched
    const noYear = applyArxivMetadata(nodes, { ...paper, year: undefined });
    expect(noYear[0].data.year).toBe(nodes[0].data.year);
  });
});
