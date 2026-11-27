import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { demoSeed } from "@/data/demo-seed";
import { scoreGhostPairs } from "../ghost-engine";
import { deserializeGraph, serializeGraph } from "../graph-engine";
import {
  AUTO_TRAIL_MAX_STEPS,
  AUTO_TRAIL_PREFIX,
  DEBATE_TITLE,
  LINEAGE_TITLE,
  NEXUS_MIN_AFFINITY,
  NEXUS_TITLE,
  autoTrailId,
  autoTrailKind,
  bisectionOrder,
  chooseWeaveTrail,
  clampMaxSteps,
  generateAutoTrails,
  hashIds,
  isDuplicateTrail,
  selectLineageCards,
  type AutoTrailKind,
} from "../trail-genesis";
import { TRAIL_EPOCH, getEventYear } from "../trail-engine";
import type {
  AssociativeEdge,
  EdgePolarity,
  GhostDiscovery,
  MemexNode,
  Trail,
} from "../types";

const RUNS = { numRuns: 200 };

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

interface CardSpec {
  prefix: string;
  year: number | null;
  date: string | null;
  titleWords: string[];
  tags: string[];
  created: number;
}

const WORDS = [
  "memory", "retrieval", "hypertext", "graph", "attention", "latent", "spatial", "archive",
  "trail", "radar", "banana", "zebra", "memex", "interface",
];

function makeNode(spec: CardSpec, index: number): MemexNode {
  const id = `${spec.prefix}-${index}`;
  return {
    id,
    type: "memexCard",
    position: { x: index * 10, y: 0 },
    data: {
      archivalId: id,
      title: `Card ${id} ${spec.titleWords.join(" ")}`,
      content: spec.titleWords.join(" "),
      cardType: "note",
      tags: spec.tags,
      createdAt: `2020-01-0${spec.created}T00:00:00.000Z`,
      ...(spec.year !== null ? { year: spec.year } : {}),
      ...(spec.year === null && spec.date !== null ? { date: spec.date } : {}),
    },
  };
}

const cardSpec: fc.Arbitrary<CardSpec> = fc.record({
  prefix: fc.constantFrom("a", "m", "z"),
  year: fc.option(fc.integer({ min: 1900, max: 2030 }), { nil: null }),
  date: fc.option(fc.constantFrom("1950", "1960-05", "2001-12-31", "not-a-date"), { nil: null }),
  titleWords: fc.array(fc.constantFrom(...WORDS), { maxLength: 4 }),
  tags: fc.array(fc.constantFrom(...WORDS), { maxLength: 3 }),
  created: fc.integer({ min: 1, max: 5 }),
});

const nodesArb = fc
  .array(cardSpec, { minLength: 0, maxLength: 14 })
  .map((specs) => specs.map(makeNode));

function edgeOf(
  source: string,
  target: string,
  polarity?: EdgePolarity,
  index = 0,
): AssociativeEdge {
  return {
    id: `e${index}-${source}-${target}`,
    source,
    target,
    type: "associative",
    data: { origin: "human", rationale: "", strength: 0.5, ...(polarity ? { polarity } : {}) },
  };
}

/** Random edges between existing cards (polarity optional). */
function edgesFor(
  nodes: readonly MemexNode[],
  polarities: readonly (EdgePolarity | undefined)[],
): fc.Arbitrary<AssociativeEdge[]> {
  if (nodes.length < 2) return fc.constant([]);
  return fc
    .array(
      fc.record({
        a: fc.integer({ min: 0, max: nodes.length - 1 }),
        b: fc.integer({ min: 0, max: nodes.length - 1 }),
        polarity: fc.constantFrom(...polarities),
      }),
      { maxLength: 12 },
    )
    .map((list) =>
      list.map((e, i) => edgeOf(nodes[e.a].id, nodes[e.b].id, e.polarity, i)),
    );
}

const graphArb = nodesArb.chain((nodes) =>
  fc.record({
    nodes: fc.constant(nodes),
    edges: edgesFor(nodes, [undefined, "supports", "refutes", "synthesizes"]),
    order: fc.array(fc.nat(), { minLength: nodes.length, maxLength: nodes.length }),
  }),
);

