studio:grid — User Manual
========================

Overview
--------
studio:grid is a grid-based pattern sequencer for monome grids and the built-in on-screen grid. Each project holds up to eight devices/pages, and every page contains eight patterns with lengths up to 128 steps. The app can run in a browser (localhost) or as an Electron wrapper, drives MIDI notes/CC, can follow internal or external clock, and exports/imports complete sets (.sgridset) plus TD-3 .seq files.

Prerequisites
-------------
- Node.js 18+ installed.
- If you use a monome grid: serialosc running on the same machine.
- A WebMIDI-capable browser (Chrome/Chromium) or the bundled Electron app.
- MIDI destinations visible to the OS; Elektron TM-1 is auto-selected for MDTonal unless overridden.

Starting the app
----------------
- Development/local web: `npm start` (serves public/ at http://localhost:3000).
- Electron shell: `npm run electron` (auto-finds a free port, opens the UI, and cleans up LEDs on quit).
- Build installers: `npm run dist`.
- The WebSocket/UI connects automatically to the local server; if the grid is attached, LEDs sync through serialosc.

Interface tour
--------------
- Top bar: transport play/stop, New Set, Import, Export, Settings.
- Device tabs: eight pages (1–8). Tabs show device color/name; right-click for rename and color.
- Device toolbar: sequencer type (Mono, Poly, Drum, MDTonal, CC), transpose ±2 oct, per-page MIDI out + channel, optional MD track/CC number fields, TD-3 actions.
- Grid canvas: 16 columns x 8 rows. Rows 0–6 are steps; bottom row holds pattern/device indicators. Works with mouse or hardware grid.
- Pattern toolbar: pattern selector (1–8), copy/paste bar or pattern, clear bar/pattern, length toggle (cycles 16/32/64; server supports up to 128), time-scale toggle (1x/2x/4x), bar view buttons, Follow toggle.
- Settings modal: tempo, swing, UI scale, scale root/mode, clock source/input, base note length, LED levels, auto-fill new bars, auto-load last set, pattern-control latch, MD slide/base sweep, mono slide pad, default device color, allow MD external, log visibility, save/restore config.

Editing the grid
----------------
- Click a cell to toggle a step. Mouse taps send press+release so clicks only toggle notes.
- Hover an active step to show ↑/↓ octave buttons; applies per-step octave shift (mono/mdtonal) or per-note octave in poly mode.
- Right-click an active step to open the note menu:
  - Accent toggle (where supported).
  - Slide toggle (mono/mdtonal). Slides shorten gates by the configured mono slide pad.
- Shift + Arrow keys: nudge the current pattern left/right (steps) or up/down (rows).
- Pattern copy/paste: copy/paste entire pattern; copy/paste bar affects current 16-step bar.
- Clear: clears pattern immediately if empty; otherwise choose pattern vs current bar.
- Follow: when on, the bar view follows the playhead; turning it off lets you edit a fixed bar.
- Pattern scale: 1x/2x/4x multiplies playback speed of the current pattern without changing displayed steps.
- Pattern length: cycles preset lengths; server supports manual lengths to 128 steps (sent via UI cycle or API).
- Auto-fill new bars: when enabled, extending length duplicates earlier bars into new, empty bars.

Sequencer types
---------------
- Mono: single note per step; accent and slide available; octave per step.
- Poly: multiple notes per step; per-note accents; per-note octave (hover ↑/↓ after selecting).
- Drum: seven rows map to per-row MIDI notes (editable in the drum note inputs).
- CC: each step stores a CC value; set CC number per page.
- MDTonal: Elektron Machinedrum tonal tracks with slide handling; select MD track per page. TM-1 is auto-picked unless “Allow non-TM-1 output” is enabled in Settings. Slide is done by basic interpolation. Also sends velocity

Patterns, bars, and switching
-----------------------------
- Each page has eight patterns. Selecting a new pattern queues the change for end-of-pattern; pending patterns show with a dimmer LED/state.
- Bar view buttons (0–7) pick which 16-step chunk you edit; bar index is clamped to the current length.
- End-of-pattern switching is honored both in the UI and on hardware grid.

MIDI, clock, and transport
--------------------------
- Transport: play/stop in the top bar; hardware grid start/stop respected when using external clock.
- Clock source: Internal (app drives ticks) or External (expects incoming MIDI clock/start/stop). Select input in Settings when exposed.
- Tempo & swing: available in the top bar and Settings; swing 50=straight to 80=max.
- Base note length: choose 1/8, 1/16, or 1/32 to set tick resolution.
- MIDI per page: choose output device and channel; saved with the set and local config.
- WebMIDI: browser prompts for permission; enable it and choose outputs before sequencing.

Scale and transpose
-------------------
- Global scale: pick root (C–B) and mode (major, minor, dorian, mixolydian, lydian, phrygian, locrian, harmonic minor, melodic minor, whole tone, chromatic). Notes quantize to the selected scale degrees.
- Per-page transpose: ±2 octaves in semitone steps; applied after scale quantization.
- Octave overlays: hovering or holding a step shows current octave shift; edits mirror to the hardware grid overlay.

TD-3 import/export
------------------
- TD-3 button opens Import/Export choices.
- Export: choose Group/Pattern numbers; downloads `td3_pattern.seq`.
- Import: choose a .seq file. If the current pattern has data, you’ll be asked to replace it. The app previews the scale; choose to fit to the current scale or switch the project scale to the detected one, then apply.

Saving, loading, and sets
-------------------------
- Export set: top-bar download saves the full snapshot as `.sgridset` (JSON) via /api/export.
- Import set: top-bar upload accepts `.json` or `.sgridset` and replaces the current state.
- New set: clears all patterns; optional “Keep device names” and “Keep MIDI settings”; default device color can be preserved.
- Auto-load last set: toggle in Settings to reload the previous snapshot on startup.
- Config save/restore: Settings → Save config writes LED levels, clock mode, MIDI selections, UI scale, default colors, and toggles to localStorage; Restore defaults clears localStorage and reverts to factory defaults.

Hardware grid specifics
-----------------------
- Uses serialosc discovery; LEDs are throttled and diffed to avoid flooding.
- Grid key presses mirror mouse clicks; queued pattern changes and playheads display on the device.
- Pattern-control latch (Settings): keeps the pattern-launch view active after releasing the pattern control button on the grid.
- “Clear LEDs” endpoint is called on quit in Electron; a separate button is available via the WebSocket API if needed.

Appearance and usability
------------------------
- UI scale: 1.0/1.25/1.5 (resizes the Electron window where permitted).
- LED levels: set brightness per role (steps, micro, accent, playhead, pattern active/pending/inactive, device present/active).
- Device colors: choose per device; set a global default color palette; MDTonal pages auto-tint to the accent color unless overridden.
- Log panel: optional text log for serialosc/MIDI messages.

Keyboard and mouse shortcuts
----------------------------
- Shift + Arrow keys: shift the current pattern’s content.
- Hover + ↑/↓ popup: nudge step octave.
- Right-click step: open accent/slide context menu.
- Clicking a tab with right-click: open device menu (rename/color).

Troubleshooting
---------------
- No grid LEDs or input: confirm serialosc is running; replug the grid; the bridge will rediscover every few seconds.
- No MIDI: confirm WebMIDI permission, select an output per page, and verify OS-level MIDI routing. MDTonal locks to TM-1 unless “Allow non-TM-1 output” is enabled.
- External clock not advancing: ensure clock source is set to External and a valid input is selected; the app ignores UI start/stop when external clock is active.
- Browser reload lost patterns: export sets regularly or enable “Auto-load last set.”

API endpoints
-------------
- `GET /api/export` → downloads the current set as `.sgridset`.
- `GET /api/export-td3?group=G&pattern=P` → downloads TD-3 `.seq`.

Data files
----------
- Sets: `.sgridset` JSON snapshots (export/import).
- TD-3: `.seq` files for import/export.

Extras & caveats
----------------
- Program-change filtering: outgoing program changes are filtered; the server side handles this automatically (no UI control).
- Device notes: an optional per-device notes field exists in the toolbar; it may be hidden in the current layout but loads/saves with the set when used.
- TD-3 slide accuracy: exporting TD-3 patterns works for editing and playback, but slide timing may differ slightly on real 303/TB-3 hardware.
