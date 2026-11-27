"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ViewportPortal, useReactFlow, useViewportStore, type ViewportStore } from "@xyflow/react";
import {
  AnimatePresence,
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
  type AnimationPlaybackControls,
  type MotionValue,
  type Variants,
} from "framer-motion";
import {
  GHOST_AFTERGLOW_MS,
  SPROCKET_ALERT_MS,
  SPROCKET_BUBBLE_MS,
  SPROCKET_INSPECT_MS,
  SPROCKET_SIZE,
  advanceQuipIndex,
  findWireDirection,
  getEdgeMidpoint,
  getPerchPosition,
  getTraversalPoint as travelPoint,
  pickInspectionTarget,
  resolveCardRect,
  selectSprocketQuip,
  type Point,
  type Rect,
} from "@/core/sprocket-engine";
import {
  CELEBRATE_MS,
  CURSOR_NEAR_HYSTERESIS_PX,
  CURSOR_NEAR_PX,
  FILAMENT_FADE_MS,
  INITIAL_SPROCKET_MACHINE,
  PUPIL_MAX_RADIUS,
  SCURRY_FLIGHT_MS,
  SPROCKET_PHYSICS,
  WAG,
  WEAVE_ABORTED_TEXT,
  WEAVE_BUBBLE_MS,
  WEAVE_BUTTON_LABEL,
  WEAVE_CANCELLED_TEXT,
  WEAVE_DWELL_MS,
  WEAVE_LEG_FLIGHT_MS,
  WEAVE_PROMPT_MS,
  WEAVE_PROMPT_TEXT,
  WEAVE_REDUCED_STEP_MS,
  arcFractionAt,
  isCursorNear,
  legPointAt,
  planWeave,
  pointDistance,
  polylinePath,
  pupilOffset,
  pupilToSprite,
  rectsSignature,
  reduceSprocket,
  shouldShowWeavePrompt,
  sparkBurst,
  weaveDoneText,
  weaveProgressText,
  type SprocketEvent,
  type SprocketMachine,
  type WeaveLeg,
} from "@/core/sprocket-motion";
import { chooseWeaveTrail, generateAutoTrails } from "@/core/trail-genesis";
import type { GhostDiscovery } from "@/core/types";
import { selectIsGhostScanning } from "@/store/ghost-selectors";
import { DEFAULT_CARD_SIZE, useMemexStore, type MemexStore } from "@/store/useMemexStore";
import { useSprocketSession } from "@/store/useSprocketSession";
import { showToast } from "@/store/useToastStore";
import { getSharedTracker, useIdleFlag } from "./activity-tracker";

const SPRING = { type: "spring", stiffness: 300, damping: 28 } as const;
/** The stretch eases in quickly at lift-off. */
const STRETCH_MS = 120;
const POINTER_OPTIONS: AddEventListenerOptions = { passive: true };

// Palette: obsidian, amber and phantom violet, plus the brass of the chassis.
const BRASS = "#D97706";
const BRASS_DARK = "#B45309";
const AMBER = "#FFB236";
const VIOLET = "#B388FF";
const OBSIDIAN = "#090A0F";
const SURFACE = "#141721";
const PARCHMENT = "#F4F1EA";

type SprocketMode = "perched" | "poised" | "scurrying" | "alert" | "inspecting" | "celebrating";
type WeaveResult = "completed" | "cancelled" | "aborted";

// ---------------------------------------------------------------------------
// Selectors (module scope, primitive results: the component re-renders only
// when one of these values changes, never on card drags or viewport frames)
// ---------------------------------------------------------------------------

const selectActiveTrailId = (s: MemexStore) => s.activeTrailId;
const selectActiveTrailIndex = (s: MemexStore) => s.activeTrailIndex;

/**
 * The card Sprocket sits on: the current trail stop while a trail plays,
 * otherwise the most recently added card. `null` when the canvas is empty.
 */
function selectPerchId(s: MemexStore): string | null {
  if (s.activeTrailId !== null) {
    const trail = s.trails.find((t) => t.id === s.activeTrailId);
    const id = trail?.nodeIds[s.activeTrailIndex];
    if (id !== undefined && s.nodes.some((n) => n.id === id)) return id;
  }
  const last = s.nodes[s.nodes.length - 1];
  return last === undefined ? null : last.id;
}

/**
 * Counter-scale so the crawler and its bubble stay legible when zoomed out.
 * Quantised to quarter zoom steps, so it changes only a handful of times over a
 * whole zoom gesture instead of on every viewport frame.
 */
function selectZoomScale(s: ViewportStore): number {
  const bucket = Math.max(0.25, Math.round(s.transform[2] * 4) / 4);
  return Math.min(3, Math.max(1, 1 / bucket));
}

function rectOf(id: string | null): Rect | null {
  if (id === null) return null;
  const node = useMemexStore.getState().nodes.find((n) => n.id === id);
  return node ? resolveCardRect(node, DEFAULT_CARD_SIZE) : null;
}

function perchOf(id: string | null): Point | null {
  const rect = rectOf(id);
  return rect ? getPerchPosition(rect) : null;
}

/** Linear interpolation that does not clamp, so a spring may overshoot slightly. */
function mix(a: Point, b: Point, k: number): Point {
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
}

/** Same node ids and nothing else: a card drag never changes this. */
function idsKey(s: MemexStore): string {
  return s.nodes.map((n) => n.id).join("|");
}

