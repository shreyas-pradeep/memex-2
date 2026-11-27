import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  SPROCKET_SCURRY_MS,
  getPerchPosition,
  getTraversalPoint,
  unionOfRects,
  type Rect,
  type WireDirection,
} from "../sprocket-engine";
import {
  CURSOR_NEAR_PX,
  INITIAL_SPROCKET_MACHINE,
  PUPIL_MAX_RADIUS,
  PUPIL_TRAVEL_UNITS,
  SCURRY_FLIGHT_MS,
  SPARK_COLORS,
  SPROCKET_EVENTS,
  SPROCKET_PHYSICS,
  SPROCKET_STATES,
  SPROCKET_TRANSITIONS,
  WEAVE_PROMPT_TEXT,
  WEAVE_SAMPLES,
  arcFractionAt,
  canStartWeave,
  flightMsFor,
  isCursorNear,
  isTravellingState,
  legPointAt,
  planWeave,
  planWeaveLeg,
  pointDistance,
  polylinePath,
  pupilOffset,
  pupilToSprite,
  rectsSignature,
  reduceSprocket,
  shouldShowWeavePrompt,
  sparkBurst,
  weaveDoneText,
  weaveProgressText,
  type SprocketEvent,
  type SprocketMachine,
  type SprocketState,
} from "../sprocket-motion";

const RUNS = { numRuns: 200 };

