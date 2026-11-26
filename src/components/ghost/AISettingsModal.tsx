"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import {
  clearUserGeminiKey,
  loadUserGeminiKey,
  maskKey,
  saveUserGeminiKey,
} from "@/store/ai-settings";

const LABEL_CLASS = "font-mono text-[10px] uppercase tracking-[0.16em] text-text-muted";
const FIELD_CLASS =
  "w-full rounded-xl border border-[#B388FF]/40 bg-[#141721] px-3 py-2 font-mono text-[12px] text-text-primary outline-none focus:border-[#B388FF]";

interface AISettingsModalProps {
  open: boolean;
  onClose: () => void;
  /** Called after the saved key is added or removed. */
  onKeyChange: (hasKey: boolean) => void;
}

function ModalBody({ onClose, onKeyChange }: Omit<AISettingsModalProps, "open">) {
  // Only the masked form is ever kept for display; the full key is never rendered.
  const [saved, setSaved] = useState(() => {
    const key = loadUserGeminiKey();
    return key === "" ? null : maskKey(key);
  });
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => previous?.focus();
  }, []);

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (draft.trim() === "") {
      setError("Paste a key first.");
      return;
    }
    if (!saveUserGeminiKey(draft)) {
      setError("This browser blocked local storage, so the key could not be saved.");
      return;
    }
    setSaved(maskKey(draft.trim()));
    setDraft("");
    setError(null);
    onKeyChange(true);
  };

  const clear = () => {
    clearUserGeminiKey();
    setSaved(null);
    setError(null);
    onKeyChange(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation(); // keep canvas shortcuts (Backspace/Delete) away from the field
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "Tab" && dialogRef.current) {
      // Keep focus inside the dialog.
      const items = dialogRef.current.querySelectorAll<HTMLElement>("input, button:not([disabled])");
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div
      className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/70 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={onKeyDown}
    >
      <form
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-settings-title"
        onSubmit={save}
        className="flex w-full max-w-[440px] flex-col gap-3 rounded-2xl border border-white/10 bg-[#141721] p-5 shadow-[0_24px_60px_rgba(0,0,0,0.8)]"
      >
        <div>
          <div className={LABEL_CLASS}>Ghost Engine</div>
          <h2 id="ai-settings-title" className="font-serif text-xl font-semibold text-text-primary">
            AI Settings
          </h2>
        </div>
        <p className="font-serif text-[12px] leading-snug text-text-muted">
          Optional. Add a free Gemini API key to let the Ghost use a live model. Without one, the
          built-in neural engine runs offline. The key stays in this browser and is sent only to
          this app&apos;s /api/ghost route, which uses it for the Gemini call.
        </p>

        <div className="flex flex-col gap-1">
          <label htmlFor="ai-settings-key" className={LABEL_CLASS}>
            Gemini API key
          </label>
          <input
            ref={inputRef}
            id="ai-settings-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={saved ? "Paste a new key to replace" : "Paste key"}
            className={FIELD_CLASS}
          />
          <div role="status" aria-live="polite" className="font-mono text-[11px] text-text-muted">
            {saved ? `Saved key: ${saved}` : "No key saved."}
          </div>
          {error ? (
            <p role="alert" className="font-mono text-[11px] text-[#FFB236]">
              {error}
            </p>
          ) : null}
        </div>

        <div className="mt-1 flex justify-end gap-2">
          {saved ? (
            <button
              type="button"
              onClick={clear}
              className="cursor-pointer rounded-xl border border-white/15 px-3 py-2 font-mono text-[11px] uppercase tracking-[0.16em] text-text-muted hover:border-[#FFB236] hover:text-[#FFB236]"
            >
              Clear key
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-xl border border-white/15 px-3 py-2 font-mono text-[11px] uppercase tracking-[0.16em] text-text-muted hover:border-white/40"
          >
            Close
          </button>
          <button
            type="submit"
            className="cursor-pointer rounded-xl border border-[#B388FF] bg-[#B388FF] px-4 py-2 font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-[#090A0F] hover:brightness-110"
          >
            Save key
          </button>
        </div>
      </form>
    </div>
  );
}

/** Dialog for saving or clearing the optional Gemini key. State resets on each open. */
export function AISettingsModal({ open, onClose, onKeyChange }: AISettingsModalProps) {
  if (!open || typeof document === "undefined") return null;
  return createPortal(<ModalBody onClose={onClose} onKeyChange={onKeyChange} />, document.body);
}
