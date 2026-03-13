# studio:grid feature guide (with file ownership)

This document explains how the app works and maps each feature to the file(s) responsible.
It complements `AGENTS.md` (code map) and `README.md` (user manual).

Quick index (jump list)
- Architecture overview
- App lifecycle, windows, and menus
- HTTP server + static UI
- WebSocket sync
- Sequencer engine and state
- Transport + clock
- Grid rendering (hardware + UI)
- WebMIDI routing
- Grid editing (steps, accents, slides, chains)
- Patterns, bars, and follow
- Sequencer types
- Scales + transpose
- Device tabs, colors, and ordering
- Settings modal
- Save/load projects
- TD-3 import/export
- Hardware grid (monome)
- UI scale + layout
- Undo/redo
- Context menus + modals
- API endpoints
- Where to extend features

## Architecture overview
- Electron wrapper starts the local Node server and opens the UI.
  - File: `electron/main.cjs`
- Node server serves static UI, manages WebSocket sync, talks to Monome via serialosc, and runs the transport clock.
  - File: `server/index.js`
- Browser UI renders the grid, handles WebMIDI + interactions, and sends edits to the server.
  - File: `public/main.js`
- Core sequencing state, pattern logic, and LED frame generation.
  - File: `server/state.js`

## Feature map (scan-friendly)

### App lifecycle, windows, and menus
- Electron startup + server boot
  - `electron/main.cjs` (`ensureServer`, `app.whenReady`)
- Window sizing, UI scale changes
  - `electron/main.cjs` (`createWindow`, `clampWindowSize`, IPC `ui-scale-changed`)
- App menus (New/Open/Save/Settings, Undo/Redo)
  - `electron/main.cjs` (`buildAppMenu`) → renderer via IPC
- Save-on-quit dialog
  - `electron/main.cjs` (`rendererDirty`, `requestRendererSave`, close handler)
Find quickly
- `electron/main.cjs`: `ensureServer`, `createWindow`, `buildAppMenu`, `ipcMain.on`, `ipcMain.handle`

### HTTP server + static UI
- Serves `public/` files, handles `/api/export`, `/api/export-td3`
  - `server/index.js` (HTTP handler, `buildExportPayload`)
Find quickly
- `server/index.js`: `http.createServer`, `/api/export`, `/api/export-td3`, `guessContentType`

### WebSocket sync
- Client ↔ server message handling
  - `server/index.js` (`wss.on("connection")`, `handleClientMessage`, `broadcastState`)
  - `public/main.js` (`connectWS`, `ws.onmessage`, `send*IfChanged` helpers)
Find quickly
- `server/index.js`: `wss.on("connection")`, `handleClientMessage`, `broadcastState`, `broadcast`
- `public/main.js`: `connectWS`, `ws.onmessage`

### Sequencer engine and state
- Core state model, patterns, pages, transport, render frames
  - `server/state.js` (`SGridState` class)
- Primary grid input handling
  - `server/state.js` (`handleGridKey`, `handlePatternControlKey`, `handleCCKey`)
Find quickly
- `server/state.js`: `class SGridState`, `handleGridKey`, `tick`, `renderLED`

### Transport + clock
- Internal clock loop, tick processing, start/stop
  - `server/index.js` (`startTick`, `processTick`, `stopTick`, `continueTick`)
- External clock input and tick conversion
  - `server/index.js` (clock source handling, MIDI input hooks)
  - `public/main.js` (clock source/input UI + messages)
Find quickly
- `server/index.js`: `startTick`, `processTick`, `broadcastClockStatus`, `broadcastClockOut`
- `public/main.js`: `updateClockSource`, `applyClockSourceUI`

### Grid rendering (hardware + UI)
- LED frame generation for hardware + UI
  - `server/state.js` (`renderLED`, `renderUIFrame`, `renderMicrotimingFrame`)
- Frame diffing and dispatch to hardware/clients
  - `server/index.js` (`renderAndPush`, `enqueueLedFrame`, `broadcastLedUIFrame`)
- Canvas rendering in browser
  - `public/main.js` (`renderFrame`, drawing helpers)
Find quickly
- `server/state.js`: `renderLED`, `renderUIFrame`
- `server/index.js`: `renderAndPush`, `enqueueLedFrame`
- `public/main.js`: `renderFrame`

### WebMIDI routing
- MIDI device discovery and output selection
  - `public/main.js` (`initMIDI`, `refreshMIDIDevices`)
- MIDI event scheduling and sending
  - `public/main.js` (`scheduleMidiEvent`, `sendMIDISafe`, `sendMIDI`)
- MIDI event generation from sequencer state
  - `server/state.js` (`tick`, note/CC generation helpers)
Find quickly
- `public/main.js`: `initMIDI`, `sendMIDI`, `sendMIDICC`, `sendMidiClockPulse`

### Grid editing (steps, accents, slides, chains)
- Click/press to toggle steps
  - `public/main.js` (grid hit detection + `toggleGridCell`)
  - `server/state.js` (`toggleStep`, `setStepAccent`, `setStepSlide`)
- Octave/microtiming overlays
  - `public/main.js` (overlay UI + handlers)
  - `server/state.js` (`enqueueOctaveOverlay`, `enqueueMicroOverlay`)
- Slide chains + poly note chains
  - `server/state.js` (chain logic: `applySlideChainGesture`, `slideChainLength`, `breakChainAtStep`, etc.)
Find quickly
- `public/main.js`: `toggleGridCell`, `handleCanvasContextMenu`
- `server/state.js`: `toggleStep`, `setStepAccent`, `setStepSlide`, `applySlideChainGesture`