function rectMap(ids: readonly string[]): Map<string, Rect> {
  const map = new Map<string, Rect>();
  for (const id of ids) {
    const rect = rectOf(id);
    if (rect) map.set(id, rect);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Imperative choreography (no React state per frame: it writes motion values)
// ---------------------------------------------------------------------------

interface Activity {
  kind: "move" | "reaction" | "weave";
  /** Everything to undo when the activity stops: timers and running animations. */
  clears: Array<() => void>;
  discoveryId?: string;
  cardIds?: readonly string[];
}

/** One run of the weaving show, as the controller needs it. */
interface WeaveRun {
  legs: readonly WeaveLeg[];
  stopIds: readonly string[];
  signature: string;
  trailId: string;
  /** Filament reveal: leg index plus the fraction of that leg already drawn. */
  progress: MotionValue<number>;
  /** Sprocket has reached stop `n` (1-based). */
  onStop: (n: number) => void;
  onCelebrate: () => void;
  onFinish: (result: WeaveResult) => void;
}

interface ControllerDeps {
  x: MotionValue<number>;
  y: MotionValue<number>;
  opacity: MotionValue<number>;
  /** Squash and stretch, anchored at the feet. */
  scaleX: MotionValue<number>;
  scaleY: MotionValue<number>;
  setMode: (mode: SprocketMode) => void;
  onHappy: (happy: boolean) => void;
  isReduced: () => boolean;
}

interface Controller {
  /** Snaps onto the current perch and cancels any activity. */
  place: () => void;
  /** Cancels any activity and forgets the position (no card to sit on). */
  reset: () => void;
  /** Scurries along the wire from one stop to the next. */
  traverse: (fromId: string, toId: string) => void;
  /** Glides (or jumps) to the current perch from wherever Sprocket is. */
  relocate: () => void;
  /** "!" popup, run to the synapse midpoint, inspect, return. */
  react: (discovery: GhostDiscovery) => void;
  /** Keeps Sprocket on its perch while the card is dragged (ignored mid-activity). */
  follow: () => void;
  /** Cancels a reaction or weave whose cards or synapse no longer exist. */
  validate: () => void;
  /** Runs the weaving show. False when one is already running. */
  weave: (run: WeaveRun) => boolean;
  /** Stops a running weave (not the celebration) and returns to the perch. */
  cancelWeave: (result: "cancelled" | "aborted") => boolean;
  isWeaving: () => boolean;
  /** The cursor came near (or left): the orthogonal "happy" overlay. */
  setHappy: (happy: boolean) => void;
  dispose: () => void;
}

function createController(deps: ControllerDeps): Controller {
  const physics = SPROCKET_PHYSICS;
  let current: Activity | null = null;
  let machine: SprocketMachine = INITIAL_SPROCKET_MACHINE;
  let weaveRun: WeaveRun | null = null;
  let scaleControls: AnimationPlaybackControls[] = [];
  // The motion values already hold the perch when a card existed at mount
  // (see `initialPerch`), so a controller created later starts out placed.
  let placed = perchOf(selectPerchId(useMemexStore.getState())) !== null;
  let disposed = false;

  /** Applies an event to the state machine. Illegal transitions are ignored (false). */
  const dispatch = (event: SprocketEvent): boolean => {
    const next = reduceSprocket(machine, event);
    if (next === machine) return false;
    machine = next;
    return true;
  };
  const busyWeaving = () => machine.state === "weaving" || machine.state === "celebrating";

  const setPoint = (p: Point) => {
    deps.x.set(p.x);
    deps.y.set(p.y);
  };
  const currentPoint = (): Point => ({ x: deps.x.get(), y: deps.y.get() });
  const currentPerch = (): Point | null => perchOf(selectPerchId(useMemexStore.getState()));

  /** Reduced motion: no travel, a quick fade in at the new spot. */
  const jump = (p: Point) => {
    setPoint(p);
    deps.opacity.set(0);
    animate(deps.opacity, 1, { duration: 0.2 });
  };

  // --- squash and stretch (skipped entirely under reduced motion) ---------
  const stopScale = () => {
    for (const c of scaleControls) c.stop();
    scaleControls = [];
  };
  const restScale = () => {
    stopScale();
    deps.scaleX.set(physics.rest.scaleX);
    deps.scaleY.set(physics.rest.scaleY);
  };
  const scaleTo = (scaleX: number, scaleY: number, ms: number) => {
    if (deps.isReduced()) return;
    stopScale();
    const options = { duration: ms / 1000, ease: "easeOut" as const };
    scaleControls = [animate(deps.scaleX, scaleX, options), animate(deps.scaleY, scaleY, options)];
  };
  /** Impact squash, then a spring back to 1.0. `onSettled` runs when the spring rests. */
  const land = (onSettled?: () => void) => {
    if (deps.isReduced()) {
      onSettled?.();
      return;
    }
    stopScale();
    deps.scaleX.set(physics.landing.scaleX);
    deps.scaleY.set(physics.landing.scaleY);
    scaleControls = [
      animate(deps.scaleX, physics.rest.scaleX, physics.landing.spring),
      animate(deps.scaleY, physics.rest.scaleY, { ...physics.landing.spring, onComplete: onSettled }),
    ];
  };

  const stop = () => {
    const a = current;
    current = null;
    if (a) {
      for (const c of a.clears) c();
      a.clears.length = 0;
    }
    stopScale();
  };

  /** Stops the running activity and returns the machine to idle. */
  const interrupt = () => {
    stop();
    dispatch("INTERRUPT");
  };

  const settle = () => {
    current = null;
    dispatch("SETTLE");
    dispatch("INTERRUPT");
    restScale();
    if (disposed) return;
    deps.setMode("perched");
    const home = currentPerch();
    if (home) setPoint(home);
  };

  /** Ends an activity where Sprocket stands (no snap to the perch). */
  const settleInPlace = () => {
    current = null;
    dispatch("SETTLE");
    dispatch("INTERRUPT");
    restScale();
    if (!disposed) deps.setMode("perched");
  };

  const begin = (kind: Activity["kind"], extra: Partial<Activity> = {}): Activity => {
    const act: Activity = { kind, clears: [], ...extra };
    current = act;
    return act;
  };

  const tween = (options: {
    ms?: number;
    spring?: boolean;
    onFrame: (k: number) => void;
    onDone: () => void;
  }): (() => void) => {
    const controls = animate(0, 1, {
      ...(options.spring
        ? SPRING
        : { duration: (options.ms ?? SCURRY_FLIGHT_MS) / 1000, ease: "easeInOut" as const }),
      onUpdate: options.onFrame,
      onComplete: options.onDone,
    });
    return () => controls.stop();
  };

  const later = (ms: number, fn: () => void): (() => void) => {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  };

  /**
   * One move: 150 ms wind-up (squat and widen), the flight (stretched tall and
   * thin) and the arrival. A trail-follow move takes 800 ms in all, the length
   * of the camera glide. Calls `onArrive` at touchdown, after the impact squash
   * has started.
   */
  const sequence = (
    act: Activity,
    o: { flightMs?: number; spring?: boolean; onFrame: (k: number) => void; onArrive: () => void },
  ) => {
    dispatch("MOVE");
    deps.setMode("poised");
    scaleTo(physics.anticipation.scaleX, physics.anticipation.scaleY, physics.anticipation.durationMs);
    act.clears.push(
      later(physics.anticipation.durationMs, () => {
        if (current !== act) return;
        dispatch("LIFTOFF");
        deps.setMode("scurrying");
        scaleTo(physics.flight.scaleX, physics.flight.scaleY, STRETCH_MS);
        act.clears.push(
          tween({
            ms: o.flightMs,
            spring: o.spring,
            onFrame: o.onFrame,
            onDone: () => {
              if (current !== act) return;
              dispatch("TOUCHDOWN");
              deps.setMode("poised");
              o.onArrive();
            },
          }),
        );
      }),
    );
  };

  /** Lands, then settles on the perch once the rebound has rested. */
  const arriveAndSettle = (act: Activity) => {
    land(() => {
      if (current === act) settle();
    });
  };

  function controllerRelocate(): void {
    if (busyWeaving()) return;
    interrupt();
    const target = currentPerch();
    if (!target) return;
    if (!placed || deps.isReduced()) {
      deps.setMode("perched");
      if (!placed) setPoint(target);
      else jump(target);
      placed = true;
      return;
    }
    const start = currentPoint();
    const act = begin("move");
    sequence(act, {
      spring: true,
      onFrame: (k) => setPoint(mix(start, currentPerch() ?? target, k)),
      onArrive: () => arriveAndSettle(act),
    });
  }

  const cancelWeave = (result: "cancelled" | "aborted"): boolean => {
    if (machine.state !== "weaving") return false;
    const run = weaveRun;
    weaveRun = null;
    interrupt();
    restScale();
    deps.setMode("perched");
    run?.onFinish(result);
    controllerRelocate();
    return true;
  };

  return {
    place: () => {
      interrupt();
      deps.setMode("perched");
      const home = currentPerch();
      if (home) setPoint(home);
      placed = home !== null;
    },

    reset: () => {
      if (!cancelWeave("aborted")) interrupt();
      placed = false;
      deps.setMode("perched");
    },

    traverse: (fromId, toId) => {
      if (busyWeaving()) return;
      interrupt();
      const from = rectOf(fromId);
      const to = rectOf(toId);
      if (!from || !to) {
        placed = false;
        return controllerRelocate();
      }
      if (deps.isReduced()) {
        deps.setMode("perched");
        jump(getPerchPosition(to));
        return;
      }
      // The stored edge may run either way; the wire is the same line.
      const direction = findWireDirection(useMemexStore.getState().edges, fromId, toId);
      const act = begin("move");
      sequence(act, {
        onFrame: (k) => setPoint(travelPoint(rectOf(fromId) ?? from, rectOf(toId) ?? to, k, direction)),
        onArrive: () => arriveAndSettle(act),
      });
    },

    relocate: () => controllerRelocate(),

    react: (discovery) => {
      if (busyWeaving()) return;
      const source = rectOf(discovery.sourceId);
      const target = rectOf(discovery.targetId);
      if (!source || !target) return;
      interrupt();
      const act = begin("reaction", {
        discoveryId: discovery.id,
        cardIds: [discovery.sourceId, discovery.targetId],
      });
      const midpoint = (): Point => {
        const a = rectOf(discovery.sourceId);
        const b = rectOf(discovery.targetId);
        return a && b ? getEdgeMidpoint(a, b) : getEdgeMidpoint(source, target);
      };
      const goBack = () => {
        if (current !== act) return;
        if (deps.isReduced()) {
          settle();
          return;
        }
        const start = currentPoint();
        sequence(act, {
          onFrame: (k) => setPoint(mix(start, currentPerch() ?? start, k)),
          onArrive: () => arriveAndSettle(act),
        });
      };
      const arrive = () => {
        if (current !== act) return;
        // Landing squash plays while Sprocket starts to inspect.
        dispatch("INSPECT");
        deps.setMode("inspecting");
        land();
        act.clears.push(later(SPROCKET_INSPECT_MS, goBack));
      };
      const goToSynapse = () => {
        if (current !== act) return;
        if (deps.isReduced()) {
          jump(midpoint());
          dispatch("MOVE");
          dispatch("LIFTOFF");
          dispatch("TOUCHDOWN");
          arrive();
          return;
        }
        const start = currentPoint();
        sequence(act, {
          onFrame: (k) => setPoint(mix(start, midpoint(), k)),
          onArrive: arrive,
        });
      };
      deps.setMode("alert");
      act.clears.push(later(SPROCKET_ALERT_MS, goToSynapse));
    },

    follow: () => {
      if (current !== null || !placed) return;
      const home = currentPerch();
      if (home) setPoint(home);
    },

    validate: () => {
      const a = current;
      if (a === null) return;
      const s = useMemexStore.getState();
      if (a.kind === "weave") {
        const run = weaveRun;
        if (run === null || machine.state !== "weaving") return;
        const trail = s.trails.find((t) => t.id === run.trailId);
        const intact =
          trail !== undefined &&
          run.stopIds.every((id) => s.nodes.some((n) => n.id === id)) &&
          rectsSignature(run.stopIds, rectMap(run.stopIds)) === run.signature;
        if (!intact) cancelWeave("aborted");
        return;
      }
      if (a.kind !== "reaction") return;
      const cardsExist = (a.cardIds ?? []).every((id) => s.nodes.some((n) => n.id === id));
      const synapseExists = s.ghostDiscoveries.some((g) => g.id === a.discoveryId);
      if (cardsExist && synapseExists) return;
      stop();
      settle();
    },

    weave: (run) => {
      if (busyWeaving() || run.legs.length === 0) return false;
      interrupt();
      dispatch("WEAVE");
      weaveRun = run;
      const act = begin("weave");
      const reduced = deps.isReduced();
      const total = run.legs.length;

      const finish = () => {
        if (current !== act) return;
        dispatch("CELEBRATE");
        deps.setMode("celebrating");
        restScale();
        run.onCelebrate();
        act.clears.push(
          later(reduced ? 300 : CELEBRATE_MS, () => {
            if (current !== act) return;
            weaveRun = null;
            settleInPlace();
            run.onFinish("completed");
            controllerRelocate();
          }),
        );
      };

      const runLeg = (i: number) => {
        if (current !== act) return;
        if (i >= total) return finish();
        const leg = run.legs[i];
        const end = leg.points[leg.points.length - 1];
        if (reduced) {
          jump(end);
          run.progress.set(i + 1);
          run.onStop(i + 2);
          act.clears.push(later(WEAVE_REDUCED_STEP_MS, () => runLeg(i + 1)));
          return;
        }
        // Wind-up, flight along the filament (stretched), landing squash, short dwell.
        sequence(act, {
          flightMs: WEAVE_LEG_FLIGHT_MS,
          onFrame: (k) => {
            setPoint(legPointAt(leg, k));
            run.progress.set(i + arcFractionAt(leg, k));
          },
          onArrive: () => {
            setPoint(end);
            run.progress.set(i + 1);
            land();
            run.onStop(i + 2);
            act.clears.push(later(WEAVE_DWELL_MS, () => runLeg(i + 1)));
          },
        });
      };

      // First get to the first stop (800 ms in all, as long as the camera fit).
      const first = run.legs[0].points[0];
      const from = currentPoint();
      if (reduced) {
        jump(first);
        act.clears.push(later(WEAVE_REDUCED_STEP_MS, () => runLeg(0)));
      } else if (pointDistance(from, first) > 2) {
        sequence(act, {
          onFrame: (k) => setPoint(mix(from, first, k)),
          onArrive: () => {
            setPoint(first);
            land();
            act.clears.push(later(WEAVE_DWELL_MS, () => runLeg(0)));
          },
        });
      } else {
        runLeg(0);
      }
      return true;
    },

    cancelWeave,

    isWeaving: () => machine.state === "weaving",

    setHappy: (happy) => {
      if (dispatch(happy ? "HAPPY_ON" : "HAPPY_OFF")) deps.onHappy(happy);
    },

    dispose: () => {
      disposed = true;
      weaveRun = null;
      interrupt();
      restScale();
    },
  };
}

// ---------------------------------------------------------------------------
// Sprite
// ---------------------------------------------------------------------------

/** Body motion per mode. Reduced motion uses the static set (no bob, no tilt). */
const BODY_VARIANTS: Variants = {
  perched: {
    y: [0, -1.5, 0],
    rotate: 0,
    transition: { y: { duration: 2.6, repeat: Infinity, ease: "easeInOut" }, rotate: { duration: 0.2 } },
  },
  poised: { y: 0, rotate: 0, transition: { duration: 0.1 } },
  scurrying: { y: 0, rotate: 0, transition: { duration: 0.15 } },
  alert: { y: 0, rotate: 0, transition: { duration: 0.15 } },
  celebrating: { y: 0, rotate: 0, transition: { duration: 0.1 } },
  inspecting: {
    y: 0,
    rotate: [0, -16, 14, -16, 14, 0],
    transition: { rotate: { duration: SPROCKET_INSPECT_MS / 1000, ease: "easeInOut" } },
  },
};
const STATIC_BODY_VARIANTS: Variants = {
  perched: { y: 0, rotate: 0 },
  poised: { y: 0, rotate: 0 },
  scurrying: { y: 0, rotate: 0 },
  alert: { y: 0, rotate: 0 },
  celebrating: { y: 0, rotate: 0 },
  inspecting: { y: 0, rotate: 0 },
};

interface EyeMotion {
  /** Pupil offset in sprite units, written by the pointer tracker. */
  pupilX: MotionValue<number>;
  pupilY: MotionValue<number>;
  /** 0 = open eye, 1 = happy arch. */
  happy: MotionValue<number>;
}

function SprocketSprite({
  awake,
  moving,
  still,
  eye,
}: {
  awake: boolean;
  moving: boolean;
  still: boolean;
  eye: EyeMotion;
}) {
  const open = useTransform(eye.happy, (v) => 1 - v);
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={SPROCKET_SIZE}
      height={SPROCKET_SIZE}
      viewBox="0 0 24 24"
      data-moving={moving ? "true" : "false"}
      style={{ display: "block", overflow: "visible" }}
    >
      <defs>
        <linearGradient id="sprocket-brass" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={BRASS} />
          <stop offset="1" stopColor={BRASS_DARK} />
        </linearGradient>
      </defs>
      {/* Legs: transform-only rocking (CSS), two alternating pairs. */}
      <g stroke={BRASS_DARK} strokeWidth="1.3" strokeLinecap="round" fill="none">
        <g className="sprocket-leg sprocket-leg-a">
          <path d="M6.5 16 L4.5 21.5" />
        </g>
        <g className="sprocket-leg sprocket-leg-b">
          <path d="M10 16.5 L9 22" />
        </g>
        <g className="sprocket-leg sprocket-leg-a">
          <path d="M14 16.5 L15 22" />
        </g>
        <g className="sprocket-leg sprocket-leg-b">
          <path d="M17.5 16 L19.5 21.5" />
        </g>
      </g>
      {/* Antenna and chimney. */}
      <path d="M7 8.5 L5 4.5" stroke={BRASS_DARK} strokeWidth="1" strokeLinecap="round" />
      <circle cx="4.8" cy="4.2" r="1.1" fill={AMBER} />
      <rect x="15" y="4.5" width="3" height="4" rx="1" fill={BRASS_DARK} />
      {/* Chassis. */}
      <rect x="2.5" y="8" width="19" height="9" rx="4.2" fill="url(#sprocket-brass)" stroke={OBSIDIAN} strokeWidth="1" />
      <circle cx="6.5" cy="12.5" r="0.8" fill={BRASS_DARK} />
      <circle cx="9.5" cy="12.5" r="0.8" fill={BRASS_DARK} />
      {/* Eye socket and soft glow ring. */}
      <circle cx="16" cy="12.5" r="3.6" fill={OBSIDIAN} />
      <motion.circle
        cx="16"
        cy="12.5"
        r="4.6"
        fill={awake ? VIOLET : AMBER}
        initial={false}
        animate={still ? { opacity: 0.28 } : { opacity: [0.18, 0.42, 0.18] }}
        transition={still ? { duration: 0 } : { duration: 2.2, repeat: Infinity, ease: "easeInOut" }}
      />
      {/* Open eye: the phosphor pupil follows the cursor (offset written by the tracker, no re-render). */}
      <motion.g style={{ x: eye.pupilX, y: eye.pupilY, opacity: open }}>
        <motion.circle
          cx="16"
          cy="12.5"
          r="2.1"
          fill={AMBER}
          initial={false}
          animate={{ opacity: awake ? 0 : 1 }}
          transition={{ duration: 0.25 }}
        />
        <motion.circle
          cx="16"
          cy="12.5"
          r="2.1"
          fill={VIOLET}
          initial={false}
          animate={{ opacity: awake ? 1 : 0 }}
          transition={{ duration: 0.25 }}
        />
      </motion.g>
      {/* Happy eye: a curved arch, cross-faded in by opacity (no filters, no path morph math). */}
      <motion.g style={{ opacity: eye.happy }}>
        <motion.path
          d="M13.4 13.9 Q16 9.7 18.6 13.9"
          fill="none"
          stroke={AMBER}
          strokeWidth="1.6"
          strokeLinecap="round"
          initial={false}
          animate={{ opacity: awake ? 0 : 1 }}
          transition={{ duration: 0.25 }}
        />
        <motion.path
          d="M13.4 13.9 Q16 9.7 18.6 13.9"
          fill="none"
          stroke={VIOLET}
          strokeWidth="1.6"
          strokeLinecap="round"
          initial={false}
          animate={{ opacity: awake ? 1 : 0 }}
          transition={{ duration: 0.25 }}
        />
      </motion.g>
    </svg>
  );
}

/** Three small steam circles that rise and fade (transform and opacity only, no filters). */
function SteamPuff({ still }: { still: boolean }) {
  const puffs = [
    { cx: 16.5, delay: 0, drift: -3 },
    { cx: 17.5, delay: 0.08, drift: 1 },
    { cx: 16, delay: 0.16, drift: 4 },
  ];
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={SPROCKET_SIZE}
      height={SPROCKET_SIZE}
      viewBox="0 0 24 24"
      style={{ position: "absolute", left: 0, top: 0, overflow: "visible", pointerEvents: "none" }}
    >
      {puffs.map((p) => (
        <motion.circle
          key={p.cx}
          cx={p.cx}
          cy={4}
          r={1.6}
          fill={PARCHMENT}
          initial={{ opacity: 0.8, x: 0, y: 0, scale: 0.6 }}
          animate={
            still
              ? { opacity: [0.8, 0], x: 0, y: 0, scale: 1 }
              : { opacity: [0.8, 0], x: p.drift, y: -16, scale: 1.3 }
          }
          transition={{ duration: 0.9, delay: p.delay, ease: "easeOut" }}
          style={{ originX: "50%", originY: "50%", transformBox: "fill-box" }}
        />
      ))}
    </svg>
  );
}

