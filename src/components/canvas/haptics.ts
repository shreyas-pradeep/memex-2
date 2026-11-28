/**
 * Tiny haptic tick for the magnetic target (Spec 09). Kept free of React so it
 * can be tested with a fake `navigator`.
 */

/** Length of the tick when a card becomes the magnetic target (ms). */
export const TARGET_HAPTIC_MS = 8;

/** The part of `navigator` this module uses; `vibrate` is missing on desktop browsers and iOS. */
export interface VibrationHost {
  vibrate?: (pattern: number) => boolean;
}

/**
 * Vibrates once for `ms` when the host supports it and `reducedMotion` is off.
 * Never throws (some browsers throw before the first user gesture). Returns
 * whether a vibration was requested.
 */
export function tryVibrate(
  host: VibrationHost | undefined,
  options: { reducedMotion: boolean; ms?: number },
): boolean {
  if (options.reducedMotion || host === undefined) return false;
  try {
    return host.vibrate?.(options.ms ?? TARGET_HAPTIC_MS) === true;
  } catch {
    return false;
  }
}

/** `tryVibrate` against the real `navigator` (no-op on the server). */
export function vibrateTargetTick(reducedMotion: boolean): boolean {
  return tryVibrate(typeof navigator === "undefined" ? undefined : navigator, { reducedMotion });
}
