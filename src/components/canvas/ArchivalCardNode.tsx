"use client";

import {
  memo,
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
} from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { motion, type Variants } from "framer-motion";
import { EDGE_COLORS, type MemexNode } from "@/core/types";
import { useMemexStore } from "@/store/useMemexStore";

const SPRING = { type: "spring", stiffness: 300, damping: 28 } as const;
const EXIT_TRANSITION = { duration: 0.22, ease: "easeIn" } as const;

/** Dark-mode editor field background (same obsidian as the card surface). */
const EDITOR_BG = "#141721";

/** `"a, b ,, a"` to `["a", "b"]`: trimmed, non-empty, unique. */
function parseTags(raw: string): string[] {
  return [...new Set(raw.split(",").map((t) => t.trim()).filter(Boolean))];
}

/** `#RRGGBB` to `rgba(r, g, b, a)`. */
function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * Both variants keep the same shadow structure (two layers) so framer-motion
 * can interpolate them. Only transform and box-shadow are animated.
 */
function cardVariants(accent: string): Variants {
  const rest = `0 0 0px 0px ${rgba(accent, 0)}, 0 4px 14px rgba(0, 0, 0, 0.55)`;
  return {
    rest: { scale: 1, y: 0, boxShadow: rest },
    hover: {
      scale: 1.025,
      y: -3,
      boxShadow: `0 0 26px 1px ${rgba(accent, 0.32)}, 0 14px 30px rgba(0, 0, 0, 0.7)`,
    },
    selected: {
      scale: 1.01,
      y: 0,
      boxShadow: `0 0 0 1px ${rgba(accent, 0.9)}, 0 10px 26px rgba(0, 0, 0, 0.65)`,
    },
    exit: {
      scale: 0.88,
      y: 6,
      opacity: 0,
      boxShadow: rest,
      transition: EXIT_TRANSITION,
    },
  };
}

/** Microfilm registration crosshair (+), centered on a card corner. */
function Crosshair({ corner }: { corner: "tl" | "tr" | "bl" | "br" }) {
  const pos: CSSProperties = {
    position: "absolute",
    width: 13,
    height: 13,
    pointerEvents: "none",
    top: corner[0] === "t" ? -7 : undefined,
    bottom: corner[0] === "b" ? -7 : undefined,
    left: corner[1] === "l" ? -7 : undefined,
    right: corner[1] === "r" ? -7 : undefined,
  };
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 13 13"
      style={pos}
      className="text-text-muted"
    >
      <path
        d="M6.5 0V13M0 6.5H13"
        stroke="currentColor"
        strokeWidth="1"
        fill="none"
        shapeRendering="crispEdges"
      />
    </svg>
  );
}

