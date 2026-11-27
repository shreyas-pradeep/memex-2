import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { demoSeed } from "@/data/demo-seed";
import {
  ARCHETYPE_LABELS,
  BREADCRUMB_MAX_VISIBLE,
  MIN_TRAIL_CARDS,
  authorSuffix,
  authorSurname,
  blazeFormState,
  buildManualTrail,
  buildTrailCardModel,
  buildTrailCardModels,
  curatorDrawerReducer,
  dedupeKeepOrder,
  isCuratorEscape,
  isCuratorHotkey,
  loadTrailState,
  orderSelectedCardIds,
  parseTrailCardModels,
  resolveEscapeOwner,
  sanitizeCardIds,
  serializeTrailCardModels,
  shouldDockHandleKeys,
  trailArchetype,
  truncateLabel,
  uniqueTrailId,
  weaveQuickAction,
  type CuratorDrawerEvent,
  type CuratorKeyEvent,
} from "../curators-index";
import { deserializeGraph, removeTrail, serializeGraph } from "../graph-engine";
import { forgeCustomTrail, normalizeTrailColor } from "../trail-engine";
import { generateAutoTrails, isAutoTrailId } from "../trail-genesis";
import type { GhostDiscovery, MemexGraphState, MemexNode, Trail } from "../types";

const RUNS = { numRuns: 200 } as const;

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function node(id: string, data: Partial<MemexNode["data"]> = {}, x = 0, y = 0): MemexNode {
  return {
    id,
    type: "memexCard",
    position: { x, y },
    data: {
      archivalId: id,
      title: `Title ${id}`,
      content: "",
      cardType: "note",
      tags: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      ...data,
    },
  };
}

