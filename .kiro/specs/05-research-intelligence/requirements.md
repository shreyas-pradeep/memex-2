# Requirements Document: Research Intelligence & Synthesis Suite

## Introduction
This specification adds three research features to Memex 2.0: a Markdown **briefing export** for a trail, **dialectical edge polarity** (supports, refutes, synthesizes), and an **arXiv resolver** in the Platen Scanner. Every feature works from the user's own cards or from one public metadata lookup; nothing is invented. The briefing engine and BibTeX generator are pure and deterministic. The arXiv route is the only new network surface.

Terminology maps to the real codebase: a card is a `MemexNode` (`data: MemexNodeData`), an edge is an `AssociativeEdge` whose `data` already holds `origin`, `rationale`, `strength` and `trailId`, and the new `polarity` field is orthogonal to `origin`. `MemexNodeData` has no `metadata` object, so citation fields are optional top-level fields: `source`, `pdfUrl`, `authors`.

## Requirements
### Requirement 1: Trail Briefing Export
**User Story:** As a researcher, I want to turn a trail into a Markdown briefing, so that I can paste it into a paper or share it.

#### Acceptance Criteria
1. WHEN a trail is playing, THE SYSTEM SHALL show an "[⚡ EXPORT BRIEFING]" button in the Trail Playback Dock that opens the briefing modal without hiding or moving the existing dock controls.
2. THE SYSTEM SHALL generate the briefing as Markdown that starts with YAML front matter holding `title`, `generatedDate`, `trailId` and `cardCount`, followed by the heading "# Executive Research Briefing" and the sections "## Thematic Arc & Thesis", "## Chronological Lineage", "## Empirical Evidence & Quotations", "## Dialectical Tensions" and "## Archival Bibliography", in that order.
3. THE SYSTEM SHALL list the trail's cards in trail order and SHALL include every listed card's archival ID and title verbatim.
4. THE SYSTEM SHALL list each card with its event date (or "undated"), type, tags, content and the link to the next stop.
5. THE SYSTEM SHALL build the thesis only from the trail's own cards (years, tags, titles, types, counts), and SHALL NOT state any claim, source or citation that is not on a card.
6. THE SYSTEM SHALL list quote and artifact cards in "Empirical Evidence & Quotations", or state that there are none.
7. THE SYSTEM SHALL list every edge with `polarity: "refutes"` whose two endpoints are both in the trail under "Dialectical Tensions", or state "None recorded" when there is none.
8. THE SYSTEM SHALL cite each card in the bibliography with the authors, year, title, source and PDF URL it holds, plus its archival ID.
9. WHEN a trail node ID has no matching card, THE SYSTEM SHALL skip it, exclude it from `cardCount`, and record the number skipped as `missingCards` in the front matter. WHEN a trail is empty, THE SYSTEM SHALL still produce a valid briefing.
10. THE SYSTEM SHALL produce the same output for the same inputs. The generation date SHALL be supplied by the caller and defaults to the date of the trail's `createdAt`; the engine SHALL NOT read the clock.
11. THE SYSTEM SHALL write front matter values as double-quoted YAML scalars, SHALL keep titles, tags and rationales on one line, and SHALL emit card content as a block quote, so that card text cannot add headings, rules or front matter.

### Requirement 2: Export Modal
**User Story:** As a researcher, I want to preview the briefing and copy or save it, so that I can check it before using it.

#### Acceptance Criteria
1. THE modal SHALL expose `role="dialog"` and `aria-modal="true"` with an accessible name, move focus into the dialog, keep focus inside while open, and restore focus on close.
2. WHEN the user presses Escape, clicks the backdrop or presses "[CLOSE / ESC]", THE SYSTEM SHALL close the modal without changing the graph.
3. THE modal SHALL show a scrollable monospace preview of the exact Markdown, with front matter, headings and block quotes visually distinguished.
4. WHEN the user presses "[COPY MARKDOWN]", THE SYSTEM SHALL copy the Markdown with the Clipboard API, falling back to a hidden textarea, show "COPIED TO CLIPBOARD" with a check mark for 2 seconds, and clear the timer when the modal closes.
5. IF copying fails, THEN THE SYSTEM SHALL show an inline message and SHALL NOT throw.
6. WHEN the user presses "[DOWNLOAD .MD]", THE SYSTEM SHALL save the Markdown as `memex-briefing-<trailId>.md` with the trail ID reduced to filename-safe characters, and SHALL revoke the object URL.
7. WHILE the modal is open, THE SYSTEM SHALL NOT run the dock's keyboard shortcuts (arrows, Escape) or the canvas shortcuts. The dock's shortcuts SHALL also stay inactive while the user is typing.

### Requirement 3: BibTeX
**User Story:** As a researcher, I want a BibTeX entry for a card, so that I can cite it in LaTeX.

