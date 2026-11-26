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
- `src/components/trails/TrailSelectorMenu.tsx`: top HUD to launch trails and "+ FORGE TRAIL".

Traversal convention: for a trail of length `N`, indices are `0..N-1`; an empty trail yields `-1`, which the store treats as "exit playback".

## 2. Correctness Properties (Property-Based Testing with `fast-check`, 200 runs each)
- **Property 1 (Traversal Bound Invariants):** For any `N >= 1`, any starting index and any sequence of next/prev moves, every resulting index `i` satisfies `0 <= i < N`.
- **Property 2 (Subsequence Preservation on Node Deletion):** For any trail and any set of deleted IDs `D`, `removeNodeFromTrail` applied for each `d` in `D` yields `nodeIds` that is an ordered subsequence of the original, contains no ID in `D`, and keeps every other ID.
- **Property 3 (Empty Trail Graceful Exit):** For any index, next/prev on a length-0 trail return `-1` without throwing; a trail emptied by deletions produces no edges and a valid forge result.

File: `src/core/__tests__/trail.property.test.ts`.
