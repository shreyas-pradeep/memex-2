import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DEFAULT_CARD_SIZE, nodeRect, rectGap, type Rect } from "../card-geometry";
import {
  arxivCassetteId,
  cassetteBounds,
  cassetteFrame,
  groupCassettes,
  moveCassette,
  resolveCassetteId,
} from "../cassette-engine";
import {
  dockForSelection,
  dockReducer,
  resolveDockEscapeOwner,
  resolveDockKey,
  shouldPlaybackHandleKeys,
  type DockEvent,
  type DockKeyEvent,
  type DockState,
  type DockTab,
} from "../command-dock";
import {
  GHOST_CONFIDENCE_MAX,
  GHOST_CONFIDENCE_MIN,
  buildAffinityContext,
  calibrateGhostConfidence,
  detectGhostSynapses,
  pairAffinity,
  scoreGhostPairs,
} from "../ghost-engine";
import { areConnected, connectNodes, serializeGraph, snapConnect } from "../graph-engine";
import { distillSourceText } from "../ingestion-engine";
import {
  MAGNETIC_MIN_AFFINITY,
  MAGNETIC_RANGE_PX,
  buildMagneticCandidates,
  computeMagneticTarget,
  findMagneticTarget,
} from "../magnetic-engine";
import {
  buildObsidianFiles,
  exportObsidianVaultZip,
  sanitizeObsidianFilename,
} from "../obsidian-export";
import {
  SPOTLIGHT_DIM_OPACITY,
  TRAIL_DIM_OPACITY,
  buildTagCloud,
  combinedDimOpacity,
  computeMatchSet,
  filterSignature,
  fuzzyScore,
  isSpotlightActive,
  matchNode,
  matchNodeMemo,
  scoreNodeQuery,
  tokenizeQuery,
  type SpotlightFilters,
} from "../spotlight";
import type {
  AssociativeEdge,
  GhostDiscovery,
  MemexCardType,
  MemexGraphState,
  MemexNode,
  Trail,
} from "../types";
import {
  BUNDLE_SCHEMA,
  BUNDLE_VERSION,
  MAX_BUNDLE_BYTES,
  exportMemexBundle,
  isSafeBundleUrl,
  validateAndImportBundle,
  type GhostBundleSettings,
} from "../vault-bundle";
import { createZip, crc32, isSafeZipPath } from "../zip";
import { demoSeed } from "@/data/demo-seed";

const RUNS = { numRuns: 200 } as const;
const FIXED_AT = "2026-01-02T03:04:05.000Z";

// ---------------------------------------------------------------------------
// Generators: valid graph states (every field the validator knows)
// ---------------------------------------------------------------------------

const text = (max = 40) => fc.string({ unit: "binary", maxLength: max });
const unit = fc.double({ min: 0, max: 1, noNaN: true }).map((n) => n + 0);
const coord = fc.integer({ min: -100_000, max: 100_000 }).map((n) => n + 0);
const isoArb = fc.integer({ min: 0, max: 4_102_444_800_000 }).map((ms) => new Date(ms).toISOString());
const hex = fc
  .integer({ min: 0, max: 0xffffff })
  .map((n) => `#${n.toString(16).padStart(6, "0").toUpperCase()}`);
const dateArb = fc.constantFrom("1945", "1945-07", "1945-07-02", "2024-02-29", "1999-12");
const urlArb = fc.constantFrom(
  "https://example.com/a.png",
  "http://example.org/x?y=1#z",
  "/images/local.png",
  "relative/path.png",
);
const dataUrlArb = fc.constantFrom("data:image/png;base64,iVBORw0KGgo=", "data:image/jpeg;base64,/9j/4AAQ");
const pdfArb = fc.constantFrom("https://arxiv.org/pdf/1706.03762", "/docs/paper.pdf");

const nodeArb = (id: string): fc.Arbitrary<MemexNode> =>
  fc.record(
    {
      id: fc.constant(id),
      type: fc.constant("memexCard" as const),
      position: fc.record({ x: coord, y: coord }),
      style: fc.record({
        width: fc.integer({ min: 1, max: 4000 }),
        height: fc.integer({ min: 1, max: 4000 }),
      }),
      data: fc.record(
        {
          archivalId: text(20),
          title: text(),
          content: text(120),
          cardType: fc.constantFrom<MemexCardType>("note", "quote", "artifact", "ghost"),
          tags: fc.array(text(12), { maxLength: 4 }),
          createdAt: isoArb,
          imageUrl: fc.oneof(urlArb, dataUrlArb),
          confidence: unit,
          date: dateArb,
          year: fc.integer({ min: 0, max: 9999 }),
          source: text(20),
          pdfUrl: pdfArb,
          authors: fc.array(text(20), { maxLength: 3 }),
          cassetteId: fc.string({ minLength: 1, maxLength: 20 }),
          cassetteTitle: text(30),
        },
        { requiredKeys: ["archivalId", "title", "content", "cardType", "tags", "createdAt"] },
      ),
    },
    { requiredKeys: ["id", "type", "position", "data"] },
  );

const settingsArb: fc.Arbitrary<GhostBundleSettings> = fc.record(
  {
    engine: fc.constantFrom("neural" as const, "live" as const),
    threshold: unit,
    dismissedDiscoveryIds: fc.array(fc.string({ maxLength: 12 }), { maxLength: 6 }),
  },
  { requiredKeys: [] },
);

const stateArb: fc.Arbitrary<MemexGraphState> = fc
  .uniqueArray(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 8 })
  .chain((ids) => {
    const pick = ids.length > 0 ? fc.constantFrom(...ids) : fc.constant("");
    const edgeArb = (i: number): fc.Arbitrary<AssociativeEdge> =>
      fc.record(
        {
        id: fc.constant(`e-${i}`),
        source: pick,
        target: pick,
        type: fc.constant("associative" as const),
        style: fc.record({ stroke: hex }),
        data: fc.record(
          {
            origin: fc.constantFrom("human" as const, "ghost" as const),
            rationale: text(60),
            strength: unit,
            trailId: text(8),
            polarity: fc.constantFrom("supports" as const, "refutes" as const, "synthesizes" as const),
            discoveryId: text(8),
          },
          { requiredKeys: ["origin", "rationale", "strength"] },
        ),
        },
        { requiredKeys: ["id", "source", "target", "type", "data"] },
      );
    const trailArb = (i: number): fc.Arbitrary<Trail> =>
      fc.record(
        {
          id: fc.constant(`t-${i}`),
          title: text(),
          description: text(60),
          origin: fc.constantFrom("human" as const, "ghost" as const),
          nodeIds: ids.length > 0 ? fc.array(pick, { maxLength: 6 }) : fc.constant([] as string[]),
          createdAt: isoArb,
          color: hex,
        },
        { requiredKeys: ["id", "title", "description", "origin", "nodeIds", "createdAt"] },
      );
    const discoveryArb = (i: number): fc.Arbitrary<GhostDiscovery> =>
      fc.record(
        {
          id: fc.constant(`gd-${i}`),
          sourceId: pick,
          targetId: pick,
          rationale: text(60),
          confidence: unit,
          trailId: text(8),
          discoveredAt: isoArb,
        },
        { requiredKeys: ["id", "sourceId", "targetId", "rationale", "confidence", "discoveredAt"] },
      );
    const hasIds = ids.length > 0;
    return fc.record({
      nodes: fc.tuple(...ids.map(nodeArb)).map((n) => n as MemexNode[]),
      edges: hasIds
        ? fc.integer({ min: 0, max: 5 }).chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => edgeArb(i))))
        : fc.constant([] as AssociativeEdge[]),
      trails: fc.integer({ min: 0, max: 3 }).chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => trailArb(i)))),
      ghostDiscoveries: hasIds
        ? fc.integer({ min: 0, max: 3 }).chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => discoveryArb(i))))
        : fc.constant([] as GhostDiscovery[]),
    }) as fc.Arbitrary<MemexGraphState>;
  })
  // fast-check may build null-prototype records; a clone gives plain objects.
  .map((s) => structuredClone(s));

/** The same state with the runtime fields React Flow adds (they must not survive an export). */
function withRuntimeFields(s: MemexGraphState): MemexGraphState {
  return {
    ...s,
    nodes: s.nodes.map((n) => ({
      ...n,
      selected: true,
      dragging: true,
      measured: { width: 1, height: 2 },
      resizing: false,
    })),
    edges: s.edges.map((e) => ({ ...e, selected: true })),
  };
}

function normalizeSettings(s: GhostBundleSettings | undefined) {
  return {
    ...(s?.engine !== undefined ? { engine: s.engine } : {}),
    ...(s?.threshold !== undefined ? { threshold: s.threshold } : {}),
    dismissedDiscoveryIds: [...new Set(s?.dismissedDiscoveryIds ?? [])].sort(),
  };
}

// ---------------------------------------------------------------------------
// P1: Vault round-trip invariant
// ---------------------------------------------------------------------------

