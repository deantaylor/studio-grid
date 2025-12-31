import http from "http";
import { readFile, stat } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import { performance } from "perf_hooks";
import { SerialOSCBridge } from "./serialosc-bridge.js";
import { buildTd3Seq, parseTd3SeqBuffer, detectScale, importTd3Pattern } from "./td3.js";
import { MGridState } from "./state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/api/export") {
    const payload = buildExportPayload();
    const json = JSON.stringify(payload, null, 2);
    res.writeHead(200, { "Content-Type": "application/x-sgridset" });
    res.end(json);
    return;
  }
  if (url.pathname === "/api/export-td3") {
    try {
      const tdGroup = Number(url.searchParams.get("group"));
      const tdPattern = Number(url.searchParams.get("pattern"));
      const opts = {};
      if (Number.isFinite(tdGroup)) opts.tdGroup = tdGroup;
      if (Number.isFinite(tdPattern)) opts.tdPattern = tdPattern;
      const { buffer } = await buildTd3Seq(state, opts);
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": 'attachment; filename="td3_pattern.seq"'
      });
      res.end(buffer);
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message || String(e) }));
    }
    return;
  }
  let pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.join(PUBLIC_DIR, pathname);

  try {
    const st = await stat(filePath);
    if (st.isDirectory()) {
      res.writeHead(403);
      res.end();
      return;
    }
    const data = await readFile(filePath);
    const contentType = guessContentType(pathname);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  } catch (e) {
    res.writeHead(404);
    res.end("not found");
  }
});

const wss = new WebSocketServer({ server });
const serial = new SerialOSCBridge({ prefix: "mgrid" });
const state = new MGridState();
state.requestRender = () => renderAndPush(true);
let clockTimer = null;
let clockMode = "stopped"; // "internal" | "stopped" | "external"
let clockSource = "external"; // default to external clock
let clockInputId = "IAC Driver Bus 2"; // preferred default
let manualRunning = false; // user start/stop button
let midiListeners = new Set(); // track ws subscribed to midi messages
let lastBroadcastPage = state.currentPage;
let followEnabled = false;
let autoFillBars = true;
let gridConnected = false;
let clockOutEnabled = false;
let clockOutDevice = ""; // MIDI clock out target (id/name hint)
let nextInternalTickTime = null;
// external clock smoothing (median over recent intervals)
let extClockIntervals = [];
let lastExtPulseTs = 0;
let extStepMs = null;
// LED throttling to avoid flooding monome / browser
const LED_MIN_INTERVAL = 40; // ~25fps
const SLIDE_ANIM_INTERVAL = LED_MIN_INTERVAL; // reuse LED cadence for slide animation
let pendingLedFrame = null;
let ledTimer = null;
let lastLedSend = 0;
let lastRenderedFrame = null;
let ledPaused = false;
let slideAnimTimer = null;

function patternControllerDevices() {
  const devices = typeof serial.deviceList === "function" ? serial.deviceList() : [];
  const primaryId = serial.getPrimaryDevice?.()?.id;
  return devices.filter((d) => d.connected && d.cols <= 8 && d.rows <= 8 && d.id !== primaryId);
}

function hasPatternControllers() {
  return patternControllerDevices().length > 0;
}

function cropFrame(frame, cols, rows, sourceWidth = 16) {
  if (!frame) return null;
  const out = new Array(Math.max(0, cols * rows)).fill(0);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const srcIdx = y * sourceWidth + x;
      const dstIdx = y * cols + x;
      out[dstIdx] = frame[srcIdx] || 0;
    }
  }
  return out;
}

function resetLedBuffers() {
  if (serial?.devices) {
    serial.devices.forEach((dev) => {
      if (!dev) return;
      dev.backBuffer = null;
      dev.frontBuffer = null;
      dev.lastFrame = null;
    });
  }
}

function median(values) {
  if (!Array.isArray(values) || !values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function recordExternalPulse(nowMs) {
  if (lastExtPulseTs) {
    const delta = nowMs - lastExtPulseTs;
    const recent = extClockIntervals.slice(-4);
    const baseline = median(recent) || delta;
    const maxDev = baseline * 0.25; // drop >25% outliers for gate timing
    if (Math.abs(delta - baseline) <= maxDev) {
      extClockIntervals.push(delta);
      if (extClockIntervals.length > 12) extClockIntervals.shift();
      const smooth = median(extClockIntervals.slice(-4));
      if (smooth && Number.isFinite(smooth)) {
        extStepMs = smooth;
      }
    }
  }
  lastExtPulseTs = nowMs;
}

function resetExternalClockStats() {
  extClockIntervals = [];
  lastExtPulseTs = 0;
  extStepMs = null;
}

function buildExportPayload() {
  const snap = state.snapshot();
  return {
    ...snap,
    clockSource,
    clockInput: clockInputId,
    clockOut: clockOutEnabled,
    clockOutDevice,
    follow: followEnabled,
    autoFill: autoFillBars
  };
}

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "hello", message: "mgrid web" }));
  broadcastState(ws);

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      handleClientMessage(ws, data);
    } catch (e) {
      console.error("ws parse error", e);
      ws.send(JSON.stringify({ type: "error", message: e.message || String(e) }));
    }
  });
});

