import http from "http";
import { readFile, stat } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import { SerialOSCBridge } from "./serialosc-bridge.js";
import { buildTd3Seq, parseTd3SeqBuffer, detectScale, importTd3Pattern } from "./td3.js";
import { SGridState } from "./state.js";

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
const serial = new SerialOSCBridge({ prefix: "sgrid" });
const state = new SGridState();
state.requestRender = () => renderAndPush(true);
const PPQN_EXT = 24;
const PPQN_INT = 96;
const INT_MULT = PPQN_INT / PPQN_EXT;
const TICKS_PER_STEP_EXT = PPQN_EXT / 4;
const PATTERN_CONTROL_GRID_X = 15;
const PATTERN_CONTROL_GRID_Y = 7;
let clockSource = "external"; // default to external clock
let clockInputId = "IAC Driver Bus 2"; // preferred default
let transport = {
  running: false,
  mode: "EXTERNAL_MIDI",
  bpm: state.tempo,
  tick: 0
};
let eventListeners = new Set(); // track ws subscribed to musical events
let lastBroadcastPage = state.currentPage;
let followEnabled = false;
let autoFillBars = true;
let gridConnected = false;
let fullScaleMode = true;
let showMonomeControls = true;
let clockOutEnabled = false;
let clockOutDevice = ""; // MIDI clock out target (id/name hint)
let lastGridDevices = serial.deviceList?.() || [];
updateFullScaleMode(lastGridDevices);
// LED throttling to avoid flooding monome / browser
const LED_MIN_INTERVAL = 40; // ~25fps
const SLIDE_ANIM_INTERVAL = LED_MIN_INTERVAL; // reuse LED cadence for slide animation
let pendingLedFrame = null;
let ledTimer = null;
let lastLedSend = 0;
let lastRenderedFrame = null;
let ledPaused = false;
let slideAnimTimer = null;
let lastExternalTickIntervalMs = null;
let lastReceivedTick = null;
let externalArmed = false;

function extToIntTick(tExt) {
  return tExt * INT_MULT;
}

function patternControllerDevices() {
  const devices = typeof serial.deviceList === "function" ? serial.deviceList() : [];
  const primaryId = serial.getPrimaryDevice?.()?.id;
  return devices.filter((d) => d.connected && d.cols <= 8 && d.rows <= 8 && d.id !== primaryId);
}

function hasPatternControllers() {
  return patternControllerDevices().length > 0;
}

function hasLargeGrid(devices = null) {
  const list = devices || (typeof serial.deviceList === "function" ? serial.deviceList() : []);
  return list.some((d) => d?.connected && ((d?.cols || 0) > 8 || (d?.rows || 0) > 8));
}

