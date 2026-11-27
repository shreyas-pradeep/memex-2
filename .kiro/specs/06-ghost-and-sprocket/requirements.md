# Requirements Document: The Ghost & Sprocket (UX Mischief & Guidance Suite)
## Introduction
This specification adds a small cast of helpers to Memex 2.0: **Sprocket**, a brass microfilm crawler that sits on cards, scurries along trail wires and reacts to the Ghost Engine; a **Ghost Guidance Beacon** that tells the user what to do next; and **retro toasts** for three user mistakes. *(Spec 07 later added a fourth toast, `NO_AUTO_TRAIL`, and gave Sprocket squash-and-stretch physics, eye tracking and a weaving show. The notes marked "Spec 07" below record what changed.)* All of it is presentation. It reads the graph and playback state, writes nothing to the graph, and adds no persisted or exported state.
Terminology maps to the real codebase: a "card" is a `MemexNode` in the store's `nodes`; the active trail step is `activeTrailIndex`; auto-play is `isPlayingAuto`; discoveries are `ghostDiscoveries`. "The 1945 Lever" is the `TrailPlaybackDock`, which appears only while a trail is active. The trail picker was the top-center `TrailSelectorMenu` ("Trails · N"); since Spec 08 it is the Curator's Index (top-center `[📜 TRAILS & REELS (N)]` button and the `[T]` key), not the dock. The Wake button reads "⚡ Wake Ghost Engine" (the HUD sets it in capitals).
## Requirements
### Requirement 1: Sprocket Sprite
**User Story:** As a researcher, I want a small mechanical companion on the canvas, so that the archive feels inhabited without getting in my way.
#### Acceptance Criteria
1. THE SYSTEM SHALL draw Sprocket as a 24×24 SVG with a brass chassis (`#D97706`, `#B45309`), four articulated legs and a glowing eye.
2. THE eye SHALL be amber `#FFB236` normally and phantom violet `#B388FF` while the Ghost is awake. THE Ghost is awake WHILE `isGhostScanning` is true and for 2.5 seconds after a scan that found at least one new synapse.
3. THE SYSTEM SHALL render Sprocket in flow coordinates, so it pans and zooms with the cards, and SHALL NOT re-render it on card drags or on every viewport frame.
4. THE SYSTEM SHALL give pointer events only to the sprite itself, so Sprocket never blocks dragging, selecting or connecting cards.
5. WHEN the canvas has no cards, THE SYSTEM SHALL hide Sprocket.
6. WHILE idle, THE SYSTEM SHALL perch Sprocket at the top-right of the header of the current trail stop, or of the most recently added card when no trail is active, and SHALL show a subtle breathing bob that never changes its coordinates.
7. THE perch SHALL lie on the top edge of the card, inset from the right corner so the resize handle stays free, and SHALL follow the card while it is dragged.
### Requirement 2: Trail Wire Traversal
**User Story:** As a researcher, I want Sprocket to follow the line between trail stops, so that the playback feels like a journey along a real wire.
#### Acceptance Criteria
1. WHEN `activeTrailIndex` of the same active trail changes by exactly one, THE SYSTEM SHALL move Sprocket from the old stop's perch along the wire to the new stop's perch in 800 ms, the length of the camera glide. *(Spec 07: the 800 ms now holds a 150 ms wind-up and a 650 ms flight, followed by the landing rebound.)*
2. THE wire SHALL be the same cubic Bezier the `AssociativePulseEdge` draws between those two cards: the same facing sides, anchors and curvature, computed by one shared pure function.
3. WHEN the stored edge between the two stops runs the other way, THE SYSTEM SHALL walk that stored curve backwards, so Sprocket still follows the drawn line.
4. WHEN no edge joins the two stops, THE SYSTEM SHALL use the curve an edge between them would take, and SHALL NOT fail.
5. THE position of Sprocket during a traversal, for any card rectangles and any progress value, SHALL stay inside the bounding box of the union of the source and target rectangles. Progress outside `[0, 1]`, NaN, infinite coordinates, zero-size and reversed rectangles SHALL be handled without throwing.
6. WHEN the trail changes, the active stop jumps by more than one, or the perch card changes for any other reason, THE SYSTEM SHALL glide Sprocket to the new perch (or fade it there under reduced motion) instead of following a wire.
7. WHEN a traversal starts while another animation runs, THE SYSTEM SHALL cancel the earlier animation first.
### Requirement 3: Ghost Reaction
**User Story:** As a researcher, I want Sprocket to notice new synapses, so that I know the Ghost found something.
#### Acceptance Criteria
1. WHEN a ghost scan finishes (`isGhostScanning` goes from true to false) and `ghostDiscoveries` holds a discovery that was absent when the scan started, THE SYSTEM SHALL show a "!" popup above Sprocket for 0.9 seconds.
2. THE SYSTEM SHALL then move Sprocket to the midpoint of the wire of the highest-confidence new discovery, computed from its two cards with the same path function as the edge. Equal confidence SHALL be broken by the smaller discovery ID, so the choice does not depend on array order.
3. THE SYSTEM SHALL play a 2-second "inspecting" animation (head tilt and scan, `transform` and `opacity` only), then return Sprocket to its perch.
4. WHEN no discovery is new, THE SYSTEM SHALL NOT react.
5. WHEN the set of cards changes during the scan, THE SYSTEM SHALL NOT react.
6. IF a card of the discovery, or the discovery itself, disappears while the reaction runs, THEN THE SYSTEM SHALL cancel the reaction and return Sprocket to its perch.
7. WHEN the component unmounts, THE SYSTEM SHALL clear every timer and stop every animation.
8. THE reaction SHALL NOT write to the store and SHALL NOT interfere with the card highlight pulse (`highlightedNodeId`).
### Requirement 4: Click Dialogue
**User Story:** As a researcher, I want a clickable character with a bit of personality, so that the tool is friendly.
#### Acceptance Criteria
1. THE sprite SHALL be a native `<button>` with `aria-label="Sprocket the microfilm crawler: click for a quip"`, reachable by keyboard and operable with Enter and Space, with a visible focus outline.
2. WHEN the user activates Sprocket, THE SYSTEM SHALL turn it 360° once *(Spec 07: not while the idle weave prompt shows, when the activation starts the weave instead, and not while a weave runs, when it stops the weave)*, show a miniature steam puff (a few small SVG circles that rise and fade, no filters) and show a speech bubble.
3. THE bubble SHALL show the next of four quips, in this order and verbatim: "Synapse tensile strength nominal, Professor!", "Careful with that 1945 lever—gears haven't been greased since Engelbart's demo.", "I found a conceptual bridge! Or maybe it's just lint in the microfilm reel.", "Associative trails verified. Vannevar Bush would be proud."
4. THE quip SHALL be chosen by a click counter held in the component and advanced by a pure function, never by a random number. For any index (negative, huge, non-integer, NaN, infinite), THE SYSTEM SHALL return one of the four quips, never an empty value, and the same index SHALL give the same quip.
5. THE bubble SHALL dismiss itself after 3.5 seconds, SHALL be inside a persistent `role="status"` region with `aria-live="polite"`, and SHALL NOT take pointer events.
### Requirement 5: Guidance Beacon
**User Story:** As a researcher, I want a hint that always says what I can do next, so that I never stare at an unexplained canvas.
#### Acceptance Criteria
1. THE SYSTEM SHALL show the beacon in the top-left HUD directly below the Wake Ghost button: a pulsing phosphor eye with violet mist (radial gradients animated by opacity and transform) and a text bubble.
2. THE bubble text SHALL come from a pure function of the card count, the active trail, auto-play, the discovery count, the scanning flag, the trail count and the idle time. For every combination, including negative, NaN, infinite and huge values, THE function SHALL return a state ID and a non-empty text that contains a bracketed control name or an action verb (press, select, click, tap, watch, use).
3. THE function SHALL choose the first matching state in this order:

   | # | State ID | Condition | Text |
   |---|---|---|---|
   | 1 | `empty-canvas` | no cards | "The microfilm reels are blank. Press [I] to scan a document onto the platen." |
   | 2 | `scanning` | Ghost scanning | "The Ghost Engine is sweeping the archive. Watch for glowing violet ⚡ SYNAPSE links." |
   | 3 | `trail-playing` | trail active and auto-playing | "Automated walkthrough underway. Press [❚❚ Auto-Play] to pause, or [Esc] to leave the trail." |
   | 4 | `trail-active` | trail active | "Press [▶] to begin automated camera walkthrough, or use [Next] to step manually." |
   | 5 | `discoveries-pending` | at least one discovery | "The Ghost found hidden links. Click a ⚡ SYNAPSE badge on the canvas to open the inspector." |
   | 6 | `idle-whisper` | idle for more than 15000 ms | "The archives whisper... tap [⚡ WAKE GHOST ENGINE] to reveal hidden latent connections." |
   | 7 | `no-trails` | trail count known and 0 | "No trails charted yet. Select two or more cards, then open [📜 TRAILS & REELS] or press [T] and choose [+ BLAZE NEW TRAIL]." |
   | 8 | `cards-no-trail` | otherwise | "Open [📜 TRAILS & REELS] or press [T] to pick an associative trail and pull up the 1945 Lever." |

