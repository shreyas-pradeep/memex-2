# Implementation Plan: 09-command-console-and-tactile-engine

Phase A (this run) is checked. Phase B (React components) is left unchecked for the next run.

- [x] 1. Author the spec
  - Create `requirements.md`, `design.md` and `tasks.md` in `.kiro/specs/09-command-console-and-tactile-engine/`; add "Superseded by Spec 09" notes to Specs 03 and 08 and a cassette note to Spec 04.
  - _Requirements: all_

## Task group 1: Research Command Dock and Spotlight

- [x] 2. Pure dock and spotlight logic
  - Create `src/core/command-dock.ts` (`dockReducer`, `resolveDockKey`, `isTrailsHotkey`, `isSpotlightHotkey`, `isDockEscape`, `dockForSelection`, `resolveDockEscapeOwner`, `shouldPlaybackHandleKeys`) and `src/core/spotlight.ts` (`fuzzyScore`, `matchNode`, `computeMatchSet`, `buildTagCloud`, `filterSignature`, `matchNodeMemo`, `combinedDimOpacity`).
  - _Requirements: 1.2, 1.5, 1.7 to 1.11, 6.1 to 6.5, 6.7, 6.8_
- [x] 3. Store: dock, inspection and spotlight state
  - Add `commandDock`, `dockFocusRequest`, `inspectedEdgeId`, `openDockTab`, `toggleDockTab`, `collapseDock`, `expandDock`, `dispatchDockKey`, `inspectEdge`; keep `isCuratorDrawerOpen`, `toggleCuratorDrawer`, `setCuratorDrawerOpen` as aliases; selection auto-opens the Synapse tab; add `spotlightQuery`, `spotlightType`, `spotlightTags` and their actions; create `src/store/spotlight-selectors.ts` (`selectNodeSpotlightDim`, `selectSpotlightMatchCount`, `selectIsSpotlightActive`).
  - _Requirements: 1.2 to 1.6, 1.12 to 1.14, 6.6, 6.7_
- [ ] 4. `CommandDock` shell and rail **[B]**
  - Create `src/components/dock/CommandDock.tsx` (right dock, 44 px rail, 420 px panel, spring slide, reduced-motion fade, tablist with arrow-key navigation, `role="complementary"`), `DockRail.tsx`, `DockFooter.tsx`, `src/components/dock/use-dock-keyboard.ts` (window capture listener calling `dispatchDockKey`) and extend `key-context.ts` with a dock containment helper. Mount it in `MemexCanvas.tsx`.
  - _Requirements: 1.1, 1.7 to 1.11, 7.1, 7.2, 7.5, 7.6, 8.1_
- [ ] 5. Trails, Synapse and Spotlight panels **[B]**
  - Move the Curator's Index content into `TrailsPanel.tsx`, the Synapse Inspector content into `SynapsePanel.tsx` (ghost discovery from `selectedGhostDiscoveryId`, real edge from `inspectedEdgeId` with a polarity toggle), and build `SpotlightPanel.tsx` (search input focused on `dockFocusRequest`, type chips, tag cloud from `buildTagCloud`, "N of M cards", clear). Delete `CuratorsIndexDrawer.tsx`, `CuratorsIndexTrigger.tsx` and `SynapseInspectorDrawer.tsx` and their mounts; replace the top-center trigger with the rail; update `TrailPlaybackDock.tsx` to use `shouldPlaybackHandleKeys` with `commandDock.open`; make the ghost pill click and edge click call `selectGhostDiscovery` and `inspectEdge`.
  - _Requirements: 1.4, 1.11, 1.15, 6.9, 7.1_
- [ ] 6. Spotlight dimming on cards **[B]**
  - In `ArchivalCardNode.tsx` subscribe to `selectNodeSpotlightDim(id)` and set the opacity with `combinedDimOpacity(trailState, spotlight)`; dim edges whose endpoints are both dimmed.
  - _Requirements: 6.7, 6.8, 8.1_

## Task group 2: Magnetic associative snapping

- [x] 7. Pair affinity and geometry
  - Refactor `src/core/ghost-engine.ts` to share pair scoring between the scan and the new `buildAffinityContext` / `pairAffinity` without changing `detectGhostSynapses`; create `src/core/card-geometry.ts` (`DEFAULT_CARD_SIZE`, `nodeRect`, `rectGap`); the store re-exports `DEFAULT_CARD_SIZE`.
  - _Requirements: 2.2, 2.3, 10.2_
- [x] 8. Magnetic engine and snap
  - Create `src/core/magnetic-engine.ts` (`MAGNETIC_RANGE_PX`, `MAGNETIC_MIN_AFFINITY`, `buildMagneticCandidates`, `findMagneticTarget`, `computeMagneticTarget`); add `areConnected` and `snapConnect` to `graph-engine.ts`.
  - _Requirements: 2.1 to 2.5, 2.8_
