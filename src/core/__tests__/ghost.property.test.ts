import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  GHOST_CONFIDENCE_MAX,
  GHOST_CONFIDENCE_MIN,
  buildGhostEdges,
  calibrateGhostConfidence,
  ghostDiscoveryId,
  sanitizeGhostSuggestions,
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
          // Local confidence is calibrated into [0.78, 0.96] from the raw score.
          expect(d.confidence).toBeGreaterThanOrEqual(GHOST_CONFIDENCE_MIN);
          expect(d.confidence).toBeLessThanOrEqual(GHOST_CONFIDENCE_MAX);
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

  it("the demo seed yields 2 to 3 non-obvious bridges between unconnected cards", () => {
    const found = detectGhostSynapses(demoSeed.nodes, demoSeed.edges);
    expect(found.length).toBeGreaterThanOrEqual(2);
    expect(found.length).toBeLessThanOrEqual(3);
    const ids = found.map((d) => d.id);
    expect(ids).toContain(ghostDiscoveryId("n-asw", "n-engelbart"));
    for (const d of found) {
      expect(d.confidence).toBeGreaterThanOrEqual(0.78);
      expect(d.confidence).toBeLessThanOrEqual(0.96);
      expect(d.rationale).toMatch(/never linked/);
    }
    expect(found.find((d) => d.id === ghostDiscoveryId("n-asw", "n-engelbart"))?.rationale).toMatch(
      /23 years.*1945.*1968/,
    );
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

// ---------- Calibration, caps, determinism, live sanitizer ----------

describe("calibration, cap and determinism", () => {
  it("calibrateGhostConfidence is monotone and stays within [0.78, 0.96]", () => {
    fc.assert(
      fc.property(fc.double({ min: -1, max: 2, noNaN: true }), fc.double({ min: -1, max: 2, noNaN: true }), (x, y) => {
        const [lo, hi] = x <= y ? [x, y] : [y, x];
        const a = calibrateGhostConfidence(lo);
        const b = calibrateGhostConfidence(hi);
        expect(a).toBeLessThanOrEqual(b);
        for (const c of [a, b]) {
          expect(c).toBeGreaterThanOrEqual(GHOST_CONFIDENCE_MIN);
          expect(c).toBeLessThanOrEqual(GHOST_CONFIDENCE_MAX);
        }
      }),
      RUNS,
    );
  });

  it("local results are deterministic, capped and sorted by confidence", () => {
    fc.assert(
      fc.property(sceneArb, fc.integer({ min: 0, max: 5 }), ({ nodes, edges, threshold }, cap) => {
        const a = detectGhostSynapses(nodes, edges, threshold, { maxResults: cap });
        expect(detectGhostSynapses(nodes, edges, threshold, { maxResults: cap })).toEqual(a);
        expect(a.length).toBeLessThanOrEqual(cap);
        for (let i = 1; i < a.length; i++) expect(a[i - 1].confidence).toBeGreaterThanOrEqual(a[i].confidence);
        expect(detectGhostSynapses(nodes, edges, threshold).length).toBeLessThanOrEqual(3);
      }),
      RUNS,
    );
  });

  it("different words for one idea still bridge through the concept lexicon", () => {
    const mk = (id: string, title: string, content: string): MemexNode => ({
      id,
      type: "memexCard",
      position: { x: 0, y: 0 },
      data: { archivalId: id, title, content, tags: [], cardType: "note", createdAt: "1945-07-01T00:00:00.000Z" },
    });
    const out = detectGhostSynapses(
      [mk("a", "Hyperlinks", "Linked trails of association."), mk("b", "Memex", "A desk with microfilm.")],
      [],
      0.1,
    );
    expect(out).toHaveLength(1);
    expect(out[0].rationale).toMatch(/associative linking/);
  });
});

describe("sanitizeGhostSuggestions", () => {
  const nodes = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  const edges = [{ source: "a", target: "b" }];
  const rawArb = fc.array(
    fc.record({
      sourceId: fc.oneof(fc.constantFrom("a", "b", "c", "d", "zz"), fc.anything()),
      targetId: fc.oneof(fc.constantFrom("a", "b", "c", "d", "zz"), fc.anything()),
      rationale: fc.oneof(fc.string({ maxLength: 800 }), fc.anything()),
      confidence: fc.oneof(fc.double(), fc.anything()),
      bridgeTheme: fc.oneof(fc.string(), fc.anything()),
    }),
    { maxLength: 12 },
  );

  it("always returns valid, unique, unconnected, bounded discoveries", () => {
    fc.assert(
      fc.property(rawArb, (raw) => {
        const out = sanitizeGhostSuggestions(raw, nodes, edges);
        const seen = new Set<string>();
        expect(out.length).toBeLessThanOrEqual(4);
        for (const d of out) {
          expect(d.sourceId).not.toBe(d.targetId);
          expect(["a", "b", "c", "d"]).toContain(d.sourceId);
          expect(["a", "b", "c", "d"]).toContain(d.targetId);
          expect(ghostPairKey(d.sourceId, d.targetId)).not.toBe(ghostPairKey("a", "b"));
          expect(seen.has(d.id)).toBe(false);
          seen.add(d.id);
          expect(d.sourceId <= d.targetId).toBe(true);
          expect(d.confidence).toBeGreaterThanOrEqual(0);
          expect(d.confidence).toBeLessThanOrEqual(1);
          expect(d.rationale.length).toBeGreaterThan(0);
          expect(d.rationale.length).toBeLessThanOrEqual(400);
        }
      }),
      RUNS,
    );
  });

  it("dedups symmetric pairs, clamps confidence and honors dismissals", () => {
    const raw = [
      { sourceId: "d", targetId: "c", rationale: "  x  ", confidence: 7, bridgeTheme: "Theme" },
      { sourceId: "c", targetId: "d", rationale: "dup", confidence: 0.1 },
      { sourceId: "a", targetId: "b", rationale: "connected", confidence: 0.9 },
      { sourceId: "a", targetId: "a", rationale: "self", confidence: 0.9 },
      { sourceId: "a", targetId: "nope", rationale: "ghost id", confidence: 0.9 },
      { sourceId: "a", targetId: "c", rationale: "ok", confidence: -3 },
    ];
    const out = sanitizeGhostSuggestions(raw, nodes, edges);
    expect(out.map((d) => [d.id, d.confidence])).toEqual([
      [ghostDiscoveryId("c", "d"), 1],
      [ghostDiscoveryId("a", "c"), 0],
    ]);
    expect(out[0].rationale).toBe("Theme: x");
    const skipped = sanitizeGhostSuggestions(raw, nodes, edges, { dismissed: [ghostDiscoveryId("c", "d")] });
    expect(skipped.map((d) => d.id)).toEqual([ghostDiscoveryId("a", "c")]);
    expect(sanitizeGhostSuggestions("nope", nodes, edges)).toEqual([]);
  });
});
