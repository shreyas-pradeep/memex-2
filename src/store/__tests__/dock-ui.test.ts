import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cassetteFramesSignature, buildCassetteFrames } from "@/core/cassette-drag";
import { distillSourceText } from "@/core/ingestion-engine";
import { MAGNETIC_RANGE_PX } from "@/core/magnetic-engine";
import { parseArcSignature, arcGeometry } from "@/core/magnetic-arc";
import { nodeRect } from "@/core/card-geometry";
import type { AssociativeEdge, MemexNode } from "@/core/types";
import { validateAndImportBundle } from "@/core/vault-bundle";
import {
  selectCassetteFramesSignature,
  selectInspectedEdge,
  selectIsSnapEdge,
  selectMagneticArcSignature,
  selectMagneticTitles,
  selectUnreviewedDiscoveries,
} from "../dock-selectors";
import { magneticDragMove, magneticDragStart, magneticDragStop } from "../magnetic-drag";
import { selectEdgeSpotlightDim, selectNodeSpotlightDim } from "../spotlight-selectors";
import { STORAGE_KEY, useMemexStore } from "../useMemexStore";
import { useToastStore } from "../useToastStore";
import { incomingCounts, stageRestoreFile, useVaultSession } from "../useVaultSession";

const store = () => useMemexStore.getState();
const FIXED = "2026-01-02T03:04:05.000Z";

function installLocalStorage(): void {
  const data = new Map<string, string>();
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
}

const POOL = ["hypertext", "associative", "trail", "memex", "network", "links"];

function card(id: string, x: number, y: number, over: Partial<MemexNode["data"]> = {}, related = true): MemexNode {
  const words = related ? POOL : ["banana", "recipe", "flour", "oven", "sugar", "butter"];
  return {
    id,
    type: "memexCard",
    position: { x, y },
    style: { width: 340, height: 230 },
    data: {
      archivalId: `MEM-${id}`,
      title: `${words[0]} ${words[1]} study ${id}`,
      content: `${words.join(" ")} ${words[2]} ${words[3]}`,
      cardType: "note",
      tags: related ? ["hypertext", "memory"] : ["cooking"],
      createdAt: FIXED,
      ...over,
    },
  };
}

function edge(id: string, source: string, target: string, data: Partial<AssociativeEdge["data"]> = {}): AssociativeEdge {
  return { id, source, target, type: "associative", data: { origin: "human", rationale: "r", strength: 0.5, ...data } };
}

/** Moves a card the way a drag frame does: a new nodes array, the same `data`. */
function dragTo(id: string, x: number, y: number): void {
  useMemexStore.setState({ nodes: store().nodes.map((n) => (n.id === id ? { ...n, position: { x, y } } : n)) });
}

