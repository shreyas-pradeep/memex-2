import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CONCEPT_LEXICON,
  DEFAULT_GHOST_THRESHOLD,
  buildAffinityContext,
  calibrateGhostConfidence,
  magneticAffinity,
  magneticRawCutoff,
  pairAffinity,
  pairMagneticAffinity,
  scoreGhostPairs,
  synthesizeBridgeRationale,
} from "../ghost-engine";
import { flowToScreen, magneticPillText, viewTransformAttribute } from "../magnetic-arc";
import { MAGNETIC_MIN_AFFINITY, MAGNETIC_RANGE_PX, buildMagneticCandidates } from "../magnetic-engine";
import type { MemexNode } from "../types";

const RUNS = { numRuns: 300 } as const;
const AT_THRESHOLD = calibrateGhostConfidence(DEFAULT_GHOST_THRESHOLD);

const score01 = fc.double({ min: 0, max: 1, noNaN: true }).map((n) => n + 0);
const threshold = fc.double({ min: 0.05, max: 0.6, noNaN: true }).map((n) => n + 0);

// ---------------------------------------------------------------------------
// magneticAffinity: the calibration extended below the detection threshold
// ---------------------------------------------------------------------------
describe("magneticAffinity", () => {
  it("stays within [0, 1] and is zero for a zero score", () => {
    expect(magneticAffinity(0)).toBe(0);
    expect(magneticAffinity(-3)).toBe(0);
    expect(magneticAffinity(Number.NaN)).toBe(0);
    fc.assert(
      fc.property(score01, threshold, (s, t) => {
        const a = magneticAffinity(s, t);
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThanOrEqual(1);
      }),
      RUNS,
    );
  });

  it("is monotone non-decreasing in the raw score", () => {
    fc.assert(
      fc.property(score01, score01, threshold, (x, y, t) => {
        const [lo, hi] = x <= y ? [x, y] : [y, x];
        expect(magneticAffinity(lo, t)).toBeLessThanOrEqual(magneticAffinity(hi, t));
      }),
      RUNS,
    );
  });

  it("equals the calibrated confidence at and above the threshold (unchanged)", () => {
    expect(magneticAffinity(DEFAULT_GHOST_THRESHOLD)).toBe(calibrateGhostConfidence(DEFAULT_GHOST_THRESHOLD));
    fc.assert(
      fc.property(threshold, fc.double({ min: 0, max: 1, noNaN: true }), (t, f) => {
        const s = t + (1 - t) * f;
        expect(magneticAffinity(s, t)).toBe(calibrateGhostConfidence(s));
        expect(magneticAffinity(s)).toBe(s >= DEFAULT_GHOST_THRESHOLD ? calibrateGhostConfidence(s) : magneticAffinity(s));
      }),
      RUNS,
    );
  });

  it("is continuous at the threshold: just below it is within the ramp slope (plus rounding) of the calibrated value", () => {
    fc.assert(
      fc.property(threshold, fc.double({ min: 1e-9, max: 1e-3, noNaN: true }), (t, eps) => {
        const at = calibrateGhostConfidence(t);
        const below = magneticAffinity(t - eps, t);
        expect(below).toBeLessThanOrEqual(at);
        // ramp slope is at / t; rounding to 3 decimals adds at most 0.0005 per side
        expect(at - below).toBeLessThanOrEqual((at / t) * eps + 0.001);
      }),
      RUNS,
    );
  });

  it("ramps linearly below the threshold, from 0 to the calibrated value at the threshold", () => {
    fc.assert(
      fc.property(threshold, fc.double({ min: 0.001, max: 1, noNaN: true }), (t, f) => {
        const s = t * f;
        if (s >= t) return;
        expect(Math.abs(magneticAffinity(s, t) - calibrateGhostConfidence(t) * (s / t))).toBeLessThanOrEqual(0.0005 + 1e-12);
      }),
      RUNS,
    );
  });

  it("documents the numbers: the ramp ends at 0.87 (not 0.78) and a 0.55 floor cuts at raw 0.19", () => {
    expect(AT_THRESHOLD).toBe(0.87);
    const cutoff = magneticRawCutoff(MAGNETIC_MIN_AFFINITY);
    expect(cutoff).toBeCloseTo(0.3 * 0.55 / 0.87, 10);
    expect(cutoff).toBeCloseTo(0.1897, 4);
    // Just under the cutoff does not reach the floor; just over does.
    expect(magneticAffinity(cutoff - 0.002)).toBeLessThan(MAGNETIC_MIN_AFFINITY);
    expect(magneticAffinity(cutoff + 0.002)).toBeGreaterThanOrEqual(MAGNETIC_MIN_AFFINITY);
  });

  it("the raw cutoff matches the floor for any floor below the affinity at the threshold", () => {
    fc.assert(
      fc.property(threshold, fc.double({ min: 0.05, max: 0.99, noNaN: true }), (t, f) => {
        const floor = f * calibrateGhostConfidence(t);
        const cutoff = magneticRawCutoff(floor, t);
        expect(cutoff).toBeGreaterThanOrEqual(0);
        expect(cutoff).toBeLessThanOrEqual(t + 1e-12);
        expect(Math.abs(magneticAffinity(cutoff, t) - floor)).toBeLessThanOrEqual(0.0006);
      }),
      RUNS,
    );
  });
});

