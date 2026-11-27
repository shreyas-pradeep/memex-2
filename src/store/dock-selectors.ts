import { buildCassetteFrames, cassetteFramesSignature } from "@/core/cassette-drag";
import { arcSignature } from "@/core/magnetic-arc";
import { nodeRect } from "@/core/card-geometry";
import type { AssociativeEdge } from "@/core/types";
import type { MemexStore } from "./useMemexStore";

/**
 * Granular selectors for the command dock, the magnetic arc and the cassette
 * frames. Every selector returns a primitive (or an object whose identity only
 * changes with its slice), so a card drag re-renders only the pieces that
 * actually depend on positions.
 */

export const selectDockOpen = (s: MemexStore): boolean => s.commandDock.open;
export const selectDockTab = (s: MemexStore) => s.commandDock.tab;
export const selectDockFocusRequest = (s: MemexStore): number => s.dockFocusRequest;
export const selectTrailTotal = (s: MemexStore): number => s.trails?.length ?? 0;
/** Pending discoveries: accepting or dismissing removes them, so every one waits for review. */
export const selectUnreviewedDiscoveries = (s: MemexStore): number => s.ghostDiscoveries?.length ?? 0;
export const selectInspectedEdgeId = (s: MemexStore): string | null => s.inspectedEdgeId;

/** The inspected real edge, or `null`. Its identity changes only when the edge list does. */
export const selectInspectedEdge = (s: MemexStore): AssociativeEdge | null =>
  s.inspectedEdgeId === null ? null : (s.edges.find((e) => e.id === s.inspectedEdgeId) ?? null);

export const selectMagneticTarget = (s: MemexStore) => s.magneticTarget;
export const selectLastSnapEdgeId = (s: MemexStore): string | null => s.lastSnapEdgeId;

/** True while the edge is the one the last magnetic snap created (for its one-time pulse). */
export const selectIsSnapEdge =
  (edgeId: string) =>
  (s: MemexStore): boolean =>
    s.lastSnapEdgeId !== null && s.lastSnapEdgeId === edgeId;

/**
 * Rectangles of the magnetic pair as one string, `""` while no target is offered.
 * It changes while the dragged card moves and not otherwise, so only the arc
 * overlay re-renders per drag frame.
 */
export const selectMagneticArcSignature = (s: MemexStore): string => {
  const target = s.magneticTarget;
  if (target === null) return "";
  let source: MemexStore["nodes"][number] | undefined;
  let other: MemexStore["nodes"][number] | undefined;
  for (const n of s.nodes) {
    if (n.id === target.sourceId) source = n;
    else if (n.id === target.targetId) other = n;
    if (source !== undefined && other !== undefined) break;
  }
  if (source === undefined || other === undefined) return "";
  const a = nodeRect(source);
  const b = nodeRect(other);
  return a === null || b === null ? "" : arcSignature(a, b);
};

/** Titles of the two cards of the offered pair, `""` while none (changes only with the offer or a title edit). */
export const selectMagneticTitles = (s: MemexStore): string => {
  const target = s.magneticTarget;
  if (target === null) return "";
  const titleOf = (id: string): string => s.nodes.find((n) => n.id === id)?.data.title ?? "";
  return JSON.stringify([titleOf(target.sourceId), titleOf(target.targetId)]);
};

/** Cassette frames as one string; a drag of a non-member card leaves it unchanged. */
export const selectCassetteFramesSignature = (s: MemexStore): string =>
  cassetteFramesSignature(buildCassetteFrames(s.nodes));
