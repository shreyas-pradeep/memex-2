/**
 * Pure logic for Sprocket 2.0 (Spec 07): squash and stretch constants, eye
 * tracking geometry, the emotive state machine, the weaving show plan, spark
 * bursts and the weave trigger rules.
 *
 * No React, no clock, no randomness: every function returns the same output
 * for the same input, so `fast-check` can test it directly.
 */

import {
  SPROCKET_SCURRY_MS,
  getTraversalPoint,
  sane,
  type Point,
  type Rect,
  type WireDirection,
} from "./sprocket-engine";

// ---------------------------------------------------------------------------
// Squash and stretch
// ---------------------------------------------------------------------------

/**
 * Squash-and-stretch keyframes. Scales are applied to the sprite wrapper with
 * `transform-origin: 50% 100%` (the feet), so the body deforms around its
 * contact point with the card.
 *
 * - `anticipation`: wind-up before each move (squat and widen) for 150 ms.
 * - `flight`: elongation while travelling (tall and thin).
 * - `landing`: impact squash that rebounds to 1.0 on `spring`. Only `scaleY`
 *   (0.75) is fixed by the spec; `scaleX` widens a little to keep the volume.
 */
export const SPROCKET_PHYSICS = {
  rest: { scaleX: 1, scaleY: 1 },
  anticipation: { scaleX: 1.25, scaleY: 0.7, durationMs: 150 },
  flight: { scaleX: 0.8, scaleY: 1.35 },
  landing: {
    scaleX: 1.2,
    scaleY: 0.75,
    spring: { type: "spring", stiffness: 450, damping: 18 },
  },
} as const;

/** Time spent in flight when a move takes `totalMs` in all: the wind-up comes out of the total. */
export function flightMsFor(totalMs: number): number {
  const total = Number.isFinite(totalMs) ? Math.max(0, totalMs) : 0;
  return Math.max(0, total - SPROCKET_PHYSICS.anticipation.durationMs);
}

/**
 * A trail-follow move (hop, wire, hop) takes `SPROCKET_SCURRY_MS` (800 ms, the
 * camera glide) including the 150 ms wind-up, so Sprocket lands as the camera
 * arrives.
 */
export const SCURRY_FLIGHT_MS = flightMsFor(SPROCKET_SCURRY_MS);

/** One weaving leg: 150 ms wind-up, 600 ms flight. The landing rebound plays during the dwell. */
export const WEAVE_LEG_FLIGHT_MS = 600;
/** Pause on each card while the landing squash rebounds. */
export const WEAVE_DWELL_MS = 120;
/** Per-card pause under reduced motion, long enough to read the progress. */
export const WEAVE_REDUCED_STEP_MS = 350;
/** Time for the celebratory 360 degree turn and the spark burst. */
export const CELEBRATE_MS = 700;
/** How long the filament takes to fade out once the weave has finished. */
export const FILAMENT_FADE_MS = 900;
/** Samples per leg when the filament and its arc length are planned. */
export const WEAVE_SAMPLES = 40;
/** The idle weave prompt hides itself after this long. */
export const WEAVE_PROMPT_MS = 12000;
/** How long the weaving result bubble stays. */
export const WEAVE_BUBBLE_MS = 5000;

// ---------------------------------------------------------------------------
// Eye tracking and the happy state
// ---------------------------------------------------------------------------

/** Largest pupil offset, in screen pixels (`pupilOffset` clamps to it). */
export const PUPIL_MAX_RADIUS = 6;
/**
 * The pupil may travel at most this far inside the 24-unit sprite: the socket
 * radius (3.6) minus the pupil radius (2.1). The 6 px screen offset is scaled
 * into this range so the glowing pupil never leaves its socket.
 */
export const PUPIL_TRAVEL_UNITS = 1.5;
/** The cursor counts as near the sprite within this many screen pixels. */
export const CURSOR_NEAR_PX = 60;
/** Extra distance before "happy" ends again, so it does not flicker at the edge. */
export const CURSOR_NEAR_HYSTERESIS_PX = 8;

/** The happy wag: a small rotate and shift oscillation. */
export const WAG = { rotateDeg: 6, shiftX: 0.8, periodMs: 520 } as const;

const ZERO: Point = { x: 0, y: 0 };

function finitePoint(p: Point): boolean {
  return !Number.isNaN(p.x) && !Number.isNaN(p.y);
}

/**
 * Where the pupil sits relative to the eye's resting position: toward the
 * pointer, by the pointer's distance, capped at `maxRadius`.
 *
 * Total: a NaN coordinate, a non-finite or non-positive `maxRadius`, or a
 * pointer exactly on the center gives `{ x: 0, y: 0 }`; infinite coordinates
 * count as `+-1e12`, which keeps the direction. Never throws and always returns
 * finite numbers with a magnitude of at most `maxRadius`.
 */
