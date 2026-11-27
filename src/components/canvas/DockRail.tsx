"use client";

import { memo } from "react";
import type { DockTab } from "@/core/command-dock";
import {
  COMMAND_DOCK_ID,
  dockPanelId,
  spotlightRailCopy,
  synapseRailCopy,
  trailsRailCopy,
} from "@/core/dock-layout";
import {
  selectDockOpen,
  selectDockTab,
  selectTrailTotal,
  selectUnreviewedDiscoveries,
} from "@/store/dock-selectors";
import { useMemexStore, type MemexStore } from "@/store/useMemexStore";

/** Id of the expand / collapse button, the fallback for returning focus. */
export const DOCK_RAIL_TOGGLE_ID = "command-dock-rail-toggle";

const selectToggleTab = (s: MemexStore) => s.toggleDockTab;
const selectExpand = (s: MemexStore) => s.expandDock;
const selectCollapse = (s: MemexStore) => s.collapseDock;

const RAIL_BUTTON =
  "relative flex h-11 w-9 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-xl border bg-[#141721] font-mono text-[10px] font-semibold leading-none shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_2px_0_rgba(0,0,0,0.65)] transition-[color,border-color,transform] duration-100 active:translate-y-[2px] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[#FFB236]";

interface RailTabButtonProps {
  tab: DockTab;
  icon: string;
  badge: string;
  label: string;
  active: boolean;
  open: boolean;
  shortcut?: string;
  accent: string;
  pulse?: boolean;
}

function RailTabButton({ tab, icon, badge, label, active, open, shortcut, accent, pulse = false }: RailTabButtonProps) {
  const toggle = useMemexStore(selectToggleTab);
  return (
    <button
      type="button"
      onClick={() => toggle(tab)}
      aria-label={label}
      title={label}
      aria-expanded={active}
      aria-controls={open ? dockPanelId(tab) : undefined}
      aria-keyshortcuts={shortcut}
      data-rail-tab={tab}
      className={RAIL_BUTTON}
      style={{
        color: accent,
        borderColor: active ? accent : "rgba(255, 178, 54, 0.2)",
      }}
    >
      <span aria-hidden="true" className="text-[15px] leading-none">
        {icon}
      </span>
      {badge !== "" ? (
        <span aria-hidden="true" className="text-text-muted">
          {badge}
        </span>
      ) : null}
      {pulse ? (
        <span
          aria-hidden="true"
          data-rail-pulse
          className="memex-rail-pulse absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full"
          style={{ background: accent, boxShadow: `0 0 6px 1px ${accent}` }}
        />
      ) : null}
    </button>
  );
}

/**
 * The slim brass rail on the right edge: always on screen, so the dock is one
 * click away. Four buttons: Trails (with the trail count), Synapse (with the
 * discovery count and an opacity pulse while discoveries wait), Spotlight, and
 * the expand / collapse toggle. Every count is a primitive selector, so a card
 * drag never re-renders it.
 */
export const DockRail = memo(function DockRail() {
  const open = useMemexStore(selectDockOpen);
  const tab = useMemexStore(selectDockTab);
  const trailCount = useMemexStore(selectTrailTotal);
  const discoveries = useMemexStore(selectUnreviewedDiscoveries);
  const expand = useMemexStore(selectExpand);
  const collapse = useMemexStore(selectCollapse);

  const trails = trailsRailCopy(trailCount, open && tab === "trails");
  const synapse = synapseRailCopy(discoveries, open && tab === "synapse");
  const spotlight = spotlightRailCopy(open && tab === "spotlight");

  return (
    <div
      role="group"
      aria-label="Command dock shortcuts"
      data-dock-rail
      className="flex h-full w-12 shrink-0 flex-col items-center gap-2 border-l bg-[#090A0F] py-3"
      style={{
        borderColor: "rgba(255, 178, 54, 0.2)",
        boxShadow: "inset 1px 0 0 rgba(255,255,255,0.05), -8px 0 24px rgba(0,0,0,0.55)",
      }}
    >
      <button
        id={DOCK_RAIL_TOGGLE_ID}
        type="button"
        onClick={open ? collapse : expand}
        aria-label={open ? "Collapse the command dock (Esc)" : "Expand the command dock"}
        title={open ? "Collapse (Esc)" : "Expand the dock"}
        aria-expanded={open}
        aria-controls={COMMAND_DOCK_ID}
        className={`${RAIL_BUTTON} text-[#8E94A5] hover:text-[#F4F1EA]`}
        style={{ borderColor: "rgba(255, 178, 54, 0.2)" }}
      >
        <span aria-hidden="true" className="text-[14px] leading-none">
          {open ? "▶" : "◀"}
        </span>
      </button>
      <span aria-hidden="true" className="h-px w-6 bg-white/10" />
      <RailTabButton
        tab="trails"
        icon="📜"
        badge={trails.badge}
        label={trails.label}
        active={open && tab === "trails"}
        open={open}
        shortcut="T"
        accent="#FFB236"
      />
      <RailTabButton
        tab="synapse"
        icon="⚡"
        badge={synapse.badge}
        label={synapse.label}
        active={open && tab === "synapse"}
        open={open}
        accent="#B388FF"
        pulse={discoveries > 0}
      />
      <RailTabButton
        tab="spotlight"
        icon="🔍"
        badge={spotlight.badge}
        label={spotlight.label}
        active={open && tab === "spotlight"}
        open={open}
        shortcut="/"
        accent="#FFB236"
      />
    </div>
  );
});
