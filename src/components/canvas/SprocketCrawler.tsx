"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ViewportPortal, useViewportStore, type ViewportStore } from "@xyflow/react";
import {
  AnimatePresence,
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  type MotionValue,
  type Variants,
} from "framer-motion";
import {
  GHOST_AFTERGLOW_MS,
  SPROCKET_ALERT_MS,
  SPROCKET_BUBBLE_MS,
  SPROCKET_INSPECT_MS,
  SPROCKET_SCURRY_MS,
  SPROCKET_SIZE,
  advanceQuipIndex,
  findWireDirection,
  getEdgeMidpoint,
  getPerchPosition,
  getTraversalPoint,
  pickInspectionTarget,
  resolveCardRect,
  selectSprocketQuip,
  type Point,
  type Rect,
} from "@/core/sprocket-engine";
import type { GhostDiscovery } from "@/core/types";
import { selectIsGhostScanning } from "@/store/ghost-selectors";
import { DEFAULT_CARD_SIZE, useMemexStore, type MemexStore } from "@/store/useMemexStore";

const SPRING = { type: "spring", stiffness: 300, damping: 28 } as const;
const SCURRY_S = SPROCKET_SCURRY_MS / 1000;

// Palette: obsidian, amber and phantom violet, plus the brass of the chassis.
const BRASS = "#D97706";
const BRASS_DARK = "#B45309";
const AMBER = "#FFB236";
const VIOLET = "#B388FF";
const OBSIDIAN = "#090A0F";
const SURFACE = "#141721";
const PARCHMENT = "#F4F1EA";

type SprocketMode = "perched" | "scurrying" | "alert" | "inspecting";

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

// ---------------------------------------------------------------------------
// Imperative choreography (no React state per frame: it writes motion values)
// ---------------------------------------------------------------------------

interface Activity {
  kind: "traverse" | "relocate" | "reaction";
  stop: () => void;
  discoveryId?: string;
  cardIds?: readonly string[];
}

interface ControllerDeps {
  x: MotionValue<number>;
  y: MotionValue<number>;
  opacity: MotionValue<number>;
  setMode: (mode: SprocketMode) => void;
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
  /** Cancels a reaction whose cards or synapse no longer exist. */
  validate: () => void;
  dispose: () => void;
}

