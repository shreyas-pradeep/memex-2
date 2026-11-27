import fc from "fast-check";
import { Position, getBezierPath } from "@xyflow/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  ARXIV_INVALID_MESSAGE,
  EDGE_CURVATURE,
  EMPTY_DROP_MESSAGE,
  EMPTY_TOAST_STATE,
  GUIDANCE_ACTION_PATTERN,
  GUIDANCE_STATE_IDS,
  GUIDANCE_TEXT,
  IDLE_THRESHOLD_MS,
  MAX_TOASTS,
  SPROCKET_QUIPS,
  TOAST_CATALOG,
  TRAIL_END_MESSAGE,
  advanceQuipIndex,
  clampToBounds,
  cubicBezierPoint,
  dismissToast,
  findWireDirection,
  getEdgeCurve,
  getEdgeGeometry,
  getEdgeMidpoint,
  getGuidanceMessage,
  getGuidanceStateId,
  getPerchPosition,
  getSprocketPosition,
  getTraversalPoint,
  isIdle,
  pickInspectionTarget,
  pushToast,
  rectToBounds,
  resolveCardRect,
  selectSprocketQuip,
  unionOfRects,
  type Bounds,
  type EdgeSide,
  type GuidanceInput,
  type Point,
  type Rect,
  type ToastKind,
} from "../sprocket-engine";
import type { GhostDiscovery } from "../types";
import { useMemexStore, STORAGE_KEY } from "@/store/useMemexStore";
import { useToastStore } from "@/store/useToastStore";

const RUNS = { numRuns: 200 } as const;

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const coord = fc.double({ min: -5000, max: 5000, noNaN: true });
const size = fc.double({ min: -800, max: 800, noNaN: true });
/** Any rectangle, including negative (reversed), zero-size, overlapping and negative-coordinate ones. */
const rectArb: fc.Arbitrary<Rect> = fc.record({
  x: coord,
  y: coord,
  width: fc.oneof(size, fc.constant(0)),
  height: fc.oneof(size, fc.constant(0)),
});
/** Rectangles with ordinary sizes, as React Flow measures them. */
const cardRectArb: fc.Arbitrary<Rect> = fc.record({
  x: coord,
  y: coord,
  width: fc.double({ min: 40, max: 800, noNaN: true }),
  height: fc.double({ min: 40, max: 800, noNaN: true }),
});
const hostileNumber = fc.oneof(
  fc.double({ min: -1e6, max: 1e6 }),
  fc.constantFrom(Number.NaN, Infinity, -Infinity, 0, -0, 1e300, -1e300),
);
const hostileRect: fc.Arbitrary<Rect> = fc.record({
  x: hostileNumber,
  y: hostileNumber,
  width: hostileNumber,
  height: hostileNumber,
});
const anyT = fc.oneof(
  fc.double({ min: 0, max: 1 }),
  fc.double({ min: -10, max: 10 }),
  fc.constantFrom(Number.NaN, Infinity, -Infinity, 0, 1, -1, 2),
);

function inside(p: Point, b: Bounds): boolean {
  return p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY;
}

const EPS = 1e-6;

// ---------------------------------------------------------------------------
// P1: guidance is valid and actionable for every state
// ---------------------------------------------------------------------------

const idleArb = fc.oneof(
  fc.integer({ min: -100_000, max: 100_000 }),
  fc.double(), // includes NaN, +/-Infinity and huge values
  fc.constantFrom(0, 14_999, 15_000, 15_001, Infinity, Number.NaN, -1),
);
const guidanceInputArb: fc.Arbitrary<GuidanceInput> = fc.record({
  cardCount: fc.oneof(fc.integer({ min: -3, max: 200 }), fc.constantFrom(Number.NaN, Infinity)),
  activeTrailId: fc.option(fc.string({ minLength: 0, maxLength: 12 }), { nil: null }),
  isPlayingAuto: fc.boolean(),
  discoveryCount: fc.oneof(fc.integer({ min: -3, max: 50 }), fc.constantFrom(Number.NaN, Infinity)),
  isGhostScanning: fc.boolean(),
  idleMs: idleArb,
  trailCount: fc.option(fc.integer({ min: -2, max: 20 }), { nil: undefined }),
});