function updateFullScaleMode(devices = null) {
  const list = devices || lastGridDevices;
  const next = hasLargeGrid(list) ? !showMonomeControls : true;
  if (next === fullScaleMode) return false;
  fullScaleMode = next;
  return true;
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

function dispatchGridEvents(events) {
  events.forEach((ev) => {
    if (!ev) return;
    if (ev.type === "octave") {
      broadcast({ type: "octave_overlay", page: state.currentPage, ...ev });
    } else if (ev.type === "micro") {
      broadcast({ type: "micro_overlay", page: state.currentPage, ...ev });
    } else if (ev.type === "accent") {
      broadcast({ type: "accent_overlay", page: state.currentPage, ...ev });
    } else if (ev.type === "slide") {
      broadcast({ type: "slide_overlay", page: state.currentPage, ...ev });
    } else if (ev.type === "audition") {
      broadcast({ type: "audition", ...ev });
    } else if (ev.type === "bar_view") {
      followEnabled = false;
      broadcast({ type: "follow", enabled: followEnabled });
      broadcastBarView(ev.page, ev.pattern, ev.bar);
    } else if (ev.type === "follow_toggle") {
      followEnabled = !followEnabled;
      broadcast({ type: "follow", enabled: followEnabled });
    } else if (ev.type === "follow") {
      followEnabled = !!ev.enabled;
      broadcast({ type: "follow", enabled: followEnabled });
    } else if (ev.type === "pattern_control") {
      if (ev.enabled) {
        broadcast({ type: "octave_overlay", page: state.currentPage, clearAll: true });
        broadcast({ type: "pattern_control", enabled: true });
      } else {
        broadcast({ type: "pattern_control", enabled: false, octaveOverlays: state.octaveOverlaySnapshot() });
        broadcastPatternStatus(state.currentPage);
      }
    } else if (ev.type === "pattern_length") {
      state.setPatternLength(ev.page, ev.pattern, ev.length, { autoFill: autoFillBars });
      broadcastPatternLength(ev.page, ev.pattern);
    } else if (ev.type === "pattern_status") {
      broadcastPatternStatus(ev.page || state.currentPage);
    }
  });
}

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "hello", message: "sgrid web" }));
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
  const isPrimary = !primaryId || evt.deviceId === primaryId;
  const isLarge = (cols > 8 || rows > 8);
  const useUiMode = isPrimary && isLarge && !showMonomeControls;
  const resp = state.handleGridKey(evt.x, evt.y, evt.s, { forcePatternControl, allowAudition: true, uiMode: useUiMode });
  const events = Array.isArray(resp) ? resp : (resp ? [resp] : []);
  // When a held note is entered from the monome, show the octave arrows in the UI
  if (evt.s === 1) {
    const info = state.getStepInfo(evt.x, evt.y, { uiMode: useUiMode });
    if (info?.on && info.seqType !== "drum" && info.seqType !== "cc") {
      events.push({
        type: "octave",
        x: evt.x,
        y: evt.y,
        octave: info.octave || 0,
        delta: 0,
        fromHold: true
      });
    }
  }
  dispatchGridEvents(events);
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
  lastGridDevices = payload?.devices || [];
  updateFullScaleMode(lastGridDevices);
  broadcastGridStatus(connected, lastGridDevices);
  renderAndPush(true);
});

