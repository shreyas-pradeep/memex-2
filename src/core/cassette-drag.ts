import { nodeRect, type Rect } from "./card-geometry";
import { cassetteBounds, groupCassettes } from "./cassette-engine";
import type { MemexNode } from "./types";

/**
 * Pure helpers for dragging and nudging a microfiche cassette (Spec 09, phase
 * B): pointer deltas to flow deltas, keyboard nudge steps, label text. No React,
 * no DOM, no clock.
 */

/** One drawn cassette: its frame rectangle (flow coordinates) and label data. */
export interface CassetteFrameModel {
  id: string;
  title: string;
  count: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Frames of every cassette on the canvas in one pass over the cards (the
 * result equals `cassetteFrame` per cassette). Cassettes whose members have no
 * usable position are left out.
 */
export function buildCassetteFrames(nodes: readonly MemexNode[]): CassetteFrameModel[] {
  const rects = new Map<string, Rect[]>();
  for (const n of nodes) {
    const cid = n.data.cassetteId;
    if (typeof cid !== "string" || cid === "") continue;
    const r = nodeRect(n);
    if (r === null) continue;
    const list = rects.get(cid);
    if (list === undefined) rects.set(cid, [r]);
    else list.push(r);
  }
  if (rects.size === 0) return [];
  const out: CassetteFrameModel[] = [];
  for (const c of groupCassettes(nodes)) {
    const frame = cassetteBounds(rects.get(c.id) ?? []);
    if (frame === null) continue;
    out.push({ id: c.id, title: c.title, count: c.memberIds.length, ...frame });
  }
  return out;
}

/** Arrow-key nudge (flow px) and the Shift multiplier step. */
export const CASSETTE_NUDGE_PX = 10;
export const CASSETTE_NUDGE_SHIFT_PX = 50;
/** Longest cassette title shown in the label tab (characters). */
export const CASSETTE_LABEL_MAX = 44;

/**
 * Converts a screen-space pointer delta into a flow-space delta: divided by the
 * current zoom. An invalid delta or a zoom that is not a positive finite number
 * gives `{ dx: 0, dy: 0 }`, so a bad frame never teleports the cards.
 */
export function cassetteDragDelta(
  screenDx: number,
  screenDy: number,
  zoom: number,
): { dx: number; dy: number } {
  if (!Number.isFinite(screenDx) || !Number.isFinite(screenDy) || !Number.isFinite(zoom) || zoom <= 0) {
    return { dx: 0, dy: 0 };
  }
  return { dx: screenDx / zoom, dy: screenDy / zoom };
}

/**
 * Keyboard nudge for an arrow key: 10 px, or 50 px with Shift (flow px, so the
 * move is the same at every zoom). `null` for any other key (Enter and Space do
 * nothing here).
 */
export function cassetteNudge(key: string, shiftKey: boolean): { dx: number; dy: number } | null {
  const step = shiftKey ? CASSETTE_NUDGE_SHIFT_PX : CASSETTE_NUDGE_PX;
  switch (key) {
    case "ArrowLeft":
      return { dx: -step, dy: 0 };
    case "ArrowRight":
      return { dx: step, dy: 0 };
    case "ArrowUp":
      return { dx: 0, dy: -step };
    case "ArrowDown":
      return { dx: 0, dy: step };
    default:
      return null;
  }
}

/** Sums pointer deltas collected between two animation frames. */
export function accumulateDelta(
  pending: { dx: number; dy: number },
  dx: number,
  dy: number,
): { dx: number; dy: number } {
  return {
    dx: pending.dx + (Number.isFinite(dx) ? dx : 0),
    dy: pending.dy + (Number.isFinite(dy) ? dy : 0),
  };
}

/** Inverse of `cassetteFramesSignature`; malformed input gives `[]`. */
export function parseCassetteFramesSignature(signature: string): CassetteFrameModel[] {
  if (signature === "") return [];
  try {
    const raw: unknown = JSON.parse(signature);
    if (!Array.isArray(raw)) return [];
    const out: CassetteFrameModel[] = [];
    for (const row of raw as unknown[]) {
      if (!Array.isArray(row) || row.length !== 7) continue;
      const [id, title, count, x, y, width, height] = row as unknown[];
      if (
        typeof id === "string" &&
        typeof title === "string" &&
        typeof count === "number" &&
        typeof x === "number" &&
        typeof y === "number" &&
        typeof width === "number" &&
        typeof height === "number"
      ) {
        out.push({ id, title, count, x, y, width, height });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Label tab text: `[🗂️ CASSETTE: title]`, the title cut to `CASSETTE_LABEL_MAX` characters. */
export function cassetteLabelText(title: string): string {
  const clean = title.replace(/\s+/g, " ").trim();
  const chars = [...clean];
  const shown =
    chars.length <= CASSETTE_LABEL_MAX ? clean : `${chars.slice(0, CASSETTE_LABEL_MAX - 1).join("").trimEnd()}…`;
  return `[🗂️ CASSETTE: ${shown === "" ? "untitled" : shown}]`;
}

/** Accessible name of the label tab. */
export function cassetteAriaLabel(title: string, memberCount: number): string {
  const n = Number.isFinite(memberCount) ? Math.max(0, Math.floor(memberCount)) : 0;
  return `Cassette ${title.trim() === "" ? "untitled" : title.trim()}, ${n} ${n === 1 ? "card" : "cards"}. Drag to move together, or use the arrow keys.`;
}

/**
 * Signature of everything a cassette frame depends on: member ids and rects.
 * A drag of a non-member leaves it unchanged, so the overlay does not re-render.
 */
export function cassetteFramesSignature(
  frames: readonly { id: string; title: string; count: number; x: number; y: number; width: number; height: number }[],
): string {
  return JSON.stringify(frames.map((f) => [f.id, f.title, f.count, f.x, f.y, f.width, f.height]));
}
