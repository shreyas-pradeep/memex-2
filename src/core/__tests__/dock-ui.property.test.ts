import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { rectGap, type Rect } from "../card-geometry";
import { buildCassetteFrames, cassetteAriaLabel, cassetteDragDelta, cassetteFramesSignature, cassetteLabelText, cassetteNudge, accumulateDelta, parseCassetteFramesSignature, CASSETTE_LABEL_MAX, CASSETTE_NUDGE_PX, CASSETTE_NUDGE_SHIFT_PX } from "../cassette-drag";
import { cassetteFrame } from "../cassette-engine";
import { DOCK_TABS, INITIAL_DOCK, dockReducer, resolveDockKey, shouldPlaybackHandleKeys } from "../command-dock";
import {
  DOCK_OVERLAY_BREAKPOINT,
  DOCK_PANEL_WIDTH,
  DOCK_RAIL_WIDTH,
  dockInsets,
  dockPanelWidth,
  nextDockTab,
  spotlightRailCopy,
  synapseRailCopy,
  toDockKeyEvent,
  trailsRailCopy,
  type KeyEventLike,
} from "../dock-layout";
import {
  ARC_CONCEPT_MAX,
  arcGeometry,
  arcSignature,
  facingPoints,
  humanizeConcept,
  magneticAnnouncement,
  magneticPillText,
  parseArcSignature,
  snapToastMessage,
} from "../magnetic-arc";
import { EMPTY_TOAST_STATE, TOAST_MESSAGE_MAX, pushToast } from "../sprocket-engine";
import type { MemexNode } from "../types";
import { MAX_BUNDLE_BYTES } from "../vault-bundle";
import {
  bundleFilename,
  checkBundleFileSize,
  dateStamp,
  isMemexFileName,
  isRestorableFileName,
  obsidianZipFilename,
  pickDroppedBundle,
  restoreSummary,
  shouldClaimFileDrag,
} from "../vault-ui";

const RUNS = { numRuns: 200 } as const;

const rectArb: fc.Arbitrary<Rect> = fc.record({
  x: fc.integer({ min: -3000, max: 3000 }),
  y: fc.integer({ min: -3000, max: 3000 }),
  width: fc.integer({ min: 1, max: 600 }),
  height: fc.integer({ min: 1, max: 600 }),
});

function onBorder(r: Rect, p: { x: number; y: number }): boolean {
  const insideX = p.x >= r.x && p.x <= r.x + r.width;
  const insideY = p.y >= r.y && p.y <= r.y + r.height;
  const onX = p.x === r.x || p.x === r.x + r.width;
  const onY = p.y === r.y || p.y === r.y + r.height;
  return insideX && insideY && (onX || onY);
}

function key(over: Partial<KeyEventLike> & { key: string }): KeyEventLike {
  return { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, defaultPrevented: false, ...over };
}

