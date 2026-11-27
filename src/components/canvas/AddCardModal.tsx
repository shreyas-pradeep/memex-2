"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { parseEventDateInput } from "@/core/trail-engine";
import { CARD_ACCENTS, type MemexCardType } from "@/core/types";
import { rgba } from "./card-skins";
import { TagInput, withPendingTags } from "./TagInput";

export type NewCardType = Extract<MemexCardType, "note" | "quote" | "artifact">;

export interface NewCardInput {
  title: string;
  content: string;
  cardType: NewCardType;
  tags: string[];
  /** Omitted when no image was given. */
  imageUrl?: string;
  /** Event year (e.g. 2026). Omitted for partial/full dates or empty input. */
  year?: number;
  /** Event date `YYYY-MM` or `YYYY-MM-DD`. Omitted otherwise. */
  date?: string;
}

const CARD_TYPES: readonly NewCardType[] = ["note", "quote", "artifact"];

/** 1945 historical quick-fill images (Wikimedia Commons). */
const IMAGE_PRESETS: readonly { label: string; url: string }[] = [
  {
    label: "Vannevar Bush",
    url: "https://commons.wikimedia.org/wiki/Special:FilePath/Vannevar_Bush_portrait.jpg?width=640",
  },
  {
    label: "ENIAC Tubes",
    url: "https://commons.wikimedia.org/wiki/Special:FilePath/ENIAC-changing_a_tube.jpg?width=640",
  },
  {
    label: "ENIAC Hall",
    url: "https://commons.wikimedia.org/wiki/Special:FilePath/Eniac.jpg?width=640",
  },
];

const FIELD_CLASS =
  "w-full rounded-xl border border-[#FFB236]/40 bg-[#141721] px-3 py-2 text-[13px] text-text-primary outline-none focus:border-[#FFB236]";
const LABEL_CLASS = "font-mono text-[10px] uppercase tracking-[0.16em] text-text-muted";

interface AddCardModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (input: NewCardInput) => void;
}

function ModalBody({ onClose, onSubmit }: Omit<AddCardModalProps, "open">) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [cardType, setCardType] = useState<NewCardType>("note");
  const [tags, setTags] = useState<string[]>([]);
  const [tagText, setTagText] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [eventDate, setEventDate] = useState("");
  const dateParse = parseEventDateInput(eventDate);
  const dateInvalid = !dateParse.ok;
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!dateParse.ok) return;
    const url = imageUrl.trim();
    onSubmit({
      title: title.trim() || "Untitled Note",
      content,
      cardType,
      tags: withPendingTags(tags, tagText),
      ...(url ? { imageUrl: url } : {}),
      ...(dateParse.year !== undefined ? { year: dateParse.year } : {}),
      ...(dateParse.date !== undefined ? { date: dateParse.date } : {}),
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Keep canvas shortcuts (Backspace/Delete) away from the form.
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
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
        role="dialog"
        aria-modal="true"
        aria-label="Add archival card"
        onSubmit={submit}
        className="flex max-h-full w-full max-w-[480px] flex-col gap-3 overflow-y-auto rounded-2xl border border-white/10 bg-[#11131C] p-5 shadow-[0_24px_60px_rgba(0,0,0,0.8)]"
      >
        <div>
          <div className={LABEL_CLASS}>Archival Ingestion</div>
          <h2 className="font-serif text-xl font-semibold text-text-primary">New Card</h2>
        </div>

        <label className="flex flex-col gap-1">
          <span className={LABEL_CLASS}>Title</span>
          <input
            ref={titleRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Untitled Note"
            className={`${FIELD_CLASS} font-serif text-[16px]`}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className={LABEL_CLASS}>Content</span>
          <textarea
            rows={4}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className={`${FIELD_CLASS} resize-none leading-relaxed`}
          />
        </label>

        <fieldset className="flex flex-col gap-1">
          <legend className={`${LABEL_CLASS} mb-1`}>Card Type</legend>
          <div className="flex gap-2" role="radiogroup" aria-label="Card type">
            {CARD_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={cardType === t}
                onClick={() => setCardType(t)}
                className="flex-1 cursor-pointer rounded-xl border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] transition-colors duration-100"
                style={
                  cardType === t
                    ? { color: "#090A0F", background: CARD_ACCENTS[t], borderColor: CARD_ACCENTS[t] }
                    : {
                        color: CARD_ACCENTS[t],
                        background: "#141721",
                        borderColor: rgba(CARD_ACCENTS[t], 0.45),
                      }
                }
              >
                {t}
              </button>
            ))}
          </div>
        </fieldset>

        <div className="flex flex-col gap-1">
          <span className={LABEL_CLASS}>Tags</span>
          <TagInput
            tags={tags}
            text={tagText}
            accent={CARD_ACCENTS[cardType]}
            onTagsChange={setTags}
            onTextChange={setTagText}
            inputClassName="border border-[#FFB236]/40 bg-[#141721] outline-none focus:border-[#FFB236]"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="add-card-image" className={LABEL_CLASS}>
            Image URL (optional)
          </label>
          <input
            id="add-card-image"
            type="url"
            value={imageUrl}
            onChange={(e) => setImageUrl(e.target.value)}
            placeholder="https://…"
            className={`${FIELD_CLASS} font-mono text-[12px]`}
          />
          <div className="mt-1 flex flex-wrap gap-1.5">
            {IMAGE_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => setImageUrl(p.url)}
                className="cursor-pointer rounded-full border border-white/15 px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-text-muted hover:border-[#FFB236] hover:text-[#FFB236]"
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="add-card-date" className={LABEL_CLASS}>
            Event Date / Year (Optional)
          </label>
          <input
            id="add-card-date"
            value={eventDate}
            onChange={(e) => setEventDate(e.target.value)}
            placeholder="2026, 1945, 2024-10-12"
            aria-invalid={dateInvalid}
            aria-describedby={dateInvalid ? "add-card-date-error" : undefined}
            className={`${FIELD_CLASS} font-mono text-[12px]`}
          />
          {dateInvalid ? (
            <p id="add-card-date-error" role="alert" className="font-mono text-[11px] text-[#B388FF]">
              Use a year (1945) or a date (1945-07, 2024-10-12). Leave blank for no date.
            </p>
          ) : null}
        </div>

        <div className="mt-2 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-xl border border-white/10 px-4 py-2 font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-text-muted hover:text-text-primary"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={dateInvalid}
            className="cursor-pointer rounded-xl border border-[#FFB236] bg-[#FFB236] px-4 py-2 font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-[#090A0F] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Add Card
          </button>
        </div>
      </form>
    </div>
  );
}

/** Archival ingestion dialog. Its state resets each time it opens. */
export function AddCardModal({ open, onClose, onSubmit }: AddCardModalProps) {
  if (!open || typeof document === "undefined") return null;
  return createPortal(<ModalBody onClose={onClose} onSubmit={onSubmit} />, document.body);
}
