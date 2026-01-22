studio:grid — User Manual
========================

Thanks for trying out studio:grid!
Born from real problems whilst making music and embracing the worlds of both hardware and software.
Leave your gear bias at the door, focus on the music and have fun :)

Overview
--------
studio:grid is a grid-based multi-sequencer and composer for monome grids (or without). Each project (set) holds up to eight devices/pages, and every page contains eight patterns with lengths up to 128 steps. The app drives MIDI notes/CC, can follow internal or external clock, and exports/imports complete projects (.studiogrid, .sgridset) plus TD-3 .seq files.

It can be used with or without a grid controller.

Prerequisites
-------------
- Node.js 18+ installed. (dev)
- If you use a monome grid: serialosc running on the same machine.
- A WebMIDI-capable browser (Chrome/Chromium) or the bundled app. (dev)
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
- Devices are 'swappable' and will replace their respective column on the grid.

Editing the grid
----------------
- Press or click a button / cell to toggle a step
- Press or click active note to remove 
- Hold active note or hover over an active note to show ↑/↓ octave shifting options; applies to appropriate sequencer types only (mono, poly, mdtonal)
- Hold active note and release to activate accent or right-click an active step to open the note menu:
  - Accent toggle (where supported).
  - Slide toggle (mono/mdtonal). Slides shorten gates by the configured mono slide pad.
- Hold active note and press step to the right to activate slide on active note.
- Extended note (slide chain): while holding an active note long enough to enter note edit mode, press the last cell in a consecutive run of active notes on the same row to create a continuous chain (mono, poly, mdtonal only). The chain shows a subtle left-to-right wave and plays as one extended note. In Poly, chains are per-note (other notes on the same step are unaffected).
- Chain rules: removing any note inside a chain deletes the downstream notes; removing the first note deletes the whole chain; octave-shifting a chained note stops the chain and deletes following notes.
- Keyboard -  Shift + Arrow keys: nudge the current pattern left/right (steps) or up/down (rows).
- Pattern copy/paste: copy/paste entire pattern; copy/paste bar affects current 16-step bar.
- Clear: clears pattern immediately if empty; otherwise choose pattern vs current bar.
- Follow: when on, the bar view follows the playhead; turning it off lets you edit a fixed bar.
- Pattern scale: 1x/2x/4x multiplies playback speed of the current pattern without changing displayed steps.
- Pattern length: cycles preset lengths; server supports manual lengths to 128 steps (sent via UI cycle or API).
- Auto-fill new bars: when enabled, extending length duplicates earlier bars into new, empty bars.

Sequencer types
---------------
- Mono: single note per step; accent and slide available; octave per step.
- Poly: multiple notes per step; per-note accents; per-note octave switching; per-note slide chains
- Drum: seven rows map to per-row MIDI notes (editable in the drum note inputs).
- CC: each step stores a CC value; set CC number per page.
- MDTonal: Sequence Elektron Machinedrum tonal tracks with slide handling; select MD track per page. TM-1 is auto-picked unless “Allow non-TM-1 output” is enabled in Settings. Slide is done by basic interpolation. Also sends velocity!

Patterns, bars, and switching
-----------------------------
- Each device has eight patterns. Selecting a new pattern queues the change for end-of-pattern; pending patterns show with a dimmer LED/state. - potentially will change
- Bar view buttons (0–7) pick which 16-step chunk you edit; bar index is clamped to the current length.
- End-of-pattern switching is honored both in the UI and on hardware grid.

MIDI, clock, and transport
--------------------------
- Transport: play/stop in the top bar; hardware grid start/stop respected when using external clock.
- Clock source: Internal (app drives ticks) or External (expects incoming MIDI clock/start/stop). Select input in Settings when exposed.
- Send midi clock out.
- Tempo & swing: available in the top bar and Settings; swing 50=straight to 80=max. Click Tempo to switch to Swing.
- Base note length: choose 1/8, 1/16, or 1/32 to set tick resolution.
- MIDI per page: choose output device and channel; saved with the set and local config.
- WebMIDI: browser prompts for permission; enable it and choose outputs before sequencing.