describe("dock layout", () => {
  it("collapsed: the rail only; open on a wide viewport: rail plus panel; open on a narrow one: overlay", () => {
    expect(dockInsets({ open: false, viewportWidth: 1440 })).toEqual({ inset: DOCK_RAIL_WIDTH, overlay: false, panelWidth: DOCK_PANEL_WIDTH });
    expect(dockInsets({ open: true, viewportWidth: 1440 })).toEqual({
      inset: DOCK_RAIL_WIDTH + DOCK_PANEL_WIDTH,
      overlay: false,
      panelWidth: DOCK_PANEL_WIDTH,
    });
    // The boundary: 900 makes room, 899 overlays.
    expect(dockInsets({ open: true, viewportWidth: DOCK_OVERLAY_BREAKPOINT }).overlay).toBe(false);
    const narrow = dockInsets({ open: true, viewportWidth: DOCK_OVERLAY_BREAKPOINT - 1 });
    expect(narrow.overlay).toBe(true);
    expect(narrow.inset).toBe(DOCK_RAIL_WIDTH);
  });

  it("the panel is 400 px but never wider than 90% of the viewport", () => {
    expect(dockPanelWidth(1920)).toBe(400);
    expect(dockPanelWidth(300)).toBe(270);
    fc.assert(
      fc.property(fc.integer({ min: 200, max: 4000 }), (w) => {
        const panel = dockPanelWidth(w);
        expect(panel).toBeLessThanOrEqual(DOCK_PANEL_WIDTH);
        expect(panel).toBeLessThanOrEqual(w * 0.9);
        expect(panel).toBeGreaterThan(0);
      }),
      RUNS,
    );
  });

  it("garbage widths fall back to a usable layout", () => {
    for (const w of [NaN, -5, 0, Infinity]) {
      const r = dockInsets({ open: true, viewportWidth: w });
      expect(Number.isFinite(r.inset)).toBe(true);
      expect(r.inset).toBeGreaterThanOrEqual(DOCK_RAIL_WIDTH);
    }
  });

  it("arrow keys move between tabs with wrap, Home and End jump, other keys are left alone", () => {
    expect(nextDockTab("trails", "ArrowRight")).toBe("synapse");
    expect(nextDockTab("spotlight", "ArrowRight")).toBe("trails");
    expect(nextDockTab("trails", "ArrowLeft")).toBe("spotlight");
    expect(nextDockTab("synapse", "ArrowUp")).toBe("trails");
    expect(nextDockTab("synapse", "Home")).toBe("trails");
    expect(nextDockTab("synapse", "End")).toBe("spotlight");
    expect(nextDockTab("synapse", "a")).toBeNull();
    expect(nextDockTab("synapse", "Enter")).toBeNull();
    fc.assert(
      fc.property(fc.constantFrom(...DOCK_TABS), (tab) => {
        // Going right three times returns to the start.
        let t = tab;
        for (let i = 0; i < DOCK_TABS.length; i++) t = nextDockTab(t, "ArrowRight") ?? t;
        expect(t).toBe(tab);
      }),
      RUNS,
    );
  });

  it("rail copy names the counts and the action", () => {
    expect(trailsRailCopy(3, false).label).toBe("Open reels and trails: 3 trails (T)");
    expect(trailsRailCopy(1, true).label).toBe("Close reels and trails: 1 trail (T)");
    expect(synapseRailCopy(0, false).label).toBe("Open synapse inspector: 0 discoveries");
    expect(synapseRailCopy(2, false).label).toBe("Open synapse inspector: 2 discoveries to review");
    expect(synapseRailCopy(1, false).label).toContain("1 discovery to review");
    expect(spotlightRailCopy(false).label).toBe("Open spotlight and filter (/)");
    expect(trailsRailCopy(NaN, false).badge).toBe("0");
    expect(trailsRailCopy(-4, false).badge).toBe("0");
  });
});

