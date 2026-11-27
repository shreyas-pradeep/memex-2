"use client";

import {
  memo,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  BLAZE_ORDER_HINT,
  CURATOR_DRAWER_ID,
  CURATOR_EMPTY_TEXT,
  CURATOR_TITLE,
  CURATOR_TRIGGER_ID,
  blazeFormState,
  curatorDrawerReducer,
  parseTrailCardModels,
  weaveQuickAction,
  type CuratorKeyEvent,
  type TrailCardModel,
} from "@/core/curators-index";
import { WEAVE_BUTTON_LABEL } from "@/core/sprocket-motion";
import { EDGE_COLORS } from "@/core/types";
import {
  parseSelectionSignature,
  selectCuratorActiveTrailId,
  selectCuratorCardCount,
  selectCuratorTrailCount,
  selectIsCuratorOpen,
  selectSelectionSignature,
  selectTrailListSignature,
} from "@/store/curator-selectors";
import { useBriefingSession } from "@/store/useBriefingSession";
import { useMemexStore, type MemexStore } from "@/store/useMemexStore";
import {
  selectIsWeaving,
  selectWeavingTrailId,
  useSprocketSession,
} from "@/store/useSprocketSession";
import { rgba } from "../canvas/card-skins";
import { isEditableTarget, isModalDialogOpen } from "./key-context";

const SPRING = { type: "spring", stiffness: 300, damping: 28 } as const;
/** Reduced motion: no slide, a short fade. */
const FADE = { duration: 0.15, ease: "linear" } as const;

const AMBER = EDGE_COLORS.human;
const VIOLET = EDGE_COLORS.ghost;
const BORDER = "rgba(255, 178, 54, 0.2)";

/** Below this width the drawer and the Synapse Inspector would cover the canvas together. */
const NARROW_QUERY = "(max-width: 1099px)";

const selectInspectorOpen = (s: MemexStore) => s.selectedGhostDiscoveryId !== null;

const BTN =
  "cursor-pointer rounded-xl border px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_2px_0_rgba(0,0,0,0.65)] transition-[color,border-color,transform] duration-100 active:translate-y-[2px] disabled:cursor-not-allowed disabled:opacity-40 disabled:active:translate-y-0 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2";
const BTN_AMBER = `${BTN} border-[#FFB236]/50 bg-[#141721] text-[#FFB236] hover:border-[#FFB236] focus-visible:outline-[#FFB236]`;
const BTN_VIOLET = `${BTN} border-[#B388FF]/55 bg-[#141721] text-[#B388FF] hover:border-[#B388FF] focus-visible:outline-[#B388FF]`;
const BTN_QUIET = `${BTN} border-white/10 bg-[#141721] text-text-muted hover:text-text-primary focus-visible:outline-[#FFB236]`;
const LABEL = "font-mono text-[10px] uppercase tracking-[0.18em] text-text-muted";

// ---------------------------------------------------------------------------
// Keyboard: [T] toggles, Escape closes, and nothing underneath reacts to either
// ---------------------------------------------------------------------------

/**
 * One window `keydown` listener in the capture phase. The pure reducer decides
 * whether the key means anything. When the drawer closes on Escape, the event
 * is stopped before it reaches the bubble-phase listeners (the playback dock's
 * "Escape exits", the Synapse Inspector's, the weave cancel), so Escape closes
 * the drawer and nothing else. Removed on unmount.
 */
function useCuratorKeyboard(panelRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const store = useMemexStore.getState();
      const target = e.target;
      const event: CuratorKeyEvent = {
        key: e.key,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
        repeat: e.repeat,
        defaultPrevented: e.defaultPrevented,
        targetIsEditable: isEditableTarget(target),
        targetInsideDrawer: target instanceof Node && panelRef.current?.contains(target) === true,
        modalOpen: isModalDialogOpen(),
      };
      const before = store.isCuratorDrawerOpen;
      const after = curatorDrawerReducer(before, { type: "key", event });
      if (after === before) return;
      e.preventDefault();
      if (e.key === "Escape") e.stopPropagation();
      store.setCuratorDrawerOpen(after);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [panelRef]);
}