function expectValidGuidance(input: GuidanceInput): void {
  const msg = getGuidanceMessage(input);
  expect(typeof msg.text).toBe("string");
  expect(msg.text.trim().length).toBeGreaterThan(0);
  expect(GUIDANCE_ACTION_PATTERN.test(msg.text)).toBe(true);
  expect(GUIDANCE_STATE_IDS).toContain(msg.id);
  expect(msg.text).toBe(GUIDANCE_TEXT[msg.id]);
}

describe("Property 1: guidance is always valid and actionable", () => {
  it("returns a non-empty actionable string for arbitrary store states", () => {
    fc.assert(
      fc.property(guidanceInputArb, (input) => {
        expectValidGuidance(input);
        // Deterministic: the same input gives the same output.
        expect(getGuidanceMessage(input)).toEqual(getGuidanceMessage({ ...input }));
      }),
      RUNS,
    );
  });

  it("covers every discrete combination exhaustively", () => {
    const seen = new Set<string>();
    for (const cardCount of [0, 1, 7])
      for (const activeTrailId of [null, "t-1"])
        for (const isPlayingAuto of [false, true])
          for (const discoveryCount of [0, 3])
            for (const isGhostScanning of [false, true])
              for (const idleMs of [0, 15_000, 15_001, 600_000])
                for (const trailCount of [undefined, 0, 4]) {
                  const input: GuidanceInput = {
                    cardCount,
                    activeTrailId,
                    isPlayingAuto,
                    discoveryCount,
                    isGhostScanning,
                    idleMs,
                    trailCount,
                  };
                  expectValidGuidance(input);
                  seen.add(getGuidanceStateId(input));
                }
    // Every state is reachable.
    expect([...seen].sort()).toEqual([...GUIDANCE_STATE_IDS].sort());
  });

  it("returns the required copy for the four documented states", () => {
    const base: GuidanceInput = {
      cardCount: 5,
      activeTrailId: null,
      isPlayingAuto: false,
      discoveryCount: 0,
      isGhostScanning: false,
      idleMs: 0,
    };
    expect(getGuidanceMessage({ ...base, cardCount: 0 }).text).toBe(
      "The microfilm reels are blank. Press [I] to scan a document onto the platen.",
    );
    expect(getGuidanceMessage(base).id).toBe("cards-no-trail");
    expect(getGuidanceMessage({ ...base, activeTrailId: "t" }).text).toBe(
      "Press [▶] to begin automated camera walkthrough, or use [Next] to step manually.",
    );
    expect(getGuidanceMessage({ ...base, idleMs: IDLE_THRESHOLD_MS + 1 }).text).toBe(
      "The archives whisper... tap [⚡ WAKE GHOST ENGINE] to reveal hidden latent connections.",
    );
  });

  it("applies the priority order", () => {
    const base: GuidanceInput = {
      cardCount: 5,
      activeTrailId: "t",
      isPlayingAuto: true,
      discoveryCount: 2,
      isGhostScanning: true,
      idleMs: 99_999,
    };
    expect(getGuidanceStateId({ ...base, cardCount: 0 })).toBe("empty-canvas");
    expect(getGuidanceStateId(base)).toBe("scanning");
    expect(getGuidanceStateId({ ...base, isGhostScanning: false })).toBe("trail-playing");
    expect(getGuidanceStateId({ ...base, isGhostScanning: false, isPlayingAuto: false })).toBe(
      "trail-active",
    );
    expect(getGuidanceStateId({ ...base, isGhostScanning: false, activeTrailId: null })).toBe(
      "discoveries-pending",
    );
    expect(
      getGuidanceStateId({ ...base, isGhostScanning: false, activeTrailId: null, discoveryCount: 0 }),
    ).toBe("idle-whisper");
    expect(
      getGuidanceStateId({
        ...base,
        isGhostScanning: false,
        activeTrailId: null,
        discoveryCount: 0,
        idleMs: 0,
        trailCount: 0,
      }),
    ).toBe("no-trails");
  });

  it("flips to the idle whisper strictly after 15 seconds", () => {
    expect(IDLE_THRESHOLD_MS).toBe(15000);
    const base: GuidanceInput = {
      cardCount: 3,
      activeTrailId: null,
      isPlayingAuto: false,
      discoveryCount: 0,
      isGhostScanning: false,
      idleMs: 0,
    };
    expect(getGuidanceStateId({ ...base, idleMs: 14_999 })).toBe("cards-no-trail");
    expect(getGuidanceStateId({ ...base, idleMs: 15_000 })).toBe("cards-no-trail");
    expect(getGuidanceStateId({ ...base, idleMs: 15_001 })).toBe("idle-whisper");
    expect(getGuidanceStateId({ ...base, idleMs: Number.NaN })).toBe("cards-no-trail");
    expect(getGuidanceStateId({ ...base, idleMs: -5 })).toBe("cards-no-trail");
    expect(isIdle(Infinity)).toBe(true);
    // Activity resets: dropping back under the threshold leaves the whisper.
    expect(getGuidanceStateId({ ...base, idleMs: 20_000 })).toBe("idle-whisper");
    expect(getGuidanceStateId({ ...base, idleMs: 0 })).toBe("cards-no-trail");
  });

  it("names only controls that exist in the UI", () => {
    // The trail picker is the Reels & Trails tab of the command dock (Spec 09): the [📜] rail icon and [T].
    // It replaced the Spec 08 top button "[📜 TRAILS & REELS]", which no longer exists.
    expect(GUIDANCE_TEXT["cards-no-trail"]).toContain("[📜]");
    expect(GUIDANCE_TEXT["cards-no-trail"]).not.toContain("TRAILS & REELS");
    expect(GUIDANCE_TEXT["cards-no-trail"]).toContain("[T]");
    expect(GUIDANCE_TEXT["cards-no-trail"]).not.toMatch(/Trails menu/);
    expect(GUIDANCE_TEXT["no-trails"]).toContain("[+ BLAZE NEW TRAIL]");
    expect(GUIDANCE_TEXT["no-trails"]).not.toMatch(/Forge/i);
    expect(GUIDANCE_TEXT["cards-no-trail"]).not.toMatch(/from the dock/i);
  });
});

