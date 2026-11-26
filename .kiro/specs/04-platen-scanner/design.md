# Technical Design: The Platen Scanner

## 1. Architecture Overview
Pure parsing and distillation live in `src/core/ingestion-engine.ts` (no React, no clock, no randomness). The store owns uniqueness and persistence through one new action, `ingestSource`. The modal and HUD only call these.

```mermaid
flowchart LR
  A[File drop / picker / paste] --> B[IngestionPlatenModal]
  B -->|name, text| C[parseSourceFile / parsePastedText]
  C -->|ParsedSource ok=false| E[inline role=alert error]
  C -->|title, text| D[distillSourceText]
  P[pickIngestionBase existing nodes] --> D
  D -->|MemexNode[], AssociativeEdge[]| S[store.ingestSource]
  S -->|addNode + connectNodes, one commit| G[(graph + localStorage)]
  S -->|cancel debounce, 1 call| T[triggerGhostScan live:false]
  S -->|added ids| H[HUD: fitView nodes, 800ms]
```

- **Relation to existing code.** Cards are `MemexNode`s (`type: "memexCard"`) and edges are `AssociativeEdge`s (`type: "associative"`, `origin: "human"`). `ghost-engine.ts` now exports `stem` and `STOP_WORDS` so the ingestion engine reuses the same stemmer, stop words and `CONCEPT_LEXICON`. `edgeId` comes from `graph-engine.ts` and `TRAIL_EPOCH` from `trail-engine.ts`.
- `src/core/ingestion-engine.ts`: `extractPublicationYear`, `extractTags`, `stripMarkdown`, `parseSourceFile`, `parsePastedText`, `distillSourceText`, `radialPlacement`, `pickIngestionBase`, `normalizeText`, `truncateAtWord`.
- `src/store/useMemexStore.ts`: `ingestSource(nodes, edges): string[]`.
- `src/components/canvas/IngestionPlatenModal.tsx`: tabs, drop zone, scan animation.
- `src/components/canvas/MemexCanvas.tsx`: "+ INGEST SOURCE (PLATEN)" button in the top-left HUD, the `I` shortcut, and the camera glide.

## 2. Data Structures
```ts
type SourceFormat = "txt" | "md" | "json" | "text";
type IngestErrorCode = "unsupported-type" | "empty" | "too-large" | "malformed-json";
type ParsedSource =
  | { ok: true; title: string; text: string; format: SourceFormat }
  | { ok: false; code: IngestErrorCode; message: string };
interface Point { x: number; y: number }
interface IngestContext {
  idPrefix?: string;               // default src-<fnv1a(title \0 text)>
  createdAt?: string;              // default TRAIL_EPOCH
  existingIds?: Iterable<string>;  // generated ids never collide with these
  archivalStart?: number;          // first MEM-1945-XXXX number, default 1
}
interface DistilledSource { nodes: MemexNode[]; edges: AssociativeEdge[] }
```
The return keeps the names `nodes` and `edges` to match the codebase (`MemexGraphState`).

## 3. Pure Function Signatures
```ts
extractPublicationYear(text: string): number | undefined
extractTags(text: string): string[]
stripMarkdown(md: string): string
parseSourceFile(name: string, text: string): ParsedSource
parsePastedText(title: string, text: string): ParsedSource
distillSourceText(title: string, rawText: string, basePosition: Point, ctx?: IngestContext): DistilledSource
radialPlacement(base: Point, count: number): Point[]
pickIngestionBase(nodes: readonly MemexNode[]): Point
```

### Year heuristic
Candidates match `(?<![\w.,\-/$])(1[89]\d\d|20[0-2]\d)(?!\w|\.\d|,\d)` and are kept only when in `[1890, 2026]`. Score: 1, plus 3 for `(YYYY)`, plus 4 after "published", "publication", "copyright", "©" or "(c)", or plus 2 after "in", "of", "by", "from", "since", "written", "issued", "appeared", "released". Highest score wins; ties go to the earliest position.

### Tags
`TAXONOMY` maps 14 research tags (attention, augmentation, benchmark, cognition, computing, deep-learning, graph, hci, hypertext, interpretability, latent, memory, retrieval, spatial) to trigger terms, stemmed with the Ghost stemmer. Tokens are counted per tag; the top 6 are returned sorted alphabetically. Tags carry no `#`, like the demo seed. With no taxonomy hit, the 3 most frequent non-stop-word stems are used.

