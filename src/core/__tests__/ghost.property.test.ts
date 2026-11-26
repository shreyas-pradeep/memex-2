import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  buildGhostEdges,
  computeCosineSimilarity,
  detectGhostSynapses,
  extractKeywords,
  forgeGhostTrail,
  ghostPairKey,
  removeNodeFromDiscoveries,
  synthesizeBridgeRationale,
} from "../ghost-engine";
import { acceptDiscovery, removeNodes } from "../graph-engine";
import { demoSeed } from "@/data/demo-seed";
import type {
  AssociativeEdge,
  GhostDiscovery,
  LinkOrigin,
  MemexGraphState,
  MemexNode,
} from "../types";

const RUNS = { numRuns: 200 } as const;

// ---------- Generators ----------

/** Small vocabulary so random cards overlap often enough to produce discoveries. */
const wordArb = fc.constantFrom(
  "memex", "trail", "microfilm", "essay", "analog", "digital", "network", "archive",
  "ghost", "bush", "hypertext", "radar", "science", "machine", "memory", "desk",
);
const textArb = fc.array(wordArb, { maxLength: 12 }).map((w) => w.join(" "));
const idArb = fc.stringMatching(/^n-[a-z0-9]{1,3}$/);

const nodeArb = (id: string): fc.Arbitrary<MemexNode> =>
  fc
    .record({
      title: textArb,
      content: textArb,
      tags: fc.array(wordArb, { maxLength: 4 }),
      cardType: fc.constantFrom("note", "quote", "artifact", "ghost" as const),
    })
    .map(({ title, content, tags, cardType }) => ({
      id,
      type: "memexCard" as const,
      position: { x: 0, y: 0 },
      data: {
        archivalId: `MEM-1945-${id}`,
        title,
        content,
        tags,
        cardType,
        createdAt: "1945-07-01T00:00:00.000Z",
      },
    }));

const nodesArb: fc.Arbitrary<MemexNode[]> = fc
  .uniqueArray(idArb, { maxLength: 10 })
  .chain((ids) => fc.tuple(...ids.map(nodeArb)))
  .map((nodes) => nodes as MemexNode[]);

const thresholdArb = fc.double({ min: 0, max: 1, noNaN: true });

/** Nodes plus random edges between them (either direction, either origin). */
const sceneArb = nodesArb.chain((nodes) => {
  const ids = nodes.map((n) => n.id);
  const edgeArb: fc.Arbitrary<AssociativeEdge> =
    ids.length === 0
      ? fc.constant<AssociativeEdge>(undefined as never)
      : fc
          .record({
            s: fc.constantFrom(...ids),
            t: fc.constantFrom(...ids),
            origin: fc.constantFrom<LinkOrigin[]>("human", "ghost"),
          })
          .map(({ s, t, origin }) => ({
            id: `e-${origin}-${s}-${t}`,
            source: s,
            target: t,
            type: "associative" as const,
            data: { origin, rationale: "", strength: 0.5 },
          }));
  return fc.record({
    nodes: fc.constant(nodes),
    edges: ids.length === 0 ? fc.constant<AssociativeEdge[]>([]) : fc.array(edgeArb, { maxLength: 15 }),
    threshold: thresholdArb,
  });
});

const vectorArb = fc
  .array(fc.tuple(wordArb, fc.double({ min: -5, max: 1e6, noNaN: true })), { maxLength: 10 })
  .map((pairs) => new Map(pairs));

// ---------- Property 1 ----------