// ---------------------------------------------------------------------------
// P2: Sprocket never leaves the union bounding box
// ---------------------------------------------------------------------------

describe("Property 2: Sprocket stays within the union of source and target", () => {
  it("getSprocketPosition is inside the union box for arbitrary rects and any t", () => {
    fc.assert(
      fc.property(rectArb, rectArb, anyT, (a, b, t) => {
        const p = getSprocketPosition(a, b, t);
        expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
        expect(inside(p, unionOfRects(a, b))).toBe(true);
      }),
      RUNS,
    );
  });

  it("stays inside for NaN, Infinity and zero-size inputs, and returns finite numbers", () => {
    fc.assert(
      fc.property(hostileRect, hostileRect, anyT, (a, b, t) => {
        const p = getSprocketPosition(a, b, t);
        expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
        expect(inside(p, unionOfRects(a, b))).toBe(true);
      }),
      RUNS,
    );
  });

  it("the whole traversal (hop, wire, hop) stays inside the union box in either wire direction", () => {
    fc.assert(
      fc.property(
        rectArb,
        rectArb,
        anyT,
        fc.constantFrom("forward", "reverse", "none"),
        (a, b, p, dir) => {
          const point = getTraversalPoint(a, b, p, dir);
          expect(inside(point, unionOfRects(a, b))).toBe(true);
        },
      ),
      RUNS,
    );
  });

  it("the perch lies inside its card's box, and the midpoint inside the union", () => {
    fc.assert(
      fc.property(hostileRect, hostileRect, (a, b) => {
        expect(inside(getPerchPosition(a), rectToBounds(a))).toBe(true);
        expect(inside(getEdgeMidpoint(a, b), unionOfRects(a, b))).toBe(true);
      }),
      RUNS,
    );
  });

  it("starts at the source perch and ends at the target perch", () => {
    fc.assert(
      fc.property(cardRectArb, cardRectArb, (a, b) => {
        const start = getTraversalPoint(a, b, 0);
        const end = getTraversalPoint(a, b, 1);
        const pa = clampToBounds(getPerchPosition(a), unionOfRects(a, b));
        const pb = clampToBounds(getPerchPosition(b), unionOfRects(a, b));
        expect(start.x).toBeCloseTo(pa.x, 6);
        expect(start.y).toBeCloseTo(pa.y, 6);
        expect(end.x).toBeCloseTo(pb.x, 6);
        expect(end.y).toBeCloseTo(pb.y, 6);
      }),
      RUNS,
    );
  });

  it("clampToBounds is idempotent and keeps points already inside", () => {
    const bounds: Bounds = { minX: -10, minY: -5, maxX: 30, maxY: 20 };
    fc.assert(
      fc.property(fc.double({ min: -100, max: 100 }), fc.double({ min: -100, max: 100 }), (x, y) => {
        const once = clampToBounds({ x, y }, bounds);
        expect(inside(once, bounds)).toBe(true);
        expect(clampToBounds(once, bounds)).toEqual(once);
        if (inside({ x, y }, bounds)) expect(once).toEqual({ x, y });
      }),
      RUNS,
    );
    expect(clampToBounds({ x: Number.NaN, y: Infinity }, bounds)).toEqual({ x: 0, y: 20 });
  });

  it("treats a reversed rectangle like the same rectangle drawn forwards", () => {
    expect(rectToBounds({ x: 100, y: 50, width: -40, height: -10 })).toEqual({
      minX: 60,
      minY: 40,
      maxX: 100,
      maxY: 50,
    });
  });
});