serial.on("grid_key", (evt) => {
  const primaryId = serial.getPrimaryDevice?.()?.id;
  const dev = serial.devices?.get?.(evt.deviceId) || null;
  const cols = evt.cols || dev?.gridCols || 16;
  const rows = evt.rows || dev?.gridRows || 8;
  const supportsLevels = evt.supportsLevels ?? dev?.supportsLevels ?? true;
  const forcePatternControl = (!supportsLevels) || ((cols <= 8 && rows <= 8) && evt.deviceId !== primaryId);
  const resp = state.handleGridKey(evt.x, evt.y, evt.s, { forcePatternControl });
  const events = Array.isArray(resp) ? resp : (resp ? [resp] : []);
  // When a held note is entered from the monome, show the octave arrows in the UI
  if (evt.s === 1) {
    const info = state.getStepInfo(evt.x, evt.y);
    if (info?.on && info.seqType !== "drum" && info.seqType !== "cc") {
      events.push({
        type: "octave_overlay",
        page: state.currentPage,
        x: evt.x,
        y: evt.y,
        octave: info.octave || 0,
        delta: 0,
        fromHold: true
      });
    }
  }
  events.forEach((ev) => {
    if (ev.type === "octave") {
      broadcast({ type: "octave_overlay", page: state.currentPage, ...ev });
    } else if (ev.type === "accent") {
      broadcast({ type: "accent_overlay", page: state.currentPage, ...ev });
    } else if (ev.type === "slide") {
      broadcast({ type: "slide_overlay", page: state.currentPage, ...ev });
    } else if (ev.type === "bar_view") {
      broadcast({ type: "bar_view", page: ev.page, pattern: ev.pattern, bar: ev.bar });
    } else if (ev.type === "pattern_status") {
      broadcastPatternStatus(ev.page || state.currentPage);
    }
  });
  renderAndPush();
});
serial.on("log", (msg) => {
  console.log(msg);
  broadcast({ type: "log", message: msg });
});
serial.on("error", (err) => {
  console.error(err);
  broadcast({ type: "error", message: err.message || String(err) });
});
serial.on("grid_status", (payload) => {
  const connected = !!(payload && payload.connected);
  gridConnected = connected;
  broadcast({ type: "grid_status", connected, devices: payload?.devices || [] });
  renderAndPush(true);
});

serial.on("device_ready", (info) => {
  // Force a full redraw on the specific device and broadcast fresh state
  broadcast({ type: "grid_status", connected: true, devices: serial.deviceList?.() || [] });
  renderAndPush(true);
  if (info?.id) {
    serial.fullResync?.({ deviceId: info.id });
  } else {
    serial.fullResync?.();
  }
});

