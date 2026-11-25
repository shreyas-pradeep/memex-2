import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  computeAutoLayout,
  connectNodes,
  createTrail,
  deserializeGraph,
  removeNodes,
  serializeGraph,
} from "../graph-engine";
import type {
  AssociativeEdge,
  GhostDiscovery,
  LinkOrigin,
  MemexGraphState,
  MemexNode,
  Trail,
} from "../types";

const NUM_RUNS = 200;

// ---------- Generators ----------

const originArb: fc.Arbitrary<LinkOrigin> = fc.constantFrom("human", "ghost");
const isoArb = fc
  .integer({ min: 0, max: 4_102_444_800_000 })
  .map((ms) => new Date(ms).toISOString());
// `+ 0` normalises -0 to 0, which JSON cannot round-trip.
const coordArb = fc.integer({ min: -100_000, max: 100_000 }).map((n) => n + 0);
const unit = fc.double({ min: 0, max: 1, noNaN: true }).map((n) => n + 0);

const nodeArb = (id: string): fc.Arbitrary<MemexNode> =>
  fc.record({
    id: fc.constant(id),
    type: fc.constant("memexCard" as const),
    position: fc.record({ x: coordArb, y: coordArb }),
    data: fc.record(
      {
        archivalId: fc.string(),
        title: fc.string(),
        content: fc.string(),
        cardType: fc.constantFrom("note", "quote", "artifact", "ghost"),
        tags: fc.array(fc.string(), { maxLength: 4 }),
        createdAt: isoArb,
        imageUrl: fc.string(),
        confidence: unit,
      },
      { requiredKeys: ["archivalId", "title", "content", "cardType", "tags", "createdAt"] },
    ),
  });

const trailArb = (ids: string[], i: number): fc.Arbitrary<Trail> =>
  fc.record({
    id: fc.constant(`t-${i}`),
    title: fc.string(),
    description: fc.string(),
    origin: originArb,
    nodeIds: ids.length ? fc.array(fc.constantFrom(...ids), { maxLength: 6 }) : fc.constant([]),
    createdAt: isoArb,
  });

/** Generates a consistent graph (unique node IDs; edges/trails/ghosts reference real nodes). */
const graphArb: fc.Arbitrary<MemexGraphState> = fc
  .uniqueArray(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 12 })
  .chain((ids) =>
    fc
      .tuple(
        fc.tuple(...ids.map(nodeArb)),
        ids.length
          ? fc.uniqueArray(
              fc.record({
                source: fc.constantFrom(...ids),
                target: fc.constantFrom(...ids),
                origin: originArb,
              }),
              {
                maxLength: 20,
                selector: (e) => `${e.source}\u0000${e.target}\u0000${e.origin}`,
              },
            )
          : fc.constant([]),
        fc.tuple(...Array.from({ length: 3 }, (_, i) => trailArb(ids, i))),
        ids.length
          ? fc.array(
              fc.record({
                id: fc.string(),
                sourceId: fc.constantFrom(...ids),
                targetId: fc.constantFrom(...ids),
                rationale: fc.string(),
                confidence: unit,
                discoveredAt: isoArb,
              }),
              { maxLength: 4 },
            )
          : fc.constant([]),
        fc.integer({ min: 0, max: 3 }),
      )
      .chain(([nodes, edgeSpecs, trails, ghosts, trailCount]) =>
        fc
          .array(fc.record({ rationale: fc.string(), strength: unit }), {
            minLength: edgeSpecs.length,
            maxLength: edgeSpecs.length,
          })
          .map((extras): MemexGraphState => {
            const edges: AssociativeEdge[] = edgeSpecs.map((s, i) => ({
              id: `e-${i}`,
              source: s.source,
              target: s.target,
              type: "associative",
              data: { origin: s.origin, ...extras[i] },
            }));
            return {
              nodes,
              edges,
              trails: trails.slice(0, trailCount),
              ghostDiscoveries: ghosts as GhostDiscovery[],
            };
          }),
      ),
  );

const deepClone = <T>(v: T): T => structuredClone(v);

// ---------- Properties ----------

