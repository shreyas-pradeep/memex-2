/**
 * Browser-side AI settings. The optional user Gemini key lives only in
 * localStorage under `GEMINI_KEY_STORAGE`; it is sent solely to this app's
 * `/api/ghost` route (header `x-gemini-api-key`) and never logged.
 */

export const GEMINI_KEY_STORAGE = "memex-2:gemini-key:v1";
export const GEMINI_KEY_HEADER = "x-gemini-api-key";

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The saved key, or `""` when absent or storage is unavailable. */
export function loadUserGeminiKey(): string {
  try {
    return storage()?.getItem(GEMINI_KEY_STORAGE)?.trim() ?? "";
  } catch {
    return "";
  }
}

/** Saves the key; returns false when storage is unavailable or the key is empty. */
export function saveUserGeminiKey(key: string): boolean {
  const trimmed = key.trim();
  const s = storage();
  if (!s || trimmed === "") return false;
  try {
    s.setItem(GEMINI_KEY_STORAGE, trimmed);
    return true;
  } catch {
    return false;
  }
}

export function clearUserGeminiKey(): void {
  try {
    storage()?.removeItem(GEMINI_KEY_STORAGE);
  } catch {
    // Storage unavailable: nothing to clear.
  }
}

/** `AIza…wxyz` style mask; never reveals the middle of the key. */
export function maskKey(key: string): string {
  if (key.length <= 8) return "•".repeat(Math.max(key.length, 4));
  return `${key.slice(0, 2)}${"•".repeat(8)}${key.slice(-2)}`;
}