describe("Property 1: Vault Round-Trip Invariant", () => {
  it("validateAndImportBundle(exportMemexBundle(state)) is ok and deep-equals the state", () => {
    fc.assert(
      fc.property(stateArb, settingsArb, (state, ghostSettings) => {
        const json = exportMemexBundle({ ...withRuntimeFields(state), ghostSettings }, { exportedAt: FIXED_AT });
        const result = validateAndImportBundle(json);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.version).toBe(BUNDLE_VERSION);
        expect(result.state).toStrictEqual(state);
        expect(result.ghostSettings).toStrictEqual(normalizeSettings(ghostSettings));
      }),
      RUNS,
    );
  });

  it("is idempotent: export(import(export(s))) equals export(s)", () => {
    fc.assert(
      fc.property(stateArb, settingsArb, (state, ghostSettings) => {
        const first = exportMemexBundle({ ...state, ghostSettings }, { exportedAt: FIXED_AT });
        const imported = validateAndImportBundle(first);
        expect(imported.ok).toBe(true);
        if (!imported.ok) return;
        const second = exportMemexBundle(
          { ...imported.state, ghostSettings: imported.ghostSettings },
          { exportedAt: FIXED_AT },
        );
        expect(second).toBe(first);
      }),
      RUNS,
    );
  });

  it("imports the legacy plain graph format as version 1.x with a warning", () => {
    fc.assert(
      fc.property(stateArb, (state) => {
        const result = validateAndImportBundle(serializeGraph(state));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.version).toBe("1.x");
        expect(result.state).toStrictEqual(state);
        expect(result.warnings.some((w) => /legacy/i.test(w))).toBe(true);
        expect(result.ghostSettings.dismissedDiscoveryIds).toEqual([]);
      }),
      RUNS,
    );
  });

  it("reads legacy files without trails or discoveries, and the demo seed", () => {
    const bare = JSON.stringify({ nodes: demoSeed.nodes, edges: demoSeed.edges });
    const r = validateAndImportBundle(bare);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.state.trails).toEqual([]);
      expect(r.state.ghostDiscoveries).toEqual([]);
    }
    const seed = validateAndImportBundle(serializeGraph(demoSeed));
    expect(seed.ok).toBe(true);
    if (seed.ok) expect(seed.state).toStrictEqual(demoSeed);
    const bundle = validateAndImportBundle(exportMemexBundle(demoSeed, { exportedAt: FIXED_AT }));
    expect(bundle.ok && bundle.warnings).toEqual([]);
  });

  it("does not mutate its input and output is deterministic with a fixed time", () => {
    fc.assert(
      fc.property(stateArb, (state) => {
        const before = structuredClone(state);
        const a = exportMemexBundle(state, { exportedAt: FIXED_AT });
        expect(state).toStrictEqual(before);
        expect(exportMemexBundle(state, { exportedAt: FIXED_AT })).toBe(a);
        const parsed = JSON.parse(a) as Record<string, unknown>;
        expect(Object.keys(parsed)).toEqual([
          "schema", "version", "exportedAt", "cards", "edges", "trails", "ghostDiscoveries", "ghostSettings",
        ]);
        expect(parsed.schema).toBe(BUNDLE_SCHEMA);
      }),
      RUNS,
    );
  });
});

// ---------------------------------------------------------------------------
// Bundle validation: hostile and malformed input
// ---------------------------------------------------------------------------

function sampleState(): MemexGraphState {
  const mk = (id: string, x: number): MemexNode => ({
    id,
    type: "memexCard",
    position: { x, y: 0 },
    style: { width: 300, height: 200 },
    data: { archivalId: `MEM-${id}`, title: `Title ${id}`, content: "body", cardType: "note", tags: ["a"], createdAt: FIXED_AT },
  });
  return {
    nodes: [mk("a", 0), mk("b", 500)],
    edges: [{ id: "e1", source: "a", target: "b", type: "associative", data: { origin: "human", rationale: "r", strength: 0.5 } }],
    trails: [{ id: "t1", title: "T", description: "", origin: "human", nodeIds: ["a", "b"], createdAt: FIXED_AT }],
    ghostDiscoveries: [],
  };
}

function bundleOf(mutate: (b: Record<string, unknown>) => void): string {
  const b = JSON.parse(exportMemexBundle(sampleState(), { exportedAt: FIXED_AT })) as Record<string, unknown>;
  mutate(b);
  return JSON.stringify(b);
}

function expectRejected(json: string, pattern?: RegExp): string[] {
  let result: ReturnType<typeof validateAndImportBundle> | undefined;
  expect(() => {
    result = validateAndImportBundle(json);
  }).not.toThrow();
  expect(result?.ok).toBe(false);
  const errors = result !== undefined && !result.ok ? result.errors : [];
  expect(errors.length).toBeGreaterThan(0);
  if (pattern !== undefined) expect(errors.join("\n")).toMatch(pattern);
  return errors;
}

