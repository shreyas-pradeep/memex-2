import type { GhostDiscovery, MemexNodeData } from "@/core/types";
import type { MemexStore } from "./useMemexStore";

/**
 * Granular ghost selectors. Each returns a value whose identity only changes
 * when that slice changes, so subscribers skip re-rendering during card drags.
 */

export const selectIsGhostScanning = (s: MemexStore) => s.isGhostScanning;
export const selectGhostEngineMode = (s: MemexStore) => s.ghostEngineMode;
export const selectTriggerGhostScan = (s: MemexStore) => s.triggerGhostScan;
export const selectGhostCount = (s: MemexStore) => s.ghostDiscoveries.length;

/** The discovery open in the inspector, or `null`. */
export function selectSelectedDiscovery(s: MemexStore): GhostDiscovery | null {
  const id = s.selectedGhostDiscoveryId;
  return id === null ? null : (s.ghostDiscoveries.find((g) => g.id === id) ?? null);
}

/** Card data by node ID. `data` keeps its identity while the card is dragged. */
export const selectNodeData =
  (id: string | undefined) =>
  (s: MemexStore): MemexNodeData | undefined =>
    id === undefined ? undefined : s.nodes.find((n) => n.id === id)?.data;
