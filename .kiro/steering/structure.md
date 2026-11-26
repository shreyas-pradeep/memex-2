---
inclusion: always
---
# Repository Structure

- `.kiro/` — Kiro specs, steering, hooks, and custom agents (MUST remain committed to git).
- `src/core/types.ts` — Canonical TypeScript interfaces (`MemexNode`, `AssociativeEdge`, `Trail`, `GhostDiscovery`).
- `src/core/graph-engine.ts` — Pure graph mutation, invariant validation, and trail traversal logic.
- `src/core/ghost-ai.ts` — Autonomous associative discovery and semantic similarity engine.
- `src/core/__tests__/graph.property.test.ts` — `fast-check` Property-Based Tests.
- `src/store/useMemexStore.ts` — Zustand store connecting core logic to React Flow UI.
- `src/components/canvas/` — Custom React Flow nodes, glowing animated SVG edges, microfilm shaders, and HUD controls.
- `src/components/trails/` — Trail Playback dock, step-by-step camera controller, and Ghost Discovery inspector.
- `src/data/demo-seed.ts` — Pre-loaded 1945–2026 cognitive AI research dataset (Bush to spatial memory) for instant judge evaluation.