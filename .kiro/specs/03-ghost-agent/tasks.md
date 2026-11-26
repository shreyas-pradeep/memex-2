# Implementation Plan: 03-ghost-agent

- [x] 1. Implement pure Ghost Engine & Property-Based Tests (PBT)
  - Create `src/core/ghost-engine.ts` with pure functions: `extractKeywords`, `computeCosineSimilarity`, `detectGhostSynapses`, `synthesizeBridgeRationale`, `removeNodeFromDiscoveries`, `buildGhostEdges`, `forgeGhostTrail`.
  - Make `removeNodes` in `src/core/graph-engine.ts` use `removeNodeFromDiscoveries`.
  - Add optional `discoveryId` to `AssociativeEdgeData` in `src/core/types.ts`.
  - Create `src/core/__tests__/ghost.property.test.ts` using `vitest` and `fast-check` implementing Correctness Properties 1, 2, 3 and 4 (200 runs each).
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 4.3_
- [x] 2. Extend the Zustand Store with ghost scanning
  - Add session-only `isGhostScanning` and `selectedGhostDiscoveryId`, and actions `triggerGhostScan`, `selectGhostDiscovery`, `acceptGhostDiscovery`, `dismissGhostDiscovery`, `convertDiscoveryToTrail` to `src/store/useMemexStore.ts`.
  - Persist dismissed pair keys deterministically; add the debounced auto-scan to `addNode` with timer cleanup.
  - Add `src/store/ghost-selectors.ts` and store tests.
  - _Requirements: 3.2, 3.3, 3.4, 3.6, 4.1, 4.2, 4.3, 4.4_
- [x] 3. Build ghost synapse UI
  - Update `AssociativePulseEdge.tsx` for clickable "⚡ X% SYNAPSE" pills; create `src/components/ghost/SynapseInspectorDrawer.tsx`.
  - Add the "⚡ WAKE GHOST ENGINE" HUD button and mount the drawer in `src/components/canvas/MemexCanvas.tsx`; make the demo seed yield a discoverable bridge.
  - Verify with `npx tsc --noEmit`, `npm test` and `npx eslint src`, then commit: `feat(spec-03): implement autonomous ghost AI connection engine and synapse inspector`.
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.1, 3.5, 3.7, 4.1_
