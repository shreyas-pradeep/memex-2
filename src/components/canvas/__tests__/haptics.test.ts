import { describe, expect, it, vi } from "vitest";
import { TARGET_HAPTIC_MS, tryVibrate } from "../haptics";

describe("tryVibrate", () => {
  it("vibrates once for 8 ms when supported and motion is allowed", () => {
    const vibrate = vi.fn(() => true);
    expect(TARGET_HAPTIC_MS).toBe(8);
    expect(tryVibrate({ vibrate }, { reducedMotion: false })).toBe(true);
    expect(vibrate).toHaveBeenCalledTimes(1);
    expect(vibrate).toHaveBeenCalledWith(8);
  });

  it("does nothing under reduced motion", () => {
    const vibrate = vi.fn(() => true);
    expect(tryVibrate({ vibrate }, { reducedMotion: true })).toBe(false);
    expect(vibrate).not.toHaveBeenCalled();
  });

  it("is a no-op without a host or without navigator.vibrate", () => {
    expect(tryVibrate(undefined, { reducedMotion: false })).toBe(false);
    expect(tryVibrate({}, { reducedMotion: false })).toBe(false);
  });

  it("swallows a throwing vibrate and a refusing one", () => {
    const throws = () => {
      throw new Error("blocked before a user gesture");
    };
    expect(tryVibrate({ vibrate: throws }, { reducedMotion: false })).toBe(false);
    expect(tryVibrate({ vibrate: () => false }, { reducedMotion: false })).toBe(false);
  });

  it("calls vibrate as a method of its host", () => {
    const host = {
      calls: 0,
      vibrate(this: { calls: number }) {
        this.calls++;
        return true;
      },
    };
    expect(tryVibrate(host, { reducedMotion: false })).toBe(true);
    expect(host.calls).toBe(1);
  });
});