describe("Property 1: No Dangling Edges Invariant", () => {
  // **Validates: Requirements 2.3**
  it("removing any subset D purges all edges and trail entries referencing D", () => {
    fc.assert(
      fc.property(
        graphArb,
        fc.array(fc.nat(), { maxLength: 12 }),
        (graph, picks) => {
          const ids = graph.nodes.map((n) => n.id);
          const deleted = new Set(
            ids.length ? picks.map((p) => ids[p % ids.length]) : [],
          );
          const before = deepClone(graph);

          const next = removeNodes(graph, deleted);

          // purity
          expect(graph).toEqual(before);
          // nodes
          expect(next.nodes.some((n) => deleted.has(n.id))).toBe(false);
          expect(next.nodes.length).toBe(graph.nodes.length - deleted.size);
          // edges
          for (const e of next.edges) {
            expect(deleted.has(e.source)).toBe(false);
            expect(deleted.has(e.target)).toBe(false);
          }
          // trails
          for (const t of next.trails) {
            for (const id of t.nodeIds) expect(deleted.has(id)).toBe(false);
          }
          // ghost discoveries
          for (const g of next.ghostDiscoveries) {
            expect(deleted.has(g.sourceId)).toBe(false);
            expect(deleted.has(g.targetId)).toBe(false);
          }
          // surviving edges are exactly those untouched by D
          expect(next.edges).toEqual(
            graph.edges.filter((e) => !deleted.has(e.source) && !deleted.has(e.target)),
          );
          // every remaining reference resolves to a remaining node
          const remaining = new Set(next.nodes.map((n) => n.id));
          for (const e of next.edges) {
            expect(remaining.has(e.source) && remaining.has(e.target)).toBe(true);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("Property 2: Idempotent Link Creation & No Self-Loops", () => {
  // **Validates: Requirements 2.2**
  it("rejects self-loops, leaving the edge set unchanged", () => {
    fc.assert(
      fc.property(graphArb, originArb, fc.nat(), (graph, origin, pick) => {
        fc.pre(graph.nodes.length > 0);
        const id = graph.nodes[pick % graph.nodes.length].id;
        const before = deepClone(graph);
        const next = connectNodes(graph, id, id, origin);
        expect(next.edges).toEqual(graph.edges);
        expect(graph).toEqual(before);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("adding the same (source, target, origin) twice equals adding it once", () => {
    fc.assert(
      fc.property(
        graphArb,
        originArb,
        fc.nat(),
        fc.nat(),
        (graph, origin, a, b) => {
          fc.pre(graph.nodes.length > 0);
          const source = graph.nodes[a % graph.nodes.length].id;
          const target = graph.nodes[b % graph.nodes.length].id;
          const before = deepClone(graph);

          const once = connectNodes(graph, source, target, origin);
          const twice = connectNodes(once, source, target, origin);

          expect(twice.edges.length).toBe(once.edges.length);
          expect(twice.edges).toEqual(once.edges);
          expect(graph).toEqual(before);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("Property 3: Serialization Round-Trip", () => {
  // **Validates: Requirements 3.1**
  it("deserializeGraph(serializeGraph(state)) deep-equals state", () => {
    fc.assert(
      fc.property(graphArb, (state) => {
        expect(deserializeGraph(serializeGraph(state))).toEqual(state);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------- Unit tests for remaining engine functions ----------

describe("graph-engine unit tests", () => {
  const mk = (id: string): MemexNode => ({
    id,
    type: "memexCard",
    position: { x: 0, y: 0 },
    data: {
      archivalId: id,
      title: id,
      content: "",
      cardType: "note",
      tags: [],
      createdAt: "1945-07-01T00:00:00.000Z",
    },
  });
  const base: MemexGraphState = {
    nodes: [mk("a"), mk("b"), mk("c")],
    edges: [],
    trails: [],
    ghostDiscoveries: [],
  };

  it("createTrail drops unknown node IDs", () => {
    const next = createTrail(base, {
      id: "t",
      title: "t",
      description: "",
      origin: "human",
      nodeIds: ["a", "zzz", "b"],
      createdAt: "1945-07-01T00:00:00.000Z",
    });
    expect(next.trails[0].nodeIds).toEqual(["a", "b"]);
  });

  it("connectNodes rejects edges to missing nodes", () => {
    expect(connectNodes(base, "a", "missing", "human").edges).toHaveLength(0);
  });

  it("computeAutoLayout places a chain in increasing columns without mutating input", () => {
    let g = connectNodes(base, "a", "b", "human");
    g = connectNodes(g, "b", "c", "human");
    const before = deepClone(g);
    const laid = computeAutoLayout(g);
    expect(g).toEqual(before);
    expect(laid.nodes.map((n) => n.position.x)).toEqual([0, 460, 920]);
    expect(computeAutoLayout(g)).toEqual(laid);
  });

  it("computeAutoLayout handles cycles", () => {
    let g = connectNodes(base, "a", "b", "human");
    g = connectNodes(g, "b", "a", "human");
    const laid = computeAutoLayout(g);
    expect(laid.nodes).toHaveLength(3);
  });
});