/**
 * Focus moves into the drawer when it opens and back to the top-bar trigger
 * when it closes (a skipped return lets the Synapse Inspector keep focus when
 * it takes over a narrow screen).
 */
function useDrawerFocus(
  open: boolean,
  panelRef: RefObject<HTMLElement | null>,
  skipReturnRef: RefObject<boolean>,
): void {
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      panelRef.current?.focus({ preventScroll: true });
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    if (skipReturnRef.current) {
      skipReturnRef.current = false;
      return;
    }
    document.getElementById(CURATOR_TRIGGER_ID)?.focus({ preventScroll: true });
  }, [open, panelRef, skipReturnRef]);
}

/**
 * On a narrow viewport the drawer and the Synapse Inspector exclude each other:
 * whichever opens last closes the other. Wide viewports show both.
 */
function useInspectorExclusion(open: boolean, skipReturnRef: RefObject<boolean>): void {
  const inspectorOpen = useMemexStore(selectInspectorOpen);
  const previous = useRef({ open: false, inspector: false });
  useEffect(() => {
    const before = previous.current;
    previous.current = { open, inspector: inspectorOpen };
    if (!open || !inspectorOpen) return;
    if (typeof window === "undefined" || !window.matchMedia(NARROW_QUERY).matches) return;
    const store = useMemexStore.getState();
    if (!before.open) {
      store.selectGhostDiscovery(null);
    } else if (!before.inspector) {
      skipReturnRef.current = true;
      store.setCuratorDrawerOpen(false);
    }
  }, [open, inspectorOpen, skipReturnRef]);
}

// ---------------------------------------------------------------------------
// Trail card
// ---------------------------------------------------------------------------

interface TrailCardProps {
  model: TrailCardModel;
  active: boolean;
  isNew: boolean;
  weaving: boolean;
  confirming: boolean;
  onLoad: (id: string) => void;
  onBriefing: (id: string) => void;
  onAskDelete: (id: string) => void;
  onConfirmDelete: (id: string) => void;
  onCancelDelete: (id: string) => void;
}