function trail(id: string, nodeIds: string[], extra: Partial<Trail> = {}): Trail {
  return {
    id,
    title: `Trail ${id}`,
    description: "",
    origin: "human",
    nodeIds,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

const idArb = fc.stringMatching(/^[a-z0-9]{1,5}$/);

const keyEventArb: fc.Arbitrary<CuratorKeyEvent> = fc.record({
  key: fc.constantFrom("t", "T", "Escape", "Enter", "a", "i", "ArrowLeft", " ", "Tab"),
  ctrlKey: fc.boolean(),
  metaKey: fc.boolean(),
  altKey: fc.boolean(),
  shiftKey: fc.boolean(),
  repeat: fc.boolean(),
  defaultPrevented: fc.boolean(),
  targetIsEditable: fc.boolean(),
  targetInsideDrawer: fc.boolean(),
  modalOpen: fc.boolean(),
});

const plainT: CuratorKeyEvent = {
  key: "t",
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  defaultPrevented: false,
  targetIsEditable: false,
  targetInsideDrawer: false,
  modalOpen: false,
};
const plainEsc: CuratorKeyEvent = { ...plainT, key: "Escape" };

// ---------------------------------------------------------------------------
// P1: loading a trail from the index
// ---------------------------------------------------------------------------

describe("Property 1: loading a trail into the lever", () => {
  const trailsArb = fc
    .uniqueArray(idArb, { minLength: 0, maxLength: 8 })
    .chain((ids) =>
      fc.tuple(...ids.map((id) => fc.array(idArb, { maxLength: 6 }).map((n) => trail(id, n)))),
    );

  it("sets the matching trail at stop 0 with auto-play off, for every known non-empty trail", () => {
    fc.assert(
      fc.property(trailsArb, (trails) => {
        for (const t of trails) {
          const state = loadTrailState(trails, t.id);
          if (t.nodeIds.length === 0) {
            expect(state).toBeNull();
          } else {
            expect(state).toEqual({ activeTrailId: t.id, activeTrailIndex: 0, isPlayingAuto: false });
            expect(trails.some((x) => x.id === state?.activeTrailId)).toBe(true);
          }
        }
      }),
      RUNS,
    );
  });

  it("never loads an unknown id", () => {
    fc.assert(
      fc.property(trailsArb, fc.string(), (trails, id) => {
        fc.pre(!trails.some((t) => t.id === id));
        expect(loadTrailState(trails, id)).toBeNull();
      }),
      RUNS,
    );
  });
});

// ---------------------------------------------------------------------------
// P2: manual trail creation
// ---------------------------------------------------------------------------

describe("Property 2: manual trail creation", () => {
  it("builds unique ids across repeated calls, even with colliding seeds and arbitrary names", () => {
    const seedArb = fc.constantFrom("a", "b", "ab12", "", "auto-lineage-0123abcd");
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.string(), seedArb), { minLength: 1, maxLength: 30 }),
        (calls) => {
          const known = ["x", "y", "z"];
          const existing: string[] = [];
          for (const [name, seed] of calls) {
            const t = buildManualTrail({
              title: name,
              description: "",
              cardIds: known,
              knownNodeIds: known,
              existingTrailIds: existing,
              idSeed: seed,
              createdAt: "2026-01-01T00:00:00.000Z",
            });
            expect(t).not.toBeNull();
            if (t === null) return;
            expect(existing).not.toContain(t.id);
            expect(isAutoTrailId(t.id)).toBe(false);
            existing.push(t.id);
          }
          expect(new Set(existing).size).toBe(existing.length);
        },
      ),
      RUNS,
    );
  });

  it("keeps the exact order of the passed ids, without repeats, only valid ids, and needs 2 or more", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(idArb, { maxLength: 10 }),
        fc.array(idArb, { maxLength: 25 }),
        fc.string(),
        fc.string(),
        (known, passed, name, description) => {
          const t = buildManualTrail({
            title: name,
            description,
            cardIds: passed,
            knownNodeIds: known,
            existingTrailIds: [],
            idSeed: "seed",
            createdAt: "2026-01-01T00:00:00.000Z",
          });
          // Reference: first occurrence wins, unknown ids dropped.
          const expected: string[] = [];
          for (const id of passed) {
            if (known.includes(id) && !expected.includes(id)) expected.push(id);
          }
          if (expected.length < MIN_TRAIL_CARDS) {
            expect(t).toBeNull();
            return;
          }
          expect(t).not.toBeNull();
          expect(t?.nodeIds).toEqual(expected);
          expect(new Set(t?.nodeIds).size).toBe(t?.nodeIds.length);
          expect(t?.origin).toBe("human");
          expect(t?.title).toBe(name.trim() === "" ? "Untitled Trail" : name.trim());
          expect(t?.description).toBe(description.trim());
          expect(t).not.toHaveProperty("color");
        },
      ),
      RUNS,
    );
  });

  it("dedupeKeepOrder and sanitizeCardIds keep order and are idempotent", () => {
    fc.assert(
      fc.property(fc.array(idArb, { maxLength: 30 }), fc.uniqueArray(idArb, { maxLength: 10 }), (ids, known) => {
        const d = dedupeKeepOrder(ids);
        expect(dedupeKeepOrder(d)).toEqual(d);
        expect(new Set(d).size).toBe(d.length);
        const s = sanitizeCardIds(ids, known);
        expect(s.every((id) => known.includes(id))).toBe(true);
        expect(sanitizeCardIds(s, known)).toEqual(s);
        // Subsequence of the deduped input.
        let i = 0;
        for (const id of d) if (i < s.length && s[i] === id) i++;
        expect(i).toBe(s.length);
      }),
      RUNS,
    );
  });

  it("uniqueTrailId never returns a taken id and returns the candidate when free", () => {
    fc.assert(
      fc.property(fc.array(idArb, { maxLength: 20 }), idArb, (existing, candidate) => {
        const id = uniqueTrailId(existing, candidate);
        expect(existing).not.toContain(id);
        if (!existing.includes(candidate)) expect(id).toBe(candidate);
        else expect(id.startsWith(`${candidate}-`)).toBe(true);
      }),
      RUNS,
    );
  });

  it("keeps a valid color, normalized, and ignores an invalid one", () => {
    fc.assert(
      fc.property(fc.string(), (color) => {
        const t = buildManualTrail({
          title: "T",
          description: "",
          cardIds: ["a", "b"],
          knownNodeIds: ["a", "b"],
          existingTrailIds: [],
          idSeed: "s",
          createdAt: "2026-01-01T00:00:00.000Z",
          color,
        });
        const valid = /^#[0-9a-fA-F]{6}$/.test(color);
        if (valid) expect(t?.color).toBe(color.toUpperCase());
        else expect(t).not.toHaveProperty("color");
      }),
      RUNS,
    );
    expect(normalizeTrailColor("#ffb236")).toBe("#FFB236");
    for (const bad of ["#fb3", "ffb236", "#ffb23", "#ffb2366", "red", "#GGGGGG", "", 12, null, undefined]) {
      expect(normalizeTrailColor(bad)).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// P3: drawer state machine
// ---------------------------------------------------------------------------

/** Independent reference model, written as a decision table over the same inputs. */
function reference(open: boolean, ev: CuratorDrawerEvent): boolean {
  switch (ev.type) {
    case "toggle":
      return !open;
    case "open":
      return true;
    case "close":
      return false;
    case "escape":
    case "hotkey":
    case "key": {
      const k = ev.event;
      if (k.key === "Escape" && ev.type !== "hotkey") {
        const allowed = open && !k.modalOpen && (!k.targetIsEditable || k.targetInsideDrawer);
        return allowed ? false : open;
      }
      if ((k.key === "t" || k.key === "T") && ev.type !== "escape") {
        const typing = k.targetIsEditable;
        const modified = k.ctrlKey || k.metaKey || k.altKey;
        const blocked = typing || modified || k.repeat || k.defaultPrevented || k.modalOpen;
        return blocked ? open : !open;
      }
      return open;
    }
  }
}

const eventArb: fc.Arbitrary<CuratorDrawerEvent> = fc.oneof(
  fc.constant<CuratorDrawerEvent>({ type: "toggle" }),
  fc.constant<CuratorDrawerEvent>({ type: "open" }),
  fc.constant<CuratorDrawerEvent>({ type: "close" }),
  keyEventArb.map<CuratorDrawerEvent>((event) => ({ type: "escape", event })),
  keyEventArb.map<CuratorDrawerEvent>((event) => ({ type: "hotkey", event })),
  keyEventArb.map<CuratorDrawerEvent>((event) => ({ type: "key", event })),
  keyEventArb.map<CuratorDrawerEvent>((event) => ({ type: "key", event })),
);

describe("Property 3: the drawer state machine", () => {
  it("matches the reference model across arbitrary event sequences and is always a boolean", () => {
    fc.assert(
      fc.property(fc.boolean(), fc.array(eventArb, { maxLength: 60 }), (start, events) => {
        let state = start;
        let model = start;
        for (const ev of events) {
          state = curatorDrawerReducer(state, ev);
          model = reference(model, ev);
          expect(typeof state).toBe("boolean");
          expect(state).toBe(model);
        }
      }),
      RUNS,
    );
  });

  it("T toggles only when allowed; every other key press, including Tab and Enter, changes nothing", () => {
    fc.assert(
      fc.property(fc.boolean(), keyEventArb, (open, e) => {
        const next = curatorDrawerReducer(open, { type: "key", event: e });
        if (e.key === "Escape") return;
        if (e.key === "t" || e.key === "T") {
          expect(next).toBe(isCuratorHotkey(e) ? !open : open);
        } else {
          expect(next).toBe(open);
        }
      }),
      RUNS,
    );
  });

  it("Escape only ever closes, and only when the drawer is open", () => {
    fc.assert(
      fc.property(fc.boolean(), keyEventArb, (open, e) => {
        const next = curatorDrawerReducer(open, { type: "key", event: { ...e, key: "Escape" } });
        expect(next && !open).toBe(false); // never opens
        if (!open) expect(next).toBe(false);
        if (next !== open) expect(isCuratorEscape({ ...e, key: "Escape" }, open)).toBe(true);
      }),
      RUNS,
    );
  });

  it("T twice returns to the start state when both presses are allowed", () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (open, shift) => {
        const e = { ...plainT, key: shift ? "T" : "t", shiftKey: shift };
        const once = curatorDrawerReducer(open, { type: "hotkey", event: e });
        expect(once).toBe(!open);
        expect(curatorDrawerReducer(once, { type: "hotkey", event: e })).toBe(open);
      }),
      RUNS,
    );
  });

  it("documents the exact rules", () => {
    expect(isCuratorHotkey(plainT)).toBe(true);
    expect(isCuratorHotkey({ ...plainT, key: "T", shiftKey: true })).toBe(true);
    for (const patch of [
      { ctrlKey: true },
      { metaKey: true },
      { altKey: true },
      { repeat: true },
      { defaultPrevented: true },
      { targetIsEditable: true },
      { modalOpen: true },
      { key: "y" },
    ]) {
      expect(isCuratorHotkey({ ...plainT, ...patch })).toBe(false);
    }
    expect(isCuratorEscape(plainEsc, true)).toBe(true);
    expect(isCuratorEscape(plainEsc, false)).toBe(false);
    expect(isCuratorEscape({ ...plainEsc, modalOpen: true }, true)).toBe(false);
    // The blaze form (inside the drawer) lets Escape through; a card editor outside keeps it.
    expect(isCuratorEscape({ ...plainEsc, targetIsEditable: true, targetInsideDrawer: true }, true)).toBe(true);
    expect(isCuratorEscape({ ...plainEsc, targetIsEditable: true, targetInsideDrawer: false }, true)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Escape and dock precedence
// ---------------------------------------------------------------------------

describe("Escape precedence", () => {
  it("a modal beats the drawer, the drawer beats the dock, the dock beats nothing", () => {
    expect(resolveEscapeOwner({ modalOpen: true, drawerOpen: true, trailActive: true })).toBe("modal");
    expect(resolveEscapeOwner({ modalOpen: false, drawerOpen: true, trailActive: true })).toBe("curator-drawer");
    expect(resolveEscapeOwner({ modalOpen: false, drawerOpen: false, trailActive: true })).toBe("dock");
    expect(resolveEscapeOwner({ modalOpen: false, drawerOpen: false, trailActive: false })).toBe("none");
  });

  it("Escape with the drawer open closes the drawer and the dock must not handle the same key", () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), fc.boolean(), (modalOpen, drawerOpen, trailActive) => {
        const owner = resolveEscapeOwner({ modalOpen, drawerOpen, trailActive });
        const dockWouldHandle = shouldDockHandleKeys({ drawerOpen, modalOpen, targetIsEditable: false });
        // The dock may act on Escape only when it is the owner.
        if (dockWouldHandle && trailActive) expect(owner).toBe("dock");
        if (owner === "curator-drawer") expect(dockWouldHandle).toBe(false);
        // The reducer agrees with the owner: Escape closes the drawer exactly when it owns the key.
        const next = curatorDrawerReducer(drawerOpen, { type: "key", event: { ...plainEsc, modalOpen } });
        expect(drawerOpen && !next).toBe(owner === "curator-drawer");
      }),
      RUNS,
    );
  });

  it("the dock ignores arrows and Escape while typing, while a modal is open and while the drawer is open", () => {
    expect(shouldDockHandleKeys({ drawerOpen: false, modalOpen: false, targetIsEditable: false })).toBe(true);
    expect(shouldDockHandleKeys({ drawerOpen: true, modalOpen: false, targetIsEditable: false })).toBe(false);
    expect(shouldDockHandleKeys({ drawerOpen: false, modalOpen: true, targetIsEditable: false })).toBe(false);
    expect(shouldDockHandleKeys({ drawerOpen: false, modalOpen: false, targetIsEditable: true })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Trail card view-model
// ---------------------------------------------------------------------------

describe("buildTrailCardModel", () => {
  const nodes = [
    node("a", { title: "As We May Think", year: 1945 }),
    node("b", { title: "Attention Is All You Need", year: 2017, authors: ["Ashish Vaswani", "Noam Shazeer"] }),
    node("c", { title: "Spatial memory", date: "2026-03" }),
    node("d", { title: "Undated" }),
  ];

  it("reports stop count (existing cards only), era span and summary line", () => {
    const m = buildTrailCardModel(trail("t-1", ["a", "ghost-missing", "b", "c"]), nodes);
    expect(m.stopCount).toBe(3);
    expect(m.eraSpan).toEqual({ from: 1945, to: 2026 });
    expect(m.eraLabel).toBe("1945 → 2026");
    expect(m.summaryLine).toBe("3 stops • 1945 → 2026");
  });

  it("uses a single year when the span collapses and omits the era when no stop is dated", () => {
    const single = buildTrailCardModel(trail("t-1", ["a"]), nodes);
    expect(single.eraLabel).toBe("1945");
    expect(single.summaryLine).toBe("1 stop • 1945");
    const none = buildTrailCardModel(trail("t-1", ["d"]), nodes);
    expect(none.eraSpan).toBeNull();
    expect(none.eraLabel).toBeNull();
    expect(none.summaryLine).toBe("1 stop");
  });

  it("orders breadcrumbs as the trail does, skips missing cards, adds the surname, keeps the full title", () => {
    const m = buildTrailCardModel(trail("t-1", ["c", "zzz", "b", "a"]), nodes);
    expect(m.breadcrumbs.map((b) => b.nodeId)).toEqual(["c", "b", "a"]);
    expect(m.breadcrumbs[1].label).toBe("Attention Is All You Need · Vaswani et al.");
    expect(m.breadcrumbs[1].fullLabel).toBe("Attention Is All You Need · Vaswani et al.");
    expect(m.breadcrumbs[0].label).toBe("Spatial memory");
  });

  it("truncates long labels but preserves the full title", () => {
    const long = "A Very Long Title That Keeps Going Well Past Any Pill Width";
    const m = buildTrailCardModel(trail("t-1", ["x"]), [node("x", { title: long })]);
    expect(m.breadcrumbs[0].label.endsWith("…")).toBe(true);
    expect([...m.breadcrumbs[0].label].length).toBeLessThanOrEqual(26);
    expect(m.breadcrumbs[0].fullLabel).toBe(long);
  });

  it("caps the pills and counts the overflow", () => {
    const many = Array.from({ length: 40 }, (_, i) => node(`n${i}`, { year: 1900 + i }));
    const m = buildTrailCardModel(trail("t-1", many.map((n) => n.id)), many);
    expect(m.breadcrumbs).toHaveLength(BREADCRUMB_MAX_VISIBLE);
    expect(m.overflowCount).toBe(40 - BREADCRUMB_MAX_VISIBLE);
    expect(m.stopCount).toBe(40);
    expect(m.summaryLine).toBe("40 stops • 1900 → 1939");
  });

  it("handles empty trails and empty node lists", () => {
    const m = buildTrailCardModel(trail("t-1", []), nodes);
    expect(m).toMatchObject({ stopCount: 0, eraSpan: null, breadcrumbs: [], overflowCount: 0, summaryLine: "0 stops" });
    const none = buildTrailCardModel(trail("t-1", ["a", "b"]), []);
    expect(none.stopCount).toBe(0);
    expect(none.breadcrumbs).toEqual([]);
  });

  it("falls back for blank titles", () => {
    const m = buildTrailCardModel(trail("t-1", ["x"], { title: "   " }), [node("x", { title: " " })]);
    expect(m.title).toBe("Untitled Trail");
    expect(m.breadcrumbs[0].label).toBe("Untitled card");
  });

  it("holds its invariants for arbitrary trails and cards", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(idArb, { maxLength: 15 }),
        fc.array(idArb, { maxLength: 25 }),
        fc.array(fc.option(fc.integer({ min: 1000, max: 2100 }), { nil: undefined }), { minLength: 15, maxLength: 15 }),
        fc.string(),
        (ids, trailIds, years, title) => {
          const cards = ids.map((id, i) => node(id, { year: years[i], title }));
          const m = buildTrailCardModel(trail("t-x", trailIds), cards);
          const existing = trailIds.filter((id) => ids.includes(id));
          expect(m.stopCount).toBe(existing.length);
          expect(m.stopCount).toBeLessThanOrEqual(trailIds.length);
          expect(m.breadcrumbs.length + m.overflowCount).toBe(m.stopCount);
          expect(m.breadcrumbs.map((b) => b.nodeId)).toEqual(existing.slice(0, m.breadcrumbs.length));
          if (m.eraSpan !== null) expect(m.eraSpan.from).toBeLessThanOrEqual(m.eraSpan.to);
          expect(m.summaryLine.startsWith(`${m.stopCount} `)).toBe(true);
          expect(m.accent).toMatch(/^#[0-9A-F]{6}$/);
          for (const b of m.breadcrumbs) expect(b.label.length).toBeGreaterThan(0);
          // Round-trips through the signature string.
          expect(parseTrailCardModels(serializeTrailCardModels([m]))).toEqual([m]);
        },
      ),
      RUNS,
    );
  });

  it("lists trails newest first and builds the card lookup once", () => {
    const models = buildTrailCardModels([trail("t-1", ["a"]), trail("t-2", ["b"])], nodes);
    expect(models.map((m) => m.id)).toEqual(["t-2", "t-1"]);
  });
});

describe("archetype and accent", () => {
  it("maps generated ids to their kind, other ghost trails to Ghost Trail and human trails to Manual Trail", () => {
    expect(trailArchetype({ id: "t-auto-lineage-0123abcd", origin: "ghost" })).toBe("lineage");
    expect(trailArchetype({ id: "t-auto-debate-0123abcd", origin: "ghost" })).toBe("debate");
    expect(trailArchetype({ id: "t-auto-nexus-0123abcd", origin: "ghost" })).toBe("nexus");
    expect(trailArchetype({ id: "t-ghost-1", origin: "ghost" })).toBe("ghost");
    expect(trailArchetype({ id: "t-1a2b3c4d", origin: "human" })).toBe("manual");
    expect(Object.values(ARCHETYPE_LABELS)).toEqual([
      "AI Lineage Arc",
      "Dialectical Debate",
      "Conceptual Nexus",
      "Manual Trail",
      "Ghost Trail",
    ]);
  });

  it("labels the demo seed trails and generated trails", () => {
    const cards = demoSeed.nodes;
    for (const t of demoSeed.trails) {
      const m = buildTrailCardModel(t, cards);
      expect(m.archetype).toBe(t.origin === "ghost" ? "ghost" : "manual");
      expect(m.stopCount).toBe(t.nodeIds.length);
    }
    const auto = generateAutoTrails(cards, demoSeed.edges, demoSeed.ghostDiscoveries);
    expect(auto.length).toBeGreaterThan(0);
    for (const t of auto) {
      const m = buildTrailCardModel(t, cards);
      expect(["lineage", "debate", "nexus"]).toContain(m.archetype);
      expect(m.hasCustomColor).toBe(false);
      expect(m.accent).toBe("#B388FF");
    }
  });

  it("uses a valid trail color and ignores an invalid one", () => {
    expect(buildTrailCardModel(trail("t-1", [], { color: "#12ab34" }), []).accent).toBe("#12AB34");
    const bad = buildTrailCardModel(trail("t-1", [], { color: "nope" }), []);
    expect(bad.accent).toBe("#FFB236");
    expect(bad.hasCustomColor).toBe(false);
  });
});

describe("labels", () => {
  it("reads surnames without inventing any", () => {
    expect(authorSurname("Ashish Vaswani")).toBe("Vaswani");
    expect(authorSurname("Vaswani, Ashish")).toBe("Vaswani");
    expect(authorSurname("Martin Luther King Jr.")).toBe("King");
    expect(authorSurname("Plato")).toBe("Plato");
    expect(authorSurname("   ")).toBeNull();
    expect(authorSurname("123")).toBeNull();
    expect(authorSuffix(["A. Author"])).toBe("Author");
    expect(authorSuffix(["A. Author", "B. Other"])).toBe("Author et al.");
    expect(authorSuffix([])).toBeNull();
    expect(authorSuffix(undefined)).toBeNull();
  });

  it("truncateLabel never exceeds the limit", () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 1, max: 40 }), (text, max) => {
        const out = truncateLabel(text, max);
        expect([...out].length).toBeLessThanOrEqual(max);
        if ([...text.trim().replace(/\s+/g, " ")].length <= max) expect(out).toBe(text.trim().replace(/\s+/g, " "));
      }),
      RUNS,
    );
  });
});

