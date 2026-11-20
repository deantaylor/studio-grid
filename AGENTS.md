# studio-grid code map (living notes)

This file is a quick, always-available map of the main runtime files and what they do. It focuses on where to look first when you need to change behavior.

## High-level flow
- Electron app (`electron/main.cjs`) starts the local Node server and opens a browser window pointed at it.
- The Node server (`server/index.js`) serves the static UI from `public/`, hosts a WebSocket, talks to Monome via serialosc, and owns the transport clock.
- The browser UI (`public/main.js`) renders the grid UI, handles WebMIDI + user interactions, and syncs state with the server over WebSocket.
- Core sequencing logic and LED frame generation live in `server/state.js` (class `SGridState`).

## File map

### `electron/main.cjs`
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
- Server startup: `server/index.js` exports `startServer()`; `electron/main.cjs` calls it.
- Sequencer logic: `SGridState` in `server/state.js` (especially `handleGridKey()` and `tick()`).

## Notes
- This file is intended to stay short and factual. Expand by adding focused subsections when you learn a new module or behavior.


## Git Workflow & Agent Isolation

### Branch Management

- Never implement new features, bug fixes, or significant refactoring directly on `main`.
- Create a dedicated Git branch for each independent task using the following naming conventions:
  - `feature/<short-description>` for features.
  - `fix/<short-description>` for bug fixes.
  - `refactor/<short-description>` for refactoring.
  - `chore/<short-description>` for maintenance.
- Check the current branch and working tree status before making changes.
- If already working on an appropriate task-specific branch, continue using it rather than creating another.
- Never discard, reset, overwrite, or clean up uncommitted changes without explicit permission.

### Worktree Isolation

- When multiple agents are working concurrently, each agent must use its own Git worktree and dedicated branch.
- Never allow multiple agents to modify the same working directory simultaneously.
- If operating in a worktree provided by Codex, use that worktree rather than creating another unnecessarily.
- Do not switch branches in a working directory shared with another agent.
- Do not remove worktrees or delete branches belonging to other agents.

### Task Execution

1. Inspect the repository status and existing branch before starting.
2. Create or use an appropriate feature branch or isolated worktree.
3. Implement only changes relevant to the assigned task.
4. Follow existing project conventions and architecture.
5. Run relevant tests, linting, and type checks where available.
6. Review the final diff for unintended changes.
7. Summarize the implementation, tests performed, and any outstanding issues.

### Merging & Safety

- Never merge changes into `main` without explicit user approval.
- Never force-push, rewrite shared history, or delete remote branches without permission.
- Do not automatically commit or push changes unless explicitly instructed.
- Keep changes small, focused, and independently reviewable.
- Prefer pull requests for integrating completed features.
- Resolve merge conflicts carefully rather than automatically accepting one side.
- Never overwrite another agent's work.

### Parallel Agent Coordination

- Assign each agent a clearly defined and independent scope.
- Avoid overlapping file modifications wherever possible.
- Identify dependencies between concurrent tasks before implementation.
- Coordinate changes to shared interfaces, database schemas, configuration, and infrastructure.
- Treat the main branch as the stable integration baseline.

### General Principle

Every independent feature should be developed in isolation, validated, reviewed, and only then integrated into the main codebase.

Use branches for logical isolation and worktrees for filesystem isolation when agents work concurrently. Do not create repository forks for routine feature development.

## Model Selection & Cost Optimization

### Core Principle

Always use the least expensive model capable of reliably completing a task.

Do not default to the most powerful model for routine operations. Optimize for cost, speed, and correctness, not maximum model capability.

### Task-Based Model Routing

**Lightweight tasks — use a cheap, fast model (prefer GPT-6 Luna when available):**
- Reading files and locating relevant code.
- Searching the codebase for functions, classes, or references.
- Summarizing documentation, logs, or existing implementations.
- Exploring directory structures and dependencies.
- Simple formatting, renaming, and repetitive edits.
- Gathering information for the main agent.
- Running predefined checks and reporting their results.

**Moderate tasks — use a balanced model and reasoning effort:**
- Implementing straightforward, well-defined features.
- Writing unit tests.
- Fixing isolated bugs with clear causes.
- Small refactoring tasks.
- Updating API integrations with established patterns.
- Reviewing routine code changes.

**Complex tasks — use a high-capability model:**
- Architectural design and major refactoring.
- Debugging complex or intermittent failures.
- Security-sensitive functionality.
- Database schema design and migrations.
- Cross-cutting changes involving multiple systems.
- Ambiguous tasks requiring substantial reasoning.
- Reviewing high-risk changes and resolving difficult integration issues.

### Subagent Delegation

- Prefer delegating independent, narrowly scoped tasks to cheaper subagents when doing so reduces overall cost.
- Explicitly select a cheaper model and lower reasoning effort for lightweight subagents whenever the Codex environment supports it.
- Do not automatically inherit the main agent's expensive model for simple delegated tasks.
- Provide subagents with specific objectives, relevant file paths, constraints, and expected outputs.
- Keep subagent context small. Avoid passing unnecessary files or conversation history.
- Use parallel subagents only when tasks are genuinely independent and parallelism provides a meaningful benefit.
- Avoid spawning agents for trivial tasks that can be completed more efficiently with a direct tool call or simple command.
- Prefer read-only exploration subagents when gathering information.

### Escalation Strategy

1. Start with the cheapest model reasonably capable of the task.
2. Validate the result against explicit requirements.
3. If the result is incomplete, incorrect, or the task proves more complex than expected, escalate to a stronger model.
4. Avoid repeatedly retrying an unsuitable cheap model.
5. Reserve the strongest model for tasks where its reasoning capability materially improves correctness.

### Main Agent Responsibilities

The main agent is responsible for:
- Planning and decomposing complex tasks.
- Selecting appropriate models for subagents.
- Coordinating parallel work and preventing conflicts.
- Integrating and reviewing subagent results.
- Verifying that the complete solution meets requirements.

The main agent should not personally perform large amounts of routine reading, searching, or summarization when a cheaper subagent can do the work more efficiently.

### Cost Awareness

- Minimize unnecessary model calls and repeated context processing.
- Reuse existing findings instead of independently rediscovering information.
- Prefer deterministic commands and tools over model-based reasoning when appropriate.
- Do not sacrifice correctness, security, or maintainability to reduce costs.
- When model selection is unavailable, respect the runtime limitations rather than claiming a cheaper model was used.

**Default behavior: cheap models for exploration and routine execution, stronger models for difficult reasoning, architectural decisions, and final verification.**