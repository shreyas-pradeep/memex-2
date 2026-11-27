"use client";

import { useEffect, type RefObject } from "react";
import { toDockKeyEvent } from "@/core/dock-layout";
import { useMemexStore } from "@/store/useMemexStore";
import { isEditableTarget, isInsideElement, isModalDialogOpen } from "../trails/key-context";

/**
 * One window `keydown` listener in the capture phase for the command dock:
 * `T` toggles Trails, `/` opens Spotlight and asks for focus, `Esc` collapses.
 * The pure rules (`resolveDockKey`, run by the store's `dispatchDockKey`) decide
 * whether the key means anything; this hook only reads the DOM facts (typing
 * target, inside the dock, a modal open) and applies the returned
 * `preventDefault` / `stopPropagation`.
 *
 * Stopping Escape at the window's capture phase keeps it from reaching the
 * bubble-phase listeners (trail playback exit, the weave cancel), so Escape
 * collapses the dock and nothing else. A modal keeps its own Escape (the rules
 * ignore it while one is open). Removed on unmount.
 */
export function useDockKeyboard(dockRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const event = toDockKeyEvent(e, {
        targetIsEditable: isEditableTarget(e.target),
        targetInsideDock: isInsideElement(dockRef.current, e.target),
        modalOpen: isModalDialogOpen(),
      });
      const result = useMemexStore.getState().dispatchDockKey(event);
      if (!result.handled) return;
      if (result.preventDefault) e.preventDefault();
      if (result.stopPropagation) e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dockRef]);
}
