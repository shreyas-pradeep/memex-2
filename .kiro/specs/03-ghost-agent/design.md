# Technical Design: The Ghost in the Machine

> **Superseded by Spec 09 (UI only).** The Synapse Inspector drawer described below is the Synapse tab of the Research Command Dock (`SynapsePanel.tsx`); the discovery engine and its store contract are unchanged.

## 1. Architecture Overview
Pure discovery logic lives in `src/core/ghost-engine.ts` (no React, no clock, no randomness). The Zustand store owns session state and calls the pure functions. UI reads granular selectors.

- **Relation to existing code:** `src/core/ghost-ai.ts` does not exist in the repo; `ghost-engine.ts` is the first and only discovery module (the structure steering file's `ghost-ai.ts` entry is satisfied by it). The existing `GhostDiscovery` type is reused. Its optional `trailId` is set when a discovery is converted to a trail. `AssociativeEdgeData` gains one optional field, `discoveryId`, used only on the display-only edges that render discoveries.
- `src/core/ghost-engine.ts`: `extractKeywords`, `computeCosineSimilarity`, `detectGhostSynapses(nodes, existingEdges, threshold, options)`, `synthesizeBridgeRationale(nodeA, nodeB)`, `ghostPairKey`, `ghostDiscoveryId`, `confidencePercent`, `calibrateGhostConfidence`, `sanitizeGhostSuggestions`, `removeNodeFromDiscoveries`, `buildGhostEdges`, `forgeGhostTrail`.
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
5. Concept overlap: `CONCEPT_LEXICON` groups related terms (e.g. hypertext/association/link/trail/memex; analog/differential/analyzer/mechanical/computing/eniac; mit/engelbart/demo/mouse/augment). Terms are stemmed at load and each card maps to a set of concept ids; overlap is the Ochiai coefficient. The stemmer folds plurals and strips one `-ing`/`-ed`/`-ly`.
   - **Clusters.** The lexicon carries four semantic clusters, merged into existing concepts where they overlap: RETRIEVAL_ATTENTION extends `retrieval` (adds `memex`, `dot-product`, and the generic `value`, `index`, `scaled`, `associative`, `trail`), COGNITIVE_AUGMENTATION extends `augmentation` (adds `working-memory`, `spatial-gestalt`, `hci`, `keyset`, `intellect`, generic `bandwidth`), LATENT_GEOMETRY extends `latent` (adds `monosemanticity`, `latent-space`, `sparse-autoencoders`, `superposed`, `manifold`), and GRAPH_HYPERTEXT is the new `hypergraph` concept ("hypertext and knowledge graphs"). The old `graph` concept was split into `graph` and `spatial` so a spatial canvas no longer bridges to GraphRAG on one word.
   - **Hyphenated terms.** A term such as `dot-product` is compiled to the phrase `dot product` and the glued form `dotproduct`; card text is matched per field (title, each tag, content) on adjacent stemmed words, so `dot-product`, `dot product`, `dotproduct` and the same words in a tag all match, while words in neighbouring tags never join into a phrase.
   - **Generic terms.** Lexicon entries are `terms` (weight 1) or `weakTerms` (weight 0.5). A card touches a concept when its distinct matched terms sum to at least 1, so one generic word (`values`, `nodes`, `link`, `key`, `model`, `feature`, `community`, `stored`, `mouse`) never creates a concept overlap, but two do.
6. `base = clamp01(0.3 * sqrt(cosine) + 0.5 * concept + 0.2 * jaccard)`. **Cross-era lineage boost:** when one card's effective year (`getEventYear`) is `<= 1970`, the other's is `>= 2015`, and the cards share at least one concept, `score = clamp01(base + 0.2)`; undated cards get no boost. A pair becomes a discovery when `score >= threshold` (default `0.3`, kept because this score scale tops out near 0.65 so the requested 0.50 would only reduce discoveries). Results are sorted by score and capped at `maxResults` (default 6). The 7-card demo seed yields five bridges (see section 4).
7. Confidence is calibrated, not the raw score: `0.78 + 0.18 * clamp01(score / 0.6)`, rounded to 3 decimals. It is monotone in the score and always within `[0.78, 0.96]`.
8. **Rationales.** `synthesizeBridgeRationale` always starts with `"A" and "B" were never linked`. A pure rule table (`LINEAGE_RATIONALE_RULES`, matched by `matchLineageRule`) adds a curated sentence for recognized landmark pairs: Bush x Transformer attention (worded as an interpretation, with no model dimensions), Bush x GraphRAG, Nelson x GraphRAG and Nelson x attention. A card is recognized by archival ID (`MEM-1945-01`, `MEM-1965-02`, `MEM-2017-04`, `MEM-2024-05`) or, for user-made cards, by year plus vocabulary. Other cross-era pairs that share a concept get "Cards share a high-affinity conceptual nexus across <theme labels> bridging theoretical origins with modern empirical implementations."; same-era pairs keep the "yet both draw on" wording. The temporal-gap clause is always appended.
9. Output is sorted by score descending, then by id ascending. The ID is `gd-<len>:<minId>:<maxId>` (the length prefix keeps it collision-free for arbitrary IDs); source is the lexicographically smaller card ID.

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
`seedGhostDiscoveries` is empty. The seed is the 1945-2026 cognitive AI research dataset (7 cards, `MEM-1945-01` to `MEM-2026-07`). Consecutive stops of both seed trails are connected, and a scan at the default threshold finds five cross-era bridges between unconnected cards: Bush <-> Spatial Gestalt hypothesis (0.96), Bush <-> GraphRAG (0.945), Engelbart <-> Spatial Gestalt hypothesis (0.93), Nelson <-> Spatial Gestalt hypothesis (0.901) and Nelson <-> GraphRAG (0.875). Bush <-> Transformer attention and Nelson <-> Transformer attention are already joined by edges in the seed, so they are not re-suggested.
## 5. Live generative route (`/api/ghost`)
- `GET /api/ghost` returns `{ live: boolean }`: whether the server has `GEMINI_API_KEY`. It never returns the key. `await connection()` keeps it a per-request read under Cache Components.
- `POST /api/ghost` takes `{ nodes, existingEdges }` and an optional `x-gemini-api-key` header (the user's key, saved in localStorage as `memex-2:gemini-key:v1`). Input is validated by `validateGhostRequest` in `src/core/ghost-live.ts` (max 60 nodes, 400 edges, bounded string lengths, 400 on violation). The key used is the user's, else `process.env.GEMINI_API_KEY`.
- With a key, the route calls the Gemini REST API (`GEMINI_MODEL`, then `gemini-2.0-flash`, then `gemini-1.5-flash`) with the key in the `x-goog-api-key` header, `responseMimeType: application/json`, and a 12s `AbortController` timeout per call. The system prompt casts the model as an archival detective that returns 2 to 4 bridges as `{ sourceId, targetId, rationale, confidence, bridgeTheme }`.
- Output is parsed defensively and passed through the pure `sanitizeGhostSuggestions` (known ids, no self-links, symmetric dedup, skip connected or dismissed pairs, confidence clamped to `[0, 1]`, rationale trimmed to 400 chars, max 4), producing `GhostDiscovery` objects with the same deterministic ids.
- **Fallback contract:** the route answers `200 { source: "live", discoveries }` or `200 { source: "none" }` (no key, rate limit, upstream error, timeout, bad JSON, nothing valid). The client then runs the local engine, since it owns the dismissed list. Upstream bodies and keys are never logged or returned. Requests that use the server key are limited to 10 per minute per IP (in-memory, per instance).
- The store's `triggerGhostScan({ live? })` is async: it POSTs first, re-sanitizes the response against the current graph, discards it if the card or edge set changed meanwhile, and otherwise falls back to `detectGhostSynapses`. Concurrent calls share one in-flight scan, and `isGhostScanning` is reset in `finally`. Session-only `ghostEngineMode` (`"live" | "neural"`) records the engine of the last scan. The debounced auto-scan calls `triggerGhostScan({ live: false })` so card creation never spends API quota.
- HUD: a `[ ⚡ AI: LIVE ]` / `[ ⚡ AI: NEURAL ]` pill (live when the server reports a key or a browser key is saved) and a gear button opening `AISettingsModal`, which saves or clears the browser key (masked after saving).