function shuffled<T>(items: readonly T[], keys: readonly number[]): T[] {
  return items
    .map((item, i) => ({ item, key: keys[i] ?? 0, i }))
    .sort((a, b) => a.key - b.key || a.i - b.i)
    .map((x) => x.item);
}

function kindOf(trail: Trail): AutoTrailKind {
  const kind = autoTrailKind(trail.id);
  if (kind === null) throw new Error(`not an auto trail id: ${trail.id}`);
  return kind;
}

const OPTIONS = { createdAt: "2026-02-03T04:05:06.000Z" } as const;

// ---------------------------------------------------------------------------
// Property 1 to 3 (required)
// ---------------------------------------------------------------------------

describe("Property 1: no duplicate card ids inside a generated trail", () => {
  it("never repeats an id, so never two identical consecutive ids", () => {
    fc.assert(
      fc.property(graphArb, ({ nodes, edges }) => {
        for (const trail of generateAutoTrails(nodes, edges, [], OPTIONS)) {
          for (let i = 1; i < trail.nodeIds.length; i++) {
            expect(trail.nodeIds[i]).not.toBe(trail.nodeIds[i - 1]);
          }
          expect(new Set(trail.nodeIds).size).toBe(trail.nodeIds.length);
        }
      }),
      RUNS,
    );
  });
});

describe("Property 2: a Lineage Arc is monotonic by year", () => {
  it("lists dated cards only, with non-decreasing years, whatever the input order", () => {
    fc.assert(
      fc.property(graphArb, ({ nodes, edges, order }) => {
        const input = shuffled(nodes, order);
        const byId = new Map(nodes.map((n) => [n.id, n]));
        for (const trail of generateAutoTrails(input, edges, [], OPTIONS)) {
          if (kindOf(trail) !== "lineage") continue;
          const years = trail.nodeIds.map((id) => getEventYear((byId.get(id) as MemexNode).data));
          for (const y of years) expect(y).not.toBeNull();
          for (let i = 1; i < years.length; i++) {
            expect(years[i] as number).toBeGreaterThanOrEqual(years[i - 1] as number);
          }
        }
      }),
      RUNS,
    );
  });

  it("keeps the order monotonic when more than eight cards are dated", () => {
    const specs = fc.array(
      fc.record({
        prefix: fc.constantFrom("a", "m", "z"),
        year: fc.integer({ min: 1900, max: 2030 }),
        date: fc.constant(null),
        titleWords: fc.constant([] as string[]),
        tags: fc.constant([] as string[]),
        created: fc.integer({ min: 1, max: 5 }),
      }),
      { minLength: 9, maxLength: 20 },
    );
    fc.assert(
      fc.property(specs, (list) => {
        const nodes = list.map(makeNode);
        const byId = new Map(nodes.map((n) => [n.id, n]));
        const lineage = generateAutoTrails(nodes, [], [], OPTIONS).find((t) => kindOf(t) === "lineage");
        expect(lineage).toBeDefined();
        const ids = (lineage as Trail).nodeIds;
        expect(ids).toHaveLength(8);
        const years = ids.map((id) => getEventYear((byId.get(id) as MemexNode).data) as number);
        for (let i = 1; i < years.length; i++) expect(years[i]).toBeGreaterThanOrEqual(years[i - 1]);
        // The first and the last dated card are always kept.
        const sorted = [...nodes].sort(
          (a, b) =>
            (a.data.year as number) - (b.data.year as number) ||
            (a.data.createdAt < b.data.createdAt ? -1 : a.data.createdAt > b.data.createdAt ? 1 : 0) ||
            (a.id < b.id ? -1 : 1),
        );
        expect(ids[0]).toBe(sorted[0].id);
        expect(ids[ids.length - 1]).toBe(sorted[sorted.length - 1].id);
      }),
      RUNS,
    );
  });
});