export function pupilOffset(spriteCenter: Point, pointer: Point, maxRadius: number): Point {
  if (!finitePoint(spriteCenter) || !finitePoint(pointer)) return { ...ZERO };
  if (typeof maxRadius !== "number" || !Number.isFinite(maxRadius) || maxRadius <= 0) {
    return { ...ZERO };
  }
  const dx = sane(pointer.x) - sane(spriteCenter.x);
  const dy = sane(pointer.y) - sane(spriteCenter.y);
  const distance = Math.hypot(dx, dy);
  if (!(distance > 0)) return { ...ZERO };
  const length = Math.min(maxRadius, distance);
  return { x: (dx / distance) * length, y: (dy / distance) * length };
}

/** Euclidean distance between two points; NaN input gives `Infinity` (never near). */
export function pointDistance(a: Point, b: Point): number {
  if (!finitePoint(a) || !finitePoint(b)) return Number.POSITIVE_INFINITY;
  return Math.hypot(sane(a.x) - sane(b.x), sane(a.y) - sane(b.y));
}

/**
 * True when `distance` (screen px) is within `threshold` (default 60). NaN,
 * negative and infinite distances are not near, and neither is a threshold that
 * is not a finite non-negative number.
 */
export function isCursorNear(distance: number, threshold: number = CURSOR_NEAR_PX): boolean {
  if (typeof distance !== "number" || typeof threshold !== "number") return false;
  if (!Number.isFinite(distance) || !Number.isFinite(threshold)) return false;
  return distance >= 0 && threshold >= 0 && distance <= threshold;
}

/** The pupil offset in sprite units: the 6 px screen offset mapped into the socket. */
export function pupilToSprite(offset: Point): Point {
  const k = PUPIL_TRAVEL_UNITS / PUPIL_MAX_RADIUS;
  return { x: offset.x * k, y: offset.y * k };
}

// ---------------------------------------------------------------------------
// Emotive state machine
// ---------------------------------------------------------------------------

export type SprocketState =
  | "idle"
  | "anticipating"
  | "travelling"
  | "landing"
  | "inspecting"
  | "weaving"
  | "celebrating";

export const SPROCKET_STATES: readonly SprocketState[] = [
  "idle",
  "anticipating",
  "travelling",
  "landing",
  "inspecting",
  "weaving",
  "celebrating",
];

export type SprocketEvent =
  | "MOVE"
  | "LIFTOFF"
  | "TOUCHDOWN"
  | "INSPECT"
  | "SETTLE"
  | "WEAVE"
  | "CELEBRATE"
  | "INTERRUPT"
  | "HAPPY_ON"
  | "HAPPY_OFF";

export const SPROCKET_EVENTS: readonly SprocketEvent[] = [
  "MOVE",
  "LIFTOFF",
  "TOUCHDOWN",
  "INSPECT",
  "SETTLE",
  "WEAVE",
  "CELEBRATE",
  "INTERRUPT",
  "HAPPY_ON",
  "HAPPY_OFF",
];

/** The lifecycle state plus the orthogonal "happy" overlay (cursor near). */
export interface SprocketMachine {
  readonly state: SprocketState;
  readonly happy: boolean;
}

export const INITIAL_SPROCKET_MACHINE: SprocketMachine = Object.freeze({
  state: "idle",
  happy: false,
});

/**
 * Lifecycle transitions, event by event. `INTERRUPT` (any state to idle) and
 * the happy overlay events are handled by `reduceSprocket` for every state.
 *
 * ```
 * idle -MOVE-> anticipating -LIFTOFF-> travelling -TOUCHDOWN-> landing -SETTLE-> idle
 *                                                                landing -INSPECT-> inspecting
 * inspecting -MOVE-> anticipating        inspecting -SETTLE-> idle
 * idle -WEAVE-> weaving -CELEBRATE-> celebrating -SETTLE-> idle
 * ```
 */
export const SPROCKET_TRANSITIONS: Readonly<
  Record<SprocketState, Readonly<Partial<Record<SprocketEvent, SprocketState>>>>
> = {
  idle: { MOVE: "anticipating", WEAVE: "weaving" },
  anticipating: { LIFTOFF: "travelling" },
  travelling: { TOUCHDOWN: "landing" },
  landing: { SETTLE: "idle", INSPECT: "inspecting" },
  inspecting: { MOVE: "anticipating", SETTLE: "idle" },
  weaving: { CELEBRATE: "celebrating" },
  celebrating: { SETTLE: "idle" },
};

