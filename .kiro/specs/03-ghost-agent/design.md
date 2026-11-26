# Technical Design: The Ghost in the Machine

## 1. Architecture Overview
Pure discovery logic lives in `src/core/ghost-engine.ts` (no React, no clock, no randomness). The Zustand store owns session state and calls the pure functions. UI reads granular selectors.

- **Relation to existing code:** `src/core/ghost-ai.ts` does not exist in the repo; `ghost-engine.ts` is the first and only discovery module (the structure steering file's `ghost-ai.ts` entry is satisfied by it). The existing `GhostDiscovery` type is reused. Its optional `trailId` is set when a discovery is converted to a trail. `AssociativeEdgeData` gains one optional field, `discoveryId`, used only on the display-only edges that render discoveries.
- `src/core/ghost-engine.ts`: `extractKeywords`, `computeCosineSimilarity`, `detectGhostSynapses(nodes, existingEdges, threshold, options)`, `synthesizeBridgeRationale(nodeA, nodeB)`, `ghostPairKey`, `ghostDiscoveryId`, `confidencePercent`, `removeNodeFromDiscoveries`, `buildGhostEdges`, `forgeGhostTrail`.
- `src/core/graph-engine.ts`: `removeNodes` delegates discovery cleanup to `removeNodeFromDiscoveries`.
- `src/store/useMemexStore.ts`: session-only `isGhostScanning` and `selectedGhostDiscoveryId`; actions `triggerGhostScan`, `selectGhostDiscovery`, `acceptGhostDiscovery`, `dismissGhostDiscovery`, `convertDiscoveryToTrail`. Dismissed discovery IDs are kept in a separate localStorage key (`memex-2:ghost-dismissed:v1`, sorted array) so they survive reloads without changing the graph schema.
- `src/store/ghost-selectors.ts`: `useGhostEdgeSelected`, `selectSelectedDiscovery`.
- `src/components/canvas/AssociativePulseEdge.tsx`: ghost edges render a clickable "⚡ X% SYNAPSE" pill.
- `src/components/ghost/SynapseInspectorDrawer.tsx`: spring-animated side drawer.
- `src/components/canvas/MemexCanvas.tsx`: "⚡ WAKE GHOST ENGINE" button in the top-left HUD, and the drawer mount. The canvas passes `edges` plus `buildGhostEdges(discoveries)` to React Flow, memoized on the two arrays.

### Scoring
1. `extractKeywords(text)`: lowercase, split on non-alphanumerics, drop tokens shorter than 3 characters, digits-only tokens and stop words, then apply a light plural/suffix stem. Returns sorted unique terms.
2. Per card, a term-frequency map from title (weight 3), tags (weight 3) and content (weight 1). Document frequency across all cards gives smoothed IDF `ln(1 + N / df)`; the TF-IDF vector is `tf * idf`.
3. `computeCosineSimilarity(a, b)` over sparse maps; returns 0 when either norm is 0, and is clamped to `[0, 1]`.
4. Tag overlap is the Jaccard index of normalized tags.
5. `score = clamp01(0.75 * sqrt(cosine) + 0.25 * jaccard)` (the square root lifts TF-IDF cosine, which is naturally small for short notes). A pair becomes a discovery when `score >= threshold` (default `0.12`). Confidence is `round(score * 1000) / 1000`, which stays inside `[0, 1]`.
6. Output is sorted by confidence descending, then by id ascending. The ID is `gd-<len>:<minId>:<maxId>` (the length prefix keeps it collision-free for arbitrary IDs); source is the lexicographically smaller card ID.

### Exclusions
A pair is skipped when it is a self-pair, when any edge (either direction, any origin) already joins it, when a discovery for its key was dismissed, or when its ID is in the `dismissed` option set. Connected-by-ghost-edge pairs are skipped too, so the seed's pre-drawn ghost edges are not suggested twice.

### Display edges
`buildGhostEdges(discoveries)` returns `AssociativeEdge`s with id `ghost-synapse-<discoveryId>`, `origin: "ghost"`, `strength = confidence`, `discoveryId` set, and `selectable: false`. They are derived, never stored in `edges`, so they never enter persistence or the human edge set.

### Triggers
- Manual: `triggerGhostScan()` sets `isGhostScanning`, runs `detectGhostSynapses` on the current graph, replaces `ghostDiscoveries` (keeping the IDs stable), and clears the flag. The scan is synchronous and fast, so the flag is held for a minimum of 600ms by a timer to let the UI show the radar state.
- Proactive: `addNode` schedules `triggerGhostScan` after 1200ms with one module-level timer that is cleared and restarted on each add (no storm), and cleared on `resetToSeed`, `importJson` and `hydrate`.

## 2. Correctness Properties (Property-Based Testing with `fast-check`, 200 runs each)
- **Property 1 (Bounded Confidence):** for any nodes, edges and threshold, every discovery has `0 <= confidence <= 1`, and `computeCosineSimilarity` of any two vectors is within `[0, 1]`.
- **Property 2 (No Self-Synapses or Duplicate Bridges):** `sourceId !== targetId` for every discovery, and no two discoveries share the same unordered pair; input node order does not change the output.
- **Property 3 (Unconnected Invariant):** no discovery joins a pair that already has an edge (in either direction), in particular none duplicates a human edge.
- **Property 4 (Node Deletion Cleansing):** for any discoveries and any deleted ID set `D`, `removeNodeFromDiscoveries` and `removeNodes` return discoveries that reference no ID in `D` and keep every other discovery unchanged and in order.

File: `src/core/__tests__/ghost.property.test.ts`.

## 3. Session-only state
`isGhostScanning` and `selectedGhostDiscoveryId` are never passed to `persistGraph` or `exportJson`. `commit` clears the selection when the selected discovery disappears.

## 4. Demo seed
`seedGhostDiscoveries` is empty (the seed's existing ghost edges already cover its connected pairs). Card `n-engelbart` gains the tags `memex` and `bush`, so a scan finds "The Memex Desk" <-> "Engelbart's Mother of All Demos" and "As We May Think" <-> "Engelbart's Mother of All Demos" at the default threshold.
