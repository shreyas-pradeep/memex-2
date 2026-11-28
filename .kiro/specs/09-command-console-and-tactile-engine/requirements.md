# Requirements Document: The Research Command Console & Tactile Spatial Engine

## Introduction

Spec 09 turns the canvas into a console you can steer and a surface you can handle. It has five parts:

1. **Research Command Dock.** One right-hand dock with three tabs (Trails, Synapse, Spotlight) and a collapsed rail replaces the Curator's Index drawer (Spec 08) and the Synapse Inspector drawer (Spec 03). Hotkeys `T`, `/` and `Esc` drive it.
2. **Magnetic associative snapping.** Dragging a card next to a related, unconnected card pulls the two together with a violet arc. Dropping inside the pull connects them.
3. **Microfiche cassettes.** All cards distilled from one ingested source share a cassette. A frame around them moves them as one unit.
4. **Portable bundle.** The whole graph exports to one `.memex` JSON bundle and imports back through a strict validator, with a restore confirmation and drag-and-drop.
5. **Obsidian export and Spotlight.** A ZIP of Markdown files with bidirectional wikilinks, and a fuzzy search with type and tag filters that dims what does not match.

The work is split in two runs. **Phase A** (this run) delivers the specification, the pure core in `src/core/`, the store, the ingestion wiring and the tests. **Phase B** delivers every React component. Requirements marked **[B]** below are implemented in phase B; the pure rules and store actions behind them exist in phase A and are tested.

Terminology maps to the real codebase (the request came from an abandoned rewrite):

| Request | Real code |
|---|---|
| `ArchivalCardData` | `MemexNodeData` (cards are `MemexNode`, store field `nodes`) |
| `AssociativeEdgeData` | `AssociativeEdge` (data: `AssociativeEdgeData`) |
| `MemexStore` as bundle input | the pure `MemexGraphState` plus a small `GhostBundleSettings` object (core cannot import the store) |
| `activeSynapse` | `selectedGhostDiscoveryId` for a ghost discovery, `inspectedEdgeId` for a real edge |
| `findGhostSynapses` | `detectGhostSynapses` |
| bundle importer returning `Partial<MemexStore>` | `validateAndImportBundle(json): BundleImportResult` (the store applies it) |
| "affinity >= 0.70", later "affinity >= 0.55" | the MAGNETIC affinity: the calibrated confidence shown as X% on synapse pills at and above the Ghost detection threshold, a linear ramp below it (see Requirement 2) |
| "Euclidean distance < 260 px", later "< 380 px" | the gap between the two card rectangles (see Requirement 2) |

## Requirements

### Requirement 1: The Research Command Dock
**User Story:** As a researcher, I want one dock for trails, synapses and search, so that I do not juggle two drawers and a dropdown.

