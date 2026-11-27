# Requirements Document: The Platen Scanner (Multi-Format Document Ingestion Engine)

> **Extended by Spec 09.** Every card distilled from one source now shares a **cassette** (`cassetteId`, `cassetteTitle`): `cassette-<arxivId>` for an arXiv paper, `cassette-<8-hex hash>` otherwise, with a `-2`, `-3` suffix on a collision with another source. Card ids, positions and edges are unchanged.

## Introduction
This specification defines the Platen Scanner for Memex 2.0. A researcher drops a source (a `.txt`, `.md` or `.json` file, or pasted text or a paper abstract) onto the "platen". A deterministic, client-side engine parses it, distills it into atomic archival cards (one Note, one or two Quotes, and an Artifact when the source holds data), detects its publication year, lays the cards out radially on the canvas, links them with human edges, and wakes the Ghost Engine so the new cards are bridged to the existing archive. No network call or API key is needed. PDF is out of scope.

Terminology used here maps to the real codebase: a card is a `MemexNode` (`type: "memexCard"`, `data: MemexNodeData`), an edge is an `AssociativeEdge` (`type: "associative"`), and the ghost scan is the store's `triggerGhostScan`.

## Requirements

### Requirement 1: File Drop Ingestion
**User Story:** As a researcher, I want to drag a document onto the app, so that I can bring it into my archive without retyping it.

#### Acceptance Criteria
1. WHEN a user selects "INGEST SOURCE (PLATEN)" or presses `I` outside a text field, THE SYSTEM SHALL open the Platen modal with a "File Drop" tab and a "Direct Raw Text / Paper Abstract" tab.
2. WHEN a user drops a file on the drop zone or chooses one with the file picker, THE SYSTEM SHALL read it as UTF-8 text and parse it by its extension.
3. THE SYSTEM SHALL accept the extensions `.txt`, `.md`, `.markdown` and `.json`, compared case-insensitively.
4. WHEN the user presses Escape or clicks the backdrop, THE SYSTEM SHALL close the modal without changing the graph.
5. THE modal SHALL expose `role="dialog"` with an accessible name, keep keyboard focus inside while open, and restore focus to the previously focused element on close.

### Requirement 2: Multi-Format Parsing
**User Story:** As a researcher, I want Markdown and JSON sources read sensibly, so that formatting noise does not end up in my cards.

#### Acceptance Criteria
1. WHEN a `.txt` source is parsed, THE SYSTEM SHALL use its text unchanged apart from line-ending and whitespace normalization, and the file name (without extension) as the title.
2. WHEN a `.md` source is parsed, THE SYSTEM SHALL remove heading markers, emphasis markers, code fence lines, inline code backticks, list bullets, blockquote markers, HTML tags and horizontal rules, replace links and images with their text, and use the first `#` heading as the title when present.
3. WHEN a `.json` source is parsed, THE SYSTEM SHALL accept a string, an object, or an array of those; for objects it SHALL read the fields `title`, `abstract`, `content`, `text` and `body` when present, and otherwise SHALL flatten the values as `key: value` lines.
4. THE SYSTEM SHALL return every parse failure as a result value with a code and a message, and SHALL NOT throw to the UI.
5. WHEN pasted text is submitted, THE SYSTEM SHALL use the entered title, or a title derived from the text when the title is blank.

### Requirement 3: Atomic Card Distillation
**User Story:** As a researcher, I want one long source split into atomic cards, so that each idea can be linked and trailed on its own.