// ---------------------------------------------------------------------------
// Bezier maths and path matching
// ---------------------------------------------------------------------------

describe("cubicBezierPoint", () => {
  const p0 = { x: 0, y: 0 };
  const p1 = { x: 10, y: 40 };
  const p2 = { x: 60, y: -20 };
  const p3 = { x: 100, y: 30 };

  it("returns the end points at t = 0 and t = 1", () => {
    expect(cubicBezierPoint(p0, p1, p2, p3, 0)).toEqual(p0);
    expect(cubicBezierPoint(p0, p1, p2, p3, 1)).toEqual(p3);
  });

  it("clamps t and treats NaN as 0", () => {
    expect(cubicBezierPoint(p0, p1, p2, p3, -5)).toEqual(p0);
    expect(cubicBezierPoint(p0, p1, p2, p3, 7)).toEqual(p3);
    expect(cubicBezierPoint(p0, p1, p2, p3, Number.NaN)).toEqual(p0);
  });

  it("matches the closed form at t = 0.5", () => {
    const mid = cubicBezierPoint(p0, p1, p2, p3, 0.5);
    expect(mid.x).toBeCloseTo(0.125 * p0.x + 0.375 * p1.x + 0.375 * p2.x + 0.125 * p3.x, 10);
    expect(mid.y).toBeCloseTo(0.125 * p0.y + 0.375 * p1.y + 0.375 * p2.y + 0.125 * p3.y, 10);
  });
});

const POSITION: Record<EdgeSide, Position> = {
  top: Position.Top,
  bottom: Position.Bottom,
  left: Position.Left,
  right: Position.Right,
};

/** Reads the four points out of `M sx,sy C c1x,c1y c2x,c2y tx,ty`. */
function parsePath(path: string): number[] {
  const nums = path.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi);
  return (nums ?? []).map(Number);
}

describe("path matching with the edge's own path function", () => {
  it("the shared curve equals the points of React Flow's getBezierPath", () => {
    fc.assert(
      fc.property(cardRectArb, cardRectArb, (a, b) => {
        const g = getEdgeGeometry(a, b);
        const [path, labelX, labelY] = getBezierPath({
          sourceX: g.source.x,
          sourceY: g.source.y,
          sourcePosition: POSITION[g.sourceSide],
          targetX: g.target.x,
          targetY: g.target.y,
          targetPosition: POSITION[g.targetSide],
          curvature: EDGE_CURVATURE,
        });
        const n = parsePath(path);
        expect(n).toHaveLength(8);
        const curve = getEdgeCurve(a, b);
        const pts = [curve.p0, curve.p1, curve.p2, curve.p3];
        pts.forEach((p, i) => {
          expect(Math.abs(p.x - n[i * 2])).toBeLessThan(EPS);
          expect(Math.abs(p.y - n[i * 2 + 1])).toBeLessThan(EPS);
        });
        // The unclamped midpoint is where React Flow puts the edge label.
        const mid = cubicBezierPoint(curve.p0, curve.p1, curve.p2, curve.p3, 0.5);
        expect(Math.abs(mid.x - labelX)).toBeLessThan(EPS);
        expect(Math.abs(mid.y - labelY)).toBeLessThan(EPS);
      }),
      RUNS,
    );
  });

  it("follows the curve, not the straight line, for a card above and to the right", () => {
    const a: Rect = { x: 0, y: 400, width: 300, height: 200 };
    const b: Rect = { x: 800, y: 0, width: 300, height: 200 };
    const g = getEdgeGeometry(a, b);
    expect(g.sourceSide).toBe("right");
    expect(g.targetSide).toBe("left");
    const q = getSprocketPosition(a, b, 0.25);
    const straight = {
      x: g.source.x + (g.target.x - g.source.x) * 0.25,
      y: g.source.y + (g.target.y - g.source.y) * 0.25,
    };
    // An S-shaped wire leaves the straight chord at t = 0.25.
    expect(Math.hypot(q.x - straight.x, q.y - straight.y)).toBeGreaterThan(5);
    // Endpoints land on the card edges.
    expect(getSprocketPosition(a, b, 0)).toEqual(g.source);
    expect(getSprocketPosition(a, b, 1)).toEqual(g.target);
  });

  it("walks a reverse wire along the stored curve backwards", () => {
    const a: Rect = { x: 0, y: 0, width: 300, height: 200 };
    const b: Rect = { x: 700, y: 300, width: 300, height: 200 };
    // Stored edge runs b -> a, Sprocket walks a -> b.
    const wireStart = getTraversalPoint(a, b, 0.15, "reverse");
    const wireEnd = getTraversalPoint(a, b, 0.85, "reverse");
    expect(wireStart).toEqual(getSprocketPosition(b, a, 1));
    expect(wireEnd).toEqual(getSprocketPosition(b, a, 0));
  });
});