describe("keyboard to dock event", () => {
  const typing = { targetIsEditable: true, targetInsideDock: false, modalOpen: false };
  const canvas = { targetIsEditable: false, targetInsideDock: false, modalOpen: false };

  it("copies the key facts and the three DOM readings from a plain-object event", () => {
    const e = key({ key: "t", shiftKey: true, repeat: true });
    expect(toDockKeyEvent(e, { targetIsEditable: true, targetInsideDock: true, modalOpen: true })).toEqual({
      ...e,
      targetIsEditable: true,
      targetInsideDock: true,
      modalOpen: true,
    });
  });

  it("T toggles Trails, / opens Spotlight and focuses it, Escape collapses, through the pure rules", () => {
    const t = resolveDockKey(INITIAL_DOCK, toDockKeyEvent(key({ key: "t" }), canvas));
    expect(t.state).toEqual({ open: true, tab: "trails" });
    expect(t.preventDefault).toBe(true);
    const slash = resolveDockKey(t.state, toDockKeyEvent(key({ key: "/" }), canvas));
    expect(slash.state).toEqual({ open: true, tab: "spotlight" });
    expect(slash.focusSpotlightInput).toBe(true);
    expect(slash.preventDefault).toBe(true);
    const esc = resolveDockKey(slash.state, toDockKeyEvent(key({ key: "Escape" }), canvas));
    expect(esc.state).toEqual({ open: false, tab: "spotlight" });
    expect(esc.stopPropagation).toBe(true);
  });

  it("ignores typing targets, modifiers, repeats, handled events and open modals; prevents nothing then", () => {
    const blocked: [KeyEventLike, Parameters<typeof toDockKeyEvent>[1]][] = [
      [key({ key: "t" }), typing],
      [key({ key: "/" }), typing],
      [key({ key: "t", ctrlKey: true }), canvas],
      [key({ key: "t", metaKey: true }), canvas],
      [key({ key: "/", altKey: true }), canvas],
      [key({ key: "t", repeat: true }), canvas],
      [key({ key: "t", defaultPrevented: true }), canvas],
      [key({ key: "t" }), { ...canvas, modalOpen: true }],
      [key({ key: "/" }), { ...canvas, modalOpen: true }],
    ];
    for (const [e, ctx] of blocked) {
      const r = resolveDockKey(INITIAL_DOCK, toDockKeyEvent(e, ctx));
      expect(r.handled).toBe(false);
      expect(r.preventDefault).toBe(false);
      expect(r.state).toBe(INITIAL_DOCK);
    }
    // Escape: a modal keeps its own; a field outside the dock keeps its own; a field inside does not.
    const open = { open: true, tab: "trails" } as const;
    expect(resolveDockKey(open, toDockKeyEvent(key({ key: "Escape" }), { ...canvas, modalOpen: true })).handled).toBe(false);
    expect(resolveDockKey(open, toDockKeyEvent(key({ key: "Escape" }), typing)).handled).toBe(false);
    expect(
      resolveDockKey(open, toDockKeyEvent(key({ key: "Escape" }), { ...typing, targetInsideDock: true })).handled,
    ).toBe(true);
    // Escape on a collapsed dock is not ours: playback may use it.
    expect(resolveDockKey(INITIAL_DOCK, toDockKeyEvent(key({ key: "Escape" }), canvas)).handled).toBe(false);
  });

  it("Escape with the dock open never reaches playback; with it closed playback keeps it", () => {
    const playbackKeys = (dockOpen: boolean) => shouldPlaybackHandleKeys({ dockOpen, modalOpen: false, targetIsEditable: false });
    expect(playbackKeys(true)).toBe(false);
    expect(playbackKeys(false)).toBe(true);
    expect(shouldPlaybackHandleKeys({ dockOpen: false, modalOpen: true, targetIsEditable: false })).toBe(false);
    expect(shouldPlaybackHandleKeys({ dockOpen: false, modalOpen: false, targetIsEditable: true })).toBe(false);
    // The reducer agrees with the listener: one Escape collapses, the second finds a closed dock.
    const once = dockReducer({ open: true, tab: "synapse" }, { type: "key", event: toDockKeyEvent(key({ key: "Escape" }), canvas) });
    expect(once).toEqual({ open: false, tab: "synapse" });
  });
});