#### Acceptance Criteria
1. THE SYSTEM SHALL provide one dock on the right edge with the tabs **Trails**, **Synapse** and **Spotlight**, and a collapsed rail that shows the three tab buttons and stays on screen while the dock is collapsed. **[B]**
2. THE dock state SHALL be `commandDock: { open: boolean; tab: "trails" | "synapse" | "spotlight" }` in `useMemexStore`, starting `{ open: false, tab: "trails" }`. Collapsing SHALL keep the tab, so expanding returns to it.
3. THE store SHALL provide `openDockTab(tab)`, `toggleDockTab(tab)`, `collapseDock()`, `expandDock()` and `dispatchDockKey(event)`. Every action SHALL be a no-op (no state write) when nothing changes.
4. THE Trails tab SHALL hold what the Curator's Index held (Spec 08 Requirements 2 to 7). THE Synapse tab SHALL hold what the Synapse Inspector held (Spec 03 Requirement 3) and also inspect a real edge. THE Spotlight tab SHALL hold the search field, the type filter and the tag cloud (Requirement 6). **[B]**
5. WHEN a ghost discovery is selected (`selectGhostDiscovery(id)` with a known id) or a real edge is inspected (`inspectEdge(id)` with a known id), THE SYSTEM SHALL open the dock on the Synapse tab. Clearing the selection SHALL NOT close the dock.
6. THE SYSTEM SHALL keep at most one of `selectedGhostDiscoveryId` and `inspectedEdgeId` set: selecting one clears the other. `inspectEdge` SHALL accept only ids of real store edges; an unknown id or `null` clears the inspection. Removing the inspected edge SHALL clear it.
7. WHEN the user presses `T` or `t` (Shift allowed), THE SYSTEM SHALL toggle the Trails tab: open on Trails collapses the dock; closed, or open on another tab, opens Trails.
8. WHEN the user presses `/`, THE SYSTEM SHALL open the Spotlight tab, request focus for its search field (`dockFocusRequest` increases by one, also when already open) and prevent the default action, so the slash is never typed.
9. WHEN the dock is open and the user presses `Escape`, THE SYSTEM SHALL collapse it ONLY: it SHALL NOT exit trail playback or cancel a weave. A modal dialog keeps its own Escape. A text field outside the dock (an inline card editor) keeps its own Escape; a text field inside the dock does not.
10. THE shortcuts `T` and `/` SHALL be ignored with Ctrl, Meta or Alt held, for an auto-repeat, when another handler already took the event, while the user types in an input, textarea, select or contenteditable element, and while any `aria-modal="true"` dialog is open. THE SYSTEM SHALL call `preventDefault` only for a handled key.
11. THE Escape precedence SHALL be: modal dialog, then the command dock, then trail playback (`resolveDockEscapeOwner`). THE trail playback dock SHALL ignore arrows and Escape while the command dock is open, a modal is open or the user types (`shouldPlaybackHandleKeys`).
12. THE Spec 08 names `isCuratorDrawerOpen`, `toggleCuratorDrawer()` and `setCuratorDrawerOpen(open)` SHALL remain as thin session-only aliases: `isCuratorDrawerOpen` equals `commandDock.open && commandDock.tab === "trails"`. `setCuratorDrawerOpen(false)` SHALL leave a dock that shows another tab open.
13. `loadTrailIntoLever` SHALL collapse the dock when it shows the Trails tab, and leave it alone otherwise.
14. THE dock state, `dockFocusRequest` and `inspectedEdgeId` SHALL be session-only: never in `localStorage`, never in an export or a bundle. `hydrate`, `resetToSeed`, `importJson` and `importBundle` SHALL leave the dock state as it is.
15. BELOW 1100 px the former drawer-versus-inspector exclusion rule (Spec 08 Requirement 10.5) no longer applies: both live in one dock, so there is nothing to exclude.

### Requirement 2: Magnetic Associative Snapping
**User Story:** As a researcher, I want related cards to pull together as I drag, so that I connect ideas by handling them.

