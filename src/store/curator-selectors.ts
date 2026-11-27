import {
  buildTrailCardModels,
  orderSelectedCardIds,
  serializeTrailCardModels,
} from "@/core/curators-index";
import type { MemexStore } from "./useMemexStore";

/**
 * Granular selectors for the Curator's Index. Each returns a primitive (a
 * number, a boolean or a string), so zustand's `Object.is` check keeps the
 * drawer, the trigger and the canvas from re-rendering during card drags.
 */

export const selectIsCuratorOpen = (s: MemexStore): boolean => s.isCuratorDrawerOpen;
export const selectCuratorTrailCount = (s: MemexStore): number => s.trails?.length ?? 0;
export const selectCuratorActiveTrailId = (s: MemexStore): string | null => s.activeTrailId;
export const selectCuratorCardCount = (s: MemexStore): number => s.nodes?.length ?? 0;

/** Empty while the drawer is closed, so a drag costs nothing when nobody is looking. */
export const NO_SIGNATURE = "";

/**
 * The trail list as one string (see `serializeTrailCardModels`): it changes
 * only when a trail, or a title, author or date of a card in it, changes. A
 * card drag replaces `nodes` at 60 fps without changing the string.
 */
export const selectTrailListSignature = (s: MemexStore): string =>
  s.isCuratorDrawerOpen ? serializeTrailCardModels(buildTrailCardModels(s.trails, s.nodes)) : NO_SIGNATURE;

/**
 * The selected cards in reading order as one string of `[id, title]` pairs.
 * Empty while the drawer is closed. A selection change or a drag that reorders
 * the cards changes it; a drag that does not, does not.
 */
export const selectSelectionSignature = (s: MemexStore): string => {
  if (!s.isCuratorDrawerOpen) return NO_SIGNATURE;
  const ordered = orderSelectedCardIds(s.nodes);
  const titles = new Map(s.nodes.map((n) => [n.id, n.data.title]));
  return JSON.stringify(ordered.map((id) => [id, titles.get(id) ?? ""]));
};

export function parseSelectionSignature(signature: string): { id: string; title: string }[] {
  if (signature === "") return [];
  try {
    const raw: unknown = JSON.parse(signature);
    if (!Array.isArray(raw)) return [];
    return (raw as [string, string][]).map(([id, title]) => ({ id, title }));
  } catch {
    return [];
  }
}