function ArchivalCardNodeImpl({ id, data, selected }: NodeProps<MemexNode>) {
  const isGhost = data.cardType === "ghost";
  const accent = isGhost ? EDGE_COLORS.ghost : EDGE_COLORS.human;
  const variants = cardVariants(accent);

  const [isEditing, setIsEditing] = useState(false);
  const [isExiting, setIsExiting] = useState(false);
  const [draft, setDraft] = useState({ title: "", content: "", tags: "" });
  // Guards against committing twice (Escape followed by the blur it causes).
  const editingRef = useRef(false);

  const startEditing = useCallback(() => {
    setDraft({
      title: data.title,
      content: data.content,
      tags: data.tags.join(", "),
    });
    editingRef.current = true;
    setIsEditing(true);
  }, [data.title, data.content, data.tags]);

  const commitEdit = useCallback(() => {
    if (!editingRef.current) return;
    editingRef.current = false;
    const title = draft.title.trim();
    useMemexStore.getState().updateCard(id, {
      // A card must keep a title: blank input leaves the old one in place.
      ...(title ? { title } : {}),
      content: draft.content,
      tags: parseTags(draft.tags),
    });
    setIsEditing(false);
  }, [id, draft]);

  const onEditorBlur = (e: FocusEvent<HTMLDivElement>) => {
    // Moving focus between the editor's own fields is not a commit.
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) commitEdit();
  };

  const onEditorKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Keep Backspace/Delete from reaching React Flow's delete-selection handler.
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      commitEdit();
    }
  };

  const fieldStyle: CSSProperties = {
    background: EDITOR_BG,
    border: `1px solid ${rgba(accent, 0.45)}`,
    borderRadius: 1,
    outline: "none",
  };

  return (
    <motion.div
      variants={variants}
      initial="rest"
      animate={isExiting ? "exit" : selected ? "selected" : "rest"}
      whileHover={isExiting ? undefined : "hover"}
      transition={SPRING}
      onAnimationComplete={(def) => {
        // Remove from the graph once the exit animation has played. The store
        // action purges connected edges and trail references (Requirement 2.3).
        if (def === "exit") useMemexStore.getState().removeNodes([id]);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (!isEditing && !isExiting) startEditing();
      }}
      className="group nopan relative w-[280px] bg-card-surface"
      style={
        {
          border: `1px solid ${accent}`,
          borderRadius: 2,
          willChange: "transform",
          pointerEvents: isExiting ? "none" : undefined,
          "--handle-accent": accent,
        } as CSSProperties
      }
    >
      <Crosshair corner="tl" />
      <Crosshair corner="tr" />
      <Crosshair corner="bl" />
      <Crosshair corner="br" />

      <header
        className="flex items-center justify-between px-3 pt-2.5 pb-2 font-mono text-[10px] uppercase tracking-[0.14em]"
        style={{ borderBottom: `1px solid ${rgba(accent, 0.22)}` }}
      >
        <span className="text-text-muted">{data.archivalId}</span>
        <div className="flex items-center gap-2">
          <span style={{ color: accent }}>
            {isGhost && data.confidence !== undefined
              ? `GHOST ${data.confidence.toFixed(2)}`
              : data.cardType}
          </span>
          <button
            type="button"
            aria-label={`Delete card ${data.archivalId}`}
            title="Delete card"
            onClick={(e) => {
              e.stopPropagation();
              setIsExiting(true);
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            className="nodrag cursor-pointer text-[11px] leading-none text-text-muted opacity-0 transition-[opacity,color] duration-150 hover:text-[#ff6b6b] focus-visible:opacity-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent-human group-hover:opacity-100"
          >
            ✕
          </button>
        </div>
      </header>

      {data.imageUrl ? (
        <div className="mx-3 mt-3 h-24 overflow-hidden border border-card-border bg-canvas-bg">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={data.imageUrl}
            alt={data.title}
            draggable={false}
            className="h-full w-full object-cover"
            style={{ filter: "url(#microfilm-duotone)" }}
          />
        </div>
      ) : null}

      {isEditing ? (
        <div
          className="nodrag nowheel nopan flex flex-col gap-2 px-3 pt-3 pb-3"
          onBlur={onEditorBlur}
          onKeyDown={onEditorKeyDown}
        >
          <input
            autoFocus
            aria-label="Card title"
            value={draft.title}
            onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
            className="w-full px-1.5 py-1 font-serif text-[17px] font-semibold leading-snug text-text-primary"
            style={fieldStyle}
          />
          <textarea
            aria-label="Card content"
            rows={4}
            value={draft.content}
            onChange={(e) => setDraft((d) => ({ ...d, content: e.target.value }))}
            className="w-full resize-none px-1.5 py-1 text-[12px] leading-relaxed text-text-primary"
            style={fieldStyle}
          />
          <input
            aria-label="Card tags (comma separated)"
            placeholder="tags, comma separated"
            value={draft.tags}
            onChange={(e) => setDraft((d) => ({ ...d, tags: e.target.value }))}
            className="w-full px-1.5 py-1 font-mono text-[10px] uppercase tracking-wider"
            style={{ ...fieldStyle, color: accent }}
          />
        </div>
      ) : (
        <div className="px-3 pt-3 pb-3">
          <h3 className="font-serif text-[17px] font-semibold leading-snug tracking-tight text-text-primary">
            {data.title}
          </h3>
          {data.content ? (
            <p className="mt-1.5 line-clamp-3 text-[12px] leading-relaxed text-text-muted">
              {data.content}
            </p>
          ) : null}
          {data.tags.length > 0 ? (
            <ul className="mt-3 flex flex-wrap gap-1.5">
              {data.tags.map((tag) => (
                <li
                  key={tag}
                  className="font-mono text-[10px] uppercase tracking-wider px-1.5 py-px"
                  style={{
                    color: accent,
                    border: `1px solid ${rgba(accent, 0.4)}`,
                    borderRadius: 1,
                  }}
                >
                  {tag}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}

      {/* One connector per side; ConnectionMode.Loose lets any pad link to any pad. */}
      <Handle id="top" type="source" position={Position.Top} className="memex-handle" />
      <Handle id="bottom" type="source" position={Position.Bottom} className="memex-handle" />
      <Handle id="left" type="source" position={Position.Left} className="memex-handle" />
      <Handle id="right" type="source" position={Position.Right} className="memex-handle" />
    </motion.div>
  );
}

export const ArchivalCardNode = memo(ArchivalCardNodeImpl);
