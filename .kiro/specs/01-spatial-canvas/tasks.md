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

- [x] 4. Build the 60fps Microfilm Spatial Canvas & Custom SVG Nodes/Edges
  - Create `src/components/canvas/MicrofilmShaders.tsx` containing the global `<svg>` defs for `#microfilm-duotone` grain filter and glowing `#amber-glow` (`#FFB236`) and `#violet-glow` (`#B388FF`) edge filters.
  - Create `src/components/canvas/ArchivalCardNode.tsx` with 1945 microfilm registration crosshairs (`+`), monospace archival ID header, serif title, tag pills, and Framer Motion spring hover physics.
  - Create `src/components/canvas/AssociativePulseEdge.tsx` rendering smooth bezier curves in `#FFB236` (human) or `#B388FF` (Ghost AI) with an animated `stroke-dasharray` thought pulse and hover rationale badge.
  - Create `src/components/canvas/MemexCanvas.tsx` integrating `@xyflow/react`, dark obsidian dot matrix (`#090A0F`), minimap, and floating command HUD.
  - _Requirements: 1.1, 1.2, 1.3, 2.1_

  - [x] 5. Add double-click inline editing and card deletion
  - Add `updateCard(id, data)` action to `src/store/useMemexStore.ts` to update title, content, or tags.
  - Update `src/components/canvas/ArchivalCardNode.tsx`: double-click toggles `isEditing` mode with dark-mode input/textarea styled to `#141721`, commits on blur/Escape via `updateCard`.
  - Add hover `✕` delete button calling `deleteNode(id)` with smooth exit animation.
  - Verify with `npx tsc --noEmit` and `npm test`, then commit: `feat(canvas): add double-click inline card editing and delete button`
  - _Requirements: 1.1, 2.3_

  - [x] 6. Implement interactive card resizing, fluid movement, and rounded chassis with state persistence
  - Integrate `@xyflow/react` `<NodeResizer minWidth={280} minHeight={180} isVisible={selected} />` into `src/components/canvas/ArchivalCardNode.tsx`.
  - Apply hybrid retro-futuristic styling: `rounded-2xl` (16px) outer chassis with `#141721` surface, `rounded-full` tag pills and badges, and `rounded-xl` text inputs, while keeping interior 1px registration crosshairs (`+`) and monospace metadata sharp and technical.
  - Gesture & gesture conflict isolation: add `nodrag nowheel` to all text inputs, textareas, and scrollable body text containers so editing and scrolling never drags or zooms the canvas. Set `nodeDragThreshold={4}` on `<ReactFlow>` in `src/components/canvas/MemexCanvas.tsx`.
  - Persist resized dimensions (`style: { width, height }`) to `localStorage` through Zustand's `onNodesChange` in `src/store/useMemexStore.ts`.
  - Update all 8 seed cards in `src/data/demo-seed.ts` with explicit default dimensions (`style: { width: 320, height: 210 }`) for generous layout spacing.
  - Add global CSS overrides in `src/app/globals.css` for `.react-flow__resize-control` to style handle dots as smooth circular pills (`rounded-full`) with subtle amber/violet glowing borders.
  - Verify Property 3 (Serialization Round-Trip) in `src/core/__tests__/graph.property.test.ts` handles node dimensions without corruption.
  - Run `npx tsc --noEmit` and `npm test` to verify all tests pass, then commit with: `feat(canvas): add interactive NodeResizer, fluid card movement, and rounded chassis`.
  - _Requirements: 1.1, 1.2, 3.1_