function broadcastState(ws = null) {
  const transposes = state.pages.map((p, idx) => (idx === 0 ? null : (p?.transpose || 0)));
  const names = state.deviceNames || state.pages.map((p, idx) => (idx === 0 ? null : p?.name || `Device ${idx}`));
  const notes = state.deviceNotes || state.pages.map((p, idx) => (idx === 0 ? null : p?.note || ""));
  const colors = state.deviceColors || state.pages.map((p, idx) => (idx === 0 ? null : p?.color || "#ffb703"));
  const sequencerTypes = state.pages.map((p, idx) => (idx === 0 ? null : p?.sequencerType || "mono"));
  const activePatterns = state.pages.map((p, idx) => (idx === 0 ? null : p?.active_pattern || 1));
  const pendingPatterns = state.pages.map((p, idx) => (idx === 0 ? null : p?.pending_pattern || null));
  const drumNotes = state.pages.map((p, idx) => (idx === 0 ? null : p?.drumNotes || null));
  const ccNumbers = state.pages.map((p, idx) => (idx === 0 ? null : (p?.ccNumber ?? 1)));
  const mdTracks = state.pages.map((p, idx) => (idx === 0 ? null : (p?.mdTrack || 1)));
  const patternLengths = state.pages.map((p, idx) => {
    if (idx === 0 || !p) return null;
    return p.patterns.map((pat, pi) => (pi === 0 || !pat ? null : pat.length_steps || 16));
  });
  const patternTimeScales = state.pages.map((p, idx) => {
    if (idx === 0 || !p) return null;
    return p.patterns.map((pat, pi) => (pi === 0 || !pat ? null : pat.time_scale || 1));
  });
  const octaveOverlays = state.octaveOverlaySnapshot();
  const barPlayheads = state.pages.map((p, idx) => {
    if (idx === 0 || !p) return null;
    const pat = p.patterns?.[p.active_pattern];
    if (!pat || p.sequencerStopped) return null;
    const len = Math.max(1, pat.length_steps || 16);
    const bars = Math.max(1, Math.ceil(len / 16));
    const pos = (state.playheads?.[idx] ?? 0) % len;
    return Math.min(bars - 1, Math.floor(pos / 16));
  });
  const barViews = state.pages.map((p, idx) => {
    if (idx === 0 || !p) return null;
    return p.patterns.map((pat, pi) => (pi === 0 || !pat ? null : pat.barView || 0));
  });
  const msg = JSON.stringify({
    type: "state",
    tempo: state.tempo,
    swing: state.swing,
    baseDivision: state.baseDivision,
    midi: state.midi,
    currentPage: state.currentPage,
    scale: state.scale,
    transposes,
    names,
    notes,
    colors,
    sequencerTypes,
    drumNotes,
    ccNumbers,
    clockSource,
    clockInput: clockInputId,
    clockOut: clockOutEnabled,
    clockOutDevice,
    ledLevels: state.ledLevels,
    activePatterns,
    pendingPatterns,
    patternLengths,
    patternTimeScales,
    barViews,
    barPlayheads,
    mdTracks,
    octaveOverlays,
    follow: followEnabled,
    autoFill: autoFillBars,
    monoSlidePad: state.monoSlidePad,
    patternControlLatch: state.patternControlLatch,
    gridConnected
  });
  if (ws) {
    ws.send(msg);
    return;
  }
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) client.send(msg);
  });
}