describe("magnetic arc geometry", () => {
  it("for disjoint rectangles both endpoints lie on the rectangle borders and their distance is the gap", () => {
    fc.assert(
      fc.property(rectArb, rectArb, (a, b) => {
        fc.pre(rectGap(a, b) > 0);
        const { from, to } = facingPoints(a, b);
        expect(onBorder(a, from)).toBe(true);
        expect(onBorder(b, to)).toBe(true);
        expect(Math.hypot(to.x - from.x, to.y - from.y)).toBeCloseTo(rectGap(a, b), 9);
      }),
      RUNS,
    );
  });

  it("the midpoint of the arc lies between the endpoints' bounding box padded by the bow", () => {
    fc.assert(
      fc.property(rectArb, rectArb, (a, b) => {
        fc.pre(rectGap(a, b) > 0);
        const g = arcGeometry(a, b);
        const pad = 0.1 * g.length + 1e-6;
        expect(g.mid.x).toBeGreaterThanOrEqual(Math.min(g.from.x, g.to.x) - pad);
        expect(g.mid.x).toBeLessThanOrEqual(Math.max(g.from.x, g.to.x) + pad);
        expect(g.mid.y).toBeGreaterThanOrEqual(Math.min(g.from.y, g.to.y) - pad);
        expect(g.mid.y).toBeLessThanOrEqual(Math.max(g.from.y, g.to.y) + pad);
        expect(g.path.startsWith("M ")).toBe(true);
        expect(g.touching).toBe(false);
        // The curve midpoint is exactly 10% of the chord off the chord's midpoint.
        const chordMid = { x: (g.from.x + g.to.x) / 2, y: (g.from.y + g.to.y) / 2 };
        expect(Math.hypot(g.mid.x - chordMid.x, g.mid.y - chordMid.y)).toBeCloseTo(0.1 * g.length, 6);
      }),
      RUNS,
    );
  });

  it("is symmetric in length, and touching or overlapping rectangles draw nothing", () => {
    fc.assert(
      fc.property(rectArb, rectArb, (a, b) => {
        expect(arcGeometry(a, b).length).toBeCloseTo(arcGeometry(b, a).length, 9);
      }),
      RUNS,
    );
    const a = { x: 0, y: 0, width: 100, height: 100 };
    const overlap = arcGeometry(a, { x: 50, y: 50, width: 100, height: 100 });
    expect(overlap.touching).toBe(true);
    expect(overlap.path).toBe("");
    expect(Number.isFinite(overlap.mid.x) && Number.isFinite(overlap.mid.y)).toBe(true);
    expect(arcGeometry(a, { x: 100, y: 0, width: 50, height: 50 }).touching).toBe(true);
  });

  it("a side-by-side pair is bridged on the facing sides at the middle of the overlap", () => {
    const g = arcGeometry({ x: 0, y: 0, width: 100, height: 100 }, { x: 300, y: 50, width: 100, height: 100 });
    expect(g.from).toEqual({ x: 100, y: 75 });
    expect(g.to).toEqual({ x: 300, y: 75 });
    expect(g.length).toBe(200);
  });

  it("the signature round-trips and rejects garbage", () => {
    fc.assert(
      fc.property(rectArb, rectArb, (a, b) => {
        expect(parseArcSignature(arcSignature(a, b))).toEqual([a, b]);
      }),
      RUNS,
    );
    expect(parseArcSignature("")).toBeNull();
    expect(parseArcSignature("1,2,3|4,5,6,7")).toBeNull();
    expect(parseArcSignature("a,b,c,d|1,2,3,4")).toBeNull();
  });

  it("formats the whisper pill and the announcements", () => {
    expect(magneticPillText({ affinity: 0.874, concept: "associative linking" })).toBe(
      "⚡ 87% Nexus: associative linking — Drop to Snap Synapse",
    );
    expect(magneticPillText({ affinity: 2, concept: "x" })).toContain("100%");
    expect(magneticPillText({ affinity: NaN, concept: "x" })).toContain("0%");
    expect(humanizeConcept("memex_machine-trail")).toBe("memex machine trail");
    expect(humanizeConcept("   ")).toBe("related ideas");
    expect(humanizeConcept("x".repeat(100))).toHaveLength(ARC_CONCEPT_MAX);
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (concept) => {
        const text = humanizeConcept(concept);
        expect(text.length).toBeGreaterThan(0);
        expect([...text].length).toBeLessThanOrEqual(ARC_CONCEPT_MAX);
      }),
      RUNS,
    );
    expect(magneticAnnouncement("Alpha", "Beta")).toBe("Magnetic link available between Alpha and Beta. Release to connect.");
    expect(magneticAnnouncement("", "Beta")).toContain("Untitled card");
    expect(magneticAnnouncement("a".repeat(500), "b")).toContain("…");
    expect(snapToastMessage("Alpha", "Beta")).toBe("Synapse snapped: Alpha ↔ Beta");
  });
});