#### Acceptance Criteria
1. WHILE a single card is dragged, THE SYSTEM SHALL offer a `MagneticTarget { sourceId, targetId, affinity, concept, rationale }` when another card is in range, is related and is not connected to the dragged card. `sourceId` is the dragged card.
2. **Range.** A card is in range when the shortest Euclidean gap between the two card RECTANGLES is below `MAGNETIC_RANGE_PX = 380` (it was 260 in the first build). The gap is 0 when the rectangles overlap or touch. Rectangle sizes come from `style.width/height`, then `width/height`, then the measured size, then `DEFAULT_CARD_SIZE` (340 x 230). A gap of exactly 380 is out of range.
3. **Relation.** A card is related when the MAGNETIC affinity of the pair is at least `MAGNETIC_MIN_AFFINITY = 0.55` (it was 0.70 on the calibrated scale in the first build). `magneticAffinity(rawScore)` in `ghost-engine.ts` is: `0` for a raw score of 0; the Ghost engine's calibrated confidence (`calibrateGhostConfidence`, the X% on synapse pills) for a raw score at or above `DEFAULT_GHOST_THRESHOLD` (0.3); and, below the threshold, a linear ramp from 0 up to the calibrated confidence AT the threshold. The scale is continuous, monotone non-decreasing and within [0, 1]. The calibration is linear from 0.78 at raw score 0 to 0.96 at 0.6, so the value at the threshold is 0.87 (0.78 is only the value at score 0); the ramp ends at 0.87 so the scale has no jump. With the floor at 0.55 the raw cutoff below the threshold is `0.3 * 0.55 / 0.87`, about 0.19 (`magneticRawCutoff`). `detectGhostSynapses`, `scoreGhostPairs`, `pairAffinity` and the synapse pill percentages are unchanged (a snapshot test generated before the change pins them on the demo seed). **Guard:** a pair BELOW the detection threshold is a candidate only when the two cards share at least one lexicon concept or one tag (`pairMagneticAffinity`); a pair at or above the threshold is never gated. The pair's rationale is `synthesizeBridgeRationale` at or above the threshold; below it, a plain statement of what is shared (`synthesizeSharedRationale`: `"A" and "B" were never linked. Shared concept: X. Shared tags: y and z.`), with no invented claims. The whisper pill shows `round(affinity * 100)`%.
4. THE candidates SHALL exclude the dragged card itself, a missing card, and any card joined to the dragged card by a real edge in either direction. A pair that is only a pending ghost discovery SHALL still qualify.
5. WHEN several candidates are in range, THE SYSTEM SHALL pick the nearest by rectangle gap, then the higher affinity, then the smaller id.
6. WHEN two or more cards are dragged together, THE SYSTEM SHALL offer no target. **Single-card isolation:** a plain press (no Shift, Cmd/Meta or Ctrl held, primary button) on a card that is part of a multi-selection SHALL collapse the selection to that card before the drag begins (`shouldIsolateDrag` in `src/core/drag-isolation.ts`; `SingleCardDragIsolation` applies it through React Flow's `addSelectedNodes`), so the drag is a single-card drag and snaps. WHEN Shift, Cmd or Ctrl is held the user intends a group drag: the selection stays, the group moves together and no target is offered. A press on a card control (handle, resize handle, input, button, `nodrag`) never changes the selection. A drag grabbed on the box-selection rectangle reports through `onSelectionDragStart/Drag/Stop`; it takes part when exactly one card is dragged.
7. WHEN a drag starts, `beginMagneticDrag(nodeId)` SHALL score the card against the canvas once and cache the candidates (with concept and rationale) outside React state. On every frame `updateMagneticDrag(nodeId)` SHALL only measure rectangle gaps to the candidates, and SHALL write `magneticTarget` to the store only when the offer changes.
8. WHEN the card is dropped with an active target, `endMagneticDrag(nodeId)` SHALL create a human edge exactly as accepting a discovery does (rationale = the generated rationale, strength = the affinity, origin `human`), SHALL remove any ghost discovery for the same pair, SHALL persist once through the normal commit path and SHALL return `{ snapped: true, edgeId }`. IF the pair got connected in the meantime, it SHALL add nothing and return `{ snapped: false }`.
9. THE SYSTEM SHALL clear the target and the cached candidates on drop, on `cancelMagneticDrag()`, on `hydrate`, `resetToSeed` and any import, and when the dragged card is deleted. WHEN a candidate card is deleted or gets connected during the drag, it SHALL leave the candidates and a target that named it SHALL be withdrawn.
10. `magneticTarget` and `lastSnapEdgeId` SHALL be session-only. `lastSnapEdgeId` SHALL hold the new edge id for 1200 ms after a snap so the UI can pulse that edge, then return to `null`.
11. WHILE a target is offered, THE canvas SHALL draw a violet (`#B388FF`) arc between the two cards with the label "⚡ X% · concept", and the target card SHALL show a `ring-2 ring-accent-ghost/60` ring (the Ghost violet `#B388FF` at 60%; `purple-400` is not in the palette) whose opacity pulses gently, steady under `prefers-reduced-motion`. A card SHALL give one haptic tick (`navigator.vibrate?.(8)`, feature-detected, inside try/catch, skipped under reduced motion) when it becomes the target, never per frame. ON a snap the new edge SHALL pulse amber (`#FFB236`) once. WHILE `prefers-reduced-motion` is set, the arc SHALL be static and the pulse SHALL be a plain opacity change. **[B]**

### Requirement 3: Microfiche Cassettes
**User Story:** As a researcher, I want the cards of one paper to travel together, so that I can place a whole source in one move.

#### Acceptance Criteria
1. `MemexNodeData` SHALL gain ONLY the optional `cassetteId?: string` and `cassetteTitle?: string`. Old saves load unchanged, key order in exports stays deterministic, and an absent field is never written.
2. WHEN a source is ingested (file, pasted text or arXiv), THE SYSTEM SHALL give ALL generated cards one cassette. THE id SHALL be `cassette-<arxivId>` for an arXiv paper (version suffix dropped, e.g. `cassette-1706.03762`) and `cassette-<8-hex hash>` otherwise, using the same hash that prefixes the card ids. THE title SHALL be the source title, cut at a word boundary to 80 characters.
3. THE cassette id SHALL be collision-safe against the cassettes already on the canvas: the same id with the same title is the same source and is reused; the same id with another title gets `-2`, `-3`, and so on. `ingestSource` SHALL re-check this at insertion time, so a stale or hand-built id cannot collide.
4. THE SYSTEM SHALL provide pure geometry in `src/core/cassette-engine.ts`: `groupCassettes(nodes)` (only cassettes with at least one member, sorted by id), `cassetteBounds(rects, padding = 24)` and `moveCassette(nodes, cassetteId, dx, dy)`.
5. `cassetteBounds` SHALL return a rectangle that STRICTLY encloses every valid member rectangle, corners included, with non-negative width and height. Rectangles with non-finite, out-of-range (beyond 1e9) or negative-size numbers SHALL be ignored; with no valid rectangle the result is `null`.
6. `moveCassette` SHALL shift every member by `(dx, dy)` and keep their relative offsets. A non-finite or zero delta, or an unknown cassette, SHALL return the same array.
7. THE store action `moveCassette(cassetteId, dx, dy, { commit })` SHALL update the members in one `set()` per call, with incremental deltas, and SHALL persist only when `commit` is true. A commit call with a zero delta SHALL still persist (the end of a drag).
8. EACH cassette SHALL be drawn as a dashed amber frame behind its cards with a label tab "CASSETTE // title". Dragging the label SHALL move the cassette. **[B]**
9. THE Obsidian front matter and the bundle SHALL carry `cassetteId` and `cassetteTitle`.

### Requirement 4: Portable Bundle (`.memex`)
**User Story:** As a researcher, I want to save my whole workspace as one file and restore it later, on any machine.

#### Acceptance Criteria
1. `exportMemexBundle(input, { exportedAt })` SHALL return pretty-printed JSON `{ schema: "memex-bundle", version: "2.0", exportedAt, cards, edges, trails, ghostDiscoveries, ghostSettings }` with a fixed key order. `ghostSettings` holds `engine?`, `threshold?` and the sorted, de-duplicated `dismissedDiscoveryIds`.
2. THE export SHALL copy whitelisted fields only. Runtime fields (`selected`, `dragging`, `measured`, `resizing`) and anything unknown SHALL NOT appear. No API key, token or anything from the AI settings or `localStorage` keys SHALL ever be written to a bundle.
3. `validateAndImportBundle(json)` SHALL return `{ ok: true, version, state, ghostSettings, warnings }` or `{ ok: false, errors }`. IT SHALL NEVER throw and SHALL NOT mutate anything.
4. **Round trip (Property 1).** FOR every valid graph state, `validateAndImportBundle(exportMemexBundle(state))` SHALL be ok with a state deep-equal to the input (after stripping the runtime fields), and `export(import(export(s)))` SHALL equal `export(s)` for a fixed `exportedAt`.
5. THE importer SHALL accept version `2.0`, read another `2.x` with a warning, and reject any other version or schema. IT SHALL also accept the legacy plain graph JSON (`nodes`, `edges`, optional `trails` and `ghostDiscoveries`, the `serializeGraph` format) as version `"1.x"` with a warning.
6. THE importer SHALL reject: input over 5 MB (UTF-8), invalid JSON, a non-object root, the keys `__proto__`, `constructor` or `prototype` anywhere, nesting deeper than 32 levels, more than 2000 cards, 10000 edges, 500 trails, 1000 discoveries or 10000 dismissed ids, and strings over their length caps.
7. THE importer SHALL check every card: unique non-empty string `id`; finite `position` within +-1e7; `style.width/height` finite and positive; `data` with string `archivalId`, `title`, `content`, a valid `cardType`, string-array `tags`, a parseable `createdAt`; optional `year` (integer 0 to 9999), `date` (valid `YYYY`, `YYYY-MM` or `YYYY-MM-DD`), `confidence` in [0, 1], `source`, `authors` (string array), `cassetteId`, `cassetteTitle`, `imageUrl` and `pdfUrl`.
8. `imageUrl` SHALL be `http(s)`, relative or `data:image/<png|jpeg|gif|webp|avif|bmp>`; `pdfUrl` SHALL be `http(s)` or relative. `javascript:`, `vbscript:`, `file:`, `data:text/html`, `data:image/svg+xml`, any URL with whitespace or control characters, and every other scheme SHALL be rejected.
9. THE importer SHALL check edges (unique id, existing endpoints, valid `origin`, `rationale`, `strength` in [0, 1], optional `polarity`), trails (unique id, existing card ids, valid `origin`; an invalid `color` is dropped with a warning) and discoveries (unique id, existing endpoints, `confidence` in [0, 1]).
10. **Dangling references are rejected, not dropped.** An edge, trail stop or discovery that names a missing card SHALL fail the import with an error that names it. The app never writes such references, so one means a damaged or edited file, and a silent drop would lose links unnoticed. Duplicate ids SHALL also be rejected.
11. THE importer SHALL build every object field by field (never spreading an untrusted object). Unknown fields SHALL be dropped and counted in one warning. Up to 25 errors SHALL be reported at once.
12. `importBundle(json)` in the store SHALL, on success, replace the graph through the same path as `importJson` (playback, ghost, magnetic and spotlight session state reset, pending auto-scan cancelled, default card sizes applied), replace the dismissed ghost ids stored under `GHOST_DISMISSED_KEY` with the bundle's (a legacy `1.x` file carries none and leaves them alone), and persist the graph once. ON failure it SHALL change nothing and write nothing.
13. THE UI SHALL offer "Export bundle" (a `.memex` file download), "Import bundle" (file picker) and drag-and-drop of a `.memex` or `.json` file onto the canvas. BEFORE replacing the graph it SHALL show a confirmation that states the counts of the incoming cards, edges and trails and that the current workspace will be replaced, and it SHALL list the warnings. Errors SHALL be shown as a list; a failed import SHALL leave the workspace untouched. **[B]**

### Requirement 5: Obsidian Vault Export
**User Story:** As a researcher who also uses Obsidian, I want my cards and links as Markdown files.

#### Acceptance Criteria
1. `buildObsidianFiles(cards, edges)` SHALL return one `.md` file per card, ordered by card id, under the folder `Memex Vault/`.
2. EACH file SHALL start with YAML front matter holding `title`, `archivalId`, `type`, `year` and/or `date`, `tags` (a list), `source`, `authors`, `pdfUrl`, `cassette`, `cassetteTitle` and `createdAt`, where a value is present. Strings SHALL be double-quoted YAML scalars (JSON escaping), so a title with quotes, colons or line breaks cannot break the front matter.
3. THE body SHALL be the card content verbatim, then the section `## Associative Links`.
4. FOR every edge between two present cards, THE SYSTEM SHALL write a `[[wikilink]]` on BOTH cards pointing at the other, with the polarity (`supports`, `refutes`, `synthesizes`) and the rationale as plain text: `- → [[Other]] · refutes · why` on the source card and `- ← [[Source]] · refutes · why` on the target card. Edges that name a missing card, and self-loops, SHALL be skipped. A card without links SHALL show a placeholder line.
5. THE rationale text SHALL be escaped so it can form no wikilink, tag, HTML, emphasis, math or comment: `\ [ ] | < > # * _ \` ~ $ &`, `==` and `%%`, with line breaks collapsed.
6. FILE NAMES SHALL come from the card title: `/ \ :` become `-`; `* ? " < > | # ^ [ ]` and control and bidi characters are removed; whitespace is collapsed; leading and trailing dots and spaces are trimmed; reserved Windows names (`CON`, `NUL`, `COM1`...) get a `_`; at most 100 characters; never empty (fallback: archival id, then `Untitled`); never a path separator or `..`.
7. FILE NAMES SHALL be unique, also ignoring case, and independent of the input order: the lowest card id keeps the plain name; a collision appends ` (archivalId)`, then a counter.
8. `exportObsidianVaultZip(cards, edges, { modified })` SHALL return a `Blob` (`application/zip`) built by the in-repo ZIP writer: STORE method, CRC-32, local headers, central directory and end record, UTF-8 names (flag bit 11), a fixed DOS timestamp (the option, else 1980-01-01), no ZIP64. IT SHALL refuse 65535 or more entries and 4 GB or more, and any path that is empty, absolute, has `.`/`..` segments, a backslash, a drive letter or control characters, or repeats.
9. THE store SHALL provide `exportObsidianZip()`; THE UI SHALL offer "Export Obsidian vault (.zip)". **[B]**

### Requirement 6: Spotlight & Filter
**User Story:** As a researcher with many cards, I want to find and isolate cards without leaving the canvas.

#### Acceptance Criteria
1. `fuzzyScore(query, text)` SHALL be deterministic and ignore case and diacritics. EVERY whitespace-separated query token SHALL match (AND); the score is the mean of the token scores in [0, 1], with 0 meaning no match and an empty query scoring 1.
2. A token SHALL score by tier: exact text 1, exact word 0.9, prefix of the text 0.8, prefix of a word 0.7, substring 0.5, and, for texts up to 200 characters only, one typo in a word of 5+ letters 0.35 and an in-order subsequence of 3+ letters 0.1 to 0.3.
3. `matchNode(node, { query, type, tags })` SHALL be true when the type matches (or is `all`), the card carries EVERY selected tag (case-insensitive) and the query matches its title, content, tags, authors or source. An empty query matches every card.
4. `computeMatchSet(nodes, filters)` SHALL return the matching ids, or `null` when no filter is active.
5. `buildTagCloud(nodes, cap = 40)` SHALL return `{ tag, count }` with trimmed lowercase tags, one count per card, sorted by count descending then tag ascending.
6. THE store SHALL hold `spotlightQuery`, `spotlightType` and `spotlightTags` (session-only, never exported or persisted) with `setSpotlightQuery`, `setSpotlightType`, `toggleSpotlightTag` and `clearSpotlight`. A graph replace (`importJson`, `importBundle`, `resetToSeed`) SHALL clear them.
7. `selectNodeSpotlightDim(nodeId)` SHALL return the primitive `"off"` (no filter), `"match"` or `"dim"`. Results SHALL be memoized in a WeakMap keyed by `node.data` and a filter signature, so a drag frame (new node objects, same `data`) costs O(1) per card.
8. A dimmed card SHALL render at `SPOTLIGHT_DIM_OPACITY = 0.15`. WHEN a trail plays too, the card opacity SHALL be `combinedDimOpacity(trailState, spotlight)`, the minimum of the applicable opacities (trail 0.2, spotlight 0.15, none 1). **[B]**
9. THE Spotlight tab SHALL show the match count ("N of M cards"), the type chips, the tag cloud with counts and a clear button. **[B]**

### Requirement 7: Accessibility
#### Acceptance Criteria
1. THE dock SHALL be `role="complementary"` with a `role="tablist"` of three tab buttons (`role="tab"`, `aria-selected`, `aria-controls`) and `role="tabpanel"` panels. Arrow keys SHALL move between tabs. EVERY control SHALL be a real `<button>` or `<input>` with an accessible name and a visible focus ring. **[B]**
2. THE collapsed rail buttons SHALL expose `aria-expanded`, `aria-controls` and `aria-keyshortcuts` (`T`, `/`). **[B]**
3. THE magnetic offer SHALL be announced through a `role="status"` region ("Snap to <title>, 87% associative linking. Release to connect."), and a snap SHALL be announced ("Connected <a> and <b>"). **[B]**
4. THE import confirmation SHALL be a modal dialog (`aria-modal="true"`) that traps focus, restores it on close and handles its own Escape. Import errors SHALL be in a `role="alert"` region. **[B]**
5. WHILE `prefers-reduced-motion` is set, THE dock SHALL fade in 150 ms instead of sliding, the magnetic arc SHALL be static, and no jitter or dash animation SHALL run. **[B]**
6. THE dock, rail and arcs SHALL use only `transform` and `opacity` for motion, on the spring `{ stiffness: 300, damping: 28 }` where a spring is used. NO SVG `<filter>`, NO `backdrop-blur` and NO CSS blur filter SHALL be used. THE palette SHALL stay `#090A0F`, `#141721`, `#FFB236` and `#B388FF` with the parchment and slate text tokens. **[B]**

### Requirement 8: Performance
#### Acceptance Criteria
1. A card drag SHALL NOT re-render the dock: the dock reads primitive selectors only.
2. THE magnetic hot path SHALL be O(candidates) per frame: no text analysis, no TF-IDF, no sorting and no full-canvas scan. THE dragged card SHALL be found through an index hint in O(1).
3. THE per-card spotlight selector SHALL cost nothing while no filter is active and O(1) otherwise (Requirement 6.7).
4. THE core SHALL stay pure: no `Date.now`, `Math.random`, React, DOM or store import in `src/core/`; time is injected (`exportedAt`, `modified`).

### Requirement 9: Security
#### Acceptance Criteria
1. Imported data SHALL be treated as hostile: validated field by field, prototype-pollution keys rejected, URLs restricted (Requirement 4.8), sizes and counts capped.
2. A bundle SHALL NEVER contain secrets (Requirement 4.2). A test SHALL put a key in the input and assert it does not appear.
3. Obsidian output SHALL contain no raw HTML from user text (Requirement 5.5) and no path traversal (Requirement 5.6, 5.8).
4. NO new npm dependency SHALL be added; the ZIP writer is in the repository.

### Requirement 10: Compatibility and Constraints
#### Acceptance Criteria
1. ALL existing tests SHALL keep passing unchanged.
2. `detectGhostSynapses` SHALL behave exactly as before. `pairAffinity` SHALL return the same numbers as `scoreGhostPairs` and `detectGhostSynapses` for the same corpus.
3. THE new session state SHALL be absent from `exportJson`, `exportBundleJson` and `localStorage`.
4. THE pure logic SHALL live in `src/core/`, covered by fast-check properties of at least 200 runs.
