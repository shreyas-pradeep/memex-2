"use client";

import { selectBriefing, useBriefingSession } from "@/store/useBriefingSession";
import { ExportBriefingModal } from "./ExportBriefingModal";

const selectClose = (s: { closeBriefing: () => void }) => s.closeBriefing;

/**
 * Renders the Export Briefing dialog for whichever trail was asked for, from
 * the playback dock or the Curator's Index. Mounted once.
 */
export function BriefingHost() {
  const briefing = useBriefingSession(selectBriefing);
  const close = useBriefingSession(selectClose);
  if (briefing === null) return null;
  return (
    <ExportBriefingModal
      markdown={briefing.markdown}
      trailId={briefing.trailId}
      onClose={close}
    />
  );
}