describe("findWireDirection", () => {
  const edges = [
    { source: "a", target: "b" },
    { source: "d", target: "c" },
  ];
  it("reports forward, reverse and none", () => {
    expect(findWireDirection(edges, "a", "b")).toBe("forward");
    expect(findWireDirection(edges, "b", "a")).toBe("reverse");
    expect(findWireDirection(edges, "c", "d")).toBe("reverse");
    expect(findWireDirection(edges, "a", "c")).toBe("none");
    expect(findWireDirection([], "a", "b")).toBe("none");
  });
});

describe("resolveCardRect", () => {
  it("prefers the measured size, then width/height, then style, then the fallback", () => {
    const pos = { x: 5, y: 6 };
    expect(resolveCardRect({ position: pos, measured: { width: 10, height: 20 }, width: 1, height: 2 }))
      .toEqual({ x: 5, y: 6, width: 10, height: 20 });
    expect(resolveCardRect({ position: pos, width: 30, height: 40 })).toEqual({
      x: 5,
      y: 6,
      width: 30,
      height: 40,
    });
    expect(resolveCardRect({ position: pos, style: { width: 50, height: "bad" } }, { width: 9, height: 8 }))
      .toEqual({ x: 5, y: 6, width: 50, height: 8 });
    expect(resolveCardRect({ position: pos })).toEqual({ x: 5, y: 6, width: 280, height: 160 });
  });
});

// ---------------------------------------------------------------------------
// P3: quips
// ---------------------------------------------------------------------------

describe("Property 3: quips are deterministic and never empty", () => {
  it("returns the four quips verbatim", () => {
    expect([...SPROCKET_QUIPS]).toEqual([
      "Synapse tensile strength nominal, Professor!",
      "Careful with that 1945 lever—gears haven't been greased since Engelbart's demo.",
      "I found a conceptual bridge! Or maybe it's just lint in the microfilm reel.",
      "Associative trails verified. Vannevar Bush would be proud.",
    ]);
    expect(SPROCKET_QUIPS[1]).toContain("\u2014"); // em dash
  });

  it("is deterministic and non-empty for arbitrary integers", () => {
    fc.assert(
      fc.property(fc.integer(), (i) => {
        const q = selectSprocketQuip(i);
        expect(q.trim().length).toBeGreaterThan(0);
        expect(selectSprocketQuip(i)).toBe(q);
        expect(SPROCKET_QUIPS).toContain(q);
      }),
      RUNS,
    );
  });

  it("handles non-integers, NaN, infinities, negatives and huge values", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.double(),
          fc.constantFrom(Number.NaN, Infinity, -Infinity, -0, 1e308, -1e308, Number.MAX_SAFE_INTEGER),
        ),
        (i) => {
          const q = selectSprocketQuip(i);
          expect(typeof q).toBe("string");
          expect(q.trim().length).toBeGreaterThan(0);
          expect(selectSprocketQuip(i)).toBe(q);
        },
      ),
      RUNS,
    );
  });

  it("wraps modulo the quip count and advances deterministically", () => {
    const n = SPROCKET_QUIPS.length;
    for (let i = 0; i < n * 3; i++) {
      expect(selectSprocketQuip(i)).toBe(SPROCKET_QUIPS[i % n]);
      expect(selectSprocketQuip(-i - 1)).toBe(SPROCKET_QUIPS[(((-i - 1) % n) + n) % n]);
    }
    let index = 0;
    const seen: string[] = [];
    for (let click = 0; click < n; click++) {
      seen.push(selectSprocketQuip(index));
      index = advanceQuipIndex(index);
    }
    expect(seen).toEqual([...SPROCKET_QUIPS]);
    expect(index).toBe(0);
    expect(advanceQuipIndex(Number.NaN)).toBe(1);
    fc.assert(
      fc.property(fc.double(), (i) => {
        const next = advanceQuipIndex(i);
        expect(Number.isInteger(next) && next >= 0 && next < n).toBe(true);
      }),
      RUNS,
    );
  });
});