### Distillation
1. Normalize text and split it into sentences. Score each sentence: taxonomy and concept-lexicon stem hits, a length bonus up to 1, and 1.5 for the lead sentence.
2. **Note:** title (or first words of the lead sentence, or "Untitled Source"); content is the lead sentence plus the 2 highest-scoring others in source order, truncated to 520 characters at a word boundary.
3. **Quotes:** up to 2 quotations of 20 to 400 characters in `“ ”` or `" "`, verbatim, titled "Quote: …". Otherwise up to 2 salient sentences not used in the Note, titled "Excerpt: …". Short sources may yield no Quote.
4. **Artifact:** only when lines match the statistics pattern (percentages, numbers with units, "N× faster") or when 2 or more lines contain 2 or more `|` (a table). Up to 4 lines, titled "Data: …".
5. `year` from `extractPublicationYear(title + text)` is set on every card when present.
6. Chain edges Note → Quote(s) → Artifact: id `e-human-<source>-<target>`, strength 0.9 / 0.8 / 0.7, fixed rationale text.

### ID scheme
Card id: `<prefix>-note | -quote-1 | -quote-2 | -artifact`, with `prefix = src-<8 hex FNV-1a of title, NUL, normalized text>`. If any id is in `existingIds`, the prefix becomes `<prefix>-2`, `-3`, ... until none collides. The store reassigns `archivalId` with `nextArchivalId` for each added card, so archival IDs are unique on the canvas.

### Placement math
Cards are 340×230 and the Note's center is the base point. With `s` satellites and `R = 460`, satellite centers are `base + R·(cos θ, sin θ)` with θ in degrees: `s=1: [30]`, `s=2: [30, 210]`, `s=3: [-90, 30, 150]`. Distances: Note to satellite 460; between satellites at least `2R·sin 60° ≈ 797`. Box separation: satellites at ±30° and ±150° are `R·cos 30° ≈ 398 ≥ 340` apart horizontally of the Note, and the one at -90° is 460 ≥ 230 vertically. Top-left = center − (170, 115), rounded to integers. Base coordinates are clamped to ±1,000,000 so float precision cannot erode spacing; non-finite values become 0.

`pickIngestionBase`: `x = maxRight + 80 + 460 + 170`, `y = (minY + maxY) / 2` over existing cards (`{0, 0}` when empty). Satellite extent to the left is `398 + 170 = 568 < 710`, so the new cluster clears existing cards.

### Store action
`ingestSource(nodes, edges)`: for each node, reassign `archivalId`, add through `addNode` (rejects duplicate ids); connect only edges whose both endpoints were added, through `connectNodes`; one `commit` (one `persistGraph`); `cancelGhostAutoScan()`; one `triggerGhostScan({ live: false })`, deferred until an in-flight scan settles. The scan is local to match card-creation auto-scan and avoid spending API quota.

### UI constraints
Palette `#090A0F` / `#141721` / `rgba(255,178,54,0.18)` / `#FFB236` (errors in `#B388FF`). No SVG filters, no `backdrop-blur`. The scan bar animates `transform` (y) and `opacity`; the dialog enters with a spring (`stiffness: 300, damping: 28`); the camera uses `fitView({ nodes, duration: 800 })`.

## 4. Correctness Properties (Property-Based Testing with `fast-check`, 300 runs each)
File: `src/core/__tests__/ingestion.property.test.ts` (the structure steering file places PBTs in `src/core/__tests__/`; `vitest.config.ts` has no custom `include`).
- **Property 1 (Year Bounds):** for any string `s`, `extractPublicationYear(s)` is `undefined` or an integer in `[1890, 2026]`. An in-range year after "published", "In" or in parentheses is found; out-of-range years are not.
- **Property 2 (Radial Separation):** for any text and any finite base, every pair of cards has center distance `≥ 380` (hence `> 320`) and their 340×230 boxes do not overlap. Cards from `pickIngestionBase` lie right of every existing card.
- **Property 3 (Distillation Validity):** for any title and text, the result has exactly one Note, unique non-empty card IDs and archival IDs, non-empty titles, `tags` as at most 6 strings, `year` absent or in range, and edges that reference only generated IDs with no self-loops, unique IDs and strength in `[0, 1]`.
- **Property 4 (Determinism and ID Safety):** the same inputs give equal output; generated IDs never appear in `existingIds`.
- **Property 5 (Tags):** `extractTags` is sorted, unique, capped at 6 and deterministic.
- **Property 6 (Total Parsers):** `parseSourceFile` and `parsePastedText` return a result for any input and never throw.

## 5. Limitations
PDF and DOCX are not supported (no parser dependency, client-side only). Text is read as UTF-8. Only the first 200,000 characters are analysed. Distillation is extractive: it selects and truncates source text and never writes new prose.
