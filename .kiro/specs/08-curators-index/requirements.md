# Requirements Document: The Curator's Index (Collapsible Left Research & Trail Hub)

> **Superseded by Spec 09 (in part).** The Curator's Index left drawer becomes the **Trails tab of the right-hand Research Command Dock** (`.kiro/specs/09-command-console-and-tactile-engine`). `isCuratorDrawerOpen`, `toggleCuratorDrawer` and `setCuratorDrawerOpen` stay as aliases of `commandDock.open && commandDock.tab === "trails"`. The `T` key now toggles the Trails tab, `Escape` collapses the dock, and the narrow-screen exclusion between the drawer and the Synapse Inspector (Requirement 10.5) no longer applies because both are tabs of one dock. The trail cards, blaze form, delete confirmation, load and briefing behavior are unchanged. Until Phase B of Spec 09 lands, the drawer component still renders.

## Introduction

The Curator's Index replaces the old top-center Trails dropdown with a left slide-out drawer, "THE CURATOR'S INDEX // REEL ARCHIVE". It lists every trail as a card (title, archetype, summary, era, ordered breadcrumbs), loads a trail into the 1945 Lever in one click, opens the research briefing for any trail, blazes new manual trails from the canvas selection, deletes trails with a two-step confirmation, and starts Sprocket's auto-weave. A top-center button and the `[T]` key open it.

Terminology maps to the real codebase (the request came from an abandoned rewrite):

