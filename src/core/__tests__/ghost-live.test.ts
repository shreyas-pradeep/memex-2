import { describe, expect, it } from "vitest";
import {
  GHOST_LIMITS,
  extractGeminiText,
  parseGhostModelText,
  validateGhostRequest,
} from "../ghost-live";

const node = (id: string) => ({ id, data: { title: "T", content: "C", tags: ["x"], cardType: "note" } });

describe("validateGhostRequest", () => {
  it("accepts a minimal valid body and normalizes it", () => {
    const r = validateGhostRequest({ nodes: [node("a"), node("b")], existingEdges: [{ source: "a", target: "b" }] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.nodes).toHaveLength(2);
      expect(r.edges[0]).toMatchObject({ source: "a", target: "b" });
    }
  });

  it("rejects bad shapes, duplicates and oversized input", () => {
    const bad: unknown[] = [
      null,
      [],
      { nodes: "x" },
      { nodes: [node("a")] },
      { nodes: [node("a"), node("a")] },
      { nodes: [node("a"), { id: "b" }] },
      { nodes: [node("a"), node("b")], existingEdges: "x" },
      { nodes: [node("a"), node("b")], existingEdges: [{ source: 1, target: "a" }] },
      { nodes: [node("a"), { id: "b", data: { title: "x".repeat(GHOST_LIMITS.maxTitleChars + 1), content: "" } }] },
      { nodes: Array.from({ length: GHOST_LIMITS.maxNodes + 1 }, (_, i) => node(`n${i}`)) },
    ];
    for (const body of bad) expect(validateGhostRequest(body).ok).toBe(false);
  });
});

describe("model output parsing", () => {
  it("parses arrays, wrapped objects and fenced JSON; rejects junk", () => {
    expect(parseGhostModelText('[{"a":1}]')).toEqual([{ a: 1 }]);
    expect(parseGhostModelText('{"bridges":[1]}')).toEqual([1]);
    expect(parseGhostModelText('```json\n[2]\n```')).toEqual([2]);
    expect(parseGhostModelText("not json")).toBeNull();
    expect(parseGhostModelText('{"x":1}')).toBeNull();
  });

  it("extracts text from a Gemini response", () => {
    expect(extractGeminiText({ candidates: [{ content: { parts: [{ text: "[]" }] } }] })).toBe("[]");
    expect(extractGeminiText({})).toBeNull();
  });
});