// ---------------------------------------------------------------------------
// pickInspectionTarget
// ---------------------------------------------------------------------------

function disc(id: string, confidence: number): GhostDiscovery {
  return {
    id,
    sourceId: `${id}-s`,
    targetId: `${id}-t`,
    rationale: "r",
    confidence,
    discoveredAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("pickInspectionTarget", () => {
  it("picks the highest-confidence new discovery", () => {
    const prev = [disc("old", 0.99)];
    const next = [disc("old", 0.99), disc("a", 0.4), disc("b", 0.8), disc("c", 0.6)];
    expect(pickInspectionTarget(prev, next)?.id).toBe("b");
  });

  it("breaks ties by the smaller id, whatever the array order", () => {
    const x = disc("m", 0.7);
    const y = disc("c", 0.7);
    const z = disc("z", 0.7);
    expect(pickInspectionTarget([], [x, y, z])?.id).toBe("c");
    expect(pickInspectionTarget([], [z, y, x])?.id).toBe("c");
  });

  it("returns undefined when nothing is new", () => {
    expect(pickInspectionTarget([], [])).toBeUndefined();
    const same = [disc("a", 0.5), disc("b", 0.6)];
    expect(pickInspectionTarget(same, same)).toBeUndefined();
    expect(pickInspectionTarget(same, [disc("a", 0.9)])).toBeUndefined();
  });

  it("is independent of input order and ignores NaN confidence", () => {
    const list = [disc("n", Number.NaN), disc("k", 0.2)];
    expect(pickInspectionTarget([], list)?.id).toBe("k");
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.tuple(fc.stringMatching(/^d[0-9a-f]{1,3}$/), fc.double({ min: 0, max: 1, noNaN: true })), {
          selector: (t) => t[0],
          minLength: 1,
          maxLength: 12,
        }),
        fc.nat(),
        (pairs, shift) => {
          const items = pairs.map(([id, c]) => disc(id, c));
          const rotated = [...items.slice(shift % items.length), ...items.slice(0, shift % items.length)];
          const a = pickInspectionTarget([], items);
          const b = pickInspectionTarget([], rotated);
          expect(a?.id).toBe(b?.id);
          const best = Math.max(...items.map((d) => d.confidence));
          expect(a?.confidence).toBe(best);
        },
      ),
      RUNS,
    );
  });
});

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

const KINDS: readonly ToastKind[] = ["EMPTY_DROP", "TRAIL_END", "ARXIV_INVALID"];

