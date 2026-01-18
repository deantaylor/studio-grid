// Base pitch for degree 0, octave 0 (C3). Raised one octave.
const BASE_PITCH = 48;
const DEFAULT_CC = 1;
const PPQN_EXT = 24;
const PPQN_INT = 96;
const INT_MULT = PPQN_INT / PPQN_EXT;
const TICKS_PER_STEP_EXT = PPQN_EXT / 4;
const TICKS_PER_STEP_INT = TICKS_PER_STEP_EXT * INT_MULT;
const PATTERN_CONTROL_BUTTON = 15; // bottom-row button to enter pattern control view (x index)
const BASE_DEFAULT_DEVICE_COLOR = "#ffe070";
const DEFAULT_DEVICE_COLORS = Array(8).fill(BASE_DEFAULT_DEVICE_COLOR);
const MDTONAL_TRACKS = [
  null,
  { ccChannel: 1, ccNumber: 16, noteNumber: 36, noteChannel: 1 },
  { ccChannel: 1, ccNumber: 40, noteNumber: 38, noteChannel: 1 },
  { ccChannel: 1, ccNumber: 72, noteNumber: 40, noteChannel: 1 },
  { ccChannel: 1, ccNumber: 96, noteNumber: 41, noteChannel: 1 },
  { ccChannel: 2, ccNumber: 16, noteNumber: 43, noteChannel: 1 },
  { ccChannel: 2, ccNumber: 40, noteNumber: 45, noteChannel: 1 },
  { ccChannel: 2, ccNumber: 72, noteNumber: 47, noteChannel: 1 },
  { ccChannel: 2, ccNumber: 96, noteNumber: 48, noteChannel: 1 },
  { ccChannel: 3, ccNumber: 16, noteNumber: 50, noteChannel: 1 },
  { ccChannel: 3, ccNumber: 40, noteNumber: 52, noteChannel: 1 },
  { ccChannel: 3, ccNumber: 72, noteNumber: 53, noteChannel: 1 },
  { ccChannel: 3, ccNumber: 96, noteNumber: 55, noteChannel: 1 },
  { ccChannel: 4, ccNumber: 16, noteNumber: 57, noteChannel: 1 },
  { ccChannel: 4, ccNumber: 40, noteNumber: 59, noteChannel: 1 },
  { ccChannel: 4, ccNumber: 72, noteNumber: 60, noteChannel: 1 },
  { ccChannel: 4, ccNumber: 96, noteNumber: 62, noteChannel: 1 }
];

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function extToIntTick(tExt) {
  return tExt * INT_MULT;
}

function intToExtTick(tInt) {
  return tInt / INT_MULT;
}

function safeColor(color, fallback = BASE_DEFAULT_DEVICE_COLOR) {
  return /^#([0-9a-fA-F]{6})$/.test(color || "") ? color : fallback;
}

export class SGridState {
  constructor() {
    this.tempo = 120;
    this.swing = 50; // 50 = straight, 80 max swing
    this.baseDivision = 16; // base step division (1/16)
    this.gateLength = 1; // fraction of step length (0.25..1)
    this.scale = { root: 0, mode: "major" };
    this.pages = this.buildDefaultPages();
    this.sequencerTypes = this.pages.map((p, i) => (i === 0 ? null : p.sequencerType));
    this.sequencerTypes = this.pages.map((p, i) => (i === 0 ? null : p.sequencerType));
    this.deviceNames = this.pages.map((p, i) => (i === 0 ? null : p.name));
    this.deviceNotes = this.pages.map((p, i) => (i === 0 ? null : p.note));
    this.deviceColors = this.pages.map((p, i) => (i === 0 ? null : p.color));
    this.deviceOrder = Array.from({ length: 8 }, (_, i) => i + 1);
    this.isomorphicModes = Array(9).fill(false);
    this.isomorphicMonoActive = Array(9).fill(null);
    this.isomorphicLayout = this.sanitizeIsomorphicLayout({ base: 24, stepX: 1, stepY: 3 });
    this.deviceTabHoldTimers = Array(9).fill(null);
    this.deviceTabHoldFired = Array(9).fill(false);
    this.deviceGateWindows = Array.from({ length: 9 }, () => []);
    this.activeNoteWindows = Array.from({ length: 9 }, () => new Map());
    this.gateLedBoost = false;
    this.gateLedFlashMs = 40;
    this.setName = "default";
    this.currentPage = 1;
    this.playheads = Array(9).fill(0); // 1-indexed
    this.lastTickTime = 0;
    this.ledLevels = {
      step_on: 10,
      step_micro: 10,
      step_accent: 14,
      playhead: 15,
      pattern_active: 12,
      pattern_pending: 6,
      pattern_inactive: 4,
      device_present: 8,
      device_active: 15
    };
    this.heldStep = null; // {x,y}
    this.heldStepModified = false;
    this.heldStepPendingOff = false;
    this.midi = this.buildDefaultMidi();
    this.deviceHeld = false;
    this.patternHeld = false; // pattern switch modifier (button 14)
    this.patternControlHeld = false; // holding launcher in non-latch mode
    this.pulse = false;
    this.noteOffEpsilonMs = 6; // shave a few ms to avoid zero-length clips in DAWs
    this.externalGatePadMs = 12; // extra pad to avoid external clock overlaps in DAWs
    this.gatePadMs = 0;
    this.tickCount = 0;
    this.keyHolds = new Map(); // key -> {start, wasOn}
    this.pageTicks = Array(9).fill(0); // total ticks per page (16ths)
    this.pageTickPos = Array(9).fill(-1); // last processed step per page
    this.skipNextMDNote = {};
    this.mdSlideFactor = 0.6;
    this.mdSlideCurve = 1.0;
    this.mdBaseSweep = 80;
    this.mdGlideValue = Array(9).fill(null);
    this.monoSlidePad = 0.2; // fraction of a step trimmed from slide gates
    this.patternControlMode = false; // when true, grid shows global pattern view
    this.forceLedRefresh = false; // request immediate LED refresh
    // this.pendingMuteTick = Array(9).fill(null); // target tick to apply mute/unmute (legacy mute path)
    this.pendingStopTick = Array(9).fill(null); // target tick to apply stop/start
    this.pendingPatternTick = Array(9).fill(null); // target tick to apply pending pattern
    this.patternControlLatch = true;
    this.pendingOctaveOverlays = [];
    this.holdTimers = new Map(); // key -> timeout id for entering edit mode
    this.requestRender = null; // optional callback wired by server to force a render
    this.auditionHolds = new Map(); // key -> {page, note, channel, cc, ccValue, ccChannel}
    this.lastMultiSelectTime = 0;
  }

  normalizeDeviceOrder(order) {
    const base = Array.from({ length: 8 }, (_, i) => i + 1);
    if (!Array.isArray(order)) return base;
    const clean = order
      .map((v) => Math.round(Number(v)))
      .filter((v) => v >= 1 && v <= 8);
    const unique = Array.from(new Set(clean));
    base.forEach((v) => {
      if (!unique.includes(v)) unique.push(v);
    });
    return unique.slice(0, 8);
  }

  setDeviceOrder(order) {
    this.deviceOrder = this.normalizeDeviceOrder(order);
  }

  getDeviceByColumn(col) {
    const safeCol = clamp(Math.round(col || 0), 0, 7);
    const order = this.normalizeDeviceOrder(this.deviceOrder);
    return order[safeCol] || (safeCol + 1);
  }

  setSetName(name) {
    const clean = String(name || "").trim().slice(0, 64);
    this.setName = clean || "default";
  }

  registerDeviceGate(page, delayMs, durMs) {
    const pageIdx = Math.round(Number(page) || 0);
    if (pageIdx < 1 || pageIdx > 8) return;
    const now = Date.now();
    const startMs = now + Math.max(0, Number(delayMs) || 0);
    const flashMs = Math.max(10, Math.round(Number(this.gateLedFlashMs) || 80));
    const endMs = startMs + flashMs;
    if (!Number.isFinite(endMs) || endMs <= now) return;
    if (!Array.isArray(this.deviceGateWindows[pageIdx])) {
      this.deviceGateWindows[pageIdx] = [];
    }
    this.deviceGateWindows[pageIdx].push({ startMs, endMs });
    this.pruneDeviceGateWindows(pageIdx, now);
    if (typeof this.requestRender === "function") {
      const startDelay = Math.max(0, startMs - now);
      const endDelay = Math.max(0, endMs - now);
      setTimeout(() => this.requestRender?.(), startDelay);
      setTimeout(() => this.requestRender?.(), endDelay);
    }
  }

  registerActiveNote(page, pitch, delayMs, durMs) {
    const pageIdx = Math.round(Number(page) || 0);
    if (pageIdx < 1 || pageIdx > 8) return;
    const safePitch = clamp(Math.round(pitch ?? 0), 0, 127);
    if (!Number.isFinite(safePitch)) return;
    const now = Date.now();
    const startMs = now + Math.max(0, Number(delayMs) || 0);
    const duration = Math.max(1, Math.round(Number(durMs) || 0));
    const endMs = startMs + duration;
    if (!Number.isFinite(endMs) || endMs <= now) return;
    const map = this.activeNoteWindows[pageIdx];
    if (!map) return;
    const prev = map.get(safePitch) || 0;
    if (endMs > prev) map.set(safePitch, endMs);
    if (typeof this.requestRender === "function") {
      const startDelay = Math.max(0, startMs - now);
      const endDelay = Math.max(0, endMs - now);
      setTimeout(() => this.requestRender?.(), startDelay);
      setTimeout(() => this.requestRender?.(), endDelay);
    }
  }

  pruneActiveNotes(pageIdx, now = Date.now()) {
    const map = this.activeNoteWindows[pageIdx];
    if (!map || !map.size) return;
    map.forEach((endMs, pitch) => {
      if (!Number.isFinite(endMs) || endMs <= now) {
        map.delete(pitch);
      }
    });
  }

  getActiveNotesSet(pageIdx, now = Date.now()) {
    this.pruneActiveNotes(pageIdx, now);
    const map = this.activeNoteWindows[pageIdx];
    if (!map || !map.size) return new Set();
    return new Set(map.keys());
  }

  pruneDeviceGateWindows(pageIdx, now = Date.now()) {
    const windows = this.deviceGateWindows[pageIdx];
    if (!Array.isArray(windows) || !windows.length) return;
    this.deviceGateWindows[pageIdx] = windows.filter((win) => win && win.endMs > now);
  }

  isDeviceGateActive(pageIdx, now = Date.now()) {
    if (!this.gateLedBoost) return false;
    const windows = this.deviceGateWindows[pageIdx];
    if (!Array.isArray(windows) || !windows.length) return false;
    let active = false;
    const remaining = [];
    windows.forEach((win) => {
      if (!win || !Number.isFinite(win.endMs)) return;
      if (win.endMs > now) {
        remaining.push(win);
        if (win.startMs <= now) active = true;
      }
    });
    if (remaining.length !== windows.length) {
      this.deviceGateWindows[pageIdx] = remaining;
    }
    return active;
  }

  pushMidiNote(midiEvents, payload) {
    midiEvents.push(payload);
    this.registerDeviceGate(payload?.page, payload?.delayMs, payload?.durMs);
    this.registerActiveNote(payload?.page, payload?.pitch, payload?.delayMs, payload?.durMs);
  }

  patternHasPolySteps(pageIdx, patternIdx) {
    if (pageIdx < 1 || pageIdx > 8) return false;
    if (patternIdx < 1 || patternIdx > 8) return false;
    const pat = this.pages[pageIdx]?.patterns?.[patternIdx];
    if (!pat || !Array.isArray(pat.steps)) return false;
    return pat.steps.some((s) => Array.isArray(s?.notes) && s.notes.length > 1);
  }

  resetTickCounters() {
    this.pageTicks = Array(9).fill(0);
    this.pageTickPos = Array(9).fill(-1);
    this.skipNextMDNote = {};
    this.mdGlideValue = Array(9).fill(null);
    // this.pendingMuteTick = Array(9).fill(null); // legacy mute scheduling
    this.pendingStopTick = Array(9).fill(null);
    this.pendingPatternTick = Array(9).fill(null);
    this.tickCount = 0;
    this.patternControlMode = false;
    this.pendingOctaveOverlays = [];
    this.holdTimers.forEach((t) => clearTimeout(t));
    this.holdTimers.clear();
  }

  makeEmptyPattern() {
    const steps = [];
    for (let i = 0; i < 128; i++) {
      steps.push({ on: false, degree: 0, octave: 0, micro: 0, accent: false, slide: false, mdSlide: false, chain: false, tie: false, notes: [], accented: [], noteOctaves: {}, noteMicros: {}, noteSlides: {}, cc: 0 });
    }
    return {
      length_steps: 16,
      root: 0,
      scale_mode: "major",
      time_scale: 1.0,
      change_mode: "end_of_pattern",
      barView: 0,
      steps
    };
  }

  enqueueOctaveOverlay(payload) {
    if (!payload || typeof payload !== "object") return;
    if (!this.pendingOctaveOverlays) this.pendingOctaveOverlays = [];
    this.pendingOctaveOverlays.push(payload);
  }

  enqueueMicroOverlay(payload) {
    if (!payload || typeof payload !== "object") return;
    if (!this.pendingMicroOverlays) this.pendingMicroOverlays = [];
    this.pendingMicroOverlays.push(payload);
  }

  consumeOctaveOverlays() {
    const out = this.pendingOctaveOverlays ? this.pendingOctaveOverlays.slice() : [];
    this.pendingOctaveOverlays = [];
    return out;
  }

  consumeMicroOverlays() {
    const out = this.pendingMicroOverlays ? this.pendingMicroOverlays.slice() : [];
    this.pendingMicroOverlays = [];
    return out;
  }

  octaveOverlaySnapshot() {
    const pages = Array(9).fill(null).map(() => []);
    for (let p = 1; p <= 8; p++) {
      const page = this.pages[p];
      if (!page) continue;
      const pat = page.patterns?.[page.active_pattern];
      if (!pat) continue;
      const bar = pat.barView || 0;
      const seqType = page.sequencerType || "mono";
      for (let x = 0; x < 16; x++) {
        const abs = x + bar * 16;
        if (abs >= pat.steps.length) break;
        const step = pat.steps[abs];
        if (!step?.on) continue;
        if (seqType === "poly") {
          if (Array.isArray(step.notes) && step.notes.length) {
            step.notes.forEach((deg) => {
              const oct = this.getNoteOctave(step, deg);
              if (!oct) return;
              const y = clamp(6 - deg, 0, 6);
              pages[p].push({ x, y, octave: oct });
            });
          }
          if ((step.octave || 0) !== 0) {
            const y = clamp(6 - (step.degree || 0), 0, 6);
            pages[p].push({ x, y, octave: step.octave || 0 });
          }
        } else if (seqType === "mono" || seqType === "mdtonal") {
          if ((step.octave || 0) !== 0) {
            const y = clamp(6 - (step.degree || 0), 0, 6);
            pages[p].push({ x, y, octave: step.octave || 0 });
          }
        }
      }
    }
    return pages;
  }

  sanitizeNoteOctaves(noteOctaves) {
    const res = {};
    if (!noteOctaves || typeof noteOctaves !== "object") return res;
    Object.entries(noteOctaves).forEach(([degRaw, octRaw]) => {
      const degNum = Number(degRaw);
      if (!Number.isFinite(degNum)) return;
      const deg = clamp(Math.round(degNum), 0, 6);
      const oct = clamp(Math.round(Number(octRaw) || 0), -3, 4);
      res[deg] = oct;
    });
    return res;
  }

  normalizeMicroValue(microRaw, opts = {}) {
    const legacy = !!opts.legacy;
    const raw = Math.round(Number(microRaw) || 0);
    const converted = legacy ? Math.round(raw / INT_MULT) : raw;
    return this.clampMicro(converted);
  }

  sanitizeNoteMicros(noteMicros, opts = {}) {
    const res = {};
    if (!noteMicros || typeof noteMicros !== "object") return res;
    Object.entries(noteMicros).forEach(([degRaw, microRaw]) => {
      const degNum = Number(degRaw);
      if (!Number.isFinite(degNum)) return;
      const safeDeg = clamp(Math.round(degNum), 0, 6);
      const safeMicro = this.normalizeMicroValue(microRaw, opts);
      if (safeMicro) res[safeDeg] = safeMicro;
    });
    return res;
  }

  sanitizeNoteSlides(noteSlides) {
    const res = {};
    if (!noteSlides || typeof noteSlides !== "object") return res;
    Object.entries(noteSlides).forEach(([degRaw, slideRaw]) => {
      const degNum = Number(degRaw);
      if (!Number.isFinite(degNum)) return;
      const safeDeg = clamp(Math.round(degNum), 0, 6);
      if (slideRaw) res[safeDeg] = true;
    });
    return res;
  }

  getNoteOctave(step, degree) {
    if (!step) return 0;
    if (step.noteOctaves && typeof step.noteOctaves === "object" && degree != null && Object.prototype.hasOwnProperty.call(step.noteOctaves, degree)) {
      const raw = step.noteOctaves[degree];
      return clamp(Number.isFinite(raw) ? Math.round(raw) : 0, -3, 4);
    }
    return clamp(step.octave || 0, -3, 4);
  }

  getDrumPitch(page, degree, octave = 0) {
    const drumMap = Array.isArray(page?.drumNotes) ? page.drumNotes : [];
    const safeDeg = clamp(Math.round(degree || 0), 0, 6);
    if (safeDeg === 0 && Number(octave) === 1) {
      return drumMap[7] ?? drumMap[0] ?? 36;
    }
    return drumMap[safeDeg] ?? drumMap[0] ?? 36;
  }

  buildDefaultMidi() {
    const midi = [null];
    for (let i = 1; i <= 8; i++) {
      midi.push({ outId: "", channel: 1 });
    }
    return midi;
  }

  buildDefaultPages() {
    const pages = [null];
    const defaultDrums = [36, 38, 41, 43, 45, 47, 55, 60]; // C1..C2 bottom->top
    const mdDrums = [36, 38, 40, 41, 43, 45, 47, 48]; // first 8 tracks
    for (let p = 1; p <= 8; p++) {
      const patterns = [null];
      for (let pat = 1; pat <= 8; pat++) {
        patterns.push(this.makeEmptyPattern());
      }
      pages.push({
        name: `${p}`,
        note: "",
        color: DEFAULT_DEVICE_COLORS[p - 1] || "#ffb703",
        active_pattern: 1,
        patterns,
        transpose: 0,
        muted: false, // legacy mute flag
        pendingMute: null, // legacy pending mute flag
        sequencerStopped: false,
        pendingStop: null,
        sequencerType: "mono",
        drumNotes: mdDrums.slice(), // change to defaultDrums for default
        ccNumber: DEFAULT_CC,
        mdTrack: 1
      });
    }
    return pages;
  }

  resetSet({ defaultColor, keepDeviceNames = false, keepMidi = false } = {}) {
    const fallbackColor = safeColor(defaultColor, BASE_DEFAULT_DEVICE_COLOR);
    const newColors = [null];
    const newNotes = [null];
    if (!keepMidi) {
      this.midi = this.buildDefaultMidi();
    }
    const defaultNames = this.pages.map((_, idx) => (idx === 0 ? null : `${idx}`));
    if (!keepDeviceNames) {
      this.deviceNames = defaultNames;
    }
    this.sequencerTypes = this.sequencerTypes.map((_, idx) => (idx === 0 ? null : "mono"));
    for (let p = 1; p <= 8; p++) {
      const page = this.pages[p];
      if (!page) continue;
      const patterns = [null];
      for (let pat = 1; pat <= 8; pat++) {
        patterns.push(this.makeEmptyPattern());
      }
      page.patterns = patterns;
      page.active_pattern = 1;
      page.pending_pattern = null;
      page.pendingMute = null; // legacy mute flag
      page.pendingStop = null;
      page.muted = false; // legacy mute flag
      page.sequencerStopped = false;
      page.sequencerType = "mono";
      page.transpose = 0;
      page.drumNotes = Array.isArray(page.drumNotes) ? page.drumNotes.slice(0, 8) : [36, 38, 41, 43, 45, 47, 55, 60];
      page.note = "";
      page.ccNumber = DEFAULT_CC;
      this.sequencerTypes[p] = "mono";
      page.mdTrack = 1;
      const paletteColor = DEFAULT_DEVICE_COLORS[p - 1] || fallbackColor;
      const resetColor = defaultColor ? safeColor(defaultColor, fallbackColor) : paletteColor;
      page.color = resetColor;
      newColors[p] = resetColor;
      if (!keepDeviceNames) {
        page.name = defaultNames[p];
      } else if (this.deviceNames?.[p]) {
        page.name = this.deviceNames[p];
      }
      newNotes[p] = "";
    }
    this.deviceColors = newColors;
    this.deviceNotes = newNotes;
    this.playheads = Array(9).fill(0);
    this.deviceOrder = Array.from({ length: 8 }, (_, i) => i + 1);
    this.setName = "default";
    this.currentPage = 1;
    this.heldStep = null;
    this.heldStepModified = false;
    this.heldStepPendingOff = false;
    this.deviceHeld = false;
    this.patternHeld = false;
    this.patternControlHeld = false;
    this.resetTickCounters();
    this.pageTickPos = Array(9).fill(-1);
  }

  setPatternLength(page, pattern, length, { autoFill = false } = {}) {
    if (page < 1 || page > 8) return;
    const pg = this.pages[page];
    if (!pg) return;
    if (pattern < 1 || pattern > 8) return;
    const pat = pg.patterns[pattern];
    if (!pat) return;
    const oldLen = clamp(pat.length_steps || 16, 1, 128);
    const len = clamp(length || pat.length_steps || 16, 1, 128);
    pat.length_steps = len;
    if (autoFill && len > oldLen) {
      const oldBars = Math.max(1, Math.ceil(oldLen / 16));
      const newBars = Math.max(1, Math.ceil(len / 16));
      for (let b = oldBars; b < newBars; b++) {
        // only autofill if target bar is empty to preserve previously entered data
        const start = b * 16;
        const hasData = pat.steps.slice(start, start + 16).some((s) => s?.on);
        if (hasData) continue;
        const src = b % oldBars;
        const snap = this.barSnapshot(page, pattern, src);
        if (snap) this.applyBarSnapshot(page, pattern, b, snap);
      }
    }
    const bars = Math.max(1, Math.ceil(len / 16));
    pat.barView = clamp(pat.barView || 0, 0, bars - 1);
    if (pattern === pg.active_pattern) {
      this.playheads[page] = this.playheads[page] % len;
      this.pageTicks[page] = this.pageTicks[page] || 0;
      this.pageTickPos[page] = -1;
    }
  }

  setPatternTimeScale(page, pattern, scale) {
    if (page < 1 || page > 8) return;
    const pg = this.pages[page];
    if (!pg) return;
    if (pattern < 1 || pattern > 8) return;
    const pat = pg.patterns[pattern];
    if (!pat) return;
    // supported UI options are 1x/2x/4x; clamp to avoid accidental sub-1 values
    const safe = Math.max(1, Math.min(4, Number(scale) || 1));
    pat.time_scale = safe;
    // preserve phase based on accumulated ticks; playhead will be recomputed in tick()
    this.pageTicks[page] = this.pageTicks[page] || 0;
    this.pageTickPos[page] = -1;
  }

  setBarView(page, pattern, bar) {
    if (page < 1 || page > 8) return;
    const pg = this.pages[page];
    if (!pg) return;
    if (pattern < 1 || pattern > 8) return;
    const pat = pg.patterns[pattern];
    if (!pat) return;
    const bars = Math.max(1, Math.ceil((pat.length_steps || 16) / 16));
    const target = clamp(bar ?? 0, 0, bars - 1);
    pat.barView = target;
  }

  setMidiConfig(page, cfg) {
    if (page < 1 || page > 8) return;
    this.midi[page] = { ...this.midi[page], ...cfg };
  }

  setMDSlideFactor(val) {
    const safe = clamp(Number(val) || this.mdSlideFactor || 0.6, 0.1, 2.0);
    this.mdSlideFactor = safe;
  }

  setMDSlideParams({ factor, curve }) {
    if (factor !== undefined) {
      this.mdSlideFactor = clamp(Number(factor) || this.mdSlideFactor || 0.6, 0.1, 2.0);
    }
    if (curve !== undefined) {
      this.mdSlideCurve = clamp(Number(curve) || this.mdSlideCurve || 1.0, 0.2, 3.0);
    }
    if (arguments[0] && arguments[0].baseMs !== undefined) {
      this.mdBaseSweep = clamp(Math.round(arguments[0].baseMs) || this.mdBaseSweep || 80, 20, 200);
    }
  }

  setMonoSlidePad(val) {
    const num = Number(val);
    const safe = clamp(Number.isFinite(num) ? num : (this.monoSlidePad || 0.1), 0, 0.5);
    this.monoSlidePad = safe;
  }

  mdGlide(p, current, target, delayMs, baseSweepMs) {
    const events = [];
    if (current == null) current = target;
    const tau = Math.max(10, Math.round((this.mdSlideFactor || 1) * (baseSweepMs || this.mdBaseSweep || 80)));
    const dt = 8; // ms per control tick
    const steps = Math.max(2, Math.round(tau / dt));
    let val = current;
    const alpha = 1 - Math.exp(-dt / tau);
    for (let i = 0; i < steps; i++) {
      val = val + alpha * (target - val);
      const tDelay = delayMs + i * dt;
      events.push({ delay: tDelay, value: Math.round(val) });
    }
    // ensure final target
    events.push({ delay: delayMs + Math.round(tau), value: Math.round(target) });
    this.mdGlideValue[p] = target;
    return events;
  }

