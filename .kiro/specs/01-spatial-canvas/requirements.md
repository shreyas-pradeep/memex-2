# Requirements Document: Spatial Microfilm Canvas & Graph Core

## Introduction
This specification defines the mathematical graph core, state persistence, and 60fps infinite spatial canvas for Memex 2.0, resurrecting Vannevar Bush's 1945 archival desk.

## Requirements

### Requirement 1: Archival Knowledge Cards (Nodes)
**User Story:** As a researcher, I want to place notes, quotes, and archival artifacts onto an infinite 2D canvas, so that I can visually organize knowledge without rigid folders.

#### Acceptance Criteria
1. WHEN a user creates a new card at coordinates `(x, y)`, THE SYSTEM SHALL generate a unique archival ID (e.g., `MEM-1945-XXXX`), timestamp, title, content body, tags, and source type (`note` | `quote` | `artifact` | `ghost-insight`).
2. WHEN a user drags a card on the canvas, THE SYSTEM SHALL update its `(x, y)` spatial coordinates at 60fps and persist the state automatically.
3. WHEN a card contains an image URL, THE SYSTEM SHALL render the image through the GPU-accelerated CSS filter `grayscale(100%) contrast(125%) sepia(25%)` to maintain a unified 1945 archival aesthetic.

### Requirement 2: Associative Links (Edges) & Graph Integrity
**User Story:** As a thinker, I want to draw associative links between any two cards and delete cards safely, so that my knowledge graph remains corruption-free.

#### Acceptance Criteria
1. WHEN a user connects Card A to Card B, THE SYSTEM SHALL create a directed `AssociativeEdge` styled in Tungsten Amber (`#FFB236`) for human links or Phantom Violet (`#B388FF`) for Ghost AI links.
2. IF a user attempts to create a self-loop (`source === target`) or a duplicate link between the same pair and type, THEN THE SYSTEM SHALL reject the duplicate and preserve graph integrity.
3. WHEN a card is deleted from the canvas, THE SYSTEM SHALL automatically purge all connected edges and remove the card from any Associative Trails so zero dangling references remain.

### Requirement 3: Deterministic Archival Serialization
**User Story:** As a researcher, I want my entire Memex desk to save and reload cleanly to JSON/localStorage, so I never lose my work.

#### Acceptance Criteria
1. WHEN the canvas state is serialized to JSON and deserialized back, THE SYSTEM SHALL produce an exact deep-equal graph of nodes, edges, and trails.