function handleClientMessage(ws, data) {
  if (!data || typeof data !== "object") return;
  switch (data.type) {
    case "led_frame":
      serial.sendLEDFrame(data.frame);
      break;
    case "grid_key":
      {
        const resp = state.handleGridKey(data.x, data.y, data.s);
        const events = Array.isArray(resp) ? resp : (resp ? [resp] : []);
        events.forEach((ev) => {
          if (ev.type === "octave") {
            broadcast({ type: "octave_overlay", page: state.currentPage, ...ev });
          } else if (ev.type === "accent") {
            broadcast({ type: "accent_overlay", page: state.currentPage, ...ev });
          } else if (ev.type === "slide") {
            broadcast({ type: "slide_overlay", page: state.currentPage, ...ev });
          } else if (ev.type === "bar_view") {
            followEnabled = false;
            broadcast({ type: "follow", enabled: followEnabled });
            broadcast({ type: "bar_view", page: ev.page, pattern: ev.pattern, bar: ev.bar });
          } else if (ev.type === "pattern_status") {
            broadcastPatternStatus(ev.page || state.currentPage);
          }
        });
      }
      maybeBroadcastPage();
      renderAndPush();
      break;
    case "get_step_state":
      {
        const info = state.getStepInfo(data.x, data.y);
        ws.send(JSON.stringify({ type: "step_state", page: state.currentPage, x: data.x, y: data.y, ...info }));
      }
      break;
    case "set_step_accent":
      {
        const res = state.setStepAccent(data.x, data.y, data.accent);
        if (res) {
          broadcast({ type: "accent_overlay", page: state.currentPage, x: data.x, y: data.y, accent: res.accent });
          renderAndPush();
        }
      }
      break;
    case "set_step_slide":
      {
        const res = state.setStepSlide(data.x, data.y, data.slide);
        if (res) {
          broadcast({ type: "slide_overlay", page: state.currentPage, x: data.x, y: data.y, slide: res.slide });
          renderAndPush();
        }
      }
      break;
    case "set_step_octave":
      {
        const res = state.setStepOctave(data.x, data.y, data.delta);
        if (res) {
          broadcast({ type: "octave_overlay", page: state.currentPage, x: data.x, y: data.y, octave: res.octave, delta: res.delta });
          renderAndPush();
        }
      }
      break;
    case "set_base_division":
      {
        state.setBaseDivision(data.division);
        broadcast({ type: "base_division", division: state.baseDivision });
        restartClock();
      }
      break;
    case "set_pattern_control_latch":
      state.patternControlLatch = !!data.enabled;
      broadcast({ type: "pattern_control_latch", enabled: state.patternControlLatch });
      break;
    case "tempo":
      state.setTempo(data.bpm);
      broadcastTempo();
      restartClock();
      break;
    case "set_scale":
      state.setScale(data.root, data.mode);
      broadcast({ type: "scale", scale: state.scale });
      break;
    case "set_swing":
      state.setSwing(data.swing);
      broadcast({ type: "swing", swing: state.swing });
      restartClock();
      break;
    case "set_transpose":
      state.setTranspose(data.page, data.transpose);
      broadcast({ type: "transpose", page: data.page, transpose: state.pages[data.page]?.transpose || 0 });
      break;
    case "set_device_name":
      state.setDeviceName(data.page, data.name);
      broadcast({ type: "device_name", page: data.page, name: state.deviceNames[data.page] });
      break;
    case "set_device_note":
      state.setDeviceNote(data.page, data.note);
      broadcast({ type: "device_note", page: data.page, note: state.deviceNotes[data.page] });
      break;
    case "set_device_color":
      state.setDeviceColor(data.page, data.color);
      broadcast({ type: "device_color", page: data.page, color: state.deviceColors[data.page] });
      break;
    case "set_page":
      if (state.setPage(data.page)) {
        maybeBroadcastPage();
        renderAndPush();
      }
      break;
    case "set_pattern":
      state.setPattern(data.pattern);
      broadcastPatternStatus(state.currentPage);
      renderAndPush();
      break;
    case "set_pattern_length":
      state.setPatternLength(
        state.currentPage,
        data.pattern || state.pages[state.currentPage]?.active_pattern || 1,
        data.length,
        { autoFill: autoFillBars }
      );
      broadcastPatternLength(state.currentPage, data.pattern || state.pages[state.currentPage]?.active_pattern || 1);
      renderAndPush();
      break;
    case "set_pattern_time_scale":
      state.setPatternTimeScale(
        state.currentPage,
        data.pattern || state.pages[state.currentPage]?.active_pattern || 1,
        data.scale
      );
      broadcastPatternTimeScale(state.currentPage, data.pattern || state.pages[state.currentPage]?.active_pattern || 1);
      renderAndPush();
      break;
    case "set_bar_view":
      state.setBarView(state.currentPage, data.pattern || state.pages[state.currentPage]?.active_pattern || 1, data.bar || 0);
      broadcastBarView(state.currentPage, data.pattern || state.pages[state.currentPage]?.active_pattern || 1);
      renderAndPush();
      break;
    case "set_follow":
      followEnabled = !!data.enabled;
      broadcast({ type: "follow", enabled: followEnabled });
      renderAndPush();
      break;
    case "set_auto_fill":
      autoFillBars = !!data.enabled;
      broadcast({ type: "auto_fill", enabled: autoFillBars });
      break;
    case "copy_pattern": {
      const pat = state.patternSnapshot(state.currentPage, state.pages[state.currentPage]?.active_pattern || 1);
      if (pat) ws.send(JSON.stringify({ type: "copy_pattern", data: pat }));
      break;
    }
    case "copy_bar": {
      const patIdx = state.pages[state.currentPage]?.active_pattern || 1;
      const bar = data.bar || 0;
      const barSnap = state.barSnapshot(state.currentPage, patIdx, bar);
      if (barSnap) ws.send(JSON.stringify({ type: "copy_bar", data: barSnap }));
      break;
    }
    case "paste_pattern":
      state.applyPatternSnapshot(state.currentPage, state.pages[state.currentPage]?.active_pattern || 1, data.data || data.pattern);
      renderAndPush();
      break;
    case "paste_bar": {
      const patIdx = state.pages[state.currentPage]?.active_pattern || 1;
      state.applyBarSnapshot(state.currentPage, patIdx, data.bar || 0, data.data || data.barData);
      renderAndPush();
      break;
    }
    case "clear_pattern":
      state.clearPattern(state.currentPage, state.pages[state.currentPage]?.active_pattern || 1);
      renderAndPush();
      break;
    case "clear_bar": {
      const patIdx = state.pages[state.currentPage]?.active_pattern || 1;
      state.clearBar(state.currentPage, patIdx, data.bar || 0);
      renderAndPush();
      break;
    }
    case "shift_pattern": {
      const page = data.page || state.currentPage;
      const patIdx = data.pattern || state.pages[page]?.active_pattern || 1;
      const dx = Number.isFinite(Number(data.dx)) ? Number(data.dx) : 0;
      const dy = Number.isFinite(Number(data.dy)) ? Number(data.dy) : 0;
      if (state.shiftPattern(page, patIdx, { dx, dy })) {
        renderAndPush();
      }
      break;
    }
    case "set_midi":
      state.setMidiConfig(data.page, { outId: data.outId, channel: data.channel });
      broadcast({ type: "midi_config", page: data.page, cfg: state.midi[data.page] });
      break;
    case "set_md_slide_factor":
      state.setMDSlideFactor(data.value);
      break;
    case "set_md_slide_params":
      state.setMDSlideParams({ factor: data.factor, curve: data.curve, baseMs: data.baseMs });
      break;
    case "set_mono_slide_pad":
      state.setMonoSlidePad(data.value);
      broadcast({ type: "mono_slide_pad", value: state.monoSlidePad });
      break;
    case "set_drum_note":
      state.setDrumNote(data.page || state.currentPage, data.row, data.note);
      broadcastState();
      renderAndPush();
      break;
    case "set_seq_type": {
      const seq = data.seqType || data.type;
      const page = Number(data.page) || state.currentPage;
      if (page >= 1 && page <= 8 && (seq === "mono" || seq === "poly" || seq === "drum" || seq === "cc" || seq === "mdtonal")) {
        state.setSequencerType(page, seq);
        broadcast({ type: "seq_type", page, seqType: seq });
      }
      break;
    }
    case "set_cc_number":
      state.setCCNumber(data.page || state.currentPage, data.cc);
      broadcastState();
      break;
    case "set_md_track": {
      const page = data.page || state.currentPage;
      state.setMDTrack(page, data.track);
      broadcast({ type: "md_track", page, track: state.pages[page]?.mdTrack || 1 });
      break;
    }
    case "set_led_levels":
      state.setLedLevels(data.levels || {});
      broadcast({ type: "led_levels", levels: state.ledLevels });
      renderAndPush();
      break;
    case "subscribe_midi":
      midiListeners.add(ws);
      break;
    case "set_clock_source":
      if (data.source === "internal" || data.source === "external") {
        clockSource = data.source;
        broadcastClockSource();
        restartClock();
        // advertise current inputs on switch
        if (clockSource === "external") broadcastClockInputs();
        broadcastClockOutDevice();
      }
      break;
    case "set_clock_out":
      clockOutEnabled = !!data.enabled;
      broadcastClockOut();
      break;
    case "set_clock_out_device":
      clockOutDevice = data.id || data.name || "";
      broadcastClockOutDevice();
      break;
    case "set_clock_input":
      clockInputId = data.id || data.name || "";
      broadcastClockInputs();
      break;
    case "clock_tick":
      if (clockSource === "external") {
        if (!manualRunning) {
          manualRunning = true;
          state.resetTickCounters();
          state.syncPlayheads(0);
        }
        recordExternalPulse(Date.now());
        processTick();
        broadcastClockStatus();
      }
      break;
    case "start":
      startTick();
      break;
    case "stop":
      stopTick();
      break;
    case "export_state":
      (() => {
        const payload = buildExportPayload();
        ws.send(JSON.stringify({ type: "export_state", data: payload }));
      })();
      break;
    case "td3_import_preview":
      (() => {
        try {
          const buf = Buffer.from(data?.data || "", "base64");
          const parsed = parseTd3SeqBuffer(buf);
          const notes = parsed.steps.filter((s) => !s.rest).map((s) => s.midiNote);
          if (!notes.length) {
            ws.send(JSON.stringify({ type: "td3_import_preview", empty: true }));
            return;
          }
          const detected = detectScale(notes);
          const currentScale = state.scale || { root: 0, mode: "major" };
          const differs = detected.mode !== (currentScale.mode || "major") || detected.root !== (currentScale.root || 0);
          ws.send(JSON.stringify({ type: "td3_import_preview", detectedScale: detected, currentScale, differs }));
        } catch (e) {
          ws.send(JSON.stringify({ type: "error", message: e.message || String(e) }));
        }
      })();
      break;
    case "td3_import_apply":
      (async () => {
        try {
          const buf = Buffer.from(data?.data || "", "base64");
          const mode = data?.mode === "switch_scale" ? "switch_scale" : "fit_current";
          if (mode === "switch_scale") {
            const parsed = parseTd3SeqBuffer(buf);
            const notes = parsed.steps.filter((s) => !s.rest).map((s) => s.midiNote);
            const detected = detectScale(notes);
            state.scale = { root: detected.root, mode: detected.mode };
          }
          const res = importTd3Pattern(state, buf, { page: data?.page, applyMode: mode });
          broadcastState();
          renderAndPush();
          ws.send(JSON.stringify({ type: "td3_import_applied", ...res }));
        } catch (e) {
          ws.send(JSON.stringify({ type: "error", message: e.message || String(e) }));
        }
      })();
      break;
    case "export_td3":
      (async () => {
        try {
          const tdGroup = Number(data?.group ?? data?.tdGroup);
          const tdPattern = Number(data?.pattern ?? data?.tdPattern);
          const opts = {};
          if (Number.isFinite(tdGroup)) opts.tdGroup = tdGroup;
          if (Number.isFinite(tdPattern)) opts.tdPattern = tdPattern;
          const { buffer } = await buildTd3Seq(state, opts);
          const data = buffer.toString("base64");
          ws.send(JSON.stringify({ type: "export_td3", data }));
        } catch (e) {
          ws.send(JSON.stringify({ type: "error", message: e.message || String(e) }));
        }
      })();
      break;
    case "import_state":
      if (data?.snapshot || data?.state) {
        const snap = data.snapshot || data.state || {};
        if (snap.clockSource === "internal" || snap.clockSource === "external") {
          clockSource = snap.clockSource;
          broadcastClockSource();
        }
        if (snap.clockInput) {
          clockInputId = snap.clockInput;
          broadcastClockInputs();
        }
        if (typeof snap.clockOut === "boolean") {
          clockOutEnabled = snap.clockOut;
          broadcastClockOut();
        }
        if (snap.clockOutDevice) {
          clockOutDevice = snap.clockOutDevice;
          broadcastClockOutDevice();
        }
        if (state.loadSnapshot(snap)) {
          if (typeof snap.follow === "boolean") {
            followEnabled = !!snap.follow;
            broadcast({ type: "follow", enabled: followEnabled });
          }
          if (typeof snap.autoFill === "boolean") {
            autoFillBars = !!snap.autoFill;
            broadcast({ type: "auto_fill", enabled: autoFillBars });
          }
          restartClock();
          broadcastState();
          renderAndPush();
        }
      } else if (state.loadSnapshot({})) {
        broadcastState();
        renderAndPush();
      }
      break;
    case "new_set":
      state.resetSet({
        defaultColor: data.defaultColor,
        keepDeviceNames: !!data.keepDeviceNames,
        keepMidi: !!data.keepMidi
      });
      state.syncPlayheads(0);
      broadcastState();
      renderAndPush();
      break;
    case "clear_leds":
      pendingLedFrame = null;
      lastRenderedFrame = null;
      serial.clearAll();
      break;
    default:
      ws.send(JSON.stringify({ type: "log", message: `unhandled ${data.type}` }));
  }
}

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) {
      client.send(msg);
    }
  });
}

