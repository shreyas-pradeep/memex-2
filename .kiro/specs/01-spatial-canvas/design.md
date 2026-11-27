# Technical Design: Spatial Microfilm Canvas & Graph Core

## 1. Architecture Overview
We separate pure mathematical graph operations (`src/core/`) from React Flow rendering (`src/components/canvas/`) so that all graph invariants can be verified via `fast-check` Property-Based Testing.

## 2. Core TypeScript Interfaces (`src/core/types.ts`)
- `MemexCardType`: `'note' | 'quote' | 'artifact' | 'ghost'`
- `MemexNodeData`: `{ archivalId: string; title: string; content: string; cardType: MemexCardType; tags: string[]; createdAt: string; imageUrl?: string; confidence?: number; }`
- `AssociativeEdgeData`: `{ origin: 'human' | 'ghost'; rationale: string; strength: number; trailId?: string; }`
- `Trail`: `{ id: string; title: string; description: string; origin: 'human' | 'ghost'; nodeIds: string[]; createdAt: string; }`

## 2b. Card Skins (`src/components/canvas/card-skins.ts`)
- `CARD_ACCENTS` in `src/core/types.ts` is the single per-type accent table (`note #FFB236`, `quote #38BDF8`, `artifact #10B981`, `ghost #B388FF`). `EDGE_COLORS` is unchanged (amber human, violet ghost). The minimap, timeline dots, Add Card type chips, Synapse drawer snippets, Trail Playback preview and the store's `TYPE_COLORS` read it.
- `CARD_SKINS` maps each `cardType` to `{ accent, label, border, leftBorderWidth, surface, bodyTextClass, bodyText, restGlow, hoverGlow, ... }`, with pure `contrastRatio`/`compositeHex` helpers. `card-skins.test.ts` asserts the exact labels, distinct accents and WCAG AA contrast (body text on its surface is 11.6:1 note, 14.0:1 quote, 12.7:1 artifact, 11.6:1 ghost).
- `ArchivalCardNode` animates only `transform` and `opacity`: card variants scale and lift; rest glows are static `box-shadow`s; hover, selection, trail glow and the ghost pulse are overlay layers whose opacity (and, for the pulse, scale) changes. Artifact bodies use a static `repeating-linear-gradient` scanline texture. The active-trail glow, highlight pulse and 0.2 dim keep using the card's own accent.

## 3. Correctness Properties (Property-Based Testing with `fast-check`)
- **Property 1 (No Dangling Edges Invariant):** For any arbitrary graph state $G = (V, E, T)$ and any subset of deleted node IDs $D \subseteq V$, after invoking `removeNodes(G, D)`, no edge $e \in E'$ shall have `e.source` or `e.target` in $D$, and no trail $t \in T'$ shall contain any node ID in $D$.
- **Property 2 (Idempotent Link Creation & No Self-Loops):** Adding an edge where `source === target` returns the unchanged edge set; adding an identical `(source, target, origin)` edge twice produces the exact same edge count as adding it once.
- **Property 3 (Serialization Round-Trip):** For any generated valid `MemexGraphState`, `deserializeGraph(serializeGraph(state))` deeply equals `state`.