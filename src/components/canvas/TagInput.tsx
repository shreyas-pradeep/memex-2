"use client";

import type { CSSProperties, KeyboardEvent } from "react";

/** Splits free text on commas into trimmed, non-empty tags. */
function splitTags(raw: string): string[] {
  return raw.split(",").map((t) => t.trim()).filter(Boolean);
}

/** Appends `extra` to `tags`, dropping duplicates (case-insensitive). */
export function mergeTags(tags: string[], extra: string[]): string[] {
  const out = [...tags];
  for (const t of extra) {
    if (!out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}

/** Tags plus any text still pending in the input. */
export function withPendingTags(tags: string[], pending: string): string[] {
  return mergeTags(tags, splitTags(pending));
}

interface TagInputProps {
  tags: string[];
  /** Text typed but not yet turned into a tag. */
  text: string;
  accent: string;
  onTagsChange: (tags: string[]) => void;
  onTextChange: (text: string) => void;
  /** Extra class names for the text field (e.g. `nodrag nowheel`). */
  inputClassName?: string;
  style?: CSSProperties;
}

/**
 * Chip-style tag editor: Enter or comma adds the typed tag, the ✕ on a chip
 * removes it, and Backspace on an empty field removes the last tag.
 */
export function TagInput({
  tags,
  text,
  accent,
  onTagsChange,
  onTextChange,
  inputClassName = "",
  style,
}: TagInputProps) {
  const flush = (raw: string) => {
    const added = splitTags(raw);
    if (added.length > 0) onTagsChange(mergeTags(tags, added));
    onTextChange("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      // Enter must not reach the surrounding form or editor.
      e.stopPropagation();
      flush(text);
    } else if (e.key === "Backspace" && text === "" && tags.length > 0) {
      onTagsChange(tags.slice(0, -1));
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded-full py-px pr-1 pl-2 font-mono text-[10px] uppercase tracking-wider"
          style={{ color: accent, border: `1px solid ${accent}66` }}
        >
          {tag}
          <button
            type="button"
            aria-label={`Remove tag ${tag}`}
            onClick={() => onTagsChange(tags.filter((t) => t !== tag))}
            className="nodrag cursor-pointer rounded-full px-1 leading-none text-text-muted hover:text-[#ff6b6b]"
          >
            ✕
          </button>
        </span>
      ))}
      <input
        aria-label="Add tag"
        placeholder={tags.length === 0 ? "type a tag, press Enter" : "add tag"}
        value={text}
        onChange={(e) => {
          const v = e.target.value;
          // A pasted or typed comma commits everything before it.
          if (v.includes(",")) flush(v);
          else onTextChange(v);
        }}
        onKeyDown={onKeyDown}
        className={`min-w-[7rem] flex-1 rounded-xl px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-wider ${inputClassName}`}
        style={{ color: accent, ...style }}
      />
    </div>
  );
}
