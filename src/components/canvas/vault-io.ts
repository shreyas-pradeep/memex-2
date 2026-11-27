import { bundleFilename, obsidianZipFilename } from "@/core/vault-ui";
import { showToast } from "@/store/useToastStore";
import { useMemexStore } from "@/store/useMemexStore";
import { useVaultSession } from "@/store/useVaultSession";

/** Delay before the object URL is revoked, so the browser has started the download. */
const REVOKE_AFTER_MS = 1000;

/** Saves a Blob as a file through an object URL, which is revoked afterwards. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
}

/** Downloads the current workspace as `memex-vault-YYYY-MM-DD.memex`. The bundle never holds a key. Returns success. */
export function downloadBackup(): boolean {
  try {
    const json = useMemexStore.getState().exportBundleJson();
    downloadBlob(new Blob([json], { type: "application/json;charset=utf-8" }), bundleFilename(new Date()));
    return true;
  } catch {
    showToast("VAULT_ERROR", "The backup could not be written. Nothing was changed.");
    return false;
  }
}

/** Builds and downloads the Obsidian vault ZIP, with a busy flag and a toast for each outcome. */
export async function downloadObsidianVault(): Promise<void> {
  const session = useVaultSession.getState();
  if (session.busy !== null) return;
  session.setBusy("obsidian");
  try {
    const blob = await useMemexStore.getState().exportObsidianZip();
    downloadBlob(blob, obsidianZipFilename(new Date()));
    const cards = useMemexStore.getState().nodes.length;
    showToast("VAULT", `Obsidian vault exported: ${cards} ${cards === 1 ? "note" : "notes"} in a .zip.`);
  } catch {
    showToast("VAULT_ERROR", "The Obsidian export failed. Nothing was changed.");
  } finally {
    useVaultSession.getState().setBusy(null);
  }
}
