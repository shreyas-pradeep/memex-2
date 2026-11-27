import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";
import {
  bibtexKey,
  briefingFilename,
  cyclePolarity,
  escapeBibTeX,
  generateBibTeX,
  generateTrailBriefing,
  getEdgePolarity,
  yamlQuote,
} from "../synthesis-engine";
import { deserializeGraph, serializeGraph, toggleEdgePolarity } from "../graph-engine";
import type {
  AssociativeEdge,
  EdgePolarity,
  MemexCardType,
  MemexGraphState,
  MemexNode,
  Trail,
} from "../types";
import { demoSeed } from "@/data/demo-seed";
import { useMemexStore } from "@/store/useMemexStore";

const RUNS = { numRuns: 200 };
const POLARITIES: EdgePolarity[] = ["supports", "refutes", "synthesizes"];

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Characters that stress Markdown, YAML and BibTeX, plus unicode. No line breaks or control characters. */
const SPECIAL = [
  "-", "---", ":", "#", "*", "_", "[", "]", "{", "}", '"', "'", "`", "|", ">", "\\", "&", "%", "$",
  "~", "^", " ", "é", "漢", "😀", "—", "…", "\u00A0",
];
const textArb = fc.string({
  unit: fc.oneof(fc.constantFrom(...SPECIAL), fc.constantFrom("a", "B", "z", "0", "9")),
  maxLength: 40,
});
const titleArb = textArb;
const cardTypeArb = fc.constantFrom<MemexCardType>("note", "quote", "artifact", "ghost");

const nodeAt = (i: number, title: string, cardType: MemexCardType, content: string, year?: number): MemexNode => ({
  id: `card-${i}`,
  type: "memexCard",
  position: { x: i * 10, y: 0 },
  data: {
    archivalId: `MEM-2000-${String(i).padStart(4, "0")}`,
    title,
    content,
    cardType,
    tags: [],
    createdAt: "2000-01-01T00:00:00.000Z",
    ...(year !== undefined ? { year } : {}),
  },
});

const nodesArb = fc.array(
  fc.record({
    title: titleArb,
    cardType: cardTypeArb,
    content: fc.string({ maxLength: 80 }),
    year: fc.option(fc.integer({ min: 1800, max: 2100 }), { nil: undefined }),
  }),
  { minLength: 0, maxLength: 8 },
).map((rows) => rows.map((r, i) => nodeAt(i, r.title, r.cardType, r.content, r.year)));

const edgeFor = (
  i: number,
  source: string,
  target: string,
  polarity: EdgePolarity | undefined,
  rationale: string,
): AssociativeEdge => ({
  id: `e-${i}`,
  source,
  target,
  type: "associative",
  data: { origin: "human", rationale, strength: 0.5, ...(polarity ? { polarity } : {}) },
});

// ---------------------------------------------------------------------------
// P1: briefing contains every trail card's id and title
// ---------------------------------------------------------------------------

