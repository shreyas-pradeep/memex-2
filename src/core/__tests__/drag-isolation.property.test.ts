import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isGroupModifierHeld, shouldIsolateDrag, type DragIsolationInput } from "../drag-isolation";

const RUNS = { numRuns: 300 } as const;

const inputArb: fc.Arbitrary<DragIsolationInput> = fc.record({
  shiftKey: fc.boolean(),
  metaKey: fc.boolean(),
  ctrlKey: fc.boolean(),
  selectedCount: fc.integer({ min: 0, max: 12 }),
  nodeSelected: fc.boolean(),
});
const noModifiers = { shiftKey: false, metaKey: false, ctrlKey: false } as const;

describe("shouldIsolateDrag", () => {
  it("isolates exactly when no group modifier is held, the pressed card is selected and more than one card is", () => {
    let isolated = 0;
    let kept = 0;
    fc.assert(
      fc.property(inputArb, (input) => {
        const expected =
          !input.shiftKey && !input.metaKey && !input.ctrlKey && input.nodeSelected && input.selectedCount > 1;
        expect(shouldIsolateDrag(input)).toBe(expected);
        if (expected) isolated++;
        else kept++;
      }),
      RUNS,
    );
    expect(isolated).toBeGreaterThan(5);
    expect(kept).toBeGreaterThan(20);
  });

  it("never isolates while Shift, Cmd (Meta) or Ctrl is held: the user intends a group drag", () => {
    fc.assert(
      fc.property(inputArb, fc.constantFrom("shiftKey", "metaKey", "ctrlKey" as const), (input, key) => {
        expect(shouldIsolateDrag({ ...input, [key]: true })).toBe(false);
        expect(isGroupModifierHeld({ ...input, [key]: true })).toBe(true);
      }),
      RUNS,
    );
  });

  it("never isolates a lone card, an unselected card (React Flow already drags it alone) or no selection", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 12 }), (selectedCount) => {
        expect(shouldIsolateDrag({ ...noModifiers, selectedCount, nodeSelected: false })).toBe(false);
        expect(shouldIsolateDrag({ ...noModifiers, selectedCount: Math.min(selectedCount, 1), nodeSelected: true })).toBe(false);
      }),
      RUNS,
    );
  });

  it("isolates a plain press on any member of a multi-selection", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 50 }), (selectedCount) => {
        expect(shouldIsolateDrag({ ...noModifiers, selectedCount, nodeSelected: true })).toBe(true);
      }),
      RUNS,
    );
  });

  it("isGroupModifierHeld is false only when all three keys are up", () => {
    expect(isGroupModifierHeld(noModifiers)).toBe(false);
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), fc.boolean(), (shiftKey, metaKey, ctrlKey) => {
        expect(isGroupModifierHeld({ shiftKey, metaKey, ctrlKey })).toBe(shiftKey || metaKey || ctrlKey);
      }),
      RUNS,
    );
  });
});