function maybeBroadcastPage() {
  if (state.currentPage !== lastBroadcastPage) {
    lastBroadcastPage = state.currentPage;
    broadcast({ type: "page_change", page: state.currentPage });
  }
}

function guessContentType(p) {
  if (p.endsWith(".html")) return "text/html";
  if (p.endsWith(".js")) return "application/javascript";
  if (p.endsWith(".css")) return "text/css";
  if (p.endsWith(".json")) return "application/json";
  return "text/plain";
}

function renderAndPush(force = false) {
  maybeBroadcastPage();
  const frame = state.renderLED();
  const forceRefresh = state.consumeForceRefresh?.() || false;
  queueLedFrame(frame, forceRefresh || force);
}

function processTick() {
  const externalStepMs = clockSource === "external" ? extStepMs : null;
  const { midiEvents, ledFrame, patternSwitches, barChanges, barPlayheadChanges } = state.tick(followEnabled, externalStepMs);
  queueLedFrame(ledFrame);
  if (patternSwitches?.length) {
    patternSwitches.forEach((sw) => broadcastPatternStatus(sw.page));
  }
  if (barChanges?.length) {
    barChanges.forEach((bc) => broadcastBarView(bc.page, bc.pattern, bc.bar));
  }
  if (barPlayheadChanges?.length) {
    barPlayheadChanges.forEach((bc) => broadcastBarPlayhead(bc.page, bc.pattern, bc.bar));
  }
  midiEvents.forEach((evt) => {
    midiListeners.forEach((client) => {
      if (client.readyState === client.OPEN) {
        const msgType = evt.type || "midi_note";
        client.send(JSON.stringify({ type: msgType, ...evt }));
      }
    });
  });
  if (clockOutEnabled && clockSource === "internal" && manualRunning) {
    const div = Math.max(1, state.baseDivision || 16);
    const pulsesPerTick = Math.max(1, Math.round(96 / div)); // 24 ppqn
    midiListeners.forEach((client) => {
      if (client.readyState === client.OPEN) {
        client.send(JSON.stringify({ type: "midi_clock", pulses: pulsesPerTick, bpm: state.tempo }));
      }
    });
  }
}

