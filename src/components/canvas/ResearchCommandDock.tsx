"use client";

import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { DOCK_TABS, type DockTab } from "@/core/command-dock";
import {
  COMMAND_DOCK_ID,
  DOCK_PANEL_WIDTH,
  DOCK_TAB_LABELS,
  dockPanelId,
  dockTabId,
  nextDockTab,
} from "@/core/dock-layout";
import { selectDockOpen, selectDockTab } from "@/store/dock-selectors";
import { useMemexStore, type MemexStore } from "@/store/useMemexStore";
import { DOCK_RAIL_TOGGLE_ID, DockRail } from "./DockRail";
import { SpotlightPanel } from "./SpotlightPanel";
import { SynapsePanel } from "./SynapsePanel";
import { TrailsPanel } from "./TrailsPanel";
import { useDockKeyboard } from "./use-dock-keyboard";

const SPRING = { type: "spring", stiffness: 300, damping: 28 } as const;
/** Reduced motion: no slide, a short fade. */
const FADE = { duration: 0.15, ease: "linear" } as const;

const BORDER = "rgba(255, 178, 54, 0.2)";
const TAB_ACCENT: Record<DockTab, string> = { trails: "#FFB236", synapse: "#B388FF", spotlight: "#FFB236" };

const selectOpenTab = (s: MemexStore) => s.openDockTab;

/** Marks the sliding panel, so focus tracking can tell it from the rail. */
const PANEL_ATTR = "data-dock-panel";

