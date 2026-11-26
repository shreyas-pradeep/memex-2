"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import {
  MAX_SOURCE_BYTES,
  distillSourceText,
  parsePastedText,
  parseSourceFile,
  pickIngestionBase,
  type ParsedSource,
} from "@/core/ingestion-engine";
import { useMemexStore } from "@/store/useMemexStore";

type Tab = "file" | "text";

/** Minimum time the scan bar sweeps, so the platen feels like a physical pass. */
export const PLATEN_SCAN_MS = 900;
const SPRING = { type: "spring", stiffness: 300, damping: 28 } as const;
const LABEL_CLASS = "font-mono text-[10px] uppercase tracking-[0.16em] text-text-muted";
const FIELD_CLASS =
  "w-full rounded-xl border border-[#FFB236]/40 bg-[#090A0F] px-3 py-2 text-[13px] text-text-primary outline-none focus:border-[#FFB236]";

interface ModalProps {
  onClose: () => void;
  /** Receives the IDs of the cards added, so the canvas can glide to them. */
  onIngested: (ids: string[]) => void;
}

function formatKb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function ModalBody({ onClose, onIngested }: ModalProps) {
  const [tab, setTab] = useState<Tab>("file");
  const [dragging, setDragging] = useState(false);
  const [file, setFile] = useState<{ name: string; size: number; parsed: ParsedSource } | null>(null);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => {
      clearTimeout(timerRef.current);
      previous?.focus();
    };
  }, []);

  const loadFile = useCallback(async (f: File) => {
    setError(null);
    setFile(null);
    if (f.size > MAX_SOURCE_BYTES) {
      setError(`"${f.name}" is too large. The limit is ${MAX_SOURCE_BYTES / 1_048_576} MB.`);
      return;
    }
    let content: string;
    try {
      content = await f.text();
    } catch {
      setError(`Could not read "${f.name}".`);
      return;
    }
    const parsed = parseSourceFile(f.name, content);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    setFile({ name: f.name, size: f.size, parsed });
  }, []);

  const onDrop = (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    setDragging(false);
    const dropped = e.dataTransfer.files.item(0);
    if (dropped) void loadFile(dropped);
  };

  const scan = () => {
    if (scanning) return;
    const parsed: ParsedSource | null =
      tab === "file" ? (file?.parsed ?? null) : parsePastedText(title, text);
    if (parsed === null) {
      setError("Drop or choose a file first.");
      return;
    }
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    setError(null);
    setScanning(true);
    timerRef.current = setTimeout(() => {
      const { nodes, ingestSource } = useMemexStore.getState();
      const distilled = distillSourceText(parsed.title, parsed.text, pickIngestionBase(nodes), {
        existingIds: nodes.map((n) => n.id),
        createdAt: new Date().toISOString(),
      });
      const ids = ingestSource(distilled.nodes, distilled.edges);
      onIngested(ids);
      onClose();
    }, PLATEN_SCAN_MS);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Keep canvas shortcuts (I, Backspace/Delete, arrows) away from the dialog.
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "Tab" && dialogRef.current) {
      const items = [
        ...dialogRef.current.querySelectorAll<HTMLElement>(
          "input:not([type=file]), textarea, button:not([disabled])",
        ),
      ];
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === dialogRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  const tabButton = (id: Tab, label: string) => (
    <button
      type="button"
      role="tab"
      id={`platen-tab-${id}`}
      aria-selected={tab === id}
      aria-controls={`platen-panel-${id}`}
      onClick={() => {
        setTab(id);
        setError(null);
      }}
      className="flex-1 cursor-pointer rounded-xl border px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] transition-colors duration-100"
      style={
        tab === id
          ? { color: "#090A0F", background: "#FFB236", borderColor: "#FFB236" }
          : { color: "#FFB236", background: "#141721", borderColor: "rgba(255,178,54,0.4)" }
      }
    >
      {label}
    </button>
  );

  const canScan = tab === "file" ? file !== null : text.trim() !== "";

  return (
    <div
      className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/70 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={onKeyDown}
    >
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="platen-title"
        tabIndex={-1}
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={SPRING}
        className="relative flex max-h-full w-full max-w-[560px] flex-col gap-3 overflow-y-auto rounded-2xl border border-[rgba(255,178,54,0.18)] bg-[#141721] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_24px_60px_rgba(0,0,0,0.8)] outline-none"
      >
        <div>
          <div className={LABEL_CLASS}>Platen Scanner · Archival Ingestion</div>
          <h2 id="platen-title" className="font-serif text-xl font-semibold text-text-primary">
            Ingest Source
          </h2>
        </div>

        <div role="tablist" aria-label="Source type" className="flex gap-2">
          {tabButton("file", "File Drop")}
          {tabButton("text", "Direct Raw Text / Paper Abstract")}
        </div>

        {tab === "file" ? (
          <div role="tabpanel" id="platen-panel-file" aria-labelledby="platen-tab-file">
            <button
              type="button"
              onClick={() => pickerRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className="flex h-40 w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed bg-[#090A0F] px-4 text-center transition-colors duration-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[#FFB236]"
              style={{ borderColor: dragging ? "#FFB236" : "rgba(255,178,54,0.35)" }}
            >
              <span aria-hidden="true" className="font-mono text-2xl text-[#FFB236]">
                +
              </span>
              {file ? (
                <>
                  <span className="font-serif text-[15px] text-text-primary">{file.name}</span>
                  <span className="font-mono text-[11px] text-text-muted">
                    {formatKb(file.size)} · {file.parsed.ok ? file.parsed.format.toUpperCase() : ""} · ready
                  </span>
                </>
              ) : (
                <>
                  <span className="font-serif text-[15px] text-text-primary">
                    Drop a document on the platen, or click to choose
                  </span>
                  <span className="font-mono text-[11px] text-text-muted">
                    .txt · .md · .json · max {MAX_SOURCE_BYTES / 1_048_576} MB
                  </span>
                </>
              )}
            </button>
            <input
              ref={pickerRef}
              type="file"
              accept=".txt,.md,.markdown,.json,text/plain,text/markdown,application/json"
              tabIndex={-1}
              aria-label="Choose a source file"
              className="hidden"
              onChange={(e) => {
                const chosen = e.target.files?.item(0);
                if (chosen) void loadFile(chosen);
                e.target.value = "";
              }}
            />
          </div>
        ) : (
          <div
            role="tabpanel"
            id="platen-panel-text"
            aria-labelledby="platen-tab-text"
            className="flex flex-col gap-3"
          >
            <label className="flex flex-col gap-1">
              <span className={LABEL_CLASS}>Title (optional)</span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Untitled Source"
                className={`${FIELD_CLASS} font-serif text-[16px]`}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className={LABEL_CLASS}>Text or abstract</span>
              <textarea
                rows={8}
                value={text}
                onChange={(e) => setText(e.target.value)}
                className={`${FIELD_CLASS} resize-none leading-relaxed`}
              />
            </label>
          </div>
        )}

        {error ? (
          <p role="alert" className="font-mono text-[11px] text-[#B388FF]">
            {error}
          </p>
        ) : null}

        <div className="relative mt-1 flex items-center justify-end gap-2 overflow-hidden rounded-xl">
          {scanning ? (
            <motion.div
              aria-hidden="true"
              className="pointer-events-none absolute left-0 top-0 h-[2px] w-full bg-[#FFB236]"
              style={{ boxShadow: "0 0 12px 2px rgba(255,178,54,0.7)" }}
              initial={{ y: 0, opacity: 0.9 }}
              animate={{ y: [0, 38, 0], opacity: [0.9, 1, 0.9] }}
              transition={{ duration: 0.9, ease: "linear", repeat: Infinity }}
            />
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-xl border border-white/10 px-4 py-2 font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-text-muted hover:text-text-primary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={scan}
            disabled={!canScan || scanning}
            aria-busy={scanning}
            className="cursor-pointer rounded-xl border border-[#FFB236] bg-[#FFB236] px-4 py-2 font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-[#090A0F] shadow-[0_2px_0_rgba(0,0,0,0.65)] hover:brightness-110 active:translate-y-[2px] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {scanning ? "Scanning…" : "Scan into platen"}
          </button>
        </div>
        <div role="status" aria-live="polite" className="sr-only">
          {scanning ? "Scanning source into the platen" : ""}
        </div>
      </motion.div>
    </div>
  );
}

interface IngestionPlatenModalProps extends ModalProps {
  open: boolean;
}

/** Platen Scanner dialog. Its state resets each time it opens. */
export function IngestionPlatenModal({ open, onClose, onIngested }: IngestionPlatenModalProps) {
  if (!open || typeof document === "undefined") return null;
  return createPortal(<ModalBody onClose={onClose} onIngested={onIngested} />, document.body);
}
