"use client";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { briefingFilename } from "@/core/synthesis-engine";

const SPRING = { type: "spring", stiffness: 300, damping: 28 } as const;
/** How long the "COPIED TO CLIPBOARD" confirmation stays. */
export const COPIED_MS = 2000;

const LABEL_CLASS = "font-mono text-[10px] uppercase tracking-[0.16em] text-text-muted";
const BUTTON_CLASS =
  "cursor-pointer rounded-xl border px-4 py-2 font-mono text-[11px] font-semibold uppercase tracking-[0.16em] transition-[color,border-color,box-shadow] duration-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[#FFB236]";

type LineKind = "fence" | "key" | "h1" | "h2" | "h3" | "quote" | "plain";

interface PreviewLine {
  kind: LineKind;
  text: string;
}

/** Classifies each line for lightweight preview coloring (front matter, headings, quotes). */
function classifyLines(markdown: string): PreviewLine[] {
  const lines = markdown.split("\n");
  let inFront = lines[0] === "---";
  return lines.map((text, i) => {
    if (inFront) {
      if (i > 0 && text === "---") {
        inFront = false;
        return { kind: "fence", text };
      }
      return { kind: i === 0 ? "fence" : "key", text };
    }
    if (text.startsWith("### ")) return { kind: "h3", text };
    if (text.startsWith("## ")) return { kind: "h2", text };
    if (text.startsWith("# ")) return { kind: "h1", text };
    if (text.startsWith(">")) return { kind: "quote", text };
    return { kind: "plain", text };
  });
}

const KIND_STYLE: Record<LineKind, string> = {
  fence: "text-[#8E94A5]",
  key: "text-[#B388FF]",
  h1: "font-bold text-[#FFB236]",
  h2: "font-semibold text-[#FFB236]",
  h3: "font-semibold text-[#F4F1EA]",
  quote: "text-[#8E94A5]",
  plain: "text-[#F4F1EA]/90",
};

/** Copies via the async Clipboard API, falling back to a hidden textarea. Never throws. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied or insecure context: try the fallback below.
  }
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const area = document.createElement("textarea");
  try {
    area.value = text;
    area.setAttribute("readonly", "");
    area.setAttribute("aria-hidden", "true");
    area.style.position = "fixed";
    area.style.top = "0";
    area.style.left = "-9999px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    previous?.focus();
  }
}

/** Saves `markdown` as a file through a Blob URL, which is revoked afterwards. */
function downloadMarkdown(markdown: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke after the browser has started the download.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

interface ExportBriefingModalProps {
  /** The briefing, generated when the modal was opened. */
  markdown: string;
  trailId: string;
  onClose: () => void;
}

type CopyState = "idle" | "copied" | "failed";

function ModalBody({ markdown, trailId, onClose }: ExportBriefingModalProps) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const dialogRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lines = useMemo(() => classifyLines(markdown), [markdown]);
  const filename = useMemo(() => briefingFilename(trailId), [trailId]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => {
      clearTimeout(timerRef.current);
      previous?.focus();
    };
  }, []);

  const copy = useCallback(async () => {
    const ok = await copyText(markdown);
    clearTimeout(timerRef.current);
    setCopyState(ok ? "copied" : "failed");
    timerRef.current = setTimeout(() => setCopyState("idle"), ok ? COPIED_MS : COPIED_MS * 2);
  }, [markdown]);

  const download = useCallback(() => downloadMarkdown(markdown, filename), [markdown, filename]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Keep canvas and trail-dock shortcuts (arrows, I, Delete, Esc) away from the dialog.
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "Tab" && dialogRef.current) {
      const items = [
        ...dialogRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), [tabindex='0']"),
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
        aria-labelledby="briefing-title"
        tabIndex={-1}
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={SPRING}
        className="relative flex max-h-full w-full max-w-[760px] flex-col gap-3 rounded-2xl border border-[rgba(255,178,54,0.2)] bg-[#141721] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_24px_60px_rgba(0,0,0,0.8)] outline-none"
      >
        <div>
          <div className={LABEL_CLASS}>Synthesis Suite · Research Intelligence</div>
          <h2 id="briefing-title" className="font-serif text-xl font-semibold text-text-primary">
            Export Briefing
          </h2>
          <div className="mt-0.5 font-mono text-[11px] text-text-muted">{filename}</div>
        </div>
        <div
          role="region"
          aria-label="Markdown preview"
          tabIndex={0}
          className="min-h-[200px] flex-1 overflow-auto rounded-xl border border-[rgba(255,178,54,0.2)] bg-[#090A0F] p-3 font-mono text-[12px] leading-relaxed shadow-[inset_0_2px_6px_rgba(0,0,0,0.6)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[#FFB236]"
          style={{ maxHeight: "min(52vh, 460px)" }}
        >
          {lines.map((line, i) => (
            <div key={i} className={`whitespace-pre-wrap break-words ${KIND_STYLE[line.kind]}`}>
              {line.text === "" ? "\u00A0" : line.text}
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void copy()}
            className={`${BUTTON_CLASS} border-[#FFB236] bg-[#FFB236] text-[#090A0F] shadow-[0_2px_0_rgba(0,0,0,0.65)] hover:brightness-110 active:translate-y-[2px]`}
          >
            [COPY MARKDOWN]
          </button>
          <button
            type="button"
            onClick={download}
            className={`${BUTTON_CLASS} border-[#FFB236]/50 bg-[#141721] text-[#FFB236] hover:border-[#FFB236]`}
          >
            [DOWNLOAD .MD]
          </button>
          <span
            role="status"
            aria-live="polite"
            className={`font-mono text-[11px] font-semibold uppercase tracking-[0.14em] ${
              copyState === "failed" ? "text-[#B388FF]" : "text-[#FFB236]"
            }`}
          >
            {copyState === "copied"
              ? "✓ COPIED TO CLIPBOARD"
              : copyState === "failed"
                ? "COPY FAILED · SELECT THE TEXT MANUALLY"
                : ""}
          </span>
          <button
            type="button"
            onClick={onClose}
            className={`${BUTTON_CLASS} ml-auto border-white/10 text-text-muted hover:text-text-primary`}
          >
            [CLOSE / ESC]
          </button>
        </div>
      </motion.div>
    </div>
  );
}

/** Retro-futuristic modal previewing a trail briefing with copy and download actions. */
export function ExportBriefingModal(props: ExportBriefingModalProps) {
  if (typeof document === "undefined") return null;
  return createPortal(<ModalBody {...props} />, document.body);
}