### Patterns, bars, and follow
- Pattern selection and pending pattern logic
  - `server/state.js` (`setPattern`, `toggleOrSetPattern`, `toggleDeviceSequencer`)
  - `public/main.js` (pattern buttons UI + WS messages)
- Bar view selection
  - `public/main.js` (`applyPatternLengthUI`, `applyPatternSelectUI`, bar buttons)
  - `server/state.js` (`setBarView`)
- Follow mode
  - `public/main.js` (`followBtn` handler)
  - `server/state.js` (`applyFollowToPlayhead`)
Find quickly
- `server/state.js`: `setPattern`, `setBarView`, `applyFollowToPlayhead`
- `public/main.js`: `applyPatternLengthUI`, `applyPatternSelectUI`

### Sequencer types
- Mono/Poly/Drum/MDTonal/CC type handling
  - `server/state.js` (step parsing, note generation, `getRowInfo`, `getDrumPitch`, `md*` helpers)
  - `public/main.js` (sequencer type UI + settings)
Find quickly
- `server/state.js`: `getRowInfo`, `getDrumPitch`, `mdTrackConfig`

### Scales + transpose
- Global scale root/mode
  - `server/state.js` (`setScale`, `calcPitch`, `getScaleIntervals`)
  - `public/main.js` (scale dropdowns + WS messages)
- Per-page transpose
  - `server/state.js` (`setTranspose`)
  - `public/main.js` (transpose controls)
Find quickly
- `server/state.js`: `setScale`, `calcPitch`, `setTranspose`

### Device tabs, colors, and ordering
- Tab rendering + playhead progress on tabs
  - `public/main.js` (`renderTabs`, `drawDeviceTabProgress`)
- Tab reordering via drag/drop
  - `public/main.js` (tab drag handlers)
  - `server/state.js` (`setDeviceOrder`)
- Device colors and defaults
  - `public/main.js` (color modal, default palette)
  - `server/state.js` (`setDeviceColor`, default color handling)
Find quickly
- `public/main.js`: `renderTabs`, `applyDeviceBadge`
- `server/state.js`: `setDeviceOrder`, `setDeviceColor`

### Settings modal
- UI state and input bindings
  - `public/main.js` (`syncSettingsInputs`, `applySettingsFromInputs`)
- Applied settings stored in local config
  - `public/main.js` (`loadSavedConfig`, `pushSavedConfigToServer`)
- Server-side effect of settings
  - `server/state.js` (tempo, swing, gate length, base division, LED levels)
  - `server/index.js` (clock source, clock outputs)
Find quickly
- `public/main.js`: `syncSettingsInputs`, `applySettingsFromInputs`
- `server/state.js`: `setTempo`, `setSwing`, `setGateLength`, `setLedLevels`

### Save/load projects
- Export snapshot (project)
  - `server/index.js` (`/api/export` uses `buildExportPayload`)
  - `public/main.js` (`startExport`)
- Import snapshot (project)
  - `public/main.js` (file picker + `applySnapshot` flow)
  - `server/state.js` (`loadSnapshot`)
- Electron save to Documents/studio-grid/sets
  - `electron/main.cjs` (IPC `save-set`)
  - `public/main.js` (`saveSnapshotToElectron`)
Find quickly
- `public/main.js`: `startExport`, `saveSnapshotToElectron`, `loadSavedConfig`
- `server/state.js`: `snapshot`, `loadSnapshot`

### TD-3 import/export
- Export TD-3 `.seq`
  - `server/index.js` (`/api/export-td3`, `buildTd3Seq`)
  - `public/main.js` (TD-3 modal + export flow)
- Import TD-3 `.seq` and scale detection
  - `public/main.js` (TD-3 import UI + preview)
  - `server/td3.js` (parse + scale detection + conversion helpers)
Find quickly
- `public/main.js`: `openTd3Modal`, `triggerTd3Export`, `requestTd3ImportPreview`
- `server/td3.js`: `parseTd3SeqBuffer`, `detectScale`

### Hardware grid (monome)
- serialosc discovery and device events
  - `server/serialosc-bridge.js` (device detection, key events)
  - `server/index.js` (registers handlers and dispatch)
- Hardware LED updates
  - `server/index.js` (frame enqueue + diff send)
  - `server/state.js` (LED frame generation)
Find quickly
- `server/index.js`: `serial.on("grid_key")`, `dispatchGridEvents`, `enqueueLedFrame`

### UI scale + layout
- UI scale selector and window resize
  - `public/main.js` (ui scale select + WS/IPC send)
  - `electron/main.cjs` (`ui-scale-changed` handler)
Find quickly
- `public/main.js`: `applyUiScale`

### Undo/redo
- Snapshot history + undo/redo commands
  - `public/main.js` (`queueUndoSnapshot`, `performUndo`, `performRedo`)
  - `electron/main.cjs` (menu sends undo/redo IPC)
Find quickly
- `public/main.js`: `queueUndoSnapshot`, `performUndo`, `performRedo`

### Context menus + modals
- Device/note/pattern menus
  - `public/main.js` (menu open/close + handlers)
- Modals (save, rename, TD-3, settings, confirm)
  - `public/main.js`
Find quickly
- `public/main.js`: `open*Modal`, `close*Modal`

### API endpoints
- Export current set
  - `server/index.js` (`/api/export`)
- Export TD-3 `.seq`
  - `server/index.js` (`/api/export-td3`)

## Where to extend features
- New sequencing logic or behaviors → `server/state.js` (then wire UI + WS).
- New UI controls or dialogs → `public/main.js` + `public/index.html` + styles.
- New hardware behaviors (grid LEDs, key maps) → `server/state.js` + `server/index.js`.
- New persistence formats → `server/index.js` (exports) + `server/state.js` (snapshots).
