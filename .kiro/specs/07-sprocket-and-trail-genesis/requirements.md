# Requirements Document: Sprocket 2.0 & AI Auto-Trail Genesis
## Introduction
This specification gives Sprocket (Spec 06) a body and a job. Sprocket gains squash-and-stretch physics, eyes that follow the cursor, a happy state with a wag, a typed emotive state machine and a **weaving show**: on request, the Ghost Engine generates up to three narrative trails from the graph (a Lineage Arc, a Dialectical Debate and a Dense Conceptual Nexus), Sprocket scampers from card to card along one of them, drawing an illuminated filament behind him, and then opens the 1945 Lever on that trail.
Terminology maps to the real codebase. A "card" is a `MemexNode`. A trail's name is `Trail.title`, its ordered cards are `Trail.nodeIds`, and the active stop is `activeTrailIndex`. A trail's color is not stored: it derives from `origin` through `EDGE_COLORS` (`human` amber `#FFB236`, `ghost` phantom violet `#B388FF`). The "dock" is `TrailPlaybackDock`, which opens when `setActiveTrail(id)` is called. Auto-generated trails use origin `ghost`: the engine made them, and violet means "made by the Ghost" everywhere else in the product. The `Trail` shape is unchanged (no new fields), so old saves, exports and the deterministic JSON are unaffected.
## Requirements
### Requirement 1: Squash and Stretch
**User Story:** As a researcher, I want Sprocket to move like a little machine with weight, so that the canvas feels alive.
#### Acceptance Criteria
1. THE SYSTEM SHALL apply squash and stretch as `scaleX` / `scaleY` on a wrapper inside the sprite button, with `transform-origin: 50% 100%` (the feet), so the body deforms around its contact with the card.
2. THE constants SHALL live in `SPROCKET_PHYSICS` in `src/core/sprocket-motion.ts`: anticipation `scaleY 0.7`, `scaleX 1.25`, 150 ms; flight `scaleY 1.35`, `scaleX 0.8`; landing `scaleY 0.75` rebounding to `1.0` on the spring `{ stiffness: 450, damping: 18 }`.
3. BEFORE every move, THE SYSTEM SHALL play the 150 ms anticipation wind-up. WHILE in flight, it SHALL hold the flight stretch. ON arrival, it SHALL play the landing squash and rebound.
4. THE wind-up SHALL count toward the move: a trail-follow move (hop, wire, hop) takes 800 ms in all (150 ms wind-up plus 650 ms flight), so Sprocket lands as the 800 ms camera glide ends.
5. THE sequence SHALL apply to the trail-follow scurry, the relocation to a new perch and both legs of the ghost reaction (to the synapse and back).
6. WHEN a new move, a weave, a store change that invalidates the move or an unmount interrupts a sequence, THE SYSTEM SHALL stop its timers and animations and return the scale to `1`.
### Requirement 2: Eye Tracking and Happy State
**User Story:** As a researcher, I want Sprocket to look at my cursor and to be glad when I come close, so that he feels attentive.
#### Acceptance Criteria
1. THE SYSTEM SHALL listen for `pointermove` on `window` with one passive listener, throttle the work with `requestAnimationFrame`, and write the result to framer-motion motion values. Moving the mouse SHALL NOT re-render any React component.
2. THE pupil offset SHALL come from the pure `pupilOffset(spriteCenter, pointer, maxRadius)`: the direction is toward the pointer, the length is the pointer's distance capped at `maxRadius` (6 px), and the result is `{ 0, 0 }` when the pointer is at the center. The function SHALL be total: NaN input, a non-positive or non-finite radius and infinite coordinates give a finite offset of at most `maxRadius`.
3. THE sprite center SHALL come from the button's `getBoundingClientRect()`, read at most once per frame, and refreshed while Sprocket itself moves.
4. THE 6 px screen offset SHALL be mapped into the eye socket (`PUPIL_TRAVEL_UNITS = 1.5` sprite units, the socket radius minus the pupil radius), so the pupil never leaves the socket.
5. WHEN the pointer is within 60 screen pixels of the sprite center (`isCursorNear(distance, 60)`; leaving needs 68 px so the edge does not flicker), THE SYSTEM SHALL cross-fade the eye to a curved happy arch by opacity and wag the body (a small rotate and shift oscillation, ±6° and ±0.8 units, 520 ms period).
6. WHEN the pointer leaves the window or the window loses focus, THE SYSTEM SHALL return the pupil to the center and end the happy state.
7. WHEN the pointer is a touch pointer, THE SYSTEM SHALL ignore it. A device without a cursor SHALL NOT crash or track.
8. THE listeners SHALL be removed and the animation frame cancelled when the component unmounts.
### Requirement 3: Emotive State Machine
**User Story:** As a maintainer, I want Sprocket's lifecycle to be a small, tested machine, so that overlapping animations cannot leave him in a broken pose.
#### Acceptance Criteria
1. THE SYSTEM SHALL define the states `idle`, `anticipating`, `travelling`, `landing`, `inspecting`, `weaving` and `celebrating`, plus an orthogonal `happy` flag, as a pure reducer `reduceSprocket(machine, event)` in `src/core/sprocket-motion.ts`.
2. THE transition table SHALL be: `idle` MOVE to `anticipating`, WEAVE to `weaving`; `anticipating` LIFTOFF to `travelling`; `travelling` TOUCHDOWN to `landing`; `landing` SETTLE to `idle`, INSPECT to `inspecting`; `inspecting` MOVE to `anticipating`, SETTLE to `idle`; `weaving` CELEBRATE to `celebrating`; `celebrating` SETTLE to `idle`.
3. AN illegal transition SHALL be ignored: the reducer returns the same object.
4. INTERRUPT SHALL return any state to `idle` and keep the happy flag. HAPPY_ON and HAPPY_OFF SHALL set the flag in every state and leave the state alone.
5. THE crawler SHALL interrupt the running activity before it starts a new one, and SHALL refuse a second weave while `weaving` or `celebrating`.
6. THE Spec 06 behaviors (perching, trail scurry, "!" and inspection, quips, awake eye color) SHALL keep working through the machine.
### Requirement 4: Auto-Trail Genesis
**User Story:** As a researcher, I want the Ghost to chart the trails my cards already support, so that I can see a story without building it by hand.
#### Acceptance Criteria
1. THE SYSTEM SHALL provide the pure function `generateAutoTrails(nodes, edges, discoveries, options?)` in `src/core/trail-genesis.ts`, with `options = { createdAt?: string; maxSteps?: number }`. It SHALL use no clock and no randomness, and SHALL NOT mutate its input.
2. THE SYSTEM SHALL generate only the trails the data supports, up to three, in this order: Lineage Arc (`lineage`), Dialectical Debate (`debate`), Dense Conceptual Nexus (`nexus`). It SHALL NOT invent content or pad a trail with unrelated cards, and SHALL return fewer trails (even `[]`) when the data cannot support a trail of at least three cards.
3. THE **Lineage Arc** SHALL list the dated cards (`getChronologicalNodes`, which uses the effective year of `year` or `date`; undated cards are excluded) in chronological order, with ties broken by `createdAt` then `id`. WITH more than `maxSteps` (default 8) dated cards, it SHALL keep the first and last card, rank the others by degree (real edges and discoveries) with ties broken by an even spread over the timeline and then by `id`, and keep the original chronological order. Years SHALL be non-decreasing.
4. THE **Dialectical Debate** SHALL be built from edges whose `polarity` is `refutes`, extended with `synthesizes` edges that attach a further card, so it can end on a synthesis. IT SHALL need at least one `refutes` edge and three distinct cards in one connected component, and SHALL be omitted otherwise. Polarity SHALL NOT be inferred or faked.
5. THE **Dense Conceptual Nexus** SHALL be the densest group of 3 to `maxSteps` cards by the ghost engine's affinity (`GhostPairScore.base`: keywords, concept lexicon and tag overlap), grown greedily from the best pair. THE seed pair and the mean affinity of every card that joins SHALL reach `NEXUS_MIN_AFFINITY` (0.25), so unrelated cards are never bundled. A card linked to the cluster by a real edge or a discovery SHALL rank higher, but the link SHALL NOT count toward that minimum.
6. EACH trail SHALL have: id `t-auto-<kind>-<8 hex of the ordered nodeIds>` (identical content gives the identical id), `title`, an academic-style `description` built only from the trail's own cards (years, titles, shared concepts and tags), origin `ghost`, ordered `nodeIds` and `createdAt` from `options` (default: the newest `createdAt` among the trail's own cards).
7. EVERY trail SHALL hold between 3 and `min(nodes.length, 8)` distinct ids that exist in `nodes`. No id SHALL repeat, so no two consecutive ids are equal. A trail with the same ordered cards as an earlier one in the result SHALL be dropped.
8. THE output SHALL not depend on the order of the input arrays (inputs are sorted by `id`, edges by `source`, `target`, `id`). The one exception is a repeated node id, which a real graph never holds.
9. THE store action `generateAndAddAutoTrails(): Trail[]` SHALL run the engine on the live graph with `createdAt` set to the current time, skip a trail whose id or ordered `nodeIds` already exists, persist once through the existing commit path, and return the trails actually added. WHEN nothing is new, it SHALL return `[]` and write nothing. It SHALL NOT change playback state.
10. WHEN a card is deleted, THE SYSTEM SHALL keep trimming it from auto trails through the existing `removeNodeFromTrail`.
### Requirement 5: Interactive Weaving Show
**User Story:** As a researcher, I want to watch Sprocket build and walk a trail, so that the Ghost's work is visible and I end up inside the playback.
#### Acceptance Criteria
1. WHEN a weave is requested, THE SYSTEM SHALL call `generateAndAddAutoTrails()` and weave the first newly added trail (the Lineage Arc when it is among them).
2. IF nothing new was added, THE SYSTEM SHALL cycle through the existing auto trails (ids starting `t-auto-`, at least two cards) in id order, using the session counter `weaveCursor`. THE counter SHALL continue after the trail just woven.
3. IF no auto trail exists, THE SYSTEM SHALL show the retro toast "The reels hold no clear trail yet, Professor. Add a few dated or related cards and try again." (kind `NO_AUTO_TRAIL`) and do nothing else.
4. THE weaving state SHALL fit the whole trail with `fitView` over 800 ms (instant under reduced motion) while Sprocket runs to the first stop. THE camera SHALL NOT pan per leg (see the design for why).
5. FOR each consecutive pair of stops, Sprocket SHALL scamper along the planned leg: the same hop, wire and hop that `getTraversalPoint` gives (the stored edge's curve, walked backwards when the edge runs the other way, or the curve an edge would take when none exists). Each leg has the 150 ms wind-up, 600 ms flight with the stretch, the landing squash and a 120 ms dwell.
6. BEHIND Sprocket, THE SYSTEM SHALL draw an illuminated pulse filament in flow space: the traversed leg polylines, each as three plain strokes (a wide low-opacity amber underlayer, a violet glow and a crisp violet `#B388FF` core), revealed with `pathLength` in step with Sprocket's arc length. No SVG filter SHALL be used.
7. WHEN the last stop is reached, THE SYSTEM SHALL turn Sprocket 360° with a burst of 6 to 10 brass sparks (`#D97706`, `#FFB236`; transform and opacity only), fade the filament out over 900 ms, call `setActiveTrail(trail.id)` (the Lever opens at stop 0) and show a speech bubble that names the trail and its stops.
8. THE weave SHALL be cancelable: Escape or a click on Sprocket stops it, returns Sprocket to his perch, leaves the generated trails in the store and does not activate any trail.
9. A second request while weaving SHALL be ignored. A request while a trail is active SHALL be ignored.
10. IF a card of the trail is deleted, or a card of the trail is moved or resized, or the trail disappears while Sprocket weaves, THE SYSTEM SHALL abort the weave gracefully (stop, fade the filament, return to the perch, say so in the bubble).
11. THE weaving flag, the weaving trail id, the request counter and the cycle cursor SHALL be session-only: never in `localStorage`, never in the export and never in `useMemexStore`.
12. WHEN the component unmounts, THE SYSTEM SHALL clear every timer, animation and key listener of the weave and clear the weaving flag.
### Requirement 6: Trigger Button and Idle Prompt
**User Story:** As a researcher, I want an obvious way to start the show, and a nudge when I have stopped to think.
#### Acceptance Criteria
1. THE SYSTEM SHALL show a button "[🧶 AUTO-WEAVE TRAIL]" in the top-left HUD below the Wake Ghost button, only while at least 3 cards exist. IT SHALL be a real `<button>`, labelled "Auto-weave trail: Sprocket builds a trail from your cards and walks it", and SHALL be disabled while a weave runs or a trail is active, with a title that says why. THE HUD SHALL wrap at narrow widths.
2. THE button, the idle prompt and Sprocket SHALL start the weave through one session action, `requestWeave()`, which refuses (returns false) with fewer than 3 cards, an active trail or a weave in progress.
3. WHEN the user has been idle (the same `IDLE_THRESHOLD_MS` rule as the Guidance Beacon) with at least 3 cards, no active trail, no weave in progress, and `generateAutoTrails` finds at least one trail, THE SYSTEM SHALL show a speech bubble "I see a trail through these papers! Tap me to weave it." with a real button labelled "🧶 AUTO-WEAVE TRAIL".
4. WHILE the prompt is visible, clicking Sprocket SHALL start the weave instead of the quip. OTHERWISE a click keeps the Spec 06 quip.
5. THE prompt SHALL show at most once per idle period, SHALL dismiss itself after 12 s, and SHALL dismiss on a deliberate input elsewhere (click, key other than Tab and Shift, wheel, touch). Moving the mouse SHALL NOT dismiss it, so the user can reach Sprocket. Input on Sprocket or the prompt SHALL NOT dismiss it. Keyboard focus inside the prompt SHALL stop the timeout.
6. THE Beacon and the crawler SHALL share one set of window activity listeners (`activity-tracker.ts`), installed on first use and removed with the last user.
### Requirement 7: Reduced Motion and Accessibility
**User Story:** As a user who is sensitive to motion or uses a keyboard or screen reader, I want the show to be calm and usable.
#### Acceptance Criteria
1. WHILE `prefers-reduced-motion` is set, THE SYSTEM SHALL NOT squash, stretch, wag, spin, scamper or draw the filament progressively. Sprocket SHALL jump to each stop and fade in, the filament leg SHALL appear whole, the spin SHALL become a flicker, and there SHALL be no sparks. THE weave SHALL still complete, with a 350 ms pause per stop, and the camera fit SHALL be instant.
2. THE eye tracking and the happy arch MAY stay under reduced motion (a small pupil shift and an opacity cross-fade); the wag SHALL NOT.
3. EVERY control SHALL be a real `<button>` with an accessible name and SHALL be keyboard operable. NO focus trap SHALL exist: Tab and Shift do not dismiss the prompt, and the prompt is in the tab order before Sprocket.
4. THE weaving progress ("Weaving Lineage Arc: stop 3 of 7.") and the result bubble SHALL be announced through the persistent `role="status"` `aria-live="polite"` region.
### Requirement 8: Performance and Constraints
#### Acceptance Criteria
1. THE SYSTEM SHALL keep all genesis, physics, geometry, state machine and trigger rules in pure `src/core` modules (`trail-genesis.ts`, `sprocket-motion.ts`) with no React, clock or randomness.
2. THE SYSTEM SHALL NOT use SVG `<filter>`, `backdrop-blur` or CSS blur filters, and SHALL animate only `transform` and `opacity` (the filament's `pathLength` on a plain SVG path is the one allowed exception, as in the edges).
3. THE crawler SHALL write position, scale, pupil, happy, wag and filament progress to motion values. It SHALL re-render only on perch card, active trail, scanning flag, quantised zoom, idle flag, and its own small state (mode, bubble, spin, weave status), never per frame or per mouse move. Selectors in the HUD SHALL be primitives.
4. THE SYSTEM SHALL use only the palette `#090A0F`, `#141721`, `#FFB236`, `#B388FF`, parchment `#F4F1EA` and the brass `#D97706` / `#B45309`.
5. THE new UI SHALL NOT overlap the HUD, the Trails menu, the playback dock, the timeline, the drawer or the toaster: the button lives inside the HUD card; the prompt and bubbles live in the Sprocket status region above the sprite.
6. AN existing test SHALL change only where a deliberate behavior change requires it. (None did.)