describe("Property 3: every trail has 3 to min(nodes, 8) valid cards", () => {
  it("references only cards that exist, within the size bounds, with ghost origin", () => {
    fc.assert(
      fc.property(graphArb, ({ nodes, edges }) => {
        const known = new Set(nodes.map((n) => n.id));
        for (const trail of generateAutoTrails(nodes, edges, [], OPTIONS)) {
          expect(trail.nodeIds.length).toBeGreaterThanOrEqual(3);
          expect(trail.nodeIds.length).toBeLessThanOrEqual(Math.min(nodes.length, AUTO_TRAIL_MAX_STEPS));
          for (const id of trail.nodeIds) expect(known.has(id)).toBe(true);
          expect(trail.origin).toBe("ghost");
          expect(trail.id).toMatch(/^t-auto-(lineage|debate|nexus)-[0-9a-f]{8}$/);
          expect(trail.title.length).toBeGreaterThan(0);
          expect(trail.description.length).toBeGreaterThan(0);
        }
      }),
      RUNS,
    );
  });

  it("honours a smaller maxSteps (clamped to 3..8)", () => {
    fc.assert(
      fc.property(graphArb, fc.integer({ min: -2, max: 12 }), ({ nodes, edges }, maxSteps) => {
        const cap = clampMaxSteps(maxSteps);
        for (const trail of generateAutoTrails(nodes, edges, [], { ...OPTIONS, maxSteps })) {
          expect(trail.nodeIds.length).toBeLessThanOrEqual(cap);
          expect(trail.nodeIds.length).toBeGreaterThanOrEqual(3);
        }
      }),
      RUNS,
    );
    expect(clampMaxSteps(undefined)).toBe(8);
    expect(clampMaxSteps(Number.NaN)).toBe(8);
    expect(clampMaxSteps(1)).toBe(3);
    expect(clampMaxSteps(99)).toBe(8);
    expect(clampMaxSteps(5.9)).toBe(5);
  });

  it("returns [] for fewer than three cards", () => {
    fc.assert(
      fc.property(fc.array(cardSpec, { maxLength: 2 }), (specs) => {
        expect(generateAutoTrails(specs.map(makeNode), [], [], OPTIONS)).toEqual([]);
      }),
      RUNS,
    );
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("determinism and input-order independence", () => {
  it("gives the same trails for any ordering of nodes, edges and discoveries", () => {
    fc.assert(
      fc.property(graphArb, fc.array(fc.nat(), { maxLength: 14 }), ({ nodes, edges, order }, edgeOrder) => {
        const discoveries: GhostDiscovery[] = nodes.slice(0, -1).map((n, i) => ({
          id: `gd-${n.id}`,
          sourceId: n.id,
          targetId: nodes[i + 1].id,
          rationale: "r",
          confidence: 0.9,
          discoveredAt: "2026-01-01T00:00:00.000Z",
        }));
        const a = generateAutoTrails(nodes, edges, discoveries, OPTIONS);
        const b = generateAutoTrails(shuffled(nodes, order), shuffled(edges, edgeOrder), [...discoveries].reverse(), OPTIONS);
        expect(b).toEqual(a);
        expect(generateAutoTrails(nodes, edges, discoveries, OPTIONS)).toEqual(a);
      }),
      RUNS,
    );
  });

  it("derives createdAt from the trail's own cards when none is given (newest card)", () => {
    fc.assert(
      fc.property(graphArb, ({ nodes, edges }) => {
        const byId = new Map(nodes.map((n) => [n.id, n]));
        for (const trail of generateAutoTrails(nodes, edges, [])) {
          const newest = trail.nodeIds
            .map((id) => (byId.get(id) as MemexNode).data.createdAt)
            .reduce((m, c) => (c > m ? c : m), "");
          expect(trail.createdAt).toBe(newest === "" ? TRAIL_EPOCH : newest);
        }
      }),
      RUNS,
    );
  });

  it("does not mutate its inputs", () => {
    fc.assert(
      fc.property(graphArb, ({ nodes, edges }) => {
        const before = JSON.stringify({ nodes, edges });
        generateAutoTrails(nodes, edges, [], OPTIONS);
        expect(JSON.stringify({ nodes, edges })).toBe(before);
      }),
      RUNS,
    );
  });
});

describe("trail ids", () => {
  it("are t-auto-<kind>-<8 hex> and identical for identical ordered content", () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 6 }), { maxLength: 8 }), (ids) => {
        expect(hashIds(ids)).toMatch(/^[0-9a-f]{8}$/);
        expect(hashIds(ids)).toBe(hashIds([...ids]));
        for (const kind of ["lineage", "debate", "nexus"] as const) {
          const id = autoTrailId(kind, ids);
          expect(id).toBe(`${AUTO_TRAIL_PREFIX}${kind}-${hashIds(ids)}`);
          expect(autoTrailKind(id)).toBe(kind);
        }
      }),
      RUNS,
    );
  });

  it("differ when the order differs", () => {
    expect(hashIds(["a", "b", "c"])).not.toBe(hashIds(["c", "b", "a"]));
    expect(autoTrailKind("t-human-abc")).toBeNull();
    expect(autoTrailKind("t-auto-lineage-xyz")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Dialectical Debate
// ---------------------------------------------------------------------------

function datedNodes(count: number): MemexNode[] {
  return Array.from({ length: count }, (_, i) =>
    makeNode(
      { prefix: "n", year: 1950 + i * 10, date: null, titleWords: ["banana"], tags: [], created: 1 },
      i,
    ),
  );
}

describe("Dialectical Debate", () => {
  it("is omitted whenever no edge refutes, whatever else is present", () => {
    fc.assert(
      fc.property(
        nodesArb.chain((nodes) =>
          fc.record({
            nodes: fc.constant(nodes),
            edges: edgesFor(nodes, [undefined, "supports", "synthesizes"]),
          }),
        ),
        ({ nodes, edges }) => {
          const kinds = generateAutoTrails(nodes, edges, [], OPTIONS).map(kindOf);
          expect(kinds).not.toContain("debate");
        },
      ),
      RUNS,
    );
  });

  it("only appears from refutes edges: every card touches a refutes or synthesizes edge, and one refutes edge lies inside", () => {
    fc.assert(
      fc.property(graphArb, ({ nodes, edges }) => {
        for (const trail of generateAutoTrails(nodes, edges, [], OPTIONS)) {
          if (kindOf(trail) !== "debate") continue;
          const inTrail = new Set(trail.nodeIds);
          const dialectical = edges.filter(
            (e) => e.data?.polarity === "refutes" || e.data?.polarity === "synthesizes",
          );
          for (const id of trail.nodeIds) {
            expect(dialectical.some((e) => e.source === id || e.target === id)).toBe(true);
          }
          expect(
            edges.some((e) => e.data?.polarity === "refutes" && inTrail.has(e.source) && inTrail.has(e.target)),
          ).toBe(true);
        }
      }),
      RUNS,
    );
  });

  it("builds thesis, antithesis, synthesis from refutes plus a synthesizes edge", () => {
    const nodes = datedNodes(4);
    const [n0, n1, n2, n3] = nodes;
    const edges = [
      edgeOf(n0.id, n1.id, "refutes", 0),
      edgeOf(n1.id, n2.id, "synthesizes", 1),
      edgeOf(n2.id, n3.id, "supports", 2),
    ];
    const trails = generateAutoTrails(nodes, edges, [], OPTIONS);
    const debate = trails.find((t) => kindOf(t) === "debate");
    expect(debate?.title).toBe(DEBATE_TITLE);
    expect(debate?.nodeIds).toEqual([n0.id, n1.id, n2.id]);
    expect(debate?.origin).toBe("ghost");
  });

  it("is omitted for a single refutes pair (fewer than three cards)", () => {
    const nodes = datedNodes(5);
    const edges = [edgeOf(nodes[0].id, nodes[1].id, "refutes")];
    expect(generateAutoTrails(nodes, edges, [], OPTIONS).map(kindOf)).not.toContain("debate");
  });

  it("orders by first appearance in the sorted edge list when cards are undated", () => {
    const nodes = ["x", "y", "z"].map((p, i) =>
      makeNode({ prefix: p, year: null, date: null, titleWords: [], tags: [], created: 1 }, i),
    );
    const [x, y, z] = nodes;
    const edges = [edgeOf(y.id, z.id, "refutes", 0), edgeOf(x.id, y.id, "refutes", 1)];
    const debate = generateAutoTrails(nodes, edges, [], OPTIONS).find((t) => kindOf(t) === "debate");
    // Sorted by source: x-y first, then y-z.
    expect(debate?.nodeIds).toEqual([x.id, y.id, z.id]);
  });

  it("keeps a synthesis at the end and at most eight cards", () => {
    const nodes = datedNodes(12);
    const edges: AssociativeEdge[] = [];
    for (let i = 0; i < 10; i++) edges.push(edgeOf(nodes[i].id, nodes[i + 1].id, "refutes", i));
    edges.push(edgeOf(nodes[11].id, nodes[5].id, "synthesizes", 99));
    const debate = generateAutoTrails(nodes, edges, [], OPTIONS).find((t) => kindOf(t) === "debate") as Trail;
    expect(debate.nodeIds).toHaveLength(8);
    expect(debate.nodeIds[debate.nodeIds.length - 1]).toBe(nodes[11].id);
  });
});

// ---------------------------------------------------------------------------
// Dense Conceptual Nexus
// ---------------------------------------------------------------------------

describe("Dense Conceptual Nexus", () => {
  it("never bundles unrelated cards: mean pairwise affinity stays above the minimum", () => {
    fc.assert(
      fc.property(graphArb, ({ nodes, edges }) => {
        const nexus = generateAutoTrails(nodes, edges, [], OPTIONS).find((t) => kindOf(t) === "nexus");
        if (nexus === undefined) return;
        const members = new Set(nexus.nodeIds);
        const pairs = scoreGhostPairs(nodes).filter((p) => members.has(p.sourceId) && members.has(p.targetId));
        const mean = pairs.reduce((s, p) => s + p.base, 0) / pairs.length;
        expect(pairs).toHaveLength((members.size * (members.size - 1)) / 2);
        expect(mean).toBeGreaterThanOrEqual(NEXUS_MIN_AFFINITY - 1e-9);
        // Every card is tied to the cluster by at least one pair at the minimum.
        for (const id of members) {
          const best = Math.max(
            ...pairs.filter((p) => p.sourceId === id || p.targetId === id).map((p) => p.base),
          );
          expect(best).toBeGreaterThanOrEqual(NEXUS_MIN_AFFINITY - 1e-9);
        }
      }),
      RUNS,
    );
  });

  it("is omitted when the cards share nothing, even with edges and discoveries between them", () => {
    fc.assert(
      fc.property(fc.integer({ min: 3, max: 12 }), (count) => {
        const nodes: MemexNode[] = Array.from({ length: count }, (_, i) => ({
          id: `u${i}`,
          type: "memexCard",
          position: { x: 0, y: 0 },
          data: {
            archivalId: `u${i}`,
            title: `qx${i}vz${i * 7}`,
            content: `wq${i}kj${i * 3}`,
            cardType: "note",
            tags: [`tg${i}xq`],
            createdAt: "2020-01-01T00:00:00.000Z",
          },
        }));
        const edges = nodes.slice(1).map((n, i) => edgeOf(nodes[i].id, n.id, undefined, i));
        const discoveries: GhostDiscovery[] = nodes.slice(1).map((n, i) => ({
          id: `gd${i}`,
          sourceId: nodes[i].id,
          targetId: n.id,
          rationale: "",
          confidence: 0.9,
          discoveredAt: "2026-01-01T00:00:00.000Z",
        }));
        expect(generateAutoTrails(nodes, edges, discoveries, OPTIONS)).toEqual([]);
      }),
      RUNS,
    );
  });

  it("is chronological when every card is dated", () => {
    fc.assert(
      fc.property(graphArb, ({ nodes, edges }) => {
        const byId = new Map(nodes.map((n) => [n.id, n]));
        const nexus = generateAutoTrails(nodes, edges, [], OPTIONS).find((t) => kindOf(t) === "nexus");
        if (nexus === undefined) return;
        const years = nexus.nodeIds.map((id) => getEventYear((byId.get(id) as MemexNode).data));
        if (years.some((y) => y === null)) return;
        for (let i = 1; i < years.length; i++) expect(years[i] as number).toBeGreaterThanOrEqual(years[i - 1] as number);
      }),
      RUNS,
    );
  });

  it("prefers a card that an existing edge links to the cluster (tie-break boost)", () => {
    // Four near-identical candidates: the linked one wins the first free slot at maxSteps 3.
    const base = { year: null, date: null, titleWords: ["memory", "retrieval", "archive"], tags: ["memory"], created: 1 };
    const nodes = ["a", "m", "z", "b"].map((p, i) => makeNode({ ...base, prefix: p }, i));
    const withoutEdge = generateAutoTrails(nodes, [], [], { ...OPTIONS, maxSteps: 3 }).find((t) => kindOf(t) === "nexus") as Trail;
    expect(withoutEdge).toBeDefined();
    const left = nodes.filter((n) => !withoutEdge.nodeIds.includes(n.id));
    // Link the last-sorted outsider to a member: it must now be chosen.
    const pick = [...left].sort((a, b) => (a.id < b.id ? 1 : -1))[0];
    const edges = [edgeOf(withoutEdge.nodeIds[0], pick.id, undefined, 0)];
    const withEdge = generateAutoTrails(nodes, edges, [], { ...OPTIONS, maxSteps: 3 }).find((t) => kindOf(t) === "nexus") as Trail;
    expect(withEdge.nodeIds).toContain(pick.id);
  });
});

// ---------------------------------------------------------------------------
// Lineage selection helpers and descriptions
// ---------------------------------------------------------------------------

describe("lineage selection", () => {
  it("bisectionOrder visits every index once, middle first", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 40 }), (n) => {
        const order = bisectionOrder(n);
        expect([...order].sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i));
      }),
      RUNS,
    );
    expect(bisectionOrder(7)).toEqual([3, 1, 5, 0, 2, 4, 6]);
  });

  it("prefers connected middle cards, then an even spread", () => {
    const nodes = datedNodes(12);
    const neighbours = new Map(nodes.map((n) => [n.id, new Set<string>()]));
    // Make cards 2 and 3 the only connected middle cards.
    for (const i of [2, 3]) neighbours.get(nodes[i].id)?.add(nodes[0].id);
    const picked = selectLineageCards(nodes, neighbours, 8).map((n) => n.id);
    expect(picked).toHaveLength(8);
    expect(picked[0]).toBe(nodes[0].id);
    expect(picked[7]).toBe(nodes[11].id);
    expect(picked).toContain(nodes[2].id);
    expect(picked).toContain(nodes[3].id);
    // Chronological order is preserved.
    const indexes = picked.map((id) => nodes.findIndex((n) => n.id === id));
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
  });
});

