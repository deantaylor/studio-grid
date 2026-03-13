# studio-grid code map (living notes)

This file is a quick, always-available map of the main runtime files and what they do. It focuses on where to look first when you need to change behavior.

## High-level flow
- Electron app (`electron/main.js`) starts the local Node server and opens a browser window pointed at it.
- The Node server (`server/index.js`) serves the static UI from `public/`, hosts a WebSocket, talks to Monome via serialosc, and owns the transport clock.
- The browser UI (`public/main.js`) renders the grid UI, handles WebMIDI + user interactions, and syncs state with the server over WebSocket.
- Core sequencing logic and LED frame generation live in `server/state.js` (class `SGridState`).

## File map

### `electron/main.js`
Purpose: Electron bootstrap + app lifecycle, window sizing, app menu, IPC bridge for save/dirty/UI scale.

Key areas
- Startup and server boot
  - `ensureServer()` finds a free port, sets `process.env.PORT`, and starts `startServer()` from `server/index.js`.
  - `app.whenReady()` wires menu + creates the window.
- Window creation and sizing
  - `createWindow()` sets `BrowserWindow` options and executes a DOM probe to resize to content (no scrollbars).
  - `clampWindowSize()` limits window size to screen work area.
- App menu and shortcuts
  - `buildAppMenu()` defines File/Edit/View/Window menus and forwards menu actions to the renderer via IPC.
- Save/quit flow
  - Tracks `rendererDirty` and intercepts window close to offer Save/Quit.
  - `requestRendererSave()` asks the renderer to save before quit.
- IPC handlers
  - `ipcMain.on("ui-scale-changed")` resizes the window to match UI scale.
  - `ipcMain.on("dirty-changed")` updates local dirty state.
  - `ipcMain.handle("save-set")` writes `.studiogrid` JSON to the Documents/`studio-grid/sets` folder.
- Shutdown
  - On `window-all-closed`, stops the HTTP server and clears LEDs via server `serial`.

### `server/index.js`
Purpose: Local HTTP server + WebSocket hub + transport clock + Monome serialosc bridge.

Key areas
- HTTP server
  - Serves `public/` assets and handles `/api/export` and `/api/export-td3` endpoints.
- WebSocket + client sync
  - `wss.on("connection")` and `handleClientMessage()` handle UI messages (settings, steps, transport, pattern edits, etc.).
  - `broadcastState()` sends initial state snapshot and config to clients.
  - `broadcast()` and `broadcastEvents()` push state or event updates to all clients.
- SerialOSC bridge
  - `SerialOSCBridge` receives grid input, status, and device info; emits LED updates.
  - `dispatchGridEvents()` routes Monome key presses into `SGridState` logic.
- Transport and timing
  - Manages external vs internal clock, tick scheduling, and `processTick()`.
  - `startTick()`, `stopTick()`, `continueTick()` orchestrate transport state.
- LED rendering + frame dispatch
  - `renderAndPush()` calls `state.renderLED()` and sends diffs to devices.
  - Frame helpers: `cloneGridFrame()`, `framesEqual()`, `countFrameChanges()`.
  - `enqueueLedFrame()` + `broadcastLedUIFrame()` keep UI in sync with hardware.
- Utilities
  - `buildExportPayload()` creates JSON exports from state.
  - `guessContentType()` infers HTTP content types.
  - `midiInputsList()` supplies available MIDI input list for UI.

### `server/state.js`
Purpose: Core sequencer state, mutation logic, pattern operations, MIDI event generation, LED/UI frame rendering.

Key areas
- Class `SGridState`
  - State: tempo, swing, pages/patterns, device info, MIDI config, overlays, transport counters, etc.
  - `requestRender` callback is set by server to force an LED/UI update.