describe("validateAndImportBundle: malformed bundles", () => {
  it("accepts the sample", () => {
    expect(validateAndImportBundle(bundleOf(() => undefined)).ok).toBe(true);
  });

  it("never throws and always returns ok:false for arbitrary garbage", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ unit: "binary" }), fc.json(), fc.constant("null"), fc.constant("[]")), (input) => {
        const result = validateAndImportBundle(input);
        if (!result.ok) expect(result.errors.length).toBeGreaterThan(0);
      }),
      RUNS,
    );
    expect(() => validateAndImportBundle(undefined as unknown as string)).not.toThrow();
  });

  it("rejects bad JSON, non-objects, wrong schema and unsupported versions", () => {
    expectRejected("{not json", /not valid JSON/i);
    expectRejected("[1,2]", /object/i);
    expectRejected("42", /object/i);
    expectRejected(bundleOf((b) => (b.schema = "other")), /schema/i);
    expectRejected(bundleOf((b) => (b.version = "3.0")), /version/i);
    expectRejected(bundleOf((b) => delete b.version), /version/i);
    expectRejected(JSON.stringify({ hello: "world" }), /not a Memex/i);
  });

  it("warns (does not reject) for a newer 2.x minor version", () => {
    const r = validateAndImportBundle(bundleOf((b) => (b.version = "2.3")));
    expect(r.ok && r.warnings.join(" ")).toMatch(/newer/);
  });

  it("rejects oversized input", () => {
    expectRejected("x".repeat(MAX_BUNDLE_BYTES + 1), /too large/i);
    // Under the character limit but over the byte limit (3 bytes per character).
    expectRejected(`"${"€".repeat(Math.ceil(MAX_BUNDLE_BYTES / 3) + 10)}"`, /too large/i);
  });

  it("rejects too many cards, edges and trails", () => {
    const card = sampleState().nodes[0];
    expectRejected(bundleOf((b) => (b.cards = Array.from({ length: 2001 }, () => card))), /too many/i);
    expectRejected(bundleOf((b) => (b.edges = Array.from({ length: 10_001 }, () => ({})))), /too many/i);
    expectRejected(bundleOf((b) => (b.trails = Array.from({ length: 501 }, () => ({})))), /too many/i);
  });

  it("rejects prototype-pollution keys anywhere, and does not pollute", () => {
    const hostile = [
      '{"__proto__": {"polluted": true}, "schema": "memex-bundle", "version": "2.0"}',
      bundleOf((b) => ((b.cards as Record<string, unknown>[])[0].data = JSON.parse('{"__proto__": {"x": 1}}'))),
    ];
    for (const json of hostile) expectRejected(json, /forbidden key/i);
    const nested = bundleOf((b) => {
      (b.cards as { data: Record<string, unknown> }[])[0].data.tags = [JSON.parse('{"constructor": {"prototype": {"x": 1}}}')];
    });
    expectRejected(nested, /forbidden key "constructor"/i);
    expectRejected(
      bundleOf((b) => ((b.ghostSettings as Record<string, unknown>).prototype = 1)),
      /forbidden key "prototype"/i,
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it("rejects unsafe image and pdf URLs, accepts safe ones", () => {
    const setUrl = (key: "imageUrl" | "pdfUrl", url: string) =>
      bundleOf((b) => ((b.cards as { data: Record<string, unknown> }[])[0].data[key] = url));
    for (const bad of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "vbscript:msgbox(1)",
      "java\tscript:alert(1)",
      " javascript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "data:image/svg+xml;base64,PHN2Zz4=",
      "file:///etc/passwd",
      "ftp://example.com/x.png",
    ]) {
      expectRejected(setUrl("imageUrl", bad), /safe URL/i);
    }
    expectRejected(setUrl("pdfUrl", "data:image/png;base64,AAAA"), /safe URL/i);
    for (const ok of ["https://example.com/a.png", "/rel/a.png", "data:image/png;base64,AAAA"]) {
      expect(validateAndImportBundle(setUrl("imageUrl", ok)).ok).toBe(true);
    }
    expect(isSafeBundleUrl("//cdn.example.com/a.png", false)).toBe(true);
    expect(isSafeBundleUrl("https://", false)).toBe(false);
  });

  it("rejects dangling edges, trail stops and discoveries with a clear error", () => {
    const edge = bundleOf((b) => ((b.edges as { target: string }[])[0].target = "ghost-card"));
    expectRejected(edge, /Edge "e1" points at a card that is not in the file/);
    expectRejected(bundleOf((b) => ((b.trails as { nodeIds: string[] }[])[0].nodeIds = ["a", "zzz"])), /Trail "t1" lists a card/);
    expectRejected(
      bundleOf(
        (b) =>
          (b.ghostDiscoveries = [
            { id: "gd1", sourceId: "a", targetId: "nope", rationale: "", confidence: 0.9, discoveredAt: FIXED_AT },
          ]),
      ),
      /discovery "gd1"/i,
    );
  });

  it("rejects duplicate ids", () => {
    expectRejected(bundleOf((b) => ((b.cards as unknown[]).push((b.cards as unknown[])[0]))), /Duplicate card id "a"/);
    expectRejected(bundleOf((b) => ((b.edges as unknown[]).push((b.edges as unknown[])[0]))), /Duplicate edge id/);
    expectRejected(bundleOf((b) => ((b.trails as unknown[]).push((b.trails as unknown[])[0]))), /Duplicate trail id/);
  });

  it("rejects non-finite or out-of-range numbers and bad enums", () => {
    // JSON cannot hold NaN; a null stands in for a serialized NaN, and strings for bad numbers.
    for (const bad of [null, "12", 1e12, Number.MAX_VALUE]) {
      expectRejected(bundleOf((b) => ((b.cards as { position: Record<string, unknown> }[])[0].position.x = bad)), /position\.x/);
    }
    expectRejected(bundleOf((b) => ((b.cards as { style: Record<string, unknown> }[])[0].style.width = -5)), /style\.width/);
    expectRejected(bundleOf((b) => ((b.cards as { style: Record<string, unknown> }[])[0].style.height = 0)), /style\.height/);
    const setData = (key: string, value: unknown) =>
      bundleOf((b) => ((b.cards as { data: Record<string, unknown> }[])[0].data[key] = value));
    expectRejected(setData("cardType", "wizard"), /cardType/);
    expectRejected(setData("year", 19.5), /year/);
    expectRejected(setData("year", 99999), /year/);
    expectRejected(setData("date", "2023-02-30"), /date/);
    expectRejected(setData("createdAt", "not a date"), /createdAt/);
    expectRejected(setData("tags", "a,b"), /tags/);
    expectRejected(setData("tags", [1]), /tags/);
    expectRejected(setData("authors", [1]), /authors/);
    expectRejected(setData("confidence", 2), /confidence/);
    expectRejected(setData("cassetteId", 7), /cassetteId/);
    expectRejected(setData("title", "x".repeat(2001)), /too long/);
    expectRejected(bundleOf((b) => ((b.edges as { data: Record<string, unknown> }[])[0].data.strength = 1.5)), /strength/);
    expectRejected(bundleOf((b) => ((b.edges as { data: Record<string, unknown> }[])[0].data.polarity = "meh")), /polarity/);
    expectRejected(bundleOf((b) => ((b.cards as Record<string, unknown>[])[0].type = "other")), /type/);
  });

  it("reports several problems at once, capped", () => {
    const errors = expectRejected(
      bundleOf((b) => {
        b.cards = Array.from({ length: 60 }, (_, i) => ({ id: `c${i}` }));
      }),
    );
    expect(errors.length).toBeLessThanOrEqual(27);
    expect(errors.length).toBeGreaterThan(5);
  });

  it("drops unknown fields with one warning, normalizes bad colors with a warning", () => {
    const r = validateAndImportBundle(
      bundleOf((b) => {
        b.extra = 1;
        (b.cards as Record<string, unknown>[])[0].zIndex = 3;
        ((b.cards as { data: Record<string, unknown> }[])[0].data).apiKey = "SECRET";
        (b.trails as Record<string, unknown>[])[0].color = "red";
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings.join("\n")).toMatch(/3 unknown fields were ignored/);
    expect(r.warnings.join("\n")).toMatch(/color/);
    expect(JSON.stringify(r.state)).not.toContain("SECRET");
    expect("color" in r.state.trails[0]).toBe(false);
  });

  it("does not mutate the input string (strings are immutable) and builds clean objects", () => {
    const r = validateAndImportBundle(bundleOf(() => undefined));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.getPrototypeOf(r.state.nodes[0].data)).toBe(Object.prototype);
  });
});

describe("exportMemexBundle never carries secrets", () => {
  it("drops an API key put anywhere in the input", () => {
    const key = "AIzaSyDUMMY-SECRET-KEY-1234567890";
    const state = sampleState();
    const poisoned = {
      ...state,
      apiKey: key,
      geminiKey: key,
      nodes: state.nodes.map((n) => ({ ...n, apiKey: key, data: { ...n.data, apiKey: key, key } })),
      edges: state.edges.map((e) => ({ ...e, key })),
      ghostSettings: { engine: "live" as const, threshold: 0.3, dismissedDiscoveryIds: ["x"], apiKey: key },
    } as unknown as GhostBundleSettings & MemexGraphState;
    const json = exportMemexBundle(poisoned as never, { exportedAt: FIXED_AT });
    expect(json).not.toContain(key);
    const names: string[] = [];
    JSON.stringify(JSON.parse(json), (k, v: unknown) => (names.push(k), v));
    expect(names.filter((n) => /api.?key|^key$|secret|token|gemini/i.test(n))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Pair affinity: shares the scan's numbers
// ---------------------------------------------------------------------------

const POOLS: { words: string[]; tags: string[] }[] = [
  { words: ["hypertext", "associative", "trail", "memex", "network", "links"], tags: ["hypertext", "memory"] },
  { words: ["attention", "transformer", "query", "retrieval", "lookup", "scaled"], tags: ["attention", "retrieval"] },
  { words: ["banana", "recipe", "flour", "oven", "sugar", "butter"], tags: ["cooking"] },
  { words: ["granite", "quarry", "basalt", "erosion", "sediment", "strata"], tags: ["geology"] },
];

function cardOf(id: string, pool: number, variant: number, x: number, y: number, size?: { width: number; height: number }): MemexNode {
  const p = POOLS[pool];
  const words = p.words.map((w, i) => (i % 2 === variant % 2 ? w : p.words[(i + 1) % p.words.length]));
  return {
    id,
    type: "memexCard",
    position: { x, y },
    ...(size !== undefined ? { style: size } : {}),
    data: {
      archivalId: `MEM-${id}`,
      title: `${words[0]} ${words[1]} study`,
      content: `${words.join(" ")} ${words[2]} ${words[3]}`,
      cardType: "note",
      tags: p.tags,
      createdAt: FIXED_AT,
    },
  };
}

describe("pairAffinity (ghost-engine)", () => {
  const corpusArb = fc
    .array(fc.record({ pool: fc.integer({ min: 0, max: 3 }), variant: fc.integer({ min: 0, max: 5 }) }), { minLength: 2, maxLength: 7 })
    .map((specs) => specs.map((s, i) => cardOf(`c${i}`, s.pool, s.variant, i * 10, 0)));

  it("matches scoreGhostPairs and detectGhostSynapses exactly, in either argument order", () => {
    fc.assert(
      fc.property(corpusArb, (nodes) => {
        const ctx = buildAffinityContext(nodes);
        const byId = new Map(nodes.map((n) => [n.id, n]));
        for (const pair of scoreGhostPairs(nodes)) {
          const a = byId.get(pair.sourceId) as MemexNode;
          const b = byId.get(pair.targetId) as MemexNode;
          const ab = pairAffinity(a, b, ctx);
          const ba = pairAffinity(b, a, ctx);
          expect(ab.score).toBe(pair.score);
          expect(ba).toEqual(ab);
          expect(ab.sharedConcepts).toEqual(pair.sharedConcepts);
        }
        const found = detectGhostSynapses(nodes, [], 0.3, { maxResults: 1000 });
        for (const d of found) {
          const ab = pairAffinity(byId.get(d.sourceId) as MemexNode, byId.get(d.targetId) as MemexNode, ctx);
          expect(ab.affinity).toBe(d.confidence);
        }
        const foundIds = new Set(found.map((d) => `${d.sourceId}|${d.targetId}`));
        for (const pair of scoreGhostPairs(nodes)) {
          const a = pairAffinity({ id: pair.sourceId }, { id: pair.targetId }, ctx);
          expect(a.affinity > 0).toBe(foundIds.has(`${pair.sourceId}|${pair.targetId}`));
          if (a.affinity > 0) {
            expect(a.affinity).toBeGreaterThanOrEqual(GHOST_CONFIDENCE_MIN);
            expect(a.affinity).toBeLessThanOrEqual(GHOST_CONFIDENCE_MAX);
            expect(a.affinity).toBe(calibrateGhostConfidence(a.score));
          }
        }
      }),
      RUNS,
    );
  });

  it("is zero for a card with itself or a card outside the corpus", () => {
    const nodes = [cardOf("a", 0, 0, 0, 0), cardOf("b", 0, 1, 0, 0)];
    const ctx = buildAffinityContext(nodes);
    expect(pairAffinity(nodes[0], nodes[0], ctx).affinity).toBe(0);
    expect(pairAffinity(nodes[0], { id: "zzz" }, ctx).affinity).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// P2: Magnetic threshold invariant
// ---------------------------------------------------------------------------

/** Independent oracle: affinity from the public scan, gap from plain arithmetic. */
function oracleAffinity(nodes: readonly MemexNode[], aId: string, bId: string): number {
  const [lo, hi] = aId <= bId ? [aId, bId] : [bId, aId];
  const pair = scoreGhostPairs(nodes).find((p) => p.sourceId === lo && p.targetId === hi);
  if (pair === undefined || pair.score <= 0 || pair.score < 0.3) return 0;
  return calibrateGhostConfidence(pair.score);
}

function sizeOf(n: MemexNode): { w: number; h: number } {
  return {
    w: typeof n.style?.width === "number" ? n.style.width : DEFAULT_CARD_SIZE.width,
    h: typeof n.style?.height === "number" ? n.style.height : DEFAULT_CARD_SIZE.height,
  };
}

function oracleGap(a: MemexNode, b: MemexNode): number {
  const sa = sizeOf(a);
  const sb = sizeOf(b);
  const dx = Math.max(0, b.position.x - (a.position.x + sa.w), a.position.x - (b.position.x + sb.w));
  const dy = Math.max(0, b.position.y - (a.position.y + sa.h), a.position.y - (b.position.y + sb.h));
  return Math.sqrt(dx * dx + dy * dy);
}

interface Scene {
  nodes: MemexNode[];
  edges: AssociativeEdge[];
}

const sceneArb: fc.Arbitrary<Scene> = fc
  .array(
    fc.record({
      pool: fc.integer({ min: 0, max: 3 }),
      variant: fc.integer({ min: 0, max: 5 }),
      x: fc.integer({ min: -900, max: 900 }),
      y: fc.integer({ min: -700, max: 700 }),
      size: fc.option(fc.record({ width: fc.integer({ min: 200, max: 500 }), height: fc.integer({ min: 120, max: 400 }) }), { nil: undefined }),
    }),
    { minLength: 2, maxLength: 7 },
  )
  .chain((specs) => {
    const nodes = specs.map((s, i) => cardOf(`c${i}`, s.pool, s.variant, s.x, s.y, s.size));
    return fc
      .array(fc.tuple(fc.integer({ min: 0, max: nodes.length - 1 }), fc.integer({ min: 0, max: nodes.length - 1 })), { maxLength: 3 })
      .map((pairs) => ({
        nodes,
        edges: pairs
          .filter(([a, b]) => a !== b)
          .map(([a, b], i): AssociativeEdge => ({
            id: `e${i}`,
            source: `c${a}`,
            target: `c${b}`,
            type: "associative",
            data: { origin: "human", rationale: "", strength: 0.5 },
          })),
      }));
  });

describe("Property 2: Magnetic Threshold Invariant", () => {
  it("snaps only to unconnected cards within the rectangle-gap range and affinity >= 0.70, nearest first", () => {
    let withTarget = 0;
    let withoutTarget = 0;
    fc.assert(
      fc.property(sceneArb, ({ nodes, edges }) => {
        for (const dragged of nodes) {
          const target = computeMagneticTarget(dragged.id, nodes, edges);
          const eligible = nodes
            .filter((o) => o.id !== dragged.id)
            .filter((o) => !edges.some((e) => (e.source === dragged.id && e.target === o.id) || (e.source === o.id && e.target === dragged.id)))
            .map((o) => ({ o, affinity: oracleAffinity(nodes, dragged.id, o.id), gap: oracleGap(dragged, o) }))
            .filter((c) => c.affinity >= MAGNETIC_MIN_AFFINITY && c.gap < MAGNETIC_RANGE_PX)
            .sort((p, q) => p.gap - q.gap || q.affinity - p.affinity || (p.o.id < q.o.id ? -1 : 1));
          if (eligible.length === 0) {
            expect(target).toBeNull();
            withoutTarget++;
            continue;
          }
          withTarget++;
          expect(target).not.toBeNull();
          if (target === null) continue;
          expect(target.sourceId).toBe(dragged.id);
          expect(target.targetId).toBe(eligible[0].o.id);
          expect(target.affinity).toBe(eligible[0].affinity);
          expect(target.targetId).not.toBe(target.sourceId);
          expect(areConnected(edges, target.sourceId, target.targetId)).toBe(false);
          expect(target.rationale.length).toBeGreaterThan(0);
          expect(target.concept.length).toBeGreaterThan(0);
        }
      }),
      RUNS,
    );
    // Both branches were really exercised.
    expect(withTarget).toBeGreaterThan(50);
    expect(withoutTarget).toBeGreaterThan(50);
  });

  it("never offers a target when the dragged card is moved out of range", () => {
    fc.assert(
      fc.property(sceneArb, fc.integer({ min: 0, max: 2000 }), ({ nodes, edges }, extra) => {
        for (const dragged of nodes) {
          const others = nodes.filter((o) => o.id !== dragged.id);
          const rightEdge = Math.max(...others.map((o) => o.position.x + sizeOf(o).w));
          const moved = nodes.map((n) =>
            n.id === dragged.id ? { ...n, position: { x: rightEdge + MAGNETIC_RANGE_PX + extra, y: n.position.y } } : n,
          );
          expect(computeMagneticTarget(dragged.id, moved, edges)).toBeNull();
        }
      }),
      RUNS,
    );
  });

  it("uses a strict range: a gap of exactly 260 does not snap, 259.9 does", () => {
    const a = cardOf("a", 0, 0, 0, 0);
    const b = (gap: number) => cardOf("b", 0, 1, DEFAULT_CARD_SIZE.width + gap, 0);
    expect(computeMagneticTarget("a", [a, b(MAGNETIC_RANGE_PX)], [])).toBeNull();
    expect(computeMagneticTarget("a", [a, b(MAGNETIC_RANGE_PX - 0.1)], [])?.targetId).toBe("b");
    // Overlapping cards (gap 0) with centers far under 260 apart still snap.
    expect(computeMagneticTarget("a", [a, cardOf("b", 0, 1, 50, 20)], [])?.targetId).toBe("b");
  });

  it("measures the gap between rectangles, not between centers", () => {
    const a = cardOf("a", 0, 0, 0, 0);
    // Centers 500 apart (> 260) but rectangles only 160 apart.
    const b = cardOf("b", 0, 1, DEFAULT_CARD_SIZE.width + 160, 0);
    expect(Math.abs(a.position.x + 170 - (b.position.x + 170))).toBeGreaterThan(MAGNETIC_RANGE_PX);
    expect(computeMagneticTarget("a", [a, b], [])?.targetId).toBe("b");
  });

  it("picks the nearest candidate, then the higher affinity, then the smaller id", () => {
    const a = cardOf("a", 0, 0, 0, 0);
    const near = cardOf("near", 0, 1, 340 + 40, 0);
    const far = cardOf("far", 0, 1, 340 + 200, 0);
    expect(computeMagneticTarget("a", [a, far, near], [])?.targetId).toBe("near");
    // Equal gaps on both sides: smaller id wins when affinities tie.
    const left = cardOf("m-left", 0, 1, -340 - 100, 0);
    const right = cardOf("m-right", 0, 1, 340 + 100, 0);
    const ctx = [a, right, left];
    const candidates = buildMagneticCandidates("a", ctx, []);
    const picked = findMagneticTarget({ x: 0, y: 0, width: 340, height: 230 }, candidates, ctx);
    const best = candidates.filter((c) => ["m-left", "m-right"].includes(c.targetId)).sort((p, q) => q.affinity - p.affinity || (p.targetId < q.targetId ? -1 : 1))[0];
    expect(picked?.targetId).toBe(best.targetId);
  });

  it("excludes self, connected pairs (either direction), unrelated cards and missing cards", () => {
    const a = cardOf("a", 0, 0, 0, 0);
    const b = cardOf("b", 0, 1, 400, 0);
    const c = cardOf("c", 2, 0, 400, 300);
    const edge = (source: string, target: string): AssociativeEdge => ({
      id: "e", source, target, type: "associative", data: { origin: "ghost", rationale: "", strength: 0.1 },
    });
    expect(buildMagneticCandidates("a", [a, b, c], []).map((x) => x.targetId)).toEqual(["b"]);
    expect(buildMagneticCandidates("a", [a, b, c], [edge("a", "b")])).toEqual([]);
    expect(buildMagneticCandidates("a", [a, b, c], [edge("b", "a")])).toEqual([]);
    expect(buildMagneticCandidates("missing", [a, b, c], [])).toEqual([]);
    expect(computeMagneticTarget("missing", [a, b], [])).toBeNull();
    expect(buildMagneticCandidates("a", [a, b, c], []).every((x) => x.targetId !== "a")).toBe(true);
    // A card whose target is missing from the lookup is skipped, not a crash.
    const cands = buildMagneticCandidates("a", [a, b], []);
    expect(findMagneticTarget({ x: 0, y: 0, width: 340, height: 230 }, cands, new Map())).toBeNull();
  });

  it("is deterministic and does not mutate nodes", () => {
    fc.assert(
      fc.property(sceneArb, ({ nodes, edges }) => {
        const before = structuredClone(nodes);
        const first = computeMagneticTarget(nodes[0].id, nodes, edges);
        expect(computeMagneticTarget(nodes[0].id, nodes, edges)).toEqual(first);
        expect(nodes).toEqual(before);
      }),
      RUNS,
    );
  });

  it("a snap connects exactly once, consumes the pair's discovery and never duplicates", () => {
    const a = cardOf("a", 0, 0, 0, 0);
    const b = cardOf("b", 0, 1, 400, 0);
    const state: MemexGraphState = {
      nodes: [a, b],
      edges: [],
      trails: [],
      ghostDiscoveries: [
        { id: "gd-x", sourceId: "b", targetId: "a", rationale: "r", confidence: 0.9, discoveredAt: FIXED_AT },
        { id: "gd-other", sourceId: "a", targetId: "zz", rationale: "r", confidence: 0.9, discoveredAt: FIXED_AT },
      ],
    };
    const snapped = snapConnect(state, "a", "b", { rationale: "why", strength: 0.9 });
    expect(snapped.edges).toHaveLength(1);
    expect(snapped.edges[0]).toMatchObject({ source: "a", target: "b", data: { origin: "human", rationale: "why", strength: 0.9 } });
    expect(snapped.ghostDiscoveries.map((g) => g.id)).toEqual(["gd-other"]);
    expect(snapConnect(snapped, "a", "b", { rationale: "again", strength: 1 })).toBe(snapped);
    expect(snapConnect(snapped, "b", "a", { rationale: "again", strength: 1 })).toBe(snapped);
    expect(snapConnect(state, "a", "a", { rationale: "", strength: 1 })).toBe(state);
    expect(snapConnect(state, "a", "missing", { rationale: "", strength: 1 })).toBe(state);
    expect(connectNodes(state, "a", "b", "human").edges).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// P3: Cassette bounding invariant
// ---------------------------------------------------------------------------

const wild = fc.oneof(
  fc.integer({ min: -1_000_000, max: 1_000_000 }),
  fc.double({ min: -1e6, max: 1e6, noNaN: true }),
  fc.constantFrom(0, -0, NaN, Infinity, -Infinity, 1e300, -1e300),
);
const rectArb: fc.Arbitrary<Rect> = fc.record({
  x: wild,
  y: wild,
  width: fc.oneof(fc.integer({ min: 0, max: 2000 }), wild),
  height: fc.oneof(fc.integer({ min: 0, max: 2000 }), wild),
});

function validRect(r: Rect): boolean {
  return [r.x, r.y, r.width, r.height].every((n) => Number.isFinite(n) && Math.abs(n) <= 1e9) && r.width >= 0 && r.height >= 0;
}

describe("Property 3: Cassette Bounding Invariant", () => {
  it("cassetteBounds strictly encloses every valid member rectangle with non-negative size", () => {
    fc.assert(
      fc.property(fc.array(rectArb, { maxLength: 8 }), fc.integer({ min: 1, max: 200 }), (rects, padding) => {
        const valid = rects.filter(validRect);
        const b = cassetteBounds(rects, padding);
        if (valid.length === 0) {
          expect(b).toBeNull();
          return;
        }
        expect(b).not.toBeNull();
        if (b === null) return;
        expect(b.width).toBeGreaterThanOrEqual(0);
        expect(b.height).toBeGreaterThanOrEqual(0);
        for (const r of valid) {
          // All four corners lie strictly inside the frame.
          for (const [cx, cy] of [[r.x, r.y], [r.x + r.width, r.y], [r.x, r.y + r.height], [r.x + r.width, r.y + r.height]]) {
            expect(cx).toBeGreaterThan(b.x);
            expect(cx).toBeLessThan(b.x + b.width);
            expect(cy).toBeGreaterThan(b.y);
            expect(cy).toBeLessThan(b.y + b.height);
          }
        }
      }),
      RUNS,
    );
  });

  it("with padding 0 (or an invalid padding) the frame still contains every rectangle", () => {
    fc.assert(
      fc.property(fc.array(rectArb, { maxLength: 8 }), fc.constantFrom(0, -5, NaN, Infinity), (rects, padding) => {
        const b = cassetteBounds(rects, padding);
        for (const r of rects.filter(validRect)) {
          expect(b).not.toBeNull();
          if (b === null) continue;
          const eps = 1e-6;
          expect(b.x).toBeLessThanOrEqual(r.x + eps);
          expect(b.y).toBeLessThanOrEqual(r.y + eps);
          expect(b.x + b.width).toBeGreaterThanOrEqual(r.x + r.width - eps);
          expect(b.y + b.height).toBeGreaterThanOrEqual(r.y + r.height - eps);
        }
      }),
      RUNS,
    );
  });

  it("defaults to 24px padding and ignores NaN rects", () => {
    expect(cassetteBounds([{ x: 0, y: 0, width: 100, height: 50 }])).toEqual({ x: -24, y: -24, width: 148, height: 98 });
    expect(cassetteBounds([{ x: NaN, y: 0, width: 1, height: 1 }, { x: 10, y: 10, width: 0, height: 0 }])).toEqual({ x: -14, y: -14, width: 48, height: 48 });
    expect(cassetteBounds([])).toBeNull();
    expect(cassetteBounds([{ x: 0, y: 0, width: -1, height: 1 }])).toBeNull();
  });

  const cassetteNodesArb = fc.array(
    fc.record({
      x: fc.integer({ min: -5000, max: 5000 }),
      y: fc.integer({ min: -5000, max: 5000 }),
      cassette: fc.constantFrom("c1", "c2", undefined),
    }),
    { maxLength: 10 },
  ).map((specs) =>
    specs.map((s, i): MemexNode => ({
      id: `n${i}`,
      type: "memexCard",
      position: { x: s.x, y: s.y },
      data: {
        archivalId: `MEM-${i}`, title: "t", content: "c", cardType: "note", tags: [], createdAt: FIXED_AT,
        ...(s.cassette !== undefined ? { cassetteId: s.cassette, cassetteTitle: `Title ${s.cassette}` } : {}),
      },
    })),
  );

  it("moveCassette shifts members by the delta, preserves relative offsets and leaves others alone", () => {
    fc.assert(
      fc.property(cassetteNodesArb, fc.integer({ min: -3000, max: 3000 }), fc.integer({ min: -3000, max: 3000 }), (nodes, dx, dy) => {
        const moved = moveCassette(nodes, "c1", dx, dy);
        const members = nodes.filter((n) => n.data.cassetteId === "c1");
        if (members.length === 0 || (dx === 0 && dy === 0)) {
          expect(moved).toBe(nodes);
          return;
        }
        expect(moved).toHaveLength(nodes.length);
        nodes.forEach((n, i) => {
          if (n.data.cassetteId === "c1") {
            expect(moved[i].position).toEqual({ x: n.position.x + dx, y: n.position.y + dy });
          } else {
            expect(moved[i]).toBe(n);
          }
        });
        for (const a of members) {
          for (const b of members) {
            const ma = moved.find((n) => n.id === a.id) as MemexNode;
            const mb = moved.find((n) => n.id === b.id) as MemexNode;
            expect(mb.position.x - ma.position.x).toBe(b.position.x - a.position.x);
            expect(mb.position.y - ma.position.y).toBe(b.position.y - a.position.y);
          }
        }
        // The frame moves with its members.
        const f0 = cassetteFrame(nodes, "c1");
        const f1 = cassetteFrame(moved, "c1");
        expect(f1).toEqual({ x: (f0 as Rect).x + dx, y: (f0 as Rect).y + dy, width: (f0 as Rect).width, height: (f0 as Rect).height });
      }),
      RUNS,
    );
  });

  it("moveCassette ignores non-finite deltas and unknown cassettes", () => {
    fc.assert(
      fc.property(cassetteNodesArb, fc.constantFrom(NaN, Infinity, -Infinity), (nodes, bad) => {
        expect(moveCassette(nodes, "c1", bad, 5)).toBe(nodes);
        expect(moveCassette(nodes, "c1", 5, bad)).toBe(nodes);
        expect(moveCassette(nodes, "nope", 5, 5)).toBe(nodes);
      }),
      RUNS,
    );
  });

  it("groupCassettes returns only populated cassettes, sorted by id, with member ids sorted", () => {
    fc.assert(
      fc.property(cassetteNodesArb, (nodes) => {
        const groups = groupCassettes(nodes);
        expect(groups.map((g) => g.id)).toEqual([...groups.map((g) => g.id)].sort());
        for (const g of groups) {
          expect(g.memberIds.length).toBeGreaterThan(0);
          expect(g.memberIds).toEqual([...g.memberIds].sort());
          expect(g.title).toBe(`Title ${g.id}`);
          expect(g.memberIds.length).toBe(nodes.filter((n) => n.data.cassetteId === g.id).length);
        }
        expect(groups.reduce((n, g) => n + g.memberIds.length, 0)).toBe(nodes.filter((n) => n.data.cassetteId !== undefined).length);
      }),
      RUNS,
    );
  });

  it("nodeRect prefers style, then attributes, then measured, then the default size", () => {
    const base = { position: { x: 1, y: 2 } };
    expect(nodeRect({ ...base })).toEqual({ x: 1, y: 2, width: 340, height: 230 });
    expect(nodeRect({ ...base, style: { width: 100, height: 50 }, width: 9, height: 9 })).toEqual({ x: 1, y: 2, width: 100, height: 50 });
    expect(nodeRect({ ...base, width: 120, height: 60 })).toEqual({ x: 1, y: 2, width: 120, height: 60 });
    expect(nodeRect({ ...base, measured: { width: 130, height: 70 } })).toEqual({ x: 1, y: 2, width: 130, height: 70 });
    expect(nodeRect({ position: { x: NaN, y: 0 } })).toBeNull();
    expect(rectGap({ x: 0, y: 0, width: 10, height: 10 }, { x: 13, y: 14, width: 5, height: 5 })).toBe(5);
    expect(rectGap({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 5, height: 5 })).toBe(0);
  });
});

describe("cassette ingestion", () => {
  const source = "Attention mechanisms let models weigh tokens. Transformers use scaled dot-product attention in 2017. They run 3.5x faster than recurrent models on 8 GPUs.";

  it("gives every generated card one cassette id and title", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), fc.string({ minLength: 1, maxLength: 300 }), (title, body) => {
        const { nodes } = distillSourceText(title, body, { x: 0, y: 0 });
        const ids = new Set(nodes.map((n) => n.data.cassetteId));
        const titles = new Set(nodes.map((n) => n.data.cassetteTitle));
        expect(ids.size).toBe(1);
        expect(titles.size).toBe(1);
        const id = [...ids][0] as string;
        expect(id).toMatch(/^cassette-[0-9a-f]{8}$/);
        expect(nodes[0].id).toContain(id.replace("cassette-", ""));
        expect(([...titles][0] as string).length).toBeLessThanOrEqual(80);
      }),
      RUNS,
    );
  });

  it("uses the arXiv id when provided and is collision-safe against existing cassettes", () => {
    expect(arxivCassetteId("1706.03762v5")).toBe("cassette-1706.03762");
    expect(arxivCassetteId("cs/0112017")).toBe("cassette-cs-0112017");
    const first = distillSourceText("Attention Is All You Need", source, { x: 0, y: 0 }, { cassetteId: arxivCassetteId("1706.03762") });
    expect(first.nodes.every((n) => n.data.cassetteId === "cassette-1706.03762")).toBe(true);
    // Same source again: same cassette.
    const again = distillSourceText("Attention Is All You Need", source, { x: 0, y: 0 }, {
      cassetteId: "cassette-1706.03762",
      existingCassettes: [{ id: "cassette-1706.03762", title: "Attention Is All You Need" }],
    });
    expect(again.nodes[0].data.cassetteId).toBe("cassette-1706.03762");
    // A different source on the same id gets -2, then -3.
    const other = distillSourceText("A Different Paper", source, { x: 0, y: 0 }, {
      cassetteId: "cassette-1706.03762",
      existingCassettes: [{ id: "cassette-1706.03762", title: "Attention Is All You Need" }],
    });
    expect(other.nodes[0].data.cassetteId).toBe("cassette-1706.03762-2");
    const third = distillSourceText("Yet Another", source, { x: 0, y: 0 }, {
      cassetteId: "cassette-1706.03762",
      existingCassettes: [
        { id: "cassette-1706.03762", title: "Attention Is All You Need" },
        { id: "cassette-1706.03762-2", title: "A Different Paper" },
      ],
    });
    expect(third.nodes[0].data.cassetteId).toBe("cassette-1706.03762-3");
    expect(resolveCassetteId("x", "t", [])).toBe("x");
  });
});

// ---------------------------------------------------------------------------
// ZIP and Obsidian
// ---------------------------------------------------------------------------

interface ZipRead {
  entries: { name: string; data: Uint8Array; crc: number; flags: number; method: number }[];
  total: number;
}

/** Independent bitwise CRC-32 (no table). */
function slowCrc(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of data) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** A tiny ZIP reader: end record, central directory, local headers, CRC check. */
function readZip(bytes: Uint8Array): ZipRead {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= 0 && v.getUint32(end, true) !== 0x06054b50) end--;
  expect(end).toBeGreaterThanOrEqual(0);
  expect(end + 22).toBe(bytes.length);
  const total = v.getUint16(end + 10, true);
  expect(v.getUint16(end + 8, true)).toBe(total);
  const cdSize = v.getUint32(end + 12, true);
  let at = v.getUint32(end + 16, true);
  expect(at + cdSize).toBe(end);
  const entries: ZipRead["entries"] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let i = 0; i < total; i++) {
    expect(v.getUint32(at, true)).toBe(0x02014b50);
    const flags = v.getUint16(at + 8, true);
    const method = v.getUint16(at + 10, true);
    const crc = v.getUint32(at + 16, true);
    const csize = v.getUint32(at + 20, true);
    const usize = v.getUint32(at + 24, true);
    const nameLen = v.getUint16(at + 28, true);
    const extraLen = v.getUint16(at + 30, true);
    const commentLen = v.getUint16(at + 32, true);
    const local = v.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    expect(csize).toBe(usize);
    expect(v.getUint32(local, true)).toBe(0x04034b50);
    expect(v.getUint16(local + 8, true)).toBe(method);
    const lNameLen = v.getUint16(local + 26, true);
    const lExtraLen = v.getUint16(local + 28, true);
    expect(decoder.decode(bytes.subarray(local + 30, local + 30 + lNameLen))).toBe(name);
    expect(v.getUint32(local + 14, true)).toBe(crc);
    const start = local + 30 + lNameLen + lExtraLen;
    const data = bytes.slice(start, start + usize);
    expect(slowCrc(data)).toBe(crc);
    entries.push({ name, data, crc, flags, method });
    at += 46 + nameLen + extraLen + commentLen;
  }
  expect(at).toBe(end);
  return { entries, total };
}

describe("zip writer", () => {
  it("computes the standard CRC-32 check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it("round-trips arbitrary files through a reader that checks every header and CRC", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.tuple(fc.stringMatching(/^[A-Za-z0-9 ()_.-]{1,20}$/), fc.uint8Array({ maxLength: 200 })), {
          maxLength: 8,
          selector: ([name]) => name,
        }),
        (files) => {
          const entries = files.filter(([n]) => isSafeZipPath(n)).map(([n, d]) => ({ path: `dir/${n}`, data: d }));
          const zip = createZip(entries);
          const read = readZip(zip);
          expect(read.total).toBe(entries.length);
          read.entries.forEach((e, i) => {
            expect(e.name).toBe(entries[i].path);
            expect(Array.from(e.data)).toEqual(Array.from(entries[i].data));
            expect(e.flags & 0x0800).toBe(0x0800);
            expect(e.method).toBe(0);
          });
        },
      ),
      RUNS,
    );
  });

  it("stores UTF-8 names and a deterministic DOS timestamp", () => {
    const a = createZip([{ path: "ü/日本.md", data: new Uint8Array([1]) }], { modified: "2026-03-04T05:06:08Z" });
    const b = createZip([{ path: "ü/日本.md", data: new Uint8Array([1]) }], { modified: "2026-03-04T05:06:08Z" });
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(readZip(a).entries[0].name).toBe("ü/日本.md");
    const v = new DataView(a.buffer);
    expect(v.getUint16(12, true)).toBe(((2026 - 1980) << 9) | (3 << 5) | 4);
    expect(v.getUint16(10, true)).toBe((5 << 11) | (6 << 5) | 4);
    const dflt = new DataView(createZip([{ path: "a", data: new Uint8Array() }]).buffer);
    expect(dflt.getUint16(12, true)).toBe(0x21);
    expect(dflt.getUint16(10, true)).toBe(0);
  });

  it("refuses unsafe paths, duplicates and too many entries", () => {
    for (const bad of ["", "/abs", "../x", "a/../b", "a//b", "a\\b", "C:/x", "a/./b", "x\u0000y"]) {
      expect(() => createZip([{ path: bad, data: new Uint8Array() }])).toThrow();
    }
    const one = { path: "a", data: new Uint8Array() };
    expect(() => createZip([one, one])).toThrow(/Duplicate/);
    const many = Array.from({ length: 65_535 }, (_, i) => ({ path: `f${i}`, data: new Uint8Array() }));
    expect(() => createZip(many)).toThrow(/Too many/);
    expect(readZip(createZip(many.slice(0, 3))).total).toBe(3);
  });
});

function plainCard(id: string, title: string, archivalId = `MEM-${id}`, content = "body"): MemexNode {
  return {
    id,
    type: "memexCard",
    position: { x: 0, y: 0 },
    data: { archivalId, title, content, cardType: "note", tags: ["t1"], createdAt: FIXED_AT },
  };
}

function plainEdge(id: string, source: string, target: string, rationale = "because", polarity?: "refutes"): AssociativeEdge {
  return { id, source, target, type: "associative", data: { origin: "human", rationale, strength: 0.5, ...(polarity ? { polarity } : {}) } };
}

describe("Obsidian vault export", () => {
  it("sanitizes filenames: never empty, no separators or illegal characters, bounded, unique reserved-safe", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 300 }), (title) => {
        const name = sanitizeObsidianFilename(title);
        expect(name.length).toBeGreaterThan(0);
        expect(name).not.toMatch(/[\\/:*?"<>|#^[\]]/);
        expect(name).not.toMatch(/[\u0000-\u001F\u007F]/);
        expect(name).not.toMatch(/^[\s.]|[\s.]$/);
        expect(name).not.toBe("..");
        expect(name).not.toContain("..".concat("/"));
        expect(Array.from(name).length).toBeLessThanOrEqual(101); // 100 plus a possible "_"
        expect(name).not.toMatch(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i);
      }),
      RUNS,
    );
    expect(sanitizeObsidianFilename("")).toBe("Untitled");
    expect(sanitizeObsidianFilename("???")).toBe("Untitled");
    expect(sanitizeObsidianFilename("../../etc/passwd")).toBe("-..-etc-passwd");
    expect(sanitizeObsidianFilename("CON")).toBe("CON_");
    expect(sanitizeObsidianFilename("nul.txt")).toBe("nul.txt_");
    expect(sanitizeObsidianFilename("A: B/C [x]#y^z")).toBe("A- B-C xyz");
    expect(sanitizeObsidianFilename("  .hidden. ")).toBe("hidden");
    expect(sanitizeObsidianFilename("日".repeat(150))).toBe("日".repeat(100));
  });

  it("gives every card its own unique file, even with colliding or odd titles", () => {
    const titleArb = fc.constantFrom("Same", "same", "SAME ", "A/B", "A:B", "???", "", "CON", "con", "x");
    fc.assert(
      fc.property(fc.array(titleArb, { minLength: 1, maxLength: 10 }), fc.boolean(), (titles, reverse) => {
        let cards = titles.map((t, i) => plainCard(`id-${i}`, t));
        if (reverse) cards = [...cards].reverse();
        const files = buildObsidianFiles(cards, []);
        expect(files).toHaveLength(cards.length);
        const paths = files.map((f) => f.path.toLowerCase());
        expect(new Set(paths).size).toBe(paths.length);
        for (const f of files) {
          expect(f.path).toMatch(/^Memex Vault\/[^/]+\.md$/);
          expect(f.path).not.toContain("..".concat("/"));
        }
        for (const c of cards) {
          expect(files.filter((f) => f.content.includes(`archivalId: "${c.data.archivalId}"`))).toHaveLength(1);
        }
        // Names do not depend on input order.
        const sortedFiles = buildObsidianFiles([...cards].sort((a, b) => (a.id < b.id ? -1 : 1)), []);
        expect(sortedFiles.map((f) => f.path)).toEqual(files.map((f) => f.path));
      }),
      RUNS,
    );
  });

  it("writes bidirectional wikilinks with polarity and an escaped rationale", () => {
    const cards = [plainCard("a", "Alpha"), plainCard("b", "Beta"), plainCard("c", "Gamma")];
    const nasty = "see [[Other]] | <script>alert(1)</script> #tag ]] **bold** $x$ ==hi== %%c%%";
    const files = buildObsidianFiles(cards, [
      plainEdge("e1", "a", "b", nasty, "refutes"),
      plainEdge("e2", "c", "a"),
      plainEdge("e3", "a", "missing"),
      plainEdge("e4", "a", "a"),
    ]);
    const get = (name: string) => files.find((f) => f.path.endsWith(`/${name}.md`))?.content ?? "";
    const alpha = get("Alpha");
    const beta = get("Beta");
    const gamma = get("Gamma");
    expect(alpha).toContain("- → [[Beta]] · refutes · ");
    expect(beta).toContain("- ← [[Alpha]] · refutes · ");
    expect(alpha).toContain("- ← [[Gamma]] · supports · because");
    expect(gamma).toContain("- → [[Alpha]] · supports · because");
    expect(alpha).not.toContain("[[missing");
    expect(alpha.match(/\[\[Alpha\]\]/g)).toBeNull();
    for (const body of [alpha, beta]) {
      const link = body.split("\n").find((l) => l.includes("refutes")) as string;
      const rationale = link.split(" · ")[2];
      expect(rationale).not.toMatch(/(?<!\\)[[\]|<>#]/);
      expect(rationale).not.toContain("]]");
    }
    // Every file keeps its content verbatim and has the links section.
    for (const f of files) {
      expect(f.content).toContain("\n\nbody\n\n## Associative Links\n\n");
    }
  });

  it("is bidirectional for arbitrary edges and keeps content verbatim", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 0, max: 4 }), fc.integer({ min: 0, max: 5 }), fc.string({ maxLength: 30 })), { maxLength: 8 }),
        fc.array(fc.string({ unit: "binary", maxLength: 30 }), { minLength: 5, maxLength: 5 }),
        (edgeSpecs, bodies) => {
          const cards = bodies.map((b, i) => plainCard(`k${i}`, `Card ${i}`, `MEM-${i}`, b));
          const edges = edgeSpecs.map(([s, t, r], i) => plainEdge(`e${i}`, `k${s}`, `k${t}`, r));
          const files = buildObsidianFiles(cards, edges);
          const nameOf = (id: string) => `Card ${id.slice(1)}`;
          const content = (id: string) => files.find((f) => f.path === `Memex Vault/${nameOf(id)}.md`)?.content ?? "";
          for (const e of edges) {
            if (e.source === e.target || e.target === "k5") continue;
            expect(content(e.source)).toContain(`→ [[${nameOf(e.target)}]]`);
            expect(content(e.target)).toContain(`← [[${nameOf(e.source)}]]`);
          }
          cards.forEach((c) => expect(content(c.id)).toContain(`\n\n${c.data.content}\n\n## Associative Links`));
        },
      ),
      RUNS,
    );
  });

  it("writes safely quoted front matter including cassette fields", () => {
    const card = plainCard("a", 'He said "hi"\nand: left');
    card.data = {
      ...card.data,
      year: 1945,
      date: "1945-07",
      source: "arXiv:1706.03762",
      authors: ["Ashish Vaswani"],
      pdfUrl: "https://arxiv.org/pdf/1706.03762",
      cassetteId: "cassette-1706.03762",
      cassetteTitle: "Attention",
      tags: ["a: b", "c"],
    };
    const [file] = buildObsidianFiles([card], []);
    const head = file.content.split("\n---\n")[0];
    expect(head).toContain('title: "He said \\"hi\\"\\nand: left"');
    expect(head).toContain("year: 1945");
    expect(head).toContain('date: "1945-07"');
    expect(head).toContain('  - "a: b"');
    expect(head).toContain('cassette: "cassette-1706.03762"');
    expect(head).toContain('cassetteTitle: "Attention"');
    expect(head).toContain('authors:\n  - "Ashish Vaswani"');
    expect(head.split("\n").every((l) => !l.includes("\r"))).toBe(true);
  });

  it("produces a valid archive with one entry per card and the expected wikilinks", async () => {
    const cards = [plainCard("a", "Alpha"), plainCard("b", "Beta"), plainCard("c", "Alpha")];
    const edges = [plainEdge("e1", "a", "b"), plainEdge("e2", "b", "c")];
    const blob = await exportObsidianVaultZip(cards, edges, { modified: FIXED_AT });
    expect(blob.type).toBe("application/zip");
    const read = readZip(new Uint8Array(await blob.arrayBuffer()));
    expect(read.total).toBe(3);
    const names = read.entries.map((e) => e.name);
    expect(new Set(names).size).toBe(3);
    expect(names.sort()).toEqual(["Memex Vault/Alpha (MEM-c).md", "Memex Vault/Alpha.md", "Memex Vault/Beta.md"]);
    const text = new Map(read.entries.map((e) => [e.name, new TextDecoder().decode(e.data)]));
    expect(text.get("Memex Vault/Alpha.md")).toContain("[[Beta]]");
    expect(text.get("Memex Vault/Beta.md")).toContain("[[Alpha]]");
    expect(text.get("Memex Vault/Beta.md")).toContain("[[Alpha (MEM-c)]]");
    expect(text.get("Memex Vault/Alpha (MEM-c).md")).toContain("[[Beta]]");
    // Same input gives byte-identical archives.
    const again = new Uint8Array(await (await exportObsidianVaultZip(cards, edges, { modified: FIXED_AT })).arrayBuffer());
    expect(Array.from(again)).toEqual(Array.from(new Uint8Array(await blob.arrayBuffer())));
  });
});

