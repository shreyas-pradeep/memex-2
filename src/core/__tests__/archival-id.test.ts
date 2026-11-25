import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { nextArchivalId } from "../graph-engine";
import type { MemexNode } from "../types";

const nodeWithId = (archivalId: string, i: number): MemexNode => ({
  id: `n${i}`,
  type: "memexCard",
  position: { x: 0, y: 0 },
  data: {
    archivalId,
    title: "t",
    content: "",
    cardType: "note",
    tags: [],
    createdAt: "1945-07-01T00:00:00.000Z",
  },
});

describe("nextArchivalId", () => {
  it("starts at MEM-1945-0001 for an empty graph", () => {
    expect(nextArchivalId([])).toBe("MEM-1945-0001");
  });

  it("goes one above the highest number, ignoring gaps and foreign IDs", () => {
    const nodes = ["MEM-1945-0002", "MEM-1945-0009", "custom"].map(nodeWithId);
    expect(nextArchivalId(nodes)).toBe("MEM-1945-0010");
  });

  it("never collides with an existing ID", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 9999 }), { maxLength: 20 }), (nums) => {
        const nodes = nums.map((n, i) =>
          nodeWithId(`MEM-1945-${String(n).padStart(4, "0")}`, i),
        );
        const next = nextArchivalId(nodes);
        expect(nodes.some((n) => n.data.archivalId === next)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});