describe("P1: generateTrailBriefing", () => {
  it("contains the archival ID, card ID and title of every trail card, with and without refutes edges", () => {
    fc.assert(
      fc.property(
        nodesArb,
        fc.array(fc.tuple(fc.nat(7), fc.nat(7), fc.constantFrom<EdgePolarity | undefined>(undefined, ...POLARITIES), textArb), {
          maxLength: 8,
        }),
        fc.array(fc.nat(7), { maxLength: 8 }),
        fc.boolean(),
        (nodes, rawEdges, picks, withMissing) => {
          const edges = rawEdges
            .filter(([a, b]) => a < nodes.length && b < nodes.length && a !== b)
            .map(([a, b, p, r], i) => edgeFor(i, nodes[a].id, nodes[b].id, p, r));
          const chosen = [...new Set(picks.filter((i) => i < nodes.length))].map((i) => nodes[i]);
          const trail: Trail = {
            id: "t-1",
            title: "A trail",
            description: "",
            origin: "human",
            nodeIds: [...chosen.map((n) => n.id), ...(withMissing ? ["gone"] : [])],
            createdAt: "2000-01-01T00:00:00.000Z",
          };
          const md = generateTrailBriefing(trail, nodes, edges, { generatedDate: "2026-01-02" });
          for (const n of chosen) {
            expect(md).toContain(n.data.archivalId);
            expect(md).toContain(n.id);
            expect(md).toContain(n.data.title);
          }
          expect(md).toContain(`cardCount: ${chosen.length}`);
          // Fixed structure regardless of content.
          expect(md.split("\n").filter((l) => l.startsWith("## "))).toEqual([
            "## Thematic Arc & Thesis",
            "## Chronological Lineage",
            "## Empirical Evidence & Quotations",
            "## Dialectical Tensions",
            "## Archival Bibliography",
          ]);
        },
      ),
      RUNS,
    );
  });

  it("is deterministic and keeps front matter parseable for any trail title and id", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 30 }), fc.string({ maxLength: 30 }), (title, id) => {
        const trail: Trail = { id, title, description: "", origin: "human", nodeIds: [], createdAt: "x" };
        const md = generateTrailBriefing(trail, [], [], { generatedDate: "2026-01-02" });
        expect(generateTrailBriefing(trail, [], [], { generatedDate: "2026-01-02" })).toBe(md);
        const lines = md.split("\n");
        expect(lines[0]).toBe("---");
        const close = lines.indexOf("---", 1);
        expect(close).toBe(5); // title, generatedDate, trailId, cardCount between the fences
        expect(JSON.parse(lines[1].slice("title: ".length))).toBe(title);
        expect(JSON.parse(lines[3].slice("trailId: ".length))).toBe(id);
        expect(lines[4]).toBe("cardCount: 0");
      }),
      RUNS,
    );
  });
});

describe("briefing structure and safety", () => {
  const trail: Trail = {
    id: "t-x",
    title: 'Evil "title"\n---\n# injected',
    description: "line one\n## fake heading",
    origin: "human",
    nodeIds: ["a", "b", "ghost-missing", "a"],
    createdAt: "2026-01-02T09:00:00.000Z",
  };
  const nodes: MemexNode[] = [
    nodeAt(1, "First\n# Heading", "quote", "---\n# Not a heading\n## Dialectical Tensions\n---", 1945),
    nodeAt(2, "Second", "artifact", "plain", 2026),
  ].map((n, i) => ({ ...n, id: ["a", "b"][i] }));

  it("neutralizes hostile card text and reports missing cards", () => {
    const md = generateTrailBriefing(trail, nodes, [], { generatedDate: "2026-01-02" });
    const lines = md.split("\n");
    // Front matter: exactly one closing fence, then no bare `---` anywhere else.
    expect(lines.filter((l) => l === "---")).toHaveLength(2);
    expect(lines.filter((l) => l.startsWith("# "))).toEqual(["# Executive Research Briefing"]);
    expect(lines.filter((l) => l.startsWith("## "))).toHaveLength(5);
    expect(md).toContain("cardCount: 2");
    expect(md).toContain("missingCards: 1");
    expect(md).toContain("> ---");
  });

  it("handles empty trails and trails whose cards are all missing", () => {
    const empty: Trail = { ...trail, nodeIds: [] };
    const md = generateTrailBriefing(empty, nodes, []);
    expect(md).toContain("cardCount: 0");
    expect(md).toContain("no resolvable cards");
    expect(md).toContain("None recorded");
    const allMissing = generateTrailBriefing({ ...trail, nodeIds: ["x", "y"] }, nodes, []);
    expect(allMissing).toContain("cardCount: 0");
    expect(allMissing).toContain("missingCards: 2");
  });

  it("lists only refutes edges whose both endpoints are in the trail", () => {
    const t: Trail = { ...trail, title: "T", nodeIds: ["a", "b"] };
    const all = [...nodes, { ...nodeAt(3, "Outside", "note", ""), id: "c" }];
    const edges = [
      edgeFor(1, "a", "b", "refutes", "They disagree on scope."),
      edgeFor(2, "a", "b", "supports", "ignored"),
      edgeFor(3, "b", "c", "refutes", "outside the trail"),
    ];
    const md = generateTrailBriefing(t, all, edges);
    const tensions = md.split("\n## Dialectical Tensions\n")[1].split("\n## Archival Bibliography\n")[0];
    expect(tensions).toContain("They disagree on scope.");
    expect(tensions).not.toContain("outside the trail");
    expect(tensions).not.toContain("None recorded");
    expect(generateTrailBriefing(t, all, edges.slice(1))).toContain("None recorded");
  });

  it("builds the arc only from the trail's own cards", () => {
    const t: Trail = { ...trail, title: "T", description: "", nodeIds: ["a", "b"] };
    const tagged = nodes.map((n) => ({ ...n, data: { ...n.data, tags: ["memex", "hci"] } }));
    const md = generateTrailBriefing(t, tagged, []);
    expect(md).toContain("From 1945 to 2026, 2 cards connect hci and memex.");
  });

  it("names filenames safely", () => {
    expect(briefingFilename("trail-evolution")).toBe("memex-briefing-trail-evolution.md");
    expect(briefingFilename("../../etc/passwd")).toBe("memex-briefing-etc-passwd.md");
    expect(briefingFilename("///")).toBe("memex-briefing-trail.md");
    expect(briefingFilename("a".repeat(300)).length).toBeLessThanOrEqual("memex-briefing-.md".length + 80);
  });

  it("yamlQuote round-trips through JSON for any string", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 40 }), (s) => {
        const q = yamlQuote(s);
        expect(q).not.toMatch(/[\n\r\u2028\u2029]/);
        expect(JSON.parse(q)).toBe(s);
      }),
      RUNS,
    );
  });
});

