import { NodeChangeset } from "@xyflow/react";
import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";
import { deserializeGraph } from "@/core/graph-engine";
import { generateAutoTrails, isAutoTrailId } from "@/core/trail-genesis";
import { demoSeed } from "@/data/demo-seed";
import {
  NO_SIGNATURE,
  parseSelectionSignature,
  selectCuratorTrailCount,
  selectSelectionSignature,
  selectTrailListSignature,
} from "../curator-selectors";
import { useBriefingSession } from "../useBriefingSession";
import { STORAGE_KEY, useMemexStore } from "../useMemexStore";
import { useSprocketSession } from "../useSprocketSession";

const RUNS = { numRuns: 200 } as const;

/** In-memory Storage that counts writes, so "persists once" can be asserted. */
function installLocalStorage(): { data: Map<string, string>; writes: () => number } {
  const data = new Map<string, string>();
  let writes = 0;
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      writes++;
      data.set(k, v);
    },
    removeItem: (k: string) => void data.delete(k),
  };
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  return { data, writes: () => writes };
}

const store = () => useMemexStore.getState();
const cardIds = () => store().nodes.map((n) => n.id);

describe("Curator's Index store", () => {
  let env: ReturnType<typeof installLocalStorage>;
  beforeEach(() => {
    env = installLocalStorage();
    store().resetToSeed();
    useMemexStore.setState({ isCuratorDrawerOpen: false, trailCameraNonce: 0 });
    useSprocketSession.getState().reset();
    useBriefingSession.setState({ briefing: null });
    env.data.clear();
  });

  describe("drawer state (session-only)", () => {
    it("starts closed and toggles", () => {
      expect(store().isCuratorDrawerOpen).toBe(false);
      store().toggleCuratorDrawer();
      expect(store().isCuratorDrawerOpen).toBe(true);
      store().toggleCuratorDrawer();
      expect(store().isCuratorDrawerOpen).toBe(false);
      store().setCuratorDrawerOpen(true);
      store().setCuratorDrawerOpen(true);
      expect(store().isCuratorDrawerOpen).toBe(true);
      store().setCuratorDrawerOpen(false);
      expect(store().isCuratorDrawerOpen).toBe(false);
    });

    it("is never in the export JSON or in localStorage, and does not change the export", () => {
      const closed = store().exportJson();
      store().setCuratorDrawerOpen(true);
      expect(store().exportJson()).toBe(closed);
      expect(closed).not.toContain("isCuratorDrawerOpen");
      expect(closed).not.toContain("trailCameraNonce");
      store().createManualTrail("T", "", cardIds().slice(0, 2));
      const saved = env.data.get(STORAGE_KEY) as string;
      expect(saved).not.toContain("isCuratorDrawerOpen");
      expect(Object.keys(JSON.parse(saved) as object).sort()).toEqual(["edges", "ghostDiscoveries", "nodes", "trails"]);
    });

    it("is left alone by reset, import and hydrate", () => {
      store().setCuratorDrawerOpen(true);
      store().importJson(store().exportJson());
      expect(store().isCuratorDrawerOpen).toBe(true);
      store().resetToSeed();
      expect(store().isCuratorDrawerOpen).toBe(true);
      store().hydrate();
      expect(store().isCuratorDrawerOpen).toBe(true);
      store().setCuratorDrawerOpen(false);
      store().hydrate();
      expect(store().isCuratorDrawerOpen).toBe(false);
    });
  });

  describe("createManualTrail", () => {
    it("keeps the passed order, drops repeats and unknown ids, persists once and returns the id", () => {
      const [a, b, c, d] = cardIds();
      const before = store().trails.length;
      const writes = env.writes();
      const id = store().createManualTrail("  My Reel  ", "  why  ", [c, a, "nope", c, d, b, a]);
      expect(id).not.toBeNull();
      const t = store().trails.find((x) => x.id === id);
      expect(t).toMatchObject({ title: "My Reel", description: "why", origin: "human", nodeIds: [c, a, d, b] });
      expect(t).not.toHaveProperty("color");
      expect(store().trails).toHaveLength(before + 1);
      expect(env.writes() - writes).toBe(1);
      expect(deserializeGraph(env.data.get(STORAGE_KEY) as string).trails.some((x) => x.id === id)).toBe(true);
      expect(new Date(t?.createdAt ?? "").toISOString()).toBe(t?.createdAt);
    });

    it("needs 2 valid cards: otherwise null, no state change and no write", () => {
      const [a] = cardIds();
      const trails = store().trails;
      const writes = env.writes();
      expect(store().createManualTrail("x", "", [])).toBeNull();
      expect(store().createManualTrail("x", "", [a])).toBeNull();
      expect(store().createManualTrail("x", "", [a, a, a])).toBeNull();
      expect(store().createManualTrail("x", "", [a, "nope"])).toBeNull();
      expect(store().trails).toBe(trails);
      expect(env.writes()).toBe(writes);
    });

    it("falls back to Untitled Trail and stores only a valid color", () => {
      const [a, b] = cardIds();
      const plain = store().createManualTrail("   ", "", [a, b]) as string;
      expect(store().trails.find((t) => t.id === plain)?.title).toBe("Untitled Trail");
      const colored = store().createManualTrail("c", "", [a, b], "#b388ff") as string;
      expect(store().trails.find((t) => t.id === colored)?.color).toBe("#B388FF");
      const bad = store().createManualTrail("c", "", [a, b], "violet") as string;
      expect(store().trails.find((t) => t.id === bad)).not.toHaveProperty("color");
      // Old saves, export and import keep working with a colored trail in the graph.
      const json = store().exportJson();
      store().importJson(json);
      expect(store().exportJson()).toBe(json);
      expect(store().trails.find((t) => t.id === colored)?.color).toBe("#B388FF");
    });

    it("gives unique ids (including after deletes) for arbitrary names, with order preserved", () => {
      fc.assert(
        fc.property(
          fc.array(fc.tuple(fc.string(), fc.shuffledSubarray(cardIds(), { minLength: 2 })), { minLength: 1, maxLength: 12 }),
          (calls) => {
            store().resetToSeed();
            const seen = new Set(store().trails.map((t) => t.id));
            for (const [name, ids] of calls) {
              const id = store().createManualTrail(name, "", ids);
              expect(id).not.toBeNull();
              expect(seen.has(id as string)).toBe(false);
              seen.add(id as string);
              expect(store().trails.find((t) => t.id === id)?.nodeIds).toEqual(ids);
              if (seen.size % 3 === 0) store().deleteTrail(id as string);
            }
            const all = store().trails.map((t) => t.id);
            expect(new Set(all).size).toBe(all.length);
          },
        ),
        RUNS,
      );
    });

    it("forgeTrail still works and builds on the same path", () => {
      const [a, b] = cardIds();
      const id = store().forgeTrail("Forged", "", [b, a]);
      expect(store().trails.find((t) => t.id === id)).toMatchObject({ title: "Forged", nodeIds: [b, a], origin: "human" });
      expect(store().forgeTrail("x", "", [a])).toBeNull();
    });
  });

  describe("deleteTrail", () => {
    it("removes the trail and persists once", () => {
      const victim = store().trails[0].id;
      const others = store().trails.slice(1).map((t) => t.id);
      const writes = env.writes();
      store().deleteTrail(victim);
      expect(store().trails.map((t) => t.id)).toEqual(others);
      expect(env.writes() - writes).toBe(1);
      expect(deserializeGraph(env.data.get(STORAGE_KEY) as string).trails.some((t) => t.id === victim)).toBe(false);
    });

    it("is a no-op for unknown ids", () => {
      const trails = store().trails;
      const writes = env.writes();
      store().deleteTrail("does-not-exist");
      expect(store().trails).toBe(trails);
      expect(env.writes()).toBe(writes);
    });

    it("exits playback when the active trail is deleted, and leaves playback alone otherwise", () => {
      const [first, second] = store().trails;
      store().setActiveTrail(first.id);
      store().nextTrailStep();
      store().toggleAutoPlay();
      expect(store().activeTrailId).toBe(first.id);
      store().deleteTrail(second.id);
      expect(store().activeTrailId).toBe(first.id);
      expect(store().activeTrailIndex).toBe(1);
      store().deleteTrail(first.id);
      expect(store().activeTrailId).toBeNull();
      expect(store().activeTrailIndex).toBe(0);
      expect(store().isPlayingAuto).toBe(false);
    });

    it("allows an auto trail to be generated again afterwards", () => {
      const added = store().generateAndAddAutoTrails();
      expect(added.length).toBeGreaterThan(0);
      expect(store().generateAndAddAutoTrails()).toEqual([]);
      const gone = added[0];
      store().deleteTrail(gone.id);
      const again = store().generateAndAddAutoTrails();
      expect(again.map((t) => t.id)).toEqual([gone.id]);
      expect(again[0].nodeIds).toEqual(gone.nodeIds);
      expect(isAutoTrailId(again[0].id)).toBe(true);
    });

    it("clears a discovery's link to the deleted trail", () => {
      const [discovery] = store().ghostDiscoveries.length > 0 ? store().ghostDiscoveries : [];
      if (discovery === undefined) {
        // The demo seed ships no discoveries; convert one by hand through the store.
        const [a, b] = cardIds();
        store().setGhostDiscoveries([
          { id: "d-x", sourceId: a, targetId: b, rationale: "r", confidence: 0.6, discoveredAt: "2026-01-01T00:00:00.000Z" },
        ]);
      }
      const id = store().ghostDiscoveries[0].id;
      const trailId = store().convertDiscoveryToTrail(id) as string;
      expect(store().ghostDiscoveries[0].trailId).toBe(trailId);
      store().deleteTrail(trailId);
      expect(store().ghostDiscoveries[0]).not.toHaveProperty("trailId");
      expect(store().activeTrailId).toBeNull();
    });
  });

  describe("loadTrailIntoLever", () => {
    it("activates the trail at stop 0 with auto-play off, closes the drawer and bumps the camera nonce", () => {
      const [first, second] = store().trails;
      store().setActiveTrail(first.id);
      store().nextTrailStep();
      store().setCuratorDrawerOpen(true);
      const nonce = store().trailCameraNonce;
      store().loadTrailIntoLever(second.id);
      expect(store().activeTrailId).toBe(second.id);
      expect(store().activeTrailIndex).toBe(0);
      expect(store().isPlayingAuto).toBe(false);
      expect(store().isCuratorDrawerOpen).toBe(false);
      expect(store().trailCameraNonce).toBe(nonce + 1);
    });

    it("restarts the active trail at stop 0 and still bumps the nonce (so the camera glides back)", () => {
      const [first] = store().trails;
      store().setActiveTrail(first.id);
      const nonce = store().trailCameraNonce;
      store().loadTrailIntoLever(first.id);
      expect(store().activeTrailIndex).toBe(0);
      expect(store().trailCameraNonce).toBe(nonce + 1);
    });

    it("never activates an unknown id or an empty trail, and leaves everything else alone", () => {
      store().setCuratorDrawerOpen(true);
      fc.assert(
        fc.property(fc.string(), (id) => {
          fc.pre(!store().trails.some((t) => t.id === id));
          store().loadTrailIntoLever(id);
          expect(store().activeTrailId).toBeNull();
          expect(store().isCuratorDrawerOpen).toBe(true);
        }),
        RUNS,
      );
      useMemexStore.setState({ trails: [...store().trails, { ...store().trails[0], id: "t-empty", nodeIds: [] }] });
      store().loadTrailIntoLever("t-empty");
      expect(store().activeTrailId).toBeNull();
    });

    it("loads any known trail at stop 0 (property)", () => {
      store().createManualTrail("m", "", cardIds().slice(0, 3));
      store().generateAndAddAutoTrails();
      const ids = store().trails.map((t) => t.id);
      fc.assert(
        fc.property(fc.constantFrom(...ids), fc.integer({ min: 0, max: 5 }), (id, steps) => {
          store().setActiveTrail(ids[0]);
          for (let i = 0; i < steps; i++) store().nextTrailStep();
          store().loadTrailIntoLever(id);
          expect(store().activeTrailId).toBe(id);
          expect(store().trails.some((t) => t.id === store().activeTrailId)).toBe(true);
          expect(store().activeTrailIndex).toBe(0);
        }),
        RUNS,
      );
    });
  });

  describe("briefing session (shared by the dock and the index)", () => {
    it("opens a briefing for a trail that is not active, and for the active one", () => {
      const [first, second] = store().trails;
      store().setActiveTrail(first.id);
      expect(useBriefingSession.getState().openBriefing(second.id)).toBe(true);
      const b = useBriefingSession.getState().briefing;
      expect(b?.trailId).toBe(second.id);
      expect(b?.markdown).toContain(second.title);
      useBriefingSession.getState().closeBriefing();
      expect(useBriefingSession.getState().briefing).toBeNull();
      expect(useBriefingSession.getState().openBriefing(first.id)).toBe(true);
    });

    it("refuses unknown and empty trails and is not part of the export", () => {
      expect(useBriefingSession.getState().openBriefing("nope")).toBe(false);
      expect(useBriefingSession.getState().briefing).toBeNull();
      useBriefingSession.getState().openBriefing(store().trails[0].id);
      expect(store().exportJson()).not.toContain("briefing");
    });
  });

  describe("selectors", () => {
    it("the trail list signature is empty while closed and stable during card drags while open", () => {
      expect(selectTrailListSignature(store())).toBe(NO_SIGNATURE);
      expect(selectSelectionSignature(store())).toBe(NO_SIGNATURE);
      store().setCuratorDrawerOpen(true);
      const before = selectTrailListSignature(store());
      expect(before).not.toBe("");
      const id = cardIds()[0];
      const node = store().nodes[0];
      store().onNodesChange(
        new NodeChangeset([
          { type: "position", id, position: { x: node.position.x + 40, y: node.position.y + 7 }, dragging: true },
        ]),
      );
      expect(store().nodes[0].position.x).toBe(node.position.x + 40);
      expect(selectTrailListSignature(store())).toBe(before); // same string: no re-render
      store().updateCard(id, { title: "Renamed card" });
      const inTrail = store().trails.some((t) => t.nodeIds.includes(id));
      expect(selectTrailListSignature(store()) === before).toBe(!inTrail);
    });

    it("the count tracks creates and deletes; the selection signature follows canvas selection in reading order", () => {
      const n = selectCuratorTrailCount(store());
      const id = store().createManualTrail("x", "", cardIds().slice(0, 2)) as string;
      expect(selectCuratorTrailCount(store())).toBe(n + 1);
      store().deleteTrail(id);
      expect(selectCuratorTrailCount(store())).toBe(n);

      store().setCuratorDrawerOpen(true);
      const [a, b, c] = store().nodes;
      useMemexStore.setState({
        nodes: store().nodes.map((node) =>
          node.id === a.id
            ? { ...node, position: { x: 500, y: 0 }, selected: true }
            : node.id === b.id
              ? { ...node, position: { x: 100, y: 0 }, selected: true }
              : node.id === c.id
                ? { ...node, position: { x: 300, y: 0 }, selected: false }
                : node,
        ),
      });
      expect(parseSelectionSignature(selectSelectionSignature(store())).map((s) => s.id)).toEqual([b.id, a.id]);
    });
  });

  it("generated trails keep exactly six keys and no color through the store", () => {
    const added = store().generateAndAddAutoTrails();
    for (const t of added) {
      expect(Object.keys(t).sort()).toEqual(["createdAt", "description", "id", "nodeIds", "origin", "title"]);
    }
    expect(generateAutoTrails(store().nodes, store().edges, store().ghostDiscoveries).length).toBeGreaterThan(0);
    expect(demoSeed.trails.length).toBeGreaterThan(0);
  });
});