const TrailCard = memo(function TrailCard({
  model,
  active,
  isNew,
  weaving,
  confirming,
  onLoad,
  onBriefing,
  onAskDelete,
  onConfirmDelete,
  onCancelDelete,
}: TrailCardProps) {
  const { accent } = model;
  const trashRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  // Keyboard users land on the safe choice when the confirm appears, and return to the trash when it is cancelled.
  useEffect(() => {
    if (confirming) {
      wasConfirming.current = true;
      cancelRef.current?.focus({ preventScroll: true });
    } else if (wasConfirming.current) {
      wasConfirming.current = false;
      trashRef.current?.focus({ preventScroll: true });
    }
  }, [confirming]);
  const empty = model.stopCount === 0;
  const loadTitle = empty
    ? "This trail has no cards left."
    : weaving
      ? "Sprocket is weaving this trail."
      : "Load into the 1945 Lever at stop 1";
  return (
    <li
      aria-current={active ? "true" : undefined}
      data-trail-id={model.id}
      className="rounded-2xl border bg-[#141721] p-3"
      style={{
        borderColor: active || isNew ? accent : rgba(accent, 0.28),
        boxShadow: active
          ? `inset 0 1px 0 rgba(255,255,255,0.06), 0 0 18px 1px ${rgba(accent, 0.3)}`
          : "inset 0 1px 0 rgba(255,255,255,0.05)",
      }}
    >
      <div className="flex items-start gap-2">
        <span
          aria-hidden="true"
          data-color-pill
          className="mt-1.5 h-2 w-5 shrink-0 rounded-full"
          style={{ background: accent, boxShadow: `0 0 8px 2px ${rgba(accent, 0.55)}` }}
        />
        <div className="min-w-0 flex-1">
          <h3 className="break-words font-serif text-[15px] font-semibold leading-snug text-text-primary">
            {model.title}
          </h3>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em]">
            <span
              className="rounded-full px-2 py-px font-semibold"
              style={{ color: accent, border: `1px solid ${rgba(accent, 0.55)}` }}
            >
              {model.archetypeLabel}
            </span>
            {active ? (
              <span className="rounded-full px-2 py-px font-semibold" style={{ color: AMBER, border: `1px solid ${rgba(AMBER, 0.55)}` }}>
                On the lever
              </span>
            ) : null}
            {isNew ? (
              <span className="rounded-full px-2 py-px font-semibold" style={{ color: VIOLET, border: `1px solid ${rgba(VIOLET, 0.55)}` }}>
                New
              </span>
            ) : null}
          </div>
        </div>
      </div>
      {model.description !== "" ? (
        <p className="mt-2 line-clamp-3 font-serif text-[12px] leading-snug text-text-muted">
          {model.description}
        </p>
      ) : null}
      <div className="mt-2 font-mono text-[11px] tracking-wide" style={{ color: accent }}>
        {model.summaryLine}
      </div>
      {model.breadcrumbs.length > 0 ? (
        <ol aria-label="Stops in trail order" className="mt-2 flex flex-wrap items-center gap-x-1 gap-y-1">
          {model.breadcrumbs.map((b, i) => (
            <li key={`${b.nodeId}-${i}`} className="flex items-center gap-1">
              {i > 0 ? (
                <span aria-hidden="true" className="font-mono text-[10px] text-text-muted">
                  →
                </span>
              ) : null}
              <span
                title={b.fullLabel}
                className="max-w-[170px] truncate rounded-full border border-white/10 bg-[#090A0F] px-2 py-0.5 font-mono text-[10px] text-text-primary"
              >
                {b.label}
              </span>
            </li>
          ))}
          {model.overflowCount > 0 ? (
            <li className="flex items-center gap-1">
              <span aria-hidden="true" className="font-mono text-[10px] text-text-muted">
                →
              </span>
              <span
                title={`${model.overflowCount} more ${model.overflowCount === 1 ? "stop" : "stops"}`}
                aria-label={`${model.overflowCount} more ${model.overflowCount === 1 ? "stop" : "stops"}`}
                className="rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold"
                style={{ color: accent, borderColor: rgba(accent, 0.5) }}
              >
                +{model.overflowCount}
              </span>
            </li>
          ) : null}
        </ol>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onLoad(model.id)}
          disabled={empty || weaving}
          title={loadTitle}
          aria-label={`Load ${model.title} into the 1945 Lever at stop 1`}
          className={BTN_AMBER}
        >
          <span aria-hidden="true">[▶ LOAD INTO 1945 LEVER]</span>
        </button>
        <button
          type="button"
          onClick={() => onBriefing(model.id)}
          disabled={empty}
          aria-haspopup="dialog"
          title="Export a research briefing for this trail"
          aria-label={`Export briefing for ${model.title}`}
          className={BTN_VIOLET}
        >
          <span aria-hidden="true">[⚡ BRIEFING]</span>
        </button>
        {confirming ? (
          <span role="group" aria-label={`Confirm deleting ${model.title}`} className="ml-auto flex items-center gap-1.5">
            <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-text-primary">
              Delete?
            </span>
            <button
              type="button"
              onClick={() => onConfirmDelete(model.id)}
              aria-label={`Confirm delete ${model.title}${active ? ". This ends trail playback" : ""}`}
              title={active ? "Delete and end playback" : "Delete this trail"}
              className={`${BTN} border-[#FFB236] bg-[#FFB236] px-2.5 text-[#090A0F] hover:brightness-110 focus-visible:outline-[#FFB236]`}
            >
              ✓
            </button>
            <button
              ref={cancelRef}
              type="button"
              onClick={() => onCancelDelete(model.id)}
              aria-label="Cancel delete"
              title="Keep this trail"
              className={`${BTN_QUIET} px-2.5`}
            >
              ✕
            </button>
          </span>
        ) : (
          <button
            ref={trashRef}
            type="button"
            onClick={() => onAskDelete(model.id)}
            disabled={weaving}
            title={weaving ? "Sprocket is weaving this trail." : "Delete this trail"}
            aria-label={`Delete trail ${model.title}`}
            className={`${BTN_QUIET} ml-auto px-2.5`}
          >
            <span aria-hidden="true">[🗑]</span>
          </button>
        )}
      </div>
    </li>
  );
});