// ---------------------------------------------------------------------------
// Selection, form and weave rules
// ---------------------------------------------------------------------------

describe("selection order, blaze form and weave action", () => {
  it("orders the selection left to right, then top to bottom, and ignores unselected cards", () => {
    const cards = [
      { id: "c", position: { x: 50, y: 0 }, selected: true },
      { id: "a", position: { x: 0, y: 40 }, selected: true },
      { id: "b", position: { x: 0, y: 10 }, selected: true },
      { id: "skip", position: { x: -9, y: 0 }, selected: false },
      { id: "none", position: { x: -9, y: 0 } },
    ];
    expect(orderSelectedCardIds(cards)).toEqual(["b", "a", "c"]);
  });

  it("selection order is a permutation of the selected ids, independent of input order", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.record({
            id: idArb,
            position: fc.record({ x: fc.integer({ min: -50, max: 50 }), y: fc.integer({ min: -50, max: 50 }) }),
            selected: fc.boolean(),
          }),
          { selector: (c) => c.id, maxLength: 15 },
        ),
        (cards) => {
          const ordered = orderSelectedCardIds(cards);
          expect([...ordered].sort()).toEqual(cards.filter((c) => c.selected).map((c) => c.id).sort());
          expect(orderSelectedCardIds([...cards].reverse())).toEqual(ordered);
        },
      ),
      RUNS,
    );
  });

  it("blaze needs 2 or more cards and says so otherwise", () => {
    expect(blazeFormState(0)).toEqual({ canSubmit: false, hint: expect.stringContaining("at least 2") });
    expect(blazeFormState(1).canSubmit).toBe(false);
    expect(blazeFormState(1).hint).toContain("1 selected");
    expect(blazeFormState(2)).toEqual({ canSubmit: true, hint: null });
    expect(blazeFormState(Number.NaN).canSubmit).toBe(false);
  });

  it("the weave action mirrors the HUD rules and always explains itself", () => {
    expect(weaveQuickAction({ cardCount: 5, activeTrailId: null, isWeaving: false }).enabled).toBe(true);
    for (const input of [
      { cardCount: 2, activeTrailId: null, isWeaving: false },
      { cardCount: 5, activeTrailId: "t", isWeaving: false },
      { cardCount: 5, activeTrailId: null, isWeaving: true },
    ]) {
      const a = weaveQuickAction(input);
      expect(a.enabled).toBe(false);
      expect(a.hint.length).toBeGreaterThan(10);
    }
  });
});