function startTick() {
  manualRunning = true;
  state.resetTickCounters();
  state.syncPlayheads(0);
  resetExternalClockStats();
  renderAndPush(); // show playhead at step 0 before ticking
  if (clockOutEnabled && clockSource === "internal") {
    broadcastClockTransport("start");
  }
  restartClock();
}

function stopTick() {
  manualRunning = false;
  state.resetTickCounters();
  state.syncPlayheads(0);
  resetExternalClockStats();
  restartClock();
  renderAndPush(); // show playhead reset
  if (clockOutEnabled && clockSource === "internal") {
    broadcastClockTransport("stop");
  }
}

function clearClockTimer() {
  if (clockTimer) {
    clearTimeout(clockTimer);
    clockTimer = null;
  }
  nextInternalTickTime = null;
}

function restartClock() {
  clearClockTimer();
  if (manualRunning && clockSource === "internal") {
    clockMode = "internal";
    nextInternalTickTime = performance.now();
    scheduleInternalTick();
  } else if (manualRunning && clockSource === "external") {
    clockMode = "external"; // driven by external clock_tick messages
  } else {
    clockMode = "stopped";
  }
  broadcastClockStatus();
}

function scheduleInternalTick() {
  if (!manualRunning || clockSource !== "internal") return;
  const div = Math.max(1, state.baseDivision || 16); // denominator of base note (1/div)
  const baseStepMs = (60000 / state.tempo) * 4 / div;
  // swing: 50 = straight, 80 = max; convert to +/- 0.5 factor
  const swingAmt = Math.max(0, (state.swing - 50) / 60); // 0..0.5
  const even = (state.tickCount % 2) === 0;
  const factor = swingAmt > 0 ? (even ? (1 - swingAmt) : (1 + swingAmt)) : 1;
  const interval = Math.max(1, Math.round(baseStepMs * factor));
  const now = performance.now();
  if (nextInternalTickTime == null) nextInternalTickTime = now;
  // prevent runaway catch-up; if we fell far behind, realign to now
  if (nextInternalTickTime < now - interval * 2) {
    nextInternalTickTime = now;
  }
  nextInternalTickTime += interval;
  const delay = Math.max(0, Math.round(nextInternalTickTime - now));
  clockTimer = setTimeout(() => {
    processTick();
    scheduleInternalTick();
  }, delay);
}