describe("Property 1: Bounded Confidence", () => {
  it("every discovery has 0 <= confidence <= 1", () => {
    fc.assert(
      fc.property(sceneArb, ({ nodes, edges, threshold }) => {
        for (const d of detectGhostSynapses(nodes, edges, threshold)) {
          expect(Number.isFinite(d.confidence)).toBe(true);
          expect(d.confidence).toBeGreaterThanOrEqual(0);
          expect(d.confidence).toBeLessThanOrEqual(1);
          expect(d.confidence).toBeGreaterThanOrEqual(Math.min(threshold, 1) - 0.0005);
        }
      }),
      RUNS,
    );
  });

  it("cosine similarity is always within [0, 1], symmetric, and 0 for empty vectors", () => {
    fc.assert(
      fc.property(vectorArb, vectorArb, (a, b) => {
        const c = computeCosineSimilarity(a, b);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
        expect(computeCosineSimilarity(b, a)).toBeCloseTo(c, 10);
        expect(computeCosineSimilarity(a, new Map())).toBe(0);
      }),
      RUNS,
    );
  });
});

// ---------- Property 2 ----------

describe("Property 2: No Self-Synapses or Duplicate Bridges", () => {
  it("never pairs a card with itself and never repeats an unordered pair", () => {
    fc.assert(
      fc.property(sceneArb, ({ nodes, edges, threshold }) => {
        const out = detectGhostSynapses(nodes, edges, threshold);
        const pairs = new Set<string>();
        const ids = new Set<string>();
        for (const d of out) {
          expect(d.sourceId).not.toBe(d.targetId);
          const key = ghostPairKey(d.sourceId, d.targetId);
          expect(pairs.has(key)).toBe(false);
          expect(ids.has(d.id)).toBe(false);
          pairs.add(key);
          ids.add(d.id);
        }
      }),
      RUNS,
    );
  });

  it("is deterministic and independent of node and edge input order", () => {
    fc.assert(
      fc.property(sceneArb, ({ nodes, edges, threshold }) => {
        const a = detectGhostSynapses(nodes, edges, threshold);
        const b = detectGhostSynapses([...nodes].reverse(), [...edges].reverse(), threshold);
        expect(b).toEqual(a);
        expect(detectGhostSynapses(nodes, edges, threshold)).toEqual(a);
      }),
      RUNS,
    );
  });

  it("rationale is symmetric in its arguments", () => {
    fc.assert(
      fc.property(nodeArb("n-a"), nodeArb("n-b"), (a, b) => {
        expect(synthesizeBridgeRationale(a, b)).toBe(synthesizeBridgeRationale(b, a));
      }),
      RUNS,
    );
  });
});

// ---------- Property 3 ----------

describe("Property 3: Unconnected Invariant", () => {
  it("never duplicates an existing edge, in either direction and for any origin", () => {
    fc.assert(
      fc.property(sceneArb, ({ nodes, edges, threshold }) => {
        const connected = new Set(edges.map((e) => ghostPairKey(e.source, e.target)));
        for (const d of detectGhostSynapses(nodes, edges, threshold)) {
          expect(connected.has(ghostPairKey(d.sourceId, d.targetId))).toBe(false);
        }
        const humanPairs = new Set(
          edges.filter((e) => e.data?.origin === "human").map((e) => ghostPairKey(e.source, e.target)),
        );
        for (const d of detectGhostSynapses(nodes, edges, threshold)) {
          expect(humanPairs.has(ghostPairKey(d.sourceId, d.targetId))).toBe(false);
        }
      }),
      RUNS,
    );
  });

  it("accepting a discovery never creates a duplicate human edge, and dismissed pairs never return", () => {
    fc.assert(
      fc.property(sceneArb, ({ nodes, edges }) => {
        const found = detectGhostSynapses(nodes, edges, 0);
        if (found.length === 0) return;
        const state: MemexGraphState = { nodes, edges, trails: [], ghostDiscoveries: found };
        const after = acceptDiscovery(state, found[0].id);
        const key = ghostPairKey(found[0].sourceId, found[0].targetId);
        const humanOnPair = after.edges.filter(
          (e) => e.data?.origin === "human" && ghostPairKey(e.source, e.target) === key,
        );
        expect(humanOnPair).toHaveLength(1);
        expect(after.ghostDiscoveries.some((d) => d.id === found[0].id)).toBe(false);

        const rescan = detectGhostSynapses(nodes, edges, 0, { dismissed: [found[0].id] });
        expect(rescan.some((d) => d.id === found[0].id)).toBe(false);
      }),
      RUNS,
    );
  });
});

