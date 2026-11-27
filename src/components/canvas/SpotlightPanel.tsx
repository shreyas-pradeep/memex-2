"use client";

import { useEffect, useMemo, useRef } from "react";
import { buildTagCloud, type SpotlightType } from "@/core/spotlight";
import { selectDockFocusRequest } from "@/store/dock-selectors";
import { selectCuratorCardCount } from "@/store/curator-selectors";
import {
  selectIsSpotlightActive,
  selectSpotlightMatchCount,
  selectSpotlightQuery,
  selectSpotlightTags,
  selectSpotlightType,
} from "@/store/spotlight-selectors";
import { useMemexStore, type MemexStore } from "@/store/useMemexStore";
import { CARD_SKINS, rgba } from "./card-skins";

const BTN =
  "cursor-pointer rounded-xl border px-3 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] transition-[color,border-color,background-color] duration-100 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[#FFB236]";

const TYPE_PILLS: readonly { type: SpotlightType; label: string; accent: string }[] = [
  { type: "all", label: "All", accent: "#F4F1EA" },
  { type: "note", label: "Notes", accent: CARD_SKINS.note.accent },
  { type: "quote", label: "Quotes", accent: CARD_SKINS.quote.accent },
  { type: "artifact", label: "Artifacts", accent: CARD_SKINS.artifact.accent },
  { type: "ghost", label: "Ghosts", accent: CARD_SKINS.ghost.accent },
];

/** Tag cloud as one string, so a drag frame (new node objects, same tags) does not re-render the panel. */
const selectTagCloudSignature = (s: MemexStore): string => JSON.stringify(buildTagCloud(s.nodes));

const selectSetQuery = (s: MemexStore) => s.setSpotlightQuery;
const selectSetType = (s: MemexStore) => s.setSpotlightType;
const selectToggleTag = (s: MemexStore) => s.toggleSpotlightTag;
const selectClear = (s: MemexStore) => s.clearSpotlight;

/** The last `dockFocusRequest` this module answered; a fresh value focuses the search field once. */
let answeredFocusRequest = 0;

/**
 * "Spotlight & Filter": fuzzy search, a card-type filter and a tag cloud. The
 * store holds the filters (session-only); cards read them through
 * `selectNodeSpotlightDim` and fade to 15% when they do not match. The search
 * field takes focus whenever `/` bumps `dockFocusRequest`.
 */
export function SpotlightPanel() {
  const query = useMemexStore(selectSpotlightQuery);
  const type = useMemexStore(selectSpotlightType);
  const selectedTags = useMemexStore(selectSpotlightTags);
  const active = useMemexStore(selectIsSpotlightActive);
  const matches = useMemexStore(selectSpotlightMatchCount);
  const total = useMemexStore(selectCuratorCardCount);
  const cloudSignature = useMemexStore(selectTagCloudSignature);
  const focusRequest = useMemexStore(selectDockFocusRequest);
  const setQuery = useMemexStore(selectSetQuery);
  const setType = useMemexStore(selectSetType);
  const toggleTag = useMemexStore(selectToggleTag);
  const clear = useMemexStore(selectClear);
  const inputRef = useRef<HTMLInputElement>(null);

  const cloud = useMemo(() => JSON.parse(cloudSignature) as { tag: string; count: number }[], [cloudSignature]);
  const selectedSet = useMemo(() => new Set(selectedTags), [selectedTags]);

  useEffect(() => {
    if (focusRequest === answeredFocusRequest) return;
    answeredFocusRequest = focusRequest;
    const input = inputRef.current;
    if (input === null) return;
    input.focus({ preventScroll: true });
    input.select();
  }, [focusRequest]);

  return (
    <>
      <header>
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-text-muted">
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: "#FFB236", boxShadow: "0 0 8px 2px rgba(255, 178, 54, 0.6)" }}
          />
          <span role="status" aria-live="polite" data-match-count>
            {matches} of {total} {total === 1 ? "card" : "cards"}
          </span>
        </div>
        <h2 className="mt-1 font-serif text-lg font-semibold text-text-primary">Spotlight &amp; Filter</h2>
      </header>

      <label className="block font-mono text-[10px] uppercase tracking-[0.18em] text-text-muted">
        <span className="flex items-center justify-between">
          Search the archive
          <kbd
            aria-hidden="true"
            className="rounded border border-[#FFB236]/40 px-1 text-[10px] font-semibold normal-case tracking-normal"
          >
            /
          </kbd>
        </span>
        <input
          ref={inputRef}
          type="search"
          value={query}
          maxLength={200}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Title, tag, author, text…"
          aria-keyshortcuts="/"
          autoComplete="off"
          spellCheck={false}
          className="mt-1 w-full rounded-xl border border-[#FFB236]/40 bg-[#090A0F] px-3 py-2 font-serif text-[14px] normal-case tracking-normal text-text-primary outline-none placeholder:text-text-muted focus:border-[#FFB236] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[#FFB236]"
        />
      </label>

      <section aria-label="Card type filter">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-text-muted">Card type</div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {TYPE_PILLS.map((pill) => {
            const pressed = type === pill.type;
            return (
              <button
                key={pill.type}
                type="button"
                aria-pressed={pressed}
                onClick={() => setType(pill.type)}
                className={`${BTN} bg-[#141721]`}
                style={{
                  color: pressed ? "#090A0F" : pill.accent,
                  background: pressed ? pill.accent : "#141721",
                  borderColor: pressed ? pill.accent : rgba(pill.accent === "#F4F1EA" ? "#8E94A5" : pill.accent, 0.5),
                }}
              >
                {pill.label}
              </button>
            );
          })}
        </div>
      </section>

      <section aria-label="Tag cloud" className="min-h-0 flex-1 overflow-y-auto">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-text-muted">Tags</div>
        {cloud.length === 0 ? (
          <p className="mt-1 font-serif text-[12px] leading-snug text-text-muted">No tags yet. Tag a card to filter by it here.</p>
        ) : (
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {cloud.map(({ tag, count }) => {
              const pressed = selectedSet.has(tag);
              return (
                <li key={tag}>
                  <button
                    type="button"
                    aria-pressed={pressed}
                    onClick={() => toggleTag(tag)}
                    className="cursor-pointer rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider transition-[color,border-color,background-color] duration-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[#FFB236]"
                    style={{
                      color: pressed ? "#090A0F" : "#FFB236",
                      background: pressed ? "#FFB236" : "#141721",
                      borderColor: pressed ? "#FFB236" : "rgba(255, 178, 54, 0.4)",
                    }}
                  >
                    {tag} <span aria-hidden="true">· {count}</span>
                    <span className="sr-only">
                      , {count} {count === 1 ? "card" : "cards"}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <button
        type="button"
        onClick={clear}
        disabled={!active}
        className={`${BTN} border-white/10 bg-[#141721] text-text-muted hover:text-text-primary`}
      >
        [Clear]
        <span className="sr-only"> all filters</span>
      </button>
    </>
  );
}