function stopClock() {
  clearClockTimer();
  clockMode = "stopped";
  broadcastClockStatus();
}

function broadcastClockStatus() {
  const status = {
    running: manualRunning,
    mode: clockMode,
    clockSource,
    clockInput: clockInputId
  };
  broadcast({ type: "clock_status", data: status });
}

function broadcastClockOut() {
  broadcast({ type: "clock_out", enabled: clockOutEnabled });
}

function broadcastClockOutDevice() {
  broadcast({ type: "clock_out_device", id: clockOutDevice });
}

function broadcastClockTransport(kind) {
  if (kind !== "start" && kind !== "stop") return;
  const msgType = kind === "start" ? "midi_clock_start" : "midi_clock_stop";
  midiListeners.forEach((client) => {
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify({ type: msgType }));
    }
  });
}

function broadcastTempo() {
  broadcast({ type: "tempo", bpm: state.tempo });
}

function broadcastPatternStatus(page) {
  const p = state.pages[page];
  if (!p) return;
  broadcast({ type: "pattern_status", page, active: p.active_pattern, pending: p.pending_pattern || null });
}

function broadcastPatternLength(page, pattern) {
  const p = state.pages[page];
  const pat = p?.patterns?.[pattern];
  if (!pat) return;
  broadcast({ type: "pattern_length", page, pattern, length: pat.length_steps || 16 });
}

function broadcastPatternTimeScale(page, pattern) {
  const p = state.pages[page];
  const pat = p?.patterns?.[pattern];
  if (!pat) return;
  broadcast({ type: "pattern_time_scale", page, pattern, scale: pat.time_scale || 1 });
}