- [x] 9. Store: magnetic session
  - Add `magneticTarget`, `lastSnapEdgeId`, `beginMagneticDrag`, `updateMagneticDrag`, `endMagneticDrag`, `cancelMagneticDrag`; module-level candidate cache; reconcile on graph change; clear on reset, hydrate and import.
  - _Requirements: 2.6 to 2.10, 8.2_
- [ ] 10. Drag wiring and arc overlay **[B]**
  - In `MemexCanvas.tsx` call `beginMagneticDrag` from `onNodeDragStart`, `updateMagneticDrag` from `onNodeDrag` and `endMagneticDrag` from `onNodeDragStop`; call `cancelMagneticDrag` on unmount. Create `src/components/canvas/MagneticArcOverlay.tsx` (SVG arc, dash animation, jitter transform, label, no filters), highlight the target card, pulse the edge named by `lastSnapEdgeId` in `AssociativePulseEdge.tsx`, and add the `role="status"` announcements.
  - _Requirements: 2.11, 7.3, 7.5, 7.6, 8.1_

## Task group 3: Microfiche cassettes

- [x] 11. Cassette data and geometry
  - Add `cassetteId?` and `cassetteTitle?` to `MemexNodeData`; create `src/core/cassette-engine.ts` (`groupCassettes`, `cassetteBounds`, `cassetteFrame`, `moveCassette`, `arxivCassetteId`, `hashCassetteId`, `cassetteRefs`, `resolveCassetteId`).
  - _Requirements: 3.1, 3.4 to 3.6_
- [x] 12. Ingestion and store
  - `distillSourceText` gives every card one cassette (`ctx.cassetteId`, `ctx.existingCassettes`); `IngestionPlatenModal.tsx` passes the arXiv cassette id and the existing cassettes; `ingestSource` re-checks collisions; add the store action `moveCassette(cassetteId, dx, dy, { commit })`.
  - _Requirements: 3.2, 3.3, 3.7, 3.9_
- [ ] 13. Cassette frames **[B]**
  - Create `src/components/canvas/CassetteFrames.tsx` (viewport-layer frames from `groupCassettes` and `cassetteFrame`, dashed amber border, "CASSETTE // title" label that drags through `moveCassette` and commits on pointer up, keyboard move with arrow keys on the focused label).
  - _Requirements: 3.8, 7.1, 7.5_

## Task group 4: Portable bundle and Obsidian export

- [x] 14. ZIP writer, bundle and Obsidian modules
  - Create `src/core/zip.ts`, `src/core/vault-bundle.ts` (`exportMemexBundle`, `validateAndImportBundle`, `isSafeBundleUrl`, limits) and `src/core/obsidian-export.ts` (`buildObsidianFiles`, `sanitizeObsidianFilename`, `escapeObsidianText`, `exportObsidianVaultZip`); add `isValidEventDate` to `trail-engine.ts`.
  - _Requirements: 4.1 to 4.11, 5.1 to 5.8, 9.1 to 9.4_
- [x] 15. Store: bundle and vault actions
  - Add `exportBundleJson`, `importBundle` (replace like `importJson`, restore dismissed ids, persist once, no change on failure) and `exportObsidianZip`.
  - _Requirements: 4.12, 5.9_
- [ ] 16. Import/export UI **[B]**
  - Create `src/components/dock/DockFooter.tsx` actions ("Export bundle" as a `.memex` download, "Import bundle" file picker, "Export Obsidian vault (.zip)"), `src/components/canvas/BundleImportDialog.tsx` (confirmation with counts and warnings, error list in `role="alert"`, focus trap, own Escape) and a window-level drag-and-drop zone for `.memex` and `.json` files (read as text, 5 MB pre-check, one confirmation, then `importBundle`). Download through `Blob` and an object URL that is revoked afterwards.
  - _Requirements: 4.13, 5.9, 7.4_

## Task group 5: Tests, accessibility sweep and commit

- [x] 17. Property-based and unit tests
  - Create `src/core/__tests__/vault-and-magnetic.property.test.ts` (Properties 1 to 3, pair affinity, malformed bundles, secrets, ZIP, Obsidian, spotlight, dock state machine; 200 runs per property) and `src/store/__tests__/command-console.test.ts` (magnetic flows, dock and aliases, spotlight selector, cassettes, bundles, session-only state).
  - _Requirements: 1 to 6, 8, 9, 10_
- [x] 18. Verify and commit phase A
  - Run `npx tsc --noEmit`, `npx vitest run`, `npx eslint src` and `npm run build`; commit `feat(spec-09): add magnetic snapping, cassettes, vault bundle and spotlight core`.
  - _Requirements: 10.1 to 10.4_
- [ ] 19. Accessibility and reduced-motion sweep **[B]**
  - Check the dock, rail, arc, frames and dialogs against Requirement 7 (roles, names, focus return, `prefers-reduced-motion`, no SVG filters, no `backdrop-blur`, palette), and add pure tests for any new key or focus rule.
  - _Requirements: 7.1 to 7.6_
- [ ] 20. Verify and commit phase B **[B]**
  - Run `npx tsc --noEmit`, `npx vitest run`, `npx eslint src` and `npm run build`; commit the UI.
  - _Requirements: all_