const coordinate = fc.oneof(
  fc.double({ min: -5000, max: 5000, noNaN: true }),
  fc.constantFrom(0, -0, 1e12, -1e12, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
);
const anyNumber = fc.oneof(coordinate, fc.constant(Number.NaN));
const point = fc.record({ x: coordinate, y: coordinate });
const anyPoint = fc.record({ x: anyNumber, y: anyNumber });
const rect = fc.record({
  x: fc.integer({ min: -2000, max: 2000 }),
  y: fc.integer({ min: -2000, max: 2000 }),
  width: fc.integer({ min: 40, max: 600 }),
  height: fc.integer({ min: 40, max: 400 }),
});

// ---------------------------------------------------------------------------
// Squash and stretch constants
// ---------------------------------------------------------------------------

describe("SPROCKET_PHYSICS", () => {
  it("matches the Spec 07 values", () => {
    expect(SPROCKET_PHYSICS.anticipation).toEqual({ scaleX: 1.25, scaleY: 0.7, durationMs: 150 });
    expect(SPROCKET_PHYSICS.flight).toEqual({ scaleX: 0.8, scaleY: 1.35 });
    expect(SPROCKET_PHYSICS.landing.scaleY).toBe(0.75);
    expect(SPROCKET_PHYSICS.landing.spring).toEqual({ type: "spring", stiffness: 450, damping: 18 });
    expect(SPROCKET_PHYSICS.rest).toEqual({ scaleX: 1, scaleY: 1 });
  });

  it("stretch and squash keep their direction (tall is thin, squat is wide)", () => {
    const { anticipation: a, flight: f, landing: l } = SPROCKET_PHYSICS;
    expect(a.scaleY).toBeLessThan(1);
    expect(a.scaleX).toBeGreaterThan(1);
    expect(f.scaleY).toBeGreaterThan(1);
    expect(f.scaleX).toBeLessThan(1);
    expect(l.scaleY).toBeLessThan(1);
    expect(l.scaleX).toBeGreaterThan(1);
  });

  it("fits wind-up and flight into the 800 ms camera glide", () => {
    expect(SCURRY_FLIGHT_MS).toBe(SPROCKET_SCURRY_MS - SPROCKET_PHYSICS.anticipation.durationMs);
    expect(SCURRY_FLIGHT_MS).toBe(650);
    expect(SPROCKET_PHYSICS.anticipation.durationMs + SCURRY_FLIGHT_MS).toBe(800);
  });

  it("flightMsFor never goes negative", () => {
    fc.assert(
      fc.property(anyNumber, (ms) => {
        const f = flightMsFor(ms);
        expect(Number.isFinite(f)).toBe(true);
        expect(f).toBeGreaterThanOrEqual(0);
      }),
      RUNS,
    );
  });
});

// ---------------------------------------------------------------------------
// Eye tracking
// ---------------------------------------------------------------------------

describe("pupilOffset", () => {
  it("stays within the 6 px radius and always returns finite numbers", () => {
    fc.assert(
      fc.property(anyPoint, anyPoint, (center, pointer) => {
        const o = pupilOffset(center, pointer, PUPIL_MAX_RADIUS);
        expect(Number.isFinite(o.x)).toBe(true);
        expect(Number.isFinite(o.y)).toBe(true);
        expect(Math.hypot(o.x, o.y)).toBeLessThanOrEqual(PUPIL_MAX_RADIUS + 1e-9);
      }),
      RUNS,
    );
  });

  it("points toward the pointer", () => {
    fc.assert(
      fc.property(point, point, (center, pointer) => {
        const o = pupilOffset(center, pointer, PUPIL_MAX_RADIUS);
        const dx = Math.max(-1e12, Math.min(1e12, pointer.x)) - Math.max(-1e12, Math.min(1e12, center.x));
        const dy = Math.max(-1e12, Math.min(1e12, pointer.y)) - Math.max(-1e12, Math.min(1e12, center.y));
        const len = Math.hypot(dx, dy);
        if (len === 0) {
          expect(o).toEqual({ x: 0, y: 0 });
          return;
        }
        // Parallel and in the same direction: cross product ~ 0, dot product >= 0.
        // (Divided by the distance so huge coordinates do not swamp the tolerance.)
        expect((o.x * dy - o.y * dx) / len).toBeCloseTo(0, 6);
        expect((o.x * dx + o.y * dy) / len).toBeGreaterThanOrEqual(0);
        // Magnitude is the distance, capped at the radius.
        expect(Math.hypot(o.x, o.y)).toBeCloseTo(Math.min(PUPIL_MAX_RADIUS, len), 6);
      }),
      RUNS,
    );
  });

  it("is zero when the pointer is at the center", () => {
    fc.assert(
      fc.property(point, (center) => {
        expect(pupilOffset(center, { ...center }, PUPIL_MAX_RADIUS)).toEqual({ x: 0, y: 0 });
      }),
      RUNS,
    );
  });

  it("is zero for NaN input or an unusable radius", () => {
    expect(pupilOffset({ x: Number.NaN, y: 0 }, { x: 10, y: 0 }, 6)).toEqual({ x: 0, y: 0 });
    expect(pupilOffset({ x: 0, y: 0 }, { x: 10, y: Number.NaN }, 6)).toEqual({ x: 0, y: 0 });
    for (const r of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(pupilOffset({ x: 0, y: 0 }, { x: 10, y: 0 }, r)).toEqual({ x: 0, y: 0 });
    }
  });

  it("looks right for a pointer to the right, and handles infinity", () => {
    expect(pupilOffset({ x: 0, y: 0 }, { x: 100, y: 0 }, 6)).toEqual({ x: 6, y: 0 });
    expect(pupilOffset({ x: 0, y: 0 }, { x: 3, y: 4 }, 6)).toEqual({ x: 3, y: 4 });
    const far = pupilOffset({ x: 0, y: 0 }, { x: Number.POSITIVE_INFINITY, y: 0 }, 6);
    expect(far.x).toBeCloseTo(6, 6);
    expect(far.y).toBeCloseTo(0, 6);
  });

  it("maps into the eye socket in sprite units", () => {
    fc.assert(
      fc.property(anyPoint, anyPoint, (center, pointer) => {
        const u = pupilToSprite(pupilOffset(center, pointer, PUPIL_MAX_RADIUS));
        expect(Math.hypot(u.x, u.y)).toBeLessThanOrEqual(PUPIL_TRAVEL_UNITS + 1e-9);
      }),
      RUNS,
    );
    // Socket radius 3.6 minus pupil radius 2.1.
    expect(PUPIL_TRAVEL_UNITS).toBeCloseTo(3.6 - 2.1, 9);
  });
});

describe("isCursorNear", () => {
  it("is true within 60 px (inclusive) and false beyond", () => {
    expect(CURSOR_NEAR_PX).toBe(60);
    expect(isCursorNear(0, 60)).toBe(true);
    expect(isCursorNear(60, 60)).toBe(true);
    expect(isCursorNear(60.0001, 60)).toBe(false);
    expect(isCursorNear(59.9)).toBe(true);
  });

  it("agrees with a plain comparison for finite non-negative values", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1e6, noNaN: true }), fc.double({ min: 0, max: 1e6, noNaN: true }), (d, t) => {
        expect(isCursorNear(d, t)).toBe(d <= t);
      }),
      RUNS,
    );
  });

  it("is false for NaN, negative, infinite or invalid thresholds", () => {
    for (const d of [Number.NaN, -1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(isCursorNear(d, 60)).toBe(false);
    }
    for (const t of [Number.NaN, -1, Number.POSITIVE_INFINITY]) expect(isCursorNear(10, t)).toBe(false);
  });

  it("pointDistance is symmetric and never NaN", () => {
    fc.assert(
      fc.property(anyPoint, anyPoint, (a, b) => {
        const d = pointDistance(a, b);
        expect(Number.isNaN(d)).toBe(false);
        expect(d).toBe(pointDistance(b, a));
        expect(d).toBeGreaterThanOrEqual(0);
      }),
      RUNS,
    );
  });
});

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

