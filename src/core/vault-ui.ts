import { MAX_BUNDLE_BYTES } from "./vault-bundle";

/**
 * Pure helpers for the Vault menu, the restore dialog and the canvas drop zone
 * (Spec 09, phase B). No React, no DOM, no clock: dates and file facts come in
 * as arguments.
 */

export const BUNDLE_EXTENSION = ".memex";

function two(n: number): string {
  return String(n).padStart(2, "0");
}

/** `YYYY-MM-DD` in the date's local calendar. An invalid date gives `1970-01-01`. */
export function dateStamp(date: Date): string {
  if (Number.isNaN(date.getTime())) return "1970-01-01";
  return `${String(date.getFullYear()).padStart(4, "0")}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

/** `memex-vault-YYYY-MM-DD.memex` */
export function bundleFilename(date: Date): string {
  return `memex-vault-${dateStamp(date)}${BUNDLE_EXTENSION}`;
}

/** `memex-obsidian-vault-YYYY-MM-DD.zip` */
export function obsidianZipFilename(date: Date): string {
  return `memex-obsidian-vault-${dateStamp(date)}.zip`;
}

/** True for a name ending in `.memex` (any case). */
export function isMemexFileName(name: string): boolean {
  return name.trim().toLowerCase().endsWith(BUNDLE_EXTENSION);
}

/** Files the restore picker accepts: `.memex` bundles and the legacy `.json` export. */
export function isRestorableFileName(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n.endsWith(BUNDLE_EXTENSION) || n.endsWith(".json");
}

export const RESTORE_ACCEPT = ".memex,.json,application/json";

export type FileSizeCheck = { ok: true } | { ok: false; message: string };

/** Size gate applied BEFORE a file is read. The limit is the importer's own (5 MB). */
export function checkBundleFileSize(size: number): FileSizeCheck {
  if (!Number.isFinite(size) || size < 0) return { ok: false, message: "The file size could not be read." };
  if (size === 0) return { ok: false, message: "The file is empty." };
  if (size > MAX_BUNDLE_BYTES) {
    return { ok: false, message: `The file is larger than the 5 MB limit (${(size / 1_000_000).toFixed(1)} MB).` };
  }
  return { ok: true };
}

/** What a drag carries, reduced to what the drop zone may read during `dragenter` and `dragover`. */
export interface DragProbe {
  /** `dataTransfer.types`. */
  types: readonly string[];
  /** Names of `dataTransfer.items` of kind file, when the browser exposes them during the drag (often it does not). */
  fileNames: readonly string[];
  /** Number of items of kind file, when known. */
  fileCount: number;
}

/** True when the drag carries files at all. */
export function dragHasFiles(types: readonly string[]): boolean {
  return types.includes("Files");
}

/**
 * Whether the canvas drop zone claims a drag (and may call `preventDefault`).
 * It needs files in the drag and no blocking dialog. Browsers hide file names
 * until the drop, so unless a name is visible and is not `.memex`/`.json`, the
 * drag is claimed and judged on drop.
 */
export function shouldClaimFileDrag(probe: DragProbe, modalOpen: boolean): boolean {
  if (modalOpen || !dragHasFiles(probe.types)) return false;
  if (probe.fileNames.length > 0) return probe.fileNames.some(isMemexFileName);
  return true;
}

/**
 * On drop: the first file decides. Only a `.memex` name restores a vault from a
 * drop (a `.json` file dropped on the canvas is left alone; the Vault menu
 * restores those). Anything else is ignored with no side effect.
 */
export function pickDroppedBundle<T extends { name: string }>(files: readonly T[]): T | null {
  const first = files[0];
  return first !== undefined && isMemexFileName(first.name) ? first : null;
}

export interface GraphCounts {
  cards: number;
  edges: number;
  trails: number;
}

/** "This replaces your current canvas (N cards, M edges, K trails) with the bundle's (...)". */
export function restoreSummary(current: GraphCounts, incoming: GraphCounts): string {
  const part = (c: GraphCounts): string =>
    `${c.cards} ${c.cards === 1 ? "card" : "cards"}, ${c.edges} ${c.edges === 1 ? "edge" : "edges"}, ${c.trails} ${c.trails === 1 ? "trail" : "trails"}`;
  return `This replaces your current canvas (${part(current)}) with the bundle's (${part(incoming)}).`;
}

/** Toast text after a successful restore. */
export function restoreToastMessage(incoming: GraphCounts): string {
  return `Vault restored: ${incoming.cards} ${incoming.cards === 1 ? "card" : "cards"}, ${incoming.edges} ${incoming.edges === 1 ? "edge" : "edges"}, ${incoming.trails} ${incoming.trails === 1 ? "trail" : "trails"}.`;
}
