SPEC: Microtiming Mode — Revised Interaction (Monome + Software UI)

SCOPE
This change affects interaction and UI behavior only.

The following remain unchanged:
- Microtiming data model
- Storage and serialization
- Playback and scheduling logic
- Immediate application of timing changes during playback

Microtiming modifies note timing only. It never modifies step position, paging, or pattern structure.


CORE PRINCIPLE
Microtiming is independent of step position and grid paging.

The grid is used purely as a value-selection surface. Microtiming values are selected spatially and applied to the currently edited note, regardless of where that note exists in the pattern.


NOTE EDIT MODE (PREREQUISITE STATE)
When entering note edit mode:
- The edited note remains fully lit
- All other notes are dimmed
- The left button remains lit
- The octave shift buttons remain lit
- Only the edited note is interactive

This applies to both:
- monome LED state
- software UI state

Note edit mode is required before microtiming mode can be entered.


REMOVED INTERACTION
- Remove all existing monome-based left/right microtiming adjustments
- Microtiming is accessible on the monome only via microtiming mode

Exception:
- The software UI may still adjust microtiming using its left/right overlay controls

There are no alternative monome access paths.


ENTERING MICROTIMITING MODE (MONOME)
Preconditions (all required):
1. The system is in note edit mode
2. A note is actively held
3. The user taps the left neighbour cell of the held note

Result:
- The system enters microtiming mode
- Microtiming mode is a strict sub-mode of note edit mode
- Input routing switches immediately

If any precondition is not met:
- No action occurs
- Input is not forwarded


MODAL CONSTRAINT
- The user must keep the note held
- Releasing the note:
  - exits microtiming mode
  - exits note edit mode
  - returns to normal sequencing mode

There are no toggles, latching behavior, or secondary exit paths.


GRID USAGE (MONOME)
- Minimum grid size: 16 x 8
- In microtiming mode:
  - exactly one row is active
  - 16 buttons are used for value selection
- All other buttons:
  - remain visible but dimmed
  - ignore input

Grid paging, pattern length, and step indices are irrelevant while in this mode.


ACTIVE MICROTIMITING ROW SELECTION
Based on the vertical position of the edited note:

- If the note is in the top half of the grid:
  - the top row is used for microtiming selection

- If the note is in the bottom half of the grid:
  - the bottom row is used for microtiming selection
  - all other monome controls are temporarily hidden or disabled
  - microtiming mode takes over the entire control surface


MICROTIMITING VALUE SPACE
- Range: -23 to +23
- Zero (0) is implicit
- Total selectable values: 46
- UI must clamp values to +/-23, even if the internal engine supports a wider range

Zero is represented by no button being lit.


BUTTON TO VALUE MAPPING
- Each of the 16 buttons in the active row maps to one discrete microtiming value
- Mapping is static and absolute
- Left side = negative timing (earlier)
- Right side = positive timing (later)
- Zero state = no button lit

Buttons do not represent steps or sequence positions.

Exact index-to-value mapping is an implementation detail but must remain consistent and symmetric.


INTERACTION BEHAVIOR
- Tapping a button:
  - immediately sets the microtiming value
  - updates playback immediately
  - updates LED state immediately
- While the note is held:
  - the user may tap multiple buttons
  - selection updates continuously
- No incremental stepping
- No accumulation

Transport may be running; changes apply immediately.


LED RULES (MICROTIMITING MODE)
- Held note: solid bright
- Active microtiming row: fully visible
- Selected value: corresponding button lit
- Zero (0): no buttons lit
- All other rows: dimmed and ignore input


INPUT CAPTURE AND CONFLICT RULES
While in microtiming mode:
- All monome input is consumed
- No sequencing, transport, or global actions are triggered
- This includes the bottom-half takeover case

Outside microtiming mode:
- Microtiming logic does not consume input


SOFTWARE UI BEHAVIOR
- The software UI must visually show the microtiming edit row
- Uses the same value range (-23 to +23)
- Zero-state visualization is deferred to a later iteration
- Left/right overlay controls remain valid in the software UI only

Intentional asymmetry:
- monome = spatial, direct value selection
- software UI = spatial + incremental adjustment


EXPLICIT NON-GOALS (THIS ITERATION)
- No swing or groove templates
- No duration or length changes
- No alternate entry gestures
- No refined zero visualization


IMPLEMENTATION SUMMARY (CODEX)
- Treat microtiming selection as a pure value-selection mode
- Ignore step indices, pattern paging, and grid position
- Clamp UI values to +/-23
- Enforce strict modal input capture
- Zero equals absence of selection, not a button
