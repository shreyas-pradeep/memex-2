import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { distillSourceText } from "@/core/ingestion-engine";
import { ghostDiscoveryId } from "@/core/ghost-engine";
import { MAGNETIC_RANGE_PX } from "@/core/magnetic-engine";
import { BUNDLE_SCHEMA, validateAndImportBundle } from "@/core/vault-bundle";
import type { AssociativeEdge, GhostDiscovery, MemexNode } from "@/core/types";
import { saveUserGeminiKey, GEMINI_KEY_STORAGE } from "../ai-settings";
import {
  selectIsSpotlightActive,
  selectNodeSpotlightDim,
  selectSpotlightMatchCount,
} from "../spotlight-selectors";
import {
  GHOST_DISMISSED_KEY,
  SNAP_PULSE_MS,
  STORAGE_KEY,
  hasMagneticSession,
  loadDismissedGhostIds,
  loadPersistedGraph,
  useMemexStore,
} from "../useMemexStore";

const store = () => useMemexStore.getState();
const FIXED = "2026-01-02T03:04:05.000Z";

/** In-memory Storage that counts graph writes, so "persists once" can be asserted. */
function installLocalStorage(): { data: Map<string, string>; graphWrites: () => number } {
  const data = new Map<string, string>();
  let writes = 0;
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (k === STORAGE_KEY) writes++;
      data.set(k, v);
    },
    removeItem: (k: string) => void data.delete(k),
  };
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  return { data, graphWrites: () => writes };
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

function edge(id: string, source: string, target: string): AssociativeEdge {
  return { id, source, target, type: "associative", data: { origin: "human", rationale: "", strength: 0.5 } };
}

function loadScene(nodes: MemexNode[], edges: AssociativeEdge[] = [], discoveries: GhostDiscovery[] = []) {
  useMemexStore.setState({ nodes, edges, trails: [], ghostDiscoveries: discoveries });
}

/** Moves a card the way a drag frame does: a new nodes array, same `data`. */
function dragTo(id: string, x: number, y: number) {
  useMemexStore.setState({
    nodes: store().nodes.map((n) => (n.id === id ? { ...n, position: { x, y } } : n)),
  });
}