// ---------- Property 4 ----------

describe("Property 4: Node Deletion Cleansing", () => {
  const discoveryArb = fc
    .record({ s: idArb, t: idArb, c: fc.double({ min: 0, max: 1, noNaN: true }) })
    .map<GhostDiscovery>(({ s, t, c }, ) => ({
      id: `gd-${s}-${t}-${c}`,
      sourceId: s,
      targetId: t,
      rationale: "r",
      confidence: c,
      discoveredAt: "1945-07-01T00:00:00.000Z",
    }));

  it("removeNodeFromDiscoveries drops exactly the discoveries that touch deleted IDs", () => {
    fc.assert(
      fc.property(
        fc.array(discoveryArb, { maxLength: 15 }),
        fc.array(idArb, { maxLength: 6 }),
        (ds, doomed) => {
          const gone = new Set(doomed);
          const out = removeNodeFromDiscoveries(ds, doomed);
          for (const d of out) {
            expect(gone.has(d.sourceId)).toBe(false);
            expect(gone.has(d.targetId)).toBe(false);
          }
          const expected = ds.filter((d) => !gone.has(d.sourceId) && !gone.has(d.targetId));
          expect(out).toEqual(expected);
        },
      ),
      RUNS,
    );
  });

  it("removeNodes leaves no discovery or synapse edge referencing a deleted card", () => {
    fc.assert(
      fc.property(sceneArb, fc.nat({ max: 5 }), ({ nodes, edges }, count) => {
        const found = detectGhostSynapses(nodes, edges, 0);
        const state: MemexGraphState = { nodes, edges, trails: [], ghostDiscoveries: found };
        const doomed = nodes.slice(0, count).map((n) => n.id);
        const next = removeNodes(state, doomed);
        const gone = new Set(doomed);
        for (const d of next.ghostDiscoveries) {
          expect(gone.has(d.sourceId) || gone.has(d.targetId)).toBe(false);
        }
        for (const e of buildGhostEdges(next.ghostDiscoveries)) {
          expect(gone.has(e.source) || gone.has(e.target)).toBe(false);
        }
        expect(next.ghostDiscoveries).toEqual(
          found.filter((d) => !gone.has(d.sourceId) && !gone.has(d.targetId)),
        );
      }),
      RUNS,
    );
  });
});

// ---------- Unit checks ----------

describe("keywords and the demo seed", () => {
  it("extractKeywords is sorted, unique, lowercase and drops stop words and numbers", () => {
    expect(extractKeywords("The Memex and the memexes, 1945! Trails of Trail")).toEqual([
      "memex",
      "trail",
    ]);
    fc.assert(
      fc.property(fc.string(), (s) => {
        const k = extractKeywords(s);
        expect(k).toEqual([...new Set(k)].sort());
        for (const w of k) expect(w).toBe(w.toLowerCase());
      }),
      RUNS,
    );
  });

  it("the demo seed yields at least one non-obvious bridge between unconnected cards", () => {
    const found = detectGhostSynapses(demoSeed.nodes, demoSeed.edges);
    expect(found.length).toBeGreaterThanOrEqual(1);
    const connected = new Set(demoSeed.edges.map((e) => ghostPairKey(e.source, e.target)));
    for (const d of found) expect(connected.has(ghostPairKey(d.sourceId, d.targetId))).toBe(false);
  });

  it("forgeGhostTrail makes a two-stop ghost trail", () => {
    const [d] = detectGhostSynapses(demoSeed.nodes, demoSeed.edges);
    const trail = forgeGhostTrail(d, demoSeed.nodes);
    expect(trail.origin).toBe("ghost");
    expect(trail.nodeIds).toEqual([d.sourceId, d.targetId]);
  });
});
