import { create } from "zustand";
import { generateTrailBriefing } from "@/core/synthesis-engine";
import { useMemexStore } from "./useMemexStore";

/**
 * The open Export Briefing dialog. Session-only: this store is separate from
 * `useMemexStore`, so it never reaches `persistGraph`, `exportJson` or
 * hydration (the same arrangement as the toast and Sprocket session stores).
 *
 * The playback dock and the Curator's Index both call `openBriefing(trailId)`;
 * one `BriefingHost` renders the dialog, so either can open it for any trail.
 */
export interface Briefing {
  trailId: string;
  /** Generated when the dialog opened, not on every store change. */
  markdown: string;
}

interface BriefingSession {
  briefing: Briefing | null;
  /** Builds the briefing for `trailId` from the live graph. Returns false for an unknown or empty trail. */
  openBriefing: (trailId: string) => boolean;
  closeBriefing: () => void;
}

export const useBriefingSession = create<BriefingSession>()((set) => ({
  briefing: null,
  openBriefing: (trailId) => {
    const { trails, nodes, edges } = useMemexStore.getState();
    const trail = trails.find((t) => t.id === trailId);
    if (!trail || trail.nodeIds.length === 0) return false;
    set({
      briefing: {
        trailId: trail.id,
        markdown: generateTrailBriefing(trail, nodes, edges, {
          generatedDate: new Date().toISOString().slice(0, 10),
        }),
      },
    });
    return true;
  },
  closeBriefing: () => set({ briefing: null }),
}));

export const selectBriefing = (s: BriefingSession) => s.briefing;
export const selectIsBriefingOpen = (s: BriefingSession) => s.briefing !== null;
