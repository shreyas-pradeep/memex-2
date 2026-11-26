import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  createTrail,
  forgeCustomTrail,
  getNextTrailIndex,
  getPrevTrailIndex,
  getTrailEdges,
  removeNodeFromTrail,
} from "../trail-engine";
import type { AssociativeEdge, LinkOrigin } from "../types";

const RUNS = { numRuns: 200 } as const;

const idArb = fc.stringMatching(/^n-[a-z0-9]{1,4}$/);
const uniqueIds = fc.uniqueArray(idArb, { minLength: 0, maxLength: 20 });
const originArb = fc.constantFrom<LinkOrigin[]>("human", "ghost");

/** True when `sub` is a (not necessarily contiguous) subsequence of `full`. */
function isSubsequence(sub: readonly string[], full: readonly string[]): boolean {
  let i = 0;
  for (const x of full) if (i < sub.length && sub[i] === x) i++;
  return i === sub.length;
}

describe("Property 1: Traversal bound invariants", () => {
  it("next/prev always stay within 0 <= i < N for any non-empty trail", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }),
        fc.array(fc.constantFrom("next", "prev"), { maxLength: 120 }),
        fc.integer({ min: -100, max: 100 }),
        (n, moves, start) => {
          let i = getNextTrailIndex(start, n);
          i = getPrevTrailIndex(i, n);
          expect(i).toBeGreaterThanOrEqual(0);
          expect(i).toBeLessThan(n);
          for (const m of moves) {
            i = m === "next" ? getNextTrailIndex(i, n) : getPrevTrailIndex(i, n);
            expect(i).toBeGreaterThanOrEqual(0);
            expect(i).toBeLessThan(n);
          }
        },
      ),
      RUNS,
    );
  });

  it("next moves exactly +1 and prev exactly -1 away from the ends", () => {
    fc.assert(
      fc.property(fc.integer({ min: 3, max: 50 }), (n) => {
        const mid = Math.floor(n / 2);
        expect(getNextTrailIndex(mid, n)).toBe(mid + 1);
        expect(getPrevTrailIndex(mid, n)).toBe(mid - 1);
        expect(getNextTrailIndex(n - 1, n)).toBe(n - 1);
        expect(getPrevTrailIndex(0, n)).toBe(0);
      }),
      RUNS,
    );
  });
});

describe("Property 2: Subsequence preservation on node deletion", () => {
  it("removing nodes leaves an ordered subsequence with no removed IDs", () => {
    fc.assert(
      fc.property(
        uniqueIds,
        fc.array(idArb, { maxLength: 10 }),
        originArb,
        (ids, doomed, origin) => {
          const trail = createTrail("t", "T", "d", ids, origin);
          const after = doomed.reduce(removeNodeFromTrail, trail);
          expect(isSubsequence(after.nodeIds, trail.nodeIds)).toBe(true);
          for (const d of doomed) expect(after.nodeIds).not.toContain(d);
          // Everything not removed survives.
          const expected = trail.nodeIds.filter((id) => !doomed.includes(id));
          expect(after.nodeIds).toEqual(expected);
          // Input is never mutated.
          expect(trail.nodeIds).toEqual([...new Set(ids)]);
        },
      ),
      RUNS,
    );
  });

  it("returns the same reference when the node is absent", () => {
    fc.assert(
      fc.property(uniqueIds, (ids) => {
        const trail = createTrail("t", "T", "d", ids, "human");
        expect(removeNodeFromTrail(trail, "missing-id")).toBe(trail);
      }),
      RUNS,
    );
  });
});

describe("Property 3: Empty trail graceful exit", () => {
  it("traversal on an empty trail never throws and yields -1", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1000, max: 1000 }), (i) => {
        expect(getNextTrailIndex(i, 0)).toBe(-1);
        expect(getPrevTrailIndex(i, 0)).toBe(-1);
      }),
      RUNS,
    );
  });

  it("deleting every node empties the trail and edges/forge handle it", () => {
    fc.assert(
      fc.property(uniqueIds, originArb, (ids, origin) => {
        const trail = createTrail("t", "T", "d", ids, origin);
        const emptied = ids.reduce(removeNodeFromTrail, trail);
        expect(emptied.nodeIds).toHaveLength(0);
        expect(getTrailEdges(emptied, [])).toEqual([]);
        expect(getNextTrailIndex(0, emptied.nodeIds.length)).toBe(-1);
        expect(forgeCustomTrail("x", "", [], origin).nodeIds).toEqual([]);
      }),
      RUNS,
    );
  });
});

describe("trail helpers", () => {
  it("getTrailEdges returns only edges between consecutive stops", () => {
    fc.assert(
      fc.property(uniqueIds, fc.boolean(), (ids, flip) => {
        const trail = createTrail("t", "T", "d", ids, "human");
        const mk = (s: string, t: string): AssociativeEdge => ({
          id: `${s}>${t}`,
          source: s,
          target: t,
          type: "associative",
          data: { origin: "human", rationale: "", strength: 0.5 },
        });
        const consecutive = ids.slice(1).map((id, k) => (flip ? mk(id, ids[k]) : mk(ids[k], id)));
        const skip = ids.length >= 3 ? [mk(ids[0], ids[2])] : [];
        const result = getTrailEdges(trail, [...consecutive, ...skip]);
        expect(result.map((e) => e.id)).toEqual(consecutive.map((e) => e.id));
      }),
      RUNS,
    );
  });

  it("forgeCustomTrail is deterministic and dedupes IDs", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.array(idArb, { maxLength: 15 }), originArb, (t, d, ids, o) => {
        const a = forgeCustomTrail(t, d, ids, o);
        const b = forgeCustomTrail(t, d, ids, o);
        expect(a).toEqual(b);
        expect(a.nodeIds).toEqual([...new Set(ids)]);
        expect(a.origin).toBe(o);
        expect(a.title.length).toBeGreaterThan(0);
      }),
      RUNS,
    );
  });
});