function DockTabList({ tab }: { tab: DockTab }) {
  const openTab = useMemexStore(selectOpenTab);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const next = nextDockTab(tab, e.key);
    if (next === null) return;
    e.preventDefault();
    openTab(next);
    // Automatic activation: move focus with the selection (roving tabindex).
    requestAnimationFrame(() => document.getElementById(dockTabId(next))?.focus({ preventScroll: true }));
  };

  return (
    <div
      role="tablist"
      aria-label="Command dock sections"
      aria-orientation="horizontal"
      onKeyDown={onKeyDown}
      className="flex shrink-0 gap-1 border-b px-3 pt-3"
      style={{ borderColor: BORDER }}
    >
      {DOCK_TABS.map((t) => {
        const selected = t === tab;
        const accent = TAB_ACCENT[t];
        return (
          <button
            key={t}
            id={dockTabId(t)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={dockPanelId(t)}
            tabIndex={selected ? 0 : -1}
            onClick={() => openTab(t)}
            className="min-w-0 flex-1 cursor-pointer rounded-t-xl border border-b-0 px-1.5 py-2 font-mono text-[10px] font-semibold uppercase leading-tight tracking-[0.1em] transition-[color,border-color] duration-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-[-2px] focus-visible:outline-[#FFB236]"
            style={{
              color: selected ? accent : "#8E94A5",
              background: selected ? "#141721" : "transparent",
              borderColor: selected ? BORDER : "transparent",
              boxShadow: selected ? `inset 0 2px 0 ${accent}` : undefined,
            }}
          >
            {DOCK_TAB_LABELS[t]}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The Research Command Dock (Spec 09): one right-edge drawer with the tabs
 * Reels & Trails, Synapse Inspect and Spotlight & Filter, plus an always
 * visible rail. A non-modal `complementary` landmark: no focus trap, no
 * `aria-modal`, so the global shortcuts and the modals' own rules keep working.
 *
 * - Focus moves into the panel when it opens (the Spotlight search field takes
 *   it itself after `/`) and returns to the control that had it before when it
 *   collapses, else to the rail's toggle.
 * - Collapsing from the Synapse tab clears the inspected selection, as closing
 *   the old inspector did.
 * - Only `transform` and `opacity` animate; reduced motion fades in 150 ms.
 * - It subscribes to the open flag and the tab only (primitives), so a card
 *   drag never re-renders it.
 */
export function ResearchCommandDock() {
  const open = useMemexStore(selectDockOpen);
  const tab = useMemexStore(selectDockTab);
  const reduce = useReducedMotion() === true;
  const dockRef = useRef<HTMLElement | null>(null);
  const lastOutsideFocus = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);

  useDockKeyboard(dockRef);

  // Remember the last focused element outside the sliding panel: the invoker to return to.
  useEffect(() => {
    const inPanel = (target: EventTarget | null) =>
      target instanceof Element && target.closest(`[${PANEL_ATTR}]`) !== null;
    const onFocusIn = (e: FocusEvent) => {
      if (!inPanel(e.target) && e.target instanceof HTMLElement && e.target !== document.body) {
        lastOutsideFocus.current = e.target;
      }
    };
    const onFocusOut = (e: FocusEvent) => {
      if (e.relatedTarget === null && !inPanel(e.target)) lastOutsideFocus.current = null;
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, []);

  useEffect(() => {
    const dock = dockRef.current;
    if (open && !wasOpen.current) {
      wasOpen.current = true;
      // A child may already have focus (the search field after `/`); otherwise land on the active tab.
      const panel = dock?.querySelector(`[${PANEL_ATTR}]`);
      if (panel !== null && panel !== undefined && !panel.contains(document.activeElement)) {
        document.getElementById(dockTabId(useMemexStore.getState().commandDock.tab))?.focus({ preventScroll: true });
      }
      return;
    }
    if (!open && wasOpen.current) {
      wasOpen.current = false;
      const active = document.activeElement;
      const focusWasInPanel =
        active instanceof Element && active.closest(`[${PANEL_ATTR}]`) !== null;
      if (focusWasInPanel) {
        const back = lastOutsideFocus.current;
        const target = back !== null && back.isConnected ? back : document.getElementById(DOCK_RAIL_TOGGLE_ID);
        target?.focus({ preventScroll: true });
      }
      // Closing the inspector tab clears what it was showing.
      const s = useMemexStore.getState();
      if (s.commandDock.tab === "synapse") {
        s.selectGhostDiscovery(null);
        s.inspectEdge(null);
      }
    }
  }, [open]);

  // Backspace and Delete delete the selected cards (React Flow listens on the document).
  // Keep them away from the buttons in here; text fields are already ignored.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key === "Backspace" || e.key === "Delete") e.stopPropagation();
  };

  return (
    <aside
      ref={dockRef}
      id={COMMAND_DOCK_ID}
      role="complementary"
      aria-label="Research command dock"
      data-dock-open={open}
      onKeyDown={onKeyDown}
      className="pointer-events-none absolute top-0 right-0 bottom-0 z-40 flex"
    >
      <AnimatePresence>
        {open ? (
          <motion.div
            key="dock-panel"
            data-dock-panel=""
            initial={reduce ? { opacity: 0 } : { x: "100%" }}
            animate={reduce ? { opacity: 1 } : { x: 0 }}
            exit={reduce ? { opacity: 0 } : { x: "100%" }}
            transition={reduce ? FADE : SPRING}
            className="pointer-events-auto flex h-full flex-col bg-[#090A0F]"
            style={{
              width: `min(${DOCK_PANEL_WIDTH}px, 90vw)`,
              borderLeft: `1px solid ${BORDER}`,
              boxShadow: "inset 1px 0 0 rgba(255,255,255,0.05), -16px 0 48px rgba(0,0,0,0.65)",
            }}
          >
            <DockTabList tab={tab} />
            {DOCK_TABS.map((t) => (
              <div
                key={t}
                id={dockPanelId(t)}
                role="tabpanel"
                aria-labelledby={dockTabId(t)}
                hidden={t !== tab}
                className={t === tab ? "flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4" : "hidden"}
              >
                {t === tab ? <TabContent tab={t} /> : null}
              </div>
            ))}
          </motion.div>
        ) : null}
      </AnimatePresence>
      <div className="pointer-events-auto relative z-10 h-full">
        <DockRail />
      </div>
    </aside>
  );
}

function TabContent({ tab }: { tab: DockTab }) {
  switch (tab) {
    case "trails":
      return <TrailsPanel />;
    case "synapse":
      return <SynapsePanel />;
    case "spotlight":
      return <SpotlightPanel />;
  }
}