4. THE idle time SHALL be strictly greater than `IDLE_THRESHOLD_MS` (15000) to count as idle; NaN and negative values SHALL NOT count.
5. THE SYSTEM SHALL measure idle time with passive, throttled listeners (pointer, keyboard, wheel, touch) that are removed on unmount *(Spec 07: one shared set, `activity-tracker.ts`, also used by Sprocket's weave prompt)*, and a one-second timer that sets state only when the idle flag flips. Activity SHALL reset the flag at once.
6. THE beacon SHALL re-render only when one of its primitive inputs changes, so a card drag does not re-render it, and its live region SHALL announce only a change of state.
7. THE beacon SHALL offer a visible "✕" control (labelled "Hide ghost hints") that collapses it to a "Show ghost hints" button. THE choice SHALL last for the session only and SHALL NOT be persisted.
8. THE bracketed control names SHALL match the real controls: `[I]` (shortcut), "▶ Auto-Play" / "❚❚ Auto-Play" and "Next ▶" (dock), "⚡ Wake Ghost Engine" (HUD, shown in capitals), "[📜 TRAILS & REELS]" and `[T]` (Curator's Index), "[+ BLAZE NEW TRAIL]" (its form), and Escape (exits playback).
### Requirement 6: Retro Toasts
**User Story:** As a researcher, I want playful but clear notices when something does not work, so that mistakes explain themselves.
#### Acceptance Criteria
1. THE SYSTEM SHALL show toasts styled with the `#141721` surface, amber `#FFB236` or violet `#B388FF` accents and a monospace label such as "[ SIGNAL // NOTICE ]".
2. THE SYSTEM SHALL keep at most 3 toasts, remove the oldest when a fourth arrives, and drop a toast whose message equals the newest toast's message.
3. EACH toast SHALL dismiss itself after 4.5 seconds, SHALL have a "✕" button labelled "Dismiss notice", and SHALL clear its timer when it goes away.
4. THE container SHALL be a polite live region that stays mounted, SHALL ignore pointer events outside the toasts, SHALL sit above modals, and SHALL move left of the Synapse Inspector drawer while the drawer is open.
5. WHEN the user drops or chooses an empty file, or submits blank or whitespace-only raw text in the Platen modal, THE SYSTEM SHALL show "Even a 1945 vacuum tube cannot decipher blank parchment, Professor. Feed the platen some ink." and SHALL keep the inline error.
6. WHEN playback arrives at the last stop of a trail from an earlier stop (Next, auto-play or a timeline jump), THE SYSTEM SHALL show "You have arrived at the frontier of human knowledge. Blaze a new trail to proceed." once for that arrival. It SHALL NOT show it when a trail starts, or when the dock re-renders. WHEN the user presses the Right Arrow key on the last stop, THE SYSTEM SHALL show it once per key press (not on key repeat).
7. WHEN the arXiv input is not a valid identifier (client-side parse fails, and the input is not a DOI) or the resolver answers 400, THE SYSTEM SHALL show "The signal was lost in the ether. Please check your arXiv identifier." and SHALL keep the inline message. THE DOI "not supported yet" message SHALL NOT use this toast. An aborted or cancelled request SHALL NOT show a toast.
8. THE toast state SHALL be session-only: it SHALL NOT be written to localStorage or to the exported JSON, and SHALL NOT change `useMemexStore`.
### Requirement 7: Reduced Motion and Accessibility
**User Story:** As a user who is sensitive to motion or uses a keyboard or screen reader, I want the helpers to be usable and calm.
#### Acceptance Criteria
1. WHILE `prefers-reduced-motion` is set, THE SYSTEM SHALL NOT scurry, spin, bob, tilt, pulse or animate the legs; Sprocket SHALL jump to its next position and fade in, the spin SHALL become a brief flicker, the steam puff SHALL only fade, and toasts SHALL only fade.
2. THE SYSTEM SHALL keep every control keyboard operable and SHALL NOT trap focus. The toast container SHALL NOT take focus.
3. THE SYSTEM SHALL give every icon-only control an accessible name and SHALL announce a new synapse spotted by Sprocket through the status region.
### Requirement 8: Performance and Constraints
#### Acceptance Criteria
1. THE SYSTEM SHALL keep all geometry, quips, selection, guidance and toast rules in pure `src/core/sprocket-engine.ts` with no React dependency, no clock and no randomness (time and idle values are passed in).
2. THE SYSTEM SHALL move `AssociativePulseEdge`'s anchor and side logic into that module and have the edge call it, with identical rendering.
3. THE SYSTEM SHALL NOT use SVG `<filter>`, `backdrop-blur` or CSS blur filters, SHALL animate only `transform` and `opacity` (leg motion is a CSS `transform` keyframe), and SHALL use framer-motion springs with stiffness 300 and damping 28 for UI springs.
4. THE crawler SHALL write positions to motion values, not React state, so a scurry causes no re-renders; it SHALL subscribe to the store outside React and re-render only on perch card, active trail, scanning flag or quantised zoom changes.
5. THE counter-scale that keeps Sprocket legible when zoomed out SHALL be quantised to quarter zoom steps, so it is not a per-frame viewport subscription.
6. THE SYSTEM SHALL use only the palette `#090A0F`, `#141721`, `#FFB236`, `#B388FF`, parchment `#F4F1EA` and the brass `#D97706` / `#B45309` of the sprite.
7. THE new UI SHALL NOT overlap the HUD, the Curator's Index trigger, the playback dock, the timeline, the drawer or the modals.