function createController(deps: ControllerDeps): Controller {
  let current: Activity | null = null;
  // The motion values already hold the perch when a card existed at mount
  // (see `initialPerch`), so a controller created later starts out placed.
  let placed = perchOf(selectPerchId(useMemexStore.getState())) !== null;
  let disposed = false;

  const setPoint = (p: Point) => {
    deps.x.set(p.x);
    deps.y.set(p.y);
  };
  const currentPoint = (): Point => ({ x: deps.x.get(), y: deps.y.get() });
  const currentPerch = (): Point | null =>
    perchOf(selectPerchId(useMemexStore.getState()));

  /** Reduced motion: no travel, a quick fade in at the new spot. */
  const jump = (p: Point) => {
    setPoint(p);
    deps.opacity.set(0);
    animate(deps.opacity, 1, { duration: 0.2 });
  };

  const stop = () => {
    const a = current;
    current = null;
    a?.stop();
  };

  const settle = () => {
    current = null;
    if (disposed) return;
    deps.setMode("perched");
    const home = currentPerch();
    if (home) setPoint(home);
  };

  /** Runs `onFrame(k)` for k from 0 to 1 and calls `onDone` at the end. Returns a stop function. */
  const tween = (
    options: { spring?: boolean; onFrame: (k: number) => void; onDone: () => void },
  ): (() => void) => {
    const controls = animate(0, 1, {
      ...(options.spring ? SPRING : { duration: SCURRY_S, ease: "easeInOut" as const }),
      onUpdate: options.onFrame,
      onComplete: options.onDone,
    });
    return () => controls.stop();
  };

  const later = (ms: number, fn: () => void): (() => void) => {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  };

  return {
    place: () => {
      stop();
      deps.setMode("perched");
      const home = currentPerch();
      if (home) setPoint(home);
      placed = home !== null;
    },

    reset: () => {
      stop();
      placed = false;
      deps.setMode("perched");
    },

    traverse: (fromId, toId) => {
      stop();
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
      const act: Activity = { kind: "traverse", stop: () => undefined };
      current = act;
      deps.setMode("scurrying");
      act.stop = tween({
        onFrame: (k) => setPoint(getTraversalPoint(rectOf(fromId) ?? from, rectOf(toId) ?? to, k, direction)),
        onDone: () => {
          if (current === act) settle();
        },
      });
    },

    relocate: () => controllerRelocate(),

    react: (discovery) => {
      const source = rectOf(discovery.sourceId);
      const target = rectOf(discovery.targetId);
      if (!source || !target) return;
      stop();
      const clears: Array<() => void> = [];
      const act: Activity = {
        kind: "reaction",
        stop: () => clears.forEach((c) => c()),
        discoveryId: discovery.id,
        cardIds: [discovery.sourceId, discovery.targetId],
      };
      current = act;
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
        deps.setMode("scurrying");
        clears.push(
          tween({
            onFrame: (k) => setPoint(mix(start, currentPerch() ?? start, k)),
            onDone: () => {
              if (current === act) settle();
            },
          }),
        );
      };
      const arrive = () => {
        if (current !== act) return;
        deps.setMode("inspecting");
        clears.push(later(SPROCKET_INSPECT_MS, goBack));
      };
      const goToSynapse = () => {
        if (current !== act) return;
        if (deps.isReduced()) {
          jump(midpoint());
          arrive();
          return;
        }
        const start = currentPoint();
        deps.setMode("scurrying");
        clears.push(
          tween({
            onFrame: (k) => setPoint(mix(start, midpoint(), k)),
            onDone: arrive,
          }),
        );
      };
      deps.setMode("alert");
      clears.push(later(SPROCKET_ALERT_MS, goToSynapse));
    },

    follow: () => {
      if (current !== null || !placed) return;
      const home = currentPerch();
      if (home) setPoint(home);
    },

    validate: () => {
      const a = current;
      if (a === null || a.kind !== "reaction") return;
      const s = useMemexStore.getState();
      const cardsExist = (a.cardIds ?? []).every((id) => s.nodes.some((n) => n.id === id));
      const synapseExists = s.ghostDiscoveries.some((g) => g.id === a.discoveryId);
      if (cardsExist && synapseExists) return;
      stop();
      settle();
    },

    dispose: () => {
      disposed = true;
      stop();
    },
  };

  function controllerRelocate(): void {
    stop();
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
    const act: Activity = { kind: "relocate", stop: () => undefined };
    current = act;
    deps.setMode("scurrying");
    act.stop = tween({
      spring: true,
      onFrame: (k) => setPoint(mix(start, currentPerch() ?? target, k)),
      onDone: () => {
        if (current === act) settle();
      },
    });
  }
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
  scurrying: { y: 0, rotate: 0, transition: { duration: 0.15 } },
  alert: { y: 0, rotate: 0, transition: { duration: 0.15 } },
  inspecting: {
    y: 0,
    rotate: [0, -16, 14, -16, 14, 0],
    transition: { rotate: { duration: SPROCKET_INSPECT_MS / 1000, ease: "easeInOut" } },
  },
};
const STATIC_BODY_VARIANTS: Variants = {
  perched: { y: 0, rotate: 0 },
  scurrying: { y: 0, rotate: 0 },
  alert: { y: 0, rotate: 0 },
  inspecting: { y: 0, rotate: 0 },
};

