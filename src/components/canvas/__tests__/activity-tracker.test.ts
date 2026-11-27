import { describe, expect, it } from "vitest";
import { IDLE_THRESHOLD_MS } from "@/core/sprocket-engine";
import {
  ACTIVITY_EVENTS,
  IDLE_CHECK_MS,
  createActivityTracker,
  type TrackerEnv,
} from "../activity-tracker";

/** A fake window with a manual clock and interval, so no real timers or DOM are needed. */
function fakeEnv() {
  const target = new EventTarget();
  let now = 1_000_000;
  let tick: (() => void) | null = null;
  let adds = 0;
  let removes = 0;
  const env: TrackerEnv = {
    target: {
      addEventListener: (type, cb, options) => {
        adds++;
        target.addEventListener(type, cb, options);
      },
      removeEventListener: (type, cb, options) => {
        removes++;
        target.removeEventListener(type, cb, options);
      },
    },
    now: () => now,
    setInterval: (fn) => {
      tick = fn;
      return 1;
    },
    clearInterval: () => {
      tick = null;
    },
  };
  return {
    env,
    fire: (type: string) => target.dispatchEvent(new Event(type)),
    advance: (ms: number) => {
      now += ms;
      tick?.();
    },
    counts: () => ({ adds, removes, ticking: tick !== null }),
  };
}

describe("shared activity tracker", () => {
  it("installs one set of listeners for any number of subscribers and removes them with the last", () => {
    const f = fakeEnv();
    const tracker = createActivityTracker(f.env);
    expect(tracker.listenerCount()).toBe(0);
    const offA = tracker.subscribeIdle(() => undefined);
    const offB = tracker.subscribeIdle(() => undefined);
    const offC = tracker.subscribeActivity(() => undefined);
    expect(f.counts().adds).toBe(ACTIVITY_EVENTS.length);
    expect(tracker.listenerCount()).toBe(ACTIVITY_EVENTS.length);
    offA();
    offB();
    expect(f.counts().removes).toBe(0);
    offC();
    expect(f.counts().removes).toBe(ACTIVITY_EVENTS.length);
    expect(f.counts().ticking).toBe(false);
    expect(tracker.listenerCount()).toBe(0);
  });

  it("flips idle only after the threshold and clears it at once on activity", () => {
    const f = fakeEnv();
    const tracker = createActivityTracker(f.env);
    let flips = 0;
    const off = tracker.subscribeIdle(() => flips++);
    f.advance(IDLE_THRESHOLD_MS);
    expect(tracker.getIdle()).toBe(false);
    f.advance(IDLE_CHECK_MS);
    expect(tracker.getIdle()).toBe(true);
    expect(flips).toBe(1);
    f.advance(IDLE_CHECK_MS);
    expect(flips).toBe(1);
    f.fire("pointermove");
    expect(tracker.getIdle()).toBe(false);
    expect(flips).toBe(2);
    off();
  });

  it("delivers deliberate input to activity subscribers but not pointer moves", () => {
    const f = fakeEnv();
    const tracker = createActivityTracker(f.env);
    const seen: string[] = [];
    const off = tracker.subscribeActivity((e) => seen.push(e.type));
    f.fire("pointermove");
    f.fire("pointerdown");
    f.fire("keydown");
    f.fire("wheel");
    f.fire("touchstart");
    expect(seen).toEqual(["pointerdown", "keydown", "wheel", "touchstart"]);
    off();
    f.fire("keydown");
    expect(seen).toHaveLength(4);
  });
});