Scale and transpose
-------------------
- Global scale: pick root note and mode (major, minor, dorian, mixolydian, lydian, phrygian, locrian, harmonic minor, melodic minor, whole tone, chromatic). Notes quantize to the selected scale degrees.
- Per-page transpose: ±2 octaves in semitone steps; applied after scale quantization.
- Octave overlays: hovering or holding a step shows current octave shift; edits mirror to the hardware grid overlay.

TD-3 import/export
------------------
- TD-3 button opens Import/Export choices.
- Export: choose Group/Pattern numbers; downloads `sgrid_td3_pattern.seq`.
- Import: choose a .seq file. If the current pattern has data, you’ll be asked to replace it. The app previews the scale; choose to fit to the current scale or switch the project scale to the detected one, then apply.

Saving, loading, and projects
-----------------------------
- Export project: top-bar download saves the full snapshot as `.studiogrid` (JSON) via /api/export.
- Import project: top-bar upload accepts `.json`, `.studiogrid`, or `.sgridset` and replaces the current state.
- Projects include musical data plus per-page MIDI routing; UI/config settings (LED levels, clock, base note length, gate length, mono slide pad, pattern-control latch) are saved separately in config.
- New project: clears all patterns; optional “Keep device names” and “Keep MIDI settings”; default device color can be preserved.
- Auto-load last project: toggle in Settings to reload the previous snapshot on startup.
- Config save/restore: Settings → Save config writes LED levels, clock mode, MIDI selections, UI scale, default colors, and toggles to localStorage; Restore defaults clears localStorage and reverts to factory defaults.
- Seamless import allows set switching whilst sequencer continues.

Hardware grid specifics
-----------------------
- Uses serialosc discovery.
- Grid key presses mirror mouse clicks; queued pattern changes and playheads display on the device.
- Pattern-control latch (Settings): keeps the pattern-launch view active after releasing the pattern control button on the grid.
- “Clear LEDs” endpoint is called on quit; a separate button is available via the WebSocket API if needed.

Appearance and usability
------------------------
- UI scale: 1.0/1.25/1.5 (resizes the window where permitted). Default : 1.5
- LED levels: set brightness per role (steps, accent, playhead, pattern active/pending/inactive, device present/active).
- Device colors: choose per device; set a global default color palette; MDTonal pages auto-tint to the accent color unless overridden.
- Log panel: optional text log for serialosc/MIDI messages. - to be removed

Keyboard and mouse shortcuts
----------------------------
- Shift + Arrow keys: shift the current pattern’s content.
- Hover + ↑/↓ popup: nudge step octave.
- Right-click step: open accent/slide context menu.
- Right-click device tab :  open device menu (rename/color).
- Cmd/Ctrl + ArrowUp / Cmd/Ctrl + ArrowDown: adjust transpose up/down
- Click + Drag device changes column order

Troubleshooting
---------------
- No grid LEDs or input: confirm serialosc is running; replug the grid; the bridge will rediscover every few seconds.
- No MIDI: confirm WebMIDI permission, select an output per page, and verify OS-level MIDI routing. MDTonal locks to TM-1 unless “Allow non-TM-1 output” is enabled.
- External clock not advancing: ensure clock source is set to External and a valid input is selected; the app ignores UI start/stop when external clock is active.
- Browser reload lost patterns: export projects regularly or enable “Auto-load last project.” (Don't worry - this is unlikely!)

API endpoints
-------------
- `GET /api/export` → downloads the current project as `.studiogrid`.
- `GET /api/export-td3?group=G&pattern=P` → downloads TD-3 `.seq`.

Data files
----------
- Projects: `.studiogrid` (export/import), `.sgridset` (legacy import/export).
- TD-3: `.seq` files for import/export to/from SynthTribe

Extras & caveats
----------------
- Program-change filtering: outgoing program changes are filtered; the server side handles this automatically (no UI control). - to be removed
- Device notes: an optional per-device notes field exists in the toolbar; it may be hidden in the current layout but loads/saves with the set when used. - to be removed