describe("descriptions are built only from the trail's own cards", () => {
  it("quotes only titles of cards inside the trail", () => {
    fc.assert(
      fc.property(graphArb, ({ nodes, edges }) => {
        for (const trail of generateAutoTrails(nodes, edges, [], OPTIONS)) {
          const inside = new Set(trail.nodeIds);
          for (const n of nodes) {
            if (inside.has(n.id)) continue;
            expect(trail.description).not.toContain(`"${n.data.title}"`);
          }
        }
      }),
      RUNS,
    );
  });
});

// ---------------------------------------------------------------------------
// Demo seed
// ---------------------------------------------------------------------------

describe("demo seed", () => {
  const trails = generateAutoTrails(demoSeed.nodes, demoSeed.edges, demoSeed.ghostDiscoveries, OPTIONS);

  it("yields a Lineage Arc and a Dense Conceptual Nexus, and no debate (no refutes edges)", () => {
    expect(trails.map((t) => t.title)).toEqual([LINEAGE_TITLE, NEXUS_TITLE]);
    expect(demoSeed.edges.some((e) => e.data?.polarity === "refutes")).toBe(false);
    expect(trails.map(kindOf)).not.toContain("debate");
  });

  it("orders the Lineage Arc chronologically over all seven dated cards", () => {
    const lineage = trails[0];
    expect(lineage.nodeIds).toEqual([
      "MEM-1945-01",
      "MEM-1965-02",
      "MEM-1968-03",
      "MEM-2017-04",
      "MEM-2024-05",
      "MEM-2024-06",
      "MEM-2026-07",
    ]);
    expect(lineage.origin).toBe("ghost");
    expect(lineage.createdAt).toBe(OPTIONS.createdAt);
  });

  it("bundles the four mutually related cards into the nexus, in date order", () => {
    expect(trails[1].nodeIds).toEqual(["MEM-1945-01", "MEM-2017-04", "MEM-2024-05", "MEM-2026-07"]);
  });

  it("does not duplicate an existing seed trail", () => {
    for (const t of trails) expect(isDuplicateTrail(t, demoSeed.trails)).toBe(false);
  });

  it("is stable across runs and across node order", () => {
    const reversed = generateAutoTrails([...demoSeed.nodes].reverse(), [...demoSeed.edges].reverse(), [], OPTIONS);
    expect(reversed).toEqual(trails);
    expect(trails.map((t) => t.id)).toEqual([
      autoTrailId("lineage", trails[0].nodeIds),
      autoTrailId("nexus", trails[1].nodeIds),
    ]);
  });

  it("describes the trail with its own years and titles only", () => {
    expect(trails[0].description).toContain("from 1945 to 2026");
    expect(trails[0].description).toContain('"Vannevar Bush: The Associative Trail Hypothesis" (1945)');
    expect(trails[1].description).toContain("4 cards");
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility: the Trail shape is unchanged
// ---------------------------------------------------------------------------

describe("Trail schema", () => {
  it("auto trails carry exactly the existing Trail fields and round-trip deterministically", () => {
    const trails = generateAutoTrails(demoSeed.nodes, demoSeed.edges, [], OPTIONS);
    for (const t of trails) {
      expect(Object.keys(t).sort()).toEqual(["createdAt", "description", "id", "nodeIds", "origin", "title"]);
    }
    const state = { ...demoSeed, trails: [...demoSeed.trails, ...trails] };
    const json = serializeGraph(state);
    expect(serializeGraph(deserializeGraph(json))).toBe(json);
    // An older save without auto trails still loads.
    const old = serializeGraph(demoSeed);
    expect(deserializeGraph(old).trails).toHaveLength(demoSeed.trails.length);
  });
});

// ---------------------------------------------------------------------------
// Choosing which trail the weave plays
// ---------------------------------------------------------------------------

describe("chooseWeaveTrail", () => {
  const mk = (kind: AutoTrailKind, ids: string[]): Trail => ({
    id: autoTrailId(kind, ids),
    title: kind,
    description: "",
    origin: "ghost",
    nodeIds: ids,
    createdAt: OPTIONS.createdAt,
  });
  const lineage = mk("lineage", ["a", "b", "c"]);
  const nexus = mk("nexus", ["a", "c", "d"]);
  const debate = mk("debate", ["b", "c", "d"]);

  it("prefers the newly added Lineage Arc, else the first added", () => {
    expect(chooseWeaveTrail([nexus, lineage], [nexus, lineage], 0).trail).toBe(lineage);
    expect(chooseWeaveTrail([nexus, debate], [nexus, debate], 0).trail).toBe(nexus);
  });

  it("cycles through the existing auto trails in id order when nothing is new", () => {
    const all = [nexus, lineage, debate];
    const sorted = [...all].sort((a, b) => (a.id < b.id ? -1 : 1));
    let cursor = 0;
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      const choice = chooseWeaveTrail([], all, cursor);
      seen.push((choice.trail as Trail).id);
      cursor = choice.nextCursor;
    }
    expect(seen).toEqual([...sorted, ...sorted].map((t) => t.id));
  });

  it("continues after the trail just woven", () => {
    const all = [nexus, lineage, debate];
    const sorted = [...all].sort((a, b) => (a.id < b.id ? -1 : 1));
    const first = chooseWeaveTrail([lineage], all, 0);
    expect(first.trail).toBe(lineage);
    const next = chooseWeaveTrail([], all, first.nextCursor);
    expect(next.trail).toBe(sorted[(sorted.indexOf(lineage) + 1) % 3]);
  });

  it("returns null when there is no auto trail, ignoring human trails and one-card trails", () => {
    const human: Trail = { ...lineage, id: "t-1", origin: "human" };
    const tiny = mk("nexus", ["a"]);
    expect(chooseWeaveTrail([], [human, tiny], 5).trail).toBeNull();
    expect(chooseWeaveTrail([], [], Number.NaN).trail).toBeNull();
  });

  it("tolerates any cursor", () => {
    fc.assert(
      fc.property(fc.oneof(fc.integer(), fc.double({ noNaN: false })), (cursor) => {
        const choice = chooseWeaveTrail([], [lineage, nexus], cursor);
        expect([lineage.id, nexus.id]).toContain((choice.trail as Trail).id);
        expect(Number.isFinite(choice.nextCursor)).toBe(true);
      }),
      RUNS,
    );
  });
});
