/**
 * DOM readings for the pure keyboard rules in `core/curators-index`. These are
 * the only places that touch the document, so the rules stay testable as data.
 */

/** True when the event target is a text field, select or contenteditable element. */
export function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

/**
 * True while a blocking dialog is mounted. The platen, add-card, AI settings and
 * briefing dialogs all render `aria-modal="true"` only while open; the
 * non-modal drawers use `aria-modal="false"` and do not count.
 */
export function isModalDialogOpen(): boolean {
  return typeof document !== "undefined" && document.querySelector('[aria-modal="true"]') !== null;
}