  setLedLevels(levels) {
    const keys = Object.keys(this.ledLevels);
    keys.forEach((k) => {
      if (levels[k] !== undefined) {
        const v = clamp(Math.round(levels[k]), 0, 15);
        this.ledLevels[k] = v;
      }
    });
  }

  setTempo(bpm) {
    this.tempo = clamp(bpm || 120, 20, 300);
  }

  setBaseDivision(div) {
    const options = [12, 16, 24, 32]; // note denominators (1/12..1/32)
    const fallback = 16;
    let val = Number(div) || fallback;
    // backward compat: old values were "per beat" (4=1/16, 2=1/8, 1=1/4, 3=triplet-ish)
    if (val <= 4) val = val * 4; // 1->4, 2->8, 3->12, 4->16
    if (val === 6) val = 24; // map 6 (old 6/beat) to 1/24th denom
    if (val === 8 || val === 16) {
      // keep as-is
    } else if (val === 32 || val === 24 || val === 12) {
      // allowed higher resolutions
    } else {
      val = fallback;
    }
    this.baseDivision = options.includes(val) ? val : fallback;
  }

  setGateLength(length) {
    const options = [0.25, 0.5, 0.75, 1];
    let val = Number(length);
    if (!Number.isFinite(val)) val = 1;
    if (val > 1.01) val = val / 100;
    val = Math.round(val * 100) / 100;
    this.gateLength = options.includes(val) ? val : 1;
  }

  setSwing(val) {
    this.swing = clamp(Math.round(val || 50), 50, 80);
  }

  sanitizeIsomorphicLayout(layout = {}) {
    const base = clamp(Math.round(layout.base ?? 24), 0, 127);
    const stepX = clamp(Math.round(layout.stepX ?? 2), -24, 24);
    const stepY = clamp(Math.round(layout.stepY ?? 7), -24, 24);
    return { base, stepX, stepY };
  }

  getIsomorphicLayoutDefaults(scaleMode, base) {
    const safeBase = clamp(Math.round(base ?? this.isomorphicLayout?.base ?? 24), 0, 127);
    return { base: safeBase, stepX: 1, stepY: 3 };
  }

  setIsomorphicLayout(layout = {}) {
    const next = this.sanitizeIsomorphicLayout(layout);
    const prev = this.isomorphicLayout || {};
    if (prev.base === next.base && prev.stepX === next.stepX && prev.stepY === next.stepY) return false;
    this.isomorphicLayout = next;
    this.forceLedRefresh = true;
    if (typeof this.requestRender === "function") this.requestRender();
    return true;
  }

  setScale(root, mode) {
    const modes = ["major", "minor", "dorian", "mixolydian", "lydian", "phrygian", "locrian", "harmonic_minor", "melodic_minor", "whole_tone", "chromatic"];
    const safeMode = modes.includes(mode) ? mode : (this.scale.mode || "major");
    this.scale = { root: clamp(root ?? this.scale.root ?? 0, -24, 24), mode: safeMode };
    this.setIsomorphicLayout(this.getIsomorphicLayoutDefaults(safeMode, this.isomorphicLayout?.base));
    this.forceLedRefresh = true;
    if (typeof this.requestRender === "function") this.requestRender();
  }

  setTranspose(page, semitones) {
    if (page < 1 || page > 8) return;
    // transpose is per-octave only, clamped to +/-2 octaves
    const oct = clamp(Math.round((semitones || 0) / 12), -2, 2);
    this.pages[page].transpose = oct * 12;
  }

  setDeviceName(page, name) {
    if (page < 1 || page > 8) return;
    const clean = String(name || "").trim().slice(0, 24) || `Device ${page}`;
    this.pages[page].name = clean;
    this.deviceNames[page] = clean;
  }

  setDeviceNote(page, note) {
    if (page < 1 || page > 8) return;
    const text = String(note || "").slice(0, 400);
    this.pages[page].note = text;
    this.deviceNotes[page] = text;
  }

  setDeviceColor(page, color) {
    if (page < 1 || page > 8) return;
    const clean = /^#([0-9a-fA-F]{6})$/.test(color || "") ? color : "#ffb703";
    this.pages[page].color = clean;
    this.deviceColors[page] = clean;
  }

  setSequencerType(page, type) {
    if (page < 1 || page > 8) return;
    if (!["mono", "poly", "drum", "cc", "mdtonal"].includes(type)) return;
    const pg = this.pages[page];
    if (!pg) return;
    const prevType = pg.sequencerType || "mono";
    pg.sequencerType = type;
    this.sequencerTypes[page] = type;
    if (type === "mdtonal") {
      // translate existing mono slides into mdSlide so glide intent carries over
      pg.patterns.forEach((pat, idx) => {
        if (!pat || idx === 0 || !Array.isArray(pat.steps)) return;
        pat.steps.forEach((s) => {
          if (s?.slide) s.mdSlide = true;
        });
      });
    } else if (type === "poly" && prevType !== "poly") {
      pg.patterns.forEach((pat, idx) => {
        if (!pat || idx === 0 || !Array.isArray(pat.steps)) return;
        pat.steps.forEach((s) => {
          if (!s?.slide) return;
          const deg = s.degree ?? 0;
          if (!s.noteSlides || typeof s.noteSlides !== "object") s.noteSlides = {};
          s.noteSlides[deg] = true;
          s.slide = false;
        });
      });
    } else if (type === "mono" && prevType === "mdtonal") {
      // translate mdSlides back into mono slides when leaving mdtonal
      pg.patterns.forEach((pat, idx) => {
        if (!pat || idx === 0 || !Array.isArray(pat.steps)) return;
        pat.steps.forEach((s) => {
          if (s?.mdSlide) {
            s.slide = true;
            s.mdSlide = false;
          }
        });
      });
    }
  }

  setDrumNote(page, row, note) {
    if (page < 1 || page > 8) return;
    if (row < 0 || row > 7) return;
    const pg = this.pages[page];
    if (!pg) return;
    if (!Array.isArray(pg.drumNotes)) pg.drumNotes = [36, 38, 42, 46, 49, 51, 57, 60];
    const val = clamp(Math.round(note || 0), 0, 127);
    pg.drumNotes[row] = val;
  }

  setCCNumber(page, cc) {
    if (page < 1 || page > 8) return;
    const pg = this.pages[page];
    if (!pg) return;
    const val = clamp(Math.round(cc ?? DEFAULT_CC), 0, 127);
    pg.ccNumber = val;
  }

  setMDTrack(page, track) {
    if (page < 1 || page > 8) return;
    const pg = this.pages[page];
    if (!pg) return;
    const safe = clamp(Math.round(track || 1), 1, 16);
    pg.mdTrack = safe;
  }

  snapshot() {
    // deep-ish copy of state for export
    const pages = this.pages.map((p, idx) => {
      if (idx === 0 || !p) return null;
      const patterns = p.patterns.map((pat, pi) => {
        if (pi === 0 || !pat) return null;
        if (!this.patternHasData(idx, pi)) return null;
        return {
          length_steps: pat.length_steps,
          root: pat.root,
          scale_mode: pat.scale_mode,
          time_scale: pat.time_scale,
          change_mode: pat.change_mode,
          barView: pat.barView || 0,
          steps: pat.steps.map((s) => ({
            on: !!s.on,
            degree: s.degree || 0,
            octave: s.octave || 0,
            micro: this.clampMicro(s.micro || 0),
            accent: !!s.accent,
            slide: !!s.slide,
            chain: !!s.chain,
            cc: clamp(Math.round(s.cc || 0), 0, 127),
            notes: Array.isArray(s.notes) ? s.notes.slice() : [],
            accented: Array.isArray(s.accented) ? s.accented.slice() : [],
            noteOctaves: this.sanitizeNoteOctaves(s.noteOctaves),
            noteMicros: this.sanitizeNoteMicros(s.noteMicros),
            noteSlides: this.sanitizeNoteSlides(s.noteSlides)
          }))
        };
      });
        return {
          name: p.name,
          note: p.note,
          color: p.color,
          active_pattern: 1,
          sequencerStopped: false,
          muted: !!p.muted, // legacy export
          transpose: p.transpose || 0,
          sequencerType: p.sequencerType || "mono",
        drumNotes: Array.isArray(p.drumNotes) ? p.drumNotes.slice(0, 8) : undefined,
        ccNumber: clamp(Math.round(p.ccNumber ?? DEFAULT_CC), 0, 127),
        mdTrack: clamp(Math.round(p.mdTrack || 1), 1, 16),
        patterns
      };
    });
    return {
      setName: this.setName,
      tempo: this.tempo,
      swing: this.swing,
      microFormat: "int96",
      scale: this.scale,
      sequencerTypes: this.pages.map((p, idx) => (idx === 0 ? null : p?.sequencerType || "mono")),
      pages,
      deviceNames: this.deviceNames,
      deviceNotes: this.deviceNotes,
      deviceColors: this.deviceColors,
      deviceOrder: this.deviceOrder,
      midi: this.midi,
      ccNumbers: this.pages.map((p, idx) => (idx === 0 ? null : clamp(Math.round(p?.ccNumber ?? DEFAULT_CC), 0, 127))),
      mdTracks: this.pages.map((p, idx) => (idx === 0 ? null : clamp(Math.round(p?.mdTrack || 1), 1, 16))),
    };
  }

  loadSnapshot(snap) {
    if (!snap || typeof snap !== "object") return false;
    const legacyMicro = snap.microFormat !== "int96";
    if (typeof snap.setName === "string") {
      this.setSetName(snap.setName);
    }
    if (snap.tempo) this.tempo = clamp(Number(snap.tempo) || 120, 20, 300);
    if (snap.swing) this.swing = clamp(Number(snap.swing) || 50, 50, 80);
    if (snap.scale && typeof snap.scale === "object") {
      this.scale = {
        root: clamp(Number(snap.scale.root) || 0, -24, 24),
        mode: snap.scale.mode || "major"
      };
    }
    if (Array.isArray(snap.deviceNames)) this.deviceNames = snap.deviceNames.slice(0, 9);
    if (Array.isArray(snap.deviceNotes)) this.deviceNotes = snap.deviceNotes.slice(0, 9);
    if (Array.isArray(snap.deviceColors)) this.deviceColors = snap.deviceColors.slice(0, 9);
    if (Array.isArray(snap.deviceOrder)) this.deviceOrder = this.normalizeDeviceOrder(snap.deviceOrder);
    if (Array.isArray(snap.midi)) this.midi = snap.midi.slice(0, 9);
    if (Array.isArray(snap.ccNumbers)) {
      snap.ccNumbers.forEach((cc, idx) => {
        if (idx >= 1 && idx <= 8 && this.pages[idx]) {
          this.pages[idx].ccNumber = clamp(Math.round(cc ?? this.pages[idx].ccNumber ?? DEFAULT_CC), 0, 127);
        }
      });
    }
    if (Array.isArray(snap.mdTracks)) {
      snap.mdTracks.forEach((t, idx) => {
        if (idx >= 1 && idx <= 8 && this.pages[idx]) {
          this.pages[idx].mdTrack = clamp(Math.round(t || 1), 1, 16);
        }
      });
    }

    if (Array.isArray(snap.pages)) {
      for (let p = 1; p <= 8; p++) {
        const pageSnap = snap.pages[p];
        if (!pageSnap) continue;
        const page = this.pages[p];
        page.name = pageSnap.name || page.name;
        page.note = pageSnap.note || page.note;
        page.color = pageSnap.color || page.color;
        // page.muted = typeof pageSnap.muted === "boolean" ? pageSnap.muted : !!page.muted; // legacy mute restore
        page.sequencerStopped = false;
        page.pendingStop = null;
        page.pendingMute = null; // legacy mute flag
        page.sequencerType = pageSnap.sequencerType || page.sequencerType || "mono";
        this.sequencerTypes[p] = page.sequencerType;
        page.transpose = clamp(pageSnap.transpose || 0, -24, 24);
        page.ccNumber = clamp(Math.round(pageSnap.ccNumber ?? page.ccNumber ?? DEFAULT_CC), 0, 127);
        page.mdTrack = clamp(Math.round(pageSnap.mdTrack || page.mdTrack || 1), 1, 16);
        if (Array.isArray(pageSnap.drumNotes)) page.drumNotes = pageSnap.drumNotes.slice(0, 8).map((n) => clamp(Number(n) || 0, 0, 127));
        page.active_pattern = 1;
        if (Array.isArray(pageSnap.patterns)) {
          for (let pi = 1; pi <= 8; pi++) {
            const patSnap = pageSnap.patterns[pi];
            if (!patSnap) {
              page.patterns[pi] = this.makeEmptyPattern();
              continue;
            }
            const pat = page.patterns[pi] || this.makeEmptyPattern();
            page.patterns[pi] = pat;
            pat.length_steps = clamp(patSnap.length_steps || pat.length_steps, 1, 128);
            pat.root = patSnap.root || 0;
            pat.scale_mode = patSnap.scale_mode || "major";
            const snapScale = patSnap.time_scale || pat.time_scale || 1;
            pat.time_scale = Math.max(1, Math.min(4, Number(snapScale) || 1));
            pat.change_mode = patSnap.change_mode || pat.change_mode;
            pat.barView = clamp(patSnap.barView || 0, 0, Math.max(0, Math.ceil(pat.length_steps / 16) - 1));
            if (Array.isArray(patSnap.steps)) {
              for (let si = 0; si < pat.steps.length && si < patSnap.steps.length; si++) {
                const ss = patSnap.steps[si];
                if (!ss) continue;
                pat.steps[si] = {
                  on: !!ss.on,
                  degree: clamp(ss.degree || 0, 0, 6),
                  octave: clamp(ss.octave || 0, -3, 4),
                  micro: this.normalizeMicroValue(ss.micro || 0, { legacy: legacyMicro }),
                  accent: !!ss.accent,
                  slide: !!ss.slide,
                  tie: !!ss.tie,
                  cc: clamp(Math.round(ss.cc || 0), 0, 127),
                  notes: Array.isArray(ss.notes) ? ss.notes.map((n) => clamp(n, 0, 6)) : [],
                  accented: Array.isArray(ss.accented) ? ss.accented.map((n) => clamp(n, 0, 6)) : [],
                  noteOctaves: this.sanitizeNoteOctaves(ss.noteOctaves),
                  noteMicros: this.sanitizeNoteMicros(ss.noteMicros, { legacy: legacyMicro })
                };
              }
            }
          }
        }
      }
    }
    return true;
  }

  syncPlayheads(tickIndex) {
    const idx = Math.max(0, Math.floor(tickIndex || 0));
    for (let p = 1; p <= 8; p++) {
      const pat = this.pages[p]?.patterns[this.pages[p]?.active_pattern];
      if (!pat) continue;
      const len = Math.max(1, pat.length_steps);
      this.playheads[p] = idx % len;
    }
  }

  getRowInfo(y, opts = {}) {
    const uiMode = !!opts.uiMode;
    const seqType = opts.seqType || this.pages[this.currentPage]?.sequencerType || "mono";
    if (!Number.isFinite(y)) {
      return { stepRow: false, controlRow: false, degree: null, octaveOffset: 0, topRow: false, uiMode };
    }
    if (!uiMode) {
      if (y === 7) return { stepRow: false, controlRow: true, degree: null, octaveOffset: 0, topRow: false, uiMode };
      if (y >= 0 && y < 7) {
        return { stepRow: true, controlRow: false, degree: clamp(6 - y, 0, 6), octaveOffset: 0, topRow: false, uiMode };
      }
      return { stepRow: false, controlRow: false, degree: null, octaveOffset: 0, topRow: false, uiMode };
    }
    if (y < 0 || y > 7) {
      return { stepRow: false, controlRow: false, degree: null, octaveOffset: 0, topRow: false, uiMode };
    }
    if (seqType === "drum") {
      if (y === 0) {
        return { stepRow: true, controlRow: false, degree: 0, octaveOffset: 1, topRow: true, uiMode };
      }
      return { stepRow: true, controlRow: false, degree: clamp(7 - y, 0, 6), octaveOffset: 0, topRow: false, uiMode };
    }
    if (y === 0) {
      return { stepRow: true, controlRow: false, degree: 0, octaveOffset: 1, topRow: true, uiMode };
    }
    return { stepRow: true, controlRow: false, degree: clamp(7 - y, 0, 6), octaveOffset: 0, topRow: false, uiMode };
  }

  noteMatchesRow(step, degree, seqType, rowInfo) {
    if (!step || degree == null) return false;
    if (seqType === "poly" || seqType === "drum") {
      if (!Array.isArray(step.notes) || !step.notes.includes(degree)) return false;
      const oct = this.getNoteOctave(step, degree) || 0;
      if (rowInfo?.topRow) return oct === rowInfo.octaveOffset;
      if (rowInfo?.uiMode && degree === 0 && oct === 1) return false;
      return true;
    }
    if (!step.on || step.degree !== degree) return false;
    const oct = step.octave || 0;
    if (rowInfo?.topRow) return oct === rowInfo.octaveOffset;
    if (rowInfo?.uiMode && degree === 0 && oct === 1) return false;
    return true;
  }

  applySlideChainGesture(x, y, rowInfo, opts = {}) {
    const pat = this.getPattern();
    const page = this.pages[this.currentPage];
    const seqType = page?.sequencerType || "mono";
    if (!pat || !rowInfo?.stepRow) return null;
    if (seqType === "drum" || seqType === "cc" || seqType === "mdtonal") return null;
    if (!this.heldStep) return null;
    const held = this.heldStep;
    if (held.x === x && held.y === y) return null;
    const heldRow = this.getRowInfo(held.y, opts);
    if (!heldRow?.stepRow) return null;
    if (heldRow.degree !== rowInfo.degree || (heldRow.octaveOffset || 0) !== (rowInfo.octaveOffset || 0)) return null;
    const startX = Math.min(held.x, x);
    const endX = Math.max(held.x, x);
    if (endX - startX < 1) return null;
    const bar = pat.barView || 0;
    const len = Math.max(1, pat.length_steps || 16);
    for (let cx = startX; cx <= endX; cx++) {
      const abs = cx + bar * 16;
      if (abs < 0 || abs >= len) return null;
      const step = pat.steps[abs];
      if (!step?.on) return null;
      if (!this.noteMatchesRow(step, rowInfo.degree, seqType, rowInfo)) return null;
      if (cx < endX) {
        const nextStep = pat.steps[abs + 1];
        if (!nextStep?.on || !this.noteMatchesRow(nextStep, rowInfo.degree, seqType, rowInfo)) return null;
        if (seqType === "poly") {
          const octCur = this.getNoteOctave(step, rowInfo.degree);
          const octNext = this.getNoteOctave(nextStep, rowInfo.degree);
          if (octCur !== octNext) return null;
        } else if (seqType === "mono") {
          const octCur = step.octave || 0;
          const octNext = nextStep.octave || 0;
          if (octCur !== octNext) return null;
        }
      }
    }
    const slideProp = seqType === "mdtonal" ? "mdSlide" : "slide";
    const events = [];
    for (let cx = startX; cx < endX; cx++) {
      const abs = cx + bar * 16;
      const step = pat.steps[abs];
      if (!step) continue;
      if (seqType === "poly") {
        if (!step.noteSlides || typeof step.noteSlides !== "object") step.noteSlides = {};
        step.noteSlides[rowInfo.degree] = true;
        step.slide = false;
      } else if (seqType === "mono") {
        step.chain = true;
        step.slide = false;
      } else {
        step[slideProp] = true;
      }
      if (seqType !== "mdtonal") step.tie = false;
      events.push({ type: "slide", x: cx, y: held.y, slide: true });
    }
    if (seqType === "poly") {
      const endAbs = endX + bar * 16;
      const endStep = pat.steps[endAbs];
      if (endStep?.noteSlides && Object.prototype.hasOwnProperty.call(endStep.noteSlides, rowInfo.degree)) {
        delete endStep.noteSlides[rowInfo.degree];
      }
      const len = Math.max(1, pat.length_steps || 16);
      for (let idx = endAbs + 1; idx < len; idx++) {
        const tailStep = pat.steps[idx];
        if (!tailStep?.on || !Array.isArray(tailStep.notes) || !tailStep.notes.includes(rowInfo.degree)) break;
        if (!tailStep.noteSlides || !Object.prototype.hasOwnProperty.call(tailStep.noteSlides, rowInfo.degree)) break;
        delete tailStep.noteSlides[rowInfo.degree];
      }
    } else if (seqType === "mono") {
      const endAbs = endX + bar * 16;
      const endStep = pat.steps[endAbs];
      if (endStep?.chain) endStep.chain = false;
    }
    return events.length ? events : null;
  }

