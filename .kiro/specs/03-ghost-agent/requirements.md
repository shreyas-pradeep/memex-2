# Requirements Document: The Ghost in the Machine (Autonomous Associative AI)

## Introduction
This specification defines the Ghost Engine for Memex 2.0: a deterministic, client-side semantic engine that scans the canvas, finds non-obvious bridges between unconnected cards, draws them as Phantom Violet "ghost synapses", and lets the user inspect, accept, dismiss or walk each one as a trail. No network call or API key is needed.

## Requirements

### Requirement 1: Autonomous Semantic Discovery
**User Story:** As a researcher with many disconnected notes, I want the system to find hidden links between my cards, so that I notice connections I would not have searched for.

#### Acceptance Criteria
1. WHEN a scan runs, THE SYSTEM SHALL evaluate every unordered pair of cards using keyword TF-IDF vectors (title, content and tags) with cosine similarity, and tag overlap.
2. WHEN a pair of cards has no edge between them in either direction and its combined score meets the threshold, THE SYSTEM SHALL produce one `GhostDiscovery` for that pair, with a confidence in `[0, 1]`.
3. THE SYSTEM SHALL NOT produce a discovery for a card paired with itself, SHALL NOT produce two discoveries for the same pair in either direction, and SHALL NOT produce a discovery for a pair already joined by a human edge.
4. WHEN the same cards, edges and threshold are scanned twice, THE SYSTEM SHALL return identical discoveries in identical order, with IDs derived from the sorted pair of card IDs.
5. WHEN a discovery is created, THE SYSTEM SHALL attach a synthesized bridge rationale that names the shared concepts of the two cards.

### Requirement 2: Visual Ghost Synapses
**User Story:** As a viewer, I want suggested links to look different from my own links, so that I can tell machine suggestions from human ones at a glance.

#### Acceptance Criteria
1. WHILE a discovery exists, THE SYSTEM SHALL render it on the canvas as a Phantom Violet (`#B388FF`) edge between its two cards, drawn with a wide translucent stroke under a crisp 1px path and an animated thought pulse, with no SVG filters and no `backdrop-blur`.
2. WHILE a discovery edge is rendered, THE SYSTEM SHALL show a floating "⚡ X% SYNAPSE" pill at its midpoint, where X is the confidence rounded to a whole percent.
3. WHEN a user clicks the pill, THE SYSTEM SHALL select that discovery and open the Synapse Inspector Drawer.
4. WHILE a trail is playing, THE SYSTEM SHALL dim ghost synapses outside the trail to 0.2 opacity, like every other edge.

### Requirement 3: Synapse Inspector Drawer
**User Story:** As a researcher, I want to read why the ghost linked two cards before I trust it, so that I can accept or reject the suggestion.

#### Acceptance Criteria
1. WHEN a discovery is selected, THE SYSTEM SHALL slide in a side drawer showing the source card, the target card, the synthesized rationale and the confidence score as a percentage and a meter.
2. WHEN a user selects "Accept Connection", THE SYSTEM SHALL create a human edge between the two cards carrying the rationale and confidence, remove the discovery, and close the drawer.
3. WHEN a user selects "Dismiss", THE SYSTEM SHALL remove the discovery, close the drawer, and keep that pair from reappearing in later scans, including after a reload.
4. WHEN a user selects "Walk Ghost Trail", THE SYSTEM SHALL create a ghost-origin trail of the two cards and start Trail Playback on it.
5. WHEN the user presses Escape, THE SYSTEM SHALL close the drawer.
6. IF the selected discovery no longer exists, THEN THE SYSTEM SHALL close the drawer.
7. THE drawer SHALL expose `role="dialog"` with an accessible name, and all actions SHALL be keyboard-focusable buttons.

### Requirement 4: On-Demand and Proactive Triggers
**User Story:** As a user, I want to wake the ghost when I choose, and have it notice new cards on its own, so that discovery needs no chat prompt.

#### Acceptance Criteria
1. WHEN a user presses "⚡ WAKE GHOST ENGINE" in the top HUD, THE SYSTEM SHALL run a scan and show a scanning state on the button until it finishes.
2. WHEN a card is created, THE SYSTEM SHALL schedule one scan after a debounce delay; further cards created within the delay SHALL restart the delay, so a burst of cards causes one scan.
3. WHEN a card is deleted, THE SYSTEM SHALL immediately remove every discovery that references it, and SHALL close the drawer if it showed one of them.
4. WHEN the graph is exported or persisted, THE SYSTEM SHALL include discoveries and SHALL NOT include the scanning flag or the selected discovery.