describe("dock UI store glue", () => {
  beforeEach(() => {
    installLocalStorage();
    store().resetToSeed();
    useMemexStore.setState({
      isCuratorDrawerOpen: false,
      commandDock: { open: false, tab: "trails" },
      lastSnapEdgeId: null,
      inspectedEdgeId: null,
      selectedGhostDiscoveryId: null,
    });
    useToastStore.getState().clear();
    useVaultSession.setState({ pending: null, busy: null });
  });

  afterEach(() => {
    store().cancelMagneticDrag();
    store().clearSpotlight();
  });

  describe("spotlight dimming", () => {
    it("a card drag frame does not change any card's dim value or any edge's flag (no per-frame re-render)", () => {
      useMemexStore.setState({
        nodes: [card("a", 0, 0), card("b", 500, 0), card("c", 0, 500, {}, false)],
        edges: [edge("e1", "a", "b"), edge("e2", "a", "c")],
        trails: [],
        ghostDiscoveries: [],
      });
      store().setSpotlightQuery("hypertext");
      const dims = () => ["a", "b", "c"].map((id) => selectNodeSpotlightDim(id)(store()));
      const flags = () => [selectEdgeSpotlightDim("a", "b")(store()), selectEdgeSpotlightDim("a", "c")(store())];
      const before = { dims: dims(), flags: flags() };
      expect(before.dims).toEqual(["match", "match", "dim"]);

      // Every zustand subscriber re-renders only when its selected primitive changes.
      let renders = 0;
      const unsubscribe = useMemexStore.subscribe((s, prev) => {
        for (const id of ["a", "b", "c"]) {
          if (selectNodeSpotlightDim(id)(s) !== selectNodeSpotlightDim(id)(prev)) renders++;
        }
        if (selectEdgeSpotlightDim("a", "c")(s) !== selectEdgeSpotlightDim("a", "c")(prev)) renders++;
      });
      for (let i = 0; i < 60; i++) dragTo("a", i * 3, i * 2);
      unsubscribe();
      expect(renders).toBe(0);
      expect({ dims: dims(), flags: flags() }).toEqual(before);
    });

    it("an edge fades only when BOTH of its cards are filtered out", () => {
      useMemexStore.setState({
        nodes: [card("a", 0, 0), card("b", 500, 0), card("c", 0, 500, {}, false), card("d", 500, 500, {}, false)],
        edges: [],
        trails: [],
        ghostDiscoveries: [],
      });
      // No filter: nothing fades.
      expect(selectEdgeSpotlightDim("c", "d")(store())).toBe(false);
      store().setSpotlightQuery("banana");
      // a and b do not match; c and d do.
      expect(selectEdgeSpotlightDim("a", "b")(store())).toBe(true);
      expect(selectEdgeSpotlightDim("a", "c")(store())).toBe(false);
      expect(selectEdgeSpotlightDim("c", "d")(store())).toBe(false);
      // Unknown endpoints never fade.
      expect(selectEdgeSpotlightDim("a", "nope")(store())).toBe(false);
      store().clearSpotlight();
      expect(selectEdgeSpotlightDim("a", "b")(store())).toBe(false);
    });
  });

  describe("magnetic arc selectors and drag glue", () => {
    const farX = 340 + MAGNETIC_RANGE_PX + 500;

    function scene() {
      useMemexStore.setState({
        nodes: [card("a", farX, 0), card("b", 0, 0)],
        edges: [],
        trails: [],
        ghostDiscoveries: [],
      });
    }

    it("the arc signature is empty without an offer and follows the dragged card while one exists", () => {
      scene();
      expect(selectMagneticArcSignature(store())).toBe("");
      expect(selectMagneticTitles(store())).toBe("");
      magneticDragStart("a", 1);
      magneticDragMove("a", 1);
      expect(selectMagneticArcSignature(store())).toBe("");

      dragTo("a", 340 + 100, 0);
      magneticDragMove("a", 1);
      const first = selectMagneticArcSignature(store());
      expect(store().magneticTarget?.targetId).toBe("b");
      expect(first).not.toBe("");
      const rects = parseArcSignature(first);
      expect(rects).not.toBeNull();
      expect(rects?.[0]).toEqual(nodeRect(store().nodes.find((n) => n.id === "a") as MemexNode));
      expect(rects?.[1]).toEqual(nodeRect(store().nodes.find((n) => n.id === "b") as MemexNode));
      expect(arcGeometry(...(rects as [never, never])).length).toBe(100);

      dragTo("a", 340 + 120, 0);
      magneticDragMove("a", 1);
      expect(selectMagneticArcSignature(store())).not.toBe(first);
      expect(JSON.parse(selectMagneticTitles(store())) as string[]).toEqual([
        "hypertext associative study a",
        "hypertext associative study b",
      ]);

      // Leaving the range clears the offer and the signature.
      dragTo("a", farX, 0);
      magneticDragMove("a", 1);
      expect(selectMagneticArcSignature(store())).toBe("");
    });

    it("the signature does not change when an unrelated card moves", () => {
      useMemexStore.setState({
        nodes: [card("a", 440, 0), card("b", 0, 0), card("z", 3000, 3000, {}, false)],
        edges: [],
        trails: [],
        ghostDiscoveries: [],
      });
      magneticDragStart("a", 1);
      magneticDragMove("a", 1);
      const sig = selectMagneticArcSignature(store());
      expect(sig).not.toBe("");
      dragTo("z", 3100, 3100);
      expect(selectMagneticArcSignature(store())).toBe(sig);
    });

    it("dropping on a target snaps, toasts with both titles and sets the pulse id; the pulse selector follows", () => {
      scene();
      magneticDragStart("a", 1);
      dragTo("a", 340 + 100, 0);
      magneticDragMove("a", 1);
      expect(magneticDragStop("a", 1)).toBe(true);
      expect(store().edges).toHaveLength(1);
      const id = store().edges[0].id;
      expect(store().lastSnapEdgeId).toBe(id);
      expect(selectIsSnapEdge(id)(store())).toBe(true);
      expect(selectIsSnapEdge("other")(store())).toBe(false);
      const [toast] = useToastStore.getState().toasts;
      expect(toast.kind).toBe("SNAP");
      expect(toast.message).toBe("Synapse snapped: hypertext associative study a ↔ hypertext associative study b");
      // Everything is cleared after the drop.
      expect(store().magneticTarget).toBeNull();
      expect(selectMagneticArcSignature(store())).toBe("");
    });

    it("dropping with no offer snaps nothing and shows no toast", () => {
      scene();
      magneticDragStart("a", 1);
      magneticDragMove("a", 1);
      expect(magneticDragStop("a", 1)).toBe(false);
      expect(store().edges).toHaveLength(0);
      expect(useToastStore.getState().toasts).toHaveLength(0);
    });

    it("a multi-card drag takes no part: nothing is offered, nothing snaps", () => {
      scene();
      magneticDragStart("a", 2);
      dragTo("a", 340 + 100, 0);
      magneticDragMove("a", 2);
      expect(store().magneticTarget).toBeNull();
      expect(magneticDragStop("a", 2)).toBe(false);
      expect(store().edges).toHaveLength(0);
      expect(useToastStore.getState().toasts).toHaveLength(0);
    });

    it("a drag that went multi after it began is cancelled, not snapped", () => {
      scene();
      magneticDragStart("a", 1);
      dragTo("a", 340 + 100, 0);
      magneticDragMove("a", 1);
      expect(store().magneticTarget).not.toBeNull();
      magneticDragMove("a", 2);
      expect(store().magneticTarget).toBeNull();
      expect(magneticDragStop("a", 1)).toBe(false);
      expect(store().edges).toHaveLength(0);
    });
  });

  describe("cassette frames", () => {
    const source =
      "Memex machines store records on microfilm. Bush described associative trails in 1945. They run 3.5x faster than a library on 8 desks.";

    function ingest(title: string, text: string, at: { x: number; y: number }): string[] {
      const { nodes } = store();
      const distilled = distillSourceText(title, text, at, { existingIds: nodes.map((n) => n.id), createdAt: FIXED });
      return store().ingestSource(distilled.nodes, distilled.edges);
    }

    it("an ingested source shows as a visible frame that encloses its 2 to 4 cards with 24 px to spare", () => {
      useMemexStore.setState({ nodes: [], edges: [], trails: [], ghostDiscoveries: [] });
      const added = ingest("Memex Notes", source, { x: 400, y: 200 });
      expect(added.length).toBeGreaterThanOrEqual(2);
      expect(added.length).toBeLessThanOrEqual(4);
      const frames = buildCassetteFrames(store().nodes);
      expect(frames).toHaveLength(1);
      const [f] = frames;
      expect(f.title).toBe("Memex Notes");
      expect(f.count).toBe(added.length);
      expect(f.width).toBeGreaterThan(0);
      expect(f.height).toBeGreaterThan(0);
      for (const n of store().nodes.filter((m) => added.includes(m.id))) {
        const r = nodeRect(n) as { x: number; y: number; width: number; height: number };
        expect(f.x).toBeLessThanOrEqual(r.x - 24);
        expect(f.y).toBeLessThanOrEqual(r.y - 24);
        expect(f.x + f.width).toBeGreaterThanOrEqual(r.x + r.width + 24);
        expect(f.y + f.height).toBeGreaterThanOrEqual(r.y + r.height + 24);
      }
    });

    it("dragging a card outside the cassette leaves the frames string alone; moving a member or the whole cassette changes it", () => {
      useMemexStore.setState({ nodes: [card("loose", 5000, 5000)], edges: [], trails: [], ghostDiscoveries: [] });
      const added = ingest("Memex Notes", source, { x: 0, y: 0 });
      const sig = selectCassetteFramesSignature(store());
      expect(sig).toBe(cassetteFramesSignature(buildCassetteFrames(store().nodes)));
      dragTo("loose", 5200, 5100);
      expect(selectCassetteFramesSignature(store())).toBe(sig);

      const cid = store().nodes.find((n) => n.id === added[0])?.data.cassetteId as string;
      store().moveCassette(cid, 40, 10);
      const moved = selectCassetteFramesSignature(store());
      expect(moved).not.toBe(sig);
      // The frame moved by exactly the delta (it follows its members live).
      const [before] = JSON.parse(sig) as [string, string, number, number, number, number, number][];
      const [after] = JSON.parse(moved) as [string, string, number, number, number, number, number][];
      expect(after[3] - before[3]).toBe(40);
      expect(after[4] - before[4]).toBe(10);
      expect(after[5]).toBe(before[5]);
      expect(after[6]).toBe(before[6]);

      dragTo(added[0], (store().nodes.find((n) => n.id === added[0]) as MemexNode).position.x + 900, 0);
      expect(selectCassetteFramesSignature(store())).not.toBe(moved);
    });
  });

  describe("dock selectors", () => {
    it("counts pending discoveries and resolves the inspected edge", () => {
      useMemexStore.setState({
        nodes: [card("a", 0, 0), card("b", 500, 0)],
        edges: [edge("e1", "a", "b", { trailId: "t1" })],
        trails: [],
        ghostDiscoveries: [],
      });
      expect(selectUnreviewedDiscoveries(store())).toBe(0);
      expect(selectInspectedEdge(store())).toBeNull();
      store().inspectEdge("e1");
      expect(selectInspectedEdge(store())?.id).toBe("e1");
      expect(store().commandDock).toEqual({ open: true, tab: "synapse" });
      // The same object identity while the edge list is unchanged (no re-render on a drag frame).
      const first = selectInspectedEdge(store());
      dragTo("a", 10, 10);
      expect(selectInspectedEdge(store())).toBe(first);
      store().inspectEdge(null);
      expect(selectInspectedEdge(store())).toBeNull();
    });
  });

  describe("vault restore staging", () => {
    function bundleOf(): string {
      useMemexStore.setState({ nodes: [card("a", 0, 0), card("b", 500, 0)], edges: [edge("e1", "a", "b")], trails: [], ghostDiscoveries: [] });
      return store().exportBundleJson();
    }

    it("stages a valid file with counts on both sides and changes nothing until confirmed", () => {
      const json = bundleOf();
      useMemexStore.setState({ nodes: [card("x", 0, 0)], edges: [], trails: [], ghostDiscoveries: [] });
      useVaultSession.getState().stageText("vault.memex", json);
      const pending = useVaultSession.getState().pending;
      expect(pending?.fileName).toBe("vault.memex");
      expect(pending?.current).toEqual({ cards: 1, edges: 0, trails: 0 });
      expect(pending?.result.ok).toBe(true);
      expect(pending && incomingCounts(pending.result)).toEqual({ cards: 2, edges: 1, trails: 0 });
      // Staging never touches the canvas.
      expect(store().nodes.map((n) => n.id)).toEqual(["x"]);
      // Confirming applies it through importBundle.
      const outcome = store().importBundle(pending?.text ?? "");
      expect(outcome.ok).toBe(true);
      expect(store().nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
      useVaultSession.getState().cancel();
      expect(useVaultSession.getState().pending).toBeNull();
    });

    it("stages an invalid file as errors with no counts, and leaves the canvas alone", () => {
      const before = store().nodes;
      useVaultSession.getState().stageText("bad.memex", '{"schema":"memex-bundle","version":"9.9"}');
      const pending = useVaultSession.getState().pending;
      expect(pending?.result.ok).toBe(false);
      expect(pending && incomingCounts(pending.result)).toBeNull();
      expect(store().nodes).toBe(before);
      useVaultSession.getState().stageText("junk.memex", "not json at all");
      expect(useVaultSession.getState().pending?.result.ok).toBe(false);
      expect(validateAndImportBundle("not json at all").ok).toBe(false);
    });

    it("refuses an oversized file BEFORE reading it", async () => {
      let read = false;
      await stageRestoreFile({
        name: "huge.memex",
        size: 5_000_001,
        text: () => {
          read = true;
          return Promise.resolve("{}");
        },
      });
      expect(read).toBe(false);
      const pending = useVaultSession.getState().pending;
      expect(pending?.result.ok).toBe(false);
      expect(pending?.result.ok === false && pending.result.errors[0]).toContain("5 MB");
    });

    it("reports an unreadable file and reads a good one", async () => {
      await stageRestoreFile({ name: "x.memex", size: 10, text: () => Promise.reject(new Error("denied")) });
      expect(useVaultSession.getState().pending?.result.ok).toBe(false);
      useVaultSession.getState().cancel();
      const json = bundleOf();
      await stageRestoreFile({ name: "ok.memex", size: json.length, text: () => Promise.resolve(json) });
      expect(useVaultSession.getState().pending?.result.ok).toBe(true);
    });

    it("never reaches the persisted graph or the export", () => {
      useVaultSession.getState().stageText("vault.memex", bundleOf());
      expect(store().exportJson()).not.toContain("pending");
      expect(store().exportBundleJson()).not.toContain("vault.memex");
      void STORAGE_KEY;
    });
  });
});