// ---------------------------------------------------------------------------
// Spotlight
// ---------------------------------------------------------------------------

const TYPES: MemexCardType[] = ["note", "quote", "artifact", "ghost"];

function spotNode(id: string, over: Partial<MemexNode["data"]> = {}): MemexNode {
  return {
    id,
    type: "memexCard",
    position: { x: 0, y: 0 },
    data: { archivalId: id, title: "Title", content: "content", cardType: "note", tags: [], createdAt: FIXED_AT, ...over },
  };
}

const spotDataArb = fc.record({
  title: fc.constantFrom("As We May Think", "Attention Is All You Need", "Cafe Notes", "Café Society", "GraphRAG", "Memex"),
  content: fc.constantFrom("hypertext trails", "scaled dot product attention", "community summaries", "", "zebra"),
  tags: fc.array(fc.constantFrom("Memory", "attention", "graph", "HCI", " memory "), { maxLength: 3 }),
  cardType: fc.constantFrom(...TYPES),
  authors: fc.array(fc.constantFrom("Vannevar Bush", "Ashish Vaswani"), { maxLength: 2 }),
  source: fc.constantFrom("arXiv:1706.03762", "The Atlantic"),
});

/** Cards with ids `s0`, `s1`, ... from generated data. */
const spotNodesArb = (min: number, max: number): fc.Arbitrary<MemexNode[]> =>
  fc.array(spotDataArb, { minLength: min, maxLength: max }).map((list) => list.map((d, i) => spotNode(`s${i}`, { ...d })));

