# Implementation Plan: 02-trail-engine

- [x] 1. Implement pure Trail Engine & Property-Based Tests (PBT)
  - Create `src/core/trail-engine.ts` with pure functions: `createTrail`, `removeNodeFromTrail`, `getTrailEdges`, `getNextTrailIndex`, `getPrevTrailIndex`, `forgeCustomTrail`.
  - Make `removeNodes` in `src/core/graph-engine.ts` use `removeNodeFromTrail`.
  - Create `src/core/__tests__/trail.property.test.ts` using `vitest` and `fast-check` implementing Correctness Properties 1, 2, and 3 (200 runs each).
  - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3_
- [x] 2. Extend the Zustand Store with trail playback
  - Add `activeTrailId`, `activeTrailIndex`, `isPlayingAuto` and actions `setActiveTrail`, `nextTrailStep`, `prevTrailStep`, `setTrailStep`, `toggleAutoPlay`, `exitTrailPlayback`, `forgeTrail` to `src/store/useMemexStore.ts`.
  - Keep playback state out of persistence and export; clamp or exit playback when the active trail changes.
  - Add `src/store/trail-selectors.ts` with granular dimming selectors and store tests.
  - _Requirements: 1.3, 1.4, 2.1, 2.3, 3.1, 3.3_
- [x] 3. Build trail UI components and dimming
  - Create `src/components/trails/TrailCameraDirector.tsx`, `TrailPlaybackDock.tsx`, and `TrailSelectorMenu.tsx`; mount them in `src/components/canvas/MemexCanvas.tsx`.
  - Dim non-trail cards and edges to 0.2 opacity and glow trail cards in `ArchivalCardNode.tsx` and `AssociativePulseEdge.tsx` without SVG filters or backdrop-blur.
  - Verify with `npx tsc --noEmit` and `npm test`, then commit: `feat(spec-02): implement Vannevar Bush trail engine and cinematic playback dock`.
  - _Requirements: 1.1, 1.2, 3.1, 3.2, 4.1, 4.2, 4.3, 4.4, 4.5_