function SprocketSprite({ awake, moving, still }: { awake: boolean; moving: boolean; still: boolean }) {
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
      {/* Eye socket, soft glow ring and the two eye colors (cross-faded by opacity). */}
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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Sprocket, the microfilm crawler. Lives in flow coordinates (a ViewportPortal
 * child), so it pans and zooms with the cards. Positions are written to motion
 * values, never React state, so scurrying causes no re-renders.
 */
export function SprocketCrawler() {
  const reduce = useReducedMotion() === true;
  const perchId = useMemexStore(selectPerchId);
  const activeTrailId = useMemexStore(selectActiveTrailId);
  const activeTrailIndex = useMemexStore(selectActiveTrailIndex);
  const scanning = useMemexStore(selectIsGhostScanning);
  const scale = useViewportStore(selectZoomScale);

  const [mode, setMode] = useState<SprocketMode>("perched");
  const [afterglow, setAfterglow] = useState(false);
  const [bubble, setBubble] = useState<{ key: number; text: string } | null>(null);
  const [clicks, setClicks] = useState(0);
  const [quipIndex, setQuipIndex] = useState(0);

  const [initialPerch] = useState<Point | null>(() =>
    perchOf(selectPerchId(useMemexStore.getState())),
  );
  const x = useMotionValue(initialPerch?.x ?? 0);
  const y = useMotionValue(initialPerch?.y ?? 0);
  const opacity = useMotionValue(1);

  const reducedRef = useRef(reduce);
  const controllerRef = useRef<Controller | null>(null);
  const previousRef = useRef<{ trailId: string | null; index: number; perchId: string | null } | null>(null);
  const bubbleTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    reducedRef.current = reduce;
  }, [reduce]);

  // Controller, store subscription and ghost reaction. One subscription: it
  // runs outside React, so card drags never re-render this component.
  useEffect(() => {
    const controller = createController({
      x,
      y,
      opacity,
      setMode,
      isReduced: () => reducedRef.current,
    });
    controllerRef.current = controller;

    let afterglowTimer: ReturnType<typeof setTimeout> | undefined;
    let before: readonly GhostDiscovery[] = [];
    let startKey = "";

    const unsubscribe = useMemexStore.subscribe((s, prev) => {
      if (s.nodes !== prev.nodes) controller.follow();
      if (s.nodes !== prev.nodes || s.ghostDiscoveries !== prev.ghostDiscoveries) controller.validate();
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

    return () => {
      unsubscribe();
      clearTimeout(afterglowTimer);
      controller.dispose();
      controllerRef.current = null;
    };
  }, [x, y, opacity]);

  // Placement: first sight, relocation, or a scurry when the trail moved one stop.
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

  const onActivate = useCallback(() => {
    const next = clicks + 1;
    setClicks(next);
    setBubble({ key: next, text: selectSprocketQuip(quipIndex) });
    setQuipIndex(advanceQuipIndex(quipIndex));
    clearTimeout(bubbleTimerRef.current);
    bubbleTimerRef.current = setTimeout(() => setBubble(null), SPROCKET_BUBBLE_MS);
  }, [clicks, quipIndex]);

  if (perchId === null) return null;

  const awake = scanning || afterglow;
  const moving = mode === "scurrying" && !reduce;

  return (
    <ViewportPortal>
      <motion.div
        className="nopan nodrag nowheel"
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
                  }}
                >
                  {bubble.text}
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
            <motion.span
              initial={false}
              animate={mode}
              variants={reduce ? STATIC_BODY_VARIANTS : BODY_VARIANTS}
              style={{ display: "block", width: SPROCKET_SIZE, height: SPROCKET_SIZE }}
            >
              {/* Click: a full mechanical turn (reduced motion: a brief flicker instead). */}
              <motion.span
                key={clicks}
                initial={clicks === 0 ? false : { rotate: 0, opacity: 1 }}
                animate={
                  clicks === 0
                    ? { rotate: 0, opacity: 1 }
                    : reduce
                      ? { rotate: 0, opacity: [1, 0.35, 1] }
                      : { rotate: [0, 360], opacity: 1 }
                }
                transition={{ duration: reduce ? 0.3 : 0.6, ease: [0.5, 0, 0.2, 1] }}
                style={{ display: "block", width: SPROCKET_SIZE, height: SPROCKET_SIZE }}
              >
                <SprocketSprite awake={awake} moving={moving} still={reduce} />
              </motion.span>
            </motion.span>
          </button>
          {clicks > 0 ? <SteamPuff key={`puff-${clicks}`} still={reduce} /> : null}
        </motion.div>
      </motion.div>
    </ViewportPortal>
  );
}