  createChainFromSelection(steps = [], opts = {}) {
    const pat = this.getPattern();
    const page = this.pages[this.currentPage];
    const seqType = page?.sequencerType || "mono";
    const uiMode = !!opts.uiMode;
    if (!pat) return { ok: false, reason: "no_pattern" };
    if (!(seqType === "mono" || seqType === "poly")) return { ok: false, reason: "seq_type" };
    if (!Array.isArray(steps) || steps.length < 2) return { ok: false, reason: "steps" };
    const bar = pat.barView || 0;
    const len = Math.max(1, pat.length_steps || 16);
    const seen = new Set();
    let degree = null;
    let octave = null;
    let startX = Infinity;
    let endX = -Infinity;
    for (const item of steps) {
      const x = Number(item?.x);
      const y = Number(item?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, reason: "steps" };
      const key = `${x}:${y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const rowInfo = this.getRowInfo(y, { uiMode });
      if (!rowInfo?.stepRow) return { ok: false, reason: "row" };
      if (degree == null) degree = rowInfo.degree;
      if (degree !== rowInfo.degree) return { ok: false, reason: "degree" };
      const abs = x + bar * 16;
      if (abs < 0 || abs >= len) return { ok: false, reason: "range" };
      const step = pat.steps[abs];
      if (!step?.on) return { ok: false, reason: "off" };
      if (!this.noteMatchesRow(step, rowInfo.degree, seqType, rowInfo)) return { ok: false, reason: "note" };
      const stepOct = seqType === "poly" ? this.getNoteOctave(step, rowInfo.degree) : (step.octave || 0);
      if (octave == null) octave = stepOct;
      if (octave !== stepOct) return { ok: false, reason: "octave" };
      startX = Math.min(startX, x);
      endX = Math.max(endX, x);
    }
    if (!Number.isFinite(startX) || !Number.isFinite(endX)) return { ok: false, reason: "steps" };
    const expected = endX - startX + 1;
    if (seen.size !== expected) return { ok: false, reason: "gap" };
    for (let cx = startX; cx < endX; cx++) {
      const abs = cx + bar * 16;
      const step = pat.steps[abs];
      if (!step) continue;
      if (seqType === "poly") {
        if (!step.noteSlides || typeof step.noteSlides !== "object") step.noteSlides = {};
        step.noteSlides[degree] = true;
        step.slide = false;
        if (Array.isArray(step.accented)) {
          step.accented = step.accented.filter((n) => n !== degree);
        }
      } else {
        step.chain = true;
        step.slide = false;
        step.tie = false;
        step.accent = false;
      }
    }
    const endAbs = endX + bar * 16;
    const endStep = pat.steps[endAbs];
    if (seqType === "poly") {
      if (endStep?.noteSlides && Object.prototype.hasOwnProperty.call(endStep.noteSlides, degree)) {
        delete endStep.noteSlides[degree];
      }
      if (endStep) {
        endStep.slide = false;
        if (Array.isArray(endStep.accented)) {
          endStep.accented = endStep.accented.filter((n) => n !== degree);
        }
      }
      for (let idx = endAbs + 1; idx < len; idx++) {
        const tailStep = pat.steps[idx];
        if (!tailStep?.on || !Array.isArray(tailStep.notes) || !tailStep.notes.includes(degree)) break;
        if (!tailStep.noteSlides || !Object.prototype.hasOwnProperty.call(tailStep.noteSlides, degree)) break;
        delete tailStep.noteSlides[degree];
      }
    } else if (endStep) {
      if (endStep.chain) endStep.chain = false;
      endStep.slide = false;
      endStep.tie = false;
      endStep.accent = false;
    }
    return { ok: true };
  }

  handleGridKey(x, y, s, opts = {}) {
    const forcePatternControl = !!opts.forcePatternControl;
    const uiMode = !!opts.uiMode;
    const allowAudition = !!opts.allowAudition;
    if (forcePatternControl) {
      return this.handlePatternControlKey(x, y, s);
    }
    // Pattern control toggle (pattern launcher) is always handled first
    const allowPatternControlKey = !uiMode || this.patternControlMode;
    if (allowPatternControlKey && y === 7 && x === PATTERN_CONTROL_BUTTON && this.patternHeld) {
      if (s !== 1) return null;
      return { type: "follow_toggle" };
    }
    if (allowPatternControlKey && y === 7 && x === PATTERN_CONTROL_BUTTON) {
      if (this.patternControlLatch) {
        if (s === 1) {
          this.patternControlMode = !this.patternControlMode;
          this.patternHeld = false;
          this.patternControlHeld = false;
          this.forceLedRefresh = true;
          if (!this.patternControlMode) {
            // this.pendingMuteTick = Array(9).fill(null); // legacy mute scheduling
            this.pendingStopTick = Array(9).fill(null);
            this.pendingPatternTick = Array(9).fill(null);
          }
          return { type: "pattern_control", enabled: this.patternControlMode };
        }
        return null;
      }
      if (s === 1) {
        this.patternControlMode = true;
        this.patternControlHeld = true;
        this.patternHeld = false;
        this.forceLedRefresh = true;
        return { type: "pattern_control", enabled: this.patternControlMode };
      }
      if (s === 0) {
        this.patternControlMode = false;
        this.patternControlHeld = false;
        // this.pendingMuteTick = Array(9).fill(null); // legacy mute scheduling
        this.pendingStopTick = Array(9).fill(null);
        this.pendingPatternTick = Array(9).fill(null);
        this.forceLedRefresh = true;
        return { type: "pattern_control", enabled: this.patternControlMode };
      }
      return null;
    }

    // In pattern control view, map presses to pattern/mute actions per device
    if (this.patternControlMode) {
      return this.handlePatternControlKey(x, y, s);
    }

    // bottom row y=7 for controls
    if (!uiMode && y === 7) {
      if (x >= 9 && x <= 12) {
        if (s !== 1) return null;
        if (this.patternHeld) {
          const lengths = [16, 32, 48, 64];
          const target = x - 9;
          const nextLen = lengths[target];
          if (!nextLen) return null;
          return { type: "pattern_length", page: this.currentPage, pattern: this.pages[this.currentPage]?.active_pattern || 1, length: nextLen };
        }
        const page = this.pages[this.currentPage];
        const patIdx = page?.active_pattern || 1;
        const pat = page?.patterns?.[patIdx];
        if (!pat) return null;
        const bars = Math.max(1, Math.ceil((pat.length_steps || 16) / 16));
        const maxBars = Math.min(4, bars);
        const target = x - 9;
        if (target >= maxBars) return null;
        this.setBarView(this.currentPage, patIdx, target);
        return { type: "bar_view", page: this.currentPage, pattern: patIdx, bar: target };
      }
      if (x === 14) {
        // pattern switch modifier (immediate)
        const wasHeld = this.patternHeld;
        this.patternHeld = s === 1;
        if (allowAudition && wasHeld && s === 0) {
          return this.releaseAuditionHolds();
        }
        return null;
      }
      if (x >= 0 && x <= 7 && !this.patternHeld) {
        const idx = x + 1;
        if (s === 1) {
          if (idx !== this.currentPage) {
            this.setPage(idx);
            return null;
          }
          if (this.deviceTabHoldTimers[idx]) {
            clearTimeout(this.deviceTabHoldTimers[idx]);
            this.deviceTabHoldTimers[idx] = null;
          }
          this.deviceTabHoldFired[idx] = false;
          this.deviceTabHoldTimers[idx] = setTimeout(() => {
            this.deviceTabHoldTimers[idx] = null;
            this.deviceTabHoldFired[idx] = true;
            const res = this.setIsomorphicMode(idx, !this.isIsomorphicMode(idx));
            if (res !== false) {
              this.forceLedRefresh = true;
            }
          }, 300);
          return null;
        }
        if (s === 0) {
          if (this.deviceTabHoldTimers[idx]) {
            clearTimeout(this.deviceTabHoldTimers[idx]);
            this.deviceTabHoldTimers[idx] = null;
          }
          const wasHold = this.deviceTabHoldFired[idx];
          this.deviceTabHoldFired[idx] = false;
          if (wasHold || idx === this.currentPage) return null;
          return null;
        }
      }
      if (s !== 1) return;
      const idx = x + 1;
      if (idx >= 1 && idx <= 8) {
        if (this.patternHeld) {
          this.setPattern(idx, this.currentPage);
          return { type: "pattern_status", page: this.currentPage };
        } else {
          const pageIdx = this.getDeviceByColumn(x);
          this.setPage(pageIdx);
        }
      }
      return;
    }
    const rowInfo = this.getRowInfo(y, { uiMode });
    if (rowInfo.stepRow) {
      if (this.isIsomorphicMode(this.currentPage)) {
        return this.handleIsomorphicKey(x, y, s);
      }
      if (allowAudition && this.patternHeld && !uiMode) {
        return this.handleAuditionKey(x, y, s, rowInfo);
      }
      const page = this.pages[this.currentPage];
      const pat = this.getPattern();
      const len = Math.max(1, pat?.length_steps || 16);
      const abs = pat ? x + pat.barView * 16 : -1;
      if (abs < 0 || abs >= len) return null;
      const step = pat && abs >= 0 ? pat.steps[abs] : null;
      const seqType = page?.sequencerType || "mono";
      if (seqType === "cc") {
        const ccRow = uiMode ? clamp(y - 1, 0, 6) : y;
        return this.handleCCKey(x, ccRow, s, pat);
      }
      const targetDegree = rowInfo.degree;
      const targetOctave = rowInfo.topRow ? rowInfo.octaveOffset : 0;
      const key = `${x},${y}`;
      const heldKey = this.heldStep ? `${this.heldStep.x},${this.heldStep.y}` : null;
      const heldInfo = heldKey ? this.keyHolds.get(heldKey) : null;
      if (s === 1) {
        const now = Date.now();
        const heldAbs = this.heldStep && pat ? this.heldStep.x + pat.barView * 16 : -1;
        const heldStepObj = heldAbs >= 0 ? pat?.steps[heldAbs] : null;
        if (heldInfo?.editMode && heldStepObj?.on) {
          const heldRow = this.getRowInfo(this.heldStep.y, { uiMode });
          const heldMatches = this.noteMatchesRow(heldStepObj, heldRow.degree, seqType, heldRow);
          if (heldMatches) {
            const chainEvents = this.applySlideChainGesture(x, y, rowInfo, { uiMode });
            if (chainEvents) {
              const actionType = seqType === "mdtonal" ? "mdslide" : "slide";
              heldInfo.slideTriggered = true;
              heldInfo.action = actionType;
              heldInfo.actionDone = true;
              this.keyHolds.set(heldKey, heldInfo);
              const timer = this.holdTimers.get(heldKey);
              if (timer) {
                clearTimeout(timer);
                this.holdTimers.delete(heldKey);
              }
              this.heldStepModified = true;
              return chainEvents;
            }
          }
        }
        const multiHoldAny = this.keyHolds.size > 1;
        if (multiHoldAny) {
          this.holdTimers.forEach((t) => clearTimeout(t));
          this.holdTimers.clear();
        }
        const multiHoldActive = this.keyHolds.size > 0 && !this.keyHolds.has(key);
        if (multiHoldActive) this.lastMultiSelectTime = now;
        if (multiHoldAny && heldInfo?.editMode) {
          heldInfo.editMode = false;
          heldInfo.action = null;
          heldInfo.actionDone = false;
          this.keyHolds.set(heldKey, heldInfo);
          this.enqueueOctaveOverlay({ page: this.currentPage, clear: true });
        }
        if (multiHoldActive && !heldInfo?.editMode) {
          this.holdTimers.forEach((t) => clearTimeout(t));
          this.holdTimers.clear();
          this.enqueueOctaveOverlay({ page: this.currentPage, clear: true });
        }
        const wasOn = heldInfo?.wasOn || !!heldStepObj?.on;
        const heldDuration = heldInfo?.start ? (Date.now() - heldInfo.start) : 0;
        const currentAction = heldInfo?.action || null;
        const sameCell = this.heldStep && this.heldStep.x === x && this.heldStep.y === y;
        const upDownNeighbor = this.heldStep && this.heldStep.x === x && Math.abs(this.heldStep.y - y) === 1;
        const leftNeighbor = this.heldStep && this.heldStep.x - 1 === x && this.heldStep.y === y;
        const rightNeighbor = this.heldStep && this.heldStep.x + 1 === x && this.heldStep.y === y;
        // slide must come from a diagonal press in the next column
        const rightDiagonal = this.heldStep && this.heldStep.x + 1 === x && Math.abs(this.heldStep.y - y) === 1;
        const editGesture = sameCell || upDownNeighbor || leftNeighbor || rightNeighbor || rightDiagonal;
        if (heldInfo?.editMode && this.heldStep && !editGesture) {
          return null;
        }
        const multiRecent = now - (this.lastMultiSelectTime || 0) < 150;
        let inEdit = this.heldStep && !multiHoldAny && (heldInfo?.editMode || (heldDuration >= 150 && !multiRecent));
        if (this.heldStep && heldInfo && !heldInfo.editMode && heldDuration >= 150 && !multiHoldAny && !multiRecent) {
          heldInfo.editMode = true;
          this.keyHolds.set(heldKey, heldInfo);
          inEdit = true;
          // entering edit mode: surface current octave for UI/overlay consistency
          if (pat && step?.on) {
            const seqTypeCur = page?.sequencerType || "mono";
            const curOct = seqTypeCur === "poly"
              ? this.getNoteOctave(step, targetDegree)
              : (step.octave || 0);
            this.enqueueOctaveOverlay({ page: this.currentPage, x: this.heldStep.x, y: this.heldStep.y, octave: curOct, delta: 0, fromHold: true });
            const curMicro = this.getNoteMicroOffset(step, targetDegree, seqTypeCur);
            const rawY = uiMode ? (this.heldStep.y === 0 ? 6 : this.heldStep.y - 1) : this.heldStep.y;
            this.enqueueMicroOverlay({
              page: this.currentPage,
              x: this.heldStep.x,
              y: this.heldStep.y,
              rawY,
              microOffset: curMicro,
              delta: 0,
              octave: curOct,
              showZero: true
            });
          }
        }
        // once an edit action is taken, block further presses until the held note is released
        if (inEdit && heldInfo?.actionDone) {
          return null;
        }
        const microEditActive = !!heldInfo?.microEdit;
        if (inEdit && !(sameCell || upDownNeighbor || leftNeighbor || rightNeighbor || rightDiagonal)) {
          return null;
        }
        const seqTypeSlide = page?.sequencerType || "mono";
        const slideAllowed = seqTypeSlide === "mono" &&
          inEdit && rightDiagonal && heldStepObj?.on;
        const mdSlideAllowed = seqTypeSlide === "mdtonal" &&
          inEdit && rightDiagonal && heldStepObj?.on;
        const microNudgeAllowed = inEdit && heldStepObj?.on && (leftNeighbor || rightNeighbor);
        if (microNudgeAllowed) {
          const delta = leftNeighbor ? -1 : 1;
          if (heldInfo) {
            heldInfo.action = "micro";
            heldInfo.actionDone = false;
            heldInfo.microEdit = true;
            this.keyHolds.set(heldKey, heldInfo);
          }
          const res = this.setStepMicroOffset(this.heldStep.x, this.heldStep.y, delta, { uiMode });
          if (res) {
            this.heldStepModified = true;
            const seqTypeHeld = page?.sequencerType || "mono";
            const heldDeg = this.holdTargetDegree != null ? clamp(this.holdTargetDegree, 0, 6) : clamp(6 - this.heldStep.y, 0, 6);
            const heldOct = (seqTypeHeld === "poly" || seqTypeHeld === "drum")
              ? this.getNoteOctave(heldStepObj, heldDeg)
              : (heldStepObj?.octave || 0);
            const rawY = uiMode ? (this.heldStep.y === 0 ? 6 : this.heldStep.y - 1) : this.heldStep.y;
            return {
              type: "micro",
              x: this.heldStep.x,
              y: this.heldStep.y,
              rawY,
              octave: heldOct,
              microOffset: res.microOffset,
              delta: res.delta
            };
          }
          return null;
        }
        if (slideAllowed) {
          heldStepObj.slide = !heldStepObj.slide;
          if (heldInfo) {
            heldInfo.slideTriggered = true;
            heldInfo.action = "slide";
            heldInfo.actionDone = false;
            this.keyHolds.set(heldKey, heldInfo);
          }
          this.heldStepModified = true;
          return { type: "slide", x: this.heldStep.x, y: this.heldStep.y, slide: heldStepObj.slide };
        }
        if (mdSlideAllowed) {
          heldStepObj.mdSlide = !heldStepObj.mdSlide;
          if (heldInfo) {
            heldInfo.slideTriggered = true;
            heldInfo.action = "mdslide";
            heldInfo.actionDone = false;
            this.keyHolds.set(heldKey, heldInfo);
          }
          this.heldStepModified = true;
          return { type: "slide", x: this.heldStep.x, y: this.heldStep.y, slide: heldStepObj.mdSlide };
        }
        const allowNeighborGesture = inEdit && wasOn && upDownNeighbor && (page?.sequencerType || "mono") !== "drum";
        if (allowNeighborGesture) {
          if (heldInfo) {
            heldInfo.action = "octave";
            heldInfo.actionDone = false;
            this.keyHolds.set(heldKey, heldInfo);
          }
          const res = this.handleNeighborGesture(x, y, { uiMode });
          this.heldStepModified = true;
          if (res?.type === "octave") {
            this.enqueueOctaveOverlay({ page: this.currentPage, ...res });
          }
          return res;
        }
        if (inEdit) {
          return null;
        }
        if (!inEdit) {
          const now = Date.now();
          const seqTypeCur = page?.sequencerType || "mono";
          const noteWasOn = this.noteMatchesRow(step, targetDegree, seqTypeCur, rowInfo);
          this.keyHolds.set(key, {
            start: now,
            wasOn: noteWasOn,
            editMode: false,
            action: null,
            actionDone: false,
            microEdit: false,
            uiMode
          });
          this.holdStart = now;
          if (!multiHoldActive) {
            // schedule entry into edit mode after hold threshold
            const timer = setTimeout(() => {
              const info = this.keyHolds.get(key);
              if (!info || info.editMode || this.keyHolds.size > 1) return;
              info.editMode = true;
              this.keyHolds.set(key, info);
              // surface current octave immediately
              const curPat = this.getPattern();
              const curPage = this.pages[this.currentPage];
              const seqTypeNow = curPage?.sequencerType || "mono";
              const absNow = curPat ? x + (curPat.barView || 0) * 16 : -1;
              const stepNow = curPat && absNow >= 0 ? curPat.steps[absNow] : null;
              if (stepNow?.on) {
                const curOct = seqTypeNow === "poly" ? this.getNoteOctave(stepNow, targetDegree) : (stepNow.octave || 0);
                this.enqueueOctaveOverlay({ page: this.currentPage, x, y, octave: curOct, delta: 0, fromHold: true });
                const curMicro = this.getNoteMicroOffset(stepNow, targetDegree, seqTypeNow);
                const rawY = uiMode ? (y === 0 ? 6 : y - 1) : y;
                this.enqueueMicroOverlay({
                  page: this.currentPage,
                  x,
                  y,
                  rawY,
                  microOffset: curMicro,
                  delta: 0,
                  octave: curOct,
                  showZero: true
                });
              }
            }, 150);
            this.holdTimers.set(key, timer);
          }
        }
        this.holdTargetDegree = targetDegree;
        // change/add note on existing step without toggling if pressing a different row in same column
        if (uiMode && step && step.on && (seqType === "poly" || seqType === "drum")) {
          if (Array.isArray(step.notes) && step.notes.includes(targetDegree)) {
            const currentOct = this.getNoteOctave(step, targetDegree);
            if (currentOct !== targetOctave) {
              if (!step.noteOctaves || typeof step.noteOctaves !== "object") step.noteOctaves = {};
              step.noteOctaves[targetDegree] = targetOctave;
              this.heldStep = { x, y };
              this.heldStepModified = true;
              return null;
            }
          }
        }
        const rowMatch = step ? this.noteMatchesRow(step, targetDegree, seqType, rowInfo) : false;
        const prevHeld = this.heldStep && this.heldStep.x === x ? this.heldStep : null;
        const prevHeldY = prevHeld ? prevHeld.y : null;
        const prevRawY = Number.isFinite(prevHeldY)
          ? (uiMode ? (prevHeldY === 0 ? 6 : prevHeldY - 1) : prevHeldY)
          : null;
        const nextRawY = uiMode ? (y === 0 ? 6 : y - 1) : y;
        const queueMicroOverlayShift = (stepObj, seqTypeNow) => {
          if (!stepObj) return;
          if (Number.isFinite(prevRawY) && prevRawY !== nextRawY) {
            this.enqueueMicroOverlay({
              page: this.currentPage,
              x,
              y: prevHeldY,
              rawY: prevRawY,
              microOffset: 0,
              delta: 0,
              showZero: false
            });
          }
          const microOffset = this.getNoteMicroOffset(stepObj, targetDegree, seqTypeNow);
          if (!microOffset) return;
          const octave = (seqTypeNow === "poly" || seqTypeNow === "drum")
            ? this.getNoteOctave(stepObj, targetDegree)
            : (stepObj.octave || 0);
          this.enqueueMicroOverlay({
            page: this.currentPage,
            x,
            y,
            rawY: nextRawY,
            microOffset,
            delta: 0,
            octave
          });
        };
        if (step && step.on && !rowMatch) {
          const prevDegree = step.degree || 0;
          const prevOctave = step.octave || 0;
          const seqTypeCur = page?.sequencerType || "mono";
          if (seqTypeCur === "poly" || seqTypeCur === "drum") {
            if (!Array.isArray(step.notes)) step.notes = [];
            if (step.notes.includes(targetDegree)) {
              if (uiMode && this.getNoteOctave(step, targetDegree) !== targetOctave) {
                if (!step.noteOctaves || typeof step.noteOctaves !== "object") step.noteOctaves = {};
                step.noteOctaves[targetDegree] = targetOctave;
                this.heldStep = { x, y };
                this.heldStepModified = true;
                return null;
              }
              // note already present; just enter hold/edit for this note
              this.heldStep = { x, y };
              this.heldStepModified = false;
              queueMicroOverlayShift(step, seqTypeCur);
              return null;
            }
            step.notes.push(targetDegree);
            step.degree = step.notes[0] ?? targetDegree;
            if (seqTypeCur === "drum") step.slide = false;
            step.accent = false; // per-note accent only
            if (!step.noteOctaves || typeof step.noteOctaves !== "object") step.noteOctaves = {};
            if (!Object.prototype.hasOwnProperty.call(step.noteOctaves, targetDegree)) {
              step.noteOctaves[targetDegree] = uiMode ? targetOctave : (step.octave || 0);
            }
            if (!step.noteMicros || typeof step.noteMicros !== "object") step.noteMicros = {};
            if (!Object.prototype.hasOwnProperty.call(step.noteMicros, targetDegree)) {
              step.noteMicros[targetDegree] = 0;
            }
            if (!step.noteMicros || typeof step.noteMicros !== "object") step.noteMicros = {};
            if (!Object.prototype.hasOwnProperty.call(step.noteMicros, targetDegree)) {
              step.noteMicros[targetDegree] = 0;
            }
            if (!step.noteSlides || typeof step.noteSlides !== "object") step.noteSlides = {};
          } else {
            step.degree = targetDegree;
            step.notes = [targetDegree];
            step.octave = uiMode ? targetOctave : 0;
            if (seqTypeCur === "mono") {
              this.breakChainAtStep(pat, abs, this.currentPage, seqTypeCur);
            }
          }
          step.micro = 0;
          if (seqTypeCur !== "poly" && seqTypeCur !== "drum") {
            if (prevOctave) {
              this.enqueueOctaveOverlay({ page: this.currentPage, x, y: clamp(6 - prevDegree, 0, 6), clear: true });
            }
            if (step.octave) {
              this.enqueueOctaveOverlay({ page: this.currentPage, x, y: clamp(6 - step.degree, 0, 6), octave: step.octave, delta: 0 });
            }
          }
          queueMicroOverlayShift(step, seqTypeCur);
          // if previous step was a tie into this step and pitch now changes, convert previous to slide
          const prevStep = abs > 0 ? pat.steps[abs - 1] : null;
          if ((page?.sequencerType || "mono") === "mono" && prevStep && prevStep.on && prevStep.tie) {
            const modeCur = (this.scale && this.scale.mode) || "major";
            const prevPitch = this.calcPitch(pat.root || 0, modeCur, prevStep.degree || 0, prevStep.octave || 0) + (page?.transpose || 0);
            const curPitch = this.calcPitch(pat.root || 0, modeCur, step.degree || 0, step.octave || 0) + (page?.transpose || 0);
            if (prevPitch !== curPitch) {
              prevStep.tie = false;
              prevStep.slide = true;
            }
          }
          this.heldStep = { x, y };
          this.heldStepModified = true;
          return null;
        } else if (step && !step.on) {
          // immediate turn-on on press
          step.on = true;
          if ((page?.sequencerType || "mono") === "poly" || (page?.sequencerType || "mono") === "drum") {
            step.notes = [targetDegree];
            step.degree = targetDegree;
            step.slide = false;
            step.accent = false; // per-note accent only
            if (!step.noteOctaves || typeof step.noteOctaves !== "object") step.noteOctaves = {};
            if (!Object.prototype.hasOwnProperty.call(step.noteOctaves, targetDegree)) {
              step.noteOctaves[targetDegree] = uiMode ? targetOctave : (step.octave || 0);
            }
            if (!step.noteMicros || typeof step.noteMicros !== "object") step.noteMicros = {};
            if (!Object.prototype.hasOwnProperty.call(step.noteMicros, targetDegree)) {
              step.noteMicros[targetDegree] = 0;
            }
            if (!step.noteSlides || typeof step.noteSlides !== "object") step.noteSlides = {};
          } else {
            step.degree = targetDegree;
            step.notes = [targetDegree];
            step.slide = false;
            if (uiMode) step.octave = targetOctave;
          }
          step.accent = false;
        }
        // begin hold (for octave or accent detection) when not already consumed
        if (!this.heldStep || !this.heldStepModified) {
          this.heldStep = { x, y };
          this.heldStepModified = false;
        }
        return null;
      } else if (s === 0) {
        const key = `${x},${y}`;
        const activeKey = this.heldStep ? `${this.heldStep.x},${this.heldStep.y}` : null;
        const activeHold = activeKey ? this.keyHolds.get(activeKey) : null;
        const holdInfo = this.keyHolds.get(key) || (key === activeKey ? activeHold : null);
        const t = this.holdTimers.get(key);
        if (t) {
          clearTimeout(t);
          this.holdTimers.delete(key);
        }
        // while in edit mode, block other releases from changing state
        if (activeKey && key !== activeKey && activeHold?.editMode && !activeHold?.actionDone) {
          this.keyHolds.delete(key);
          return null;
        }
        if (!holdInfo) {
          this.keyHolds.delete(key);
          return null;
        }
        const seqType = page?.sequencerType || "mono";
        const hasEditAction = !!(holdInfo?.octaveChanged || holdInfo?.slideTriggered || holdInfo?.microEdit || (holdInfo?.action && holdInfo.action !== "accent"));
        const keepEdit = holdInfo?.editMode && !holdInfo?.actionDone && !hasEditAction && key !== activeKey;
        if (!keepEdit) this.keyHolds.delete(key);
        const duration = Date.now() - ((holdInfo && holdInfo.start) || this.holdStart || 0);
        this.holdStart = 0;
        const pat2 = this.getPattern();
        const hx = x;
        const hy = y;
        const abs2 = pat2 ? hx + pat2.barView * 16 : -1;
        const step2 = pat2 && abs2 >= 0 ? pat2.steps[abs2] : null;
        if (!keepEdit) {
          this.heldStep = null;
          this.holdTargetDegree = null;
          this.enqueueOctaveOverlay({ page: this.currentPage, clear: true });
        } else {
          // remain in edit mode waiting for a valid action
          this.heldStep = { x, y };
          return null;
        }
        if (!pat2 || abs2 < 0 || !step2) {
          this.heldStepModified = false;
          return null;
        }
        const targetDeg = rowInfo.degree;
        // long press toggles accent (as long as no other edit action was taken)
        if (duration >= 150 && holdInfo?.wasOn && step2.on && !hasEditAction) {
          if (seqType === "poly" || seqType === "drum") {
            if (!Array.isArray(step2.accented)) step2.accented = [];
            const idx = step2.accented.indexOf(targetDeg);
            if (idx === -1) step2.accented.push(targetDeg);
            else step2.accented.splice(idx, 1);
            // keep step2.accent global off for poly; per-note accents only
            step2.accent = false;
          } else {
            step2.accent = !step2.accent;
          }
          if (holdInfo) {
            holdInfo.action = "accent";
            holdInfo.actionDone = true;
          }
          this.heldStepModified = false;
          return { type: "accent", x: hx, y: hy, accent: seqType === "poly" ? step2.accented.includes(targetDeg) : step2.accent };
        }
        if (this.heldStepModified) {
          const noEditAction = holdInfo?.editMode
            && !holdInfo?.action
            && !holdInfo?.actionDone
            && !holdInfo?.octaveChanged
            && !holdInfo?.slideTriggered;
          const actionBlocksClear = !noEditAction && (holdInfo?.action === "micro"
            || holdInfo?.action === "slide"
            || holdInfo?.action === "mdslide"
            || holdInfo?.octaveChanged
            || holdInfo?.slideTriggered);
          if (actionBlocksClear) {
            this.heldStepModified = false;
            return null;
          }
          if (noEditAction) {
            this.heldStepModified = false;
          }
        }
        if (!holdInfo?.wasOn && step2.on) {
          // if we just turned it on this press, leave it on
          this.heldStepModified = false;
          return null;
        }
        if (holdInfo?.octaveChanged || holdInfo?.slideTriggered) {
          this.heldStepModified = false;
          return null; // keep note on after octave/slide
        }
        if (holdInfo?.wasOn && step2.on) {
          if (seqType === "poly" || seqType === "drum") {
            if (!Array.isArray(step2.notes)) step2.notes = [];
            const idx = step2.notes.indexOf(targetDeg);
            const rowMatch = this.noteMatchesRow(step2, targetDeg, seqType, rowInfo);
            if (idx !== -1 && rowMatch) {
              const prevStep = abs2 > 0 ? pat2.steps[abs2 - 1] : null;
              const inChain = seqType === "poly" && (this.hasPolyNoteSlide(step2, targetDeg) || this.hasPolyNoteSlide(prevStep, targetDeg));
              const chainEndAbs = inChain ? this.polyChainEnd(pat2, abs2, targetDeg) : abs2;
              const prevOct = this.getNoteOctave(step2, targetDeg);
              step2.notes.splice(idx, 1);
              if (Array.isArray(step2.accented)) step2.accented = step2.accented.filter((n) => n !== targetDeg);
              if (step2.noteOctaves && typeof step2.noteOctaves === "object") {
                delete step2.noteOctaves[targetDeg];
              }
              if (step2.noteMicros && typeof step2.noteMicros === "object") {
                delete step2.noteMicros[targetDeg];
              }
              if (step2.noteSlides && typeof step2.noteSlides === "object") {
                delete step2.noteSlides[targetDeg];
              }
              if (prevOct) {
                const clearY = clamp(6 - targetDeg, 0, 6);
                this.enqueueOctaveOverlay({ page: this.currentPage, x: hx, y: clearY, clear: true });
              }
              if (seqType === "poly" && inChain) {
                if (prevStep?.noteSlides && Object.prototype.hasOwnProperty.call(prevStep.noteSlides, targetDeg)) {
                  delete prevStep.noteSlides[targetDeg];
                }
                for (let idx2 = abs2 + 1; idx2 <= chainEndAbs; idx2++) {
                  this.removePolyNoteFromStep(pat2, idx2, targetDeg, this.currentPage);
                }
              }
            }
            if (!step2.notes.length) {
              this.clearStep(pat2, abs2);
            } else {
              step2.degree = step2.notes[0];
              step2.accent = false; // per-note accent only in poly
            }
          } else {
            // short tap release on previously active note toggles off
            this.clearStep(pat2, abs2);
          }
        }
        this.heldStepModified = false;
        return null;
      }
    }
    return null;
  }

  handleAuditionKey(x, y, s, rowInfo) {
    const page = this.pages[this.currentPage];
    if (!page || !rowInfo?.stepRow) return null;
    const seqType = page.sequencerType || "mono";
    if (seqType === "cc") return null;
    const key = `${x},${y}`;
    if (s === 1) {
      if (this.auditionHolds.has(key)) return null;
      const degree = rowInfo.degree ?? 0;
      const octave = rowInfo.topRow ? rowInfo.octaveOffset : 0;
      const pageIdx = this.currentPage;
      const pageTranspose = page.transpose || 0;
      let note = null;
      let channel = clamp(this.midi[pageIdx]?.channel || 1, 1, 16);
      let cc = null;
      let ccValue = null;
      let ccChannel = null;
      if (seqType === "drum") {
        note = this.getDrumPitch(page, degree, octave);
      } else if (seqType === "mdtonal") {
        const trackCfg = this.mdTrackConfig(pageIdx);
        note = trackCfg.noteNumber;
        channel = clamp(trackCfg.noteChannel || channel, 1, 16);
        const value = this.mdCCFromDegree(degree, pageTranspose, octave);
        if (value == null) return null;
        cc = trackCfg.ccNumber;
        ccValue = value;
        ccChannel = clamp(trackCfg.ccChannel || channel, 1, 16);
      } else {
        const mode = (this.scale && this.scale.mode) || "major";
        const pat = page.patterns?.[page.active_pattern];
        const root = pat?.root || 0;
        note = this.calcPitch(root, mode, degree || 0, octave || 0) + pageTranspose;
      }
      if (!Number.isFinite(note)) return null;
      const safeNote = clamp(Math.round(note), 0, 127);
      const vel = 96;
      const hold = { page: pageIdx, note: safeNote, channel, cc, ccValue, ccChannel };
      this.auditionHolds.set(key, hold);
      return { type: "audition", action: "on", velocity: vel, ...hold };
    }
    if (s === 0) {
      const hold = this.auditionHolds.get(key);
      if (!hold) return null;
      this.auditionHolds.delete(key);
      return { type: "audition", action: "off", ...hold };
    }
    return null;
  }

  handleIsomorphicKey(x, y, s) {
    const page = this.pages[this.currentPage];
    if (!page) return null;
    const seqType = page.sequencerType || "mono";
    if (seqType === "cc" || seqType === "drum") return null;
    const key = `iso:${x},${y}`;
    if (s === 1) {
      if (this.auditionHolds.has(key)) return null;
      const info = this.getIsomorphicNoteInfo(x, y, page);
      const pageIdx = this.currentPage;
      let channel = clamp(this.midi[pageIdx]?.channel || 1, 1, 16);
      let cc = null;
      let ccValue = null;
      let ccChannel = null;
      let note = null;
      if (seqType === "mdtonal") {
        const trackCfg = this.mdTrackConfig(pageIdx);
        note = trackCfg.noteNumber;
        channel = clamp(trackCfg.noteChannel || channel, 1, 16);
        const value = this.mdCCFromDegree(info.degree, 0, info.octave);
        if (value == null) return null;
        cc = trackCfg.ccNumber;
        ccValue = value;
        ccChannel = clamp(trackCfg.ccChannel || channel, 1, 16);
      } else {
        const mode = (this.scale && this.scale.mode) || "major";
        const pat = page.patterns?.[page.active_pattern];
        const root = pat?.root || 0;
        note = this.calcPitch(root, mode, info.degree, info.octave);
      }
      if (!Number.isFinite(note)) return null;
      const safeNote = clamp(Math.round(note), 0, 127);
      const hold = { page: pageIdx, note: safeNote, channel, cc, ccValue, ccChannel };
      const events = [];
      if (seqType === "mono" || seqType === "mdtonal") {
        const activeKey = this.isomorphicMonoActive?.[pageIdx];
        if (activeKey && activeKey !== key) {
          const activeHold = this.auditionHolds.get(activeKey);
          if (activeHold) {
            events.push({ type: "audition", action: "off", ...activeHold });
            this.auditionHolds.delete(activeKey);
          }
        }
        if (Array.isArray(this.isomorphicMonoActive)) this.isomorphicMonoActive[pageIdx] = key;
      }
      this.auditionHolds.set(key, hold);
      events.push({ type: "audition", action: "on", velocity: 96, ...hold });
      return events.length === 1 ? events[0] : events;
    }
    if (s === 0) {
      const hold = this.auditionHolds.get(key);
      if (!hold) return null;
      this.auditionHolds.delete(key);
      if (Array.isArray(this.isomorphicMonoActive) && this.isomorphicMonoActive[this.currentPage] === key) {
        this.isomorphicMonoActive[this.currentPage] = null;
      }
      return { type: "audition", action: "off", ...hold };
    }
    return null;
  }

  isIsomorphicMode(page = this.currentPage) {
    const idx = clamp(Math.round(page || 0), 0, 8);
    return !!this.isomorphicModes?.[idx];
  }

  setIsomorphicMode(page, enabled) {
    const idx = clamp(Math.round(page || 0), 1, 8);
    const next = !!enabled;
    if (!this.isomorphicModes || this.isomorphicModes[idx] === next) return false;
    this.isomorphicModes[idx] = next;
    if (!next) {
      if (Array.isArray(this.isomorphicMonoActive)) this.isomorphicMonoActive[idx] = null;
      const released = this.releaseAuditionHolds();
      if (typeof this.requestRender === "function") this.requestRender();
      return released || true;
    }
    if (typeof this.requestRender === "function") this.requestRender();
    return true;
  }

  toggleIsomorphicMode(page) {
    const idx = clamp(Math.round(page || 0), 1, 8);
    const next = !this.isIsomorphicMode(idx);
    return this.setIsomorphicMode(idx, next);
  }

  releaseAuditionHolds() {
    if (!this.auditionHolds.size) return null;
    const events = [];
    this.auditionHolds.forEach((hold) => {
      events.push({ type: "audition", action: "off", ...hold });
    });
    this.auditionHolds.clear();
    return events;
  }

  getStepInfo(x, y, opts = {}) {
    const rowInfo = this.getRowInfo(y, opts);
    if (!rowInfo.stepRow) return { exists: false, on: false };
    const page = this.pages[this.currentPage];
    const pat = this.getPattern();
    if (!pat) return { exists: false, on: false };
    const abs = x + (pat.barView || 0) * 16;
    if (abs < 0 || abs >= pat.steps.length) return { exists: false, on: false };
    const step = pat.steps[abs];
    const nextStep = pat.steps[abs + 1];
    const seqType = page?.sequencerType || "mono";
    const degree = rowInfo.degree;
    const isNoteOn = this.noteMatchesRow(step, degree, seqType, rowInfo);
    const accent = (seqType === "poly" || seqType === "drum")
      ? (isNoteOn && Array.isArray(step?.accented) && step.accented.includes(degree))
      : (isNoteOn && !!step?.accent);
    const slideProp = seqType === "mdtonal" ? "mdSlide" : "slide";
    const canSlide = seqType === "mono" || seqType === "mdtonal";
    const canAccent = seqType !== "cc" && seqType !== "drum";
    const noteSlide = seqType === "poly"
      ? (!!step?.noteSlides?.[degree] || (!step?.noteSlides && step?.slide && degree === (step.degree || 0)))
      : !!step?.[slideProp];
    return {
      exists: !!step,
      on: isNoteOn,
      octave: this.getNoteOctave(step, degree),
      microOffset: this.getNoteMicroOffset(step, degree, seqType),
      accent,
      slide: noteSlide,
      seqType,
      degree,
      canSlide: isNoteOn && canSlide,
      nextOn: !!nextStep?.on,
      canAccent: isNoteOn && canAccent
    };
  }

  setStepAccent(x, y, value, opts = {}) {
    const info = this.getStepInfo(x, y, opts);
    if (!info.exists || !info.on || !info.canAccent) return null;
    const pat = this.getPattern();
    const abs = x + (pat.barView || 0) * 16;
    const step = pat?.steps?.[abs];
    if (!step) return null;
    const targetDeg = info.degree;
    const nextVal = !!value;
    if (info.seqType === "poly" || info.seqType === "drum") {
      if (!Array.isArray(step.accented)) step.accented = [];
      const idx = step.accented.indexOf(targetDeg);
      if (nextVal && idx === -1) step.accented.push(targetDeg);
      if (!nextVal && idx !== -1) step.accented.splice(idx, 1);
      step.accent = false;
      return { accent: step.accented.includes(targetDeg) };
    }
    step.accent = nextVal;
    return { accent: step.accent };
  }

  setStepSlide(x, y, value, opts = {}) {
    const pat = this.getPattern();
    const page = this.pages[this.currentPage];
    const seqType = page?.sequencerType || "mono";
    const rowInfo = this.getRowInfo(y, opts);
    if (!pat || !rowInfo.stepRow) return null;
    const abs = x + (pat.barView || 0) * 16;
    if (abs < 0 || abs >= pat.steps.length) return null;
    const step = pat.steps[abs];
    if (!this.noteMatchesRow(step, rowInfo.degree, seqType, rowInfo)) return null;
    if (seqType === "poly") {
      if (!step.noteSlides || typeof step.noteSlides !== "object") step.noteSlides = {};
      if (value) step.noteSlides[rowInfo.degree] = true;
      else delete step.noteSlides[rowInfo.degree];
      step.slide = false;
      return { slide: !!step.noteSlides[rowInfo.degree] };
    }
    if (seqType !== "mono" && seqType !== "mdtonal") return null;
    const prop = seqType === "mdtonal" ? "mdSlide" : "slide";
    step[prop] = !!value;
    return { slide: step[prop] };
  }

  setStepOctave(x, y, delta, opts = {}) {
    const pat = this.getPattern();
    const page = this.pages[this.currentPage];
    const seqType = page?.sequencerType || "mono";
    const rowInfo = this.getRowInfo(y, opts);
    const skipChainClear = !!opts.skipChainClear;
    if (!pat || !rowInfo.stepRow) return null;
    if (seqType === "drum" || seqType === "cc") return null;
    const abs = x + (pat.barView || 0) * 16;
    if (abs < 0 || abs >= pat.steps.length) return null;
    const step = pat.steps[abs];
    if (!this.noteMatchesRow(step, rowInfo.degree, seqType, rowInfo)) return null;
    const targetDeg = rowInfo.degree;
    if (seqType === "poly") {
      if (!Array.isArray(step.notes) || !step.notes.includes(targetDeg)) return null;
      if (!step.noteOctaves || typeof step.noteOctaves !== "object") step.noteOctaves = {};
      const currentOct = this.getNoteOctave(step, targetDeg);
      const nextOct = clamp((currentOct || 0) + (delta || 0), -2, 2);
      if (nextOct === currentOct) return null;
      const prevStep = abs > 0 ? pat.steps[abs - 1] : null;
      const hasSlideChain = this.hasPolyNoteSlide(step, targetDeg) || this.hasPolyNoteSlide(prevStep, targetDeg);
      const prevInChain = prevStep?.on && this.hasPolyNoteSlide(prevStep, targetDeg)
        && Array.isArray(prevStep.notes) && prevStep.notes.includes(targetDeg)
        && this.getNoteOctave(prevStep, targetDeg) === currentOct;
      const chainStart = hasSlideChain && !prevInChain;
      step.noteOctaves[targetDeg] = nextOct;
      const chainEndAbs = hasSlideChain ? this.polyChainEnd(pat, abs, targetDeg) : abs;
      if (!skipChainClear) {
        if (chainStart && chainEndAbs > abs) {
          const barBase = (pat.barView || 0) * 16;
          for (let idx = abs + 1; idx <= chainEndAbs; idx++) {
            const step2 = pat.steps[idx];
            if (!step2?.on || !Array.isArray(step2.notes) || !step2.notes.includes(targetDeg)) break;
            if (!step2.noteOctaves || typeof step2.noteOctaves !== "object") step2.noteOctaves = {};
            step2.noteOctaves[targetDeg] = nextOct;
            if (idx >= barBase && idx < barBase + 16) {
              const x2 = idx - barBase;
              this.enqueueOctaveOverlay({ page: this.currentPage, x: x2, y, octave: nextOct, delta: delta || 0 });
            }
          }
          this.enqueueOctaveOverlay({ page: this.currentPage, x, y, octave: nextOct, delta: delta || 0 });
          return { octave: nextOct, delta: delta || 0 };
        }
        if (step.noteSlides && Object.prototype.hasOwnProperty.call(step.noteSlides, targetDeg)) {
          delete step.noteSlides[targetDeg];
        }
        if (prevStep?.noteSlides && Object.prototype.hasOwnProperty.call(prevStep.noteSlides, targetDeg)) {
          delete prevStep.noteSlides[targetDeg];
        }
        if (hasSlideChain) {
          for (let idx = abs + 1; idx <= chainEndAbs; idx++) {
            this.removePolyNoteFromStep(pat, idx, targetDeg, this.currentPage);
          }
        }
      }
      this.enqueueOctaveOverlay({ page: this.currentPage, x, y, octave: nextOct, delta: delta || 0 });
      return { octave: nextOct, delta: delta || 0 };
    }
    // keep octave offsets within a musical window
    const nextOct = clamp((step.octave || 0) + (delta || 0), -2, 2);
    if (nextOct === (step.octave || 0)) return null;
    const slideProp = seqType === "mdtonal" ? "mdSlide" : "slide";
    let endAbs = abs;
    if ((seqType === "mono" && step.chain) || (seqType !== "mono" && step[slideProp])) {
      const len = Math.max(1, pat.length_steps || 16);
      while (endAbs < len - 1) {
        const curStep = pat.steps[endAbs];
        const nextStep = pat.steps[endAbs + 1];
        if (seqType === "mono") {
          if (!curStep?.chain || !nextStep?.on) break;
        } else if (!curStep?.[slideProp] || !nextStep?.on) {
          break;
        }
        endAbs += 1;
      }
    }
    step.octave = nextOct;
    if (!skipChainClear) {
      if (seqType === "mono") {
        const prevStep = abs > 0 ? pat.steps[abs - 1] : null;
        const isChainStart = step.chain && !(prevStep?.on && prevStep.chain);
        if (step.chain && isChainStart && endAbs > abs) {
          const barBase = (pat.barView || 0) * 16;
          for (let idx = abs + 1; idx <= endAbs; idx++) {
            const step2 = pat.steps[idx];
            if (!step2?.on) break;
            step2.octave = nextOct;
            if (idx >= barBase && idx < barBase + 16) {
              const x2 = idx - barBase;
              this.enqueueOctaveOverlay({ page: this.currentPage, x: x2, y, octave: nextOct, delta: delta || 0 });
            }
          }
        } else {
          if (step.chain) step.chain = false;
          if (prevStep?.on && prevStep.chain) prevStep.chain = false;
          if (endAbs > abs) {
            for (let idx = abs + 1; idx <= endAbs; idx++) {
              this.clearStep(pat, idx, this.currentPage, { skipChainClear: true, skipAutoClear: true });
            }
          }
        }
      } else {
        if (step[slideProp]) step[slideProp] = false;
        if (abs > 0) {
          const prevStep = pat.steps[abs - 1];
          if (prevStep?.on && prevStep[slideProp]) prevStep[slideProp] = false;
        }
      }
    }
    this.enqueueOctaveOverlay({ page: this.currentPage, x, y, octave: step.octave, delta: delta || 0 });
    return { octave: step.octave, delta: delta || 0 };
  }

  setStepMicroOffset(x, y, delta, opts = {}) {
    const pat = this.getPattern();
    const page = this.pages[this.currentPage];
    const seqType = page?.sequencerType || "mono";
    const rowInfo = this.getRowInfo(y, opts);
    if (!pat || !rowInfo.stepRow) return null;
    const abs = x + (pat.barView || 0) * 16;
    if (abs < 0 || abs >= pat.steps.length) return null;
    const step = pat.steps[abs];
    if (!this.noteMatchesRow(step, rowInfo.degree, seqType, rowInfo)) return null;
    const degree = rowInfo.degree;
    const current = this.getNoteMicroOffset(step, degree, seqType);
    const next = this.setNoteMicroOffset(step, degree, seqType, current + (delta || 0));
    if (next === current) return null;
    const rawY = opts.uiMode ? (y === 0 ? 6 : y - 1) : y;
    const octave = (seqType === "poly" || seqType === "drum")
      ? this.getNoteOctave(step, degree)
      : (step?.octave || 0);
    this.enqueueMicroOverlay({
      page: this.currentPage,
      x,
      y,
      rawY,
      microOffset: next,
      delta: delta || 0,
      octave,
      showZero: true
    });
    return { microOffset: next, delta: delta || 0 };
  }

  moveSteps(steps = [], dx = 0, dy = 0, opts = {}) {
    if (!Array.isArray(steps) || !steps.length) return { ok: false, reason: "empty" };
    const pat = this.getPattern();
    if (!pat) return { ok: false, reason: "no_pattern" };
    const uiMode = !!opts.uiMode;
    const rows = uiMode ? 8 : 7;
    const wrapIndex = (val, max) => {
      if (!max) return 0;
      const mod = val % max;
      return mod < 0 ? mod + max : mod;
    };
    const moves = [];
    for (const step of steps) {
      const x = Number(step?.x);
      const y = Number(step?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const info = this.getStepInfo(x, y, { uiMode });
      if (!info?.on) continue;
      const nx = wrapIndex(x + dx, 16);
      const ny = wrapIndex(y + dy, rows);
      const srcRow = this.getRowInfo(y, { uiMode });
      const dstRow = this.getRowInfo(ny, { uiMode });
      moves.push({ x, y, nx, ny, info, srcRow, dstRow });
    }
    if (!moves.length) return { ok: false, reason: "empty" };

    const absFor = (x) => x + (pat.barView || 0) * 16;
    const clampOctave = (seqType, val) => {
      if (seqType === "poly" || seqType === "drum") return clamp(val, -3, 4);
      return clamp(val, -2, 2);
    };

    moves.forEach((move) => {
      const abs = absFor(move.x);
      const step = pat.steps[abs];
      if (!step) return;
      if (move.info.seqType === "poly" || move.info.seqType === "drum") {
        this.clearStepNoteFromPoly(step, move.info.degree);
        const clearY = clamp(6 - move.info.degree, 0, 6);
        this.enqueueOctaveOverlay({ page: this.currentPage, clears: [{ x: move.x, y: clearY }], clear: true });
        this.enqueueMicroOverlay({ page: this.currentPage, x: move.x, y: clearY, rawY: clearY, microOffset: 0, delta: 0, showZero: false });
        if (!step.notes.length) {
          this.clearStep(pat, abs);
        } else {
          step.degree = step.notes[0];
          step.on = true;
          step.accent = false;
        }
      } else if (this.noteMatchesRow(step, move.info.degree, move.info.seqType, move.srcRow)) {
        this.clearStep(pat, abs);
      }
    });

    moves.forEach((move) => {
      const abs = absFor(move.nx);
      const step = pat.steps[abs];
      if (!step) return;
      const targetDeg = move.dstRow.degree;
      const offsetDelta = (move.dstRow.octaveOffset || 0) - (move.srcRow.octaveOffset || 0);
      const nextOct = clampOctave(move.info.seqType, (move.info.octave || 0) + offsetDelta);
      this.applyMoveOrCopyToStep(step, move, targetDeg, nextOct);
    });

    this.forceLedRefresh = true;
    return { ok: true, moved: moves.length };
  }

  copySteps(steps = [], dx = 0, dy = 0, opts = {}) {
    if (!Array.isArray(steps) || !steps.length) return { ok: false, reason: "empty" };
    const pat = this.getPattern();
    if (!pat) return { ok: false, reason: "no_pattern" };
    const uiMode = !!opts.uiMode;
    const rows = uiMode ? 8 : 7;
    const wrapIndex = (val, max) => {
      if (!max) return 0;
      const mod = val % max;
      return mod < 0 ? mod + max : mod;
    };
    const moves = [];
    for (const step of steps) {
      const x = Number(step?.x);
      const y = Number(step?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const info = this.getStepInfo(x, y, { uiMode });
      if (!info?.on) continue;
      const nx = wrapIndex(x + dx, 16);
      const ny = wrapIndex(y + dy, rows);
      const srcRow = this.getRowInfo(y, { uiMode });
      const dstRow = this.getRowInfo(ny, { uiMode });
      moves.push({ x, y, nx, ny, info, srcRow, dstRow });
    }
    if (!moves.length) return { ok: false, reason: "empty" };

    const absFor = (x) => x + (pat.barView || 0) * 16;
    const clampOctave = (seqType, val) => {
      if (seqType === "poly" || seqType === "drum") return clamp(val, -3, 4);
      return clamp(val, -2, 2);
    };

    moves.forEach((move) => {
      const abs = absFor(move.nx);
      const step = pat.steps[abs];
      if (!step) return;
      const targetDeg = move.dstRow.degree;
      const offsetDelta = (move.dstRow.octaveOffset || 0) - (move.srcRow.octaveOffset || 0);
      const nextOct = clampOctave(move.info.seqType, (move.info.octave || 0) + offsetDelta);
      this.applyMoveOrCopyToStep(step, move, targetDeg, nextOct);
    });

    this.forceLedRefresh = true;
    return { ok: true, moved: moves.length };
  }

  toggleOrSetPattern(n) {
    if (n < 1 || n > 8) return;
    const page = this.pages[this.currentPage];
    if (!page) return;
    const current = page.active_pattern;
    if (current === n) return;
    this.setPattern(n);
  }

  cyclePattern() {
    const page = this.pages[this.currentPage];
    if (!page) return;
    const next = (page.active_pattern % 8) + 1;
    this.toggleOrSetPattern(next);
  }

  // Legacy mute controls retained for reference.
  // toggleDeviceMute(idx) {
  //   const page = this.pages[idx];
  //   if (!page) return;
  //   page.muted = !page.muted;
  //   page.pendingMute = null;
  // }
  //
  // queueDeviceMuteToggle(idx) {
  //   if (idx < 1 || idx > 8) return null;
  //   const page = this.pages[idx];
  //   if (!page) return null;
  //   if (this.tickCount === 0) {
  //     page.muted = !page.muted;
  //     page.pendingMute = null;
  //     this.pendingMuteTick[idx] = null;
  //     return { page: idx, muted: page.muted, immediate: true };
  //   }
  //   const target = page.pendingMute != null ? !page.pendingMute : !page.muted;
  //   page.pendingMute = target;
  //   this.pendingMuteTick[idx] = this.computePendingMuteTick(idx);
  //   return { page: idx, muted: target, pending: true };
  // }
  //
  // queueDeviceMuteSet(idx, muted) {
  //    if (idx < 1 || idx > 8) return null;
  //    const page = this.pages[idx];
  //    if (!page) return null;
  //    if (this.tickCount === 0) {
  //      page.muted = !!muted;
  //      page.pendingMute = null;
  //      this.pendingMuteTick[idx] = null;
  //      return { page: idx, muted: page.muted, immediate: true };
  //    }
  //    page.pendingMute = !!muted;
  //    this.pendingMuteTick[idx] = this.computePendingMuteTick(idx);
  //    return { page: idx, muted: page.pendingMute, pending: true };
  // }
  //
  // computePendingMuteTick(pageIdx) {
  //   const page = this.pages[pageIdx];
  //   if (!page) return null;
  //   return this.computeNextGlobalBarTick();
  // }

  toggleDeviceSequencer(idx) {
    const page = this.pages[idx];
    if (!page) return;
    page.sequencerStopped = !page.sequencerStopped;
    page.pendingStop = null;
  }

  queueDeviceSequencerToggle(idx) {
    if (idx < 1 || idx > 8) return null;
    const page = this.pages[idx];
    if (!page) return null;
    if (this.tickCount === 0) {
      const target = !page.sequencerStopped;
      if (target && !this.deviceHasData(idx)) return null;
      page.sequencerStopped = target;
      page.pendingStop = null;
      this.pendingStopTick[idx] = null;
      return { page: idx, stopped: page.sequencerStopped, immediate: true };
    }
    const target = page.pendingStop != null ? !page.pendingStop : !page.sequencerStopped;
    if (target && !this.deviceHasData(idx)) return null;
    page.pendingStop = target;
    this.pendingStopTick[idx] = this.computePendingStopTick(idx);
    return { page: idx, stopped: target, pending: true };
  }

  queueDeviceSequencerSet(idx, stopped) {
    if (idx < 1 || idx > 8) return null;
    const page = this.pages[idx];
    if (!page) return null;
    const target = !!stopped;
    if (target && !this.deviceHasData(idx)) return null;
    if (this.tickCount === 0) {
      page.sequencerStopped = target;
      page.pendingStop = null;
      this.pendingStopTick[idx] = null;
      return { page: idx, stopped: page.sequencerStopped, immediate: true };
    }
    page.pendingStop = target;
    this.pendingStopTick[idx] = this.computePendingStopTick(idx);
    return { page: idx, stopped: page.pendingStop, pending: true };
  }

  computePendingStopTick(pageIdx) {
    const page = this.pages[pageIdx];
    if (!page) return null;
    return this.computeNextGlobalBarTick();
  }

  computeNextGlobalBarTick() {
    // tickCount is advanced near start of tick(); schedule for next multiple of 16 ticks
    const base = this.tickCount;
    const nextBar = Math.floor(base / 16 + 1) * 16;
    return nextBar;
  }

  handlePatternControlKey(x, y, s) {
    // columns 0..7 -> devices 1..8, rows 0..6 -> patterns 1..7 (top to bottom)
    if (x < 0 || x > 15 || y < 0 || y > 7) return null;
    if (y === 7) {
      // pattern modifier is inert in pattern control view; don't alter mutes/patterns
      if (x === 15) return null;
      if (s !== 1) return null;
      if (x >= 0 && x < 8) {
        const pageIdx = this.getDeviceByColumn(x);
        const stopRes = this.queueDeviceSequencerToggle(pageIdx);
        return stopRes ? { type: "device_sequencer", page: pageIdx } : null;
      }
      return null;
    }
    if (x >= 0 && x < 8 && y >= 0 && y <= 6 && s === 1) {
      const patternIdx = y + 1; // top row = pattern 1
      const pageIdx = this.getDeviceByColumn(x);
      const hasData = this.patternHasData(pageIdx, patternIdx);
      if (hasData) {
        this.setPattern(patternIdx, pageIdx);
        const restart = this.queueDeviceSequencerSet(pageIdx, false);
        return restart ? [{ type: "pattern_status", page: pageIdx }, { type: "device_sequencer", page: pageIdx }] : { type: "pattern_status", page: pageIdx };
      } else {
        const stopRes = this.queueDeviceSequencerSet(pageIdx, true);
        return stopRes ? { type: "device_sequencer", page: pageIdx } : null;
      }
    }
    return null;
  }

  handleNeighborGesture(nx, ny, opts = {}) {
    const pat = this.getPattern();
    if (!pat) return;
    const dy = ny - this.heldStep.y;
    if (dy === 0) return null;
    const delta = dy < 0 ? 1 : -1;
    // reuse setStepOctave so the same path is used for monome/UI updates
    const res = this.setStepOctave(this.heldStep.x, this.heldStep.y, delta, opts);
    if (res) {
      const key = `${this.heldStep.x},${this.heldStep.y}`;
      const info = this.keyHolds.get(key) || {};
      info.octaveChanged = true;
      this.keyHolds.set(key, info);
      this.heldStepModified = true;
      this.enqueueOctaveOverlay({ page: this.currentPage, x: this.heldStep.x, y: this.heldStep.y, octave: res.octave, delta: res.delta });
      return { type: "octave", x: this.heldStep.x, y: this.heldStep.y, octave: res.octave, delta: res.delta };
    }
    return null;
  }

  handleCCKey(x, y, s, pat) {
    if (!pat) return null;
    const abs = x + (pat.barView || 0) * 16;
    const len = Math.max(1, pat.length_steps || 16);
    if (abs < 0 || abs >= len) return null;
    const step = pat.steps[abs];
    if (!step) return null;
    if (s === 1) {
      const value = this.ccValueFromRow(y);
      if (step.on && step.cc === value) {
        this.clearStep(pat, abs);
      } else {
        step.on = true;
        step.cc = value;
        step.degree = clamp(6 - y, 0, 6);
        step.notes = [];
        step.accented = [];
        step.accent = false;
        step.slide = false;
        step.octave = 0;
        step.micro = 0;
        step.noteOctaves = {};
        step.noteMicros = {};
      }
      this.heldStep = null;
      this.heldStepModified = false;
      this.keyHolds.clear();
      return null;
    }
    if (s === 0) {
      const key = `${x},${y}`;
      this.keyHolds.delete(key);
      this.heldStep = null;
      this.heldStepModified = false;
      return null;
    }
    return null;
  }

  setPattern(n, pageIdx = this.currentPage) {
    if (n < 1 || n > 8) return;
    if (pageIdx < 1 || pageIdx > 8) return;
    const page = this.pages[pageIdx];
    if (!page) return;
    if (page.active_pattern === n) {
      page.pending_pattern = null;
      this.pendingPatternTick[pageIdx] = null;
      return;
    }
    // if stopped (no ticks yet), swap immediately so user can edit
    if (this.tickCount === 0) {
      page.active_pattern = n;
      page.pending_pattern = null;
      this.pendingPatternTick[pageIdx] = null;
      page.patterns[page.active_pattern].barView = 0;
      this.playheads[pageIdx] = 0;
      this.pageTicks[pageIdx] = 0;
      this.pageTickPos[pageIdx] = -1;
    } else {
      page.pending_pattern = n; // queue until pattern end
      this.pendingPatternTick[pageIdx] = this.computeNextGlobalBarTick();
    }
  }


  setPage(n) {
    if (n < 1 || n > 8) return false;
    if (this.currentPage === n) return false;
    this.currentPage = n;
    this.forceLedRefresh = true;
    return true;
  }

  getPattern() {
    const page = this.pages[this.currentPage];
    if (!page) return null;
    return page.patterns[page.active_pattern];
  }

  cycleBar() {
    const pat = this.getPattern();
    if (!pat) return;
    const bars = Math.max(1, Math.ceil(pat.length_steps / 16));
    pat.barView = (pat.barView + 1) % bars;
  }

  toggleStep(x, y, targetDegree) {
    const pat = this.getPattern();
    const page = this.pages[this.currentPage];
    const seqType = page?.sequencerType || "mono";
    if (!pat) return null;
    const abs = x + pat.barView * 16;
    const step = pat.steps[abs];
    if (!step) return null;
    const tgt = targetDegree ?? clamp(6 - y, 0, 6); // bottom = lowest
    if (seqType === "poly" || seqType === "drum") {
      if (!Array.isArray(step.notes)) step.notes = [];
      if (!step.noteOctaves || typeof step.noteOctaves !== "object") step.noteOctaves = {};
      const exists = step.notes.includes(tgt);
      if (exists) {
        step.notes = step.notes.filter((n) => n !== tgt);
        if (Array.isArray(step.accented)) step.accented = step.accented.filter((n) => n !== tgt);
        delete step.noteOctaves[tgt];
        if (step.noteMicros && typeof step.noteMicros === "object") {
          delete step.noteMicros[tgt];
        }
        if (!step.notes.length) {
          this.clearStep(pat, abs);
        } else {
          step.degree = step.notes[0];
          step.on = true;
          step.accent = false; // per-note accent only in poly
        }
        this.enqueueOctaveOverlay({ page: this.currentPage, clears: [{ x: abs % 16, y: clamp(6 - tgt, 0, 6) }], clear: true });
        return null;
      }
      step.notes.push(tgt);
      step.on = true;
      step.degree = step.notes[0];
      step.accent = false;
      step.slide = false; // slides disabled in poly
      if (!Object.prototype.hasOwnProperty.call(step.noteOctaves, tgt)) step.noteOctaves[tgt] = 0;
      if (!step.noteMicros || typeof step.noteMicros !== "object") step.noteMicros = {};
      if (!Object.prototype.hasOwnProperty.call(step.noteMicros, tgt)) step.noteMicros[tgt] = 0;
      if (!Array.isArray(step.accented)) step.accented = [];
      return null;
    } else {
      if (!step.on) {
        step.on = true;
        step.degree = tgt;
        step.accent = false;
        step.mdSlide = false;
        return null;
      }
      this.clearStep(pat, abs);
      return null;
    }
  }

  clearStep(pat, abs, pageIdx = this.currentPage, opts = {}) {
    const step = pat.steps[abs];
    if (!step) return;
    const { skipAutoClear = false, patternIdx = null, skipChainClear = false } = opts || {};
    const page = this.pages[pageIdx];
    const seqType = page?.sequencerType || "mono";
    const slideProp = seqType === "mdtonal" ? "mdSlide" : "slide";
    if (!skipChainClear && step.on && seqType === "poly") {
      const degrees = Array.isArray(step.notes) ? step.notes.slice() : [];
      degrees.forEach((deg) => {
        const prevStep = abs > 0 ? pat.steps[abs - 1] : null;
        const inChain = this.hasPolyNoteSlide(step, deg) || this.hasPolyNoteSlide(prevStep, deg);
        if (inChain) {
          this.clearPolyChainTail(pat, abs, deg, pageIdx);
        }
      });
    }
    const chainSeqType = (seqType === "mono" || seqType === "mdtonal") ? seqType : null;
    if (!skipChainClear && chainSeqType) {
      if (this.clearChainFromStart(pat, abs, pageIdx, { skipAutoClear, patternIdx }, chainSeqType)) {
        return;
      }
    }
    if (!skipChainClear && chainSeqType) {
      this.clearChainFromMiddle(pat, abs, pageIdx, { skipAutoClear, patternIdx }, chainSeqType);
    }
    if (abs > 0 && chainSeqType === "mono") {
      const prevStep = pat.steps[abs - 1];
      const prop = this.getChainProp(chainSeqType);
      if (prevStep?.on && prop && prevStep[prop]) {
        prevStep[prop] = false;
      }
    }
    const prevDeg = step.degree || 0;
    const yPos = clamp(6 - prevDeg, 0, 6);
    const xPos = abs % 16;
    // clear slide/tie on this step only; preserve previous links when clearing/moving targets
    step.slide = false;
    step.chain = false;
    step.mdSlide = false;
    step.on = false;
    step.degree = 0;
    step.octave = 0;
    step.micro = 0;
    step.accent = false;
    step.tie = false;
    step.cc = 0;
    const prevNotes = Array.isArray(step.notes) ? step.notes.slice() : [];
    step.notes = [];
    step.accented = [];
    step.noteOctaves = {};
    step.noteMicros = {};
    step.noteSlides = {};
    // clear overlays for the notes that existed on this step
    const clears = [];
    if (prevNotes.length) {
      prevNotes.forEach((deg) => clears.push({ x: xPos, y: clamp(6 - deg, 0, 6) }));
    } else {
      clears.push({ x: xPos, y: yPos });
    }
    this.enqueueOctaveOverlay({ page: pageIdx, clears, clear: true });
    this.enqueueMicroOverlay({ page: pageIdx, x: xPos, y: yPos, rawY: yPos, microOffset: 0, delta: 0, showZero: false });
    if (skipAutoClear) return;
    const len = Math.max(1, pat.length_steps || 16);
    const hasDataInLength = pat.steps.slice(0, len).some((s) => s?.on);
    if (!hasDataInLength) {
      const hasHiddenData = pat.steps.slice(len).some((s) => s?.on);
      if (hasHiddenData) {
        const pg = this.pages[pageIdx];
        const targetPattern = patternIdx || pg?.active_pattern;
        if (targetPattern) this.clearPattern(pageIdx, targetPattern);
      }
    }
  }

  patternSnapshot(page, pattern) {
    if (page < 1 || page > 8) return null;
    const pg = this.pages[page];
    if (!pg) return null;
    const pat = pg.patterns[pattern];
    if (!pat) return null;
    return {
      length_steps: pat.length_steps,
      time_scale: pat.time_scale,
      barView: pat.barView || 0,
      steps: pat.steps.map((s) => ({
        on: !!s.on,
        degree: s.degree || 0,
        octave: s.octave || 0,
        micro: this.clampMicro(s.micro || 0),
        accent: !!s.accent,
        slide: !!s.slide,
        chain: !!s.chain,
        tie: !!s.tie,
        cc: clamp(Math.round(s.cc || 0), 0, 127),
        mdSlide: !!s.mdSlide,
        notes: Array.isArray(s.notes) ? s.notes.slice() : [],
        accented: Array.isArray(s.accented) ? s.accented.slice() : [],
        noteOctaves: this.sanitizeNoteOctaves(s.noteOctaves),
        noteMicros: this.sanitizeNoteMicros(s.noteMicros),
        noteSlides: this.sanitizeNoteSlides(s.noteSlides)
      }))
    };
  }

  applyPatternSnapshot(page, pattern, snap) {
    if (!snap) return;
    if (page < 1 || page > 8) return;
    const pg = this.pages[page];
    if (!pg || pattern < 1 || pattern > 8) return;
    const pat = pg.patterns[pattern];
    if (!pat) return;
    pat.length_steps = clamp(snap.length_steps || pat.length_steps, 1, 128);
    if (snap.time_scale !== undefined) {
      pat.time_scale = Math.max(1, Math.min(4, Number(snap.time_scale) || 1));
    }
    pat.barView = clamp(snap.barView || 0, 0, Math.max(0, Math.ceil(pat.length_steps / 16) - 1));
    for (let i = 0; i < pat.steps.length && i < snap.steps.length; i++) {
      const s = snap.steps[i];
      if (!s) continue;
      pat.steps[i] = {
        on: !!s.on,
        degree: clamp(s.degree || 0, 0, 6),
        octave: clamp(s.octave || 0, -3, 4),
        micro: this.clampMicro(s.micro || 0),
        accent: !!s.accent,
        slide: !!s.slide,
        tie: !!s.tie,
        mdSlide: !!s.mdSlide,
        chain: !!s.chain,
        cc: clamp(Math.round(s.cc || 0), 0, 127),
        notes: Array.isArray(s.notes) ? s.notes.map((n) => clamp(n, 0, 6)) : [],
        accented: Array.isArray(s.accented) ? s.accented.map((n) => clamp(n, 0, 6)) : [],
        noteOctaves: this.sanitizeNoteOctaves(s.noteOctaves),
        noteMicros: this.sanitizeNoteMicros(s.noteMicros),
        noteSlides: this.sanitizeNoteSlides(s.noteSlides)
      };
    }
    if (pattern === pg.active_pattern) {
      this.playheads[page] = this.playheads[page] % pat.length_steps;
      this.pageTicks[page] = this.pageTicks[page] || 0;
      this.pageTickPos[page] = -1;
    }
  }

  barSnapshot(page, pattern, bar) {
    const snap = this.patternSnapshot(page, pattern);
    if (!snap) return null;
    const start = (bar || 0) * 16;
    const end = Math.min(start + 16, snap.steps.length);
    return {
      length_steps: snap.length_steps,
      bar,
      steps: snap.steps.slice(start, end)
    };
  }

  applyBarSnapshot(page, pattern, bar, snap) {
    if (!snap) return;
    const pg = this.pages[page];
    if (!pg || pattern < 1 || pattern > 8) return;
    const pat = pg.patterns[pattern];
    if (!pat) return;
    const len = Math.max(1, pat.length_steps || 16);
    const bars = Math.max(1, Math.ceil(len / 16));
    const barIdx = clamp(bar || 0, 0, bars - 1);
    const start = barIdx * 16;
    for (let i = 0; i < 16 && (start + i) < pat.steps.length; i++) {
      const s = snap.steps?.[i];
      if (!s) {
        this.clearStep(pat, start + i);
        continue;
      }
      pat.steps[start + i] = {
        on: !!s.on,
        degree: clamp(s.degree || 0, 0, 6),
        octave: clamp(s.octave || 0, -3, 4),
        micro: this.clampMicro(s.micro || 0),
        accent: !!s.accent,
        slide: !!s.slide,
        tie: !!s.tie,
        mdSlide: !!s.mdSlide,
        chain: !!s.chain,
        cc: clamp(Math.round(s.cc || 0), 0, 127),
        notes: Array.isArray(s.notes) ? s.notes.map((n) => clamp(n, 0, 6)) : [],
        accented: Array.isArray(s.accented) ? s.accented.map((n) => clamp(n, 0, 6)) : [],
        noteOctaves: this.sanitizeNoteOctaves(s.noteOctaves),
        noteMicros: this.sanitizeNoteMicros(s.noteMicros),
        noteSlides: this.sanitizeNoteSlides(s.noteSlides)
      };
    }
  }

  patternHasData(pageIdx, patternIdx) {
    if (pageIdx < 1 || pageIdx > 8) return false;
    if (patternIdx < 1 || patternIdx > 8) return false;
    const pat = this.pages[pageIdx]?.patterns?.[patternIdx];
    if (!pat || !Array.isArray(pat.steps)) return false;
    return pat.steps.some((s) => s?.on);
  }

  deviceHasData(pageIdx) {
    if (pageIdx < 1 || pageIdx > 8) return false;
    const patterns = this.pages[pageIdx]?.patterns;
    if (!Array.isArray(patterns)) return false;
    return patterns.some((pat, idx) => idx > 0 && Array.isArray(pat?.steps) && pat.steps.some((s) => s?.on));
  }

  clearPattern(page, pattern) {
    if (page < 1 || page > 8) return;
    const pg = this.pages[page];
    if (!pg || pattern < 1 || pattern > 8) return;
    const pat = pg.patterns[pattern];
    if (!pat) return;
    pat.steps.forEach((_, idx) => this.clearStep(pat, idx, page, { skipAutoClear: true, patternIdx: pattern }));
    this.enqueueOctaveOverlay({ page, clearAll: true });
  }

  clearBar(page, pattern, bar) {
    if (page < 1 || page > 8) return;
    const pg = this.pages[page];
    if (!pg || pattern < 1 || pattern > 8) return;
    const pat = pg.patterns[pattern];
    if (!pat) return;
    const len = Math.max(1, pat.length_steps || 16);
    const bars = Math.max(1, Math.ceil(len / 16));
    const barIdx = clamp(bar || 0, 0, bars - 1);
    const start = barIdx * 16;
    for (let i = 0; i < 16 && (start + i) < pat.steps.length; i++) {
      this.clearStep(pat, start + i, page, { skipAutoClear: true, patternIdx: pattern });
    }
    const hasDataInLength = pat.steps.slice(0, len).some((s) => s?.on);
    if (!hasDataInLength) {
      this.clearPattern(page, pattern);
      return;
    }
    this.enqueueOctaveOverlay({ page, clearAll: true });
  }

  shiftPattern(page = this.currentPage, pattern = this.pages[this.currentPage]?.active_pattern || 1, opts = {}) {
    if (page < 1 || page > 8) return false;
    if (pattern < 1 || pattern > 8) return false;
    const pg = this.pages[page];
    if (!pg) return false;
    const pat = pg.patterns[pattern];
    if (!pat) return false;
    const len = Math.max(1, pat.length_steps || 16);
    if (!len) return false;
    const seqType = pg.sequencerType || "mono";
    const dxRaw = Number.isFinite(Number(opts.dx)) ? Math.round(Number(opts.dx)) : 0;
    const dyRaw = Number.isFinite(Number(opts.dy)) ? Math.round(Number(opts.dy)) : 0;
    const barRaw = Number.isFinite(Number(opts.bar)) ? Math.round(Number(opts.bar)) : null;
    const bars = Math.max(1, Math.ceil(len / 16));
    const barIdx = barRaw == null ? null : clamp(barRaw, 0, bars - 1);
    const barStart = barIdx == null ? 0 : barIdx * 16;
    const barLen = barIdx == null ? len : Math.max(0, Math.min(16, len - barStart));
    let changed = false;

    // shift horizontally (wrap within the active pattern length)
    if (dxRaw) {
      const span = barIdx == null ? len : barLen;
      if (span <= 0) return false;
      const norm = ((dxRaw % span) + span) % span;
      if (norm) {
        const nextSteps = pat.steps.slice();
        const start = barIdx == null ? 0 : barStart;
        for (let i = 0; i < span; i++) {
          const dest = start + ((i + norm) % span);
          nextSteps[dest] = pat.steps[start + i];
        }
        pat.steps = nextSteps;
        changed = true;
      }
    }

    // shift vertically (wrap rows) except for CC sequencer
    if (dyRaw && seqType !== "cc") {
      const degreeDelta = -dyRaw; // up arrow = +degree
      const wrapDegree = (deg) => {
        const next = ((deg + degreeDelta) % 7 + 7) % 7;
        return clamp(next, 0, 6);
      };
      const start = barIdx == null ? 0 : barStart;
      const end = barIdx == null ? len : barStart + barLen;
      for (let i = start; i < end; i++) {
        const step = pat.steps[i];
        if (!step?.on) continue;
        if (seqType === "poly" || seqType === "drum") {
          const notes = Array.isArray(step.notes) ? step.notes : [];
          const newNotes = notes.map((n) => wrapDegree(n));
          const newOctaves = {};
          const newMicros = {};
          if (step.noteOctaves && typeof step.noteOctaves === "object") {
            Object.entries(step.noteOctaves).forEach(([degRaw, oct]) => {
              const baseDeg = clamp(Math.round(Number(degRaw) || 0), 0, 6);
              const mapped = wrapDegree(baseDeg);
              newOctaves[mapped] = oct;
            });
          }
          if (step.noteMicros && typeof step.noteMicros === "object") {
            Object.entries(step.noteMicros).forEach(([degRaw, micro]) => {
              const baseDeg = clamp(Math.round(Number(degRaw) || 0), 0, 6);
              const mapped = wrapDegree(baseDeg);
              const nextMicro = this.clampMicro(micro);
              if (nextMicro) newMicros[mapped] = nextMicro;
            });
          }
          step.notes = newNotes;
          step.degree = newNotes[0] ?? wrapDegree(step.degree || 0);
          if (Array.isArray(step.accented)) {
            step.accented = step.accented.map((n) => wrapDegree(n));
          }
          step.noteOctaves = newOctaves;
          step.noteMicros = newMicros;
        } else {
          const nextDeg = wrapDegree(step.degree || 0);
          step.degree = nextDeg;
          step.notes = [nextDeg];
        }
      }
      changed = true;
    }

    if (changed) {
      this.enqueueOctaveOverlay({ page, clearAll: true });
      const overlays = this.octaveOverlaySnapshot?.();
      const pageOverlays = Array.isArray(overlays?.[page]) ? overlays[page] : [];
      pageOverlays.forEach((ov) => {
        if (!ov) return;
        this.enqueueOctaveOverlay({ page, x: ov.x, y: ov.y, rawY: ov.y, octave: ov.octave, delta: 0, silent: true });
      });
      this.heldStep = null;
      this.heldStepModified = false;
      this.heldStepPendingOff = false;
      this.keyHolds.clear();
      this.holdTimers.forEach((t) => clearTimeout(t));
      this.holdTimers.clear();
    }
    return changed;
  }

  tick(follow = false, externalStepMs = null, transportTick = null) {
    const barChanges = [];
    const barPlayheadChanges = [];
    const midiEvents = [];
    this.gatePadMs = externalStepMs ? this.externalGatePadMs : 0;
    this.lastTickTime = Date.now();
    const currentTick = this.tickCount; // use pre-increment tick for alignment
    const baseTickExt = Number.isFinite(transportTick) ? transportTick : (this.tickCount * TICKS_PER_STEP_EXT);
    const baseTick = extToIntTick(baseTickExt);
    this.pulse = (currentTick % 4) === 0; // pulse on quarter notes (assuming 1/16 ticks)
    const isGlobalBarBoundary = (currentTick % 16) === 0;
    const patternSwitches = [];
    for (let p = 1; p <= 8; p++) {
      const page = this.pages[p];
      if (!page) continue;

      // apply pending pattern/mute at bar boundary before processing steps
      if (page.pending_pattern && (isGlobalBarBoundary || (this.pendingPatternTick[p] != null && currentTick >= this.pendingPatternTick[p]))) {
        const nextPat = page.patterns[page.pending_pattern];
        if (nextPat) {
          const prevIdx = page.active_pattern;
          page.active_pattern = page.pending_pattern;
          page.pending_pattern = null;
          this.pendingPatternTick[p] = null;
          page.patterns[page.active_pattern].barView = 0;
          const prevPat = page.patterns[prevIdx];
          // if (prevPat) prevPat.muted = false; // legacy mute cleanup
          this.playheads[p] = 0;
          this.pageTicks[p] = 0;
          this.pageTickPos[p] = -1;
          patternSwitches.push({ page: p, active: page.active_pattern });
          barChanges.push({ page: p, pattern: page.active_pattern, bar: 0 });
        }
      }
      if (page.pendingStop != null) {
        const targetTick = this.pendingStopTick[p];
        const shouldApplyStop = (targetTick == null && isGlobalBarBoundary) || (targetTick != null && currentTick >= targetTick);
        if (shouldApplyStop) {
          const targetStop = !!page.pendingStop;
          if (targetStop && !this.deviceHasData(p)) {
            page.pendingStop = null;
            this.pendingStopTick[p] = null;
          } else {
            page.sequencerStopped = targetStop;
            page.pendingStop = null;
            this.pendingStopTick[p] = null;
            if (!page.sequencerStopped) {
              this.pageTicks[p] = 0;
              this.pageTickPos[p] = -1;
              this.playheads[p] = 0;
            }
          }
        }
      }

      let pat = page.patterns[page.active_pattern];
      if (!pat) continue;
      if (page.sequencerStopped) {
        continue; // skip processing while stopped; playhead stays parked
      }
      const scaleFactor = Math.max(1, Math.round(pat.time_scale || 1)); // 1x/2x/4x
      const currentTicks = this.pageTicks[p] || 0;
      const len = Math.max(1, pat.length_steps);
      const stepPos = Math.floor(currentTicks / scaleFactor) % len;
      const prevPos = this.pageTickPos[p] ?? -1;
      const canWrapSlide = prevPos === (len - 1);
      this.pageTicks[p] = currentTicks + 1;
      if (prevPos === stepPos) {
        continue; // no new step to process this tick at this scale
      }
      const currentBar = Math.floor(stepPos / 16);
      const prevBar = prevPos >= 0 ? Math.floor(prevPos / 16) : null;
      if (prevBar == null || currentBar !== prevBar) {
        barPlayheadChanges.push({ page: p, pattern: page.active_pattern, bar: currentBar });
      }
      // skip a step if it was merged by a previous slide-to-same-note (mono only)
      const skipCurrentStep = this.skipNextNote && this.skipNextNote[p] === stepPos;
      if (skipCurrentStep) {
        delete this.skipNextNote[p];
        this.pageTickPos[p] = stepPos;
        this.playheads[p] = stepPos;
      }
      this.pageTickPos[p] = stepPos;
      this.playheads[p] = stepPos;
      const pos = stepPos;
      const step = pat.steps[pos];
      const nextStep = pat.steps[(pos + 1) % len];
      const prevStep = pat.steps[(pos - 1 + len) % len];
      const seqTypePlay = page.sequencerType || "mono";
      const skipMdNote = (seqTypePlay === "mdtonal" && this.skipNextMDNote && this.skipNextMDNote[p] === pos);
      if (skipMdNote) {
        delete this.skipNextMDNote[p];
      }
      const baseDur = externalStepMs ? (externalStepMs * scaleFactor) : this.stepDurationMs(scaleFactor);
      const swingAmt = Math.max(0, Math.min(0.5, (this.swing || 50) > 50 ? (this.swing - 50) / 60 : 0));
      const swingOffsetTicks = (pos % 2 === 1) ? Math.round(TICKS_PER_STEP_INT * swingAmt) : 0;
      const chan = clamp(this.midi[p]?.channel || 1, 1, 16);
      // Legacy mute path kept for reference:
      // if (page.muted) {
      //   // advance playhead but skip emitting notes
      // } else if (seqTypePlay === "mdtonal") { ... }
      if (!skipCurrentStep) {
        if (seqTypePlay === "mdtonal") {
          if (step?.on) {
            const trackCfg = this.mdTrackConfig(p);
            const pageTranspose = this.pages[p]?.transpose || 0;
            const value = this.mdCCFromDegree(step.degree || 0, pageTranspose, step.octave || 0);
            const microOffset = this.getNoteMicroOffset(step, step.degree || 0, seqTypePlay);
            const eventTick = baseTick + swingOffsetTicks + microOffset;
            const emit = microOffset >= 0;
            const delayMs = 0;
            if (value != null) {
              const slideActive = step.mdSlide && nextStep?.on;
              if (slideActive) {
                const nextValue = this.mdCCFromDegree(nextStep.degree || 0, pageTranspose, nextStep.octave || 0);
                const fromVal = value;
                const targetVal = nextValue != null ? nextValue : value;
                // ensure the first slide step sets its own pitch immediately
                if (emit) {
                  midiEvents.push({
                    type: "midi_cc",
                    page: p,
                    tick: eventTick,
                    cc: trackCfg.ccNumber,
                    value: fromVal,
                    delayMs,
                    chan: trackCfg.ccChannel
                  });
                }
                this.mdGlideValue[p] = fromVal;
                const glideEvents = this.mdGlide(p, fromVal, targetVal, baseDur, this.mdBaseSweep);
                if (emit) {
                  glideEvents.forEach((ev) => {
                    midiEvents.push({
                      type: "midi_cc",
                      page: p,
                      tick: eventTick,
                      cc: trackCfg.ccNumber,
                      value: ev.value,
                      delayMs: ev.delay,
                      chan: trackCfg.ccChannel
                    });
                  });
                }
                this.skipNextMDNote = this.skipNextMDNote || {};
                this.skipNextMDNote[p] = (pos + 1) % len;
              } else {
                if (emit) {
                  midiEvents.push({
                    type: "midi_cc",
                    page: p,
                    tick: eventTick,
                    cc: trackCfg.ccNumber,
                    value,
                    delayMs,
                    chan: trackCfg.ccChannel
                  });
                }
                this.mdGlideValue[p] = value;
              }
              if (!skipMdNote) {
                const noteDur = this.gateDurationMs(baseDur * 0.5);
                if (emit) {
                  this.pushMidiNote(midiEvents, {
                    type: "midi_note",
                    page: p,
                    tick: eventTick,
                    pitch: trackCfg.noteNumber,
                    vel: step.accent ? 120 : 96,
                    durMs: noteDur,
                    delayMs,
                    chan: trackCfg.noteChannel,
                    accent: !!step.accent,
                    td3Slide: false
                  });
                }
              }
            }
          }
        } else if (seqTypePlay === "cc") {
          if (step?.on) {
            const chan = clamp(this.midi[p]?.channel || 1, 1, 16);
            const ccNum = clamp(Math.round(page.ccNumber ?? DEFAULT_CC), 0, 127);
            const value = clamp(Math.round(step.cc ?? 0), 0, 127);
            const microOffset = this.getNoteMicroOffset(step, step.degree || 0, seqTypePlay);
            const eventTick = baseTick + swingOffsetTicks + microOffset;
            const emit = microOffset >= 0;
            if (emit) {
              midiEvents.push({ type: "midi_cc", page: p, tick: eventTick, cc: ccNum, value, delayMs: 0, chan });
            }
          }
        } else if (step?.on) {
          // Note duration should stay at base 16th regardless of pattern time scale
          {
            const degrees = (seqTypePlay === "poly" || seqTypePlay === "drum") && Array.isArray(step.notes) && step.notes.length
              ? step.notes
              : [step.degree || 0];
            const mode = (this.scale && this.scale.mode) || "major";
            if (seqTypePlay === "mono") {
              // DO NOT CHANGE LOGIC: TD-3 slide playback behavior depends on this exact block.
              const pageTranspose = this.pages[p].transpose || 0;
              const pitchCur = this.calcPitch(pat.root || 0, mode, step.degree || 0, step.octave || 0) + pageTranspose;
              const lastStep = pos === 0 ? pat.steps[len - 1] : null;
              const wrapSlidesHere = pos === 0 && canWrapSlide && lastStep?.on && lastStep.slide
                && (this.calcPitch(pat.root || 0, mode, lastStep.degree || 0, lastStep.octave || 0) + pageTranspose) === pitchCur;
              const prevSlidesHere = (pos > 0 && prevStep?.on && (prevStep?.slide || prevStep?.chain)) || wrapSlidesHere;
              const isSlideStart = step.slide || step.chain;
              const chainLen = step.chain ? this.slideChainLength(pat, pos, { seqType: "mono" }) : (step.slide ? 2 : 1);
              const noteVel = step.accent ? 120 : 96;
              const microOffset = this.getNoteMicroOffset(step, step.degree || 0, seqTypePlay);
              const eventTick = baseTick + swingOffsetTicks + microOffset;
              const emit = microOffset >= 0;
              if (prevSlidesHere) {
                const pitchPrev = this.calcPitch(pat.root || 0, mode, prevStep.degree || 0, prevStep.octave || 0) + pageTranspose;
                const samePitch = pitchPrev === pitchCur;
                if (samePitch) {
                  continue; // already held by previous slide gate
                }
                if (!step.slide && !step.chain) {
                  const durMs = this.gateDurationMs(baseDur); // slide ended; play target at normal length
                  if (emit) {
                    this.pushMidiNote(midiEvents, {
                      type: "midi_note",
                      page: p,
                      tick: eventTick,
                      pitch: pitchCur,
                      vel: noteVel,
                      durMs,
                      delayMs: 0,
                      chan,
                      accent: !!step.accent,
                      td3Slide: false
                    });
                  }
                  continue;
                }
                // Trim by swing/epsilon plus a small margin so the slide gate doesn't run past the following note.
                const chainDurMs = baseDur * Math.max(1, chainLen);
                const durMs = step.chain
                  ? Math.max(1, Math.round(chainDurMs - this.noteOffEpsilonMs))
                  : (() => {
                      const slidePad = this.monoSlidePad || 0;
                      const gatedChainMs = this.applyGateLength(chainDurMs);
                      const padMs = this.noteOffEpsilonMs + Math.round(gatedChainMs * slidePad);
                      return Math.max(1, Math.round(gatedChainMs - padMs));
                    })();
                if (emit) {
                  this.pushMidiNote(midiEvents, {
                    type: "midi_note",
                    page: p,
                    tick: eventTick,
                    pitch: pitchCur,
                    vel: noteVel,
                    durMs,
                    delayMs: 0,
                    chan,
                    accent: !!step.accent,
                    td3Slide: !!step.slide || !!step.chain
                  });
                }
                continue;
              }
              if (isSlideStart) {
                const chainDurMs = baseDur * Math.max(1, chainLen);
                const durMs = step.chain
                  ? Math.max(1, Math.round(chainDurMs - this.noteOffEpsilonMs))
                  : (() => {
                      const slidePad = this.monoSlidePad || 0;
                      const gatedChainMs = this.applyGateLength(chainDurMs);
                      const padMs = this.noteOffEpsilonMs + Math.round(gatedChainMs * slidePad);
                      return Math.max(1, Math.round(gatedChainMs - padMs));
                    })(); // hold through the chain without overshooting
                if (emit) {
                  this.pushMidiNote(midiEvents, {
                    type: "midi_note",
                    page: p,
                    tick: eventTick,
                    pitch: pitchCur,
                    vel: noteVel,
                    durMs,
                    delayMs: 0,
                    chan,
                    accent: !!step.accent,
                    td3Slide: !!step.slide || !!step.chain
                  });
                }
                continue;
              }
              if (step.tie) {
                const durMs = this.gateDurationMs(baseDur * 2); // tie adds one step
                if (emit) {
                  this.pushMidiNote(midiEvents, {
                    type: "midi_note",
                    page: p,
                    tick: eventTick,
                    pitch: pitchCur,
                    vel: noteVel,
                    durMs,
                    delayMs: 0,
                    chan,
                    accent: !!step.accent,
                    td3Slide: false
                  });
                }
                this.skipNextNote = this.skipNextNote || {};
                this.skipNextNote[p] = (pos + 1) % len;
                continue;
              }
            }
            degrees.forEach((deg) => {
              if (seqTypePlay === "poly") {
                const octave = this.getNoteOctave(step, deg);
                const lastStep = pos === 0 ? pat.steps[len - 1] : null;
                const wrapSlidesHere = pos === 0 && canWrapSlide && lastStep?.on && this.hasPolyNoteSlide(lastStep, deg)
                  && Array.isArray(lastStep.notes) && lastStep.notes.includes(deg)
                  && this.getNoteOctave(lastStep, deg) === octave;
                const prevSlidesHere = (prevStep?.on && this.hasPolyNoteSlide(prevStep, deg)
                  && Array.isArray(prevStep.notes) && prevStep.notes.includes(deg)
                  && this.getNoteOctave(prevStep, deg) === octave) || wrapSlidesHere;
                if (prevSlidesHere) return;
                const pageTranspose = this.pages[p].transpose || 0;
                const pitch = this.calcPitch(pat.root || 0, mode, deg || 0, octave) + pageTranspose;
                const microOffset = this.getNoteMicroOffset(step, deg, seqTypePlay);
                const eventTick = baseTick + swingOffsetTicks + microOffset;
                const emit = microOffset >= 0;
                const hasChain = this.hasPolyNoteSlide(step, deg);
                const chainLen = hasChain ? this.slideChainLength(pat, pos, { seqType: "poly", degree: deg }) : 1;
                const chainDurMs = baseDur * Math.max(1, chainLen);
                const durMs = hasChain
                  ? Math.max(1, Math.round(chainDurMs - this.noteOffEpsilonMs))
                  : this.gateDurationMs(baseDur);
                const noteVel = Array.isArray(step.accented) && step.accented.includes(deg) ? 120 : 96;
                if (emit) {
                  this.pushMidiNote(midiEvents, {
                    type: "midi_note",
                    page: p,
                    tick: eventTick,
                    pitch,
                    vel: noteVel,
                    durMs,
                    delayMs: 0,
                    chan,
                    accent: noteVel >= 120,
                    td3Slide: false
                  });
                }
                return;
              }
              let pitch;
              if (seqTypePlay === "drum") {
                const drumOct = this.getNoteOctave(step, deg);
                pitch = this.getDrumPitch(page, deg, drumOct);
              } else {
                const pageTranspose = this.pages[p].transpose || 0;
                const octave = this.getNoteOctave(step, deg || 0);
                pitch = this.calcPitch(pat.root || 0, mode, deg || 0, octave) + pageTranspose;
              }
              const microOffset = this.getNoteMicroOffset(step, deg, seqTypePlay);
              const eventTick = baseTick + swingOffsetTicks + microOffset;
              const emit = microOffset >= 0;
              const durMs = this.gateDurationMs(baseDur); // default one step with slight shorten
              const noteVel = Array.isArray(step.accented) && step.accented.includes(deg) ? 120 : 96;
              if (emit) {
                this.pushMidiNote(midiEvents, {
                  type: "midi_note",
                  page: p,
                  tick: eventTick,
                  pitch,
                  vel: noteVel,
                  durMs,
                  delayMs: 0,
                  chan,
                  accent: noteVel >= 120,
                  td3Slide: false
                });
              }
            });
          }
        }
      }
      const nextPos = (pos + 1) % len;
      const nextStepObj = pat.steps[nextPos];
      const nextSwingOffsetTicks = (nextPos % 2 === 1) ? Math.round(TICKS_PER_STEP_INT * swingAmt) : 0;
      const nextBaseTick = baseTick + TICKS_PER_STEP_INT;
      if (nextStepObj?.on) {
        if (seqTypePlay === "mdtonal") {
          if (!(this.skipNextMDNote && this.skipNextMDNote[p] === nextPos)) {
            const trackCfg = this.mdTrackConfig(p);
            const pageTranspose = this.pages[p]?.transpose || 0;
            const value = this.mdCCFromDegree(nextStepObj.degree || 0, pageTranspose, nextStepObj.octave || 0);
            const microOffset = this.getNoteMicroOffset(nextStepObj, nextStepObj.degree || 0, seqTypePlay);
            if (microOffset < 0 && value != null) {
              const eventTick = nextBaseTick + nextSwingOffsetTicks + microOffset;
              const slideActive = nextStepObj.mdSlide && pat.steps[(nextPos + 1) % len]?.on;
              if (slideActive) {
                const nextValue = this.mdCCFromDegree(pat.steps[(nextPos + 1) % len]?.degree || 0, pageTranspose, pat.steps[(nextPos + 1) % len]?.octave || 0);
                const fromVal = value;
                const targetVal = nextValue != null ? nextValue : value;
                midiEvents.push({
                  type: "midi_cc",
                  page: p,
                  tick: eventTick,
                  cc: trackCfg.ccNumber,
                  value: fromVal,
                  delayMs: 0,
                  chan: trackCfg.ccChannel
                });
                const glideEvents = this.mdGlide(p, fromVal, targetVal, baseDur, this.mdBaseSweep);
                glideEvents.forEach((ev) => {
                  midiEvents.push({
                    type: "midi_cc",
                    page: p,
                    tick: eventTick,
                    cc: trackCfg.ccNumber,
                    value: ev.value,
                    delayMs: ev.delay,
                    chan: trackCfg.ccChannel
                  });
                });
              } else {
                midiEvents.push({
                  type: "midi_cc",
                  page: p,
                  tick: eventTick,
                  cc: trackCfg.ccNumber,
                  value,
                  delayMs: 0,
                  chan: trackCfg.ccChannel
                });
              }
              const noteDur = this.gateDurationMs(baseDur * 0.5);
              this.pushMidiNote(midiEvents, {
                type: "midi_note",
                page: p,
                tick: eventTick,
                pitch: trackCfg.noteNumber,
                vel: nextStepObj.accent ? 120 : 96,
                durMs: noteDur,
                delayMs: 0,
                chan: trackCfg.noteChannel,
                accent: !!nextStepObj.accent,
                td3Slide: false
              });
            }
          }
        } else if (seqTypePlay === "cc") {
          const microOffset = this.getNoteMicroOffset(nextStepObj, nextStepObj.degree || 0, seqTypePlay);
          if (microOffset < 0) {
            const eventTick = nextBaseTick + nextSwingOffsetTicks + microOffset;
            const chan = clamp(this.midi[p]?.channel || 1, 1, 16);
            const ccNum = clamp(Math.round(page.ccNumber ?? DEFAULT_CC), 0, 127);
            const value = clamp(Math.round(nextStepObj.cc ?? 0), 0, 127);
            midiEvents.push({ type: "midi_cc", page: p, tick: eventTick, cc: ccNum, value, delayMs: 0, chan });
          }
        } else {
            const degrees = (seqTypePlay === "poly" || seqTypePlay === "drum") && Array.isArray(nextStepObj.notes) && nextStepObj.notes.length
              ? nextStepObj.notes
              : [nextStepObj.degree || 0];
            const mode = (this.scale && this.scale.mode) || "major";
          if (seqTypePlay === "mono") {
            const pageTranspose = this.pages[p].transpose || 0;
            const pitchCur = this.calcPitch(pat.root || 0, mode, nextStepObj.degree || 0, nextStepObj.octave || 0) + pageTranspose;
            const wrapSlidesHere = nextPos === 0 && pos === (len - 1) && step?.on && step.slide
              && (this.calcPitch(pat.root || 0, mode, step.degree || 0, step.octave || 0) + pageTranspose) === pitchCur;
            const prevSlidesHere = (nextPos > 0 && step?.on && (step?.slide || step?.chain)) || wrapSlidesHere;
            const isSlideStart = nextStepObj.slide || nextStepObj.chain;
            const chainLen = nextStepObj.chain ? this.slideChainLength(pat, nextPos, { seqType: "mono" }) : (nextStepObj.slide ? 2 : 1);
            const noteVel = nextStepObj.accent ? 120 : 96;
            const microOffset = this.getNoteMicroOffset(nextStepObj, nextStepObj.degree || 0, seqTypePlay);
            if (microOffset < 0 && !(this.skipNextNote && this.skipNextNote[p] === nextPos)) {
              const eventTick = nextBaseTick + nextSwingOffsetTicks + microOffset;
              if (prevSlidesHere) {
                const pitchPrev = this.calcPitch(pat.root || 0, mode, step.degree || 0, step.octave || 0) + pageTranspose;
                const samePitch = pitchPrev === pitchCur;
                if (samePitch) {
                  // held by previous slide gate
                } else if (!nextStepObj.slide && !nextStepObj.chain) {
                  const durMs = this.gateDurationMs(baseDur);
                  this.pushMidiNote(midiEvents, {
                    type: "midi_note",
                    page: p,
                    tick: eventTick,
                    pitch: pitchCur,
                    vel: noteVel,
                    durMs,
                    delayMs: 0,
                    chan,
                    accent: !!nextStepObj.accent,
                    td3Slide: false
                  });
                } else {
                  const chainDurMs = baseDur * Math.max(1, chainLen);
                  const durMs = nextStepObj.chain
                    ? Math.max(1, Math.round(chainDurMs - this.noteOffEpsilonMs))
                    : (() => {
                        const slidePad = this.monoSlidePad || 0;
                        const gatedChainMs = this.applyGateLength(chainDurMs);
                        const padMs = this.noteOffEpsilonMs + Math.round(gatedChainMs * slidePad);
                        return Math.max(1, Math.round(gatedChainMs - padMs));
                      })();
                  this.pushMidiNote(midiEvents, {
                    type: "midi_note",
                    page: p,
                    tick: eventTick,
                    pitch: pitchCur,
                    vel: noteVel,
                    durMs,
                    delayMs: 0,
                    chan,
                    accent: !!nextStepObj.accent,
                    td3Slide: !!nextStepObj.slide || !!nextStepObj.chain
                  });
                }
              } else if (isSlideStart) {
                const chainDurMs = baseDur * Math.max(1, chainLen);
                const durMs = nextStepObj.chain
                  ? Math.max(1, Math.round(chainDurMs - this.noteOffEpsilonMs))
                  : (() => {
                      const slidePad = this.monoSlidePad || 0;
                      const gatedChainMs = this.applyGateLength(chainDurMs);
                      const padMs = this.noteOffEpsilonMs + Math.round(gatedChainMs * slidePad);
                      return Math.max(1, Math.round(gatedChainMs - padMs));
                    })();
                this.pushMidiNote(midiEvents, {
                  type: "midi_note",
                  page: p,
                  tick: eventTick,
                  pitch: pitchCur,
                  vel: noteVel,
                  durMs,
                  delayMs: 0,
                  chan,
                  accent: !!nextStepObj.accent,
                  td3Slide: !!nextStepObj.slide || !!nextStepObj.chain
                });
              } else if (nextStepObj.tie) {
                const durMs = this.gateDurationMs(baseDur * 2);
                this.pushMidiNote(midiEvents, {
                  type: "midi_note",
                  page: p,
                  tick: eventTick,
                  pitch: pitchCur,
                  vel: noteVel,
                  durMs,
                  delayMs: 0,
                  chan,
                  accent: !!nextStepObj.accent,
                  td3Slide: false
                });
              } else {
                const durMs = this.gateDurationMs(baseDur);
                this.pushMidiNote(midiEvents, {
                  type: "midi_note",
                  page: p,
                  tick: eventTick,
                  pitch: pitchCur,
                  vel: noteVel,
                  durMs,
                  delayMs: 0,
                  chan,
                  accent: !!nextStepObj.accent,
                  td3Slide: false
                });
              }
            }
          } else {
            degrees.forEach((deg) => {
              const microOffset = this.getNoteMicroOffset(nextStepObj, deg, seqTypePlay);
              if (microOffset >= 0) return;
              if (seqTypePlay === "poly") {
                const octave = this.getNoteOctave(nextStepObj, deg);
                const prevSlidesHere = step?.on && this.hasPolyNoteSlide(step, deg)
                  && Array.isArray(step.notes) && step.notes.includes(deg)
                  && this.getNoteOctave(step, deg) === octave;
                if (prevSlidesHere) return;
                const eventTick = nextBaseTick + nextSwingOffsetTicks + microOffset;
                const pageTranspose = this.pages[p].transpose || 0;
                const pitch = this.calcPitch(pat.root || 0, mode, deg || 0, octave) + pageTranspose;
                const hasChain = this.hasPolyNoteSlide(nextStepObj, deg);
                const chainLen = hasChain ? this.slideChainLength(pat, nextPos, { seqType: "poly", degree: deg }) : 1;
                const chainDurMs = baseDur * Math.max(1, chainLen);
                const durMs = hasChain
                  ? Math.max(1, Math.round(chainDurMs - this.noteOffEpsilonMs))
                  : this.gateDurationMs(baseDur);
                const noteVel = Array.isArray(nextStepObj.accented) && nextStepObj.accented.includes(deg) ? 120 : 96;
                this.pushMidiNote(midiEvents, {
                  type: "midi_note",
                  page: p,
                  tick: eventTick,
                  pitch,
                  vel: noteVel,
                  durMs,
                  delayMs: 0,
                  chan,
                  accent: noteVel >= 120,
                  td3Slide: false
                });
                return;
              }
              const eventTick = nextBaseTick + nextSwingOffsetTicks + microOffset;
              let pitch;
              if (seqTypePlay === "drum") {
                const drumOct = this.getNoteOctave(nextStepObj, deg);
                pitch = this.getDrumPitch(page, deg, drumOct);
              } else {
                const pageTranspose = this.pages[p].transpose || 0;
                const octave = this.getNoteOctave(nextStepObj, deg || 0);
                pitch = this.calcPitch(pat.root || 0, mode, deg || 0, octave) + pageTranspose;
              }
              const durMs = this.gateDurationMs(baseDur);
              const noteVel = Array.isArray(nextStepObj.accented) && nextStepObj.accented.includes(deg) ? 120 : 96;
              this.pushMidiNote(midiEvents, {
                type: "midi_note",
                page: p,
                tick: eventTick,
                pitch,
                vel: noteVel,
                durMs,
                delayMs: 0,
                chan,
                accent: noteVel >= 120,
                td3Slide: false
              });
            });
          }
        }
      }
      // pattern/mute changes handled before step processing for tighter LED alignment
    }
    this.tickCount = (this.tickCount + 1) % 1024;
    if (follow) {
      barChanges.push(...this.applyFollowToPlayhead());
    }
    const ledFrame = this.renderLED();
    return { midiEvents, ledFrame, patternSwitches, barChanges, barPlayheadChanges };
  }

  applyFollowToPlayhead() {
    const changes = [];
    const page = this.pages[this.currentPage];
    if (!page || page.sequencerStopped) return changes;
    const pat = page.patterns[page.active_pattern];
    if (!pat) return changes;
    const len = Math.max(1, pat.length_steps || 16);
    const bars = Math.max(1, Math.ceil(len / 16));
    const pos = (this.playheads[this.currentPage] ?? 0) % len;
    const bar = Math.min(bars - 1, Math.floor(pos / 16));
    if (pat.barView !== bar) {
      pat.barView = bar;
      changes.push({ page: this.currentPage, pattern: page.active_pattern, bar });
    }
    return changes;
  }

  mdCCFromDegree(degree, transpose = 0, octave = 0) {
    const deg = clamp(Math.round(degree || 0), 0, 6);
    const mode = (this.scale && this.scale.mode) || "major";
    const pitch = this.calcPitch(0, mode, deg, octave || 0) + (transpose || 0) - 12; // transpose down one octave, plus page transpose
    const midi = Math.round(pitch || 0);
    // map pitch 25 (C#1) .. 88 (E6) to even CC values 0..126
    if (midi < 25 || midi > 88) return null;
    return (midi - 25) * 2;
  }

  mdTrackConfig(page) {
    const track = clamp(Math.round(this.pages[page]?.mdTrack || 1), 1, 16);
    return MDTONAL_TRACKS[track] || MDTONAL_TRACKS[1];
  }

  ccValueFromRow(y) {
    const row = clamp(y, 0, 6);
    const t = (6 - row) / 6;
    return clamp(Math.round(t * 127), 0, 127);
  }

  ccRowFromValue(val) {
    const v = clamp(Math.round(val || 0), 0, 127);
    return clamp(6 - Math.round((v / 127) * 6), 0, 6);
  }

  getScaleIntervals(scale_mode) {
    const scales = {
      "major": [0, 2, 4, 5, 7, 9, 11],
      "minor": [0, 2, 3, 5, 7, 8, 10],
      "dorian": [0, 2, 3, 5, 7, 9, 10],
      "mixolydian": [0, 2, 4, 5, 7, 9, 10],
      "lydian": [0, 2, 4, 6, 7, 9, 11],
      "phrygian": [0, 1, 3, 5, 7, 8, 10],
      "locrian": [0, 1, 3, 5, 6, 8, 10],
      "harmonic_minor": [0, 2, 3, 5, 7, 8, 11],
      "melodic_minor": [0, 2, 3, 5, 7, 9, 11],
      "whole_tone": [0, 2, 4, 6, 8, 10],
      "chromatic": [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
    };
    const globalScale = this.scale || { root: 0, mode: "major" };
    return scales[scale_mode] || scales[globalScale.mode] || scales.major;
  }

  calcPitch(root, scale_mode, degree, octave) {
    const globalScale = this.scale || { root: 0, mode: "major" };
    const scale = this.getScaleIntervals(scale_mode);
    const deg = clamp(degree, 0, scale.length - 1);
    return BASE_PITCH + (globalScale.root || 0) + root + scale[deg] + (octave || 0) * 12;
  }

  findNearestOctaveForDegree(targetMidi, degree, scale, basePitch) {
    const safeMidi = clamp(Math.round(targetMidi || 0), 0, 127);
    const safeScale = Array.isArray(scale) && scale.length ? scale : [0];
    const base = Number.isFinite(basePitch) ? basePitch : BASE_PITCH;
    const deg = clamp(Math.round(degree || 0), 0, safeScale.length - 1);
    const approxOct = Math.floor((safeMidi - base) / 12);
    let best = { diff: Infinity, octave: approxOct, midi: base + safeScale[deg] + approxOct * 12 };
    for (let oct = approxOct - 2; oct <= approxOct + 2; oct += 1) {
      const candidate = base + safeScale[deg] + oct * 12;
      const diff = Math.abs(safeMidi - candidate);
      if (diff < best.diff || (diff === best.diff && candidate < best.midi)) {
        best = { diff, octave: oct, midi: candidate };
      }
    }
    return best.octave;
  }

  getIsomorphicNoteInfo(x, y, page) {
    const safeX = clamp(Math.round(x || 0), 0, 15);
    const safeY = clamp(Math.round(y || 0), 0, 6);
    const layout = this.sanitizeIsomorphicLayout(this.isomorphicLayout || {});
    const gridY = 6 - safeY; // bottom row = 0
    const mode = (this.scale && this.scale.mode) || "major";
    const scale = this.getScaleIntervals(mode);
    const root = page?.patterns?.[page.active_pattern]?.root || 0;
    const basePitch = BASE_PITCH + (this.scale?.root || 0) + root;
    const baseOctave = this.findNearestOctaveForDegree(layout.base, 0, scale, basePitch);
    const stepDegX = clamp(Math.round(layout.stepX || 0), -12, 12) || 1;
    const stepDegY = clamp(Math.round(layout.stepY || 0), -12, 12) || 3;
    const degreeCount = Math.max(1, scale.length);
    const totalDeg = safeX * stepDegX + gridY * stepDegY;
    const octaveShift = Math.floor(totalDeg / degreeCount);
    const degree = ((totalDeg % degreeCount) + degreeCount) % degreeCount;
    const octave = baseOctave + octaveShift;
    const midi = this.calcPitch(root, mode, degree, octave);
    const rawMidi = layout.base + safeX * layout.stepX + gridY * layout.stepY;
    const safeMidi = clamp(Math.round(rawMidi || 0), 0, 127);
    const mapped = { degree, octave, midi, pitchClass: ((midi - basePitch) % 12 + 12) % 12 };
    return {
      degree: mapped.degree,
      octave: mapped.octave,
      midi: mapped.midi,
      rawMidi: safeMidi,
      pitchClass: mapped.pitchClass
    };
  }

  gateLengthFactor() {
    return clamp(Number(this.gateLength) || 1, 0.25, 1);
  }

  applyGateLength(rawMs) {
    return Math.max(1, Math.round(rawMs * this.gateLengthFactor()));
  }

  gateDurationMs(rawMs) {
    const gated = this.applyGateLength(rawMs);
    const pad = this.noteOffEpsilonMs + (Number(this.gatePadMs) || 0);
    return Math.max(1, Math.round(gated - pad));
  }

  stepDurationMs(time_scale) {
    const div = Math.max(1, this.baseDivision || 16); // denominator of note length (1/div)
    return (60000 / this.tempo) * 4 / div * (time_scale || 1);
  }

  clampMicro(micro) {
    const stepsPerBeat = Math.max(1, Math.round((this.baseDivision || 16) / 4));
    const ticksPerStepInt = Math.round(PPQN_INT / stepsPerBeat);
    const max = Math.max(1, ticksPerStepInt - 1);
    return clamp(Math.round(Number(micro) || 0), -max, max);
  }

  getNoteMicroOffset(step, degree, seqType = "mono") {
    if (!step) return 0;
    if (seqType === "poly" || seqType === "drum") {
      const micros = step.noteMicros || {};
      if (Object.prototype.hasOwnProperty.call(micros, degree)) {
        return this.clampMicro(micros[degree]);
      }
      return 0;
    }
    return this.clampMicro(step.micro || 0);
  }

  setNoteMicroOffset(step, degree, seqType = "mono", microOffset = 0) {
    if (!step) return 0;
    const next = this.clampMicro(microOffset);
    if (seqType === "poly" || seqType === "drum") {
      if (!step.noteMicros || typeof step.noteMicros !== "object") step.noteMicros = {};
      if (next) step.noteMicros[degree] = next;
      else delete step.noteMicros[degree];
      return next;
    }
    step.micro = next;
    return next;
  }

  hasPolyNoteSlide(step, degree) {
    if (!step) return false;
    if (step.noteSlides && Object.prototype.hasOwnProperty.call(step.noteSlides, degree)) {
      return !!step.noteSlides[degree];
    }
    return !!(step.slide && (step.degree || 0) === degree);
  }

  polyChainEnd(pat, startIdx, degree) {
    if (!pat || !Array.isArray(pat.steps)) return startIdx;
    const len = Math.max(1, Math.min(pat.length_steps || 16, pat.steps.length));
    let idx = startIdx;
    while (idx < len - 1) {
      const cur = pat.steps[idx];
      const next = pat.steps[idx + 1];
      if (!this.hasPolyNoteSlide(cur, degree)) break;
      if (!next?.on || !Array.isArray(next.notes) || !next.notes.includes(degree)) break;
      if (this.getNoteOctave(cur, degree) !== this.getNoteOctave(next, degree)) break;
      idx += 1;
    }
    return idx;
  }

  removePolyNoteFromStep(pat, abs, degree, pageIdx = this.currentPage) {
    const step = pat?.steps?.[abs];
    if (!step || !Array.isArray(step.notes)) return;
    const idx = step.notes.indexOf(degree);
    if (idx === -1) return;
    const prevOct = this.getNoteOctave(step, degree);
    step.notes.splice(idx, 1);
    if (Array.isArray(step.accented)) step.accented = step.accented.filter((n) => n !== degree);
    if (step.noteOctaves && typeof step.noteOctaves === "object") {
      delete step.noteOctaves[degree];
    }
    if (step.noteMicros && typeof step.noteMicros === "object") {
      delete step.noteMicros[degree];
    }
    if (step.noteSlides && typeof step.noteSlides === "object") {
      delete step.noteSlides[degree];
    }
    if (prevOct) {
      const x = abs % 16;
      const clearY = clamp(6 - degree, 0, 6);
      this.enqueueOctaveOverlay({ page: pageIdx, x, y: clearY, clear: true });
    }
    if (!step.notes.length) {
      this.clearStep(pat, abs, pageIdx, { skipChainClear: true, skipAutoClear: true });
    } else {
      step.degree = step.notes[0];
      step.accent = false;
    }
  }

  clearPolyChainTail(pat, abs, degree, pageIdx = this.currentPage) {
    const endAbs = this.polyChainEnd(pat, abs, degree);
    for (let idx = abs + 1; idx <= endAbs; idx++) {
      this.removePolyNoteFromStep(pat, idx, degree, pageIdx);
    }
  }

  slideChainLength(pat, startIdx, opts = {}) {
    if (!pat || !Array.isArray(pat.steps)) return 1;
    const seqType = opts.seqType || "mono";
    const degree = opts.degree;
    const len = Math.max(1, Math.min(pat.length_steps || 16, pat.steps.length));
    let span = 1;
    let idx = startIdx;
    while (span < len) {
      const cur = pat.steps[idx];
      if (seqType === "mono") {
        if (!cur?.chain) break;
        const nextIdx = idx + 1;
        if (nextIdx >= len) break;
        const nextStep = pat.steps[nextIdx];
        if (!nextStep?.on) break;
        if ((cur.octave || 0) !== (nextStep.octave || 0)) break;
        span += 1;
        if (!nextStep.chain) break;
        idx = nextIdx;
        continue;
      }
      if (seqType === "poly") {
        if (!this.hasPolyNoteSlide(cur, degree)) break;
        const nextIdx = idx + 1;
        if (nextIdx >= len) break;
        const nextStep = pat.steps[nextIdx];
        if (!nextStep?.on || !Array.isArray(nextStep.notes) || !nextStep.notes.includes(degree)) break;
        if (this.getNoteOctave(cur, degree) !== this.getNoteOctave(nextStep, degree)) break;
        span += 1;
        if (!this.hasPolyNoteSlide(nextStep, degree)) break;
        idx = nextIdx;
        continue;
      }
      const slideProp = seqType === "mdtonal" ? "mdSlide" : "slide";
      if (!cur?.[slideProp]) break;
      const nextIdx = idx + 1;
      if (nextIdx >= len) break;
      const nextStep = pat.steps[nextIdx];
      if (!nextStep?.on) break;
      span += 1;
      if (!nextStep[slideProp]) break; // stop after adding target if chain ends there
      idx = nextIdx;
    }
    return span;
  }

  getChainProp(seqType) {
    if (seqType === "mono") return "chain";
    if (seqType === "mdtonal") return "mdSlide";
    return null;
  }

  clearStepNoteFromPoly(step, degree) {
    if (!Array.isArray(step.notes)) step.notes = [];
    step.notes = step.notes.filter((n) => n !== degree);
    if (Array.isArray(step.accented)) step.accented = step.accented.filter((n) => n !== degree);
    if (step.noteOctaves && typeof step.noteOctaves === "object") delete step.noteOctaves[degree];
    if (step.noteMicros && typeof step.noteMicros === "object") delete step.noteMicros[degree];
    if (step.noteSlides && typeof step.noteSlides === "object") delete step.noteSlides[degree];
  }

  applyMoveOrCopyToStep(step, move, targetDeg, nextOct, opts = {}) {
    if (!step) return;
    const isPoly = move.info.seqType === "poly" || move.info.seqType === "drum";
    if (isPoly) {
      if (!Array.isArray(step.notes)) step.notes = [];
      if (!step.noteOctaves || typeof step.noteOctaves !== "object") step.noteOctaves = {};
      if (!step.noteMicros || typeof step.noteMicros !== "object") step.noteMicros = {};
      if (!step.noteSlides || typeof step.noteSlides !== "object") step.noteSlides = {};
      if (!step.notes.includes(targetDeg)) step.notes.push(targetDeg);
      step.on = true;
      step.degree = step.notes[0];
      step.accent = false;
      step.slide = false;
      step.mdSlide = false;
      step.noteOctaves[targetDeg] = nextOct;
      step.noteMicros[targetDeg] = this.clampMicro(move.info.microOffset || 0);
      if (move.info.seqType === "poly" && move.info.slide) step.noteSlides[targetDeg] = true;
      if (!Array.isArray(step.accented)) step.accented = [];
      if (move.info.accent && !step.accented.includes(targetDeg)) step.accented.push(targetDeg);
      return;
    }
    step.on = true;
    step.degree = targetDeg;
    step.octave = nextOct;
    step.micro = this.clampMicro(move.info.microOffset || 0);
    step.accent = !!move.info.accent;
    step.slide = false;
    step.mdSlide = false;
    const slideProp = move.info.seqType === "mdtonal" ? "mdSlide" : "slide";
    step[slideProp] = !!move.info.slide;
    step.tie = false;
  }

  clearChainFromStart(pat, abs, pageIdx, opts, seqType) {
    const prop = this.getChainProp(seqType);
    if (!prop) return false;
    const step = pat.steps[abs];
    if (!step?.on || !step[prop]) return false;
    const prevStep = abs > 0 ? pat.steps[abs - 1] : null;
    if (prevStep?.on && prevStep[prop]) return false;
    const len = Math.max(1, pat.length_steps || 16);
    const chainLen = this.slideChainLength(pat, abs, { seqType });
    const endAbs = clamp(abs + Math.max(1, chainLen) - 1, 0, len - 1);
    for (let idx = abs; idx <= endAbs; idx++) {
      this.clearStep(pat, idx, pageIdx, { skipAutoClear: true, skipChainClear: true, patternIdx: opts.patternIdx });
    }
    if (!opts.skipAutoClear) {
      const hasDataInLength = pat.steps.slice(0, len).some((s) => s?.on);
      if (!hasDataInLength) {
        const hasHiddenData = pat.steps.slice(len).some((s) => s?.on);
        if (hasHiddenData) {
          const pg = this.pages[pageIdx];
          const targetPattern = opts.patternIdx || pg?.active_pattern;
          if (targetPattern) this.clearPattern(pageIdx, targetPattern);
        }
      }
    }
    return true;
  }

  clearChainFromMiddle(pat, abs, pageIdx, opts, seqType) {
    const prop = this.getChainProp(seqType);
    if (!prop) return false;
    const prevStep = abs > 0 ? pat.steps[abs - 1] : null;
    if (!prevStep?.on || !prevStep[prop]) return false;
    const len = Math.max(1, pat.length_steps || 16);
    const chainLen = this.slideChainLength(pat, abs, { seqType });
    const endAbs = clamp(abs + Math.max(1, chainLen) - 1, 0, len - 1);
    for (let idx = abs + 1; idx <= endAbs; idx++) {
      this.clearStep(pat, idx, pageIdx, { skipAutoClear: true, skipChainClear: true, patternIdx: opts.patternIdx });
    }
    return true;
  }

  breakChainAtStep(pat, abs, pageIdx, seqType) {
    const prop = this.getChainProp(seqType);
    if (!prop) return false;
    const step = pat.steps[abs];
    if (!step) return false;
    if (step[prop]) {
      const len = Math.max(1, pat.length_steps || 16);
      const chainLen = this.slideChainLength(pat, abs, { seqType });
      const endAbs = clamp(abs + Math.max(1, chainLen) - 1, 0, len - 1);
      if (endAbs > abs) {
        for (let idx = abs + 1; idx <= endAbs; idx++) {
          this.clearStep(pat, idx, pageIdx, { skipChainClear: true, skipAutoClear: true });
        }
      }
    }
    if (abs > 0) {
      const prevStep = pat.steps[abs - 1];
      if (prevStep?.on && prevStep[prop]) prevStep[prop] = false;
    }
    step[prop] = false;
    return true;
  }

  hasSlidePairs() {
    const page = this.pages[this.currentPage];
    const pat = page?.patterns?.[page.active_pattern];
    if (!pat) return false;
    const bar = pat.barView || 0;
    const seqType = page?.sequencerType || "mono";
    for (let x = 0; x < 16; x++) {
      const abs = x + bar * 16;
      if (abs >= pat.steps.length) break;
      const step = pat.steps[abs];
      if (!step?.on) continue;
      const nextStep = pat.steps[abs + 1];
      if (seqType === "mono" && (step.slide || step.chain || step.tie)) return true;
      if (seqType === "mdtonal" && step.mdSlide) return true;
    }
    return false;
  }

  hasWaveChains() {
    const page = this.pages[this.currentPage];
    const pat = page?.patterns?.[page.active_pattern];
    if (!pat) return false;
    const bar = pat.barView || 0;
    const seqType = page?.sequencerType || "mono";
    if (!(seqType === "mono" || seqType === "poly" || seqType === "mdtonal")) return false;
    const len = Math.max(1, pat.length_steps || 16);
    for (let x = 0; x < 16; x++) {
      const abs = x + bar * 16;
      if (abs >= len) break;
      const step = pat.steps[abs];
      if (seqType === "poly") {
        if (!step?.on) continue;
        const degrees = Array.isArray(step.notes) ? step.notes : [];
        for (const degree of degrees) {
          if (!this.hasPolyNoteSlide(step, degree)) continue;
          const chainLen = this.slideChainLength(pat, abs, { seqType: "poly", degree });
          if (chainLen > 1) return true;
        }
      } else {
        const slideProp = seqType === "mdtonal" ? "mdSlide" : "slide";
        if (!step?.on || !step[slideProp]) continue;
        const chainLen = this.slideChainLength(pat, abs, { seqType });
        if (chainLen > 1) return true;
      }
    }
    return false;
  }

  hasOctaveShifts() {
    const page = this.pages[this.currentPage];
    const pat = page?.patterns?.[page.active_pattern];
    if (!pat) return false;
    const bar = pat.barView || 0;
    const seqType = page?.sequencerType || "mono";
    for (let x = 0; x < 16; x++) {
      const abs = x + bar * 16;
      if (abs >= pat.steps.length) break;
      const step = pat.steps[abs];
      if (!step?.on) continue;
      if (seqType === "poly") {
        if (step.noteOctaves && typeof step.noteOctaves === "object") {
          const hasShift = Object.entries(step.noteOctaves).some(([deg, val]) => {
            if (!Array.isArray(step.notes) || !step.notes.includes(Number(deg))) return false;
            return (Number(val) || 0) !== 0;
          });
          if (hasShift) return true;
        }
        if ((step.octave || 0) !== 0) return true;
      } else if (seqType === "mono" || seqType === "mdtonal") {
        if ((step.octave || 0) !== 0) return true;
      }
    }
    return false;
  }

  consumeForceRefresh() {
    const flag = this.forceLedRefresh;
    this.forceLedRefresh = false;
    return flag;
  }

  renderPatternControlLED() {
    const WIDTH = 16;
    const HEIGHT = 8;
    const OFF = 0;
    const tMs = Date.now();
    const PATTERN_ACTIVE = this.ledLevels.pattern_active;
    const PATTERN_INACTIVE = this.ledLevels.pattern_inactive;
    const PATTERN_PENDING = this.ledLevels.pattern_pending;
    const PATTERN_MUTED = Math.max(1, Math.min(15, Math.round(PATTERN_ACTIVE * 0.4)));
    const PATTERN_HAS_DATA = Math.max(PATTERN_INACTIVE + 2, Math.min(15, Math.round(PATTERN_ACTIVE * 0.75)));
    const DEVICE_PRESENT = this.ledLevels.device_present;
    const DEVICE_ACTIVE = this.ledLevels.device_active;
    const GATE_LED_BUMP = 4;
    const DEVICE_HAS_DATA = Math.max(DEVICE_PRESENT - 2, PATTERN_HAS_DATA);
    const PLAYHEAD = this.ledLevels.playhead;
    const frame = new Array(WIDTH * HEIGHT).fill(OFF);
    for (let col = 0; col < 8; col++) {
      const pageIdx = this.getDeviceByColumn(col);
      const page = this.pages[pageIdx];
      if (!page) continue;
      const active = page.active_pattern;
      const pending = page.pending_pattern;
      for (let patIdx = 1; patIdx <= 7; patIdx++) {
        const row = patIdx - 1; // y position (0 top)
        const hasData = this.patternHasData(pageIdx, patIdx);
        let level = OFF;
        if (hasData) {
          level = PATTERN_HAS_DATA;
          if (active === patIdx) {
            const activeLevel = this.pulse ? PATTERN_ACTIVE : PATTERN_HAS_DATA;
            // level = page.muted ? PATTERN_MUTED : activeLevel;
            level = page.sequencerStopped ? PATTERN_MUTED : activeLevel;
          } else if (pending === patIdx) {
            level = this.pulse ? PATTERN_ACTIVE : PATTERN_PENDING;
          }
        }
        frame[row * WIDTH + col] = level;
      }
      const devHasData = page?.patterns?.some((pat, idx) => idx > 0 && pat?.steps?.some((s) => s.on));
      // const pendingMute = page.pendingMute;
      // let muteLevel = page.muted ? PATTERN_MUTED : (devHasData ? DEVICE_HAS_DATA : DEVICE_PRESENT);
      // if (pendingMute != null) {
      //   muteLevel = this.pulse ? PATTERN_ACTIVE : PATTERN_PENDING;
      // } else if (!page.muted) {
      //   muteLevel = devHasData ? DEVICE_HAS_DATA : DEVICE_PRESENT;
      // }
      const pendingStop = page.pendingStop;
      let stopLevel = page.sequencerStopped ? PATTERN_MUTED : (devHasData ? DEVICE_HAS_DATA : DEVICE_PRESENT);
      if (pendingStop != null) {
        stopLevel = this.pulse ? PATTERN_ACTIVE : PATTERN_PENDING;
      } else if (!page.sequencerStopped) {
        stopLevel = devHasData ? DEVICE_HAS_DATA : DEVICE_PRESENT;
      }
      if (this.isDeviceGateActive(pageIdx, tMs)) {
        stopLevel = Math.min(15, stopLevel + GATE_LED_BUMP);
      }
      frame[7 * WIDTH + col] = stopLevel;
    }
    // indicator for control mode toggle: only bright when pattern control is active/held
    // keep the button dark when inactive; only light when pressed/latched
    const ctlActive = this.patternControlMode || this.patternControlHeld;
    const ctlLevel = ctlActive ? PATTERN_ACTIVE : OFF;
    frame[7 * WIDTH + PATTERN_CONTROL_BUTTON] = ctlLevel;
    // dim other control buttons (exclude the control button itself)
    frame[7 * WIDTH + 14] = OFF;
    return frame;
  }

  renderPatternControlBinaryLED(tMs = Date.now()) {
    const WIDTH = 16;
    const HEIGHT = 8;
    const OFF = 0;
    const frame = new Array(WIDTH * HEIGHT).fill(OFF);
    const blinkFast = Math.floor(tMs / 150) % 2 === 0;
    const blinkSlow = Math.floor(tMs / 320) % 2 === 0;
    for (let col = 0; col < 8; col++) {
      const pageIdx = this.getDeviceByColumn(col);
      const page = this.pages[pageIdx];
      if (!page) continue;
      const active = page.active_pattern;
      const pending = page.pending_pattern;
      for (let patIdx = 1; patIdx <= 7; patIdx++) {
        const row = patIdx - 1; // y position (0 top)
        const hasData = this.patternHasData(pageIdx, patIdx);
        if (!hasData) continue;
        let on = true;
        const stopped = !!page.sequencerStopped;
        if (!stopped) {
          if (active === patIdx) {
            on = blinkSlow;
          } else if (pending === patIdx) {
            on = blinkFast;
          }
        }
        frame[row * WIDTH + col] = on ? 1 : 0;
      }
      const devHasData = page?.patterns?.some((pat, idx) => idx > 0 && pat?.steps?.some((s) => s.on));
      const pendingStop = page.pendingStop;
      let stopLevel = devHasData ? 1 : 0;
      if (pendingStop != null) {
        stopLevel = blinkFast ? 1 : 0;
      } else if (page.sequencerStopped) {
        stopLevel = 0; // turn off bottom row when stopped
      }
      if (this.isDeviceGateActive(pageIdx, tMs)) {
        stopLevel = 1;
      }
      frame[7 * WIDTH + col] = stopLevel;
    }
    // pattern control button indicator (col 15) not visible on 8x8 crop but keep it consistent
    const ctlActive = this.patternControlMode || this.patternControlHeld;
    frame[7 * WIDTH + PATTERN_CONTROL_BUTTON] = ctlActive && blinkSlow ? 1 : 0;
    return frame;
  }

  renderIsomorphicLED(slideTimeMs, opts = {}) {
    const WIDTH = 16;
    const STEP_ROWS = 7;
    const baseFrame = this.renderLED(slideTimeMs, { ...opts, ignoreIsomorphic: true });
    const page = this.pages[this.currentPage];
    if (!page) return baseFrame;
    const baseLevel = Math.max(1, Math.round((this.ledLevels.step_on || 10) * 0.35));
    const rootLevel = Math.max(baseLevel + 1, Math.round((this.ledLevels.step_on || 10) * 0.7));
    const activeLevel = this.ledLevels.step_on || 10;
    const noteInfos = Array.from({ length: STEP_ROWS }, () => Array(WIDTH).fill(null));
    for (let y = 0; y < STEP_ROWS; y += 1) {
      for (let x = 0; x < WIDTH; x += 1) {
        const info = this.getIsomorphicNoteInfo(x, y, page);
        const idx = y * WIDTH + x;
        noteInfos[y][x] = info;
        baseFrame[idx] = info.degree === 0 ? rootLevel : baseLevel;
      }
    }
    if (!page.sequencerStopped) {
      const pat = page.patterns?.[page.active_pattern];
      const len = Math.max(1, pat?.length_steps || 16);
      const ph = Math.max(0, Math.floor(this.playheads[this.currentPage] ?? 0)) % len;
      const phBar = Math.floor(ph / 16);
      const bar = pat?.barView || 0;
      if (phBar === bar) {
        const phX = ph % 16;
        const playLevel = Math.max(1, Math.round((this.ledLevels.playhead || 15) * 0.25));
        for (let yy = 0; yy < STEP_ROWS; yy += 1) {
          const idx = yy * WIDTH + phX;
          baseFrame[idx] = Math.max(baseFrame[idx] || 0, playLevel);
        }
      }
    }
    const activeMidi = this.getActiveNotesSet(this.currentPage);
    if (this.auditionHolds && this.auditionHolds.size) {
      this.auditionHolds.forEach((hold, key) => {
        if (!key.startsWith("iso:")) return;
        if (hold.page !== this.currentPage) return;
        const coords = key.slice(4).split(",").map((v) => Number(v));
        const [sx, sy] = coords;
        if (!Number.isFinite(sx) || !Number.isFinite(sy)) return;
        if (sy < 0 || sy >= STEP_ROWS) return;
        const info = noteInfos[sy]?.[sx];
        if (info && Number.isFinite(info.midi)) {
          activeMidi.add(info.midi);
        }
      });
    }
    if (activeMidi.size) {
      for (let y = 0; y < STEP_ROWS; y += 1) {
        for (let x = 0; x < WIDTH; x += 1) {
          const info = noteInfos[y][x];
          if (!info || !Number.isFinite(info.midi)) continue;
          if (activeMidi.has(info.midi)) {
            baseFrame[y * WIDTH + x] = activeLevel;
          }
        }
      }
    }
    return baseFrame;
  }

  renderUIFrame(slideTimeMs, opts = {}) {
    const WIDTH = 16;
    const HEIGHT = 8;
    const STEP_ROWS = 7;
    const ignorePatternControl = !!opts.ignorePatternControl;
    const prevPatternControl = this.patternControlMode;
    if (ignorePatternControl && prevPatternControl) {
      this.patternControlMode = false;
    }
    const baseFrame = this.renderLED(slideTimeMs, {
      includeOctaveHint: opts.includeOctaveHint,
      includeMicroHint: opts.includeMicroHint,
      ignorePatternHoldDim: opts.ignorePatternHoldDim
    });
    if (ignorePatternControl && prevPatternControl) {
      this.patternControlMode = prevPatternControl;
    }
    const uiFrame = new Array(WIDTH * HEIGHT).fill(0);
    for (let y = 0; y < STEP_ROWS; y++) {
      for (let x = 0; x < WIDTH; x++) {
        uiFrame[(y + 1) * WIDTH + x] = baseFrame[y * WIDTH + x] || 0;
      }
    }
    const page = this.pages[this.currentPage];
    const pat = page?.patterns[page?.active_pattern];
    if (!page || !pat) {
      return uiFrame;
    }
    if (this.patternControlMode && !ignorePatternControl) {
      return baseFrame;
    }
    const bar = pat.barView || 0;
    const seqType = page?.sequencerType || "mono";
    for (let x = 0; x < WIDTH; x++) {
      const abs = x + bar * 16;
      if (abs >= pat.steps.length) break;
      const step = pat.steps[abs];
      if (!step?.on) continue;
      let hasTop = false;
      if (seqType === "poly" || seqType === "drum") {
        if (Array.isArray(step.notes) && step.notes.includes(0)) {
          const oct = this.getNoteOctave(step, 0) || 0;
          hasTop = oct === 1;
        }
      } else if (seqType !== "cc") {
        hasTop = (step.degree || 0) === 0 && (step.octave || 0) === 1;
      }
      if (hasTop) {
        const baseIdx = 6 * WIDTH + x;
        const level = baseFrame[baseIdx] || 0;
        uiFrame[x] = Math.max(uiFrame[x] || 0, level);
        uiFrame[7 * WIDTH + x] = 0;
      }
    }
    if (!page.sequencerStopped) {
      const len = Math.max(1, pat.length_steps);
      const ph = Math.max(0, Math.floor(this.playheads[this.currentPage] ?? 0)) % len;
      const phBar = Math.floor(ph / 16);
      if (phBar === bar) {
        const phX = ph % 16;
        const playLevel = this.ledLevels.playhead;
        for (let yy = 0; yy < HEIGHT; yy++) {
          uiFrame[yy * WIDTH + phX] = playLevel;
        }
      }
    }
    return uiFrame;
  }

  // DO NOT CHANGE LOGIC: monome LED frame generation depends on this exact pipeline.
  renderLED(slideTimeMs, opts = {}) {
    const ignoreIsomorphic = !!opts.ignoreIsomorphic;
    const includeOctaveHint = opts.includeOctaveHint !== false;
    const includeMicroHint = opts.includeMicroHint !== false;
    const ignorePatternHoldDim = !!opts.ignorePatternHoldDim;
    const WIDTH = 16;
    const HEIGHT = 8;
    const STEP_ROWS = 7;
    const OFF = 0;
    const STEP_ON = this.ledLevels.step_on;
    const STEP_MICRO = this.ledLevels.step_micro;
    const STEP_ACCENT = this.ledLevels.step_accent;
    const PLAYHEAD = this.ledLevels.playhead;
    const PATTERN_ACTIVE = this.ledLevels.pattern_active;
    const PATTERN_INACTIVE = this.ledLevels.pattern_inactive;
    const PATTERN_PENDING = this.ledLevels.pattern_pending;
    const PATTERN_MUTED = Math.max(1, Math.min(15, Math.round(PATTERN_ACTIVE * 0.4)));
    const PATTERN_HAS_DATA = Math.max(PATTERN_INACTIVE + 2, Math.min(15, Math.round(PATTERN_ACTIVE * 0.75)));
    const DEVICE_PRESENT = this.ledLevels.device_present;
    const DEVICE_ACTIVE = this.ledLevels.device_active;
    const GATE_LED_BUMP = 2;
    const DEVICE_HAS_DATA = Math.max(DEVICE_PRESENT - 2, PATTERN_HAS_DATA);
    const tMs = Date.now();
    const OCT_LOOP_MS = 1200;
    const octPhase = (tMs % OCT_LOOP_MS) / OCT_LOOP_MS; // 0..1
    const octPulse = (1 - Math.cos(octPhase * Math.PI * 2)) * 0.5; // cosine ease
    const PULSE_MIN = 0.9;
    const octFactor = PULSE_MIN + (1 - PULSE_MIN) * octPulse; // 0.9..1.0
    const applyOctavePulse = (level, shifted) => {
      if (!shifted) return level;
      return Math.max(1, Math.round(level * octFactor));
    };
    const frame = new Array(WIDTH * HEIGHT).fill(OFF);
    const page = this.pages[this.currentPage];
    if (!ignoreIsomorphic && this.isIsomorphicMode(this.currentPage)) {
      return this.renderIsomorphicLED(slideTimeMs, opts);
    }
    if (this.patternControlMode) {
      return this.renderPatternControlLED();
    }
    const pat = page?.patterns[page?.active_pattern];
    const heldKey = this.heldStep ? `${this.heldStep.x},${this.heldStep.y}` : null;
    const heldInfo = heldKey ? this.keyHolds.get(heldKey) : null;
    const multiHoldAny = this.keyHolds.size > 1;
    const multiRecent = Date.now() - (this.lastMultiSelectTime || 0) < 150;
    const inEditMode = this.heldStep && heldInfo && !multiHoldAny
      && (heldInfo.editMode || (!multiRecent && heldInfo.start && (Date.now() - heldInfo.start) >= 150));
    if (pat) {
      const bar = pat.barView || 0;
      const slideStarts = [];
      for (let x = 0; x < 16; x++) {
        const abs = x + bar * 16;
        if (abs >= pat.steps.length) break;
        const step = pat.steps[abs];
        if (step.on) {
          const seqType = page?.sequencerType || "mono";
          if (seqType === "cc") {
            const row = this.ccRowFromValue(step.cc);
            const intensity = Math.max(0.2, clamp(step.cc || 0, 0, 127) / 127);
            const baseLevel = Math.max(1, Math.round(STEP_ON * intensity));
            // const level = page?.muted ? Math.max(1, Math.round(baseLevel * 0.4)) : baseLevel;
            const level = page?.sequencerStopped ? Math.max(1, Math.round(baseLevel * 0.4)) : baseLevel;
            const idx = row * WIDTH + x;
            frame[idx] = Math.max(frame[idx], level);
          } else if (seqType === "mdtonal") {
            const row = clamp(6 - (step.degree || 0), 0, 6);
            const baseLevel = step.accent ? STEP_ACCENT : STEP_ON;
            const hasOctShift = (step.octave || 0) !== 0;
            const pulsed = applyOctavePulse(baseLevel, hasOctShift);
            // const level = page?.muted ? Math.max(1, Math.round(pulsed * 0.4)) : pulsed;
            const level = page?.sequencerStopped ? Math.max(1, Math.round(pulsed * 0.4)) : pulsed;
            const idx = row * WIDTH + x;
            frame[idx] = Math.max(frame[idx], level);
            if (step.mdSlide) {
              slideStarts.push({
                x1: x,
                y1: clamp(6 - step.degree, 0, 6),
                accent1: !!step.accent
              });
            }
          } else {
            const degrees = ((page.sequencerType === "poly" || page.sequencerType === "drum") && Array.isArray(step.notes) && step.notes.length)
              ? step.notes
              : [step.degree || 0];
            degrees.forEach((deg) => {
              const y = clamp(6 - deg, 0, 6);
              const level = (page.sequencerType === "poly" || page.sequencerType === "drum")
                ? (Array.isArray(step.accented) && step.accented.includes(deg) ? STEP_ACCENT : STEP_ON)
                : (step.accent ? STEP_ACCENT : STEP_ON);
              const hasOctShift = (page.sequencerType === "poly")
                ? (this.getNoteOctave(step, deg) || 0) !== 0
                : (page.sequencerType === "mono" || page.sequencerType === "mdtonal") && (step.octave || 0) !== 0;
              const pulsed = applyOctavePulse(level, hasOctShift);
              // if (page?.muted) {
              if (page?.sequencerStopped) {
                frame[y * WIDTH + x] = Math.max(1, Math.round(pulsed * 0.4));
              } else {
                frame[y * WIDTH + x] = pulsed;
              }
            });
            const seq = page?.sequencerType || "mono";
            if ((seq === "mono" && (step.slide || step.chain || step.tie)) || (seq === "mdtonal" && step.mdSlide)) {
              slideStarts.push({
                x1: x,
                y1: clamp(6 - step.degree, 0, 6),
                accent1: !!step.accent
              });
            }
          }
        }
      }
      // octave hint in edit mode: dim up/down neighbors (hardware only)
      if (includeOctaveHint && inEditMode && this.heldStep && (page?.sequencerType || "mono") !== "drum" && (page?.sequencerType || "mono") !== "cc") {
        const previewLevel = Math.max(1, Math.round(STEP_ON * 0.35));
        const hx = this.heldStep.x;
        const hy = this.heldStep.y;
        const seqTypeHint = page?.sequencerType || "mono";
        const heldDeg = this.holdTargetDegree != null ? clamp(this.holdTargetDegree, 0, 6) : clamp(6 - hy, 0, 6);
        const candidates = [
          { x: hx, y: hy - 1 },
          { x: hx, y: hy + 1 }
        ];
        const absHeld = hx + bar * 16;
        const heldStepObj = pat.steps[absHeld];
        let heldOct = heldStepObj?.octave || 0;
        if (seqTypeHint === "poly" && Array.isArray(heldStepObj?.notes) && heldStepObj.notes.includes(heldDeg)) {
          heldOct = this.getNoteOctave(heldStepObj, heldDeg);
        }
        candidates.forEach((c) => {
          if (c.y >= 0 && c.y < STEP_ROWS) {
            const idx = c.y * WIDTH + c.x;
            const isUp = c.y < hy;
            const levelHint = heldOct > 0
              ? (isUp ? Math.max(previewLevel, Math.round(STEP_ACCENT * 0.8)) : previewLevel)
              : heldOct < 0
                ? (!isUp ? Math.max(previewLevel, Math.round(STEP_ACCENT * 0.8)) : previewLevel)
                : previewLevel;
            if (frame[idx] === OFF || frame[idx] < levelHint) frame[idx] = levelHint;
          }
        });
      }
      // microtiming hint in edit mode: light left/right neighbors by offset sign
      if (includeMicroHint && inEditMode && this.heldStep) {
        const hx = this.heldStep.x;
        const hy = this.heldStep.y;
        const seqTypeHint = page?.sequencerType || "mono";
        const hintY = heldInfo?.uiMode ? (hy === 0 ? 6 : hy - 1) : hy;
        const heldDeg = this.holdTargetDegree != null ? clamp(this.holdTargetDegree, 0, 6) : clamp(6 - hintY, 0, 6);
        const absHeld = hx + bar * 16;
        const heldStepObj = pat.steps[absHeld];
        const microOffset = this.getNoteMicroOffset(heldStepObj, heldDeg, seqTypeHint);
        const previewLevel = Math.max(1, Math.round(STEP_MICRO * 0.35));
        const accentLevel = Math.max(previewLevel, Math.round(STEP_MICRO * 0.8));
        const candidates = [
          { x: hx - 1, isLeft: true },
          { x: hx + 1, isLeft: false }
        ];
        candidates.forEach((c) => {
          if (c.x < 0 || c.x >= WIDTH) return;
          const idx = hintY * WIDTH + c.x;
          const levelHint = microOffset > 0
            ? (c.isLeft ? previewLevel : accentLevel)
            : microOffset < 0
              ? (c.isLeft ? accentLevel : previewLevel)
              : previewLevel;
          if (frame[idx] === OFF || frame[idx] < levelHint) frame[idx] = levelHint;
        });
      }
      if (!page.sequencerStopped) {
        const len = Math.max(1, pat.length_steps);
        // Use the computed playhead to avoid the pageTicks pre-increment offset.
        const ph = Math.max(0, Math.floor(this.playheads[this.currentPage] ?? 0)) % len;
        const phBar = Math.floor(ph / 16);
        if (phBar === bar) {
          const phX = ph % 16;
          for (let yy = 0; yy < STEP_ROWS; yy++) {
            frame[yy * WIDTH + phX] = PLAYHEAD;
          }
        }
      }
      const slideChains = [];
      const chainCells = new Set();
      {
        const seqType = page?.sequencerType || "mono";
        if (seqType === "mono" || seqType === "poly" || seqType === "mdtonal") {
          const len = Math.max(1, pat.length_steps || 16);
          for (let x = 0; x < 16; x++) {
            const abs = x + bar * 16;
            if (abs >= len) break;
            const step = pat.steps[abs];
            if (!step?.on) continue;
            if (seqType === "poly") {
              const degrees = Array.isArray(step.notes) ? step.notes : [];
              for (const degree of degrees) {
                if (!this.hasPolyNoteSlide(step, degree)) continue;
                if (abs > 0) {
                  const prev = pat.steps[abs - 1];
                  if (this.hasPolyNoteSlide(prev, degree)) continue;
                }
                const chainLen = this.slideChainLength(pat, abs, { seqType: "poly", degree });
                if (chainLen <= 1) continue;
                const endX = x + chainLen - 1;
                if (endX >= 16) continue;
                const y = clamp(6 - degree, 0, 6);
                const bright = Array.isArray(step.accented) && step.accented.includes(degree) ? STEP_ACCENT : STEP_ON;
                slideChains.push({ x1: x, x2: endX, y, bright });
                for (let cx = x; cx <= endX; cx++) {
                  chainCells.add(`${cx},${y}`);
                }
              }
              continue;
            }
            if (seqType === "mono") {
              if (!step.chain) continue;
            } else if (seqType === "mdtonal") {
              continue;
            }
            if (abs > 0) {
              const prev = pat.steps[abs - 1];
              if (seqType === "mono") {
                if (prev?.on && prev.chain) continue;
              }
            }
            const chainLen = seqType === "mono"
              ? this.slideChainLength(pat, abs, { seqType: "mono" })
              : this.slideChainLength(pat, abs, { seqType });
            if (chainLen <= 1) continue;
            const endX = x + chainLen - 1;
            if (endX >= 16) continue;
            const degree = step.degree || 0;
            const y = clamp(6 - degree, 0, 6);
            const bright = step.accent ? STEP_ACCENT : STEP_ON;
            slideChains.push({ x1: x, x2: endX, y, bright });
            for (let cx = x; cx <= endX; cx++) {
              chainCells.add(`${cx},${y}`);
            }
          }
        }
      }
      if (slideChains.length) {
        const loopMs = 1400;
        const t = slideTimeMs !== undefined ? slideTimeMs : Date.now();
        const travel = (t % loopMs) / loopMs;
        slideChains.forEach((chain) => {
          const span = Math.max(1, chain.x2 - chain.x1);
          const dim = Math.max(1, Math.round(chain.bright * 0.25));
          for (let x = chain.x1; x <= chain.x2; x++) {
            const pos = span ? (x - chain.x1) / span : 0;
            const phase = (pos - travel) * Math.PI * 2;
            const strength = (Math.sin(phase) + 1) * 0.5;
            const level = Math.round(dim + (chain.bright - dim) * strength);
            const idx = chain.y * WIDTH + x;
            frame[idx] = frame[idx] >= PLAYHEAD ? frame[idx] : level;
          }
        });
      }
      // slide/tie indication: pulse only the originating step
      if (slideStarts.length) {
        const loopMs = 900; // ~0.9s pulse
        const t = slideTimeMs !== undefined ? slideTimeMs : Date.now();
        const phase = (t % loopMs) / loopMs; // 0..1
        const pulse = (1 - Math.cos(phase * Math.PI * 2)) * 0.5; // cosine ease 0..1..0
        slideStarts.forEach((sp) => {
          if (chainCells.has(`${sp.x1},${sp.y1}`)) return;
          const bright = sp.accent1 ? STEP_ACCENT : STEP_ON;
          const dim = Math.max(1, Math.round(bright * 0.4));
          const level = Math.round(dim + (bright - dim) * pulse);
          frame[sp.y1 * WIDTH + sp.x1] = level;
        });
      }
    }
    if (this.patternHeld && !ignorePatternHoldDim) {
      for (let yy = 0; yy < STEP_ROWS; yy++) {
        for (let xx = 0; xx < WIDTH; xx++) {
          const idx = yy * WIDTH + xx;
          if (frame[idx] > 0) {
            frame[idx] = PATTERN_INACTIVE;
          }
        }
      }
      if (this.auditionHolds && this.auditionHolds.size) {
        this.auditionHolds.forEach((hold, key) => {
          const [sx, sy] = key.split(",").map((val) => Number(val));
          if (!Number.isFinite(sx) || !Number.isFinite(sy)) return;
          if (sy < 0 || sy >= STEP_ROWS) return;
          const idx = sy * WIDTH + sx;
          frame[idx] = Math.max(frame[idx], STEP_ON);
        });
      }
    }
    if ((this.patternControlMode || this.patternControlHeld || this.patternHeld) && page) {
      // show patterns when holding pattern button
      for (let i = 0; i < 8; i++) {
        const patIdx = i + 1;
        const pat = page.patterns[patIdx];
        const hasData = pat?.steps?.some((s) => s.on);
        const isActive = page.active_pattern === patIdx;
        const isPending = page.pending_pattern === patIdx;
        const bars = Math.max(1, Math.ceil((pat?.length_steps || 16) / 16));
        let level = PATTERN_INACTIVE;
        if (hasData) {
          level = PATTERN_HAS_DATA;
          if (bars > 1 && !isActive && !isPending) {
            level = Math.min(15, PATTERN_HAS_DATA + (bars - 1) * 2);
          }
        }
        if (isPending) {
          level = this.pulse ? PATTERN_ACTIVE : PATTERN_PENDING;
        } else if (isActive) {
          // active should light even when empty; keep pulsing if it has data
          level = this.pulse ? PATTERN_ACTIVE : (hasData ? PATTERN_HAS_DATA : PATTERN_ACTIVE);
        }
        frame[7 * WIDTH + i] = level;
      }
      // visualize bars of current pattern on subsequent buttons
      const activePat = page.patterns[page.active_pattern];
      if (activePat) {
        const patHasData = this.patternHasData(this.currentPage, page.active_pattern);
        if (patHasData) {
          const bars = Math.max(1, Math.ceil((activePat.length_steps || 16) / 16));
          const phLen = Math.max(1, activePat.length_steps || 16);
          const currentBar = page.sequencerStopped ? null : Math.min(bars - 1, Math.floor((this.playheads[this.currentPage] % phLen) / 16));
          const baseIdx = page.active_pattern - 1;
          const patternPulse = this.pulse ? PLAYHEAD : PATTERN_ACTIVE;
          for (let b = 0; b < bars && (baseIdx + b) < 8; b++) {
            const idx = baseIdx + b;
            const isActivePattern = (b === 0);
            const isPlayingBar = currentBar != null && currentBar === b;
            let level = PATTERN_HAS_DATA;
            if (isActivePattern) {
              level = patternPulse;
            } else if (isPlayingBar) {
              level = this.pulse ? Math.min(PLAYHEAD, Math.round(PATTERN_ACTIVE * 0.7)) : Math.round(PATTERN_HAS_DATA * 0.8);
            } else {
              level = Math.round(PATTERN_HAS_DATA * 0.7);
            }
            frame[7 * WIDTH + idx] = level;
          }
        }
      }
      const ctlLevel = (this.patternControlMode || this.patternControlHeld) ? PATTERN_ACTIVE : PATTERN_INACTIVE;
      frame[7 * WIDTH + 14] = OFF;
      frame[7 * WIDTH + PATTERN_CONTROL_BUTTON] = ctlLevel;
    } else {
      for (let i = 0; i < 8; i++) {
        const pageIdx = this.getDeviceByColumn(i);
        const dev = this.pages[pageIdx];
        const isCurrent = this.currentPage === pageIdx;
        const isDevStopped = dev?.sequencerStopped;
        const hasData = dev?.patterns?.some((pat, idx) => idx > 0 && pat?.steps?.some((s) => s.on));
        const pendingStop = dev?.pendingStop;
        // const pendingMute = dev?.pendingMute;
        let level;
        if (pendingStop != null) {
          level = this.pulse ? PATTERN_ACTIVE : PATTERN_PENDING;
        } else if (isCurrent) {
          level = isDevStopped ? PATTERN_MUTED : DEVICE_ACTIVE;
        } else if (isDevStopped) {
          level = PATTERN_INACTIVE;
        } else {
          level = hasData ? DEVICE_HAS_DATA : DEVICE_PRESENT;
        }
        if (this.isDeviceGateActive(pageIdx, tMs)) {
          level = Math.min(15, level + GATE_LED_BUMP);
        }
        frame[7 * WIDTH + i] = level;
      }
      // const isPending = page && page.pending_pattern;
      // const isMuted = page?.muted;
      // const isStopped = page?.sequencerStopped;
      const ctlLevel = (this.patternControlMode || this.patternControlHeld) ? PATTERN_ACTIVE : PATTERN_INACTIVE;
      frame[7 * WIDTH + 14] = PATTERN_INACTIVE;
      frame[7 * WIDTH + PATTERN_CONTROL_BUTTON] = ctlLevel;
    }
    if (page?.patterns?.[page.active_pattern]) {
      const barPat = page.patterns[page.active_pattern];
      const bars = Math.max(1, Math.ceil((barPat.length_steps || 16) / 16));
      const maxBars = Math.min(4, bars);
      const storedBar = barPat.barView || 0;
      const playingBar = (!page.sequencerStopped && Number.isFinite(this.playheads[this.currentPage]))
        ? Math.min(bars - 1, Math.floor((this.playheads[this.currentPage] % Math.max(1, barPat.length_steps || 16)) / 16))
        : null;
      for (let i = 0; i < 4; i++) {
        const idx = 7 * WIDTH + (9 + i);
        if (this.patternHeld) {
          frame[idx] = i < maxBars ? PATTERN_HAS_DATA : PATTERN_INACTIVE;
          continue;
        }
        if (i >= maxBars) {
          frame[idx] = OFF;
          continue;
        }
        let level = PATTERN_INACTIVE;
        if (playingBar === i) {
          level = this.pulse ? PATTERN_PENDING : PATTERN_INACTIVE;
        } else if (storedBar === i) {
          level = PATTERN_HAS_DATA;
        }
        frame[idx] = level;
      }
    }
    return frame;
  }
}
// studio grid server-side state: tracks pages, patterns, playback, clock, MIDI events, monome LED frames, and import/export snapshots.