describe("Sprocket state machine", () => {
  const at = (state: SprocketState, happy = false): SprocketMachine => ({ state, happy });

  it("has the seven documented states", () => {
    expect([...SPROCKET_STATES]).toEqual([
      "idle",
      "anticipating",
      "travelling",
      "landing",
      "inspecting",
      "weaving",
      "celebrating",
    ]);
  });

  it("follows the transition table exactly", () => {
    expect(SPROCKET_TRANSITIONS).toEqual({
      idle: { MOVE: "anticipating", WEAVE: "weaving" },
      anticipating: { LIFTOFF: "travelling" },
      travelling: { TOUCHDOWN: "landing" },
      landing: { SETTLE: "idle", INSPECT: "inspecting" },
      inspecting: { MOVE: "anticipating", SETTLE: "idle" },
      weaving: { CELEBRATE: "celebrating" },
      celebrating: { SETTLE: "idle" },
    });
  });

  it("applies every legal transition and ignores every illegal one (same object back)", () => {
    for (const state of SPROCKET_STATES) {
      for (const event of SPROCKET_EVENTS) {
        const m = at(state);
        const next = reduceSprocket(m, event);
        if (event === "INTERRUPT") {
          expect(next.state).toBe("idle");
        } else if (event === "HAPPY_ON") {
          expect(next).toEqual({ state, happy: true });
        } else if (event === "HAPPY_OFF") {
          expect(next).toBe(m);
        } else {
          const target = SPROCKET_TRANSITIONS[state][event];
          if (target === undefined) expect(next).toBe(m);
          else expect(next).toEqual({ state: target, happy: false });
        }
      }
    }
  });

  it("walks the full move and the full weave", () => {
    const run = (events: SprocketEvent[]) => events.reduce(reduceSprocket, INITIAL_SPROCKET_MACHINE).state;
    expect(run(["MOVE", "LIFTOFF", "TOUCHDOWN", "SETTLE"])).toBe("idle");
    expect(run(["MOVE", "LIFTOFF", "TOUCHDOWN", "INSPECT"])).toBe("inspecting");
    expect(run(["MOVE", "LIFTOFF", "TOUCHDOWN", "INSPECT", "MOVE", "LIFTOFF", "TOUCHDOWN", "SETTLE"])).toBe("idle");
    expect(run(["WEAVE"])).toBe("weaving");
    expect(run(["WEAVE", "CELEBRATE"])).toBe("celebrating");
    expect(run(["WEAVE", "CELEBRATE", "SETTLE"])).toBe("idle");
  });

  it("ignores a second WEAVE and a move while weaving or celebrating", () => {
    const weaving = reduceSprocket(INITIAL_SPROCKET_MACHINE, "WEAVE");
    expect(reduceSprocket(weaving, "WEAVE")).toBe(weaving);
    expect(reduceSprocket(weaving, "MOVE")).toBe(weaving);
    const celebrating = reduceSprocket(weaving, "CELEBRATE");
    expect(reduceSprocket(celebrating, "WEAVE")).toBe(celebrating);
    expect(reduceSprocket(celebrating, "MOVE")).toBe(celebrating);
  });

  it("INTERRUPT returns to idle from any state, keeping the happy overlay", () => {
    for (const state of SPROCKET_STATES) {
      for (const happy of [false, true]) {
        const next = reduceSprocket(at(state, happy), "INTERRUPT");
        expect(next.state).toBe("idle");
        expect(next.happy).toBe(happy);
      }
    }
    expect(reduceSprocket(INITIAL_SPROCKET_MACHINE, "INTERRUPT")).toBe(INITIAL_SPROCKET_MACHINE);
  });

  it("the happy overlay is orthogonal to the lifecycle state", () => {
    for (const state of SPROCKET_STATES) {
      const on = reduceSprocket(at(state), "HAPPY_ON");
      expect(on).toEqual({ state, happy: true });
      expect(reduceSprocket(on, "HAPPY_ON")).toBe(on);
      expect(reduceSprocket(on, "HAPPY_OFF")).toEqual({ state, happy: false });
    }
  });

  it("any event sequence leaves a valid state and never throws", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...SPROCKET_EVENTS), { maxLength: 40 }), (events) => {
        let m = INITIAL_SPROCKET_MACHINE;
        for (const e of events) {
          const next = reduceSprocket(m, e);
          expect(SPROCKET_STATES).toContain(next.state);
          m = next;
        }
        // One interrupt always gets back to idle.
        expect(reduceSprocket(m, "INTERRUPT").state).toBe("idle");
      }),
      RUNS,
    );
  });

  it("only travelling and weaving rock the legs", () => {
    expect(SPROCKET_STATES.filter(isTravellingState)).toEqual(["travelling", "weaving"]);
  });
});

