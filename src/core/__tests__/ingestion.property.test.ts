import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  MAX_SOURCE_BYTES,
  MAX_TAGS,
  MIN_CENTER_DISTANCE,
  distillSourceText,
  extractPublicationYear,
  extractTags,
  parsePastedText,
  parseSourceFile,
  pickIngestionBase,
  stripMarkdown,
} from "../ingestion-engine";
import type { MemexNode } from "../types";

const RUNS = { numRuns: 300 };

const anyText = fc.oneof(fc.string({ maxLength: 400 }), fc.string({ unit: "binary", maxLength: 200 }), fc.constant(""));
const sourceText = fc.oneof(
  anyText,
  fc
    .array(fc.oneof(fc.lorem({ maxCount: 12 }), fc.constantFrom("“Memory is a trail of associations.”", "It runs 3.2x faster at 91% accuracy.", "| a | b |\n| 1 | 2 |")), {
      maxLength: 8,
    })
    .map((p) => p.join(". ")),
);
const base = fc.record({
  x: fc.double({ min: -1e7, max: 1e7, noNaN: true }),
  y: fc.double({ min: -1e7, max: 1e7, noNaN: true }),
});

const center = (n: MemexNode) => ({ x: n.position.x + CARD_WIDTH / 2, y: n.position.y + CARD_HEIGHT / 2 });

describe("P1: extractPublicationYear", () => {
  it("returns an integer in [1890, 2026] or undefined for arbitrary strings", () => {
    fc.assert(
      fc.property(fc.oneof(anyText, fc.string({ unit: "grapheme" })), (s) => {
        const y = extractPublicationYear(s);
        expect(y === undefined || (Number.isInteger(y) && y >= 1890 && y <= 2026)).toBe(true);
      }),
      RUNS,
    );
  });

  it("finds an embedded in-range year and rejects out-of-range ones", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1890, max: 2026 }), fc.constantFrom("published", "In", "(", "©"), (year, ctx) => {
        const text = ctx === "(" ? `Paper (${year}) text` : `${ctx} ${year} text`;
        expect(extractPublicationYear(text)).toBe(year);
      }),
      RUNS,
    );
    fc.assert(
      fc.property(
        fc.oneof(fc.integer({ min: 1000, max: 1889 }), fc.integer({ min: 2027, max: 9999 })),
        (year) => {
          expect(extractPublicationYear(`Published in ${year}.`)).toBeUndefined();
        },
      ),
      RUNS,
    );
  });

  it("ignores longer numbers and decimals", () => {
    expect(extractPublicationYear("id 12345 and 19450")).toBeUndefined();
    expect(extractPublicationYear("value 1945.5 here")).toBeUndefined();
    expect(extractPublicationYear("1,945,000 units")).toBeUndefined();
    expect(extractPublicationYear("Intro. In 1968 Engelbart. Later 2001.")).toBe(1968);
  });
});

describe("P2: radial placement", () => {
  it("keeps centers >= 380px apart with no overlapping boxes", () => {
    fc.assert(
      fc.property(sourceText, base, (text, b) => {
        const { nodes } = distillSourceText("T", text, b);
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const a = center(nodes[i]);
            const c = center(nodes[j]);
            const dx = Math.abs(a.x - c.x);
            const dy = Math.abs(a.y - c.y);
            expect(Math.hypot(dx, dy)).toBeGreaterThanOrEqual(MIN_CENTER_DISTANCE);
            expect(Math.hypot(dx, dy)).toBeGreaterThan(320);
            expect(dx >= CARD_WIDTH || dy >= CARD_HEIGHT).toBe(true);
          }
        }
      }),
      RUNS,
    );
  });

  it("places new clusters clear of existing cards", () => {
    fc.assert(
      fc.property(
        fc.array(base, { minLength: 1, maxLength: 6 }),
        sourceText,
        (positions, text) => {
          const existing: MemexNode[] = positions.map((p, i) => ({
            id: `e${i}`,
            type: "memexCard",
            position: { x: p.x / 1e4, y: p.y / 1e4 },
            style: { width: CARD_WIDTH, height: CARD_HEIGHT },
            data: { archivalId: `MEM-1945-${i}`, title: "t", content: "c", cardType: "note", tags: [], createdAt: "x" },
          }));
          const maxRight = Math.max(...existing.map((n) => n.position.x + CARD_WIDTH));
          const { nodes } = distillSourceText("T", text, pickIngestionBase(existing));
          for (const n of nodes) expect(n.position.x).toBeGreaterThan(maxRight);
        },
      ),
      RUNS,
    );
  });
});