#### Acceptance Criteria
1. THE SYSTEM SHALL produce exactly one Note card holding the core thesis, built from the lead and most salient sentences and truncated at a word boundary.
2. WHEN the source contains quotations in `“ ”` or `" "` of 20 to 400 characters, THE SYSTEM SHALL produce up to two Quote cards holding those quotations verbatim.
3. WHEN the source contains no such quotations, THE SYSTEM SHALL produce up to two Quote cards from salient sentences, titled "Excerpt: …", and SHALL NOT invent any text that is not in the source.
4. WHEN the source contains statistics (percentages, numbers with units, "N× faster", or Markdown pipe tables), THE SYSTEM SHALL produce one Artifact card holding those lines; otherwise it SHALL produce none.
5. THE SYSTEM SHALL tag every card with at most 6 deduplicated, sorted tags drawn from a research taxonomy, in the same unprefixed lowercase form as the demo seed.
6. FOR ANY input, including empty, whitespace-only and Unicode text, THE SYSTEM SHALL produce at least one valid Note card (title defaulting to "Untitled Source"), valid unique IDs and a `tags` array of strings.
7. THE SYSTEM SHALL chain the cards with human edges Note → Quote(s) → Artifact, each with a rationale and a strength in `[0, 1]`, with no self-loops and no edge to an unknown card.

### Requirement 4: Publication Year Detection
**User Story:** As a researcher, I want the source's year detected, so that its cards appear on the timeline.

#### Acceptance Criteria
1. THE SYSTEM SHALL return a year only when it is an integer in `[1890, 2026]` found as a standalone four-digit number, and SHALL return `undefined` otherwise.
2. THE SYSTEM SHALL ignore digit runs inside longer numbers (such as `12345`), decimals (such as `1945.5`) and thousands groups (such as `1,945,000`).
3. WHEN several candidate years are present, THE SYSTEM SHALL prefer years in publication contexts ("published", "©", "copyright", "In 1968", "(1945)") and break ties by earliest position.
4. WHEN a year is detected, THE SYSTEM SHALL set it as `year` on every card of the source; otherwise it SHALL leave `year` absent.

### Requirement 5: Radial Non-Overlapping Placement
**User Story:** As a viewer, I want new cards arranged clearly around the source, so that nothing is hidden behind anything else.

#### Acceptance Criteria
1. THE SYSTEM SHALL place the Note at the base position (card center) and the other cards on a ring of radius 460 px around it.
2. THE SYSTEM SHALL keep the pairwise distance between card centers at 380 px or more, and SHALL keep the 340×230 card boxes from overlapping, for any finite base position.
3. WHEN the canvas already holds cards, THE SYSTEM SHALL choose a base position to the right of the existing bounding box so the new cluster does not overlap existing cards.
4. THE SYSTEM SHALL size every new card 340×230 through `style: { width, height }`.

### Requirement 6: Automatic Ghost Synapse Triggering
**User Story:** As a researcher, I want the ghost to relate my new source to what I already have, so that I see connections immediately.

#### Acceptance Criteria
1. WHEN a source is ingested, THE SYSTEM SHALL add all its cards and edges in one store update, persist the graph once, and drop any card whose ID already exists.
2. WHEN a source is ingested, THE SYSTEM SHALL start exactly one ghost scan using the local neural engine (no API quota spent), and SHALL cancel any pending debounced auto-scan so no second scan follows.
3. WHEN a source is ingested, THE SYSTEM SHALL glide the camera to the new cards over 800 ms.
4. THE SYSTEM SHALL assign every ingested card an archival ID that is unique among all cards on the canvas.

### Requirement 7: Validation and Errors
**User Story:** As a user, I want clear errors for bad input, so that I know what to fix.

#### Acceptance Criteria
1. IF a file's extension is not supported, THEN THE SYSTEM SHALL show "unsupported file type" naming the accepted types and SHALL NOT change the graph.
2. IF the source is empty or whitespace-only, THEN THE SYSTEM SHALL show an "empty source" error and SHALL NOT change the graph. (Spec 06 adds a retro toast next to this error, and keeps "Scan into platen" enabled on the raw-text tab while it is blank so the error can be reached.)
3. IF a source exceeds 1 MB (1,048,576 UTF-8 bytes), THEN THE SYSTEM SHALL reject it with a "too large" error that states the limit.
4. IF a `.json` source is not valid JSON, THEN THE SYSTEM SHALL show a "malformed JSON" error with the parser's reason.
5. THE SYSTEM SHALL show errors inline in the modal with `role="alert"`, and SHALL keep the modal open.