| Request | Real code |
|---|---|
| `activeStepIndex` | `activeTrailIndex` |
| `cardIds` | `Trail.nodeIds` (input name `cardIds` on `createManualTrail`) |
| `name` | `Trail.title` (input name `name` on `createManualTrail`) |
| "1945 Lever dock" | `TrailPlaybackDock`, which opens when `setActiveTrail(id)` runs |
| `forgeTrail`, `forgeCustomTrail` | already exist (Spec 02); `createManualTrail` builds on `forgeCustomTrail`, and `forgeTrail` now delegates to it |
| trail archetype | `autoTrailKind(id)` (`lineage`, `debate`, `nexus`; Spec 07, encoded in `t-auto-<kind>-<hash>` ids); manual = origin `human`; fallback "Ghost Trail" for ghost-origin trails that are not auto (the seed's ghost trail, trails converted from a discovery) |
| trail color | optional `Trail.color` (`#RRGGBB`), added in this spec; otherwise derived from `origin` through `EDGE_COLORS` |
| selection order | not recorded by the canvas: order is left to right, then top to bottom (as `forgeTrail` always did) |

## Requirements

### Requirement 1: The Drawer and its Trigger
**User Story:** As a researcher, I want one tactile control that opens my reel archive without covering the canvas permanently.

#### Acceptance Criteria
1. THE SYSTEM SHALL provide `CuratorsIndexDrawer`, a left slide-out panel 420 px wide (`max-w-[90vw]`) with the chassis `#090A0F`, microfiche containers `#141721`, border `rgba(255, 178, 54, 0.2)` and amber `#FFB236` / violet `#B388FF` accents.
2. WHEN it opens, THE drawer SHALL slide in from `x: -100%` on the spring `{ stiffness: 300, damping: 28 }`; WHEN it closes, it SHALL slide back out. ONLY `transform` and `opacity` SHALL animate.
3. WHILE `prefers-reduced-motion` is set, THE drawer SHALL NOT slide: it SHALL fade by opacity in 150 ms.
4. THE header SHALL read "THE CURATOR'S INDEX // REEL ARCHIVE", show the trail count ("N trails on file") and hold a close button "[✕ CLOSE / ESC]".
5. THE top bar SHALL hold a button "[📜 TRAILS & REELS (N)]" with the hint `[T]`, where N is the trail count. IT SHALL toggle the drawer and expose `aria-expanded`, `aria-controls` (the drawer id), `aria-haspopup="dialog"` and `aria-keyshortcuts="T"`.
6. THE open state SHALL be `isCuratorDrawerOpen` in `useMemexStore` with the actions `toggleCuratorDrawer()` and `setCuratorDrawerOpen(open)`. IT SHALL start `false`.
7. THE drawer SHALL sit above the canvas HUD, the timeline, the playback dock and the Synapse Inspector (z-index 40) and below every modal dialog (2000) and the toaster (2100).

### Requirement 2: Trail Cards
**User Story:** As a researcher, I want to see what each trail is about before I load it.

#### Acceptance Criteria
1. THE list SHALL show every trail, most recently added first, in a scrollable region.
2. EACH card SHALL show: the title; a color indicator pill and glow (`Trail.color` when it is a valid `#RRGGBB`, else the origin color); an archetype badge; the description (at most three lines); the summary line "N stops • 1945 → 2026"; and the breadcrumb pills.
3. THE archetype badge SHALL read "AI Lineage Arc", "Dialectical Debate" or "Conceptual Nexus" for `t-auto-lineage|debate|nexus-<hash>` ids, "Manual Trail" for a human trail, and "Ghost Trail" for any other ghost-origin trail.
4. THE stop count SHALL count only cards that still exist. THE era SHALL be the minimum and maximum year of those cards (`getEventYear`): "1945 → 2026"; a single year shows as "1945"; with no dated card the era is left out ("5 stops").
5. THE breadcrumbs SHALL follow the trail order (the narrative sequence, not chronology). Each label SHALL be the card title (truncated to 26 characters with `…`), followed by " · Surname" or " · Surname et al." when the card has `authors` and a surname can be read from the first author. THE full label SHALL stay available as the pill's tooltip. A stop whose card is missing SHALL be skipped.
6. A trail with more than 6 stops SHALL show 6 pills and a "+N" pill for the rest.
7. THE trail that is playing SHALL be highlighted (border, glow, "On the lever" badge, `aria-current`).
8. WHEN there is no trail, THE list SHALL show "The reel archive is empty. Blaze a trail from selected cards, or let Sprocket weave one."
9. THE cards SHALL be derived through one primitive string selector (see Requirement 11).

### Requirement 3: One-Click Load
#### Acceptance Criteria
1. THE card SHALL have "[▶ LOAD INTO 1945 LEVER]". WHEN pressed, THE SYSTEM SHALL call `loadTrailIntoLever(trailId)`: `activeTrailId` is that trail, `activeTrailIndex` is `0`, `isPlayingAuto` is `false`, and the drawer closes.
2. THE action SHALL do nothing (and leave the drawer open) for an unknown id or a trail with no cards.
3. THE camera SHALL glide to stop 1 (800 ms, zoom 1.15) through the existing `TrailCameraDirector`, and the playback dock SHALL open. WHEN the trail is already active at stop 1 the camera SHALL still glide there (the session counter `trailCameraNonce`).
4. THE button SHALL be disabled while Sprocket is weaving that trail or when the trail has no cards, with a title that says why.

### Requirement 4: Briefing
#### Acceptance Criteria
1. THE card SHALL have "[⚡ BRIEFING]". WHEN pressed, THE SYSTEM SHALL open the Export Briefing dialog for that trail, whether or not it is the active trail.
2. THE playback dock's "[⚡ Export Briefing]" button SHALL keep working through the same shared dialog state (`useBriefingSession`), and the dock SHALL still ignore its keyboard shortcuts while the dialog is open.
3. THE dialog state SHALL be session-only and SHALL NOT be persisted or exported.

### Requirement 5: Blaze a New Trail
#### Acceptance Criteria
1. THE bottom section SHALL hold "[+ BLAZE NEW TRAIL]", which expands an inline form: trail name, optional description, and a live list and count of the cards selected on the canvas (`node.selected`).
2. THE selected cards SHALL be ordered left to right, then top to bottom (ties by id). THE form SHALL say that the canvas does not record the order in which cards were clicked.
3. WITH fewer than 2 selected cards, THE submit button SHALL be disabled and an inline hint SHALL say "Select at least 2 cards on the canvas to blaze a trail."
4. THE SYSTEM SHALL provide `createManualTrail(name, description, cardIds, color?)`, built on `forgeCustomTrail`. IT SHALL keep the exact order of `cardIds`, drop repeated ids (first occurrence wins) and ids that do not exist, require at least 2 valid cards (else return `null`, change nothing, write nothing), trim the name (empty becomes "Untitled Trail"), use origin `human`, give an id that no existing trail has, persist once and return the new id.
5. `Trail` SHALL gain ONLY an optional `color?: string`. AN invalid value (not `#RRGGBB`) SHALL be ignored when stored and when read. Auto trails SHALL keep exactly their six keys, old saves SHALL load unchanged, and export and import SHALL round-trip the field deterministically.
6. AFTER a successful blaze, THE new trail SHALL appear at the top, marked "New", with a "Trail blazed" notice and a "[▶ LOAD NOW]" button.
7. THE canvas selection SHALL survive interacting with the drawer.
8. THE old "+ FORGE TRAIL" entry point SHALL be replaced by this form. `forgeTrail` SHALL remain in the store and delegate to `createManualTrail`.

### Requirement 6: Delete
#### Acceptance Criteria
1. EACH card SHALL have "[🗑]" (labelled "Delete trail <title>"). Pressing it SHALL replace it with an inline "Delete? ✓ ✕" (no `window.confirm`); focus SHALL move to "✕". "✓" SHALL call `deleteTrail(trailId)`; "✕" SHALL cancel and return focus to "[🗑]".
2. ANY trail MAY be deleted, except the one Sprocket is weaving right now (the button is disabled with a title).
3. `deleteTrail(trailId)` SHALL remove the trail through the pure `removeTrail`, clear the `trailId` of discoveries that were converted into it, persist once, and do nothing for an unknown id.
4. IF the deleted trail is the active trail, THE SYSTEM SHALL exit playback (`activeTrailId` null, index 0, auto-play off, the same state as `exitTrailPlayback`).
5. DELETING an auto trail SHALL NOT block generating it again later (`generateAndAddAutoTrails` treats it as new).

### Requirement 7: Auto-Weave Quick Action
#### Acceptance Criteria
1. THE quick action bar SHALL hold "[🧶 AUTO-WEAVE NEW TRAIL]". IT SHALL call the gated `requestWeave()` and, when it returns `true`, close the drawer so the show is visible.
2. IT SHALL be disabled, with an explanatory title and visible text, while a trail is active, while Sprocket is weaving, or with fewer than 3 cards (the HUD button's rules, from `canStartWeave`).

### Requirement 8: Replacing the Legacy Dropdown
#### Acceptance Criteria
1. `TrailSelectorMenu.tsx` SHALL be deleted, with its mount and imports. NO dead code SHALL remain.
2. EVERY copy that named the old menu SHALL name the new controls: the Ghost Guidance Beacon states `no-trails` ("... open [📜 TRAILS & REELS] or press [T] and choose [+ BLAZE NEW TRAIL].") and `cards-no-trail` ("Open [📜 TRAILS & REELS] or press [T] to pick an associative trail and pull up the 1945 Lever."), and Sprocket's weave-cancelled bubble. EVERY guidance state SHALL stay non-empty and actionable.
3. THE documents of Specs 02, 06 and 07 that named the menu SHALL be updated.

### Requirement 9: Keyboard
#### Acceptance Criteria
1. WHEN the user presses `T` or `t` (Shift allowed), THE SYSTEM SHALL toggle the drawer, EXCEPT with Ctrl, Meta or Alt held, for an auto-repeat, when another handler already took the event, while the user types in an input, textarea, select or contenteditable element, and while a blocking modal dialog (platen, add card, AI settings, briefing) is open.
2. WHEN the drawer is open and the user presses Escape, THE SYSTEM SHALL close the drawer ONLY. IT SHALL NOT exit trail playback, cancel a weave or close the Synapse Inspector. A modal dialog keeps its own Escape; a text field outside the drawer (an inline card editor) keeps its own Escape; the blaze form inside the drawer does not.
3. WHEN the drawer is closed, Escape SHALL behave as before (the dock exits playback).
4. WHILE the drawer is open, THE playback dock SHALL ignore its arrow-key and Escape shortcuts. The dock SHALL always ignore them while the user types, so arrows in the blaze form never step the trail.
5. THE precedence rules (`isCuratorHotkey`, `isCuratorEscape`, `curatorDrawerReducer`, `resolveEscapeOwner`, `shouldDockHandleKeys`) SHALL be pure and testable without a DOM. THE key listener SHALL be removed when the component unmounts.
6. Backspace and Delete pressed on a control inside the drawer SHALL NOT delete the selected canvas cards.

### Requirement 10: Accessibility
#### Acceptance Criteria
1. THE drawer SHALL be `role="dialog"` with `aria-modal="false"` and `aria-label="The Curator's Index"`. IT SHALL NOT trap focus.
2. WHEN it opens, FOCUS SHALL move into the drawer. WHEN it closes, FOCUS SHALL return to the top-bar trigger (not when the Synapse Inspector takes over on a narrow screen).
3. EVERY control SHALL be a real `<button>` with an accessible name that includes the trail title where it acts on a trail, keyboard operable and with a visible focus ring.
4. THE trail count and notices SHALL be announced through `role="status"` regions.
5. BELOW 1100 px, THE drawer and the Synapse Inspector SHALL exclude each other: opening one closes the other. Above that width both may be open.

### Requirement 11: Performance, State and Constraints
#### Acceptance Criteria
1. THE canvas SHALL NOT re-render because of the drawer: the drawer is mounted outside React Flow, the trigger subscribes to two primitives (trail count, open flag), and the drawer's lists come from primitive string selectors that return `""` while it is closed and change only when a trail, or a title, author or date of a card in a trail, changes. A card drag changes none of them.
2. `isCuratorDrawerOpen`, `trailCameraNonce` and the briefing dialog state SHALL be session-only: never in `localStorage`, never in the export JSON. `hydrate`, `resetToSeed` and `importJson` SHALL leave the drawer state as it is.
3. THE pure logic SHALL live in `src/core/curators-index.ts` (no React, no store), and every graph change in `src/core/` SHALL stay pure.
4. NO SVG `<filter>`, NO `backdrop-blur` and NO CSS blur filter SHALL be used. THE palette SHALL stay `#090A0F`, `#141721`, `#FFB236`, `#B388FF` with the parchment and slate text tokens.
5. ALL existing tests SHALL keep passing; only the copy assertions that name the old menu change.
