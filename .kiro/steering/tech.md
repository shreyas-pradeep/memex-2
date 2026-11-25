---
inclusion: always
---
# Tech Stack & Engineering Standards

- **Framework:** Next.js (App Router), React 19, TypeScript (Strict mode, no `any`).
- **Canvas Engine:** `@xyflow/react` (React Flow v12) with custom Node and Edge types.
- **State Management:** `zustand` with `localStorage` persistence and deterministic JSON export/import.
- **Animations:** `framer-motion` (Spring physics: `stiffness: 300, damping: 28`).
- **Testing & PBT:** `vitest` + `fast-check` for Property-Based Testing of all graph, trail, and layout invariants.
- **AI Architecture:** Dual-engine design:
  1. Deterministic Client-Side Semantic Graph Engine (TF-IDF + cosine similarity + concept graph) for zero-latency, zero-key judge testing.
  2. Optional `/api/ghost-discover` route for live LLM trail synthesis.

## Code Rules
- Separate pure graph/trail mathematical logic into `src/core/` (100% pure TypeScript functions, zero React dependencies) so `fast-check` Property-Based Tests can test them directly.
- Keep UI components in `src/components/`.

## Git Workflow Automation
- After completing any task or sub-task where `npm test` and `npx tsc --noEmit` pass cleanly, the agent SHALL automatically stage and commit the changes using the shell tool with a descriptive conventional commit message (e.g., `feat(spec-01): task 4 - spatial canvas and shaders`).
- Do not run `git push` automatically; only commit locally so the developer can review before pushing.