#### Acceptance Criteria
1. THE SYSTEM SHALL produce `@article` for a card whose `source` is an arXiv or journal-like reference, and `@misc` otherwise.
2. THE SYSTEM SHALL derive the cite key from the archival ID, replacing every character outside `[A-Za-z0-9_:-]` with `_`.
3. THE SYSTEM SHALL escape `{ } \ & % $ # _ ^ ~` in title, author, source and note, and turn line breaks and control characters into spaces.
4. THE SYSTEM SHALL include `title`, `year` when the card has one, `author` when authors are known, and a `note` holding the archival ID.
5. WHEN the source is `arXiv:<id>` with a valid id, THE SYSTEM SHALL add `eprint` and `archivePrefix = {arXiv}`, and `url` when the card has an http(s) `pdfUrl`.
6. FOR ANY card, THE SYSTEM SHALL produce syntactically valid BibTeX: an entry type, a key, comma-separated `name = {value}` fields and balanced braces.

### Requirement 4: Dialectical Edge Polarity
**User Story:** As a researcher, I want to mark a link as supporting, refuting or synthesizing, so that the canvas shows where ideas disagree.

#### Acceptance Criteria
1. THE SYSTEM SHALL support the polarities `supports`, `refutes` and `synthesizes` in the optional `polarity` field of edge data, independent of `origin`.
2. THE SYSTEM SHALL treat an edge without a valid polarity as `supports`.
3. WHEN the user activates an edge's polarity badge, THE SYSTEM SHALL advance the polarity supports → refutes → synthesizes → supports, counting a missing polarity as `supports`, and persist the result.
4. IF the edge ID is not a real store edge, THEN THE SYSTEM SHALL leave the graph unchanged. Display-only ghost synapse edges are not store edges and SHALL NOT be toggleable.
5. THE SYSTEM SHALL keep polarity through export, import and reload with deterministic JSON, and SHALL load graphs saved without polarity.
6. THE SYSTEM SHALL draw `supports` edges in their origin color (amber for human, violet for ghost) with a forward pulse; `refutes` edges in crimson `#EF4444`, dashed, with a reverse pulse and an always-visible "≠ REFUTES" badge; `synthesizes` edges in violet `#B388FF` with two offset pulses and an always-visible "⚡ SYNAPSE" badge.
7. WHILE a `supports` edge is neither hovered nor selected, THE SYSTEM SHALL hide its badge; on hover or selection it SHALL show "→ SUPPORTS".
8. THE SYSTEM SHALL keep the ghost discovery pill ("⚡ X% SYNAPSE") and its inspector behavior unchanged and visually and semantically distinct from the polarity badge.
9. THE SYSTEM SHALL keep trail dimming and highlighting working on edges of every polarity.

### Requirement 5: arXiv Resolver
**User Story:** As a researcher, I want to enter an arXiv ID or URL and get the paper's metadata, so that I do not retype it.

#### Acceptance Criteria
1. THE SYSTEM SHALL accept `1706.03762`, `1706.03762v5`, `arXiv:1706.03762`, old-style ids such as `cs/0112017`, and `abs` or `pdf` URLs on arxiv.org, and SHALL reject everything else by anchored regular expressions.
2. WHEN `GET /api/arxiv?id=` receives a missing or invalid id, THE SYSTEM SHALL answer 400 without contacting any upstream. A DOI-shaped input SHALL get a 400 that says DOI lookup is not supported.
3. WHEN the id is valid, THE SYSTEM SHALL request only `https://export.arxiv.org/api/query` with the validated id built by `URLSearchParams`, with a 10 second timeout, a response size cap, no redirect following, and a User-Agent header.
4. THE SYSTEM SHALL answer 200 with `{ title, authors, year, abstract, arxivId, pdfUrl }` when arXiv returns an entry.
5. THE SYSTEM SHALL answer 404 when arXiv returns no entry or an entry titled "Error", 502 for an upstream failure, redirect, oversize or unreadable response, 504 on timeout, and 429 above 12 requests per minute per client IP.
6. THE SYSTEM SHALL return only generic error messages and SHALL NOT return, log or cache upstream bodies or errors.
7. THE Platen modal SHALL offer a third tab labelled "arXiv / DOI" with an input and a "RESOLVE PAPER" button, a loading state, and inline `role="alert"` errors for invalid input, not found, rate limit and network failure.
8. WHEN the input is a DOI, THE modal SHALL show that DOI lookup is not supported yet, and SHALL NOT call the route.
9. WHEN a paper is resolved, THE modal SHALL preview its title, authors and year, then distill its title and abstract into Note, Quote and Artifact cards through the existing ingestion path (one `ingestSource` call, one ghost scan).
10. THE SYSTEM SHALL stamp every generated card with `source: "arXiv:<id>"`, `pdfUrl`, `authors` and the published `year`, and the published year SHALL override the year the text heuristic found.
11. WHEN the modal closes or the user leaves the tab, THE SYSTEM SHALL abort any in-flight request. The "File Drop" and "Direct Raw Text / Paper Abstract" tabs SHALL work unchanged.

### Requirement 6: Constraints
1. THE SYSTEM SHALL keep synthesis, BibTeX and arXiv parsing in pure `src/core/` modules with no React dependency.
2. THE SYSTEM SHALL NOT use SVG `<filter>` elements or `backdrop-blur`, and SHALL animate only `transform`, `opacity` and `box-shadow`, with framer-motion springs at stiffness 300 and damping 28.
3. THE SYSTEM SHALL NOT log or store secrets. The arXiv route needs none.
