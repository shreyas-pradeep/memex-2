import { create } from "zustand";
import { checkBundleFileSize, type GraphCounts } from "@/core/vault-ui";
import { validateAndImportBundle, type BundleImportResult } from "@/core/vault-bundle";
import { useMemexStore } from "./useMemexStore";

/**
 * The restore flow of the Vault menu (Spec 09). Session-only: this store is
 * separate from `useMemexStore`, so none of it reaches `persistGraph`, an export
 * or hydration (the same arrangement as the toast and briefing stores).
 *
 * A file (picked or dropped) is read as text and `stage`d: it is validated
 * without touching the canvas and the result waits as `pending` until the
 * confirmation dialog applies (`importBundle`) or cancels it.
 */
export interface PendingRestore {
  fileName: string;
  /** The raw text, applied by `importBundle` on confirm (which validates again). */
  text: string;
  /** Outcome of validating the text; `ok: false` shows errors and offers no confirm button. */
  result: BundleImportResult;
  /** Counts of the canvas that would be replaced, read when the file was staged. */
  current: GraphCounts;
}

export type VaultBusy = "backup" | "obsidian" | null;

interface VaultSession {
  pending: PendingRestore | null;
  busy: VaultBusy;
  /** Validates `text` and opens the confirmation. Nothing changes on the canvas. */
  stageText: (fileName: string, text: string) => void;
  /** Opens the confirmation with an error that stopped the file from being read (too large, unreadable). */
  stageError: (fileName: string, message: string) => void;
  cancel: () => void;
  setBusy: (busy: VaultBusy) => void;
}

function currentCounts(): GraphCounts {
  const { nodes, edges, trails } = useMemexStore.getState();
  return { cards: nodes.length, edges: edges.length, trails: trails.length };
}

export const useVaultSession = create<VaultSession>()((set) => ({
  pending: null,
  busy: null,
  stageText: (fileName, text) =>
    set({ pending: { fileName, text, result: validateAndImportBundle(text), current: currentCounts() } }),
  stageError: (fileName, message) =>
    set({ pending: { fileName, text: "", result: { ok: false, errors: [message] }, current: currentCounts() } }),
  cancel: () => set({ pending: null }),
  setBusy: (busy) => set({ busy }),
}));

export const selectPendingRestore = (s: VaultSession) => s.pending;
export const selectVaultBusy = (s: VaultSession) => s.busy;

/** Counts of the cards, edges and trails a validated bundle holds. */
export function incomingCounts(result: BundleImportResult): GraphCounts | null {
  return result.ok
    ? { cards: result.state.nodes.length, edges: result.state.edges.length, trails: result.state.trails.length }
    : null;
}

/**
 * Reads a chosen or dropped file and stages it. The size check runs BEFORE the
 * file is read, so an oversized file is never loaded into memory. Never throws.
 */
export async function stageRestoreFile(file: Pick<File, "name" | "size" | "text">): Promise<void> {
  const size = checkBundleFileSize(file.size);
  if (!size.ok) {
    useVaultSession.getState().stageError(file.name, size.message);
    return;
  }
  try {
    const text = await file.text();
    useVaultSession.getState().stageText(file.name, text);
  } catch {
    useVaultSession.getState().stageError(file.name, "The file could not be read.");
  }
}
