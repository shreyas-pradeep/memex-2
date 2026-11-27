import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  CONCEPT_LEXICON,
  CROSS_ERA_BOOST,
  DEFAULT_GHOST_MAX_RESULTS,
  GHOST_CONFIDENCE_MAX,
  GHOST_CONFIDENCE_MIN,
  LINEAGE_RATIONALE_RULES,
  buildGhostEdges,
  calibrateGhostConfidence,
  conceptIdsOf,
  crossEraBoost,
  isCrossEraPair,
  matchLineageRule,
  scoreGhostPairs,
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
import { getChronologicalNodes, getTrailEdges } from "../trail-engine";
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
  "attention", "graphrag", "augmentation", "values", "nodes", "dot-product", "working-memory",
);
const textArb = fc.array(wordArb, { maxLength: 12 }).map((w) => w.join(" "));
const idArb = fc.stringMatching(/^n-[a-z0-9]{1,3}$/);

/** Event year or undated, spanning both sides of the 1970 and 2015 cross-era bounds. */
const yearArb = fc.option(fc.integer({ min: 1900, max: 2030 }), { nil: undefined });

const nodeArb = (id: string): fc.Arbitrary<MemexNode> =>
  fc
    .record({
      title: textArb,
      content: textArb,
      tags: fc.array(wordArb, { maxLength: 4 }),
      cardType: fc.constantFrom("note", "quote", "artifact", "ghost" as const),
      year: yearArb,
    })
    .map(({ title, content, tags, cardType, year }) => ({
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
        ...(year === undefined ? {} : { year }),
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

  it("the demo seed yields 4 to 6 cross-era bridges between unconnected cards", () => {
    const found = detectGhostSynapses(demoSeed.nodes, demoSeed.edges);
    expect(found.length).toBeGreaterThanOrEqual(4);
    expect(found.length).toBeLessThanOrEqual(6);
    const ids = found.map((d) => d.id);
    // The cross-era bridges the lineage boost exists to surface.
    for (const [x, y] of [
      ["MEM-1945-01", "MEM-2026-07"],
      ["MEM-1945-01", "MEM-2024-05"],
      ["MEM-1968-03", "MEM-2026-07"],
      ["MEM-1965-02", "MEM-2024-05"],
    ]) {
      expect(ids).toContain(ghostDiscoveryId(x, y));
    }
    const year = (id: string) => demoSeed.nodes.find((n) => n.id === id)?.data.year ?? null;
    for (const d of found) {
      expect(d.confidence).toBeGreaterThanOrEqual(0.78);
      expect(d.confidence).toBeLessThanOrEqual(0.96);
      expect(d.rationale).toMatch(/never linked/);
      expect(isCrossEraPair(year(d.sourceId), year(d.targetId))).toBe(true);
    }
    expect(found.find((d) => d.id === ghostDiscoveryId("MEM-1945-01", "MEM-2026-07"))?.rationale).toMatch(
      /81 years.*1945.*2026/,
    );
    const connected = new Set(demoSeed.edges.map((e) => ghostPairKey(e.source, e.target)));
    for (const d of found) expect(connected.has(ghostPairKey(d.sourceId, d.targetId))).toBe(false);
    // Already-connected landmark pairs (ghost edges in the seed) are never re-suggested.
    for (const [x, y] of [
      ["MEM-1945-01", "MEM-2017-04"],
      ["MEM-1965-02", "MEM-2017-04"],
    ]) {
      expect(ids).not.toContain(ghostDiscoveryId(x, y));
    }
  });

  it("the demo seed is dated, and every trail's consecutive stops are connected", () => {
    expect(getChronologicalNodes(demoSeed.nodes)).toHaveLength(7);
    const ids = new Set(demoSeed.nodes.map((n) => n.id));
    expect(ids.size).toBe(7);
    for (const n of demoSeed.nodes) expect(n.data.archivalId).toBe(n.id);
    for (const t of demoSeed.trails) {
      expect(t.nodeIds.every((id) => ids.has(id))).toBe(true);
      expect(getTrailEdges(t, demoSeed.edges)).toHaveLength(t.nodeIds.length - 1);
    }
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
        expect(detectGhostSynapses(nodes, edges, threshold).length).toBeLessThanOrEqual(DEFAULT_GHOST_MAX_RESULTS);
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

// ---------- Concept clusters ----------

const card = (
  id: string,
  title: string,
  content: string,
  tags: string[] = [],
  year?: number,
): MemexNode => ({
  id,
  type: "memexCard",
  position: { x: 0, y: 0 },
  data: {
    archivalId: id,
    title,
    content,
    tags,
    cardType: "note",
    createdAt: "1945-07-01T00:00:00.000Z",
    ...(year === undefined ? {} : { year }),
  },
});

const conceptsOfText = (title: string, content = "", tags: string[] = []) =>
  conceptIdsOf(card("x", title, content, tags).data);

describe("semantic concept clusters", () => {
  it("hyphenated, split and glued spellings match, in text and in tags", () => {
    for (const spelling of ["dot-product", "dot product", "dotproduct", "Dot-Product"]) {
      expect(conceptsOfText(spelling)).toContain("retrieval");
      expect(conceptsOfText("x", "", [spelling])).toContain("retrieval");
    }
    for (const spelling of ["non-linear", "non linear", "nonlinear"]) {
      expect(conceptsOfText(spelling)).toContain("hypergraph");
    }
    for (const spelling of ["working-memory", "working memory", "Working Memory"]) {
      expect(conceptsOfText(spelling)).toContain("augmentation");
    }
    expect(conceptsOfText("x", "", ["spatial-gestalt"])).toContain("augmentation");
    expect(conceptsOfText("latent space")).toContain("latent");
    expect(conceptsOfText("Sparse autoencoders")).toContain("latent");
    expect(conceptsOfText("x", "", ["knowledge-graphs"])).toContain("hypergraph");
    expect(conceptsOfText("Monosemanticity")).toContain("latent");
    expect(conceptsOfText("Manifold")).toContain("latent");
  });

  it("phrases never form across separate tags", () => {
    // "dot" and "product" in different tags are not the phrase "dot-product".
    expect(conceptsOfText("x", "", ["dot", "product"])).not.toContain("retrieval");
    expect(conceptsOfText("x", "", ["working", "memory"])).not.toContain("augmentation");
  });

  it("a single over-generic term never touches a cluster, two distinct ones do", () => {
    for (const generic of ["values", "nodes", "links", "keys", "features", "community", "hierarchical", "scaled", "mouse", "bandwidth", "stored", "model"]) {
      expect(conceptsOfText(generic), generic).toEqual([]);
      // Repeating the same term does not add weight.
      expect(conceptsOfText(`${generic} ${generic} ${generic}`), generic).toEqual([]);
    }
    // "index" is a distinctive term of the older "organizing knowledge" concept only.
    expect(conceptsOfText("indexing")).toEqual(["knowledge"]);
    expect(conceptsOfText("keys and values")).toContain("retrieval");
    expect(conceptsOfText("nodes and community")).toContain("hypergraph");
    expect(conceptsOfText("mouse and bandwidth")).toContain("augmentation");
    expect(conceptsOfText("model features")).toContain("latent");
  });

  it("unrelated cards sharing only a generic word get no bridge and no cross-era boost", () => {
    const old = card("a", "Ledger of values", "Values recorded by clerks.", [], 1950);
    const modern = card("b", "Market values", "Values rise and fall.", [], 2020);
    const [pair] = scoreGhostPairs([old, modern]);
    expect(pair.sharedConcepts).toEqual([]);
    expect(pair.boost).toBe(0);
    expect(detectGhostSynapses([old, modern], [], 0.3)).toEqual([]);
  });

  it("every lexicon concept has a label and at least one distinctive term", () => {
    for (const [id, def] of Object.entries(CONCEPT_LEXICON)) {
      expect(def.label.length, id).toBeGreaterThan(0);
      expect(def.terms.length, id).toBeGreaterThan(0);
    }
  });
});

// ---------- Cross-era lineage boost ----------

describe("cross-era lineage boost", () => {
  it("boundaries: <= 1970 versus >= 2015, either order, undated excluded", () => {
    expect(isCrossEraPair(1970, 2015)).toBe(true);
    expect(isCrossEraPair(2015, 1970)).toBe(true);
    expect(isCrossEraPair(1971, 2015)).toBe(false);
    expect(isCrossEraPair(1970, 2014)).toBe(false);
    expect(isCrossEraPair(null, 2020)).toBe(false);
    expect(isCrossEraPair(1945, null)).toBe(false);
    expect(crossEraBoost(1945, 2026, 0)).toBe(0);
    expect(crossEraBoost(1945, 2026, 1)).toBe(CROSS_ERA_BOOST);
  });

  it("applies only to <=1970 vs >=2015 pairs that share a concept, never lowers the score, never exceeds 1", () => {
    fc.assert(
      fc.property(nodeArb("n-a"), nodeArb("n-b"), (a, b) => {
        const [pair] = scoreGhostPairs([a, b]);
        const ya = a.data.year ?? null;
        const yb = b.data.year ?? null;
        const qualifies = isCrossEraPair(ya, yb) && pair.sharedConcepts.length > 0;
        expect(pair.boost).toBe(qualifies ? CROSS_ERA_BOOST : 0);
        expect(pair.score).toBeGreaterThanOrEqual(pair.base);
        expect(pair.score).toBeLessThanOrEqual(1);
        expect(pair.score).toBeCloseTo(Math.min(1, pair.base + pair.boost), 12);
        // Years never change the base affinity: only the boost depends on them.
        const undated = scoreGhostPairs([
          { ...a, data: { ...a.data, year: undefined } },
          { ...b, data: { ...b.data, year: undefined } },
        ])[0];
        expect(undated.boost).toBe(0);
        expect(undated.base).toBeCloseTo(pair.base, 12);
      }),
      RUNS,
    );
  });

  it("a dated pair's confidence is never below the same pair undated, and stays calibrated", () => {
    fc.assert(
      fc.property(nodeArb("n-a"), nodeArb("n-b"), (a, b) => {
        const strip = (n: MemexNode): MemexNode => ({ ...n, data: { ...n.data, year: undefined } });
        const dated = detectGhostSynapses([a, b], [], 0, { maxResults: 5 });
        const plain = detectGhostSynapses([strip(a), strip(b)], [], 0, { maxResults: 5 });
        expect(dated.length).toBeGreaterThanOrEqual(plain.length);
        for (const p of plain) {
          const d = dated.find((x) => x.id === p.id);
          expect(d).toBeDefined();
          expect(d?.confidence ?? 0).toBeGreaterThanOrEqual(p.confidence);
        }
        for (const d of dated) {
          expect(d.confidence).toBeGreaterThanOrEqual(GHOST_CONFIDENCE_MIN);
          expect(d.confidence).toBeLessThanOrEqual(GHOST_CONFIDENCE_MAX);
        }
        expect(detectGhostSynapses([a, b], [], 0, { maxResults: 5 })).toEqual(dated);
      }),
      RUNS,
    );
  });

  it("lifts a pair across the threshold only when it is cross-era", () => {
    const mk = (y1: number, y2: number) => [
      card("a", "Memex trails", "Associative trails of memory.", [], y1),
      card("b", "Attention retrieval", "Attention as memory retrieval.", [], y2),
    ];
    const threshold = (() => {
      const [pair] = scoreGhostPairs(mk(2000, 2000));
      return pair.base + 0.01;
    })();
    expect(detectGhostSynapses(mk(2000, 2020), [], threshold)).toHaveLength(0);
    expect(detectGhostSynapses(mk(1945, 2020), [], threshold)).toHaveLength(1);
    expect(detectGhostSynapses(mk(2020, 1945), [], threshold)).toHaveLength(1);
  });
});

// ---------- Contextual rationales ----------

const seedNode = (id: string): MemexNode => {
  const n = demoSeed.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`missing seed node ${id}`);
  return n;
};

/** Built at runtime so this file does not itself contain the removed figure. */
const WRONG_DIMENSION = new RegExp(`${12}[,_.]?${288}`);

describe("contextual rationale table", () => {
  const BUSH = seedNode("MEM-1945-01");
  const NELSON = seedNode("MEM-1965-02");
  const VASWANI = seedNode("MEM-2017-04");
  const GRAPHRAG = seedNode("MEM-2024-05");

  it("Bush and Vaswani: hedged scaled dot-product reading, with no invented number", () => {
    const r = synthesizeBridgeRationale(BUSH, VASWANI);
    expect(r).toContain(
      "Direct theoretical realization (an interpretation): Bush's associative trail selection reads as scaled dot-product key-value lookup in Transformer attention.",
    );
    expect(r).not.toMatch(WRONG_DIMENSION);
    expect(r).not.toMatch(/latent dimensions/);
    expect(r).toMatch(/never linked/);
    expect(r).toMatch(/72 years.*1945.*2017/);
  });

  it("Bush and GraphRAG", () => {
    expect(synthesizeBridgeRationale(BUSH, GRAPHRAG)).toContain(
      "Hierarchical graph community traversal operationalizes Bush's non-linear associative web for LLM memory retrieval.",
    );
  });

  it("Nelson with GraphRAG or Vaswani", () => {
    const text = "Non-linear hypertext topology realized as multi-hop associative graph retrieval.";
    expect(synthesizeBridgeRationale(NELSON, GRAPHRAG)).toContain(text);
    expect(synthesizeBridgeRationale(NELSON, VASWANI)).toContain(text);
  });

  it("is symmetric and recognizes user-made equivalents by year and vocabulary", () => {
    const pairs = [
      [BUSH, VASWANI],
      [BUSH, GRAPHRAG],
      [NELSON, GRAPHRAG],
      [NELSON, VASWANI],
    ] as const;
    for (const [x, y] of pairs) {
      expect(synthesizeBridgeRationale(x, y)).toBe(synthesizeBridgeRationale(y, x));
      expect(matchLineageRule(x, y)?.id).toBe(matchLineageRule(y, x)?.id);
    }
    const myBush = card("u-1", "My notes on the Memex", "Trails by association.", ["memex"], 1945);
    const myAttention = card(
      "u-2",
      "Attention Is All You Need",
      "Queries, keys and a scaled dot-product.",
      ["transformer"],
      2017,
    );
    expect(matchLineageRule(myBush, myAttention)?.id).toBe("bush-attention");
    expect(synthesizeBridgeRationale(myBush, myAttention)).toContain("Direct theoretical realization");
    // The same vocabulary without a year is not recognized by signals.
    const undatedAttention = card("u-3", "Attention Is All You Need", "Queries, keys and a scaled dot-product.");
    expect(matchLineageRule(myBush, undatedAttention)).toBeNull();
  });

  it("every rule names two distinct roles and carries no digit-grouped figure", () => {
    expect(LINEAGE_RATIONALE_RULES.length).toBeGreaterThanOrEqual(3);
    for (const rule of LINEAGE_RATIONALE_RULES) {
      expect(rule.roles[0]).not.toBe(rule.roles[1]);
      expect(rule.text).not.toMatch(/\d/);
    }
  });

  it("default cross-era rationale lists human-readable shared themes", () => {
    const eng = seedNode("MEM-1968-03");
    const hyp = seedNode("MEM-2026-07");
    const r = synthesizeBridgeRationale(eng, hyp);
    expect(r).toContain(
      "Cards share a high-affinity conceptual nexus across cognitive augmentation and spatial layout bridging theoretical origins with modern empirical implementations.",
    );
    expect(matchLineageRule(eng, hyp)).toBeNull();
    expect(r).toMatch(/never linked/);
    expect(r).toMatch(/58 years.*1968.*2026/);
  });

  it("same-era pairs keep the existing wording and never claim cross-era bridging", () => {
    const r = synthesizeBridgeRationale(GRAPHRAG, seedNode("MEM-2026-07"));
    expect(r).toMatch(/never linked, yet both draw on/);
    expect(r).not.toMatch(/bridging theoretical origins/);
    expect(r).toMatch(/2 years apart/);
  });

  it("only cross-era pairs sharing a concept use the nexus sentence", () => {
    fc.assert(
      fc.property(nodeArb("n-a"), nodeArb("n-b"), (a, b) => {
        const r = synthesizeBridgeRationale(a, b);
        const [pair] = scoreGhostPairs([a, b]);
        if (matchLineageRule(a, b) === null) {
          expect(r.includes("bridging theoretical origins")).toBe(pair.boost > 0);
        }
        expect(r).not.toMatch(WRONG_DIMENSION);
      }),
      RUNS,
    );
  });

  it("no rationale of any seed pair, and no source file, contains the removed GPT-3 width figure", () => {
    const nodes = demoSeed.nodes;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        expect(synthesizeBridgeRationale(nodes[i], nodes[j])).not.toMatch(WRONG_DIMENSION);
      }
    }
    for (const d of detectGhostSynapses(nodes, [], 0, { maxResults: 100 })) {
      expect(d.rationale).not.toMatch(WRONG_DIMENSION);
    }
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        return statSync(full).isDirectory() ? walk(full) : /\.(tsx?|css|md|json)$/.test(name) ? [full] : [];
      });
    for (const file of walk(join(process.cwd(), "src"))) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(WRONG_DIMENSION);
    }
  });
});
