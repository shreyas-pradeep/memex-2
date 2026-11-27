import { useSyncExternalStore } from "react";
import { isIdle } from "@/core/sprocket-engine";

/**
 * One shared set of window activity listeners for everything that needs to know
 * whether the user is idle (the Ghost Guidance Beacon and Sprocket's weave
 * prompt). Listeners are passive and installed only while somebody subscribes;
 * they are removed with the last subscriber. State changes only when the idle
 * flag flips, so activity never re-renders anything by itself.
 */

/** Pointer, keyboard and scroll activity that counts as "the user is here". */
export const ACTIVITY_EVENTS = ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"] as const;
/** Ignore activity bursts closer together than this (ms) while the user is active. */
export const ACTIVITY_THROTTLE_MS = 250;
/** How often the idle clock is checked. */
export const IDLE_CHECK_MS = 1000;

export interface TrackerEnv {
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  now: () => number;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (id: unknown) => void;
}

export interface ActivityTracker {
  /** Calls `cb` whenever the idle flag flips. Returns the unsubscribe function. */
  subscribeIdle: (cb: () => void) => () => void;
  /**
   * Calls `cb` for every deliberate input event (everything but `pointermove`):
   * pointer press, key press, wheel and touch. Returns the unsubscribe function.
   */
  subscribeActivity: (cb: (event: Event) => void) => () => void;
  getIdle: () => boolean;
  /** Number of window listeners currently installed (0 when nobody subscribes). */
  listenerCount: () => number;
}

export function createActivityTracker(env: TrackerEnv): ActivityTracker {
  const idleSubs = new Set<() => void>();
  const activitySubs = new Set<(event: Event) => void>();
  let installed = false;
  let timer: unknown;
  let lastActivity = 0;
  let idle = false;
  const options: AddEventListenerOptions = { passive: true, capture: true };

  const setIdleFlag = (next: boolean) => {
    if (next === idle) return;
    idle = next;
    for (const cb of [...idleSubs]) cb();
  };

  const onActivity = (event: Event) => {
    if (event.type !== "pointermove") for (const cb of [...activitySubs]) cb(event);
    const now = env.now();
    if (!idle && now - lastActivity < ACTIVITY_THROTTLE_MS) return;
    lastActivity = now;
    setIdleFlag(false);
  };

  const install = () => {
    if (installed) return;
    installed = true;
    lastActivity = env.now();
    idle = false;
    timer = env.setInterval(() => setIdleFlag(isIdle(env.now() - lastActivity)), IDLE_CHECK_MS);
    // Capture phase: React Flow stops propagation of some pointer events.
    for (const type of ACTIVITY_EVENTS) env.target.addEventListener(type, onActivity, options);
  };

  const uninstall = () => {
    if (!installed || idleSubs.size + activitySubs.size > 0) return;
    installed = false;
    env.clearInterval(timer);
    for (const type of ACTIVITY_EVENTS) env.target.removeEventListener(type, onActivity, options);
  };

  return {
    subscribeIdle: (cb) => {
      idleSubs.add(cb);
      install();
      return () => {
        idleSubs.delete(cb);
        uninstall();
      };
    },
    subscribeActivity: (cb) => {
      activitySubs.add(cb);
      install();
      return () => {
        activitySubs.delete(cb);
        uninstall();
      };
    },
    getIdle: () => idle,
    listenerCount: () => (installed ? ACTIVITY_EVENTS.length : 0),
  };
}

let shared: ActivityTracker | null = null;

/** The window-level tracker. Created on first use in the browser. */
export function getSharedTracker(): ActivityTracker {
  if (shared === null) {
    shared = createActivityTracker({
      target: window,
      now: () => Date.now(),
      setInterval: (fn, ms) => window.setInterval(fn, ms),
      clearInterval: (id) => window.clearInterval(id as number),
    });
  }
  return shared;
}

const subscribeIdle = (cb: () => void) => getSharedTracker().subscribeIdle(cb);
const getIdleSnapshot = () => getSharedTracker().getIdle();
const getServerSnapshot = () => false;

/** True once the user has been inactive for more than `IDLE_THRESHOLD_MS`. */
export function useIdleFlag(): boolean {
  return useSyncExternalStore(subscribeIdle, getIdleSnapshot, getServerSnapshot);
}