// ---------------------------------------------------------------------------
// The guard and the scene arbitrary
// ---------------------------------------------------------------------------
const CONCEPT_WORDS = ["hypertext", "memory", "attention", "graph", "knowledge", "spatial", "machine", "trail"];
const PLAIN_WORDS = ["banana", "oven", "river", "lantern", "orchard", "velvet", "copper", "meadow", "harbor", "quartz"];
const TAGS = ["alpha", "beta", "gamma", "delta", "memory", "attention"];

function card(id: string, words: string[], tags: string[], x = 0, y = 0): MemexNode {
  return {
    id,
    type: "memexCard",
    position: { x, y },
    style: { width: 340, height: 230 },
    data: {
      archivalId: `MEM-${id}`,
      title: `${words[0] ?? "card"} ${id}`,
      content: words.join(" "),
      cardType: "note",
      tags,
      createdAt: "2026-01-02T03:04:05.000Z",
    },
  };
}

const wordsArb = fc.array(fc.constantFrom(...CONCEPT_WORDS, ...PLAIN_WORDS), { minLength: 1, maxLength: 8 });
const tagsArb = fc.uniqueArray(fc.constantFrom(...TAGS), { maxLength: 3 });
const corpusArb = fc
  .array(fc.record({ words: wordsArb, tags: tagsArb }), { minLength: 2, maxLength: 7 })
  .map((specs) => specs.map((s, i) => card(`c${i}`, s.words, s.tags)));