/**
 * Next machine for an event. An illegal transition is ignored: the same object
 * comes back, so `next === machine` tells the caller nothing happened.
 * `INTERRUPT` returns to `idle` from any state; `HAPPY_ON` and `HAPPY_OFF` set
 * the overlay in every state and leave the lifecycle state alone.
 */
export function reduceSprocket(machine: SprocketMachine, event: SprocketEvent): SprocketMachine {
  if (event === "HAPPY_ON") return machine.happy ? machine : { ...machine, happy: true };
  if (event === "HAPPY_OFF") return machine.happy ? { ...machine, happy: false } : machine;
  if (event === "INTERRUPT") {
    return machine.state === "idle" ? machine : { ...machine, state: "idle" };
  }
  const next = SPROCKET_TRANSITIONS[machine.state][event];
  return next === undefined ? machine : { ...machine, state: next };
}

/** True for the states in which the body is in motion (the legs rock). */
export function isTravellingState(state: SprocketState): boolean {
  return state === "travelling" || state === "weaving";
}

// ---------------------------------------------------------------------------
// Weaving show
// ---------------------------------------------------------------------------

/** One leg of the weave: the exact path Sprocket walks between two consecutive stops. */
export interface WeaveLeg {
  fromId: string;
  toId: string;
  direction: WireDirection;
  /** `WEAVE_SAMPLES + 1` points of `getTraversalPoint`, at equal progress steps. */
  points: Point[];
  /** Arc length fraction at each point: starts at 0, ends at 1, never decreases. */
  arc: number[];
}

/**
 * Plans one leg by sampling `getTraversalPoint`, the same curve Sprocket
 * follows (hop, wire in the stored direction, hop). `direction` says whether a
 * stored edge runs forward, reverse or not at all (then the would-be curve).
 */
export function planWeaveLeg(
  fromId: string,
  toId: string,
  from: Rect,
  to: Rect,
  direction: WireDirection,
  samples: number = WEAVE_SAMPLES,
): WeaveLeg {
  const n = Math.max(2, Math.floor(Number.isFinite(samples) ? samples : WEAVE_SAMPLES));
  const points: Point[] = [];
  for (let i = 0; i <= n; i++) points.push(getTraversalPoint(from, to, i / n, direction));
  const cumulative: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    cumulative.push(
      cumulative[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y),
    );
  }
  const total = cumulative[cumulative.length - 1];
  const arc = cumulative.map((c, i) => (total > 0 ? c / total : i / n));
  arc[arc.length - 1] = 1;
  return { fromId, toId, direction, points, arc };
}

/**
 * Fraction of the leg's path length that Sprocket has covered at `progress`
 * (clamped to `[0, 1]`, NaN is 0). Monotone, 0 at the start and 1 at the end.
 */
