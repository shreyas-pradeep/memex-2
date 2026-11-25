# Implementation Plan: 01-spatial-canvas

- [x] 1. Create canonical TypeScript interfaces and seed dataset
  - Create `src/core/types.ts` defining `MemexNode`, `AssociativeEdge`, `Trail`, `GhostDiscovery`, and `MemexGraphState`.
  - Create `src/data/demo-seed.ts` with an authentic 1945 Vannevar Bush & computing history research dataset (8 rich interconnected cards, human links, and pre-computed Ghost AI trails) so the app loads with a breathtaking demo immediately.
  - _Requirements: 1.1, 2.1_

- [x] 2. Implement pure Graph Engine & Property-Based Tests (PBT)
  - Create `src/core/graph-engine.ts` with pure functions: `addNode`, `removeNode`, `connectNodes`, `createTrail`, `serializeGraph`, `deserializeGraph`, and `computeAutoLayout`.
  - Create `src/core/__tests__/graph.property.test.ts` using `vitest` and `fast-check` implementing Correctness Properties 1, 2, and 3 (minimum 100 random iterations per property).
  - Configure `package.json` with `"test": "vitest run"` and verify all PBT suites pass.
  - _Requirements: 2.2, 2.3, 3.1_

- [x] 3. Build Zustand Store (`src/store/useMemexStore.ts`)
  - Connect `src/core/graph-engine.ts` to `@xyflow/react` state with automatic `localStorage` persistence and a "Reset to 1945 Demo Seed" action.
  - _Requirements: 1.2, 3.1_

- [-] 4. Build the 60fps Microfilm Spatial Canvas & Custom SVG Nodes/Edges
  - Create `src/components/canvas/MicrofilmShaders.tsx` containing the global `<svg>` defs for `#microfilm-duotone` grain filter and glowing `#amber-glow` (`#FFB236`) and `#violet-glow` (`#B388FF`) edge filters.
  - Create `src/components/canvas/ArchivalCardNode.tsx` with 1945 microfilm registration crosshairs (`+`), monospace archival ID header, serif title, tag pills, and Framer Motion spring hover physics.
  - Create `src/components/canvas/AssociativePulseEdge.tsx` rendering smooth bezier curves in `#FFB236` (human) or `#B388FF` (Ghost AI) with an animated `stroke-dasharray` thought pulse and hover rationale badge.
  - Create `src/components/canvas/MemexCanvas.tsx` integrating `@xyflow/react`, dark obsidian dot matrix (`#090A0F`), minimap, and floating command HUD.
  - _Requirements: 1.1, 1.2, 1.3, 2.1_