const filtersArb: fc.Arbitrary<SpotlightFilters> = fc.record({
  query: fc.constantFrom("", "  ", "attention", "ATTENTION", "café", "cafe", "bush", "zebra", "memex trail", "atention", "xyzzy"),
  type: fc.constantFrom<SpotlightFilters["type"]>("all", ...TYPES),
  tags: fc.array(fc.constantFrom("memory", "Attention", "graph", "hci"), { maxLength: 2 }),
});

describe("spotlight", () => {
  it("fuzzyScore: tiers are ordered exact > word > prefix > word-prefix > substring > typo > subsequence", () => {
    const scores = [
      fuzzyScore("attention", "attention"),
      fuzzyScore("attention", "attention is all you need"),
      fuzzyScore("atten", "attention span"),
      fuzzyScore("atten", "the attention span"),
      fuzzyScore("tent", "attention"),
      fuzzyScore("atention", "attention"),
      fuzzyScore("atnn", "attention"),
    ];
    for (let i = 0; i + 1 < scores.length; i++) expect(scores[i]).toBeGreaterThan(scores[i + 1]);
    expect(scores[scores.length - 1]).toBeGreaterThan(0);
    expect(fuzzyScore("zebra", "attention")).toBe(0);
    expect(fuzzyScore("a", "attention")).toBeGreaterThan(0);
    expect(fuzzyScore("xq", "attention")).toBe(0);
  });

  it("fuzzyScore: case and diacritic insensitive, AND over tokens, empty query matches everything", () => {
    expect(fuzzyScore("CAFE", "Café")).toBe(fuzzyScore("cafe", "cafe"));
    expect(fuzzyScore("naïve", "NAIVE approach")).toBeGreaterThan(0);
    expect(fuzzyScore("attention transformer", "Transformer attention")).toBeGreaterThan(0);
    expect(fuzzyScore("attention zebra", "attention is all")).toBe(0);
    expect(fuzzyScore("", "anything")).toBe(1);
    expect(fuzzyScore("   ", "")).toBe(1);
    expect(fuzzyScore("x", "")).toBe(0);
  });

  it("fuzzyScore: bounded, deterministic, and a text always matches itself", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 60 }), fc.string({ unit: "binary", maxLength: 60 }), (q, t) => {
        const s = fuzzyScore(q, t);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(1);
        expect(fuzzyScore(q, t)).toBe(s);
        if (tokenizeQuery(q).length > 0 && foldTextHasNoBreaks(q)) expect(fuzzyScore(q, q)).toBeGreaterThan(0);
      }),
      RUNS,
    );
  });

  it("long texts only match literally (no loose matches on a body)", () => {
    const body = `${"lorem ipsum dolor ".repeat(40)}end`;
    expect(fuzzyScore("amet", body)).toBe(0);
    expect(fuzzyScore("lorm", body)).toBe(0);
    expect(fuzzyScore("dolor", body)).toBeGreaterThan(0);
  });

  it("matchNode is type AND every tag AND query; an empty filter matches everything", () => {
    fc.assert(
      fc.property(spotNodesArb(1, 8), filtersArb, (nodes, filters) => {
        const wanted = filters.tags.map((t) => t.trim().toLowerCase());
        const tokens = tokenizeQuery(filters.query);
        for (const n of nodes) {
          const typeOk = filters.type === "all" || n.data.cardType === filters.type;
          const own = new Set(n.data.tags.map((t) => t.trim().toLowerCase()));
          const tagsOk = wanted.every((t) => own.has(t));
          const queryOk = scoreNodeQuery(n.data, tokens) > 0;
          expect(matchNode(n, filters)).toBe(typeOk && tagsOk && queryOk);
          expect(matchNode(n, { query: "", type: "all", tags: [] })).toBe(true);
        }
        const set = computeMatchSet(nodes, filters);
        if (!isSpotlightActive(filters)) {
          expect(set).toBeNull();
        } else {
          expect(set).not.toBeNull();
          expect([...(set as Set<string>)].sort()).toEqual(nodes.filter((n) => matchNode(n, filters)).map((n) => n.id).sort());
        }
        // Adding a constraint never adds matches.
        const stricter: SpotlightFilters = { ...filters, tags: [...filters.tags, "memory"] };
        for (const n of nodes) if (matchNode(n, stricter)) expect(matchNode(n, filters)).toBe(true);
      }),
      RUNS,
    );
  });

  it("matches title, content, tags, authors and source", () => {
    const n = spotNode("x", { title: "Alpha", content: "beta words", tags: ["Gamma"], authors: ["Delta Person"], source: "epsilon-journal" });
    const f = (query: string): SpotlightFilters => ({ query, type: "all", tags: [] });
    for (const q of ["alpha", "beta", "gamma", "delta", "epsilon"]) expect(matchNode(n, f(q))).toBe(true);
    expect(matchNode(n, f("omega"))).toBe(false);
    expect(computeMatchSet([n], { query: "  ", type: "all", tags: [] })).toBeNull();
    expect(computeMatchSet([n], { query: "", type: "quote", tags: [] })?.size).toBe(0);
  });

  it("tag cloud: counts once per card, sorted by count desc then tag asc, capped, order independent", () => {
    fc.assert(
      fc.property(spotNodesArb(0, 10), fc.integer({ min: 0, max: 6 }), (nodes, cap) => {
        const cloud = buildTagCloud(nodes, cap);
        expect(cloud.length).toBeLessThanOrEqual(cap);
        for (let i = 0; i + 1 < cloud.length; i++) {
          const [a, b] = [cloud[i], cloud[i + 1]];
          expect(a.count > b.count || (a.count === b.count && a.tag < b.tag)).toBe(true);
        }
        const full = buildTagCloud(nodes, 1000);
        for (const { tag, count } of full) {
          expect(count).toBe(nodes.filter((n) => n.data.tags.some((t) => t.trim().toLowerCase() === tag)).length);
          expect(tag).toBe(tag.trim().toLowerCase());
        }
        expect(cloud).toEqual(full.slice(0, cap));
        expect(buildTagCloud([...nodes].reverse(), 1000)).toEqual(full);
      }),
      RUNS,
    );
    expect(buildTagCloud(Array.from({ length: 60 }, (_, i) => spotNode(`n${i}`, { tags: [`t${String(i).padStart(2, "0")}`] }))).length).toBe(40);
  });

  it("matchNodeMemo always equals matchNode, across changing filters and re-created node objects", () => {
    fc.assert(
      fc.property(spotNodesArb(1, 5), fc.array(filtersArb, { minLength: 1, maxLength: 8 }), (nodes, seq) => {
        for (const f of [...seq, ...seq]) {
          const sig = filterSignature(f);
          for (const n of nodes) {
            const clone = { ...n, position: { x: 1, y: 2 } }; // new node object, same data reference
            expect(matchNodeMemo(clone, f, sig)).toBe(matchNode(n, f));
            expect(matchNodeMemo(n, f)).toBe(matchNode(n, f));
          }
        }
      }),
      RUNS,
    );
  });

  it("equivalent filters share a signature; different ones do not", () => {
    expect(filterSignature({ query: "  Café  Memex ", type: "all", tags: ["B", "a", "b"] })).toBe(
      filterSignature({ query: "cafe memex", type: "all", tags: ["a", "b"] }),
    );
    expect(filterSignature({ query: "a", type: "all", tags: [] })).not.toBe(filterSignature({ query: "a", type: "note", tags: [] }));
  });

  it("combinedDimOpacity is the minimum of the applicable opacities", () => {
    expect(SPOTLIGHT_DIM_OPACITY).toBe(0.15);
    expect(TRAIL_DIM_OPACITY).toBe(0.2);
    const states = ["idle", "current", "active", "dim"] as const;
    for (const t of states) {
      for (const s of ["match", "dim", "off"] as const) {
        const expected = Math.min(t === "dim" ? 0.2 : 1, s === "dim" ? 0.15 : 1);
        expect(combinedDimOpacity(t, s)).toBe(expected);
      }
    }
    expect(combinedDimOpacity("dim", "dim")).toBe(0.15);
    expect(combinedDimOpacity("dim", "match")).toBe(0.2);
    expect(combinedDimOpacity("active", "dim")).toBe(0.15);
    expect(combinedDimOpacity("idle", "off")).toBe(1);
  });
});