/** Celebration: brass sparks burst outward from the chassis (transform and opacity only). */
function SparkBurst() {
  const sparks = sparkBurst();
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={SPROCKET_SIZE}
      height={SPROCKET_SIZE}
      viewBox="0 0 24 24"
      style={{ position: "absolute", left: 0, top: 0, overflow: "visible", pointerEvents: "none" }}
    >
      {sparks.map((s, i) => {
        const rad = (s.angleDeg * Math.PI) / 180;
        return (
          <motion.circle
            key={i}
            cx={12}
            cy={11}
            r={s.radius}
            fill={s.color}
            initial={{ opacity: 1, x: 0, y: 0, scale: 1 }}
            animate={{
              opacity: [1, 1, 0],
              x: Math.cos(rad) * s.distance,
              y: Math.sin(rad) * s.distance,
              scale: 0.4,
            }}
            transition={{ duration: 0.7, delay: s.delay, ease: "easeOut" }}
            style={{ originX: "50%", originY: "50%", transformBox: "fill-box" }}
          />
        );
      })}
    </svg>
  );
}

/**
 * One leg of the illuminated pulse filament: a wide amber underlayer, a violet
 * glow and a crisp violet core, revealed by `pathLength` as Sprocket walks it.
 * Plain strokes only (no SVG filters).
 */