function broadcastBarView(page, pattern, bar) {
  const p = state.pages[page];
  const pat = p?.patterns?.[pattern];
  if (!pat) return;
  const barVal = typeof bar === "number" ? bar : (pat.barView || 0);
  broadcast({ type: "bar_view", page, pattern, bar: barVal });
}

function broadcastBarPlayhead(page, pattern, bar) {
  if (page < 1 || page > 8) return;
  broadcast({ type: "bar_playhead", page, pattern, bar });
}

function manageLedAnimation(forceStop = false) {
  const shouldRun = !forceStop && (state.hasSlidePairs() || state.hasOctaveShifts());
  if (shouldRun) {
    if (slideAnimTimer) return;
    slideAnimTimer = setInterval(() => {
      if (!(state.hasSlidePairs() || state.hasOctaveShifts())) {
        manageLedAnimation(true);
        return;
      }
      const frame = state.renderLED(Date.now());
      queueLedFrame(frame);
    }, SLIDE_ANIM_INTERVAL);
  } else if (slideAnimTimer) {
    clearInterval(slideAnimTimer);
    slideAnimTimer = null;
  }
}

function queueLedFrame(frame, force = false) {
  if (ledPaused) return;
  manageLedAnimation();
  const octaveEvents = state.consumeOctaveOverlays ? state.consumeOctaveOverlays() : [];
  if (octaveEvents.length) {
    octaveEvents.forEach((ev) => broadcast({ type: "octave_overlay", ...ev }));
  }
  const patternControllersPresent = hasPatternControllers();
  if (!force && !patternControllersPresent && lastRenderedFrame && frame && lastRenderedFrame.length === frame.length) {
    let same = true;
    for (let i = 0; i < frame.length; i++) {
      if (frame[i] !== lastRenderedFrame[i]) {
        same = false;
        break;
      }
    }
    if (same) return;
  }
  if (force) {
    lastRenderedFrame = null;
    resetLedBuffers();
  }
  pendingLedFrame = frame;
  scheduleLedSend(force);
}

function scheduleLedSend(force = false) {
  if (ledTimer && !force) return;
  const now = Date.now();
  const wait = force ? 0 : Math.max(0, LED_MIN_INTERVAL - (now - lastLedSend));
  if (ledTimer) {
    clearTimeout(ledTimer);
    ledTimer = null;
  }
  ledTimer = setTimeout(() => {
    ledTimer = null;
    if (!pendingLedFrame) return;
    const frameToSend = pendingLedFrame;
    pendingLedFrame = null;
    lastLedSend = Date.now();
    serial.sendLEDDiff(frameToSend);
    const patternDevices = patternControllerDevices();
    if (patternDevices.length) {
      const patternFrame = state.renderPatternControlLED();
      const binaryFrame = state.renderPatternControlBinaryLED();
      patternDevices.forEach((dev) => {
        const cols = dev.cols || 8;
        const rows = dev.rows || 8;
        const useBinary = dev.supportsLevels === false;
        const baseFrame = useBinary ? binaryFrame : patternFrame;
        const sliced = cropFrame(baseFrame, cols, rows, 16);
        if (sliced) {
          serial.sendLEDDiff(sliced, { deviceId: dev.id });
        }
      });
    }
    lastRenderedFrame = frameToSend;
    // broadcast a UI-safe frame without octave neighbor hints
    const uiFrame = state.renderLED(Date.now(), { includeOctaveHint: false });
    broadcast({ type: "led_frame", frame: uiFrame });
    if (pendingLedFrame) scheduleLedSend();
  }, wait);
}

function pauseLEDOutput(flag = true) {
  ledPaused = !!flag;
  pendingLedFrame = null;
  lastRenderedFrame = null;
  if (ledPaused) {
    manageSlideAnimation(false);
    serial.clearAll();
  }
}

function broadcastClockSource() {
  broadcast({ type: "clock_source", source: clockSource });
}

function broadcastClockInputs() {
  const inputs = midiInputsList();
  broadcast({ type: "clock_inputs", inputs, selected: clockInputId });
}


function midiInputsList() {
  // TODO: expose real MIDI input names; placeholder empty
  return [];
}

export function startServer(port = PORT) {
  return new Promise((resolve) => {
    server.listen(port, () => {
      console.log(`mgrid web listening on http://localhost:${port}`);
      serial.start();
      restartClock();
      resolve(server);
    });
  });
}

export { serial, state };
export { pauseLEDOutput };

// If run directly (npm start), start the server. When imported (Electron), caller controls start/port.
import { pathToFileURL } from "node:url";
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  startServer();
}
// studio grid server entrypoint: serves static files, hosts WebSocket API, drives clock/tick loop, and bridges to serialosc.
