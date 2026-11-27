"use client";

import { Panel } from "@xyflow/react";
import { CURATOR_DRAWER_ID, CURATOR_TRIGGER_ID } from "@/core/curators-index";
import { selectCuratorTrailCount, selectIsCuratorOpen } from "@/store/curator-selectors";
import { useMemexStore, type MemexStore } from "@/store/useMemexStore";

const selectToggle = (s: MemexStore) => s.toggleCuratorDrawer;

/**
 * Top-center button that opens the Curator's Index. Replaces the old Trails
 * dropdown. Subscribes to two primitives (the trail count and the open flag),
 * so a card drag never re-renders it.
 */
export function CuratorsIndexTrigger() {
  const count = useMemexStore(selectCuratorTrailCount);
  const open = useMemexStore(selectIsCuratorOpen);
  const toggle = useMemexStore(selectToggle);
  return (
    <Panel position="top-center" className="!m-4">
      <button
        id={CURATOR_TRIGGER_ID}
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={CURATOR_DRAWER_ID}
        aria-haspopup="dialog"
        aria-keyshortcuts="T"
        aria-label={`Trails & Reels (${count}): ${open ? "close" : "open"} the Curator's Index`}
        title="The Curator's Index (T)"
        className="flex cursor-pointer items-center gap-2 rounded-xl border border-[#FFB236]/50 bg-gradient-to-b from-[#141721] to-[#090A0F] px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-[#FFB236] shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_2px_0_rgba(0,0,0,0.65),0_6px_14px_rgba(0,0,0,0.4)] transition-[color,border-color,box-shadow,transform] duration-100 hover:border-[#FFB236] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_2px_0_rgba(0,0,0,0.65),0_0_16px_rgba(255,178,54,0.3)] active:translate-y-[2px] active:shadow-[inset_0_2px_6px_rgba(0,0,0,0.7)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[#FFB236]"
        style={open ? { borderColor: "#FFB236" } : undefined}
      >
        <span aria-hidden="true">[📜 TRAILS &amp; REELS ({count})]</span>
        <kbd
          aria-hidden="true"
          className="rounded border border-[#FFB236]/40 px-1 text-[10px] font-semibold text-text-muted"
        >
          [T]
        </kbd>
      </button>
    </Panel>
  );
}
