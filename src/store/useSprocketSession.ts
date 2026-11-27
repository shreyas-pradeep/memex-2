import { create } from "zustand";
import { canStartWeave } from "@/core/sprocket-motion";
import { useMemexStore } from "./useMemexStore";

/**
 * Sprocket's weaving session. Session-only: this store is separate from
 * `useMemexStore`, so none of it can reach `persistGraph`, `exportJson` or
 * hydration (the same arrangement as the toast store).
 *
 * The trigger (the HUD button, the idle prompt, Sprocket itself) calls
 * `requestWeave()`. `SprocketCrawler` subscribes to `weaveRequestId` outside
 * React and runs the show; no component needs a ref to another.
 */
export interface SprocketSession {
  isWeaving: boolean;
  weavingTrailId: string | null;
  /** Bumped by every accepted request; the crawler reacts to the change. */
  weaveRequestId: number;
  /** Position in the cycle of existing auto trails (see `chooseWeaveTrail`). */
  weaveCursor: number;
  /**
   * Asks the crawler to weave. Returns false (and changes nothing) when fewer
   * than three cards exist, a trail is playing or a weave is already running,
   * which also guards against a double trigger.
   */
  requestWeave: () => boolean;
  beginWeave: (trailId: string | null) => void;
  endWeave: () => void;
  setWeaveCursor: (cursor: number) => void;
  /** Clears everything (tests and unmount cleanup). */
  reset: () => void;
}

const INITIAL = {
  isWeaving: false,
  weavingTrailId: null,
  weaveRequestId: 0,
  weaveCursor: 0,
} as const;

export const useSprocketSession = create<SprocketSession>()((set, get) => ({
  ...INITIAL,
  requestWeave: () => {
    const { isWeaving, weaveRequestId } = get();
    const memex = useMemexStore.getState();
    if (!canStartWeave({ cardCount: memex.nodes.length, activeTrailId: memex.activeTrailId, isWeaving })) {
      return false;
    }
    set({ weaveRequestId: weaveRequestId + 1 });
    return true;
  },
  beginWeave: (trailId) => set({ isWeaving: true, weavingTrailId: trailId }),
  endWeave: () => set({ isWeaving: false, weavingTrailId: null }),
  setWeaveCursor: (cursor) => set({ weaveCursor: cursor }),
  reset: () => set({ ...INITIAL }),
}));

export const selectIsWeaving = (s: SprocketSession) => s.isWeaving;
export const selectWeaveRequestId = (s: SprocketSession) => s.weaveRequestId;
export const selectRequestWeave = (s: SprocketSession) => s.requestWeave;
export const selectWeavingTrailId = (s: SprocketSession) => s.weavingTrailId;
