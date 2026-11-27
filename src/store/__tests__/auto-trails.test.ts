import { beforeEach, describe, expect, it } from "vitest";
import { deserializeGraph } from "@/core/graph-engine";
import { autoTrailKind, isAutoTrailId } from "@/core/trail-genesis";
import { demoSeed } from "@/data/demo-seed";
import { STORAGE_KEY, useMemexStore } from "../useMemexStore";
import { useSprocketSession } from "../useSprocketSession";
import { useToastStore, showToast } from "../useToastStore";

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

describe("generateAndAddAutoTrails", () => {
  let env: ReturnType<typeof installLocalStorage>;

  beforeEach(() => {
    env = installLocalStorage();
    useMemexStore.getState().resetToSeed();
    useSprocketSession.getState().reset();
    useToastStore.getState().clear();
    env.data.clear();
  });

  it("adds the Lineage Arc and the Dense Conceptual Nexus for the demo seed, and no debate", () => {
    const before = useMemexStore.getState().trails.length;
    const added = useMemexStore.getState().generateAndAddAutoTrails();
    expect(added.map((t) => t.title)).toEqual(["Lineage Arc", "Dense Conceptual Nexus"]);
    expect(added.map((t) => autoTrailKind(t.id))).toEqual(["lineage", "nexus"]);
    expect(added.every((t) => t.origin === "ghost" && isAutoTrailId(t.id))).toBe(true);
    const { trails } = useMemexStore.getState();
    expect(trails).toHaveLength(before + 2);
    expect(trails.slice(before)).toEqual(added);
    // createdAt is the moment of generation (a real ISO timestamp).
    for (const t of added) expect(new Date(t.createdAt).toISOString()).toBe(t.createdAt);
  });

  it("persists once for the whole batch", () => {
    const start = env.writes();
    useMemexStore.getState().generateAndAddAutoTrails();
    expect(env.writes() - start).toBe(1);
    const saved = deserializeGraph(env.data.get(STORAGE_KEY) as string);
    expect(saved.trails.filter((t) => isAutoTrailId(t.id))).toHaveLength(2);
  });

  it("is idempotent: a second call returns [], adds nothing and does not write", () => {
    useMemexStore.getState().generateAndAddAutoTrails();
    const trailsAfterFirst = useMemexStore.getState().trails;
    const writes = env.writes();
    expect(useMemexStore.getState().generateAndAddAutoTrails()).toEqual([]);
    expect(useMemexStore.getState().trails).toBe(trailsAfterFirst);
    expect(env.writes()).toBe(writes);
  });

  it("skips a trail whose ordered cards already exist under another id", () => {
    const first = useMemexStore.getState().generateAndAddAutoTrails();
    const lineage = first[0];
    useMemexStore.getState().importJson(
      JSON.stringify({
        ...demoSeed,
        trails: [
          ...demoSeed.trails,
          { ...lineage, id: "t-human-copy", title: "My own arc", origin: "human" },
        ],
      }),
    );
    const again = useMemexStore.getState().generateAndAddAutoTrails();
    expect(again.map((t) => t.title)).toEqual(["Dense Conceptual Nexus"]);
  });

  it("survives export and import", () => {
    const added = useMemexStore.getState().generateAndAddAutoTrails();
    const json = useMemexStore.getState().exportJson();
    useMemexStore.getState().resetToSeed();
    expect(useMemexStore.getState().trails).toHaveLength(demoSeed.trails.length);
    useMemexStore.getState().importJson(json);
    expect(useMemexStore.getState().trails.slice(-2)).toEqual(added);
    expect(useMemexStore.getState().exportJson()).toBe(json);
    expect(useMemexStore.getState().generateAndAddAutoTrails()).toEqual([]);
  });

  it("never touches playback state", () => {
    const { setActiveTrail, setTrailStep, toggleAutoPlay } = useMemexStore.getState();
    setActiveTrail(demoSeed.trails[0].id);
    setTrailStep(2);
    toggleAutoPlay();
    const playback = () => {
      const s = useMemexStore.getState();
      return { id: s.activeTrailId, index: s.activeTrailIndex, auto: s.isPlayingAuto };
    };
    const before = playback();
    expect(before).toEqual({ id: demoSeed.trails[0].id, index: 2, auto: true });
    useMemexStore.getState().generateAndAddAutoTrails();
    expect(playback()).toEqual(before);
    useMemexStore.getState().generateAndAddAutoTrails();
    expect(playback()).toEqual(before);
  });

  it("returns [] and writes nothing when the data cannot support a trail", () => {
    const ids = useMemexStore.getState().nodes.map((n) => n.id);
    useMemexStore.getState().removeNodes(ids.slice(0, ids.length - 2));
    const writes = env.writes();
    expect(useMemexStore.getState().nodes).toHaveLength(2);
    expect(useMemexStore.getState().generateAndAddAutoTrails()).toEqual([]);
    expect(env.writes()).toBe(writes);
  });

  it("deleting a card still trims it from auto trails (existing cleanup)", () => {
    const [lineage] = useMemexStore.getState().generateAndAddAutoTrails();
    const victim = lineage.nodeIds[2];
    useMemexStore.getState().removeNodes([victim]);
    const stored = useMemexStore.getState().trails.find((t) => t.id === lineage.id);
    expect(stored?.nodeIds).toEqual(lineage.nodeIds.filter((id) => id !== victim));
    // The shortened trail is no longer identical to a fresh generation: a new one is added.
    const regenerated = useMemexStore.getState().generateAndAddAutoTrails();
    expect(regenerated.every((t) => !t.nodeIds.includes(victim))).toBe(true);
  });

  it("does not add fields to the Trail schema", () => {
    const [lineage] = useMemexStore.getState().generateAndAddAutoTrails();
    expect(Object.keys(lineage).sort()).toEqual(["createdAt", "description", "id", "nodeIds", "origin", "title"]);
  });
});

