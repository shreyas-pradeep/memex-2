# Technical Design: Vannevar Bush Trail Engine & Cinematic Playback

## 1. Architecture Overview
Pure trail logic lives in `src/core/trail-engine.ts` (no React, no clock, no randomness). The Zustand store holds playback state and calls the pure functions. UI in `src/components/trails/` reads granular selectors.

- `src/core/trail-engine.ts`: `createTrail`, `removeNodeFromTrail`, `getTrailEdges`, `getNextTrailIndex`, `getPrevTrailIndex`, `forgeCustomTrail`, `clampTrailIndex`. The existing `Trail` type is reused unchanged.
- `src/core/graph-engine.ts`: `removeNodes` delegates trail cleanup to `removeNodeFromTrail`.
- `src/store/useMemexStore.ts`: adds `activeTrailId`, `activeTrailIndex`, `isPlayingAuto` and the actions `setActiveTrail`, `nextTrailStep`, `prevTrailStep`, `setTrailStep`, `toggleAutoPlay`, `exitTrailPlayback`, `forgeTrail`. Playback state is session-only: it is not part of `persistGraph`, `exportJson`, or hydration. When a graph commit shrinks or removes the active trail, the index is clamped or playback exits.
- `src/store/trail-selectors.ts`: `useNodeTrailState(id)` and `useEdgeTrailState(source, target)` return one string (`idle | current | active | dim`), so a card or edge re-renders only when its own state changes.
- `src/components/canvas/ArchivalCardNode.tsx` and `AssociativePulseEdge.tsx`: fade to 0.2 opacity when `dim`; trail cards show a `box-shadow` glow layer whose opacity animates.
- `src/components/trails/TrailCameraDirector.tsx`: effect on `activeTrailIndex` calls `setCenter(x + w/2, y + h/2, { zoom: 1.15, duration: 800 })`.
- `src/components/trails/TrailPlaybackDock.tsx`: "The 1945 Lever" dock, framer-motion spring (stiffness 300, damping 28), transform-only countdown bar.
- ~~`src/components/trails/TrailSelectorMenu.tsx`~~ (removed in Spec 08): the top dropdown and "+ FORGE TRAIL" were replaced by the Curator's Index drawer (`CuratorsIndexDrawer.tsx`, `CuratorsIndexTrigger.tsx`) and "+ BLAZE NEW TRAIL". `forgeTrail` stays in the store and now delegates to `createManualTrail`.

Traversal convention: for a trail of length `N`, indices are `0..N-1`; an empty trail yields `-1`, which the store treats as "exit playback".

## 2. Correctness Properties (Property-Based Testing with `fast-check`, 200 runs each)
- **Property 1 (Traversal Bound Invariants):** For any `N >= 1`, any starting index and any sequence of next/prev moves, every resulting index `i` satisfies `0 <= i < N`.
- **Property 2 (Subsequence Preservation on Node Deletion):** For any trail and any set of deleted IDs `D`, `removeNodeFromTrail` applied for each `d` in `D` yields `nodeIds` that is an ordered subsequence of the original, contains no ID in `D`, and keeps every other ID.
- **Property 3 (Empty Trail Graceful Exit):** For any index, next/prev on a length-0 trail return `-1` without throwing; a trail emptied by deletions produces no edges and a valid forge result.

File: `src/core/__tests__/trail.property.test.ts`.

## 3. Chronological Knowledge Timeline (Requirement 5)

### Data model
`MemexNodeData` gains optional `year?: number` (integer, e.g. 1931, 2026) and `date?: string` (`YYYY`, `YYYY-MM` or `YYYY-MM-DD`). Both are absent (not `null`) when unset, travel with the node through persistence and export, and older graphs stay valid.

Effective sortable value (`getEventSortKey`): `year` if it is an integer, else the parsed `date`; the value is `year * 10000 + month * 100 + day` with missing parts as 0. Missing or unparseable input yields `null`: the card is excluded and never given an invented date (Req 5.4).

### Pure logic (`src/core/trail-engine.ts`)
- `getChronologicalNodes(nodes)`: dated nodes only, ascending by sort key, ties by `createdAt` then `id`; deterministic and non-mutating.
- `getEventSortKey`, `getEventYear`, `formatEventDate`, and `parseEventDateInput` (blank = no date, `1945` becomes `year`, `1945-07` / `2024-10-12` become `date`, anything else is rejected).

### State
`isTimelineOpen` (default true), `toggleTimeline`, `setTimelineOpen`, and `highlightedNodeId` with `highlightNode(id)` (auto-clears after 1800ms) live in `useMemexStore`. All are session-only. The timeline derives its milestones from `nodes` through a string-signature selector, so card drags do not re-render it. `updateCard` accepts `year`/`date` (`null` clears).

### UI
- `src/components/trails/ArchivalTimeline.tsx`: floating bottom ticker, horizontally scrollable, range label follows the dated cards. `[ ⏱️ TIMELINE ]` collapses or expands it. It is not rendered while `activeTrailId !== null`; the stored choice is untouched and returns on exit.
- Milestone click: `setCenter(x + w/2, y + h/2, { zoom: 1.15, duration: 800 })` (same as `TrailCameraDirector`), then `highlightNode`.
- `ArchivalCardNode.tsx` pulses a glow layer (`opacity` and `transform` over a static `box-shadow`) while highlighted. No SVG filters, no `backdrop-blur`.
- `AddCardModal.tsx` and card edit mode have the event date field with an inline error for unparseable input.

### Correctness Property
- **Property 4 (Chronological Monotonicity):** for any nodes with arbitrary `year`/`date` (including invalid strings), `getChronologicalNodes` returns only dated nodes, in ascending sort-key order, as a permutation of the dated input; undated nodes never appear. Input order does not change the result.

File: `src/core/__tests__/trail.property.test.ts` (200 runs).