function FilamentLeg({
  leg,
  index,
  progress,
}: {
  leg: WeaveLeg;
  index: number;
  progress: MotionValue<number>;
}) {
  const d = polylinePath(leg.points);
  const length = useTransform(progress, (v) => Math.min(1, Math.max(0, v - index)));
  const visible = useTransform(progress, (v) => (v - index > 0 ? 1 : 0));
  return (
    <motion.g style={{ opacity: visible }}>
      <motion.path d={d} fill="none" stroke={AMBER} strokeOpacity={0.16} strokeWidth={11} strokeLinecap="round" strokeLinejoin="round" style={{ pathLength: length }} />
      <motion.path d={d} fill="none" stroke={VIOLET} strokeOpacity={0.32} strokeWidth={6} strokeLinecap="round" strokeLinejoin="round" style={{ pathLength: length }} />
      <motion.path d={d} fill="none" stroke={VIOLET} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ pathLength: length }} />
    </motion.g>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface BubbleState {
  key: number;
  text: string;
  /** The idle prompt: shows the auto-weave button and takes pointer events. */
  action: boolean;
}

/**
 * Sprocket, the microfilm crawler. Lives in flow coordinates (a ViewportPortal
 * child), so it pans and zooms with the cards. Positions, squash and stretch,
 * the pupil and the filament are written to motion values, never React state,
 * so scurrying, eye tracking and weaving cause no re-renders per frame.
 */