describe("cassette drag helpers", () => {
  it("divides the pointer delta by the zoom and refuses a bad zoom or delta", () => {
    expect(cassetteDragDelta(100, -50, 2)).toEqual({ dx: 50, dy: -25 });
    expect(cassetteDragDelta(100, 50, 0.5)).toEqual({ dx: 200, dy: 100 });
    for (const z of [0, -1, NaN, Infinity]) expect(cassetteDragDelta(10, 10, z)).toEqual({ dx: 0, dy: 0 });
    expect(cassetteDragDelta(NaN, 10, 1)).toEqual({ dx: 0, dy: 0 });
    fc.assert(
      fc.property(fc.integer({ min: -2000, max: 2000 }), fc.integer({ min: -2000, max: 2000 }), fc.double({ min: 0.15, max: 2.5, noNaN: true }), (dx, dy, zoom) => {
        const r = cassetteDragDelta(dx, dy, zoom);
        // Converting back to screen pixels gives the original delta.
        expect(r.dx * zoom).toBeCloseTo(dx, 6);
        expect(r.dy * zoom).toBeCloseTo(dy, 6);
      }),
      RUNS,
    );
  });

  it("accumulates the deltas of several pointer events into one frame step", () => {
    let p = { dx: 0, dy: 0 };
    p = accumulateDelta(p, 3, -1);
    p = accumulateDelta(p, 4, 5);
    p = accumulateDelta(p, NaN, Infinity);
    expect(p).toEqual({ dx: 7, dy: 4 });
  });

  it("arrow keys nudge by 10 px (50 with Shift) and nothing else moves a cassette", () => {
    expect(cassetteNudge("ArrowLeft", false)).toEqual({ dx: -CASSETTE_NUDGE_PX, dy: 0 });
    expect(cassetteNudge("ArrowRight", false)).toEqual({ dx: CASSETTE_NUDGE_PX, dy: 0 });
    expect(cassetteNudge("ArrowUp", true)).toEqual({ dx: 0, dy: -CASSETTE_NUDGE_SHIFT_PX });
    expect(cassetteNudge("ArrowDown", true)).toEqual({ dx: 0, dy: CASSETTE_NUDGE_SHIFT_PX });
    for (const k of ["Enter", " ", "Space", "a", "Tab", "Escape", "Delete", "Backspace"]) {
      expect(cassetteNudge(k, false)).toBeNull();
    }
  });

  it("builds the label text with the title cut and an accessible name", () => {
    expect(cassetteLabelText("Attention Is All You Need")).toBe("[🗂️ CASSETTE: Attention Is All You Need]");
    expect(cassetteLabelText("   ")).toBe("[🗂️ CASSETTE: untitled]");
    const long = cassetteLabelText("w".repeat(200));
    expect(long).toContain("…");
    expect([...long].length).toBeLessThanOrEqual(CASSETTE_LABEL_MAX + "[🗂️ CASSETTE: ]".length);
    expect(cassetteAriaLabel("Memex", 3)).toContain("3 cards");
    expect(cassetteAriaLabel("Memex", 1)).toContain("1 card.");
  });

  function member(id: string, cassetteId: string | undefined, x: number, y: number, w = 340, h = 230): MemexNode {
    return {
      id,
      type: "memexCard",
      position: { x, y },
      style: { width: w, height: h },
      data: {
        archivalId: id,
        title: id,
        content: "",
        cardType: "note",
        tags: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        ...(cassetteId !== undefined ? { cassetteId, cassetteTitle: `Title ${cassetteId}` } : {}),
      },
    };
  }

  it("frames from one pass equal cassetteFrame per cassette and enclose every member with the padding", () => {
    const cardArb = fc.record({
      cassette: fc.constantFrom<string | undefined>(undefined, "c1", "c2", "c3"),
      x: fc.integer({ min: -4000, max: 4000 }),
      y: fc.integer({ min: -4000, max: 4000 }),
      w: fc.integer({ min: 100, max: 700 }),
      h: fc.integer({ min: 100, max: 500 }),
    });
    fc.assert(
      fc.property(fc.array(cardArb, { maxLength: 14 }), (cards) => {
        const nodes = cards.map((c, i) => member(`n${i}`, c.cassette, c.x, c.y, c.w, c.h));
        const frames = buildCassetteFrames(nodes);
        const ids = new Set(nodes.map((n) => n.data.cassetteId).filter((c): c is string => c !== undefined));
        expect(frames.map((f) => f.id).sort()).toEqual([...ids].sort());
        for (const f of frames) {
          const expected = cassetteFrame(nodes, f.id);
          expect(expected).not.toBeNull();
          expect({ x: f.x, y: f.y, width: f.width, height: f.height }).toEqual(expected);
          for (const n of nodes.filter((m) => m.data.cassetteId === f.id)) {
            const w = Number(n.style?.width);
            const h = Number(n.style?.height);
            expect(f.x).toBeLessThanOrEqual(n.position.x - 24);
            expect(f.y).toBeLessThanOrEqual(n.position.y - 24);
            expect(f.x + f.width).toBeGreaterThanOrEqual(n.position.x + w + 24);
            expect(f.y + f.height).toBeGreaterThanOrEqual(n.position.y + h + 24);
          }
        }
      }),
      RUNS,
    );
  });

  it("the frames signature ignores cards outside every cassette and round-trips", () => {
    const base = [member("a", "c1", 0, 0), member("b", "c1", 400, 0), member("loose", undefined, 2000, 2000)];
    const sig = cassetteFramesSignature(buildCassetteFrames(base));
    const dragged = base.map((n) => (n.id === "loose" ? { ...n, position: { x: -900, y: 77 } } : n));
    expect(cassetteFramesSignature(buildCassetteFrames(dragged))).toBe(sig);
    const moved = base.map((n) => (n.id === "b" ? { ...n, position: { x: 900, y: 0 } } : n));
    expect(cassetteFramesSignature(buildCassetteFrames(moved))).not.toBe(sig);
    expect(parseCassetteFramesSignature(sig)).toEqual(buildCassetteFrames(base));
    expect(parseCassetteFramesSignature("")).toEqual([]);
    expect(parseCassetteFramesSignature("not json")).toEqual([]);
    expect(parseCassetteFramesSignature('[["x"]]')).toEqual([]);
    expect(buildCassetteFrames([member("loose", undefined, 0, 0)])).toEqual([]);
  });
});