describe("weaving session state is session-only", () => {
  beforeEach(() => {
    installLocalStorage();
    useMemexStore.getState().resetToSeed();
    useSprocketSession.getState().reset();
  });

  it("never appears in the export, the persisted graph or the Memex store", () => {
    const session = useSprocketSession.getState();
    session.beginWeave("t-auto-lineage-deadbeef");
    session.setWeaveCursor(4);
    expect(useSprocketSession.getState().isWeaving).toBe(true);
    const json = useMemexStore.getState().exportJson();
    for (const key of ["isWeaving", "weavingTrailId", "weaveRequestId", "weaveCursor", "deadbeef"]) {
      expect(json).not.toContain(key);
    }
    expect(Object.keys(JSON.parse(json)).sort()).toEqual(["edges", "ghostDiscoveries", "nodes", "trails"]);
    const memexKeys = Object.keys(useMemexStore.getState());
    for (const key of ["isWeaving", "weavingTrailId", "weaveRequestId", "weaveCursor"]) {
      expect(memexKeys).not.toContain(key);
    }
    // Generating trails while weaving does not leak it either.
    useMemexStore.getState().generateAndAddAutoTrails();
    expect(useMemexStore.getState().exportJson()).not.toContain("isWeaving");
  });

  it("requestWeave is gated: three cards, no playing trail, no weave running", () => {
    const requests = () => useSprocketSession.getState().weaveRequestId;
    expect(useSprocketSession.getState().requestWeave()).toBe(true);
    expect(requests()).toBe(1);

    // Double trigger while weaving.
    useSprocketSession.getState().beginWeave("t");
    expect(useSprocketSession.getState().requestWeave()).toBe(false);
    expect(requests()).toBe(1);
    useSprocketSession.getState().endWeave();
    expect(useSprocketSession.getState().isWeaving).toBe(false);

    // A playing trail blocks it.
    useMemexStore.getState().setActiveTrail(demoSeed.trails[0].id);
    expect(useSprocketSession.getState().requestWeave()).toBe(false);
    useMemexStore.getState().exitTrailPlayback();
    expect(useSprocketSession.getState().requestWeave()).toBe(true);
    expect(requests()).toBe(2);

    // Fewer than three cards.
    const ids = useMemexStore.getState().nodes.map((n) => n.id);
    useMemexStore.getState().removeNodes(ids.slice(0, ids.length - 2));
    expect(useSprocketSession.getState().requestWeave()).toBe(false);
    expect(requests()).toBe(2);
  });

  it("subscribers see exactly one change per accepted request", () => {
    const seen: number[] = [];
    const off = useSprocketSession.subscribe((s, prev) => {
      if (s.weaveRequestId !== prev.weaveRequestId) seen.push(s.weaveRequestId);
    });
    useSprocketSession.getState().requestWeave();
    // A handler like the crawler's marks the weave as begun synchronously.
    useSprocketSession.getState().beginWeave("t");
    useSprocketSession.getState().requestWeave();
    useSprocketSession.getState().requestWeave();
    off();
    expect(seen).toEqual([1]);
  });
});

describe("NO_AUTO_TRAIL toast", () => {
  it("shows the truthful message and stays out of the graph store", () => {
    installLocalStorage();
    useToastStore.getState().clear();
    showToast("NO_AUTO_TRAIL");
    const [toast] = useToastStore.getState().toasts;
    expect(toast.message).toBe(
      "The reels hold no clear trail yet, Professor. Add a few dated or related cards and try again.",
    );
    expect(toast.label).toMatch(/^\[ SIGNAL \/\/ [A-Z]+ \]$/);
    expect(useMemexStore.getState().exportJson()).not.toContain("reels");
    useToastStore.getState().clear();
  });
});
