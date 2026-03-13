# Interaction Audit: UI vs Monome

## Intent Mapping (UI path vs Monome path)

| Intent | UI Path | Monome Path |
| --- | --- | --- |
| Device selection | `public/main.js` `renderTabs()` -> `focusPage()` -> `updatePage()` -> WS `set_page` -> `server/index.js` `handleClientMessage` -> `state.setPage()` -> `renderAndPush()` -> WS `page_change` -> `updatePage()` | `server/index.js` `serial.on("grid_key")` -> `state.handleGridKey()` -> `state.setPage()` -> `renderAndPush()` -> WS `page_change` -> `updatePage()` |
| Note edit mode (octave/micro overlays) | UI hover -> WS `get_step_state` -> UI `showOctaveControls()`; edits via WS `set_step_octave` / `set_step_micro` -> server state change -> overlay broadcast | Monome key-hold -> `state.handleGridKey()` hold timer -> `enqueueOctaveOverlay()` -> `renderAndPush()` -> overlay broadcast; neighbor gestures -> `handleGridKey()` returns `octave` / `micro` events -> overlay broadcast |
| Pattern launch / change | UI `setPattern()` -> WS `set_pattern` -> `state.setPattern()` -> `broadcastPatternStatus()` -> `renderAndPush()` | Monome pattern-control view -> `state.handleGridKey()` -> `pattern_status` event -> `broadcastPatternStatus()` -> `renderAndPush()` |
| Bar view / length changes | UI pattern length buttons -> WS `set_pattern_length` -> `state.setPatternLength()` -> `broadcastPatternLength()` -> `renderAndPush()` | Monome bottom-row controls -> `state.handleGridKey()` -> `pattern_length` or `bar_view` -> `broadcastPatternLength()` / `broadcastBarView()` -> `renderAndPush()` |
| Transport (start/stop) | UI transport controls -> WS `transport` -> `startTick()` / `stopTick()` -> `renderAndPush()` | Monome does not directly start/stop transport; follows server transport |

## Discrepancies & Redundant Logic

- UI device selection sends `set_page` twice (`focusPage()` and `updatePage()`), while Monome path sends once.
- UI path rendered a blank frame immediately on selection when no cached frame existed; Monome path waited for server-led frames.
- `grid_key` handling was duplicated between UI and Monome with drift:
  - UI path did not broadcast `micro` overlay events from `state.handleGridKey()`.
  - Monome path used `getStepInfo()` without `uiMode`, causing overlay misses in full-scale mode.
  - Monome `bar_view` broadcast skipped overlay snapshots, while UI used `broadcastBarView()`.
- Pattern-control latch changes did not trigger render/push, so LED/UI could remain stale until clock/tick activity.

## Root Cause Analysis

1) UI device selection flicker
- Cause: UI selection immediately rendered `frames[currentPage]` (often empty for newly selected pages) before server `led_frame` arrived, plus duplicate `set_page` requests.
- Fix: defer frame render when no cached frame is ready and remove duplicate `set_page` send.

2) Missing overlays when Monome enters note edit mode
- Cause: overlay emission paths diverged; Monome used `getStepInfo()` without `uiMode` (incorrect row mapping in full-scale) and `grid_key` dispatch was not unified with UI path (missing `micro` overlay handling, inconsistent `bar_view` overlay snapshots).
- Fix: unify grid event dispatch, include `uiMode` in Monome `getStepInfo()`, and handle `micro` events in the shared path.

3) Clock-gated UI / LED updates
- Cause: some state changes (e.g., pattern-control latch) did not call `renderAndPush()`, so updates relied on clock/tick-driven renders.
- Fix: trigger render on latch changes and force LED/UI refresh independent of transport state.

## Intentional Exceptions (documented)

- Monome pattern-control latching semantics remain hardware-specific and are handled in the adapter layer (`state.handleGridKey()` with `patternControlLatch`). This behavior is intentionally different from UI toggles and should not be forced into identical behavior.

## Verification Checklist

- UI device selection is smooth (no blank-frame flicker).
- Entering note edit mode from Monome shows octave/micro overlays in the UI.
- UI and Monome LED feedback updates when the clock is stopped.
- Monome-specific latching behavior remains intact.