describe("demo seed briefing", () => {
  it("is deterministic and matches the snapshot (no network)", () => {
    const trail = demoSeed.trails[0];
    const a = generateTrailBriefing(trail, demoSeed.nodes, demoSeed.edges, { generatedDate: "2026-01-02" });
    const b = generateTrailBriefing(trail, demoSeed.nodes, demoSeed.edges, { generatedDate: "2026-01-02" });
    expect(a).toBe(b);
    for (const id of trail.nodeIds) expect(a).toContain(id);
    expect(a).toContain("cardCount: 5");
    expect(a).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// P2: BibTeX is syntactically valid
// ---------------------------------------------------------------------------

/** Independent escape for strings that hold no control characters. */
function expectedEscape(text: string): string {
  const map: Record<string, string> = {
    "\\": "\\textbackslash{}",
    "^": "\\textasciicircum{}",
    "~": "\\textasciitilde{}",
    "{": "\\{",
    "}": "\\}",
    "&": "\\&",
    "%": "\\%",
    $: "\\$",
    "#": "\\#",
    _: "\\_",
  };
  return [...text].map((c) => map[c] ?? c).join("");
}

interface ParsedBib {
  type: string;
  key: string;
  fields: Map<string, string>;
}

/** Strict validator: `@type{key,` then `name = {value}` fields separated by commas, then `}`. */
function parseBibTeX(entry: string): ParsedBib {
  const head = /^@(article|misc)\{([A-Za-z0-9_:-]+),\n/.exec(entry);
  if (!head) throw new Error("bad entry head");
  let i = head[0].length;
  const fields = new Map<string, string>();
  const skipWs = () => {
    while (i < entry.length && /\s/.test(entry[i])) i++;
  };
  for (;;) {
    skipWs();
    const name = /^[a-zA-Z]+/.exec(entry.slice(i));
    if (!name) throw new Error(`field name expected at ${i}`);
    i += name[0].length;
    skipWs();
    if (entry[i++] !== "=") throw new Error("= expected");
    skipWs();
    if (entry[i] !== "{") throw new Error("{ expected");
    const start = i;
    let depth = 0;
    for (; i < entry.length; i++) {
      const c = entry[i];
      if (c === "\\") {
        i++; // escaped character, including \{ and \}
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        i++;
        break;
      }
    }
    if (depth !== 0) throw new Error("unbalanced braces");
    fields.set(name[0], entry.slice(start, i));
    skipWs();
    if (entry[i] === ",") {
      i++;
      continue;
    }
    if (entry[i] === "}" && i === entry.length - 1) return { type: head[1], key: head[2], fields };
    throw new Error(`unexpected character at ${i}`);
  }
}

const sourceArb = fc.option(
  fc.oneof(
    fc.constantFrom("arXiv:1706.03762", "arXiv:cs/0112017v2", "arXiv:not-an-id", "Journal of Memory & Language"),
    textArb,
  ),
  { nil: undefined },
);

const bibNodeArb = fc
  .record({
    title: textArb,
    archivalId: fc.string({ minLength: 1, maxLength: 20, unit: fc.oneof(fc.constantFrom(...SPECIAL), fc.constantFrom("M", "E", "1")) }),
    authors: fc.option(fc.array(textArb, { maxLength: 4 }), { nil: undefined }),
    source: sourceArb,
    pdfUrl: fc.option(
      fc.oneof(fc.constant("https://arxiv.org/pdf/1706.03762"), fc.constant("https://x.org/a{b}c\\d%20"), textArb),
      { nil: undefined },
    ),
    year: fc.option(fc.integer({ min: 1800, max: 2100 }), { nil: undefined }),
  })
  .map(
    (r): MemexNode => ({
      id: "n",
      type: "memexCard",
      position: { x: 0, y: 0 },
      data: {
        archivalId: r.archivalId,
        title: r.title,
        content: "",
        cardType: "note",
        tags: [],
        createdAt: "2000-01-01T00:00:00.000Z",
        ...(r.authors ? { authors: r.authors } : {}),
        ...(r.source !== undefined ? { source: r.source } : {}),
        ...(r.pdfUrl !== undefined ? { pdfUrl: r.pdfUrl } : {}),
        ...(r.year !== undefined ? { year: r.year } : {}),
      },
    }),
  );

describe("P2: generateBibTeX", () => {
  it("is syntactically valid and contains the escaped title and archival ID", () => {
    fc.assert(
      fc.property(bibNodeArb, (node) => {
        const bib = generateBibTeX(node);
        const parsed = parseBibTeX(bib);
        expect(["article", "misc"]).toContain(parsed.type);
        expect(parsed.key).toMatch(/^[A-Za-z0-9_:-]+$/);
        expect(parsed.key).toBe(bibtexKey(node.data.archivalId));
        expect(parsed.fields.get("title")).toBe(`{{${expectedEscape(node.data.title)}}}`);
        expect(parsed.fields.get("note")).toContain(expectedEscape(node.data.archivalId));
        if (node.data.year !== undefined) expect(parsed.fields.get("year")).toBe(`{${node.data.year}}`);
        // Deterministic.
        expect(generateBibTeX(node)).toBe(bib);
      }),
      RUNS,
    );
  });

  it("uses @article with eprint fields for arXiv cards and @misc otherwise", () => {
    const base = fc.sample(bibNodeArb, 1)[0];
    const arxiv: MemexNode = {
      ...base,
      data: {
        ...base.data,
        title: "Attention Is All You Need",
        archivalId: "MEM-2017-04",
        source: "arXiv:1706.03762",
        pdfUrl: "https://arxiv.org/pdf/1706.03762",
        authors: ["Ashish Vaswani", "Noam Shazeer"],
        year: 2017,
      },
    };
    const parsed = parseBibTeX(generateBibTeX(arxiv));
    expect(parsed.type).toBe("article");
    expect(parsed.key).toBe("MEM-2017-04");
    expect(parsed.fields.get("eprint")).toBe("{1706.03762}");
    expect(parsed.fields.get("archivePrefix")).toBe("{arXiv}");
    expect(parsed.fields.get("url")).toBe("{https://arxiv.org/pdf/1706.03762}");
    expect(parsed.fields.get("author")).toBe("{Ashish Vaswani and Noam Shazeer}");
    const plain: MemexNode = { ...arxiv, data: { ...arxiv.data, source: undefined, pdfUrl: undefined } };
    delete plain.data.source;
    delete plain.data.pdfUrl;
    expect(parseBibTeX(generateBibTeX(plain)).type).toBe("misc");
  });

  it("escapes special characters and line breaks", () => {
    expect(escapeBibTeX("a{b}c\\d&e%f$g#h_i^j~k")).toBe(
      "a\\{b\\}c\\textbackslash{}d\\&e\\%f\\$g\\#h\\_i\\textasciicircum{}j\\textasciitilde{}k",
    );
    expect(escapeBibTeX("two\nlines\r\n")).toBe("two lines ");
    expect(bibtexKey("MEM 1945/01")).toBe("MEM_1945_01");
    expect(bibtexKey("")).toBe("memex");
  });
});

// ---------------------------------------------------------------------------
// P3: polarity cycle and store toggle
// ---------------------------------------------------------------------------

describe("P3: cyclePolarity", () => {
  it("is a 3-cycle over the polarities, with undefined counting as supports", () => {
    const starts: (EdgePolarity | undefined)[] = [undefined, ...POLARITIES];
    fc.assert(
      fc.property(fc.constantFrom(...starts), (p) => {
        const norm = p ?? "supports";
        const once = cyclePolarity(p);
        expect(once).not.toBe(norm);
        expect(cyclePolarity(cyclePolarity(cyclePolarity(p)))).toBe(norm);
      }),
      RUNS,
    );
    expect(new Set(POLARITIES.map((p) => cyclePolarity(p)))).toEqual(new Set(POLARITIES));
    expect(cyclePolarity(undefined)).toBe("refutes");
    expect(cyclePolarity("supports")).toBe("refutes");
    expect(cyclePolarity("refutes")).toBe("synthesizes");
    expect(cyclePolarity("synthesizes")).toBe("supports");
  });

  it("treats unknown stored values as supports", () => {
    expect(cyclePolarity("bogus" as EdgePolarity)).toBe("refutes");
    expect(getEdgePolarity({ data: { polarity: "bogus" as EdgePolarity } })).toBe("supports");
    expect(getEdgePolarity(undefined)).toBe("supports");
  });
});

describe("P3: toggleEdgePolarity", () => {
  beforeEach(() => useMemexStore.getState().resetToSeed());

  it("pure: advances only the targeted edge by one cycle step", () => {
    const state: MemexGraphState = demoSeed;
    fc.assert(
      fc.property(fc.nat(state.edges.length - 1), fc.integer({ min: 0, max: 7 }), (index, times) => {
        const target = state.edges[index];
        let next = state;
        let expected: EdgePolarity | undefined = target.data?.polarity;
        for (let k = 0; k < times; k++) {
          next = toggleEdgePolarity(next, target.id);
          expected = cyclePolarity(expected);
        }
        expect(getEdgePolarity(next.edges[index])).toBe(expected ?? "supports");
        next.edges.forEach((e, i) => {
          if (i !== index) expect(e).toBe(state.edges[i]);
          else expect(e.data?.origin).toBe(target.data?.origin);
        });
        expect(state.edges[index].data?.polarity).toBe(target.data?.polarity); // input untouched
      }),
      RUNS,
    );
    expect(toggleEdgePolarity(state, "no-such-edge")).toBe(state);
  });

  it("store: applies the cycle to real edges, persists through export/import, ignores unknown ids", () => {
    fc.assert(
      fc.property(fc.nat(demoSeed.edges.length - 1), fc.integer({ min: 1, max: 7 }), (index, times) => {
        useMemexStore.getState().resetToSeed();
        const before = useMemexStore.getState().edges;
        const id = before[index].id;
        let expected: EdgePolarity | undefined = before[index].data?.polarity;
        for (let k = 0; k < times; k++) {
          useMemexStore.getState().toggleEdgePolarity(id);
          expected = cyclePolarity(expected);
        }
        const after = useMemexStore.getState().edges;
        expect(after[index].data?.polarity).toBe(expected);
        const exported = useMemexStore.getState().exportJson();
        expect(deserializeGraph(exported).edges[index].data?.polarity).toBe(expected);
        // Deterministic JSON: re-serializing the exported graph is byte-identical.
        expect(serializeGraph(deserializeGraph(exported))).toBe(exported);
        useMemexStore.getState().toggleEdgePolarity("no-such-edge");
        expect(useMemexStore.getState().edges).toBe(after);
      }),
      RUNS,
    );
  });
});

describe("persistence of new optional fields", () => {
  it("round-trips source, pdfUrl, authors and polarity; legacy graphs still load", () => {
    const node = nodeAt(1, "Paper", "note", "x", 2017);
    node.data.source = "arXiv:1706.03762";
    node.data.pdfUrl = "https://arxiv.org/pdf/1706.03762";
    node.data.authors = ["A", "B"];
    const state: MemexGraphState = {
      nodes: [node, nodeAt(2, "Other", "note", "y")],
      edges: [edgeFor(1, "card-1", "card-2", "refutes", "r")],
      trails: [],
      ghostDiscoveries: [],
    };
    const back = deserializeGraph(serializeGraph(state));
    expect(back).toEqual(state);
    const legacy = deserializeGraph(serializeGraph(demoSeed));
    expect(legacy.edges.every((e) => getEdgePolarity(e) === "supports")).toBe(true);
  });
});