// ---------------------------------------------------------------------------
// Weave plan
// ---------------------------------------------------------------------------

describe("weave plan", () => {
  it("samples the exact traversal: starts on the first perch, ends on the second, inside the union box", () => {
    fc.assert(
      fc.property(rect, rect, fc.constantFrom<WireDirection>("forward", "reverse", "none"), (a, b, direction) => {
        const leg = planWeaveLeg("a", "b", a, b, direction);
        expect(leg.points).toHaveLength(WEAVE_SAMPLES + 1);
        expect(leg.points[0]).toEqual(getPerchPosition(a));
        expect(leg.points[leg.points.length - 1]).toEqual(getPerchPosition(b));
        const box = unionOfRects(a, b);
        for (const p of leg.points) {
          expect(p.x).toBeGreaterThanOrEqual(box.minX - 1e-9);
          expect(p.x).toBeLessThanOrEqual(box.maxX + 1e-9);
          expect(p.y).toBeGreaterThanOrEqual(box.minY - 1e-9);
          expect(p.y).toBeLessThanOrEqual(box.maxY + 1e-9);
        }
        for (let i = 0; i < leg.points.length; i += 8) {
          const k = i / WEAVE_SAMPLES;
          expect(legPointAt(leg, k).x).toBeCloseTo(getTraversalPoint(a, b, k, direction).x, 6);
        }
      }),
      RUNS,
    );
  });

  it("arc fraction is monotone from 0 to 1 and total for any progress", () => {
    fc.assert(
      fc.property(rect, rect, fc.array(anyNumber, { minLength: 2, maxLength: 12 }), (a, b, ks) => {
        const leg = planWeaveLeg("a", "b", a, b, "forward");
        expect(leg.arc[0]).toBe(0);
        expect(leg.arc[leg.arc.length - 1]).toBe(1);
        for (let i = 1; i < leg.arc.length; i++) expect(leg.arc[i]).toBeGreaterThanOrEqual(leg.arc[i - 1]);
        expect(arcFractionAt(leg, 0)).toBe(0);
        expect(arcFractionAt(leg, 1)).toBeCloseTo(1, 9);
        const sorted = ks.filter((k) => !Number.isNaN(k)).sort((x, y) => x - y);
        let last = 0;
        for (const k of sorted) {
          const f = arcFractionAt(leg, k);
          expect(f).toBeGreaterThanOrEqual(last - 1e-12);
          expect(f).toBeGreaterThanOrEqual(0);
          expect(f).toBeLessThanOrEqual(1 + 1e-12);
          last = f;
        }
        expect(arcFractionAt(leg, Number.NaN)).toBe(0);
        const p = legPointAt(leg, Number.NaN);
        expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      }),
      RUNS,
    );
  });

  it("plans one connected leg per consecutive pair and skips unknown or repeated stops", () => {
    fc.assert(
      fc.property(fc.array(rect, { minLength: 0, maxLength: 8 }), (rects) => {
        const ids = rects.map((_, i) => `n${i}`);
        const map = new Map(ids.map((id, i) => [id, rects[i]]));
        const legs = planWeave([...ids, "ghost-missing"], map, () => "none");
        expect(legs).toHaveLength(Math.max(0, ids.length - 1));
        legs.forEach((leg, i) => {
          expect(leg.fromId).toBe(ids[i]);
          expect(leg.toId).toBe(ids[i + 1]);
          if (i > 0) expect(leg.points[0]).toEqual(legs[i - 1].points[legs[i - 1].points.length - 1]);
        });
      }),
      RUNS,
    );
    const map = new Map([["a", { x: 0, y: 0, width: 100, height: 100 }]]);
    expect(planWeave(["a", "a", "a"], map, () => "none")).toEqual([]);
  });

  it("polylinePath draws M then L segments", () => {
    expect(polylinePath([])).toBe("");
    expect(polylinePath([{ x: 1, y: 2 }])).toBe("");
    expect(polylinePath([{ x: 1, y: 2 }, { x: 3.456, y: 4 }])).toBe("M1 2 L3.46 4");
  });

  it("rectsSignature changes when a card moves or disappears", () => {
    const rects = new Map<string, Rect>([["a", { x: 0, y: 0, width: 10, height: 10 }]]);
    const sig = rectsSignature(["a", "b"], rects);
    rects.set("a", { x: 1, y: 0, width: 10, height: 10 });
    expect(rectsSignature(["a", "b"], rects)).not.toBe(sig);
    expect(rectsSignature(["a", "b"], rects)).toContain("b:-");
  });
});