export function SprocketCrawler() {
  const reduce = useReducedMotion() === true;
  const perchId = useMemexStore(selectPerchId);
  const activeTrailId = useMemexStore(selectActiveTrailId);
  const activeTrailIndex = useMemexStore(selectActiveTrailIndex);
  const scanning = useMemexStore(selectIsGhostScanning);
  const scale = useViewportStore(selectZoomScale);
  const idle = useIdleFlag();
  const { fitView } = useReactFlow();

  const [mode, setMode] = useState<SprocketMode>("perched");
  const [afterglow, setAfterglow] = useState(false);
  const [bubble, setBubble] = useState<BubbleState | null>(null);
  const [clicks, setClicks] = useState(0);
  const [spin, setSpin] = useState(0);
  const [celebration, setCelebration] = useState(0);
  const [quipIndex, setQuipIndex] = useState(0);
  const [weaveStatus, setWeaveStatus] = useState("");
  const [filament, setFilament] = useState<{ key: number; legs: readonly WeaveLeg[] } | null>(null);

  const [initialPerch] = useState<Point | null>(() =>
    perchOf(selectPerchId(useMemexStore.getState())),
  );
  const x = useMotionValue(initialPerch?.x ?? 0);
  const y = useMotionValue(initialPerch?.y ?? 0);
  const opacity = useMotionValue(1);
  const scaleX = useMotionValue<number>(SPROCKET_PHYSICS.rest.scaleX);
  const scaleY = useMotionValue<number>(SPROCKET_PHYSICS.rest.scaleY);
  const pupilX = useMotionValue(0);
  const pupilY = useMotionValue(0);
  const happy = useMotionValue(0);
  const wagRotate = useMotionValue(0);
  const wagX = useMotionValue(0);
  const weaveProgress = useMotionValue(0);
  const filamentOpacity = useMotionValue(1);

  const reducedRef = useRef(reduce);
  const controllerRef = useRef<Controller | null>(null);
  const spriteRef = useRef<HTMLButtonElement | null>(null);
  const previousRef = useRef<{ trailId: string | null; index: number; perchId: string | null } | null>(null);
  const bubbleTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const promptVisibleRef = useRef(false);
  const promptShownRef = useRef(false);
  const bubbleKeyRef = useRef(0);
  const filamentKeyRef = useRef(0);
  const filamentFadeRef = useRef<AnimationPlaybackControls | null>(null);
  const weaveKeyCleanupRef = useRef<(() => void) | null>(null);
  const fitViewRef = useRef(fitView);

  useEffect(() => {
    reducedRef.current = reduce;
  }, [reduce]);
  useEffect(() => {
    fitViewRef.current = fitView;
  }, [fitView]);

  const hasPerch = perchId !== null;

  // --- bubbles ------------------------------------------------------------
  const hideBubble = useCallback(() => {
    clearTimeout(bubbleTimerRef.current);
    promptVisibleRef.current = false;
    setBubble(null);
  }, []);

  const showBubble = useCallback((text: string, action: boolean, ms: number) => {
    clearTimeout(bubbleTimerRef.current);
    bubbleKeyRef.current += 1;
    promptVisibleRef.current = action;
    setBubble({ key: bubbleKeyRef.current, text, action });
    bubbleTimerRef.current = setTimeout(() => {
      promptVisibleRef.current = false;
      setBubble(null);
    }, ms);
  }, []);

  // --- controller, store subscription, ghost reaction and weave ----------
  useEffect(() => {
    const stopHappyWag = { current: null as AnimationPlaybackControls[] | null };
    const controller = createController({
      x,
      y,
      opacity,
      scaleX,
      scaleY,
      setMode,
      isReduced: () => reducedRef.current,
      onHappy: (isHappy) => {
        // The arch cross-fades in by opacity; the wag is a small rotate and shift (not under reduced motion).
        animate(happy, isHappy ? 1 : 0, { duration: reducedRef.current ? 0.15 : 0.18 });
        for (const c of stopHappyWag.current ?? []) c.stop();
        stopHappyWag.current = null;
        if (isHappy && !reducedRef.current) {
          const half = WAG.periodMs / 2000;
          const options = { duration: half, repeat: Infinity, repeatType: "mirror" as const, ease: "easeInOut" as const };
          wagRotate.set(-WAG.rotateDeg);
          wagX.set(-WAG.shiftX);
          stopHappyWag.current = [
            animate(wagRotate, WAG.rotateDeg, options),
            animate(wagX, WAG.shiftX, options),
          ];
        } else {
          animate(wagRotate, 0, { duration: 0.15 });
          animate(wagX, 0, { duration: 0.15 });
        }
      },
    });
    controllerRef.current = controller;

    let afterglowTimer: ReturnType<typeof setTimeout> | undefined;
    let before: readonly GhostDiscovery[] = [];
    let startKey = "";

    const unsubscribeMemex = useMemexStore.subscribe((s, prev) => {
      if (s.nodes !== prev.nodes) controller.follow();
      if (s.nodes !== prev.nodes || s.ghostDiscoveries !== prev.ghostDiscoveries || s.trails !== prev.trails) {
        controller.validate();
      }
      if (s.isGhostScanning === prev.isGhostScanning) return;
      if (s.isGhostScanning) {
        // Scan started: remember what exists and which cards were there.
        before = s.ghostDiscoveries;
        startKey = idsKey(s);
        clearTimeout(afterglowTimer);
        setAfterglow(false);
        return;
      }
      // Scan finished. A graph that changed during the scan makes it stale.
      const target = idsKey(s) === startKey ? pickInspectionTarget(before, s.ghostDiscoveries) : undefined;
      if (target === undefined) return;
      setAfterglow(true);
      clearTimeout(afterglowTimer);
      afterglowTimer = setTimeout(() => setAfterglow(false), GHOST_AFTERGLOW_MS);
      controller.react(target);
    });

    // --- the weaving show --------------------------------------------------
    const fadeFilament = (ms: number) => {
      filamentFadeRef.current?.stop();
      filamentFadeRef.current = animate(filamentOpacity, 0, {
        duration: ms / 1000,
        ease: "easeOut",
        onComplete: () => {
          filamentFadeRef.current = null;
          setFilament(null);
        },
      });
    };

    const stopWeaveKeys = () => {
      weaveKeyCleanupRef.current?.();
      weaveKeyCleanupRef.current = null;
    };

    const runWeave = () => {
      const memex = useMemexStore.getState();
      if (memex.activeTrailId !== null || controller.isWeaving()) return;
      const session = useSprocketSession.getState();
      const added = memex.generateAndAddAutoTrails();
      const after = useMemexStore.getState();
      const choice = chooseWeaveTrail(added, after.trails, session.weaveCursor);
      const trail = choice.trail;
      if (trail === null) {
        showToast("NO_AUTO_TRAIL");
        return;
      }
      session.setWeaveCursor(choice.nextCursor);
      const stopIds = trail.nodeIds.filter((id) => after.nodes.some((n) => n.id === id));
      const rects = rectMap(stopIds);
      const legs = planWeave(stopIds, rects, (a, b) => findWireDirection(after.edges, a, b));
      if (legs.length === 0) {
        showToast("NO_AUTO_TRAIL");
        return;
      }

      hideBubble();
      session.beginWeave(trail.id);
      filamentFadeRef.current?.stop();
      filamentFadeRef.current = null;
      weaveProgress.set(0);
      filamentOpacity.set(1);
      filamentKeyRef.current += 1;
      setFilament({ key: filamentKeyRef.current, legs });
      setWeaveStatus(weaveProgressText(trail.title, 1, legs.length + 1));

      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") controller.cancelWeave("cancelled");
      };
      window.addEventListener("keydown", onKey);
      weaveKeyCleanupRef.current = () => window.removeEventListener("keydown", onKey);

      // The camera frames the whole trail while Sprocket runs to its first stop (800 ms).
      void fitViewRef.current({
        nodes: stopIds.map((id) => ({ id })),
        padding: 0.25,
        duration: reducedRef.current ? 0 : 800,
      });

      const started = controller.weave({
        legs,
        stopIds,
        signature: rectsSignature(stopIds, rects),
        trailId: trail.id,
        progress: weaveProgress,
        onStop: (n) => setWeaveStatus(weaveProgressText(trail.title, n, legs.length + 1)),
        onCelebrate: () => {
          setSpin((n) => n + 1);
          setCelebration((n) => n + 1);
        },
        onFinish: (result) => {
          stopWeaveKeys();
          useSprocketSession.getState().endWeave();
          setWeaveStatus("");
          fadeFilament(result === "completed" ? FILAMENT_FADE_MS : 400);
          if (result === "completed") {
            const store = useMemexStore.getState();
            // The Lever opens at stop 0 (the camera director glides there).
            store.setActiveTrail(trail.id);
            showBubble(weaveDoneText(trail.title, stopIds.length), false, WEAVE_BUBBLE_MS);
          } else {
            showBubble(result === "aborted" ? WEAVE_ABORTED_TEXT : WEAVE_CANCELLED_TEXT, false, SPROCKET_BUBBLE_MS);
          }
        },
      });
      if (!started) {
        stopWeaveKeys();
        useSprocketSession.getState().endWeave();
        setFilament(null);
        setWeaveStatus("");
      }
    };

    const unsubscribeSession = useSprocketSession.subscribe((s, prev) => {
      if (s.weaveRequestId !== prev.weaveRequestId) runWeave();
    });

    return () => {
      unsubscribeMemex();
      unsubscribeSession();
      clearTimeout(afterglowTimer);
      stopWeaveKeys();
      filamentFadeRef.current?.stop();
      for (const c of stopHappyWag.current ?? []) c.stop();
      if (controller.isWeaving()) useSprocketSession.getState().endWeave();
      controller.dispose();
      controllerRef.current = null;
    };
  }, [
    x, y, opacity, scaleX, scaleY, happy, wagRotate, wagX, weaveProgress, filamentOpacity,
    hideBubble, showBubble,
  ]);

  // --- eye tracking and the happy state ------------------------------------
  // One passive window listener, throttled with requestAnimationFrame, writing
  // motion values: moving the mouse never re-renders React.
  useEffect(() => {
    if (!hasPerch || typeof window === "undefined") return;
    let frame = 0;
    let pointer: Point | null = null;
    let isHappy = false;

    const update = () => {
      frame = 0;
      const el = spriteRef.current;
      if (pointer === null || el === null) return;
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return;
      const center: Point = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      const offset = pupilToSprite(pupilOffset(center, pointer, PUPIL_MAX_RADIUS));
      pupilX.set(offset.x);
      pupilY.set(offset.y);
      const near = isCursorNear(
        pointDistance(center, pointer),
        isHappy ? CURSOR_NEAR_PX + CURSOR_NEAR_HYSTERESIS_PX : CURSOR_NEAR_PX,
      );
      if (near !== isHappy) {
        isHappy = near;
        controllerRef.current?.setHappy(near);
      }
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };
    const onMove = (e: PointerEvent) => {
      // Touch has no cursor to follow.
      if (e.pointerType === "touch") return;
      pointer = { x: e.clientX, y: e.clientY };
      schedule();
    };
    const reset = () => {
      pointer = null;
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = 0;
      animate(pupilX, 0, { duration: 0.2 });
      animate(pupilY, 0, { duration: 0.2 });
      if (isHappy) {
        isHappy = false;
        controllerRef.current?.setHappy(false);
      }
    };
    const onOut = (e: MouseEvent) => {
      if (e.relatedTarget === null) reset();
    };

    window.addEventListener("pointermove", onMove, POINTER_OPTIONS);
    document.documentElement.addEventListener("pointerleave", reset, POINTER_OPTIONS);
    window.addEventListener("mouseout", onOut, POINTER_OPTIONS);
    window.addEventListener("blur", reset, POINTER_OPTIONS);
    // Sprocket itself moves (scurry, weave): refresh the direction while the pointer rests.
    const offX = x.on("change", schedule);
    const offY = y.on("change", schedule);
    return () => {
      window.removeEventListener("pointermove", onMove, POINTER_OPTIONS);
      document.documentElement.removeEventListener("pointerleave", reset, POINTER_OPTIONS);
      window.removeEventListener("mouseout", onOut, POINTER_OPTIONS);
      window.removeEventListener("blur", reset, POINTER_OPTIONS);
      offX();
      offY();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [hasPerch, x, y, pupilX, pupilY]);

  // --- idle weave prompt ---------------------------------------------------
  useEffect(() => {
    if (!idle) {
      // Activity returned: the next idle period may offer once more.
      promptShownRef.current = false;
      return;
    }
    const memex = useMemexStore.getState();
    const session = useSprocketSession.getState();
    const gate = {
      cardCount: memex.nodes.length,
      activeTrailId: memex.activeTrailId,
      isWeaving: session.isWeaving,
      idle: true,
      shownThisPeriod: promptShownRef.current,
    };
    // Cheap rules first; the (pure) genesis only runs when the offer could show.
    if (!shouldShowWeavePrompt({ ...gate, trailAvailable: true })) return;
    const available = generateAutoTrails(memex.nodes, memex.edges, memex.ghostDiscoveries).length > 0;
    if (!shouldShowWeavePrompt({ ...gate, trailAvailable: available })) return;
    promptShownRef.current = true;
    showBubble(WEAVE_PROMPT_TEXT, true, WEAVE_PROMPT_MS);
  }, [idle, showBubble]);

  // Deliberate input elsewhere (click, key, wheel, touch) dismisses the prompt. Moving
  // the mouse does not, so the user can reach Sprocket. Input on Sprocket is ignored.
  useEffect(() => {
    return getSharedTracker().subscribeActivity((event) => {
      if (!promptVisibleRef.current) return;
      if (event instanceof KeyboardEvent && (event.key === "Tab" || event.key === "Shift")) return;
      const target = event.target;
      if (target instanceof Element && target.closest("[data-sprocket-root]") !== null) return;
      hideBubble();
    });
  }, [hideBubble]);

  // --- placement: first sight, relocation, or a scurry when the trail moved one stop ---
  useEffect(() => {
    const controller = controllerRef.current;
    if (controller === null) return;
    const prev = previousRef.current;
    previousRef.current = { trailId: activeTrailId, index: activeTrailIndex, perchId };
    if (perchId === null) {
      controller.reset();
      return;
    }
    if (prev === null || prev.perchId === null) {
      controller.place();
      return;
    }
    if (prev.perchId === perchId) return;
    const oneStep =
      prev.trailId !== null &&
      prev.trailId === activeTrailId &&
      Math.abs(activeTrailIndex - prev.index) === 1;
    if (oneStep) controller.traverse(prev.perchId, perchId);
    else controller.relocate();
  }, [perchId, activeTrailId, activeTrailIndex]);

  useEffect(
    () => () => {
      clearTimeout(bubbleTimerRef.current);
    },
    [],
  );

  const startWeave = useCallback(() => {
    hideBubble();
    return useSprocketSession.getState().requestWeave();
  }, [hideBubble]);

  const onActivate = useCallback(() => {
    // Clicking Sprocket mid-weave stops the show.
    if (controllerRef.current?.cancelWeave("cancelled") === true) return;
    // While the idle prompt shows, a click starts the weave instead of a quip.
    if (promptVisibleRef.current && startWeave()) return;
    const next = clicks + 1;
    setClicks(next);
    setSpin((n) => n + 1);
    showBubble(selectSprocketQuip(quipIndex), false, SPROCKET_BUBBLE_MS);
    setQuipIndex(advanceQuipIndex(quipIndex));
  }, [clicks, quipIndex, showBubble, startWeave]);

  const eye: EyeMotion = { pupilX, pupilY, happy };

  if (perchId === null) return null;

  const awake = scanning || afterglow;
  const moving = mode === "scurrying" && !reduce;

  return (
    <ViewportPortal>
      {filament !== null ? (
        <svg
          key={filament.key}
          aria-hidden="true"
          focusable="false"
          width={1}
          height={1}
          style={{ position: "absolute", left: 0, top: 0, overflow: "visible", pointerEvents: "none", zIndex: 1150 }}
        >
          <motion.g style={{ opacity: filamentOpacity }}>
            {filament.legs.map((leg, i) => (
              <FilamentLeg key={`${leg.fromId}->${leg.toId}`} leg={leg} index={i} progress={weaveProgress} />
            ))}
          </motion.g>
        </svg>
      ) : null}
      <motion.div
        className="nopan nodrag nowheel"
        data-sprocket-root=""
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          x,
          y,
          opacity,
          width: SPROCKET_SIZE,
          height: SPROCKET_SIZE,
          marginLeft: -SPROCKET_SIZE / 2,
          marginTop: -SPROCKET_SIZE / 2,
          zIndex: 1200,
          // Only the sprite itself takes pointer events (see the button below).
          pointerEvents: "none",
        }}
      >
        <motion.div
          initial={false}
          animate={{ scale }}
          transition={reduce ? { duration: 0 } : SPRING}
          style={{ position: "relative", width: SPROCKET_SIZE, height: SPROCKET_SIZE, transformOrigin: "50% 100%" }}
        >
          {/* Speech bubble and screen-reader announcements. The region stays mounted so changes are announced. */}
          <div
            role="status"
            aria-live="polite"
            style={{
              position: "absolute",
              bottom: "100%",
              left: "50%",
              width: "max-content",
              maxWidth: 220,
              marginBottom: 8,
              transform: "translateX(-50%)",
              pointerEvents: "none",
            }}
          >
            {mode === "alert" ? <span className="sr-only">Sprocket spotted a new ghost synapse.</span> : null}
            {weaveStatus !== "" ? <span className="sr-only">{weaveStatus}</span> : null}
            <AnimatePresence>
              {bubble !== null ? (
                <motion.div
                  key={bubble.key}
                  initial={{ opacity: 0, y: reduce ? 0 : 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={reduce ? { duration: 0.15 } : SPRING}
                  className="font-mono"
                  style={{
                    background: SURFACE,
                    color: PARCHMENT,
                    border: "1px solid rgba(255, 178, 54, 0.45)",
                    borderRadius: 10,
                    padding: "6px 10px",
                    fontSize: 11,
                    lineHeight: 1.35,
                    boxShadow: "0 6px 18px rgba(0, 0, 0, 0.65), 0 0 10px rgba(255, 178, 54, 0.18)",
                    pointerEvents: bubble.action ? "auto" : "none",
                  }}
                >
                  <span>{bubble.text}</span>
                  {bubble.action ? (
                    <button
                      type="button"
                      onClick={startWeave}
                      onFocus={() => clearTimeout(bubbleTimerRef.current)}
                      aria-label="Auto-weave trail: let Sprocket scamper through a generated trail"
                      className="nopan nodrag nowheel mt-1.5 block w-full cursor-pointer rounded-lg border border-accent-ghost/70 bg-[#090A0F] px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-accent-ghost focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent-ghost"
                      style={{ boxShadow: "0 0 10px rgba(179, 136, 255, 0.35)" }}
                    >
                      {WEAVE_BUTTON_LABEL}
                    </button>
                  ) : null}
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>

          {/* "!" popup above Sprocket while it notices a new synapse. */}
          <AnimatePresence>
            {mode === "alert" ? (
              <motion.div
                key="alert"
                aria-hidden="true"
                initial={{ opacity: 0, scale: reduce ? 1 : 0.4 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: reduce ? 1 : 0.6 }}
                transition={reduce ? { duration: 0.15 } : SPRING}
                className="font-mono"
                style={{
                  position: "absolute",
                  bottom: "100%",
                  left: "50%",
                  marginLeft: -9,
                  marginBottom: 2,
                  width: 18,
                  height: 18,
                  borderRadius: 999,
                  background: VIOLET,
                  color: OBSIDIAN,
                  fontSize: 12,
                  fontWeight: 700,
                  lineHeight: "18px",
                  textAlign: "center",
                  pointerEvents: "none",
                  boxShadow: "0 0 10px rgba(179, 136, 255, 0.7)",
                }}
              >
                !
              </motion.div>
            ) : null}
          </AnimatePresence>

          <button
            ref={spriteRef}
            type="button"
            onClick={onActivate}
            aria-label="Sprocket the microfilm crawler: click for a quip"
            title="Sprocket"
            className="nopan nodrag nowheel cursor-pointer focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent-human"
            style={{
              position: "relative",
              display: "block",
              width: SPROCKET_SIZE,
              height: SPROCKET_SIZE,
              padding: 0,
              border: 0,
              borderRadius: 6,
              background: "transparent",
              pointerEvents: "auto",
            }}
          >
            {/* Squash and stretch, anchored at the feet (bottom center). */}
            <motion.span
              style={{
                display: "block",
                width: SPROCKET_SIZE,
                height: SPROCKET_SIZE,
                scaleX,
                scaleY,
                transformOrigin: "50% 100%",
              }}
            >
              {/* Happy wag: a small rotate and shift while the cursor is near. */}
              <motion.span
                style={{
                  display: "block",
                  width: SPROCKET_SIZE,
                  height: SPROCKET_SIZE,
                  rotate: wagRotate,
                  x: wagX,
                  transformOrigin: "50% 100%",
                }}
              >
                <motion.span
                  initial={false}
                  animate={mode}
                  variants={reduce ? STATIC_BODY_VARIANTS : BODY_VARIANTS}
                  style={{ display: "block", width: SPROCKET_SIZE, height: SPROCKET_SIZE }}
                >
                  {/* Click and celebration: a full mechanical turn (reduced motion: a brief flicker instead). */}
                  <motion.span
                    key={spin}
                    initial={spin === 0 ? false : { rotate: 0, opacity: 1 }}
                    animate={
                      spin === 0
                        ? { rotate: 0, opacity: 1 }
                        : reduce
                          ? { rotate: 0, opacity: [1, 0.35, 1] }
                          : { rotate: [0, 360], opacity: 1 }
                    }
                    transition={{ duration: reduce ? 0.3 : 0.6, ease: [0.5, 0, 0.2, 1] }}
                    style={{ display: "block", width: SPROCKET_SIZE, height: SPROCKET_SIZE }}
                  >
                    <SprocketSprite awake={awake} moving={moving} still={reduce} eye={eye} />
                  </motion.span>
                </motion.span>
              </motion.span>
            </motion.span>
          </button>
          {clicks > 0 ? <SteamPuff key={`puff-${clicks}`} still={reduce} /> : null}
          {celebration > 0 && !reduce ? <SparkBurst key={`sparks-${celebration}`} /> : null}
        </motion.div>
      </motion.div>
    </ViewportPortal>
  );
}