// ---------------------------------------------------------------------------
// Pure graph changes: removeTrail and the optional color
// ---------------------------------------------------------------------------

describe("removeTrail and trail color in the data model", () => {
  const base: MemexGraphState = {
    nodes: [node("a"), node("b"), node("c")],
    edges: [],
    trails: [trail("t-1", ["a", "b"]), trail("t-2", ["b", "c"])],
    ghostDiscoveries: [
      {
        id: "d1",
        sourceId: "a",
        targetId: "c",
        rationale: "r",
        confidence: 0.5,
        trailId: "t-1",
        discoveredAt: "2026-01-01T00:00:00.000Z",
      } satisfies GhostDiscovery,
    ],
  };

  it("removes only that trail, clears dangling discovery links and returns the same state for unknown ids", () => {
    const next = removeTrail(base, "t-1");
    expect(next.trails.map((t) => t.id)).toEqual(["t-2"]);
    expect(next.nodes).toBe(base.nodes);
    expect(next.edges).toBe(base.edges);
    expect(next.ghostDiscoveries[0]).not.toHaveProperty("trailId");
    expect(base.trails).toHaveLength(2); // input untouched
    expect(removeTrail(base, "nope")).toBe(base);
    expect(removeTrail(removeTrail(base, "t-1"), "t-1").trails).toHaveLength(1);
  });

  it("round-trips a trail with a color and an old save without one", () => {
    const withColor: MemexGraphState = {
      ...base,
      trails: [
        forgeCustomTrail("Colored", "", ["a", "b"], "human", { id: "t-c", color: "#b388ff" }),
        forgeCustomTrail("Plain", "", ["a", "b"], "human", { id: "t-p" }),
      ],
    };
    const json = serializeGraph(withColor);
    expect(deserializeGraph(json)).toEqual(withColor);
    expect(serializeGraph(deserializeGraph(json))).toBe(json);
    expect(withColor.trails[0].color).toBe("#B388FF");
    expect(Object.keys(withColor.trails[1])).toEqual(["id", "title", "description", "origin", "nodeIds", "createdAt"]);
    // A save written before Spec 08 has no color anywhere and still loads.
    const old = deserializeGraph(serializeGraph(base));
    expect(old.trails.every((t) => !("color" in t))).toBe(true);
  });

  it("auto trails keep exactly the original six keys", () => {
    const auto = generateAutoTrails(demoSeed.nodes, demoSeed.edges, demoSeed.ghostDiscoveries);
    expect(auto.length).toBeGreaterThan(0);
    for (const t of auto) {
      expect(Object.keys(t).sort()).toEqual(["createdAt", "description", "id", "nodeIds", "origin", "title"]);
    }
  });
});
