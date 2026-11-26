import { useCallback } from "react";
import { useMemexStore, type MemexStore } from "./useMemexStore";

/**
 * How a canvas element is presented during trail playback.
 * - `idle`: no trail is playing
 * - `current`: the node at the active stop
 * - `active`: part of the playing trail
 * - `dim`: outside the playing trail (rendered at 0.2 opacity)
 */
export type TrailVisualState = "idle" | "current" | "active" | "dim";

/** Opacity applied to elements outside the playing trail. */
export const DIM_OPACITY = 0.2;

export function nodeTrailState(s: MemexStore, nodeId: string): TrailVisualState {
  if (s.activeTrailId === null) return "idle";
  const trail = s.trails.find((t) => t.id === s.activeTrailId);
  if (!trail) return "idle";
  if (trail.nodeIds[s.activeTrailIndex] === nodeId) return "current";
  return trail.nodeIds.includes(nodeId) ? "active" : "dim";
}

export function edgeTrailState(
  s: MemexStore,
  source: string,
  target: string,
): TrailVisualState {
  if (s.activeTrailId === null) return "idle";
  const trail = s.trails.find((t) => t.id === s.activeTrailId);
  if (!trail) return "idle";
  const ids = trail.nodeIds;
  for (let i = 0; i + 1 < ids.length; i++) {
    if (
      (ids[i] === source && ids[i + 1] === target) ||
      (ids[i] === target && ids[i + 1] === source)
    ) {
      return "active";
    }
  }
  return "dim";
}

/** Subscribes to a single string, so a card re-renders only when its state flips. */
export function useNodeTrailState(nodeId: string): TrailVisualState {
  return useMemexStore(useCallback((s: MemexStore) => nodeTrailState(s, nodeId), [nodeId]));
}

export function useEdgeTrailState(source: string, target: string): TrailVisualState {
  return useMemexStore(
    useCallback((s: MemexStore) => edgeTrailState(s, source, target), [source, target]),
  );
}

/** Origin of the playing trail, for accent color. */
export const selectActiveTrail = (s: MemexStore) =>
  s.activeTrailId === null ? null : (s.trails.find((t) => t.id === s.activeTrailId) ?? null);