serial.on("device_ready", (info) => {
  // Force a full redraw on the specific device and broadcast fresh state
  const devices = serial.deviceList?.() || [];
  lastGridDevices = devices;
  updateFullScaleMode(devices);
  broadcastGridStatus(true, devices);
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
  const deviceOrder = state.deviceOrder || Array.from({ length: 8 }, (_, i) => i + 1);
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
  const deviceHasData = state.pages.map((p, idx) => (idx === 0 ? null : state.deviceHasData(idx)));
  const deviceStopped = state.pages.map((p, idx) => (idx === 0 ? null : !!p?.sequencerStopped));
  const msg = JSON.stringify({
    type: "state",
    tempo: state.tempo,
    swing: state.swing,
    baseDivision: state.baseDivision,
    midi: state.midi,
    currentPage: state.currentPage,
    scale: state.scale,
    setName: state.setName,
    transposes,
    names,
    notes,
    colors,
    deviceOrder,
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
    deviceHasData,
    deviceStopped,
    mdTracks,
    octaveOverlays,
    follow: followEnabled,
    autoFill: autoFillBars,
    monoSlidePad: state.monoSlidePad,
    patternControlLatch: state.patternControlLatch,
    gridConnected,
    fullScaleMode,
    showMonomeControls,
    devices: lastGridDevices
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
        const isPatternControlKey = data.x === PATTERN_CONTROL_GRID_X && data.y === PATTERN_CONTROL_GRID_Y;
        const uiMode = isPatternControlKey ? false : fullScaleMode;
        const resp = state.handleGridKey(data.x, data.y, data.s, { uiMode, allowAudition: false });
        const events = Array.isArray(resp) ? resp : (resp ? [resp] : []);
        dispatchGridEvents(events);
      }
      maybeBroadcastPage();
      renderAndPush();
      break;
    case "get_step_state":
      {
        const info = state.getStepInfo(data.x, data.y, { uiMode: fullScaleMode });
        ws.send(JSON.stringify({ type: "step_state", page: state.currentPage, x: data.x, y: data.y, ...info }));
      }
      break;
    case "set_step_accent":
      {
        const res = state.setStepAccent(data.x, data.y, data.accent, { uiMode: fullScaleMode });
        if (res) {
          broadcast({ type: "accent_overlay", page: state.currentPage, x: data.x, y: data.y, accent: res.accent });
          renderAndPush();
        }
      }
      break;
    case "set_step_slide":
      {
        const res = state.setStepSlide(data.x, data.y, data.slide, { uiMode: fullScaleMode });
        if (res) {
          broadcast({ type: "slide_overlay", page: state.currentPage, x: data.x, y: data.y, slide: res.slide });
          renderAndPush();
        }
      }
      break;
    case "set_step_octave":
      {
        const res = state.setStepOctave(data.x, data.y, data.delta, { uiMode: fullScaleMode });
        if (res) {
          broadcast({ type: "octave_overlay", page: state.currentPage, x: data.x, y: data.y, octave: res.octave, delta: res.delta });
          renderAndPush();
        }
      }
      break;
    case "set_step_micro":
      {
        const res = state.setStepMicroOffset(data.x, data.y, data.delta, { uiMode: fullScaleMode });
        if (res) {
          const page = state.pages[state.currentPage];
          const pat = page?.patterns?.[page?.active_pattern];
          const abs = pat ? data.x + (pat.barView || 0) * 16 : -1;
          const step = abs >= 0 && abs < (pat?.steps?.length || 0) ? pat.steps[abs] : null;
          const seqType = page?.sequencerType || "mono";
          const rowInfo = state.getRowInfo(data.y, { uiMode: fullScaleMode });
          const degree = rowInfo?.degree ?? 0;
          const octave = (seqType === "poly" || seqType === "drum")
            ? state.getNoteOctave(step, degree)
            : (step?.octave || 0);
          broadcast({
            type: "micro_overlay",
            page: state.currentPage,
            x: data.x,
            y: data.y,
            rawY: fullScaleMode ? (data.y === 0 ? 6 : data.y - 1) : data.y,
            octave,
            microOffset: res.microOffset,
            delta: res.delta
          });
          renderAndPush();
        }
      }
      break;
    case "set_base_division":
      {
        state.setBaseDivision(data.division);
        broadcast({ type: "base_division", division: state.baseDivision });
      }
      break;
    case "set_pattern_control_latch":
      state.patternControlLatch = !!data.enabled;
      broadcast({ type: "pattern_control_latch", enabled: state.patternControlLatch });
      renderAndPush();
      break;
    case "set_monome_controls":
      if (typeof data.enabled === "boolean") {
        showMonomeControls = data.enabled;
        updateFullScaleMode(lastGridDevices);
        broadcastGridStatus(gridConnected, lastGridDevices);
        renderAndPush(true);
      }
      break;
    case "tempo":
      state.setTempo(data.bpm);
      transport.bpm = state.tempo;
      broadcastTempo();
      break;
    case "set_scale":
      state.setScale(data.root, data.mode);
      broadcast({ type: "scale", scale: state.scale });
      break;
    case "set_swing":
      state.setSwing(data.swing);
      broadcast({ type: "swing", swing: state.swing });
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
    case "set_device_order":
      state.setDeviceOrder(data.order);
      broadcast({ type: "device_order", order: state.deviceOrder });
      renderAndPush();
      break;
    case "set_set_name":
      state.setSetName(data.name);
      broadcast({ type: "set_name", name: state.setName });
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
      broadcastPatternLength(
        state.currentPage,
        data.pattern || state.pages[state.currentPage]?.active_pattern || 1,
        { silent: !!data.silent }
      );
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
      broadcastPatternLength(state.currentPage, state.pages[state.currentPage]?.active_pattern || 1);
      broadcastPatternTimeScale(state.currentPage, state.pages[state.currentPage]?.active_pattern || 1);
      broadcastBarView(state.currentPage, state.pages[state.currentPage]?.active_pattern || 1);
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
      const bar = Number.isFinite(Number(data.bar)) ? Number(data.bar) : null;
      const dx = Number.isFinite(Number(data.dx)) ? Number(data.dx) : 0;
      const dy = Number.isFinite(Number(data.dy)) ? Number(data.dy) : 0;
      if (state.shiftPattern(page, patIdx, { dx, dy, bar })) {
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
    case "pattern_poly_check": {
      const page = Number(data.page) || state.currentPage;
      const pattern = Number(data.pattern) || state.pages[page]?.active_pattern || 1;
      const multi = state.patternHasPolySteps(page, pattern);
      ws.send(JSON.stringify({ type: "pattern_poly_status", page, pattern, multi, requestId: data.requestId || null }));
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
    case "subscribe_events":
    case "subscribe_midi":
      eventListeners.add(ws);
      break;
    case "set_clock_source":
      if (data.source === "internal" || data.source === "external") {
        clockSource = data.source;
        transport.mode = clockSource === "internal" ? "INTERNAL" : "EXTERNAL_MIDI";
        if (clockSource !== "external") externalArmed = false;
        stopTick();
        broadcastClockSource();
        // advertise current inputs on switch
        if (clockSource === "external") broadcastClockInputs();
        broadcastClockOutDevice();
      }
      break;
    case "set_external_arm":
      externalArmed = !!data.enabled;
      broadcast({ type: "external_arm", enabled: externalArmed });
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
    case "transport":
      {
        const action = data.action || data.subtype;
        if (action === "start") {
          if (!transport.running || lastReceivedTick == null) {
            startTick({ tick: data.tick });
          }
        } else if (action === "stop") {
          stopTick();
        } else if (action === "continue") {
          continueTick({ tick: data.tick });
        }
      }
      break;
    case "clockTicks":
      {
        const ticks = Array.isArray(data.ticks)
          ? data.ticks
          : [{ tick: data.tick, intervalMs: data.intervalMs }];
        ticks.forEach((evt) => {
          if (!evt || !Number.isFinite(evt.tick)) return;
          const nextTick = Math.max(0, Math.floor(evt.tick));
          if (lastReceivedTick != null && nextTick <= lastReceivedTick) {
            return;
          }
          lastReceivedTick = nextTick;
          if (!transport.running && transport.mode === "EXTERNAL_MIDI") {
            if (!externalArmed) return;
            startTick({ tick: nextTick });
          }
          transport.tick = nextTick;
          if (transport.mode === "EXTERNAL_MIDI" && Number.isFinite(evt.intervalMs) && evt.intervalMs > 0) {
            lastExternalTickIntervalMs = evt.intervalMs;
          }
          if (transport.tick % TICKS_PER_STEP_EXT === 0) {
            const externalStepMs = transport.mode === "EXTERNAL_MIDI" && Number.isFinite(lastExternalTickIntervalMs)
              ? lastExternalTickIntervalMs * TICKS_PER_STEP_EXT
              : null;
            processTick({ tick: transport.tick, externalStepMs });
            broadcastClockStatus();
          }
        });
      }
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
          transport.mode = clockSource === "internal" ? "INTERNAL" : "EXTERNAL_MIDI";
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
          transport.bpm = state.tempo;
          if (typeof snap.follow === "boolean") {
            followEnabled = !!snap.follow;
            broadcast({ type: "follow", enabled: followEnabled });
          }
          if (typeof snap.autoFill === "boolean") {
            autoFillBars = !!snap.autoFill;
            broadcast({ type: "auto_fill", enabled: autoFillBars });
          }
          if (transport.running) {
            syncStateToTransport();
          } else {
            stopTick();
          }
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
      if (transport.running) {
        syncStateToTransport();
      } else {
        state.syncPlayheads(0);
      }
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

function broadcastGridStatus(connected = gridConnected, devices = lastGridDevices) {
  broadcast({ type: "grid_status", connected, devices: devices || [], fullScaleMode, showMonomeControls });
}

function maybeBroadcastPage() {
  if (state.currentPage !== lastBroadcastPage) {
    lastBroadcastPage = state.currentPage;
    broadcast({ type: "page_change", page: state.currentPage, octaveOverlays: state.octaveOverlaySnapshot() });
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
  const ignorePatternControl = !showMonomeControls && !state.patternControlMode;
  const frame = fullScaleMode
    ? state.renderUIFrame(Date.now(), { ignorePatternControl })
    : state.renderLED();
  const forceRefresh = state.consumeForceRefresh?.() || false;
  queueLedFrame(frame, forceRefresh || force);
}

function buildMusicalEvents({ tick, midiEvents }) {
  if (!Array.isArray(midiEvents) || !midiEvents.length) return [];
  const out = [];
  midiEvents.forEach((evt) => {
    if (!evt) return;
    if (evt.type === "midi_note") {
      const baseTick = Number.isFinite(evt.tick) ? evt.tick : tick;
      const delayMs = Math.max(0, Number(evt.delayMs) || 0);
      const durMs = Math.max(0, Number(evt.durMs) || 0);
      out.push({
        type: "note_on",
        tick: baseTick,
        offsetMs: delayMs,
        page: evt.page,
        channel: evt.chan,
        note: evt.pitch,
        velocity: evt.vel,
        accent: !!evt.accent,
        td3Slide: !!evt.td3Slide
      });
      out.push({
        type: "note_off",
        tick: baseTick,
        offsetMs: delayMs + durMs,
        page: evt.page,
        channel: evt.chan,
        note: evt.pitch,
        velocity: 0
      });
    } else if (evt.type === "midi_cc") {
      const baseTick = Number.isFinite(evt.tick) ? evt.tick : tick;
      out.push({
        type: "cc",
        tick: baseTick,
        offsetMs: Math.max(0, Number(evt.delayMs) || 0),
        page: evt.page,
        channel: evt.chan,
        cc: evt.cc,
        value: evt.value
      });
    }
  });
  return out;
}

function broadcastEvents(events) {
  if (!events || !events.length) return;
  eventListeners.forEach((client) => {
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify({ type: "events", events }));
    }
  });
}

function processTick({ tick, externalStepMs = null }) {
  const { midiEvents, patternSwitches, barChanges, barPlayheadChanges } = state.tick(followEnabled, externalStepMs, tick);
  const ignorePatternControl = !showMonomeControls && !state.patternControlMode;
  const frame = fullScaleMode
    ? state.renderUIFrame(Date.now(), { ignorePatternControl })
    : state.renderLED(Date.now());
  queueLedFrame(frame);
  if (patternSwitches?.length) {
    patternSwitches.forEach((sw) => broadcastPatternStatus(sw.page));
  }
  if (barChanges?.length) {
    barChanges.forEach((bc) => broadcastBarView(bc.page, bc.pattern, bc.bar));
  }
  if (barPlayheadChanges?.length) {
    barPlayheadChanges.forEach((bc) => broadcastBarPlayhead(bc.page, bc.pattern, bc.bar));
  }
  const tickInt = extToIntTick(tick);
  broadcastEvents(buildMusicalEvents({ tick: tickInt, midiEvents }));
}

function startTick({ tick = 0 } = {}) {
  transport.running = true;
  transport.tick = Math.max(0, Math.floor(tick || 0));
  lastExternalTickIntervalMs = null;
  lastReceivedTick = null;
  const stepIndex = Math.max(0, Math.floor(transport.tick / TICKS_PER_STEP_EXT));
  state.resetTickCounters();
  state.tickCount = stepIndex % 1024;
  for (let p = 1; p <= 8; p++) {
    if (!state.pages[p]) continue;
    state.pageTicks[p] = stepIndex;
    state.pageTickPos[p] = stepIndex - 1;
  }
  state.syncPlayheads(stepIndex);
  renderAndPush(); // show playhead at step 0 before ticking
  broadcastClockStatus();
}

function syncStateToTransport() {
  const baseStepIndex = Math.max(0, Math.floor((transport.tick || 0) / TICKS_PER_STEP_EXT));
  const nextStepIndex = baseStepIndex + 1;
  state.resetTickCounters();
  state.tickCount = nextStepIndex % 1024;
  for (let p = 1; p <= 8; p++) {
    const page = state.pages[p];
    if (!page) continue;
    const pat = page.patterns?.[page.active_pattern];
    if (!pat) continue;
    const len = Math.max(1, pat.length_steps || 16);
    const scaleFactor = Math.max(1, Math.round(pat.time_scale || 1));
    const prevStepPos = Math.floor(baseStepIndex / scaleFactor) % len;
    state.pageTicks[p] = nextStepIndex;
    state.pageTickPos[p] = prevStepPos;
    state.playheads[p] = prevStepPos;
  }
  broadcastClockStatus();
}

function stopTick() {
  transport.running = false;
  transport.tick = 0;
  lastExternalTickIntervalMs = null;
  lastReceivedTick = null;
  state.resetTickCounters();
  state.syncPlayheads(0);
  renderAndPush(); // show playhead reset
  broadcastClockStatus();
}

function continueTick({ tick = null } = {}) {
  transport.running = true;
  if (Number.isFinite(tick)) {
    transport.tick = Math.max(0, Math.floor(tick));
    state.syncPlayheads(Math.floor(transport.tick / TICKS_PER_STEP_EXT));
  }
  broadcastClockStatus();
}

function broadcastClockStatus() {
  const status = {
    running: transport.running,
    mode: transport.mode,
    clockSource,
    clockInput: clockInputId,
    tick: transport.tick,
    bpm: transport.bpm
  };
  broadcast({ type: "clock_status", data: status });
}

function broadcastClockOut() {
  broadcast({ type: "clock_out", enabled: clockOutEnabled });
}

function broadcastClockOutDevice() {
  broadcast({ type: "clock_out_device", id: clockOutDevice });
}

function broadcastTempo() {
  broadcast({ type: "tempo", bpm: state.tempo });
}

function broadcastPatternStatus(page) {
  const p = state.pages[page];
  if (!p) return;
  broadcast({
    type: "pattern_status",
    page,
    active: p.active_pattern,
    pending: p.pending_pattern || null,
    octaveOverlays: state.octaveOverlaySnapshot()
  });
}

function broadcastPatternLength(page, pattern, opts = {}) {
  const p = state.pages[page];
  const pat = p?.patterns?.[pattern];
  if (!pat) return;
  broadcast({ type: "pattern_length", page, pattern, length: pat.length_steps || 16, silent: !!opts.silent });
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
  broadcast({
    type: "bar_view",
    page,
    pattern,
    bar: barVal,
    octaveOverlays: state.octaveOverlaySnapshot()
  });
}

function broadcastBarPlayhead(page, pattern, bar) {
  if (page < 1 || page > 8) return;
  broadcast({ type: "bar_playhead", page, pattern, bar });
}

// DO NOT CHANGE LOGIC: monome LED frame generation + serialosc output pipeline.
function manageLedAnimation(forceStop = false) {
  const shouldRun = !forceStop && (state.hasSlidePairs() || state.hasOctaveShifts());
  if (shouldRun) {
    if (slideAnimTimer) return;
    slideAnimTimer = setInterval(() => {
      if (!(state.hasSlidePairs() || state.hasOctaveShifts())) {
        manageLedAnimation(true);
        return;
      }
      const ignorePatternControl = !showMonomeControls && !state.patternControlMode;
      const frame = fullScaleMode
        ? state.renderUIFrame(Date.now(), { ignorePatternControl })
        : state.renderLED(Date.now());
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
    const uiFrame = fullScaleMode
      ? state.renderUIFrame(Date.now(), { includeOctaveHint: false, ignorePatternHoldDim: true })
      : state.renderLED(Date.now(), { includeOctaveHint: false, ignorePatternHoldDim: true });
    const inPatternControl = state.patternControlMode || state.patternControlHeld || state.patternHeld;
    broadcast({
      type: "led_frame",
      frame: uiFrame,
      octaveOverlays: inPatternControl ? Array.from({ length: 9 }, () => []) : state.octaveOverlaySnapshot(),
      deviceHasData: state.pages.map((p, idx) => (idx === 0 ? null : state.deviceHasData(idx))),
      deviceStopped: state.pages.map((p, idx) => (idx === 0 ? null : !!p?.sequencerStopped))
    });
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
      console.log(`sgrid web listening on http://localhost:${port}`);
      serial.start();
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
