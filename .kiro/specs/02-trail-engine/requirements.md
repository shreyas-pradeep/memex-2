# Requirements Document: Vannevar Bush Trail Engine & Cinematic Playback

## Introduction
This specification defines Associative Trails for Memex 2.0: ordered sequences of cards that can be created, walked step by step, isolated visually on the canvas, and played back cinematically from a bottom dock ("The 1945 Lever").

## Requirements

### Requirement 1: Trail Creation
**User Story:** As a researcher, I want to save an ordered path through my cards as a named trail, so that I can retrace my line of thought later.

#### Acceptance Criteria
1. WHEN a user forges a trail from selected cards, THE SYSTEM SHALL create a `Trail` with a title, a human origin, a timestamp, and an ordered `nodeIds` list in which each card appears at most once.
2. IF fewer than two valid cards are supplied, THEN THE SYSTEM SHALL reject the trail and leave the graph unchanged.
3. WHEN a card is deleted, THE SYSTEM SHALL remove it from every trail while preserving the relative order of the remaining cards.
4. WHEN the graph is exported or persisted, THE SYSTEM SHALL include trails and SHALL NOT include playback state.

### Requirement 2: Sequential Traversal
**User Story:** As a reader of a trail, I want to move forward and backward one stop at a time, so that I never land on a stop that does not exist.

#### Acceptance Criteria
1. WHEN a user requests the next or previous stop, THE SYSTEM SHALL move the active index by exactly one and keep it within `0 <= i < N`.
2. WHILE the active index is at the last (first) stop, THE SYSTEM SHALL keep it there on a next (previous) request.
3. IF the active trail has no cards, THEN THE SYSTEM SHALL exit playback without raising an error.

### Requirement 3: Visual Isolation
**User Story:** As a viewer, I want everything outside the playing trail to recede, so that I can focus on the path.

#### Acceptance Criteria
1. WHILE a trail is active, THE SYSTEM SHALL render every card and edge outside the trail at 0.2 opacity.
2. WHILE a trail is active, THE SYSTEM SHALL render trail cards and the edges between consecutive stops at full opacity with a glowing border in the trail's accent color (`#FFB236` human, `#B388FF` ghost), using CSS `box-shadow` and plain strokes, never SVG filters or `backdrop-blur`.
3. WHEN playback exits, THE SYSTEM SHALL restore all cards and edges to full opacity.

### Requirement 4: Cinematic Playback
**User Story:** As a presenter, I want the camera to glide from stop to stop with a control dock, so that a trail plays like a guided tour.

#### Acceptance Criteria
1. WHEN a trail is launched, THE SYSTEM SHALL show a floating bottom dock with the trail title, "Stop X of Y", a preview of the current card, Prev and Next buttons, an Auto-Play toggle, and an Exit button.
2. WHEN the active stop changes, THE SYSTEM SHALL move the camera to the center of the active card at zoom 1.15 over 800ms.
3. WHILE Auto-Play is on, THE SYSTEM SHALL show a 5-second countdown progress bar and advance one stop when it completes.
4. WHEN Auto-Play reaches the last stop, THE SYSTEM SHALL turn Auto-Play off.
5. WHEN a user selects Exit, THE SYSTEM SHALL end playback and dismiss the dock.

### Requirement 5: Chronological Knowledge Timeline
**User Story:** As a researcher, I want my dated cards laid out on a timeline, so that I can see the history of an idea and jump to any moment in it.

#### Acceptance Criteria
1. WHEN cards carry an optional `year` (for example 1931, 1945, 2026) or `date` (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`), THE SYSTEM SHALL extract them, sort them chronologically, and plot them as milestones on a scrollable horizontal timeline bar at the bottom of the canvas.
2. WHEN a user clicks a timeline milestone, THE SYSTEM SHALL smoothly center the canvas viewport on the corresponding card and give that card a temporary highlight pulse.
3. WHILE the Trail Playback Dock is active, THE SYSTEM SHALL hide the timeline so the two do not overlap, and restore the user's open/collapsed choice on exit.
4. IF a card has no explicit date, THEN THE SYSTEM SHALL keep it visible on the canvas, exclude it from timeline plotting, and SHALL NOT assign it an invented date.
