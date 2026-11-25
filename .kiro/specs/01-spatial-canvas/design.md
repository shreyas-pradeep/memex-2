# Technical Design: Spatial Microfilm Canvas & Graph Core

## 1. Architecture Overview
We separate pure mathematical graph operations (`src/core/`) from React Flow rendering (`src/components/canvas/`) so that all graph invariants can be verified via `fast-check` Property-Based Testing.

## 2. Core TypeScript Interfaces (`src/core/types.ts`)
- `MemexCardType`: `'note' | 'quote' | 'artifact' | 'ghost'`
- `MemexNodeData`: `{ archivalId: string; title: string; content: string; cardType: MemexCardType; tags: string[]; createdAt: string; imageUrl?: string; confidence?: number; }`
- `AssociativeEdgeData`: `{ origin: 'human' | 'ghost'; rationale: string; strength: number; trailId?: string; }`
- `Trail`: `{ id: string; title: string; description: string; origin: 'human' | 'ghost'; nodeIds: string[]; createdAt: string; }`

## 3. Correctness Properties (Property-Based Testing with `fast-check`)
- **Property 1 (No Dangling Edges Invariant):** For any arbitrary graph state $G = (V, E, T)$ and any subset of deleted node IDs $D \subseteq V$, after invoking `removeNodes(G, D)`, no edge $e \in E'$ shall have `e.source` or `e.target` in $D$, and no trail $t \in T'$ shall contain any node ID in $D$.
- **Property 2 (Idempotent Link Creation & No Self-Loops):** Adding an edge where `source === target` returns the unchanged edge set; adding an identical `(source, target, origin)` edge twice produces the exact same edge count as adding it once.
- **Property 3 (Serialization Round-Trip):** For any generated valid `MemexGraphState`, `deserializeGraph(serializeGraph(state))` deeply equals `state`.