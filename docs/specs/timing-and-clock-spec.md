You are modifying an existing monome-based multi-sequencer app with a Node server (index.js) and a browser/Electron renderer (main.js). Implement a clock/timing refactor to remove ambiguity and improve MIDI timing stability.

NON-NEGOTIABLE CONSTRAINTS
1) 1/16 grid only. One step = 1/16 note.
2) TD-3 slide behavior must remain EXACTLY as current. Do not redesign it. Do not reinterpret it. Extract it into a module if needed but do not change logic.
3) Monome LED handling is tight and must not be refactored. Treat the existing LED pipeline as read-only. Do not unify LED timing with MIDI timing.
4) Server remains the single source of musical truth (transport state, tick/step position, pattern evaluation, playheads, event generation).
5) Renderer owns real-time MIDI scheduling (AudioContext-based lookahead + WebMIDI timestamps). Server must not “send MIDI now” over WebSocket.

GOAL
- Make MIDI output timing stable by scheduling MIDI in renderer using AudioContext time.
- Keep sequencer logic and TD-3 slide semantics on server.
- Keep monome LED pipeline on server unchanged.
- External MIDI clock input enters via renderer WebMIDI and is forwarded to server to drive musical ticks/transport.

IMPLEMENTATION STEPS (DO THESE IN ORDER)

STEP 0 — Inventory and freeze protected code
- Identify the existing TD-3 slide execution code path used during playback (not just export). Mark it as protected.
- Identify monome LED frame generation + serialosc output path. Mark it as protected.
- Add comments: “DO NOT CHANGE LOGIC” around these sections.

STEP 1 — Add golden-master tests for TD-3 slide playback behavior
- Create a test harness that:
  a) loads representative TD-3 .seq fixtures already supported by the app (use existing import path),
  b) runs the sequencer for N steps (e.g. 64 or 128),
  c) captures emitted musical events per tick (tick index, step index, message type, note, velocity, channel, ordering).
- Save these outputs as JSON fixtures.
- Ensure tests fail if event streams differ (per tick, per ordering). This locks slide behavior.
- IMPORTANT: Compare by musical time (tick indices), not wall-clock timestamps.

STEP 2 — Define explicit transport + tick model on server
- Create/introduce a TransportState structure on server:
  - running: boolean
  - mode: 'INTERNAL' | 'EXTERNAL_MIDI'
  - bpm: number (authoritative only in INTERNAL)
  - tick: number (absolute tick since Start)
  - step: derived = floor(tick / 6)
- Constants:
  - PPQN = 24
  - TICKS_PER_STEP = 6
- Step boundary condition: tick % 6 == 0

STEP 3 — Change server “event generation” to output logical musical events (not real-time MIDI sends)
- Refactor so server produces “musical events” keyed to tick indices:
  - note_on / note_off / cc
  - includes channel, note, velocity, cc/value
  - includes existing flags (accent, td3Slide) but DO NOT reinterpret them
- Server must NOT schedule timestamps and must NOT attempt tight timing based on setInterval for MIDI output.
- Server continues generating monome LED frames exactly as before (no changes).

STEP 4 — Implement a renderer scheduling engine (pure MIDI)
- Implement a lookahead scheduler:
  - interval ~ 15ms
  - lookahead window ~ 150ms
- Use a monotonic timebase:
  - default: performance.now() (ms)
  - optional: AudioContext.currentTime (sec) ONLY if available and already running; do not require it.
- Maintain mapping from tick -> targetTime (in the chosen timebase).
- Use WebMIDI output.send(data, timestampMs) when available; otherwise send as close to target time as possible.


STEP 5 — Define and implement WebSocket message schema for timing and events
- Add server -> renderer message:
  - type: 'events'
  - for a range of upcoming ticks or steps (preferred), e.g. include events for ticks [T..T+K]
  - payload: ordered array of MusicalEvent objects including tick index
- Add renderer -> server messages for clock/transport:
  - type: 'transport'
  - subtypes: start, stop, continue, spp(optional)
  - include current tick (and/or step) when relevant
  - type: 'clockTicks' for external: send tick increments (or batches) with monotonically increasing tick index
- Keep other existing state sync messages intact.

STEP 6 — INTERNAL mode behavior (app as master)
- Renderer is the real-time clock:
  - Compute tick period: tickPeriodSec = 60 / (bpm * 24)
  - Determine tick times deterministically from a start time anchor
  - Advance ticks locally and schedule MIDI output
- Renderer must periodically inform server of tick position:
  - at least once per step (tick multiple of 6), or once per beat is acceptable if server can interpolate by tick index; but prefer per-step for tight LED/playhead sync.
- Server updates its authoritative tick to the renderer-reported tick and runs pattern evaluation for steps (tick%6==0).
- Server sends upcoming musical events ahead (lookahead) to renderer for scheduling.

STEP 7 — EXTERNAL MIDI mode behavior (app as slave)
- Renderer receives WebMIDI realtime:
  - 0xFA Start => immediately send “transport start” to server; reset local tick to 0
  - 0xFC Stop => send stop; flush notes
  - 0xFB Continue => send continue
  - 0xF8 Clock => increment local tick; forward tick index to server (can batch small groups but must preserve ordering)
  - 0xF2 SPP (optional): convert SPP units (1/16 notes) to tick = spp * 6; forward to server
- Renderer schedules MIDI output aligned to received tick arrival times (low-latency).
- Server uses forwarded ticks as the authoritative tick progression and evaluates steps at tick%6==0.
- Server sends musical events ahead when possible; renderer schedules them against tick times derived from incoming clock.

STEP 8 — Panic / stuck note prevention
- Renderer maintains an “active notes” registry per MIDI output/channel.
- On:
  - stop,
  - clock source switch,
  - WS reconnect,
  - MIDI port change,
  send:
  - note_off for all active notes, plus optionally CC 123 and CC 120 per channel.
- Server should also reset playheads appropriately on transport changes, but DO NOT change LED pipeline logic.

STEP 9 — Clock source switching must be explicit
- Add/ensure explicit UI/config choice: INTERNAL vs EXTERNAL_MIDI
- No auto-detection.
- Switching stops transport + triggers panic.

STEP 10 — Regression verification
- Run TD-3 golden-master tests; must pass exactly.
- Verify monome LEDs behave exactly as before:
  - same update rate feel
  - same playhead rendering
  - no added latency
- Verify MIDI timing improved:
  - internal: stable BPM, less jitter
  - external: follows incoming clock reliably, correct start/stop/continue

DELIVERABLES
- Renderer: AudioContext-based Scheduler module; WebMIDI IO wrapper that supports timestamp sending.
- Server: TransportState + logical event generation; TD-3 slide kernel extracted (logic unchanged); no refactor of monome LED code.
- Tests: TD-3 golden master event stream fixtures.

DO NOT DO
- Do not rewrite TD-3 slide semantics.
- Do not refactor monome LED generation/serialosc pipeline.
- Do not make server send raw MIDI bytes “now” via WebSocket.
- Do not introduce non-1/16 divisions.
- Resepect current behaviours found in the app (e.g per device sequencer start-stop).