describe("P3: distillation validity", () => {
  it("always yields a valid note, unique non-empty ids, string tags and sane edges", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), sourceText, (title, text) => {
        const { nodes, edges } = distillSourceText(title, text, { x: 0, y: 0 });
        expect(nodes.filter((n) => n.data.cardType === "note")).toHaveLength(1);
        const ids = nodes.map((n) => n.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(new Set(nodes.map((n) => n.data.archivalId)).size).toBe(nodes.length);
        for (const n of nodes) {
          expect(n.id).not.toBe("");
          expect(n.data.title.trim()).not.toBe("");
          expect(Array.isArray(n.data.tags)).toBe(true);
          expect(n.data.tags.every((t) => typeof t === "string")).toBe(true);
          expect(n.data.tags.length).toBeLessThanOrEqual(MAX_TAGS);
          const y = n.data.year;
          expect(y === undefined || (y >= 1890 && y <= 2026)).toBe(true);
        }
        const known = new Set(ids);
        for (const e of edges) {
          expect(known.has(e.source) && known.has(e.target)).toBe(true);
          expect(e.source).not.toBe(e.target);
          expect(e.data!.strength).toBeGreaterThanOrEqual(0);
          expect(e.data!.strength).toBeLessThanOrEqual(1);
        }
        expect(new Set(edges.map((e) => e.id)).size).toBe(edges.length);
      }),
      RUNS,
    );
  });

  it("never collides with existing ids and is deterministic", () => {
    fc.assert(
      fc.property(sourceText, (text) => {
        const first = distillSourceText("T", text, { x: 0, y: 0 });
        expect(distillSourceText("T", text, { x: 0, y: 0 })).toEqual(first);
        const taken = first.nodes.map((n) => n.id);
        const second = distillSourceText("T", text, { x: 0, y: 0 }, { existingIds: taken });
        for (const n of second.nodes) expect(taken).not.toContain(n.id);
      }),
      RUNS,
    );
  });

  it("extractTags is sorted, unique, capped and deterministic", () => {
    fc.assert(
      fc.property(sourceText, (text) => {
        const tags = extractTags(text);
        expect(tags).toEqual(extractTags(text));
        expect(tags).toEqual([...new Set(tags)].sort());
        expect(tags.length).toBeLessThanOrEqual(MAX_TAGS);
      }),
      RUNS,
    );
  });

  it("parsers never throw", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), anyText, (name, text) => {
        for (const r of [parseSourceFile(name, text), parseSourceFile(`${name}.json`, text), parsePastedText(name, text)]) {
          expect(typeof r.ok).toBe("boolean");
        }
        expect(typeof stripMarkdown(text)).toBe("string");
      }),
      RUNS,
    );
  });
});

describe("unit: parsing and distillation", () => {
  it("strips markdown and takes the first heading as the title", () => {
    const r = parseSourceFile(
      "paper.md",
      "# As We May Think\n\nSee **bold** and [a link](http://x.y) and `code`.\n\n```js\nlet a = 1;\n```\n- item one\n> quoted",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.title).toBe("As We May Think");
    expect(r.text).toContain("See bold and a link and code.");
    expect(r.text).not.toMatch(/[*`#\[\]>]|http/);
    expect(r.text).toContain("item one");
  });

  it("reads txt using the file name as title", () => {
    const r = parseSourceFile("my_notes-1945.TXT", "Hello world.");
    expect(r).toEqual({ ok: true, title: "my notes 1945", text: "Hello world.", format: "txt" });
  });

  it("parses json strings, objects and arrays", () => {
    const str = parseSourceFile("a.json", JSON.stringify("plain abstract"));
    expect(str.ok && str.text).toBe("plain abstract");
    const obj = parseSourceFile("a.json", JSON.stringify({ title: "T1", abstract: "Abs.", body: "Body." }));
    expect(obj.ok && obj.title).toBe("T1");
    expect(obj.ok && obj.text).toBe("Abs.\n\nBody.");
    const arr = parseSourceFile("a.json", JSON.stringify([{ title: "A", text: "One." }, { content: "Two." }]));
    expect(arr.ok && arr.text).toContain("Two.");
    const other = parseSourceFile("a.json", JSON.stringify({ k: "v", n: 3 }));
    expect(other.ok && other.text).toBe("k: v\nn: 3");
  });

  it("returns errors instead of throwing", () => {
    expect(parseSourceFile("a.json", "{oops")).toMatchObject({ ok: false, code: "malformed-json" });
    expect(parseSourceFile("a.pdf", "x")).toMatchObject({ ok: false, code: "unsupported-type" });
    expect(parseSourceFile("noext", "x")).toMatchObject({ ok: false, code: "unsupported-type" });
    expect(parseSourceFile("a.txt", "  \n ")).toMatchObject({ ok: false, code: "empty" });
    expect(parsePastedText("t", "")).toMatchObject({ ok: false, code: "empty" });
    expect(parseSourceFile("a.txt", "x".repeat(MAX_SOURCE_BYTES + 1))).toMatchObject({ ok: false, code: "too-large" });
    expect(parseSourceFile("a.txt", "é".repeat(MAX_SOURCE_BYTES / 2 + 1))).toMatchObject({ ok: false, code: "too-large" });
    expect(parseSourceFile("a.txt", "x".repeat(MAX_SOURCE_BYTES)).ok).toBe(true);
  });

  it("distills a note, quotations and an artifact with the detected year", () => {
    const text =
      "Published in 1968. Engelbart demonstrated the mouse and hypertext links to an audience. " +
      'He said “The augmentation of human intellect is our goal.” The system was 3x faster and 91% accurate.';
    const { nodes, edges } = distillSourceText("Mother of All Demos", text, { x: 0, y: 0 });
    expect(nodes.map((n) => n.data.cardType)).toEqual(["note", "quote", "artifact"]);
    expect(nodes[1].data.content).toBe("“The augmentation of human intellect is our goal.”");
    expect(nodes[2].data.content).toContain("91%");
    expect(nodes.every((n) => n.data.year === 1968)).toBe(true);
    expect(nodes[0].data.tags).toContain("hypertext");
    expect(edges).toHaveLength(2);
    expect(edges[0].source).toBe(nodes[0].id);
  });

  it("falls back to Untitled Source for empty input", () => {
    const { nodes, edges } = distillSourceText("", "   ", { x: 5, y: 5 });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].data.title).toBe("Untitled Source");
    expect(edges).toHaveLength(0);
  });
});