// ---------------------------------------------------------------------------
// Blaze form
// ---------------------------------------------------------------------------

function BlazeSection({
  selection,
  onBlazed,
}: {
  selection: { id: string; title: string }[];
  onBlazed: (trailId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const formId = useId();
  const form = blazeFormState(selection.length);

  useEffect(() => {
    if (expanded) nameRef.current?.focus({ preventScroll: true });
  }, [expanded]);

  const submit = () => {
    if (!form.canSubmit) return;
    const id = useMemexStore
      .getState()
      .createManualTrail(name, description, selection.map((s) => s.id));
    if (id === null) return;
    setName("");
    setDescription("");
    setExpanded(false);
    onBlazed(id);
  };

  return (
    <section aria-label="Blaze a new trail" className="border-t pt-3" style={{ borderColor: BORDER }}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={formId}
        onClick={() => setExpanded((e) => !e)}
        className={`${BTN_AMBER} w-full`}
      >
        <span aria-hidden="true">[+ BLAZE NEW TRAIL]</span>
        <span className="sr-only">Blaze new trail</span>
      </button>
      {expanded ? (
        <form
          id={formId}
          className="mt-3 flex flex-col gap-2 rounded-2xl border bg-[#141721] p-3"
          style={{ borderColor: BORDER }}
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label className={LABEL}>
            Trail name
            <input
              ref={nameRef}
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
              placeholder="Untitled Trail"
              className="mt-1 w-full rounded-xl border border-[#FFB236]/40 bg-[#090A0F] px-2.5 py-1.5 font-serif text-[14px] normal-case tracking-normal text-text-primary outline-none focus:border-[#FFB236] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[#FFB236]"
            />
          </label>
          <label className={LABEL}>
            Description (optional)
            <textarea
              value={description}
              rows={2}
              maxLength={400}
              onChange={(e) => setDescription(e.target.value)}
              className="mt-1 w-full resize-none rounded-xl border border-white/10 bg-[#090A0F] px-2.5 py-1.5 font-serif text-[13px] normal-case tracking-normal text-text-primary outline-none focus:border-[#FFB236] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[#FFB236]"
            />
          </label>
          <div>
            <div className={LABEL}>
              Selected on canvas: <span style={{ color: AMBER }}>{selection.length}</span>
            </div>
            {selection.length > 0 ? (
              <ol
                aria-label="Selected cards in trail order"
                className="mt-1 max-h-24 list-inside list-decimal overflow-y-auto rounded-xl border border-white/10 bg-[#090A0F] px-2 py-1 font-mono text-[11px] text-text-primary"
              >
                {selection.map((s) => (
                  <li key={s.id} className="truncate" title={s.title}>
                    {s.title.trim() === "" ? "Untitled card" : s.title}
                  </li>
                ))}
              </ol>
            ) : null}
            <p className="mt-1 text-[11px] leading-snug text-text-muted">{BLAZE_ORDER_HINT}</p>
            {form.hint !== null ? (
              <p id={hintId} role="status" className="mt-1 text-[11px] font-semibold" style={{ color: AMBER }}>
                {form.hint}
              </p>
            ) : null}
          </div>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={!form.canSubmit}
              aria-describedby={form.hint !== null ? hintId : undefined}
              className={`${BTN} flex-1 border-[#FFB236] bg-[#FFB236] text-[#090A0F] hover:brightness-110 focus-visible:outline-[#FFB236]`}
            >
              [BLAZE TRAIL]
            </button>
            <button type="button" onClick={() => setExpanded(false)} className={BTN_QUIET}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Drawer body
// ---------------------------------------------------------------------------

/** Keeps the last real value while the drawer slides out and its selectors go quiet (`""`). */
function useHeld(signature: string): string {
  const [held, setHeld] = useState(signature);
  if (signature !== "" && signature !== held) setHeld(signature);
  return signature === "" ? held : signature;
}

function DrawerBody() {
  const trailSignature = useHeld(useMemexStore(selectTrailListSignature));
  const selectionSignature = useHeld(useMemexStore(selectSelectionSignature));
  const trailCount = useMemexStore(selectCuratorTrailCount);
  const cardCount = useMemexStore(selectCuratorCardCount);
  const activeTrailId = useMemexStore(selectCuratorActiveTrailId);
  const isWeaving = useSprocketSession(selectIsWeaving);
  const weavingTrailId = useSprocketSession(selectWeavingTrailId);
  const requestWeave = useSprocketSession((s) => s.requestWeave);

  const [models, setModels] = useState<TrailCardModel[]>(() => parseTrailCardModels(trailSignature));
  const [parsedFrom, setParsedFrom] = useState(trailSignature);
  if (parsedFrom !== trailSignature) {
    setParsedFrom(trailSignature);
    setModels(parseTrailCardModels(trailSignature));
  }
  const selection = parseSelectionSignature(selectionSignature);

  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [newId, setNewId] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const weave = weaveQuickAction({ cardCount, activeTrailId, isWeaving });

  const onWeave = useCallback(() => {
    // The gated request: refuses with fewer than 3 cards, an active trail or a weave in progress.
    if (requestWeave()) useMemexStore.getState().setCuratorDrawerOpen(false);
  }, [requestWeave]);
  const onLoad = useCallback((id: string) => useMemexStore.getState().loadTrailIntoLever(id), []);
  const onBriefing = useCallback((id: string) => void useBriefingSession.getState().openBriefing(id), []);
  const onAskDelete = useCallback((id: string) => setConfirmingId(id), []);
  const onCancelDelete = useCallback(() => setConfirmingId(null), []);
  const onConfirmDelete = useCallback((id: string) => {
    useMemexStore.getState().deleteTrail(id);
    setConfirmingId(null);
    setNewId((current) => (current === id ? null : current));
    // The deleted card took focus with it; park it on the list so Tab continues from here.
    listRef.current?.focus({ preventScroll: true });
  }, []);
  const onBlazed = useCallback((id: string) => {
    setNewId(id);
    listRef.current?.scrollTo({ top: 0 });
  }, []);

  const newModel = newId === null ? undefined : models.find((m) => m.id === newId);

  return (
    <>
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-text-muted">
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: AMBER, boxShadow: "0 0 8px 2px rgba(255, 178, 54, 0.6)" }}
            />
            <span role="status">
              {trailCount} {trailCount === 1 ? "trail" : "trails"} on file
            </span>
          </div>
          <h2
            id="curators-index-title"
            className="mt-1 font-mono text-[13px] font-semibold uppercase leading-snug tracking-[0.14em] text-text-primary"
            style={{ textShadow: "0 0 10px rgba(255, 178, 54, 0.45)" }}
          >
            {CURATOR_TITLE}
          </h2>
        </div>
        <button
          type="button"
          onClick={() => useMemexStore.getState().setCuratorDrawerOpen(false)}
          aria-label="Close the Curator's Index"
          title="Close (Esc)"
          className={`${BTN_QUIET} shrink-0 px-2.5 py-1.5`}
        >
          <span aria-hidden="true">[✕ CLOSE / ESC]</span>
        </button>
      </header>

      <div>
        <button
          type="button"
          onClick={onWeave}
          disabled={!weave.enabled}
          title={weave.hint}
          aria-label={`Auto-weave new trail: ${weave.hint}`}
          aria-busy={isWeaving}
          className={`${BTN_VIOLET} w-full`}
        >
          <span aria-hidden="true">[{WEAVE_BUTTON_LABEL.replace("AUTO-WEAVE TRAIL", "AUTO-WEAVE NEW TRAIL")}]</span>
        </button>
        {!weave.enabled ? (
          <p className="mt-1 text-[11px] leading-snug text-text-muted">{weave.hint}</p>
        ) : null}
      </div>

      {newModel !== undefined ? (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2 font-mono text-[11px] text-text-primary"
          style={{ borderColor: rgba(newModel.accent, 0.55), background: "#141721" }}
        >
          <span className="min-w-0 flex-1 break-words">
            Trail blazed: <span style={{ color: newModel.accent }}>{newModel.title}</span>
          </span>
          <button
            type="button"
            onClick={() => onLoad(newModel.id)}
            aria-label={`Load ${newModel.title} into the 1945 Lever`}
            className={`${BTN_AMBER} px-2.5 py-1`}
            disabled={isWeaving}
          >
            <span aria-hidden="true">[▶ LOAD NOW]</span>
          </button>
        </div>
      ) : null}

      <ul
        ref={listRef}
        tabIndex={-1}
        aria-label="Trails and reels"
        className="-mr-1 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1 outline-none"
      >
        {models.length === 0 ? (
          <li className="rounded-2xl border border-dashed border-white/15 p-4 text-center font-serif text-[13px] leading-snug text-text-muted">
            {CURATOR_EMPTY_TEXT}
          </li>
        ) : (
          models.map((m) => (
            <TrailCard
              key={m.id}
              model={m}
              active={m.id === activeTrailId}
              isNew={m.id === newId}
              weaving={m.id === weavingTrailId}
              confirming={m.id === confirmingId}
              onLoad={onLoad}
              onBriefing={onBriefing}
              onAskDelete={onAskDelete}
              onConfirmDelete={onConfirmDelete}
              onCancelDelete={onCancelDelete}
            />
          ))
        )}
      </ul>

      <BlazeSection selection={selection} onBlazed={onBlazed} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Drawer
// ---------------------------------------------------------------------------

/**
 * "The Curator's Index": the left slide-out reel archive. A non-modal dialog
 * (no focus trap, `aria-modal="false"`): focus moves in when it opens and back
 * to the top-bar trigger when it closes. It overlays the HUD while open and
 * stays below the dialogs (z 2000) and the toaster (z 2100).
 *
 * Its subscriptions are primitive strings that stay empty while it is closed,
 * so a card drag never re-renders it and never re-renders the canvas because of
 * it. Only `transform` and `opacity` animate.
 */
export function CuratorsIndexDrawer() {
  const open = useMemexStore(selectIsCuratorOpen);
  const reduce = useReducedMotion() === true;
  const panelRef = useRef<HTMLElement | null>(null);
  const skipReturnRef = useRef(false);

  useCuratorKeyboard(panelRef);
  useDrawerFocus(open, panelRef, skipReturnRef);
  useInspectorExclusion(open, skipReturnRef);

  // Backspace and Delete delete the selected cards on the canvas (React Flow listens on the
  // document). Keep them away from the buttons in here; text fields are already ignored.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key === "Backspace" || e.key === "Delete") e.stopPropagation();
  };

  return (
    <AnimatePresence>
      {open ? (
        <motion.aside
          key="curators-index"
          ref={panelRef}
          id={CURATOR_DRAWER_ID}
          role="dialog"
          aria-modal="false"
          aria-label="The Curator's Index"
          tabIndex={-1}
          onKeyDown={onKeyDown}
          initial={reduce ? { opacity: 0 } : { x: "-100%" }}
          animate={reduce ? { opacity: 1 } : { x: 0 }}
          exit={reduce ? { opacity: 0 } : { x: "-100%" }}
          transition={reduce ? FADE : SPRING}
          className="absolute top-4 bottom-4 left-4 z-40 flex w-[420px] max-w-[90vw] flex-col gap-3 rounded-2xl border bg-[#090A0F] p-4 outline-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-[#FFB236]"
          style={{
            borderColor: BORDER,
            boxShadow:
              "inset 0 1px 0 rgba(255,255,255,0.06), 0 16px 48px rgba(0,0,0,0.75), 0 0 24px rgba(255,178,54,0.08)",
          }}
        >
          <DrawerBody />
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
}