- State and config setters
  - Tempo/swing/division/gate: `setTempo`, `setSwing`, `setBaseDivision`, `setGateLength`.
  - Scale/isomorphic layout: `setScale`, `setIsomorphicLayout`, `setIsomorphicMode`.
  - Device config: `setDeviceName`, `setDeviceNote`, `setDeviceColor`, `setSequencerType`.
  - MIDI config: `setMidiConfig`, `setCCNumber`, `setMDTrack`.
- Pattern + step editing
  - Step edits: `toggleStep`, `clearStep`, `setStepAccent`, `setStepSlide`, `setStepOctave`, `setStepMicroOffset`.
  - Selection ops: `moveSteps`, `copySteps`, `applyMoveOrCopyToStep`.
  - Pattern ops: `setPattern`, `toggleOrSetPattern`, `cyclePattern`, `clearPattern`, `clearBar`, `shiftPattern`.
- Grid input handling
  - `handleGridKey()` is the primary entry for Monome key events.
  - `handlePatternControlKey()`, `handleNeighborGesture()`, `handleCCKey()` route context-specific actions.
- Microtiming + overlays
  - `enqueueOctaveOverlay`, `enqueueMicroOverlay`, `consume*Overlays`.
  - `microtimingRowForNoteRow`, `microtimingValueForColumn`, `start/exitMicrotimingMode`.
- Snapshots and persistence
  - `snapshot()` / `loadSnapshot()` serialize and restore state.
  - `patternSnapshot`, `applyPatternSnapshot`, `barSnapshot`, `applyBarSnapshot`.
- Transport + tick processing
  - `tick()` advances state, generates MIDI events, updates playheads.
  - Helpers for tick conversion and gate timing.
- LED/UI rendering
  - `renderLED()` generates the frame for the hardware grid.
  - `renderUIFrame()`, `renderIsomorphicUIFrame()`, `renderMicrotimingFrame()` support UI views.

### `public/main.js`
Purpose: Frontend UI logic (canvas rendering, WebSocket sync, WebMIDI, modals, settings, selection tools).

Key areas
- Rendering + color utilities
  - CSS color resolution, LED palette, device color palette, and color mixing helpers.
  - `renderFrame()` draws the 16x8 LED grid on `<canvas>`.
- WebSocket sync
  - `connectWS()` opens a WS connection and handles inbound state updates.
  - `send*IfChanged()` helpers push deltas to the server.
- WebMIDI + clock
  - `initMIDI()`, `refreshMIDIDevices()` set up MIDI inputs/outputs.
  - Internal transport clock (`startInternalClockLoop`) + external clock handling.
- UI controls and settings
  - Custom select controls (`buildCustomSelect`, `initCustomSelects`).
  - Settings dialog sync (`syncSettingsInputs`, `applySettingsFromInputs`).
  - UI scale, clock source, gate length, base division, mono slide, etc.
- Patterns, pages, and tabs
  - `updatePage()`, `renderTabs()`, `applyPatternLengthUI()`, `applyPatternSelectUI()`.
  - Device tab progress rendering for playheads.
- Editing interactions
  - Grid hit detection and selection logic (`getGridHit`, `updateSelectionFromCells`, selection move/copy).
  - Context menus for devices, notes, and pattern length.
- Import/export + persistence
  - `saveSnapshotToElectron()` (Electron IPC), `saveSnapshotToHandle()` (File System Access API).
  - TD-3 import/export flows (sysex + file import).
  - Local config caching (`loadSavedConfig`, `pushSavedConfigToServer`).
- Modals and toasts
  - Rename/save dialogs, confirm modals, color picker, TD-3 modals, sequence type modal.

## Entry points when debugging
- Renderer startup: `public/main.js` global initialization at top-level and DOM `load` handlers.
- Server startup: `server/index.js` exports `startServer()`; `electron/main.js` calls it.
- Sequencer logic: `SGridState` in `server/state.js` (especially `handleGridKey()` and `tick()`).

## Notes
- This file is intended to stay short and factual. Expand by adding focused subsections when you learn a new module or behavior.