export function arcFractionAt(leg: WeaveLeg, progress: number): number {
  const p = typeof progress === "number" && !Number.isNaN(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  const n = leg.arc.length - 1;
  if (n <= 0) return p;
  const at = p * n;
  const lo = Math.min(n - 1, Math.floor(at));
  const t = at - lo;
  return leg.arc[lo] + (leg.arc[lo + 1] - leg.arc[lo]) * t;
}

/**
 * Sprocket's position on a leg at `progress` (clamped to `[0, 1]`, NaN is 0):
 * linear between the planned samples, so it is exactly on the drawn filament.
 */
export function legPointAt(leg: WeaveLeg, progress: number): Point {
  const last = leg.points.length - 1;
  if (last < 0) return { x: 0, y: 0 };
  const p = typeof progress === "number" && !Number.isNaN(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  const at = p * last;
  const lo = Math.min(Math.max(0, last - 1), Math.floor(at));
  const a = leg.points[lo];
  const b = leg.points[Math.min(last, lo + 1)];
  const t = at - lo;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** SVG path data for a polyline, with two decimals. Empty for fewer than two points. */
export function polylinePath(points: readonly Point[]): string {
  if (points.length < 2) return "";
  const f = (v: number) => (Math.round(v * 100) / 100).toString();
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${f(p.x)} ${f(p.y)}`).join(" ");
}

/**
 * Plans the whole weave over ordered stops. Stops without a rectangle are
 * skipped and a repeat of the previous stop makes no leg, so the result never
 * has a gap or a zero-length hop. `directionOf` tells which way a stored edge runs.
 */
export function planWeave(
  ids: readonly string[],
  rects: ReadonlyMap<string, Rect>,
  directionOf: (fromId: string, toId: string) => WireDirection,
): WeaveLeg[] {
  const stops = ids.filter((id, i) => rects.has(id) && ids[i - 1] !== id);
  const legs: WeaveLeg[] = [];
  for (let i = 0; i + 1 < stops.length; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    const from = rects.get(a) as Rect;
    const to = rects.get(b) as Rect;
    legs.push(planWeaveLeg(a, b, from, to, directionOf(a, b)));
  }
  return legs;
}

/** A compact signature of card rectangles; it changes when a card moves or is resized. */
export function rectsSignature(ids: readonly string[], rects: ReadonlyMap<string, Rect>): string {
  return ids
    .map((id) => {
      const r = rects.get(id);
      return r === undefined ? `${id}:-` : `${id}:${r.x},${r.y},${r.width},${r.height}`;
    })
    .join("|");
}

// ---------------------------------------------------------------------------
// Celebration sparks
// ---------------------------------------------------------------------------

export interface Spark {
  /** Direction of travel in degrees, 0 pointing right. */
  angleDeg: number;
  /** How far the spark flies (sprite units). */
  distance: number;
  /** Radius in sprite units. */
  radius: number;
  color: string;
  /** Start delay in seconds. */
  delay: number;
}

/** Brass spark colors. */
export const SPARK_COLORS: readonly string[] = ["#D97706", "#FFB236"];
export const SPARK_COUNT = 8;

/**
 * The celebration burst: `SPARK_COUNT` (8) sparks spread evenly around a
 * circle with alternating distances, colors and sizes. Fixed numbers, no random.
 */
export function sparkBurst(count: number = SPARK_COUNT): Spark[] {
  const n = Math.min(10, Math.max(6, Math.floor(Number.isFinite(count) ? count : SPARK_COUNT)));
  return Array.from({ length: n }, (_, i) => ({
    angleDeg: (360 / n) * i + (i % 2 === 0 ? 0 : 11),
    distance: i % 2 === 0 ? 26 : 19,
    radius: i % 3 === 0 ? 1.6 : 1.1,
    color: SPARK_COLORS[i % SPARK_COLORS.length],
    delay: (i % 4) * 0.025,
  }));
}

// ---------------------------------------------------------------------------
// Weave trigger rules and copy
// ---------------------------------------------------------------------------

/** Fewest cards for which the weave trigger appears. */
export const WEAVE_MIN_CARDS = 3;

export const WEAVE_BUTTON_LABEL = "🧶 AUTO-WEAVE TRAIL";
export const WEAVE_PROMPT_TEXT = "I see a trail through these papers! Tap me to weave it.";
export const WEAVE_CANCELLED_TEXT = "Weave halted. Any trail already forged stays in [📜 TRAILS & REELS].";
/** Screen-reader progress line while weaving: `stop` is the 1-based stop Sprocket has reached. */
export function weaveProgressText(title: string, stop: number, total: number): string {
  const t = Number.isFinite(total) ? Math.max(1, Math.floor(total)) : 1;
  const n = Number.isFinite(stop) ? Math.min(t, Math.max(1, Math.floor(stop))) : 1;
  return `Weaving ${title.trim() === "" ? "trail" : title.trim()}: stop ${n} of ${t}.`;
}
export const WEAVE_ABORTED_TEXT = "The cards moved under my feet. Weave stopped, Professor.";

/** Speech bubble shown when a weave completes. Built only from the trail itself. */
export function weaveDoneText(title: string, stops: number): string {
  const count = Number.isFinite(stops) ? Math.max(0, Math.floor(stops)) : 0;
  const name = title.trim() === "" ? "Untitled Trail" : title.trim();
  return `Woven: ${name}, ${count} ${count === 1 ? "stop" : "stops"}. The 1945 Lever is yours, Professor.`;
}

export interface WeaveGateInput {
  cardCount: number;
  /** A trail is open in the playback dock. */
  activeTrailId: string | null;
  isWeaving: boolean;
}

/** The trigger is usable: enough cards, no trail playing and no weave running. */
export function canStartWeave(input: WeaveGateInput): boolean {
  return (
    Number.isFinite(input.cardCount) &&
    input.cardCount >= WEAVE_MIN_CARDS &&
    input.activeTrailId === null &&
    !input.isWeaving
  );
}

export interface WeavePromptInput extends WeaveGateInput {
  /** The user has been idle for longer than `IDLE_THRESHOLD_MS`. */
  idle: boolean;
  /** The prompt already showed in this idle period. */
  shownThisPeriod: boolean;
  /** `generateAutoTrails` found at least one trail, so the offer is true. */
  trailAvailable: boolean;
}

/** Whether Sprocket offers to weave: idle, gate open, a trail exists and not offered yet. */
export function shouldShowWeavePrompt(input: WeavePromptInput): boolean {
  return input.idle && !input.shownThisPeriod && input.trailAvailable && canStartWeave(input);
}