// ---------------------------------------------------------------------------
// Sparks, copy and trigger rules
// ---------------------------------------------------------------------------

describe("celebration sparks", () => {
  it("bursts 6 to 10 brass sparks and is deterministic", () => {
    fc.assert(
      fc.property(anyNumber, (n) => {
        const a = sparkBurst(n);
        expect(a.length).toBeGreaterThanOrEqual(6);
        expect(a.length).toBeLessThanOrEqual(10);
        expect(a).toEqual(sparkBurst(n));
        for (const s of a) expect(SPARK_COLORS).toContain(s.color);
      }),
      RUNS,
    );
    expect(sparkBurst()).toHaveLength(8);
    expect([...SPARK_COLORS]).toEqual(["#D97706", "#FFB236"]);
  });
});

describe("weave trigger rules", () => {
  const base = { cardCount: 5, activeTrailId: null, isWeaving: false } as const;

  it("needs three cards, no playing trail and no weave in progress", () => {
    expect(canStartWeave(base)).toBe(true);
    expect(canStartWeave({ ...base, cardCount: 2 })).toBe(false);
    expect(canStartWeave({ ...base, cardCount: 3 })).toBe(true);
    expect(canStartWeave({ ...base, activeTrailId: "t1" })).toBe(false);
    expect(canStartWeave({ ...base, isWeaving: true })).toBe(false);
    expect(canStartWeave({ ...base, cardCount: Number.NaN })).toBe(false);
  });

  it("offers the prompt only when idle, once per period, with a trail to weave", () => {
    const ok = { ...base, idle: true, shownThisPeriod: false, trailAvailable: true };
    expect(shouldShowWeavePrompt(ok)).toBe(true);
    expect(shouldShowWeavePrompt({ ...ok, idle: false })).toBe(false);
    expect(shouldShowWeavePrompt({ ...ok, shownThisPeriod: true })).toBe(false);
    expect(shouldShowWeavePrompt({ ...ok, trailAvailable: false })).toBe(false);
    expect(shouldShowWeavePrompt({ ...ok, cardCount: 2 })).toBe(false);
    expect(shouldShowWeavePrompt({ ...ok, activeTrailId: "t" })).toBe(false);
    expect(shouldShowWeavePrompt({ ...ok, isWeaving: true })).toBe(false);
  });

  it("uses the documented copy", () => {
    expect(WEAVE_PROMPT_TEXT).toBe("I see a trail through these papers! Tap me to weave it.");
    expect(weaveDoneText("Lineage Arc", 7)).toBe(
      "Woven: Lineage Arc, 7 stops. The 1945 Lever is yours, Professor.",
    );
    expect(weaveDoneText("  ", 1)).toContain("Untitled Trail, 1 stop.");
    expect(weaveProgressText("Lineage Arc", 3, 7)).toBe("Weaving Lineage Arc: stop 3 of 7.");
    expect(weaveProgressText("", Number.NaN, Number.NaN)).toBe("Weaving trail: stop 1 of 1.");
  });

  it("progress text always names a stop within range", () => {
    fc.assert(
      fc.property(fc.integer({ min: -5, max: 20 }), fc.integer({ min: -5, max: 20 }), (stop, total) => {
        const text = weaveProgressText("T", stop, total);
        const m = /stop (\d+) of (\d+)/.exec(text);
        expect(m).not.toBeNull();
        expect(Number(m?.[1])).toBeLessThanOrEqual(Number(m?.[2]));
        expect(Number(m?.[1])).toBeGreaterThanOrEqual(1);
      }),
      RUNS,
    );
  });
});
