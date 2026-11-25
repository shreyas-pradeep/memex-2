import { NodeChangeset } from "@xyflow/react";
import { beforeEach, describe, expect, it } from "vitest";
import { deserializeGraph } from "@/core/graph-engine";
import { demoSeed } from "@/data/demo-seed";
import { STORAGE_KEY, useMemexStore } from "../useMemexStore";

/** Minimal in-memory Storage so the store can persist under Node. */
function installLocalStorage(): Map<string, string> {
  const data = new Map<string, string>();
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
  });
  return data;
}

describe("useMemexStore", () => {
  let data: Map<string, string>;

  beforeEach(() => {
    data = installLocalStorage();
    useMemexStore.getState().resetToSeed();
    data.clear();
  });

  it("starts from the demo seed and resets to it", () => {
    const s = useMemexStore.getState();
    expect(s.nodes).toHaveLength(demoSeed.nodes.length);
    s.removeNodes([s.nodes[0].id]);
    expect(useMemexStore.getState().nodes).toHaveLength(demoSeed.nodes.length - 1);
    useMemexStore.getState().resetToSeed();
    expect(useMemexStore.getState().nodes).toEqual(demoSeed.nodes);
    expect(deserializeGraph(data.get(STORAGE_KEY)!).nodes).toEqual(demoSeed.nodes);
  });

  it("updates position on every drag frame but persists only when the drag ends", () => {
    const id = useMemexStore.getState().nodes[0].id;
    const { onNodesChange } = useMemexStore.getState();

    onNodesChange(
      new NodeChangeset([
        { type: "position", id, position: { x: 11, y: 22 }, dragging: true },
      ]),
    );
    expect(useMemexStore.getState().nodes[0].position).toEqual({ x: 11, y: 22 });
    expect(data.has(STORAGE_KEY)).toBe(false);

    onNodesChange(
      new NodeChangeset([
        { type: "position", id, position: { x: 33, y: 44 }, dragging: false },
      ]),
    );
    const saved = deserializeGraph(data.get(STORAGE_KEY)!);
    expect(saved.nodes.find((n) => n.id === id)!.position).toEqual({ x: 33, y: 44 });
    expect(saved.nodes[0]).not.toHaveProperty("dragging");
  });

  it("purges edges and trail references when React Flow removes a node", () => {
    const id = useMemexStore.getState().edges[0].source;
    useMemexStore.getState().onNodesChange(
      new NodeChangeset([{ type: "remove", id }]),
    );
    const s = useMemexStore.getState();
    expect(s.nodes.some((n) => n.id === id)).toBe(false);
    expect(s.edges.some((e) => e.source === id || e.target === id)).toBe(false);
    expect(s.trails.some((t) => t.nodeIds.includes(id))).toBe(false);
  });

  it("rejects self-loops and duplicate connections", () => {
    const [a, b] = useMemexStore.getState().nodes.map((n) => n.id);
    const { onConnect } = useMemexStore.getState();
    const before = useMemexStore.getState().edges.length;
    onConnect({ source: a, target: a, sourceHandle: null, targetHandle: null });
    expect(useMemexStore.getState().edges).toHaveLength(before);
    onConnect({ source: a, target: b, sourceHandle: null, targetHandle: null });
    onConnect({ source: a, target: b, sourceHandle: null, targetHandle: null });
    expect(useMemexStore.getState().edges.length).toBeLessThanOrEqual(before + 1);
  });

  it("hydrates from storage, and falls back to the seed on corrupt JSON", () => {
    useMemexStore.getState().removeNodes([useMemexStore.getState().nodes[0].id]);
    useMemexStore.getState().resetToSeed();
    useMemexStore.getState().removeNodes([useMemexStore.getState().nodes[0].id]);
    const expected = useMemexStore.getState().nodes.length;

    useMemexStore.setState({ nodes: [] });
    useMemexStore.getState().hydrate();
    expect(useMemexStore.getState().nodes).toHaveLength(expected);

    data.set(STORAGE_KEY, "{not json");
    useMemexStore.getState().hydrate();
    expect(useMemexStore.getState().nodes).toEqual(demoSeed.nodes);
    expect(useMemexStore.getState().hydrated).toBe(true);
  });
});
