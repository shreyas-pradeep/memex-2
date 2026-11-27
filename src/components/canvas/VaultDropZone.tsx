"use client";

import { useEffect, useState } from "react";
import { pickDroppedBundle, shouldClaimFileDrag, type DragProbe } from "@/core/vault-ui";
import { stageRestoreFile } from "@/store/useVaultSession";
import { isModalDialogOpen } from "../trails/key-context";

function probeOf(e: DragEvent): DragProbe {
  const dt = e.dataTransfer;
  const items = dt?.items ? Array.from(dt.items) : [];
  return {
    types: dt ? Array.from(dt.types) : [],
    // Browsers hide file names until the drop, so none is read here.
    fileNames: [],
    fileCount: items.filter((i) => i.kind === "file").length,
  };
}

/**
 * Whole-canvas drop zone for `.memex` vault files (Spec 09). Window-level
 * `dragenter` / `dragover` / `dragleave` / `drop` listeners:
 *
 * - They react only to drags that carry files (`dataTransfer.types` includes
 *   "Files") and only while no modal dialog is open, so the Platen's own drop
 *   zone and the restore dialog are left alone.
 * - `preventDefault` is called only for a drag it claims; on drop only when the
 *   first file's name ends in `.memex`. Any other file is ignored, untouched.
 * - A claimed drag shows a full-canvas affordance (opacity only) that says
 *   "DROP .memex VAULT TO RESTORE".
 * - A dropped bundle goes through the same staging and confirmation as the
 *   Vault menu, so nothing is replaced without the dialog.
 */
export function VaultDropZone() {
  const [active, setActive] = useState(false);

  useEffect(() => {
    let depth = 0;
    let claimed = false;

    const reset = () => {
      depth = 0;
      claimed = false;
      setActive(false);
    };

    const onEnter = (e: DragEvent) => {
      if (!shouldClaimFileDrag(probeOf(e), isModalDialogOpen())) return;
      e.preventDefault();
      depth += 1;
      claimed = true;
      setActive(true);
    };

    const onOver = (e: DragEvent) => {
      if (!shouldClaimFileDrag(probeOf(e), isModalDialogOpen())) {
        if (claimed) reset();
        return;
      }
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      if (!claimed) {
        claimed = true;
        setActive(true);
      }
    };

    const onLeave = () => {
      if (!claimed) return;
      depth -= 1;
      if (depth <= 0) reset();
    };

    const onDrop = (e: DragEvent) => {
      const wasClaimed = claimed;
      reset();
      if (!wasClaimed || isModalDialogOpen()) return;
      const file = pickDroppedBundle(Array.from(e.dataTransfer?.files ?? []));
      // Not a .memex file: leave the event alone (no preventDefault).
      if (file === null) return;
      e.preventDefault();
      void stageRestoreFile(file);
    };

    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("blur", reset);
    };
  }, []);

  return (
    <div
      aria-hidden="true"
      data-vault-drop={active ? "active" : "idle"}
      className="pointer-events-none fixed inset-0 z-[1900] flex items-center justify-center p-6"
      style={{ opacity: active ? 1 : 0, transition: "opacity 150ms ease", background: "rgba(9, 10, 15, 0.72)" }}
    >
      <div
        className="rounded-2xl border-2 border-dashed px-10 py-8 text-center font-mono text-[14px] font-semibold uppercase tracking-[0.2em]"
        style={{ borderColor: "#FFB236", color: "#FFB236", background: "#141721" }}
      >
        DROP .memex VAULT TO RESTORE
      </div>
    </div>
  );
}