describe("Spec 09 store", () => {
  let env: ReturnType<typeof installLocalStorage>;

  beforeEach(() => {
    env = installLocalStorage();
    store().resetToSeed();
    useMemexStore.setState({
      isCuratorDrawerOpen: false,
      commandDock: { open: false, tab: "trails" },
      dockFocusRequest: 0,
      lastSnapEdgeId: null,
    });
    env.data.clear();
  });

  afterEach(() => {
    store().cancelMagneticDrag();
    vi.useRealTimers();
  });

  describe("magnetic snapping", () => {
    const farX = 340 + MAGNETIC_RANGE_PX + 500;

    it("offers a target only when a related unconnected card is in range, and only changes state when it changes", () => {
      loadScene([card("a", farX, 0), card("b", 0, 0), card("c", 0, 600, {}, false)]);
      store().beginMagneticDrag("a");
      expect(hasMagneticSession()).toBe(true);
      store().updateMagneticDrag("a");
      expect(store().magneticTarget).toBeNull();

      let changes = 0;
      const unsubscribe = useMemexStore.subscribe((s, prev) => {
        if (s.magneticTarget !== prev.magneticTarget) changes++;
      });
      dragTo("a", 340 + 100, 0);
      store().updateMagneticDrag("a");
      const first = store().magneticTarget;
      expect(first).toMatchObject({ sourceId: "a", targetId: "b" });
      expect(first?.affinity).toBeGreaterThanOrEqual(0.7);
      expect(first?.rationale.length).toBeGreaterThan(0);
      // Frames that do not change the offer do not touch the store value.
      for (let i = 0; i < 20; i++) {
        dragTo("a", 340 + 100 + (i % 3), 0);
        store().updateMagneticDrag("a");
      }
      expect(store().magneticTarget).toBe(first);
      expect(changes).toBe(1);
      dragTo("a", farX, 0);
      store().updateMagneticDrag("a");
      expect(store().magneticTarget).toBeNull();
      expect(changes).toBe(2);
      unsubscribe();
    });

    it("a drop on a target creates exactly one human edge, consumes the discovery and persists once", () => {
      vi.useFakeTimers();
      const discovery: GhostDiscovery = {
        id: ghostDiscoveryId("a", "b"),
        sourceId: "a",
        targetId: "b",
        rationale: "ghost says so",
        confidence: 0.9,
        discoveredAt: FIXED,
      };
      loadScene([card("a", 400, 0), card("b", 0, 0)], [], [discovery]);
      store().selectGhostDiscovery(discovery.id);
      store().beginMagneticDrag("a");
      store().updateMagneticDrag("a");
      const target = store().magneticTarget;
      expect(target).not.toBeNull();
      const before = env.graphWrites();
      const result = store().endMagneticDrag("a");
      expect(result).toEqual({ snapped: true, edgeId: "e-human-a-b" });
      expect(env.graphWrites() - before).toBe(1);
      const s = store();
      expect(s.edges).toHaveLength(1);
      expect(s.edges[0]).toMatchObject({
        id: "e-human-a-b",
        source: "a",
        target: "b",
        data: { origin: "human", rationale: target?.rationale, strength: target?.affinity },
      });
      expect(s.ghostDiscoveries).toEqual([]);
      expect(s.selectedGhostDiscoveryId).toBeNull();
      expect(s.magneticTarget).toBeNull();
      expect(hasMagneticSession()).toBe(false);
      expect(s.lastSnapEdgeId).toBe("e-human-a-b");
      expect(loadPersistedGraph()?.edges).toHaveLength(1);
      vi.advanceTimersByTime(SNAP_PULSE_MS + 10);
      expect(store().lastSnapEdgeId).toBeNull();
      // A second drop does nothing.
      expect(store().endMagneticDrag("a")).toEqual({ snapped: false });
    });

    it("does nothing on drop without a target", () => {
      loadScene([card("a", farX, 0), card("b", 0, 0)]);
      store().beginMagneticDrag("a");
      store().updateMagneticDrag("a");
      const before = env.graphWrites();
      expect(store().endMagneticDrag("a")).toEqual({ snapped: false });
      expect(env.graphWrites()).toBe(before);
      expect(store().edges).toEqual([]);
      expect(store().lastSnapEdgeId).toBeNull();
      expect(store().endMagneticDrag("never-started")).toEqual({ snapped: false });
    });

    it("never duplicates an edge when the pair was connected during the drag", () => {
      loadScene([card("a", 400, 0), card("b", 0, 0)]);
      store().beginMagneticDrag("a");
      store().updateMagneticDrag("a");
      expect(store().magneticTarget).not.toBeNull();
      store().connect("b", "a", "human");
      // The graph change reconciles the session: the stale offer is withdrawn.
      expect(store().magneticTarget).toBeNull();
      expect(store().endMagneticDrag("a")).toEqual({ snapped: false });
      expect(store().edges).toHaveLength(1);
    });

    it("cancels when the dragged card or the offered card is deleted", () => {
      loadScene([card("a", 400, 0), card("b", 0, 0), card("c", 0, 300)]);
      store().beginMagneticDrag("a");
      store().updateMagneticDrag("a");
      expect(store().magneticTarget?.targetId).toBeDefined();
      const offered = store().magneticTarget?.targetId as string;
      store().removeNodes([offered]);
      expect(store().magneticTarget?.targetId).not.toBe(offered);
      store().removeNodes(["a"]);
      expect(store().magneticTarget).toBeNull();
      expect(hasMagneticSession()).toBe(false);
    });

    it("gives no target for a multi-card drag, an unknown card, a cancel, a hydrate or a reset", () => {
      loadScene([
        { ...card("a", 400, 0), selected: true },
        { ...card("c", 0, 600), selected: true },
        card("b", 0, 0),
      ]);
      store().beginMagneticDrag("a");
      expect(hasMagneticSession()).toBe(false);
      store().updateMagneticDrag("a");
      expect(store().magneticTarget).toBeNull();

      loadScene([card("a", 400, 0), card("b", 0, 0)]);
      store().beginMagneticDrag("nope");
      expect(hasMagneticSession()).toBe(false);

      store().beginMagneticDrag("a");
      store().updateMagneticDrag("a");
      expect(store().magneticTarget).not.toBeNull();
      store().cancelMagneticDrag();
      expect(store().magneticTarget).toBeNull();
      expect(hasMagneticSession()).toBe(false);

      store().beginMagneticDrag("a");
      store().updateMagneticDrag("a");
      store().resetToSeed();
      expect(store().magneticTarget).toBeNull();
      expect(hasMagneticSession()).toBe(false);
    });

    it("keeps per-frame work proportional to the candidates, not to the canvas", () => {
      // 300 unrelated cards and 3 related ones: only the 3 are candidates.
      const filler = Array.from({ length: 300 }, (_, i) => card(`f${i}`, 5000 + (i % 20) * 400, Math.floor(i / 20) * 300, {}, false));
      const dragged = card("a", 0, 0);
      loadScene([dragged, ...filler, card("r1", 1000, 0), card("r2", 1000, 500), card("r3", -1000, 0)]);
      store().beginMagneticDrag("a");
      const started = performance.now();
      for (let i = 0; i < 2000; i++) {
        dragTo("a", (i % 50) * 10, 0);
        store().updateMagneticDrag("a");
      }
      // Generous bound: dragTo itself maps 300+ cards per frame; no text analysis runs per frame.
      expect(performance.now() - started).toBeLessThan(3000);
      expect(store().magneticTarget === null || store().magneticTarget?.sourceId === "a").toBe(true);
    });

    it("is session-only: never in the exports or in localStorage", () => {
      loadScene([card("a", 400, 0), card("b", 0, 0)]);
      store().beginMagneticDrag("a");
      store().updateMagneticDrag("a");
      store().endMagneticDrag("a");
      for (const text of [store().exportJson(), store().exportBundleJson(), env.data.get(STORAGE_KEY) as string]) {
        expect(text).not.toContain("magneticTarget");
        expect(text).not.toContain("lastSnapEdgeId");
      }
    });
  });

  describe("command dock", () => {
    it("starts collapsed on the Trails tab and the Spec 08 flag is an alias of (open and Trails)", () => {
      expect(store().commandDock).toEqual({ open: false, tab: "trails" });
      store().toggleCuratorDrawer();
      expect(store().commandDock).toEqual({ open: true, tab: "trails" });
      expect(store().isCuratorDrawerOpen).toBe(true);
      store().openDockTab("spotlight");
      expect(store().isCuratorDrawerOpen).toBe(false);
      expect(store().commandDock.open).toBe(true);
      // "Close the drawer" leaves a dock that shows another tab alone.
      store().setCuratorDrawerOpen(false);
      expect(store().commandDock).toEqual({ open: true, tab: "spotlight" });
      store().setCuratorDrawerOpen(true);
      expect(store().commandDock).toEqual({ open: true, tab: "trails" });
      store().setCuratorDrawerOpen(false);
      expect(store().commandDock).toEqual({ open: false, tab: "trails" });
      store().toggleDockTab("synapse");
      expect(store().commandDock).toEqual({ open: true, tab: "synapse" });
      store().toggleDockTab("synapse");
      expect(store().commandDock.open).toBe(false);
      store().openDockTab("synapse");
      store().collapseDock();
      expect(store().commandDock).toEqual({ open: false, tab: "synapse" });
      store().expandDock();
      expect(store().commandDock).toEqual({ open: true, tab: "synapse" });
    });

    it("turns key presses into dock changes and focus requests", () => {
      const key = (k: string, over: Record<string, boolean> = {}) =>
        store().dispatchDockKey({
          key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false,
          defaultPrevented: false, targetIsEditable: false, targetInsideDock: false, modalOpen: false, ...over,
        });
      expect(key("t").handled).toBe(true);
      expect(store().commandDock).toEqual({ open: true, tab: "trails" });
      expect(store().isCuratorDrawerOpen).toBe(true);
      expect(store().dockFocusRequest).toBe(0);
      const slash = key("/");
      expect(slash.preventDefault).toBe(true);
      expect(store().commandDock).toEqual({ open: true, tab: "spotlight" });
      expect(store().dockFocusRequest).toBe(1);
      key("/");
      expect(store().dockFocusRequest).toBe(2);
      expect(key("/", { targetIsEditable: true }).handled).toBe(false);
      expect(store().dockFocusRequest).toBe(2);
      expect(key("Escape", { modalOpen: true }).handled).toBe(false);
      expect(store().commandDock.open).toBe(true);
      expect(key("Escape").stopPropagation).toBe(true);
      expect(store().commandDock).toEqual({ open: false, tab: "spotlight" });
      expect(key("Escape").handled).toBe(false);
    });

    it("opens the Synapse tab for a selection; one selection kind clears the other; clearing never closes", () => {
      const a = card("a", 0, 0);
      const b = card("b", 400, 0);
      const d: GhostDiscovery = {
        id: ghostDiscoveryId("a", "b"), sourceId: "a", targetId: "b", rationale: "r", confidence: 0.9, discoveredAt: FIXED,
      };
      loadScene([a, b, card("c", 900, 0)], [edge("e-1", "b", "c")], [d]);
      store().selectGhostDiscovery(d.id);
      expect(store().commandDock).toEqual({ open: true, tab: "synapse" });
      expect(store().selectedGhostDiscoveryId).toBe(d.id);
      expect(store().inspectedEdgeId).toBeNull();
      store().inspectEdge("e-1");
      expect(store().inspectedEdgeId).toBe("e-1");
      expect(store().selectedGhostDiscoveryId).toBeNull();
      store().selectGhostDiscovery(d.id);
      expect(store().inspectedEdgeId).toBeNull();
      store().selectGhostDiscovery(null);
      expect(store().commandDock).toEqual({ open: true, tab: "synapse" });
      store().inspectEdge("nope");
      expect(store().inspectedEdgeId).toBeNull();
      store().selectGhostDiscovery("nope");
      expect(store().selectedGhostDiscoveryId).toBeNull();
      // Deleting the inspected edge clears the inspection.
      store().inspectEdge("e-1");
      store().removeNodes(["c"]);
      expect(store().inspectedEdgeId).toBeNull();
    });

    it("loading a trail collapses the Trails tab only", () => {
      const trailId = store().trails[0].id;
      store().openDockTab("trails");
      store().loadTrailIntoLever(trailId);
      expect(store().commandDock.open).toBe(false);
      expect(store().isCuratorDrawerOpen).toBe(false);
      store().openDockTab("spotlight");
      store().loadTrailIntoLever(trailId);
      expect(store().commandDock).toEqual({ open: true, tab: "spotlight" });
    });

    it("is session-only: not exported, not persisted, and left alone by reset, import and hydrate", () => {
      store().openDockTab("spotlight");
      store().dispatchDockKey({
        key: "/", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false,
        defaultPrevented: false, targetIsEditable: false, targetInsideDock: false, modalOpen: false,
      });
      store().createManualTrail("T", "", store().nodes.slice(0, 2).map((n) => n.id));
      const bundle = store().exportBundleJson();
      for (const text of [store().exportJson(), bundle, env.data.get(STORAGE_KEY) as string]) {
        for (const name of ["commandDock", "dockFocusRequest", "inspectedEdgeId", "isCuratorDrawerOpen", "spotlight"]) {
          expect(text).not.toContain(name);
        }
      }
      store().importJson(store().exportJson());
      store().resetToSeed();
      store().hydrate();
      expect(store().commandDock).toEqual({ open: true, tab: "spotlight" });
      expect(store().dockFocusRequest).toBe(1);
    });
  });

  describe("spotlight", () => {
    it("holds session-only filters and clears them", () => {
      store().setSpotlightQuery("attention");
      store().setSpotlightType("quote");
      store().toggleSpotlightTag(" Memory ");
      store().toggleSpotlightTag("graph");
      expect(store().spotlightTags).toEqual(["memory", "graph"]);
      store().toggleSpotlightTag("memory");
      expect(store().spotlightTags).toEqual(["graph"]);
      store().setSpotlightType("bogus" as never);
      expect(store().spotlightType).toBe("quote");
      store().setSpotlightQuery("x".repeat(500));
      expect(store().spotlightQuery).toHaveLength(200);
      expect(selectIsSpotlightActive(store())).toBe(true);
      for (const text of [store().exportJson(), store().exportBundleJson()]) {
        expect(text).not.toContain("spotlight");
      }
      store().clearSpotlight();
      expect(store()).toMatchObject({ spotlightQuery: "", spotlightType: "all", spotlightTags: [] });
      expect(selectIsSpotlightActive(store())).toBe(false);
    });

    it("the per-card selector returns off, match or dim, and stays cheap and correct across drag frames", () => {
      loadScene([
        card("m", 0, 0, { title: "Attention Is All You Need", tags: ["attention"] }),
        card("n", 400, 0, { title: "As We May Think", tags: ["memex"], cardType: "quote" }),
      ]);
      const dim = (id: string) => selectNodeSpotlightDim(id)(store());
      expect(dim("m")).toBe("off");
      expect(dim("missing")).toBe("off");
      store().setSpotlightQuery("attention");
      expect(dim("m")).toBe("match");
      expect(dim("n")).toBe("dim");
      expect(dim("missing")).toBe("off");
      expect(selectSpotlightMatchCount(store())).toBe(1);
      store().setSpotlightType("quote");
      expect(dim("m")).toBe("dim");
      store().clearSpotlight();
      store().toggleSpotlightTag("memex");
      expect(dim("n")).toBe("match");
      expect(dim("m")).toBe("dim");
      // A drag frame replaces the node objects but keeps `data`: the answer is unchanged.
      dragTo("m", 50, 50);
      expect(dim("n")).toBe("match");
      expect(dim("m")).toBe("dim");
      // The memo is keyed by `data` identity: editing the card through the store (a new data object) recomputes.
      store().updateCard("m", { tags: ["memex"] });
      expect(dim("m")).toBe("match");
    });

    it("a graph replace clears the filters", () => {
      store().setSpotlightQuery("x");
      store().importBundle(store().exportBundleJson());
      expect(store().spotlightQuery).toBe("");
    });
  });

  describe("cassettes", () => {
    const source =
      "Memex machines store records on microfilm. Bush described associative trails in 1945. They run 3.5x faster than a library on 8 desks.";

    function ingest(title: string, text: string) {
      const { nodes, edges } = store();
      const distilled = distillSourceText(title, text, { x: 4000, y: 0 }, {
        existingIds: nodes.map((n) => n.id),
        createdAt: FIXED,
      });
      void edges;
      return { distilled, added: store().ingestSource(distilled.nodes, distilled.edges) };
    }

    it("assigns every ingested card the same cassette id and title", () => {
      const { added } = ingest("Memex Notes", source);
      expect(added.length).toBeGreaterThanOrEqual(2);
      const cards = store().nodes.filter((n) => added.includes(n.id));
      expect(new Set(cards.map((n) => n.data.cassetteId)).size).toBe(1);
      expect(cards[0].data.cassetteId).toMatch(/^cassette-[0-9a-f]{8}$/);
      expect(cards.every((n) => n.data.cassetteTitle === "Memex Notes")).toBe(true);
      expect(store().nodes.filter((n) => n.data.cassetteId === undefined).length).toBe(store().nodes.length - added.length);
    });

    it("re-ingesting the same source joins its cassette; another source with the same id gets a suffix", () => {
      const first = ingest("Memex Notes", source);
      const id = store().nodes.find((n) => n.id === first.added[0])?.data.cassetteId as string;
      const again = ingest("Memex Notes", source);
      expect(store().nodes.find((n) => n.id === again.added[0])?.data.cassetteId).toBe(id);

      // A hand-built import that claims the same id for a different title is renamed at insertion.
      const clash = distillSourceText("Other Source", "Totally different text about geology and rocks.", { x: 9000, y: 0 }, {
        existingIds: store().nodes.map((n) => n.id),
        cassetteId: id,
      });
      const added = store().ingestSource(clash.nodes, clash.edges);
      expect(store().nodes.find((n) => n.id === added[0])?.data.cassetteId).toBe(`${id}-2`);
      const third = distillSourceText("Third Source", "More notes on glaciers and ice sheets of the north.", { x: 12000, y: 0 }, {
        existingIds: store().nodes.map((n) => n.id),
        cassetteId: id,
      });
      const added3 = store().ingestSource(third.nodes, third.edges);
      expect(store().nodes.find((n) => n.id === added3[0])?.data.cassetteId).toBe(`${id}-3`);
    });

    it("moveCassette updates members in one set per call and persists only on commit", () => {
      const { added } = ingest("Memex Notes", source);
      const cid = store().nodes.find((n) => n.id === added[0])?.data.cassetteId as string;
      const members = store().nodes.filter((n) => n.data.cassetteId === cid);
      const others = store().nodes.filter((n) => n.data.cassetteId !== cid);
      const before = new Map(members.map((n) => [n.id, n.position]));
      env.data.clear();
      const writesBefore = env.graphWrites();
      let sets = 0;
      const unsubscribe = useMemexStore.subscribe(() => sets++);
      store().moveCassette(cid, 10, -5);
      store().moveCassette(cid, 10, -5);
      expect(sets).toBe(2);
      expect(env.graphWrites()).toBe(writesBefore);
      for (const m of store().nodes.filter((n) => n.data.cassetteId === cid)) {
        const p = before.get(m.id) as { x: number; y: number };
        expect(m.position).toEqual({ x: p.x + 20, y: p.y - 10 });
      }
      store().nodes.filter((n) => n.data.cassetteId !== cid).forEach((n, i) => expect(n).toBe(others[i]));
      store().moveCassette(cid, 1, 1, { commit: true });
      expect(sets).toBe(3);
      expect(env.graphWrites()).toBe(writesBefore + 1);
      // The end of a drag persists even when the last frame moved nothing.
      store().moveCassette(cid, 0, 0, { commit: true });
      expect(env.graphWrites()).toBe(writesBefore + 2);
      // Unknown cassettes and bad deltas change nothing.
      const snapshot = store().nodes;
      store().moveCassette("nope", 5, 5, { commit: true });
      store().moveCassette(cid, NaN, 5);
      expect(store().nodes).toBe(snapshot);
      expect(env.graphWrites()).toBe(writesBefore + 2);
      unsubscribe();
    });
  });

  describe("bundles", () => {
    it("exports a bundle with the dismissed ids and never any API key", () => {
      saveUserGeminiKey("AIzaSyDUMMY-SECRET-1234567890");
      expect(env.data.get(GEMINI_KEY_STORAGE)).toBeDefined();
      const d = store().ghostDiscoveries[0] ?? null;
      void d;
      env.data.set(GHOST_DISMISSED_KEY, JSON.stringify(["gd-dismissed-1"]));
      const json = store().exportBundleJson();
      expect(json).not.toContain("AIzaSyDUMMY");
      expect(json).not.toMatch(/api.?key|gemini/i);
      const parsed = JSON.parse(json) as { schema: string; ghostSettings: { dismissedDiscoveryIds: string[]; engine: string } };
      expect(parsed.schema).toBe(BUNDLE_SCHEMA);
      expect(parsed.ghostSettings.dismissedDiscoveryIds).toEqual(["gd-dismissed-1"]);
      expect(parsed.ghostSettings.engine).toBe("neural");
    });

    it("importBundle replaces the graph, resets session state, persists once and restores dismissed ids", () => {
      vi.useFakeTimers();
      const trailId = store().trails[0].id;
      env.data.set(GHOST_DISMISSED_KEY, JSON.stringify(["gd-b", "gd-a"]));
      const json = store().exportBundleJson();
      const original = validateAndImportBundle(json);
      expect(original.ok).toBe(true);

      // Change everything the import must undo or reset.
      store().removeNodes([store().nodes[0].id]);
      store().setActiveTrail(trailId);
      store().openDockTab("synapse");
      store().setSpotlightQuery("zzz");
      env.data.set(GHOST_DISMISSED_KEY, JSON.stringify(["something-else"]));
      const scan = vi.fn(() => Promise.resolve());
      useMemexStore.setState({ triggerGhostScan: scan });
      store().addNode(card("late", 0, 0)); // starts the debounced scan
      const writesBefore = env.graphWrites();

      const result = store().importBundle(json);
      expect(result.ok).toBe(true);
      expect(env.graphWrites() - writesBefore).toBe(1);
      expect(store().nodes.map((n) => n.id).sort()).toEqual((original.ok ? original.state.nodes : []).map((n) => n.id).sort());
      expect(store().activeTrailId).toBeNull();
      expect(store().spotlightQuery).toBe("");
      expect(store().commandDock).toEqual({ open: true, tab: "synapse" }); // interface state stays
      expect(loadDismissedGhostIds()).toEqual(["gd-a", "gd-b"]);
      expect(loadPersistedGraph()?.nodes).toHaveLength(store().nodes.length);
      // The pending debounced scan was cancelled.
      vi.advanceTimersByTime(5000);
      expect(scan).not.toHaveBeenCalled();
    });

    it("leaves the state untouched when the bundle is invalid", () => {
      const before = store();
      env.data.clear();
      const writes = env.graphWrites();
      for (const bad of ["not json", JSON.stringify({ schema: "memex-bundle", version: "9" }), "{}"]) {
        const r = store().importBundle(bad);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.errors.length).toBeGreaterThan(0);
      }
      const dangling = JSON.parse(store().exportBundleJson()) as { edges: { target: string }[] };
      dangling.edges[0].target = "ghost";
      expect(store().importBundle(JSON.stringify(dangling)).ok).toBe(false);
      const after = store();
      expect(after.nodes).toBe(before.nodes);
      expect(after.edges).toBe(before.edges);
      expect(after.trails).toBe(before.trails);
      expect(env.graphWrites()).toBe(writes);
      expect(env.data.size).toBe(0);
    });

    it("a legacy graph file imports with a warning and keeps the existing dismissals", () => {
      env.data.set(GHOST_DISMISSED_KEY, JSON.stringify(["keep-me"]));
      const result = store().importBundle(store().exportJson());
      expect(result.ok && result.version).toBe("1.x");
      expect(result.ok && result.warnings.length).toBeGreaterThan(0);
      expect(loadDismissedGhostIds()).toEqual(["keep-me"]);
    });

    it("round-trips the whole store graph, cassette fields included", () => {
      const distilled = distillSourceText("Memex Notes", "Memex machines store records on microfilm. Associative trails link them.", { x: 4000, y: 0 }, {
        existingIds: store().nodes.map((n) => n.id),
        createdAt: FIXED,
      });
      store().ingestSource(distilled.nodes, distilled.edges);
      const exported = store().exportBundleJson();
      const snapshot = store().nodes.map((n) => n.data);
      store().resetToSeed();
      expect(store().importBundle(exported).ok).toBe(true);
      expect(store().nodes.map((n) => n.data)).toStrictEqual(snapshot);
      expect(store().nodes.some((n) => n.data.cassetteId !== undefined)).toBe(true);
    });

    it("exports an Obsidian ZIP with one file per card", async () => {
      const blob = await store().exportObsidianZip();
      expect(blob.type).toBe("application/zip");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const view = new DataView(bytes.buffer);
      expect(view.getUint32(0, true)).toBe(0x04034b50);
      let end = bytes.length - 22;
      while (view.getUint32(end, true) !== 0x06054b50) end--;
      expect(view.getUint16(end + 10, true)).toBe(store().nodes.length);
    });
  });
});