describe("pairMagneticAffinity and the spurious-pair guard", () => {
  it("matches magneticAffinity, gates sub-threshold pairs without a shared concept or tag, and never touches pairs above the threshold", () => {
    const seen = { gated: 0, rampWithEvidence: 0, aboveThreshold: 0 };
    fc.assert(
      fc.property(corpusArb, (nodes) => {
        const ctx = buildAffinityContext(nodes);
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const m = pairMagneticAffinity(nodes[i], nodes[j], ctx);
            const reverse = pairMagneticAffinity(nodes[j], nodes[i], ctx);
            expect(reverse).toEqual(m);
            const old = pairAffinity(nodes[i], nodes[j], ctx);
            expect(m.score).toBe(old.score);
            expect(m.sharedConcepts).toEqual(old.sharedConcepts);
            const evidence = m.sharedConcepts.length > 0 || m.sharedTags.length > 0;
            expect(m.subThreshold).toBe(m.score < DEFAULT_GHOST_THRESHOLD);
            if (!m.subThreshold) {
              // The Ghost engine's own number, whatever the evidence.
              expect(m.affinity).toBe(old.affinity);
              if (m.score > 0) seen.aboveThreshold++;
            } else if (!evidence) {
              expect(m.affinity).toBe(0);
              if (m.score > 0) seen.gated++;
            } else {
              expect(m.affinity).toBe(magneticAffinity(m.score));
              expect(old.affinity).toBe(0);
              if (m.score > 0) seen.rampWithEvidence++;
            }
          }
        }
      }),
      RUNS,
    );
    // Every branch was exercised.
    expect(seen.gated).toBeGreaterThan(20);
    expect(seen.rampWithEvidence).toBeGreaterThan(20);
    expect(seen.aboveThreshold).toBeGreaterThan(20);
  });

  it("buildMagneticCandidates: candidates at or above the floor, sub-threshold ones only with a shared concept or tag and a shared-evidence rationale", () => {
    const counts = { sub: 0, above: 0 };
    fc.assert(
      fc.property(corpusArb, (nodes) => {
        const raw = new Map(scoreGhostPairs(nodes).map((p) => [`${p.sourceId}|${p.targetId}`, p]));
        for (const dragged of nodes) {
          const ctx = buildAffinityContext(nodes);
          const candidates = buildMagneticCandidates(dragged.id, nodes, []);
          const ids = new Set(candidates.map((c) => c.targetId));
          for (const other of nodes) {
            if (other.id === dragged.id) continue;
            const m = pairMagneticAffinity(dragged, other, ctx);
            expect(ids.has(other.id)).toBe(m.affinity >= MAGNETIC_MIN_AFFINITY);
          }
          for (const c of candidates) {
            const [lo, hi] = dragged.id <= c.targetId ? [dragged.id, c.targetId] : [c.targetId, dragged.id];
            const pair = raw.get(`${lo}|${hi}`);
            expect(pair).toBeDefined();
            if (pair === undefined) continue;
            expect(c.affinity).toBeGreaterThanOrEqual(MAGNETIC_MIN_AFFINITY);
            expect(c.affinity).toBeLessThanOrEqual(0.96);
            // The pill percentage is round(affinity * 100).
            expect(magneticPillText(c)).toContain(`⚡ ${Math.round(c.affinity * 100)}% Nexus:`);
            const other = nodes.find((n) => n.id === c.targetId) as MemexNode;
            if (pair.score >= DEFAULT_GHOST_THRESHOLD) {
              counts.above++;
              expect(c.rationale).toBe(synthesizeBridgeRationale(dragged, other));
              expect(c.affinity).toBe(calibrateGhostConfidence(pair.score));
            } else {
              counts.sub++;
              expect(pair.sharedConcepts.length > 0 || c.rationale.includes("Shared tag")).toBe(true);
              expect(c.rationale).toMatch(/Shared (concept|concepts|tag|tags): /);
              for (const id of pair.sharedConcepts.slice(0, 3)) expect(c.rationale).toContain(CONCEPT_LEXICON[id].label);
              // A score just under the threshold rounds to the value at the threshold.
              expect(c.affinity).toBeLessThanOrEqual(AT_THRESHOLD);
              expect(c.affinity).toBe(magneticAffinity(pair.score));
            }
            expect(c.concept.length).toBeGreaterThan(0);
          }
        }
      }),
      RUNS,
    );
    expect(counts.sub).toBeGreaterThan(20);
    expect(counts.above).toBeGreaterThan(20);
  });

  it("a pair that shares only vocabulary (no concept, no tag) never becomes a sub-threshold candidate", () => {
    const a = card("a", ["banana", "river", "oven", "banana", "lantern"], ["alpha"]);
    const b = card("b", ["banana", "river", "oven", "meadow"], ["beta"]);
    const ctx = buildAffinityContext([a, b]);
    const m = pairMagneticAffinity(a, b, ctx);
    expect(m.score).toBeGreaterThan(magneticRawCutoff(MAGNETIC_MIN_AFFINITY));
    expect(m.score).toBeLessThan(DEFAULT_GHOST_THRESHOLD);
    expect(m.sharedConcepts).toEqual([]);
    expect(m.sharedTags).toEqual([]);
    expect(m.affinity).toBe(0);
    expect(buildMagneticCandidates("a", [a, b], [])).toEqual([]);
    // Shared tags alone are enough evidence (raw score about 0.235: below the 0.3 threshold, above the 0.19 cutoff).
    const t1 = card("a", ["banana", "river", "oven", "lantern"], ["alpha", "beta", "gamma"]);
    const t2 = card("b", ["quartz", "harbor", "meadow", "velvet"], ["alpha", "beta", "delta"]);
    const tagged = pairMagneticAffinity(t1, t2, buildAffinityContext([t1, t2]));
    expect(tagged.subThreshold).toBe(true);
    expect(tagged.sharedConcepts).toEqual([]);
    expect(tagged.sharedTags).toEqual(["alpha", "beta"]);
    const [cand] = buildMagneticCandidates("a", [t1, t2], []);
    expect(cand).toBeDefined();
    expect(cand.concept).toBe("alpha");
    expect(cand.rationale).toBe('"banana a" and "quartz b" were never linked. Shared tags: alpha and beta.');
    expect(cand.affinity).toBe(magneticAffinity(tagged.score));
    expect(magneticPillText(cand)).toBe(`⚡ ${Math.round(cand.affinity * 100)}% Nexus: alpha — Drop to Snap Synapse`);
    expect(Math.round(cand.affinity * 100)).toBe(68);
  });

  it("the range constant is 380 and the affinity floor 0.55", () => {
    expect(MAGNETIC_RANGE_PX).toBe(380);
    expect(MAGNETIC_MIN_AFFINITY).toBe(0.55);
  });
});