function foldTextHasNoBreaks(q: string): boolean {
  return !/[\u0085\u2028\u2029]/.test(q);
}

// ---------------------------------------------------------------------------
// Command dock
// ---------------------------------------------------------------------------

const keyArb: fc.Arbitrary<DockKeyEvent> = fc.record({
  key: fc.constantFrom("t", "T", "/", "?", "Escape", "a", "ArrowLeft", "Enter"),
  ctrlKey: fc.boolean(),
  metaKey: fc.boolean(),
  altKey: fc.boolean(),
  shiftKey: fc.boolean(),
  repeat: fc.boolean(),
  defaultPrevented: fc.boolean(),
  targetIsEditable: fc.boolean(),
  targetInsideDock: fc.boolean(),
  modalOpen: fc.boolean(),
});

const TABS: DockTab[] = ["trails", "synapse", "spotlight"];
const eventArb: fc.Arbitrary<DockEvent> = fc.oneof(
  keyArb.map((event): DockEvent => ({ type: "key", event })),
  keyArb.map((event): DockEvent => ({ type: "key", event })),
  fc.constantFrom(...TABS).map((tab): DockEvent => ({ type: "openTab", tab })),
  fc.constantFrom(...TABS).map((tab): DockEvent => ({ type: "toggleTab", tab })),
  fc.constant<DockEvent>({ type: "collapse" }),
  fc.constant<DockEvent>({ type: "expand" }),
);

