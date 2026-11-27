import {
  filterSignature,
  isSpotlightActive,
  matchNodeMemo,
  type SpotlightDim,
  type SpotlightFilters,
} from "@/core/spotlight";
import type { MemexNode, MemexNodeData } from "@/core/types";
import type { MemexStore } from "./useMemexStore";

/**
 * Granular spotlight selectors. Each returns a primitive, so a card re-renders
 * only when its own match state flips. Cost per store update: nothing while no
 * filter is active; otherwise one WeakMap lookup per card, plus one id index
 * per `nodes` array (shared by every card for that update).
 */

export const selectSpotlightQuery = (s: MemexStore): string => s.spotlightQuery;
export const selectSpotlightType = (s: MemexStore) => s.spotlightType;
export const selectSpotlightTags = (s: MemexStore): string[] => s.spotlightTags;
export const selectIsSpotlightActive = (s: MemexStore): boolean =>
  isSpotlightActive({ query: s.spotlightQuery, type: s.spotlightType, tags: s.spotlightTags });

// Filter signature, cached on the three store fields so cards do not rebuild it per update.
let lastQuery = "";
let lastType: SpotlightFilters["type"] = "all";
let lastTags: readonly string[] = [];
const INACTIVE_SIGNATURE = filterSignature({ query: "", type: "all", tags: [] });
let lastSignature = INACTIVE_SIGNATURE;

function signatureOf(s: MemexStore): string {
  if (s.spotlightQuery !== lastQuery || s.spotlightType !== lastType || s.spotlightTags !== lastTags) {
    lastQuery = s.spotlightQuery;
    lastType = s.spotlightType;
    lastTags = s.spotlightTags;
    lastSignature = filterSignature({ query: lastQuery, type: lastType, tags: lastTags });
  }
  return lastSignature;
}

// One id -> data index per `nodes` array identity (a drag frame makes a new array).
const INDEX = new WeakMap<readonly MemexNode[], Map<string, MemexNodeData>>();

function dataById(nodes: readonly MemexNode[]): Map<string, MemexNodeData> {
  let index = INDEX.get(nodes);
  if (index === undefined) {
    index = new Map(nodes.map((n) => [n.id, n.data]));
    INDEX.set(nodes, index);
  }
  return index;
}

/**
 * `"off"` while no filter is active, `"match"` when the card passes, `"dim"`
 * when it does not (render it at `SPOTLIGHT_DIM_OPACITY`). Unknown ids are `"off"`.
 */
export const selectNodeSpotlightDim =
  (nodeId: string) =>
  (s: MemexStore): SpotlightDim => {
    const signature = signatureOf(s);
    if (signature === INACTIVE_SIGNATURE) return "off";
    const data = dataById(s.nodes).get(nodeId);
    if (data === undefined) return "off";
    const filters: SpotlightFilters = { query: s.spotlightQuery, type: s.spotlightType, tags: s.spotlightTags };
    return matchNodeMemo({ data }, filters, signature) ? "match" : "dim";
  };

/** Number of cards that match, or the total when no filter is active (for the "N of M" readout). */
export const selectSpotlightMatchCount = (s: MemexStore): number => {
  const signature = signatureOf(s);
  if (signature === INACTIVE_SIGNATURE) return s.nodes.length;
  const filters: SpotlightFilters = { query: s.spotlightQuery, type: s.spotlightType, tags: s.spotlightTags };
  let count = 0;
  for (const n of s.nodes) if (matchNodeMemo(n, filters, signature)) count++;
  return count;
};
