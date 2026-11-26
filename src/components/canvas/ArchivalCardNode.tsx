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
import { Handle, NodeResizer, Position, type NodeProps } from "@xyflow/react";
import { motion, type Variants } from "framer-motion";
import { EDGE_COLORS, type MemexNode } from "@/core/types";
import { useMemexStore } from "@/store/useMemexStore";
import { TagInput, withPendingTags } from "./TagInput";

/** GPU-composited microfilm tint (replaces the CPU-bound SVG duotone filter). */
const MICROFILM_IMAGE_FILTER = "grayscale(100%) contrast(125%) sepia(25%)";

const SPRING = { type: "spring", stiffness: 300, damping: 28 } as const;
const EXIT_TRANSITION = { duration: 0.22, ease: "easeIn" } as const;

/** Dark-mode editor field background (same obsidian as the card surface). */
const EDITOR_BG = "#141721";
/** Minimum body height (px) so short notes never collapse. */
const BODY_MIN_HEIGHT = 160;

/** `#RRGGBB` to `rgba(r, g, b, a)`. */
function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * All variants keep the same shadow structure (two layers) so framer-motion
 * can interpolate them. Only transform and box-shadow are animated. Ghost
 * cards rest with a Phantom Violet rim glow; other cards rest dark.
 */
function cardVariants(accent: string, isGhost: boolean): Variants {
  const restGlow = isGhost ? `0 0 22px 1px ${rgba(accent, 0.3)}` : `0 0 0px 0px ${rgba(accent, 0)}`;
  const rest = `${restGlow}, 0 4px 14px rgba(0, 0, 0, 0.55)`;
  return {
    rest: { scale: 1, y: 0, boxShadow: rest },
    hover: {
      scale: 1.025,
      y: -3,
      boxShadow: `0 0 26px 1px ${rgba(accent, isGhost ? 0.5 : 0.32)}, 0 14px 30px rgba(0, 0, 0, 0.7)`,
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

/** Minimum card size (px) enforced by the resizer. */
const MIN_WIDTH = 280;
/** Header strip (about 41px) plus the 160px body minimum. */
const MIN_HEIGHT = 204;

/**
 * Microfilm registration crosshair (+). Sits just inside each corner of the
 * rounded chassis so the sharp 1px strokes stay clear of the 16px curve.
 */
function Crosshair({ corner }: { corner: "tl" | "tr" | "bl" | "br" }) {
  const pos: CSSProperties = {
    position: "absolute",
    width: 11,
    height: 11,
    pointerEvents: "none",
    top: corner[0] === "t" ? 5 : undefined,
    bottom: corner[0] === "b" ? 5 : undefined,
    left: corner[1] === "l" ? 5 : undefined,
    right: corner[1] === "r" ? 5 : undefined,
  };
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 11 11"
      style={pos}
      className="text-text-muted"
    >
      <path
        d="M5.5 0V11M0 5.5H11"
        stroke="currentColor"
        strokeWidth="1"
        fill="none"
        shapeRendering="crispEdges"
      />
    </svg>
  );
}

/** FNV-1a hash: stable across server and client renders. */
function hashString(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic patent number and sheet coordinates derived from the archival ID. */
function patentMarks(archivalId: string): { patentNo: string; x: string; y: string } {
  const h = hashString(archivalId);
  return {
    patentNo: (2_000_000 + (h % 700_000)).toLocaleString("en-US"),
    x: (((h >>> 3) % 1000) / 10).toFixed(1).padStart(5, "0"),
    y: (((h >>> 13) % 1000) / 10).toFixed(1).padStart(5, "0"),
  };
}

const AMBER = EDGE_COLORS.human;
const GRID_FINE = rgba(AMBER, 0.07);
const GRID_MAJOR = rgba(AMBER, 0.18);

/**
 * 1945 technical drawing plate for artifact cards: microfiche gridlines
 * (8px fine, 40px major), a line-drawn reel with a dimension rule, and patent
 * coordinates derived from the archival ID.
 */
function BlueprintPlate({ archivalId }: { archivalId: string }) {
  const { patentNo, x, y } = patentMarks(archivalId);
  const stroke = rgba(AMBER, 0.75);
  return (
    <div
      role="img"
      aria-label={`Technical drawing, patent ${patentNo}`}
      className="relative mb-3 h-14 shrink-0 overflow-hidden rounded-xl bg-[#090A0F]"
      style={{
        border: `1px solid ${rgba(AMBER, 0.22)}`,
        backgroundImage: [
          `linear-gradient(${GRID_MAJOR} 1px, transparent 1px)`,
          `linear-gradient(90deg, ${GRID_MAJOR} 1px, transparent 1px)`,
          `linear-gradient(${GRID_FINE} 1px, transparent 1px)`,
          `linear-gradient(90deg, ${GRID_FINE} 1px, transparent 1px)`,
        ].join(", "),
        backgroundSize: "40px 40px, 40px 40px, 8px 8px, 8px 8px",
      }}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 160 56"
        preserveAspectRatio="xMinYMid meet"
        className="absolute inset-0 h-full w-[160px]"
        fill="none"
        stroke={stroke}
        strokeWidth="1"
      >
        <circle cx="30" cy="28" r="19" />
        <circle cx="30" cy="28" r="6" />
        <path d="M30 9V47M11 28H49M16.6 14.6L43.4 41.4M43.4 14.6L16.6 41.4" strokeOpacity="0.45" />
        <path d="M58 28H92M58 24V32M92 24V32" />
        <path d="M92 28C104 28 108 14 122 14M92 28C104 28 108 42 122 42" strokeOpacity="0.6" />
        <circle cx="128" cy="14" r="5" />
        <circle cx="128" cy="42" r="5" />
      </svg>
      <div className="absolute top-1 right-2 text-right font-mono text-[9px] leading-tight tracking-wider text-text-muted">
        <div>FIG. 1 · SHEET 1/1</div>
        <div>PAT. NO. {patentNo}</div>
        <div>
          X {x} · Y {y}
        </div>
      </div>
    </div>
  );
}

function ArchivalCardNodeImpl({ id, data, selected }: NodeProps<MemexNode>) {
  const isGhost = data.cardType === "ghost";
  const isQuote = data.cardType === "quote";
  const isArtifact = data.cardType === "artifact";
  const accent = isGhost ? EDGE_COLORS.ghost : EDGE_COLORS.human;
  const variants = cardVariants(accent, isGhost);

  const [isEditing, setIsEditing] = useState(false);
  const [isExiting, setIsExiting] = useState(false);
  const [draft, setDraft] = useState<{
    title: string;
    content: string;
    tags: string[];
    tagText: string;
    imageUrl: string;
  }>({ title: "", content: "", tags: [], tagText: "", imageUrl: "" });
  // Guards against committing twice (Escape followed by the blur it causes).
  const editingRef = useRef(false);

  const startEditing = useCallback(() => {
    setDraft({
      title: data.title,
      content: data.content,
      tags: data.tags,
      tagText: "",
      imageUrl: data.imageUrl ?? "",
    });
    editingRef.current = true;
    setIsEditing(true);
  }, [data.title, data.content, data.tags, data.imageUrl]);

  const commitEdit = useCallback(() => {
    if (!editingRef.current) return;
    editingRef.current = false;
    const title = draft.title.trim();
    useMemexStore.getState().updateCard(id, {
      // A card must keep a title: blank input leaves the old one in place.
      ...(title ? { title } : {}),
      content: draft.content,
      tags: withPendingTags(draft.tags, draft.tagText),
      imageUrl: draft.imageUrl.trim(),
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
    outline: "none",
  };

  // The ghost body gets a faint phosphor bloom behind the text.
  const bodyStyle: CSSProperties = {
    minHeight: BODY_MIN_HEIGHT,
    ...(isGhost
      ? {
          backgroundImage: `radial-gradient(ellipse at 50% 0%, ${rgba(accent, 0.12)}, transparent 70%)`,
        }
      : {}),
  };

  return (
    <>
      <NodeResizer
        minWidth={MIN_WIDTH}
        minHeight={MIN_HEIGHT}
        isVisible={selected}
        handleStyle={{ "--resize-accent": accent } as CSSProperties}
        lineStyle={{ "--resize-accent": accent } as CSSProperties}
      />
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
        className="group nopan relative flex h-full w-full flex-col rounded-2xl bg-card-surface"
        style={
          {
            border: `1px solid ${accent}`,
            minWidth: MIN_WIDTH,
            minHeight: MIN_HEIGHT,
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

        {/* Microfiche strip. The whole card drags; the header is the grab surface. */}
        <header className="flex shrink-0 cursor-grab items-center gap-2 rounded-t-2xl border-b border-white/5 bg-[#161922] px-4 py-2.5 active:cursor-grabbing">
          <svg
            aria-hidden="true"
            viewBox="0 0 6 10"
            className="h-2.5 w-1.5 shrink-0 text-text-muted"
            fill="currentColor"
          >
            <circle cx="1" cy="1" r="0.9" />
            <circle cx="5" cy="1" r="0.9" />
            <circle cx="1" cy="5" r="0.9" />
            <circle cx="5" cy="5" r="0.9" />
            <circle cx="1" cy="9" r="0.9" />
            <circle cx="5" cy="9" r="0.9" />
          </svg>
          <span className="font-mono text-xs text-[#8E94A5]">{data.archivalId}</span>
          <div className="ml-auto flex items-center gap-2">
            <span
              className="rounded-full px-2 py-px font-mono text-[10px] uppercase tracking-[0.14em]"
              style={{ color: accent, border: `1px solid ${rgba(accent, 0.4)}` }}
            >
              {data.cardType}
            </span>
            {/* No `nodrag`: only the edit fields opt out of dragging. A plain click
                stays under `nodeDragThreshold`, so it never starts a drag. */}
            <button
              type="button"
              aria-label={`Delete card ${data.archivalId}`}
              title="Delete card"
              onClick={(e) => {
                e.stopPropagation();
                setIsExiting(true);
              }}
              onDoubleClick={(e) => e.stopPropagation()}
              className="cursor-pointer text-[11px] leading-none text-text-muted opacity-0 transition-[opacity,color] duration-150 hover:text-[#ff6b6b] focus-visible:opacity-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent-human group-hover:opacity-100"
            >
              ✕
            </button>
          </div>
        </header>

        {isEditing ? (
          <div
            className="flex flex-1 flex-col gap-2 overflow-y-auto rounded-b-2xl bg-[#11131C] p-5"
            style={{ minHeight: BODY_MIN_HEIGHT }}
            onBlur={onEditorBlur}
            onKeyDown={onEditorKeyDown}
          >
            <input
              autoFocus
              aria-label="Card title"
              value={draft.title}
              onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
              className="nodrag nowheel w-full shrink-0 rounded-xl px-2.5 py-1.5 font-serif text-[17px] font-semibold leading-snug text-text-primary"
              style={fieldStyle}
            />
            <textarea
              aria-label="Card content"
              rows={3}
              value={draft.content}
              onChange={(e) => setDraft((d) => ({ ...d, content: e.target.value }))}
              className="nodrag nowheel min-h-[4.5rem] w-full flex-1 resize-none rounded-xl px-2.5 py-1.5 text-[12px] leading-relaxed text-text-primary"
              style={fieldStyle}
            />
            <TagInput
              tags={draft.tags}
              text={draft.tagText}
              accent={accent}
              onTagsChange={(tags) => setDraft((d) => ({ ...d, tags }))}
              onTextChange={(tagText) => setDraft((d) => ({ ...d, tagText }))}
              inputClassName="nodrag nowheel"
              style={fieldStyle}
            />
            <input
              aria-label="Image URL"
              type="url"
              placeholder="image URL (optional)"
              value={draft.imageUrl}
              onChange={(e) => setDraft((d) => ({ ...d, imageUrl: e.target.value }))}
              className="nodrag nowheel w-full shrink-0 rounded-xl px-2.5 py-1.5 font-mono text-[10px] tracking-wider text-text-muted"
              style={fieldStyle}
            />
          </div>
        ) : (
          <div
            className="relative flex-1 overflow-y-auto rounded-b-2xl bg-[#11131C] p-5"
            style={bodyStyle}
          >
            {isQuote ? (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute top-1 right-4 select-none font-serif text-[88px] leading-none"
                style={{ color: AMBER, opacity: 0.1 }}
              >
                {"\u201C"}
              </span>
            ) : null}

            {isGhost ? (
              <div
                className="mb-3 inline-flex items-center gap-1.5 rounded-full px-2 py-px font-mono text-[10px] uppercase tracking-[0.14em]"
                style={{
                  color: accent,
                  background: rgba(accent, 0.08),
                  border: `1px solid ${rgba(accent, 0.35)}`,
                }}
              >
                <span
                  aria-hidden="true"
                  className="memex-phosphor-dot h-1.5 w-1.5 rounded-full"
                  style={{ background: accent, boxShadow: `0 0 6px 1px ${rgba(accent, 0.8)}` }}
                />
                {data.confidence !== undefined
                  ? `Phosphor · ${data.confidence.toFixed(2)}`
                  : "Phosphor · Live"}
              </div>
            ) : null}

            {isArtifact && !data.imageUrl ? <BlueprintPlate archivalId={data.archivalId} /> : null}

            {data.imageUrl ? (
              <div className="mb-3 h-24 overflow-hidden rounded-xl border border-card-border bg-canvas-bg">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={data.imageUrl}
                  alt={data.title}
                  draggable={false}
                  className="h-full w-full object-cover"
                  style={{ filter: MICROFILM_IMAGE_FILTER }}
                />
              </div>
            ) : null}

            <h3 className="relative font-serif text-[17px] font-semibold leading-snug tracking-tight text-text-primary">
              {data.title}
            </h3>
            {data.content ? (
              <p
                className={
                  isQuote
                    ? "relative mt-2 font-serif text-[14px] italic leading-relaxed text-text-primary/90"
                    : "relative mt-1.5 text-[12px] leading-relaxed text-text-muted"
                }
              >
                {data.content}
              </p>
            ) : null}
            {data.tags.length > 0 ? (
              <ul className="relative mt-3 flex flex-wrap gap-1.5">
                {data.tags.map((tag) => (
                  <li
                    key={tag}
                    className="rounded-full px-2 py-px font-mono text-[10px] uppercase tracking-wider"
                    style={{
                      color: accent,
                      border: `1px solid ${rgba(accent, 0.4)}`,
                    }}
                  >
                    {tag}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        )}

        {/* One pill connector per side; ConnectionMode.Loose lets any pill link to any pill. */}
        <Handle id="top" type="source" position={Position.Top} className="memex-handle" />
        <Handle id="bottom" type="source" position={Position.Bottom} className="memex-handle" />
        <Handle id="left" type="source" position={Position.Left} className="memex-handle" />
        <Handle id="right" type="source" position={Position.Right} className="memex-handle" />
      </motion.div>
    </>
  );
}

export const ArchivalCardNode = memo(ArchivalCardNodeImpl);