/** Reference model: written straight from the rules, sharing no code with the implementation. */
function reference(state: DockState, ev: DockEvent): DockState {
  switch (ev.type) {
    case "openTab":
      return { open: true, tab: ev.tab };
    case "toggleTab":
      return state.open && state.tab === ev.tab ? { open: false, tab: state.tab } : { open: true, tab: ev.tab };
    case "collapse":
      return { open: false, tab: state.tab };
    case "expand":
      return { open: true, tab: state.tab };
    case "key": {
      const e = ev.event;
      if (e.key === "Escape") {
        const allowed = state.open && !e.modalOpen && (!e.targetIsEditable || e.targetInsideDock);
        return allowed ? { open: false, tab: state.tab } : state;
      }
      const blocked = e.ctrlKey || e.metaKey || e.altKey || e.repeat || e.defaultPrevented || e.targetIsEditable || e.modalOpen;
      if (blocked) return state;
      if (e.key === "t" || e.key === "T") {
        return state.open && state.tab === "trails" ? { open: false, tab: "trails" } : { open: true, tab: "trails" };
      }
      if (e.key === "/") return { open: true, tab: "spotlight" };
      return state;
    }
  }
}

describe("command dock state machine", () => {
  it("matches the reference model over arbitrary event sequences", () => {
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 40 }), (events) => {
        let actual: DockState = { open: false, tab: "trails" };
        let model: DockState = { open: false, tab: "trails" };
        for (const ev of events) {
          const next = dockReducer(actual, ev);
          model = reference(model, ev);
          expect({ open: next.open, tab: next.tab }).toEqual(model);
          if (model.open === actual.open && model.tab === actual.tab) expect(next).toBe(actual);
          actual = next;
        }
      }),
      RUNS,
    );
  });

  it("T and / act only when allowed; the slash is never typed; Escape only collapses an open dock", () => {
    fc.assert(
      fc.property(fc.constantFrom(...TABS), fc.boolean(), keyArb, (tab, open, e) => {
        const state: DockState = { open, tab };
        const r = resolveDockKey(state, e);
        const typing = e.targetIsEditable;
        const blocked = e.ctrlKey || e.metaKey || e.altKey || e.repeat || e.defaultPrevented || typing || e.modalOpen;
        if (e.key === "Escape") {
          expect(r.state.open && !open).toBe(false);
          expect(r.focusSpotlightInput).toBe(false);
          expect(r.handled).toBe(open && !e.modalOpen && (!typing || e.targetInsideDock));
          expect(r.stopPropagation).toBe(r.handled);
          if (r.handled) expect(r.state).toEqual({ open: false, tab });
          else expect(r.state).toBe(state);
        } else if ((e.key === "t" || e.key === "T") && !blocked) {
          expect(r.handled).toBe(true);
          expect(r.preventDefault).toBe(true);
          expect(r.state.tab).toBe("trails");
          expect(r.state.open).toBe(!(open && tab === "trails"));
        } else if (e.key === "/" && !blocked) {
          expect(r.handled).toBe(true);
          expect(r.preventDefault).toBe(true);
          expect(r.focusSpotlightInput).toBe(true);
          expect(r.state).toEqual({ open: true, tab: "spotlight" });
        } else {
          expect(r.handled).toBe(false);
          expect(r.preventDefault).toBe(false);
          expect(r.focusSpotlightInput).toBe(false);
          expect(r.state).toBe(state);
        }
      }),
      RUNS,
    );
  });

  it("T toggles Trails, / opens Spotlight, Escape collapses (and remembers the tab)", () => {
    const base: DockKeyEvent = {
      key: "t", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false,
      defaultPrevented: false, targetIsEditable: false, targetInsideDock: false, modalOpen: false,
    };
    let s: DockState = { open: false, tab: "trails" };
    s = dockReducer(s, { type: "key", event: base });
    expect(s).toEqual({ open: true, tab: "trails" });
    s = dockReducer(s, { type: "key", event: { ...base, key: "T", shiftKey: true } });
    expect(s).toEqual({ open: false, tab: "trails" });
    s = dockReducer(s, { type: "key", event: { ...base, key: "/" } });
    expect(s).toEqual({ open: true, tab: "spotlight" });
    s = dockReducer(s, { type: "key", event: { ...base, key: "t" } });
    expect(s).toEqual({ open: true, tab: "trails" });
    s = dockReducer(s, { type: "key", event: { ...base, key: "/" } });
    s = dockReducer(s, { type: "key", event: { ...base, key: "Escape" } });
    expect(s).toEqual({ open: false, tab: "spotlight" });
    // Escape while typing in the dock's own field collapses; in an outside field it does not.
    s = { open: true, tab: "spotlight" };
    expect(dockReducer(s, { type: "key", event: { ...base, key: "Escape", targetIsEditable: true, targetInsideDock: false } })).toBe(s);
    expect(dockReducer(s, { type: "key", event: { ...base, key: "Escape", targetIsEditable: true, targetInsideDock: true } }).open).toBe(false);
    // "/" typed into a text field is left alone.
    expect(resolveDockKey({ open: false, tab: "trails" }, { ...base, key: "/", targetIsEditable: true }).preventDefault).toBe(false);
  });

  it("Escape precedence: modal, then the dock, then playback", () => {
    const owners = [false, true].flatMap((modalOpen) =>
      [false, true].flatMap((dockOpen) => [false, true].map((trailActive) => ({ modalOpen, dockOpen, trailActive }))),
    );
    for (const o of owners) {
      const expected = o.modalOpen ? "modal" : o.dockOpen ? "command-dock" : o.trailActive ? "playback" : "none";
      expect(resolveDockEscapeOwner(o)).toBe(expected);
      expect(shouldPlaybackHandleKeys({ dockOpen: o.dockOpen, modalOpen: o.modalOpen, targetIsEditable: false })).toBe(!o.dockOpen && !o.modalOpen);
    }
    expect(shouldPlaybackHandleKeys({ dockOpen: false, modalOpen: false, targetIsEditable: true })).toBe(false);
  });

  it("selection opens the Synapse tab and clearing it does not close the dock", () => {
    const closed: DockState = { open: false, tab: "trails" };
    expect(dockForSelection(closed, { selectedGhostDiscoveryId: "gd", inspectedEdgeId: null })).toEqual({ open: true, tab: "synapse" });
    expect(dockForSelection(closed, { selectedGhostDiscoveryId: null, inspectedEdgeId: "e" })).toEqual({ open: true, tab: "synapse" });
    const open: DockState = { open: true, tab: "spotlight" };
    expect(dockForSelection(open, { selectedGhostDiscoveryId: null, inspectedEdgeId: null })).toBe(open);
    const synapse: DockState = { open: true, tab: "synapse" };
    expect(dockForSelection(synapse, { selectedGhostDiscoveryId: "gd", inspectedEdgeId: null })).toBe(synapse);
  });
});