describe("vault UI helpers", () => {
  it("builds the download file names from the local date", () => {
    const d = new Date(2026, 0, 5, 12, 30);
    expect(dateStamp(d)).toBe("2026-01-05");
    expect(bundleFilename(d)).toBe("memex-vault-2026-01-05.memex");
    expect(obsidianZipFilename(d)).toBe("memex-obsidian-vault-2026-01-05.zip");
    expect(dateStamp(new Date(NaN))).toBe("1970-01-01");
    fc.assert(
      fc.property(fc.date({ min: new Date(1971, 0, 2), max: new Date(2200, 0, 1), noInvalidDate: true }), (date) => {
        expect(bundleFilename(date)).toMatch(/^memex-vault-\d{4}-\d{2}-\d{2}\.memex$/);
        expect(obsidianZipFilename(date)).toMatch(/^memex-obsidian-vault-\d{4}-\d{2}-\d{2}\.zip$/);
      }),
      RUNS,
    );
  });

  it("recognises .memex names for drops and .memex or .json names for the picker", () => {
    expect(isMemexFileName("vault.memex")).toBe(true);
    expect(isMemexFileName("VAULT.MEMEX")).toBe(true);
    expect(isMemexFileName("vault.memex.txt")).toBe(false);
    expect(isMemexFileName("memex")).toBe(false);
    expect(isMemexFileName("vault.json")).toBe(false);
    expect(isRestorableFileName("old.json")).toBe(true);
    expect(isRestorableFileName("v.memex")).toBe(true);
    expect(isRestorableFileName("v.zip")).toBe(false);
  });

  it("checks the size before anything is read", () => {
    expect(checkBundleFileSize(1)).toEqual({ ok: true });
    expect(checkBundleFileSize(MAX_BUNDLE_BYTES)).toEqual({ ok: true });
    expect(checkBundleFileSize(MAX_BUNDLE_BYTES + 1).ok).toBe(false);
    expect(checkBundleFileSize(0).ok).toBe(false);
    expect(checkBundleFileSize(NaN).ok).toBe(false);
    expect(checkBundleFileSize(-1).ok).toBe(false);
  });

  it("claims a drag only when it carries files and no modal is open", () => {
    const files = { types: ["Files"], fileNames: [], fileCount: 1 };
    expect(shouldClaimFileDrag(files, false)).toBe(true);
    expect(shouldClaimFileDrag(files, true)).toBe(false);
    expect(shouldClaimFileDrag({ types: ["text/plain"], fileNames: [], fileCount: 0 }, false)).toBe(false);
    expect(shouldClaimFileDrag({ types: ["Files", "text/uri-list"], fileNames: [], fileCount: 1 }, false)).toBe(true);
    // A visible name decides: .memex claims, anything else is left alone.
    expect(shouldClaimFileDrag({ ...files, fileNames: ["a.memex"] }, false)).toBe(true);
    expect(shouldClaimFileDrag({ ...files, fileNames: ["a.png"] }, false)).toBe(false);
  });

  it("on drop only a .memex first file restores", () => {
    const f = (name: string) => ({ name });
    expect(pickDroppedBundle([f("a.memex"), f("b.png")])).toEqual({ name: "a.memex" });
    expect(pickDroppedBundle([f("b.png"), f("a.memex")])).toBeNull();
    expect(pickDroppedBundle([f("a.json")])).toBeNull();
    expect(pickDroppedBundle([])).toBeNull();
  });

  it("states both sides of the replacement", () => {
    expect(restoreSummary({ cards: 10, edges: 1, trails: 0 }, { cards: 1, edges: 2, trails: 3 })).toBe(
      "This replaces your current canvas (10 cards, 1 edge, 0 trails) with the bundle's (1 card, 2 edges, 3 trails).",
    );
  });
});

describe("toast message override", () => {
  it("a custom text replaces the catalog message, is trimmed and cut, and dedupes by text", () => {
    const a = pushToast(EMPTY_TOAST_STATE, "SNAP", "  Synapse snapped: A ↔ B  ");
    expect(a.toasts[0].message).toBe("Synapse snapped: A ↔ B");
    expect(a.toasts[0].kind).toBe("SNAP");
    expect(pushToast(a, "SNAP", "Synapse snapped: A ↔ B")).toBe(a);
    expect(pushToast(a, "SNAP", "Synapse snapped: A ↔ C").toasts).toHaveLength(2);
    // Blank text falls back to the catalog message.
    expect(pushToast(EMPTY_TOAST_STATE, "SNAP", "   ").toasts[0].message).toBe("Synapse snapped. The two cards are now linked.");
    expect(pushToast(EMPTY_TOAST_STATE, "VAULT_ERROR").toasts[0].label).toMatch(/^\[ SIGNAL \/\/ [A-Z]+ \]$/);
    expect(pushToast(EMPTY_TOAST_STATE, "VAULT", "x".repeat(1000)).toasts[0].message).toHaveLength(TOAST_MESSAGE_MAX);
  });
});