describe("retro toast catalog and reducer", () => {
  it("uses the exact copy", () => {
    expect(EMPTY_DROP_MESSAGE).toBe(
      "Even a 1945 vacuum tube cannot decipher blank parchment, Professor. Feed the platen some ink.",
    );
    expect(TRAIL_END_MESSAGE).toBe(
      "You have arrived at the frontier of human knowledge. Blaze a new trail to proceed.",
    );
    expect(ARXIV_INVALID_MESSAGE).toBe(
      "The signal was lost in the ether. Please check your arXiv identifier.",
    );
    expect(TOAST_CATALOG.EMPTY_DROP.message).toBe(EMPTY_DROP_MESSAGE);
    expect(TOAST_CATALOG.TRAIL_END.message).toBe(TRAIL_END_MESSAGE);
    expect(TOAST_CATALOG.ARXIV_INVALID.message).toBe(ARXIV_INVALID_MESSAGE);
    for (const k of KINDS) expect(TOAST_CATALOG[k].label).toMatch(/^\[ SIGNAL \/\/ [A-Z]+ \]$/);
  });

  it("drops an identical consecutive message", () => {
    const once = pushToast(EMPTY_TOAST_STATE, "TRAIL_END");
    expect(once.toasts).toHaveLength(1);
    expect(pushToast(once, "TRAIL_END")).toBe(once);
    const other = pushToast(once, "EMPTY_DROP");
    expect(other.toasts).toHaveLength(2);
    // Not consecutive any more, so the first message may show again.
    expect(pushToast(other, "TRAIL_END").toasts).toHaveLength(3);
  });

  it("allows the same message again after the visible one is dismissed", () => {
    const once = pushToast(EMPTY_TOAST_STATE, "ARXIV_INVALID");
    const gone = dismissToast(once, once.toasts[0].id);
    expect(gone.toasts).toHaveLength(0);
    expect(pushToast(gone, "ARXIV_INVALID").toasts).toHaveLength(1);
  });

  it("never holds more than three toasts, and keeps the newest", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...KINDS), { maxLength: 40 }), (kinds) => {
        let state = EMPTY_TOAST_STATE;
        for (const k of kinds) {
          state = pushToast(state, k);
          expect(state.toasts.length).toBeLessThanOrEqual(MAX_TOASTS);
          // No two neighbours share a message.
          for (let i = 1; i < state.toasts.length; i++) {
            expect(state.toasts[i].message).not.toBe(state.toasts[i - 1].message);
          }
        }
        if (kinds.length > 0) {
          expect(state.toasts[state.toasts.length - 1].message).toBe(
            TOAST_CATALOG[kinds[kinds.length - 1]].message,
          );
        }
        const ids = state.toasts.map((t) => t.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect([...ids]).toEqual([...ids].sort((a, b) => a - b));
      }),
      RUNS,
    );
  });

  it("evicts the oldest toast when a fourth arrives", () => {
    // Alternate so no two neighbours are identical.
    let s = EMPTY_TOAST_STATE;
    for (const k of ["EMPTY_DROP", "TRAIL_END", "ARXIV_INVALID", "EMPTY_DROP"] as const) {
      s = pushToast(s, k);
    }
    expect(s.toasts.map((t) => t.kind)).toEqual(["TRAIL_END", "ARXIV_INVALID", "EMPTY_DROP"]);
  });

  it("dismisses by id and ignores unknown ids", () => {
    let s = pushToast(EMPTY_TOAST_STATE, "EMPTY_DROP");
    s = pushToast(s, "TRAIL_END");
    expect(dismissToast(s, 999)).toBe(s);
    const next = dismissToast(s, s.toasts[0].id);
    expect(next.toasts.map((t) => t.kind)).toEqual(["TRAIL_END"]);
  });
});

describe("toast store is session-only", () => {
  afterEach(() => {
    useToastStore.getState().clear();
  });

  it("stacks, dedupes and dismisses through the store", () => {
    const { show, dismiss } = useToastStore.getState();
    show("TRAIL_END");
    show("TRAIL_END");
    expect(useToastStore.getState().toasts).toHaveLength(1);
    show("EMPTY_DROP");
    expect(useToastStore.getState().toasts).toHaveLength(2);
    dismiss(useToastStore.getState().toasts[0].id);
    expect(useToastStore.getState().toasts.map((t) => t.kind)).toEqual(["EMPTY_DROP"]);
  });

  it("never reaches the exported graph JSON or the persisted save", () => {
    useToastStore.getState().show("EMPTY_DROP");
    useToastStore.getState().show("ARXIV_INVALID");
    const json = useMemexStore.getState().exportJson();
    expect(json).not.toContain("toast");
    expect(json).not.toContain(EMPTY_DROP_MESSAGE);
    expect(json).not.toContain(ARXIV_INVALID_MESSAGE);
    expect(Object.keys(JSON.parse(json)).sort()).toEqual(
      ["edges", "ghostDiscoveries", "nodes", "trails"].sort(),
    );
    // The graph store holds no toast state either.
    expect("toasts" in useMemexStore.getState()).toBe(false);
    expect(STORAGE_KEY).not.toContain("toast");
  });
});
