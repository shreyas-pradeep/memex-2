import { NodeChangeset } from "@xyflow/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shouldIsolateDrag, type DragIsolationInput } from "@/core/drag-isolation";
import { nodeRect, rectGap } from "@/core/card-geometry";
import { MAGNETIC_RANGE_PX } from "@/core/magnetic-engine";
import { seedNodes } from "@/data/demo-seed";
import { magneticDragMove, magneticDragStart, magneticDragStop } from "../magnetic-drag";
import { hasMagneticSession, useMemexStore } from "../useMemexStore";

const store = () => useMemexStore.getState();

// Seed cards (see src/data/demo-seed.ts). MEM-1945-01 (Bush) and MEM-2026-07 are not connected and
// score 0.649 (calibrated 0.96); MEM-2017-04 (Vaswani) is connected to every other card.
const BUSH = "MEM-1945-01";
const SPATIAL = "MEM-2026-07";
const VASWANI = "MEM-2017-04";
const ENGELBART = "MEM-1968-03";

function installLocalStorage(): void {
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    },
    configurable: true,
  });
}

/** Selects exactly these cards, the way a box selection leaves them. */
function select(...ids: string[]): void {
  store().onNodesChange(
    new NodeChangeset(store().nodes.map((n) => ({ id: n.id, type: "select" as const, selected: ids.includes(n.id) }))),
  );
}

const selectedIds = (): string[] => store().nodes.filter((n) => n.selected === true).map((n) => n.id);

/**
 * What React Flow and `SingleCardDragIsolation` do for a press on `id`, minus the DOM: the isolation
 * handler runs first (capture phase) and, when `shouldIsolateDrag` says so, applies the same select
 * changes `addSelectedNodes([id])` emits; then XYDrag drags every selected card, or only the pressed
 * one when it is not selected. Returns how many cards React Flow would drag (`draggedCount`).
 */
function press(id: string, modifiers: Partial<Pick<DragIsolationInput, "shiftKey" | "metaKey" | "ctrlKey">> = {}): number {
  const selected = selectedIds();
  const input: DragIsolationInput = {
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    ...modifiers,
    selectedCount: selected.length,
    nodeSelected: selected.includes(id),
  };
  if (shouldIsolateDrag(input)) select(id);
  const after = selectedIds();
  return after.includes(id) ? after.length : 1;
}

/** Moves a card the way a drag frame does. */
function dragTo(id: string, x: number, y: number): void {
  useMemexStore.setState({ nodes: store().nodes.map((n) => (n.id === id ? { ...n, position: { x, y } } : n)) });
}

/** Position that puts `id` (340 wide) at the given rectangle gap to the LEFT of `anchorId`, level with it. */
function gapLeftOf(anchorId: string, gap: number): { x: number; y: number } {
  const anchor = nodeRect(store().nodes.find((n) => n.id === anchorId)!)!;
  return { x: anchor.x - 340 - gap, y: anchor.y };
}

describe("single-card drag isolation, store flow on the demo seed", () => {
  beforeEach(() => {
    installLocalStorage();
    store().resetToSeed();
    store().cancelMagneticDrag();
  });
  afterEach(() => store().cancelMagneticDrag());

  it("the seed has the cards this test relies on", () => {
    expect(seedNodes.map((n) => n.id)).toEqual(expect.arrayContaining([BUSH, SPATIAL, VASWANI, ENGELBART]));
    expect(store().edges.some((e) => [e.source, e.target].sort().join() === [BUSH, SPATIAL].sort().join())).toBe(false);
  });

  it("a plain press on a card of a multi-selection collapses it to that card and the drag offers a target", () => {
    select(BUSH, VASWANI, ENGELBART);
    expect(selectedIds()).toHaveLength(3);
    const dragged = press(BUSH);
    expect(selectedIds()).toEqual([BUSH]);
    expect(dragged).toBe(1);
    magneticDragStart(BUSH, dragged);
    expect(hasMagneticSession()).toBe(true);
    const spot = gapLeftOf(SPATIAL, 120);
    dragTo(BUSH, spot.x, spot.y);
    magneticDragMove(BUSH, dragged);
    const offer = store().magneticTarget;
    expect(offer).toMatchObject({ sourceId: BUSH, targetId: SPATIAL });
    expect(offer?.affinity).toBe(0.96);
    expect(rectGap(nodeRect(store().nodes.find((n) => n.id === BUSH)!)!, nodeRect(store().nodes.find((n) => n.id === SPATIAL)!)!)).toBeLessThan(
      MAGNETIC_RANGE_PX,
    );
    expect(magneticDragStop(BUSH, dragged)).toBe(true);
    expect(store().edges.some((e) => e.id === "e-human-MEM-1945-01-MEM-2026-07")).toBe(true);
  });

  it.each([["shiftKey"], ["metaKey"], ["ctrlKey"]] as const)(
    "with %s held the selection stays, the group drag gets no target and nothing snaps",
    (key) => {
      select(BUSH, VASWANI, ENGELBART);
      const dragged = press(BUSH, { [key]: true });
      expect(selectedIds().sort()).toEqual([BUSH, ENGELBART, VASWANI].sort());
      expect(dragged).toBe(3);
      magneticDragStart(BUSH, dragged);
      expect(hasMagneticSession()).toBe(false);
      const spot = gapLeftOf(SPATIAL, 120);
      dragTo(BUSH, spot.x, spot.y);
      magneticDragMove(BUSH, dragged);
      expect(store().magneticTarget).toBeNull();
      const edgesBefore = store().edges.length;
      expect(magneticDragStop(BUSH, dragged)).toBe(false);
      expect(store().edges).toHaveLength(edgesBefore);
    },
  );

  it("a press on an unselected card drags it alone (React Flow's own rule) and offers a target", () => {
    select(VASWANI, ENGELBART);
    // React Flow selects the pressed card (and unselects the rest) before it reads the drag items.
    select(BUSH);
    const dragged = press(BUSH);
    expect(dragged).toBe(1);
    magneticDragStart(BUSH, dragged);
    const spot = gapLeftOf(SPATIAL, 50);
    dragTo(BUSH, spot.x, spot.y);
    magneticDragMove(BUSH, dragged);
    expect(store().magneticTarget?.targetId).toBe(SPATIAL);
  });

  it("a drag grabbed on the box-selection rectangle reports its cards through the selection callbacks: one card takes part, several do not", () => {
    // The canvas passes (nodes[0].id, nodes.length) from onSelectionDragStart/Drag/Stop.
    select(BUSH);
    magneticDragStart(BUSH, 1);
    const spot = gapLeftOf(SPATIAL, 60);
    dragTo(BUSH, spot.x, spot.y);
    magneticDragMove(BUSH, 1);
    expect(store().magneticTarget?.targetId).toBe(SPATIAL);
    store().cancelMagneticDrag();
    select(BUSH, ENGELBART);
    magneticDragStart(BUSH, 2);
    magneticDragMove(BUSH, 2);
    expect(store().magneticTarget).toBeNull();
    // An empty selection (no id) never starts a session.
    magneticDragStart("", 0);
    expect(hasMagneticSession()).toBe(false);
  });

  it("the store guard still refuses a session when the card is dragged while the store holds a multi-selection (race safety net)", () => {
    select(BUSH, ENGELBART);
    // If React Flow had not yet seen the collapse it would report draggedCount 2; if the count said 1 while
    // the store still showed a group, the store refuses rather than offering a target to a group drag.
    magneticDragStart(BUSH, 1);
    expect(hasMagneticSession()).toBe(false);
  });
});
