"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Panel } from "@xyflow/react";
import { RESTORE_ACCEPT } from "@/core/vault-ui";
import { selectVaultBusy, stageRestoreFile, useVaultSession } from "@/store/useVaultSession";
import { downloadBackup, downloadObsidianVault } from "./vault-io";

const ITEM_CLASS =
  "flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-left font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-text-primary transition-colors duration-100 hover:bg-white/5 hover:text-[#FFB236] focus-visible:bg-white/5 focus-visible:text-[#FFB236] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[#FFB236] disabled:cursor-not-allowed disabled:opacity-40";

type ItemId = "backup" | "restore" | "obsidian";

/**
 * The Vault menu (Spec 09), a compact item in the top bar (top-centre, where
 * the old Trails trigger sat). A disclosure menu: `aria-haspopup="menu"`,
 * `aria-expanded`, `role="menu"` with `role="menuitem"` buttons, roving focus
 * with the arrow keys, Home and End; Escape and an outside click close it and
 * Escape returns focus to the button.
 *
 * Items: download a `.memex` backup, restore a `.memex` (or legacy `.json`)
 * file through a confirmation dialog, export the Obsidian vault as a ZIP.
 * Restoring is destructive, so the picker only STAGES the file; the dialog
 * (`BundleImportDialog`) applies it.
 */
export function VaultMenu() {
  const [open, setOpen] = useState(false);
  const busy = useVaultSession(selectVaultBusy);
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const items = (): HTMLButtonElement[] =>
    Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? []);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus({ preventScroll: true });
  }, []);

  // Focus the first item when the menu opens.
  useEffect(() => {
    if (open) items()[0]?.focus({ preventScroll: true });
  }, [open]);

  // Outside click closes (without stealing focus from what was clicked).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (e.target instanceof Node && rootRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    // Backspace and Delete delete the selected cards (React Flow listens on the document).
    if (e.key === "Backspace" || e.key === "Delete") {
      e.stopPropagation();
      return;
    }
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        close(true);
        return;
      case "ArrowDown":
        e.preventDefault();
        list[(at + 1) % list.length]?.focus();
        return;
      case "ArrowUp":
        e.preventDefault();
        list[(at - 1 + list.length) % list.length]?.focus();
        return;
      case "Home":
        e.preventDefault();
        list[0]?.focus();
        return;
      case "End":
        e.preventDefault();
        list[list.length - 1]?.focus();
        return;
      case "Tab":
        // Do not trap focus: Tab leaves the menu and closes it.
        setOpen(false);
        return;
    }
  };

  const onButtonKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Backspace" || e.key === "Delete") {
      e.stopPropagation();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
    }
  };

  const choose = (id: ItemId) => {
    switch (id) {
      case "backup":
        close(true);
        downloadBackup();
        return;
      case "restore":
        // The picker opens first; the dialog (which takes focus) follows once a file is chosen.
        close(false);
        fileRef.current?.click();
        return;
      case "obsidian":
        close(true);
        void downloadObsidianVault();
        return;
    }
  };

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.item(0) ?? null;
    // Reset so choosing the same file again fires `change`.
    e.target.value = "";
    if (file !== null) void stageRestoreFile(file);
  };

  return (
    <Panel position="top-center" className="!m-4">
      <div ref={rootRef} className="relative">
        <button
          ref={buttonRef}
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          aria-label="Vault: backup, restore and export"
          aria-busy={busy !== null}
          onClick={() => setOpen((o) => !o)}
          onKeyDown={onButtonKeyDown}
          className="flex cursor-pointer items-center gap-2 rounded-xl border border-[#FFB236]/50 bg-gradient-to-b from-[#141721] to-[#090A0F] px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-[#FFB236] shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_2px_0_rgba(0,0,0,0.65),0_6px_14px_rgba(0,0,0,0.4)] transition-[color,border-color,box-shadow,transform] duration-100 hover:border-[#FFB236] active:translate-y-[2px] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[#FFB236]"
          style={open ? { borderColor: "#FFB236" } : undefined}
        >
          <span aria-hidden="true">[💾 VAULT]</span>
        </button>
        {open ? (
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label="Vault"
            onKeyDown={onMenuKeyDown}
            className="absolute top-full left-0 z-50 mt-2 w-[270px] rounded-2xl border border-[rgba(255,178,54,0.2)] bg-[#141721] p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_16px_40px_rgba(0,0,0,0.7)]"
          >
            <button type="button" role="menuitem" className={ITEM_CLASS} onClick={() => choose("backup")}>
              <span aria-hidden="true">⬇</span> Download .memex Backup
            </button>
            <button type="button" role="menuitem" className={ITEM_CLASS} onClick={() => choose("restore")}>
              <span aria-hidden="true">⬆</span> Restore .memex File
            </button>
            <button
              type="button"
              role="menuitem"
              className={ITEM_CLASS}
              disabled={busy === "obsidian"}
              onClick={() => choose("obsidian")}
            >
              <span aria-hidden="true">🗃</span>
              {busy === "obsidian" ? "Building Obsidian ZIP…" : "Export Obsidian Vault (.zip)"}
            </button>
          </div>
        ) : null}
        <input
          ref={fileRef}
          type="file"
          accept={RESTORE_ACCEPT}
          onChange={onFile}
          tabIndex={-1}
          className="hidden"
        />
      </div>
    </Panel>
  );
}