// ---------------------------------------------------------------------------
// Arc view transform: flow coordinates to screen coordinates
// ---------------------------------------------------------------------------
describe("arc view transform", () => {
  const view = fc.record({
    x: fc.integer({ min: -5000, max: 5000 }),
    y: fc.integer({ min: -5000, max: 5000 }),
    zoom: fc.double({ min: 0.15, max: 2.5, noNaN: true }).map((n) => n + 0),
  });
  const point = fc.record({ x: fc.integer({ min: -5000, max: 5000 }), y: fc.integer({ min: -5000, max: 5000 }) });

  it("flowToScreen is `p * zoom + translate` and inverts back to the flow point", () => {
    fc.assert(
      fc.property(point, view, (p, v) => {
        const s = flowToScreen(p, v);
        expect(s.x).toBeCloseTo(p.x * v.zoom + v.x, 9);
        expect(s.y).toBeCloseTo(p.y * v.zoom + v.y, 9);
        expect((s.x - v.x) / v.zoom).toBeCloseTo(p.x, 6);
        expect((s.y - v.y) / v.zoom).toBeCloseTo(p.y, 6);
      }),
      RUNS,
    );
  });

  it("the SVG transform attribute is the same translate-then-scale React Flow writes to the viewport", () => {
    expect(viewTransformAttribute({ x: 12.5, y: -40, zoom: 0.5 })).toBe("translate(12.5 -40) scale(0.5)");
    fc.assert(
      fc.property(view, (v) => {
        const m = /^translate\((-?[\d.]+) (-?[\d.]+)\) scale\(([\d.e-]+)\)$/.exec(viewTransformAttribute(v));
        expect(m).not.toBeNull();
        expect(Number(m?.[1])).toBe(v.x);
        expect(Number(m?.[2])).toBe(v.y);
        expect(Number(m?.[3])).toBe(v.zoom);
      }),
      RUNS,
    );
  });
});
