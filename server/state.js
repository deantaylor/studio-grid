// Base pitch for degree 0, octave 0 (C3). Raised one octave.
const BASE_PITCH = 48;
const DEFAULT_CC = 1;
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

function safeColor(color, fallback = BASE_DEFAULT_DEVICE_COLOR) {
  return /^#([0-9a-fA-F]{6})$/.test(color || "") ? color : fallback;
}

export class MGridState {
  constructor() {
    this.tempo = 120;
    this.swing = 50; // 50 = straight, 80 max swing
    this.baseDivision = 16; // denominator of base note (1/16)
    this.scale = { root: 0, mode: "major" };
    this.pages = this.buildDefaultPages();
    this.sequencerTypes = this.pages.map((p, i) => (i === 0 ? null : p.sequencerType));
    this.sequencerTypes = this.pages.map((p, i) => (i === 0 ? null : p.sequencerType));
    this.deviceNames = this.pages.map((p, i) => (i === 0 ? null : p.name));
    this.deviceNotes = this.pages.map((p, i) => (i === 0 ? null : p.note));
    this.deviceColors = this.pages.map((p, i) => (i === 0 ? null : p.color));
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
    this.patternControlLatch = false;
    this.pendingOctaveOverlays = [];
    this.holdTimers = new Map(); // key -> timeout id for entering edit mode
    this.requestRender = null; // optional callback wired by server to force a render
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
      steps.push({ on: false, degree: 0, octave: 0, micro: 0, accent: false, slide: false, mdSlide: false, tie: false, notes: [], accented: [], noteOctaves: {}, cc: 0 });
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
    this.forceLedRefresh = true;
    if (typeof this.requestRender === "function") {
      this.requestRender();
    }
  }

  consumeOctaveOverlays() {
    const out = this.pendingOctaveOverlays ? this.pendingOctaveOverlays.slice() : [];
    this.pendingOctaveOverlays = [];
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

  getNoteOctave(step, degree) {
    if (!step) return 0;
    if (step.noteOctaves && typeof step.noteOctaves === "object" && degree != null && Object.prototype.hasOwnProperty.call(step.noteOctaves, degree)) {
      const raw = step.noteOctaves[degree];
      return clamp(Number.isFinite(raw) ? Math.round(raw) : 0, -3, 4);
    }
    return clamp(step.octave || 0, -3, 4);
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
    const defaultDrums = [36, 38, 41, 43, 45, 47, 55]; // C1..G1 bottom->top
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
        drumNotes: defaultDrums.slice(),
        ccNumber: DEFAULT_CC,
        mdTrack: 1
      });
    }
    return pages;
  }

  resetSet({ defaultColor, keepDeviceNames = false, keepMidi = false } = {}) {
    const fallbackColor = safeColor(defaultColor, BASE_DEFAULT_DEVICE_COLOR);
    const newColors = [null];
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
      page.drumNotes = Array.isArray(page.drumNotes) ? page.drumNotes.slice(0, 7) : [36, 38, 41, 43, 45, 47, 55];
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
    }
    this.deviceColors = newColors;
    this.playheads = Array(9).fill(0);
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
    const options = [8, 12, 16, 24, 32]; // note denominators (1/8..1/32)
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

  setSwing(val) {
    this.swing = clamp(Math.round(val || 50), 50, 80);
  }

  setScale(root, mode) {
    const modes = ["major", "minor", "dorian", "mixolydian", "lydian", "phrygian", "locrian", "harmonic_minor", "melodic_minor", "whole_tone", "chromatic"];
    const safeMode = modes.includes(mode) ? mode : (this.scale.mode || "major");
    this.scale = { root: clamp(root ?? this.scale.root ?? 0, -24, 24), mode: safeMode };
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
    if (row < 0 || row > 6) return;
    const pg = this.pages[page];
    if (!pg) return;
    if (!Array.isArray(pg.drumNotes)) pg.drumNotes = [36, 38, 42, 46, 49, 51, 57];
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
            micro: s.micro || 0,
            accent: !!s.accent,
            slide: !!s.slide,
            cc: clamp(Math.round(s.cc || 0), 0, 127),
            notes: Array.isArray(s.notes) ? s.notes.slice() : [],
            accented: Array.isArray(s.accented) ? s.accented.slice() : [],
            noteOctaves: this.sanitizeNoteOctaves(s.noteOctaves)
          }))
        };
      });
      return {
        name: p.name,
        note: p.note,
        color: p.color,
        active_pattern: p.active_pattern,
        sequencerStopped: !!p.sequencerStopped,
        muted: !!p.muted, // legacy export
        transpose: p.transpose || 0,
        sequencerType: p.sequencerType || "mono",
        drumNotes: Array.isArray(p.drumNotes) ? p.drumNotes.slice(0, 7) : undefined,
        ccNumber: clamp(Math.round(p.ccNumber ?? DEFAULT_CC), 0, 127),
        mdTrack: clamp(Math.round(p.mdTrack || 1), 1, 16),
        patterns
      };
    });
    return {
      tempo: this.tempo,
      swing: this.swing,
      baseDivision: this.baseDivision,
      scale: this.scale,
      currentPage: this.currentPage,
      sequencerTypes: this.pages.map((p, idx) => (idx === 0 ? null : p?.sequencerType || "mono")),
      pages,
      deviceNames: this.deviceNames,
      deviceNotes: this.deviceNotes,
      deviceColors: this.deviceColors,
      midi: this.midi,
      ledLevels: { ...this.ledLevels },
      ccNumbers: this.pages.map((p, idx) => (idx === 0 ? null : clamp(Math.round(p?.ccNumber ?? DEFAULT_CC), 0, 127))),
      mdTracks: this.pages.map((p, idx) => (idx === 0 ? null : clamp(Math.round(p?.mdTrack || 1), 1, 16))),
      monoSlidePad: this.monoSlidePad,
      patternControlLatch: this.patternControlLatch
    };
  }

  loadSnapshot(snap) {
    if (!snap || typeof snap !== "object") return false;
    if (snap.tempo) this.tempo = clamp(Number(snap.tempo) || 120, 20, 300);
    if (snap.swing) this.swing = clamp(Number(snap.swing) || 50, 50, 80);
    if (snap.baseDivision) this.setBaseDivision(snap.baseDivision);
    if (snap.scale && typeof snap.scale === "object") {
      this.scale = {
        root: clamp(Number(snap.scale.root) || 0, -24, 24),
        mode: snap.scale.mode || "major"
      };
    }
    if (snap.currentPage) {
      this.currentPage = clamp(Math.round(snap.currentPage) || this.currentPage || 1, 1, 8);
    }
    if (snap.ledLevels && typeof snap.ledLevels === "object") {
      Object.keys(this.ledLevels).forEach((k) => {
        if (snap.ledLevels[k] !== undefined) {
          this.ledLevels[k] = clamp(Math.round(snap.ledLevels[k]), 0, 15);
        }
      });
    }
    if (Array.isArray(snap.deviceNames)) this.deviceNames = snap.deviceNames.slice(0, 9);
    if (Array.isArray(snap.deviceNotes)) this.deviceNotes = snap.deviceNotes.slice(0, 9);
    if (Array.isArray(snap.deviceColors)) this.deviceColors = snap.deviceColors.slice(0, 9);
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
    if (snap.monoSlidePad !== undefined) {
      this.setMonoSlidePad(snap.monoSlidePad);
    }
    if (typeof snap.patternControlLatch === "boolean") {
      this.patternControlLatch = snap.patternControlLatch;
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
        page.sequencerStopped = typeof pageSnap.sequencerStopped === "boolean"
          ? pageSnap.sequencerStopped
          : (typeof pageSnap.muted === "boolean" ? pageSnap.muted : !!page.sequencerStopped);
        page.pendingStop = null;
        page.pendingMute = null; // legacy mute flag
        page.sequencerType = pageSnap.sequencerType || page.sequencerType || "mono";
        this.sequencerTypes[p] = page.sequencerType;
        page.transpose = clamp(pageSnap.transpose || 0, -24, 24);
        page.ccNumber = clamp(Math.round(pageSnap.ccNumber ?? page.ccNumber ?? DEFAULT_CC), 0, 127);
        page.mdTrack = clamp(Math.round(pageSnap.mdTrack || page.mdTrack || 1), 1, 16);
        if (Array.isArray(pageSnap.drumNotes)) page.drumNotes = pageSnap.drumNotes.slice(0, 7).map((n) => clamp(Number(n) || 0, 0, 127));
        page.active_pattern = clamp(pageSnap.active_pattern || 1, 1, 8);
        if (Array.isArray(pageSnap.patterns)) {
          for (let pi = 1; pi <= 8; pi++) {
            const patSnap = pageSnap.patterns[pi];
            if (!patSnap) continue;
            const pat = page.patterns[pi];
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
            micro: ss.micro || 0,
            accent: !!ss.accent,
            slide: !!ss.slide,
            tie: !!ss.tie,
            cc: clamp(Math.round(ss.cc || 0), 0, 127),
            notes: Array.isArray(ss.notes) ? ss.notes.map((n) => clamp(n, 0, 6)) : [],
            accented: Array.isArray(ss.accented) ? ss.accented.map((n) => clamp(n, 0, 6)) : [],
            noteOctaves: this.sanitizeNoteOctaves(ss.noteOctaves)
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

  handleGridKey(x, y, s, opts = {}) {
    const forcePatternControl = !!opts.forcePatternControl;
    if (forcePatternControl) {
      return this.handlePatternControlKey(x, y, s);
    }
    // Pattern control toggle (pattern launcher) is always handled first
    if (y === 7 && x === PATTERN_CONTROL_BUTTON) {
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
    if (y === 7) {
      if (x === 14) {
        // pattern switch modifier (immediate)
        this.patternHeld = s === 1;
        return null;
      }
      if (s !== 1) return;
      const idx = x + 1;
      if (idx >= 1 && idx <= 8) {
        if (this.patternHeld) {
          this.setPattern(idx, this.currentPage);
          return { type: "pattern_status", page: this.currentPage };
        } else {
          this.setPage(idx);
        }
      }
      return;
    }
    if (y >= 0 && y < 7) {
      const page = this.pages[this.currentPage];
      const pat = this.getPattern();
      const abs = pat ? x + pat.barView * 16 : -1;
      const step = pat && abs >= 0 ? pat.steps[abs] : null;
      const seqType = page?.sequencerType || "mono";
      if (seqType === "cc") {
        return this.handleCCKey(x, y, s, pat);
      }
      const targetDegree = clamp(6 - y, 0, 6);
      const key = `${x},${y}`;
      const heldKey = this.heldStep ? `${this.heldStep.x},${this.heldStep.y}` : null;
      const heldInfo = heldKey ? this.keyHolds.get(heldKey) : null;
      if (s === 1) {
        const heldAbs = this.heldStep && pat ? this.heldStep.x + pat.barView * 16 : -1;
        const heldStepObj = heldAbs >= 0 ? pat?.steps[heldAbs] : null;
        const wasOn = heldInfo?.wasOn || heldStepObj?.on;
        const heldDuration = heldInfo?.start ? (Date.now() - heldInfo.start) : 0;
        const currentAction = heldInfo?.action || null;
        const sameCell = this.heldStep && this.heldStep.x === x && this.heldStep.y === y;
        const upDownNeighbor = this.heldStep && this.heldStep.x === x && Math.abs(this.heldStep.y - y) === 1;
        // slide can come from any press in the immediate right column, as long as that step is active
        const rightNeighbor = this.heldStep && this.heldStep.x + 1 === x;
        let inEdit = this.heldStep && (heldInfo?.editMode || heldDuration >= 150);
        if (this.heldStep && heldInfo && !heldInfo.editMode && heldDuration >= 150) {
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
          }
        }
        // once an edit action is taken, block further presses until the held note is released
        if (inEdit && heldInfo?.actionDone) {
          return null;
        }
        if (inEdit && !(sameCell || upDownNeighbor || rightNeighbor)) {
          return null;
        }
        const seqTypeSlide = page?.sequencerType || "mono";
        const slideAllowed = seqTypeSlide === "mono" &&
          inEdit && rightNeighbor && heldStepObj?.on && (!currentAction || currentAction === "slide");
        const mdSlideAllowed = seqTypeSlide === "mdtonal" &&
          inEdit && rightNeighbor && heldStepObj?.on && (!currentAction || currentAction === "mdslide");
        if (slideAllowed) {
          heldStepObj.slide = !heldStepObj.slide;
          if (heldInfo) {
            heldInfo.slideTriggered = true;
            heldInfo.action = "slide";
            heldInfo.actionDone = true;
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
            heldInfo.actionDone = true;
            this.keyHolds.set(heldKey, heldInfo);
          }
          this.heldStepModified = true;
          return { type: "slide", x: this.heldStep.x, y: this.heldStep.y, slide: heldStepObj.mdSlide };
        }
        const allowNeighborGesture = inEdit && wasOn && upDownNeighbor && (!currentAction || currentAction === "octave") && (page?.sequencerType || "mono") !== "drum";
        if (allowNeighborGesture) {
          if (heldInfo) {
            heldInfo.action = "octave";
            heldInfo.actionDone = false;
            this.keyHolds.set(heldKey, heldInfo);
          }
          const res = this.handleNeighborGesture(x, y);
          this.heldStepModified = true;
          if (res?.type === "octave") {
            this.enqueueOctaveOverlay({ page: this.currentPage, ...res });
          }
          return res;
        }
        if (!inEdit) {
          const now = Date.now();
          const seqTypeCur = page?.sequencerType || "mono";
          const noteWasOn = (seqTypeCur === "poly" || seqTypeCur === "drum")
            ? (!!step?.on && Array.isArray(step?.notes) && step.notes.includes(targetDegree))
            : !!step?.on;
          this.keyHolds.set(key, { start: now, wasOn: noteWasOn, editMode: false, action: null, actionDone: false });
          this.holdStart = now;
          // schedule entry into edit mode after hold threshold
          const timer = setTimeout(() => {
            const info = this.keyHolds.get(key);
            if (!info || info.editMode) return;
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
            }
          }, 150);
          this.holdTimers.set(key, timer);
        }
        this.holdTargetDegree = targetDegree;
        // change/add note on existing step without toggling if pressing a different row in same column
        if (step && step.on && step.degree !== targetDegree) {
          const seqTypeCur = page?.sequencerType || "mono";
          if (seqTypeCur === "poly" || seqTypeCur === "drum") {
            if (!Array.isArray(step.notes)) step.notes = [];
            if (step.notes.includes(targetDegree)) {
              // note already present; just enter hold/edit for this note
              this.heldStep = { x, y };
              this.heldStepModified = false;
              return null;
            }
            step.notes.push(targetDegree);
            step.degree = step.notes[0] ?? targetDegree;
            step.slide = false; // no slides in poly
            step.accent = false; // per-note accent only
            if (!step.noteOctaves || typeof step.noteOctaves !== "object") step.noteOctaves = {};
            if (!Object.prototype.hasOwnProperty.call(step.noteOctaves, targetDegree)) {
              step.noteOctaves[targetDegree] = 0;
            }
          } else {
            step.degree = targetDegree;
            step.notes = [targetDegree];
            step.slide = false;
            step.octave = 0;
          }
          step.micro = 0;
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
              step.noteOctaves[targetDegree] = step.octave || 0;
            }
          } else {
            step.degree = targetDegree;
            step.notes = [targetDegree];
            step.slide = false;
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
        const keepEdit = holdInfo?.editMode && !holdInfo?.actionDone && holdInfo?.slideTriggered && !holdInfo?.octaveChanged;
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
        const targetDeg = clamp(6 - y, 0, 6);
        // long press toggles accent
        if (duration >= 150 && holdInfo?.wasOn && step2.on && !holdInfo?.octaveChanged && !holdInfo?.slideTriggered && (!holdInfo?.action || holdInfo.action === "accent")) {
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
          if (holdInfo) holdInfo.actionDone = true;
          this.heldStepModified = false;
          return { type: "accent", x: hx, y: hy, accent: seqType === "poly" ? step2.accented.includes(targetDeg) : step2.accent };
        }
        if (this.heldStepModified) {
          this.heldStepModified = false;
          return null;
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
            if (idx !== -1) {
              step2.notes.splice(idx, 1);
              if (Array.isArray(step2.accented)) step2.accented = step2.accented.filter((n) => n !== targetDeg);
              if (step2.noteOctaves && typeof step2.noteOctaves === "object") {
                delete step2.noteOctaves[targetDeg];
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

  getStepInfo(x, y) {
    if (y < 0 || y >= 7) return { exists: false, on: false };
    const page = this.pages[this.currentPage];
    const pat = this.getPattern();
    if (!pat) return { exists: false, on: false };
    const abs = x + (pat.barView || 0) * 16;
    if (abs < 0 || abs >= pat.steps.length) return { exists: false, on: false };
    const step = pat.steps[abs];
    const nextStep = pat.steps[abs + 1];
    const seqType = page?.sequencerType || "mono";
    const degree = clamp(6 - y, 0, 6);
    const isNoteOn = seqType === "poly" || seqType === "drum"
      ? (Array.isArray(step?.notes) && step.notes.includes(degree))
      : !!step?.on;
    const accent = seqType === "poly" || seqType === "drum"
      ? (Array.isArray(step?.accented) && step.accented.includes(degree))
      : !!step?.accent;
    const slideProp = seqType === "mdtonal" ? "mdSlide" : "slide";
    const canSlide = seqType === "mono" || seqType === "mdtonal";
    const canAccent = seqType !== "cc";
    return {
      exists: !!step,
      on: isNoteOn,
      octave: this.getNoteOctave(step, degree),
      accent,
      slide: !!step?.[slideProp],
      seqType,
      degree,
      canSlide: isNoteOn && canSlide,
      nextOn: !!nextStep?.on,
      canAccent: isNoteOn && canAccent
    };
  }

  setStepAccent(x, y, value) {
    const info = this.getStepInfo(x, y);
    if (!info.exists || !info.on || !info.canAccent) return null;
    const pat = this.getPattern();
    const abs = x + (pat.barView || 0) * 16;
    const step = pat?.steps?.[abs];
    if (!step) return null;
    const targetDeg = clamp(6 - y, 0, 6);
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

  setStepSlide(x, y, value) {
    const pat = this.getPattern();
    const page = this.pages[this.currentPage];
    const seqType = page?.sequencerType || "mono";
    if (!pat || y < 0 || y >= 7) return null;
    const abs = x + (pat.barView || 0) * 16;
    if (abs < 0 || abs >= pat.steps.length) return null;
    const step = pat.steps[abs];
    if (!step?.on) return null;
    if (seqType !== "mono" && seqType !== "mdtonal") return null;
    const prop = seqType === "mdtonal" ? "mdSlide" : "slide";
    step[prop] = !!value;
    return { slide: step[prop] };
  }

  setStepOctave(x, y, delta) {
    const pat = this.getPattern();
    const page = this.pages[this.currentPage];
    const seqType = page?.sequencerType || "mono";
    if (!pat || y < 0 || y >= 7) return null;
    if (seqType === "drum" || seqType === "cc") return null;
    const abs = x + (pat.barView || 0) * 16;
    if (abs < 0 || abs >= pat.steps.length) return null;
    const step = pat.steps[abs];
    if (!step?.on) return null;
    const targetDeg = clamp(6 - y, 0, 6);
    if (seqType === "poly") {
      if (!Array.isArray(step.notes) || !step.notes.includes(targetDeg)) return null;
      if (!step.noteOctaves || typeof step.noteOctaves !== "object") step.noteOctaves = {};
      const currentOct = this.getNoteOctave(step, targetDeg);
      const nextOct = clamp((currentOct || 0) + (delta || 0), -2, 2);
      if (nextOct === currentOct) return null;
      step.noteOctaves[targetDeg] = nextOct;
      this.enqueueOctaveOverlay({ page: this.currentPage, x, y, octave: nextOct, delta: delta || 0 });
      return { octave: nextOct, delta: delta || 0 };
    }
    // keep octave offsets within a musical window
    const nextOct = clamp((step.octave || 0) + (delta || 0), -2, 2);
    if (nextOct === (step.octave || 0)) return null;
    step.octave = nextOct;
    this.enqueueOctaveOverlay({ page: this.currentPage, x, y, octave: step.octave, delta: delta || 0 });
    return { octave: step.octave, delta: delta || 0 };
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
        const stopRes = this.queueDeviceSequencerToggle(x + 1);
        return stopRes ? { type: "device_sequencer", page: x + 1 } : null;
      }
      return null;
    }
    if (x >= 0 && x < 8 && y >= 0 && y <= 6 && s === 1) {
      const patternIdx = y + 1; // top row = pattern 1
      const pageIdx = x + 1;
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

  handleNeighborGesture(nx, ny) {
    const pat = this.getPattern();
    if (!pat) return;
    const dy = ny - this.heldStep.y;
    if (dy === 0) return null;
    const delta = dy < 0 ? 1 : -1;
    // reuse setStepOctave so the same path is used for monome/UI updates
    const res = this.setStepOctave(this.heldStep.x, this.heldStep.y, delta);
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
    if (abs < 0 || abs >= pat.steps.length) return null;
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

  clearStep(pat, abs, pageIdx = this.currentPage) {
    const step = pat.steps[abs];
    if (!step) return;
    const prevDeg = step.degree || 0;
    const yPos = clamp(6 - prevDeg, 0, 6);
    const xPos = abs % 16;
    // clear any slide relationships involving this step
    step.slide = false;
    step.mdSlide = false;
    if (abs > 0) {
      const prev = pat.steps[abs - 1];
      if (prev && prev.slide) prev.slide = false;
      if (prev && prev.mdSlide) prev.mdSlide = false;
      if (prev && prev.tie) prev.tie = false;
    }
    const next = pat.steps[abs + 1];
    if (next && step.slide) step.slide = false;
    if (next && step.mdSlide) step.mdSlide = false;
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
    // clear overlays for the notes that existed on this step
    const clears = [];
    if (prevNotes.length) {
      prevNotes.forEach((deg) => clears.push({ x: xPos, y: clamp(6 - deg, 0, 6) }));
    } else {
      clears.push({ x: xPos, y: yPos });
    }
    this.enqueueOctaveOverlay({ page: pageIdx, clears, clear: true });
  }

  patternSnapshot(page, pattern) {
    if (page < 1 || page > 8) return null;
    const pg = this.pages[page];
    if (!pg) return null;
    const pat = pg.patterns[pattern];
    if (!pat) return null;
    return {
      length_steps: pat.length_steps,
      barView: pat.barView || 0,
      steps: pat.steps.map((s) => ({
        on: !!s.on,
        degree: s.degree || 0,
        octave: s.octave || 0,
        micro: s.micro || 0,
        accent: !!s.accent,
        slide: !!s.slide,
        tie: !!s.tie,
        cc: clamp(Math.round(s.cc || 0), 0, 127),
        mdSlide: !!s.mdSlide,
        notes: Array.isArray(s.notes) ? s.notes.slice() : [],
        accented: Array.isArray(s.accented) ? s.accented.slice() : [],
        noteOctaves: this.sanitizeNoteOctaves(s.noteOctaves)
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
    pat.barView = clamp(snap.barView || 0, 0, Math.max(0, Math.ceil(pat.length_steps / 16) - 1));
    for (let i = 0; i < pat.steps.length && i < snap.steps.length; i++) {
      const s = snap.steps[i];
      if (!s) continue;
      pat.steps[i] = {
        on: !!s.on,
        degree: clamp(s.degree || 0, 0, 6),
        octave: clamp(s.octave || 0, -3, 4),
        micro: s.micro || 0,
        accent: !!s.accent,
        slide: !!s.slide,
        tie: !!s.tie,
        mdSlide: !!s.mdSlide,
        cc: clamp(Math.round(s.cc || 0), 0, 127),
        notes: Array.isArray(s.notes) ? s.notes.map((n) => clamp(n, 0, 6)) : [],
        accented: Array.isArray(s.accented) ? s.accented.map((n) => clamp(n, 0, 6)) : [],
        noteOctaves: this.sanitizeNoteOctaves(s.noteOctaves)
      };
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
        micro: s.micro || 0,
        accent: !!s.accent,
        slide: !!s.slide,
        tie: !!s.tie,
        mdSlide: !!s.mdSlide,
        cc: clamp(Math.round(s.cc || 0), 0, 127),
        notes: Array.isArray(s.notes) ? s.notes.map((n) => clamp(n, 0, 6)) : [],
        accented: Array.isArray(s.accented) ? s.accented.map((n) => clamp(n, 0, 6)) : [],
        noteOctaves: this.sanitizeNoteOctaves(s.noteOctaves)
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
    pat.steps.forEach((_, idx) => this.clearStep(pat, idx, page));
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
      this.clearStep(pat, start + i, page);
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
    let changed = false;

    // shift horizontally (wrap within the active pattern length)
    if (dxRaw) {
      const norm = ((dxRaw % len) + len) % len;
      if (norm) {
        const nextSteps = pat.steps.slice();
        for (let i = 0; i < len; i++) {
          const dest = (i + norm) % len;
          nextSteps[dest] = pat.steps[i];
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
      for (let i = 0; i < len; i++) {
        const step = pat.steps[i];
        if (!step?.on) continue;
        if (seqType === "poly" || seqType === "drum") {
          const notes = Array.isArray(step.notes) ? step.notes : [];
          const newNotes = notes.map((n) => wrapDegree(n));
          const newOctaves = {};
          if (step.noteOctaves && typeof step.noteOctaves === "object") {
            Object.entries(step.noteOctaves).forEach(([degRaw, oct]) => {
              const baseDeg = clamp(Math.round(Number(degRaw) || 0), 0, 6);
              const mapped = wrapDegree(baseDeg);
              newOctaves[mapped] = oct;
            });
          }
          step.notes = newNotes;
          step.degree = newNotes[0] ?? wrapDegree(step.degree || 0);
          if (Array.isArray(step.accented)) {
            step.accented = step.accented.map((n) => wrapDegree(n));
          }
          step.noteOctaves = newOctaves;
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
      this.heldStep = null;
      this.heldStepModified = false;
      this.heldStepPendingOff = false;
      this.keyHolds.clear();
      this.holdTimers.forEach((t) => clearTimeout(t));
      this.holdTimers.clear();
    }
    return changed;
  }

  tick(follow = false, externalStepMs = null) {
    const barChanges = follow ? this.applyFollow() : [];
    const barPlayheadChanges = [];
    const midiEvents = [];
    this.lastTickTime = Date.now();
    const currentTick = this.tickCount; // use pre-increment tick for alignment
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
      if (this.skipNextNote && this.skipNextNote[p] === stepPos) {
        delete this.skipNextNote[p];
        this.pageTickPos[p] = stepPos;
        this.playheads[p] = stepPos;
        continue;
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
      // Legacy mute path kept for reference:
      // if (page.muted) {
      //   // advance playhead but skip emitting notes
      // } else if (seqTypePlay === "mdtonal") { ... }
      if (seqTypePlay === "mdtonal") {
        if (step?.on) {
          const baseDur = externalStepMs || this.stepDurationMs(1);
          const swingAmt = Math.max(0, Math.min(0.5, (this.swing || 50) > 50 ? (this.swing - 50) / 60 : 0));
          const delayMs = (pos % 2 === 1) ? Math.round(baseDur * swingAmt) : 0;
          const trackCfg = this.mdTrackConfig(p);
          const pageTranspose = this.pages[p]?.transpose || 0;
          const value = this.mdCCFromDegree(step.degree || 0, pageTranspose, step.octave || 0);
          if (value != null) {
            const slideActive = step.mdSlide && nextStep?.on;
            if (slideActive) {
              const nextValue = this.mdCCFromDegree(nextStep.degree || 0, pageTranspose, nextStep.octave || 0);
              const fromVal = value;
              const targetVal = nextValue != null ? nextValue : value;
              // ensure the first slide step sets its own pitch immediately
              midiEvents.push({
                type: "midi_cc",
                page: p,
                cc: trackCfg.ccNumber,
                value: fromVal,
                delayMs,
                chan: trackCfg.ccChannel
              });
              this.mdGlideValue[p] = fromVal;
              const glideEvents = this.mdGlide(p, fromVal, targetVal, delayMs + baseDur, this.mdBaseSweep);
              glideEvents.forEach((ev) => {
                midiEvents.push({
                  type: "midi_cc",
                  page: p,
                  cc: trackCfg.ccNumber,
                  value: ev.value,
                  delayMs: ev.delay,
                  chan: trackCfg.ccChannel
                });
              });
              this.skipNextMDNote = this.skipNextMDNote || {};
              this.skipNextMDNote[p] = (pos + 1) % len;
            } else {
              midiEvents.push({
                type: "midi_cc",
                page: p,
                cc: trackCfg.ccNumber,
                value,
                delayMs,
                chan: trackCfg.ccChannel
              });
              this.mdGlideValue[p] = value;
            }
            if (!skipMdNote) {
              const noteDur = Math.max(1, Math.round(baseDur * 0.5 - this.noteOffEpsilonMs));
              midiEvents.push({
                type: "midi_note",
                page: p,
                pitch: trackCfg.noteNumber,
                vel: step.accent ? 120 : 96,
                durMs: noteDur,
                delayMs,
                chan: trackCfg.noteChannel
              });
            }
          }
        }
      } else if (seqTypePlay === "cc") {
        if (step?.on) {
          const baseDur = externalStepMs || this.stepDurationMs(1);
          const swingAmt = Math.max(0, Math.min(0.5, (this.swing || 50) > 50 ? (this.swing - 50) / 60 : 0));
          const delayMs = (pos % 2 === 1) ? Math.round(baseDur * swingAmt) : 0;
          const chan = clamp(this.midi[p]?.channel || 1, 1, 16);
          const ccNum = clamp(Math.round(page.ccNumber ?? DEFAULT_CC), 0, 127);
          const value = clamp(Math.round(step.cc ?? 0), 0, 127);
          midiEvents.push({ type: "midi_cc", page: p, cc: ccNum, value, delayMs, chan });
        }
      } else if (step?.on) {
        // Note duration should stay at base 16th regardless of pattern time scale
        const baseDur = externalStepMs || this.stepDurationMs(1);
        const swingAmt = Math.max(0, Math.min(0.5, (this.swing || 50) > 50 ? (this.swing - 50) / 60 : 0));
        const delayMs = (pos % 2 === 1) ? Math.round(baseDur * swingAmt) : 0;
        const chan = clamp(this.midi[p]?.channel || 1, 1, 16);
        {
          const degrees = (seqTypePlay === "poly" || seqTypePlay === "drum") && Array.isArray(step.notes) && step.notes.length
            ? step.notes
            : [step.degree || 0];
          const mode = (this.scale && this.scale.mode) || "major";
          if (seqTypePlay === "mono") {
            const pageTranspose = this.pages[p].transpose || 0;
            const pitchCur = this.calcPitch(pat.root || 0, mode, step.degree || 0, step.octave || 0) + pageTranspose;
            const prevSlidesHere = prevStep?.on && prevStep?.slide;
            const isSlideStart = step.slide;
            const chainLen = this.slideChainLength(pat, pos);
            const noteVel = step.accent ? 120 : 96;
            if (prevSlidesHere) {
              const pitchPrev = this.calcPitch(pat.root || 0, mode, prevStep.degree || 0, prevStep.octave || 0) + pageTranspose;
              const samePitch = pitchPrev === pitchCur;
              if (samePitch) {
                continue; // already held by previous slide gate
              }
              if (!step.slide) {
                const durMs = Math.max(1, Math.round(baseDur - this.noteOffEpsilonMs)); // slide ended; play target at normal length
                midiEvents.push({ type: "midi_note", page: p, pitch: pitchCur, vel: noteVel, durMs, delayMs, chan });
                continue;
              }
              // Trim by swing/epsilon plus a small margin so the slide gate doesn't run past the following note.
              const chainDurMs = baseDur * Math.max(1, chainLen);
              const slidePad = this.monoSlidePad || 0;
              const padMs = this.noteOffEpsilonMs + delayMs + Math.round(chainDurMs * slidePad);
              const durMs = Math.max(1, Math.round(chainDurMs - padMs));
              midiEvents.push({ type: "midi_note", page: p, pitch: pitchCur, vel: noteVel, durMs, delayMs, chan });
              continue;
            }
            if (isSlideStart) {
              const chainDurMs = baseDur * Math.max(1, chainLen);
              const slidePad = this.monoSlidePad || 0;
              const padMs = this.noteOffEpsilonMs + delayMs + Math.round(chainDurMs * slidePad);
              const durMs = Math.max(1, Math.round(chainDurMs - padMs)); // hold through the chain without overshooting
              midiEvents.push({ type: "midi_note", page: p, pitch: pitchCur, vel: noteVel, durMs, delayMs, chan });
              continue;
            }
            if (step.tie) {
              const durMs = baseDur * 2; // tie adds one step
              midiEvents.push({ type: "midi_note", page: p, pitch: pitchCur, vel: noteVel, durMs, delayMs, chan });
              this.skipNextNote = this.skipNextNote || {};
              this.skipNextNote[p] = (pos + 1) % len;
              continue;
            }
          }
          degrees.forEach((deg) => {
            let pitch;
            if (seqTypePlay === "drum") {
              const drumMap = Array.isArray(page.drumNotes) ? page.drumNotes : [];
              pitch = drumMap[deg] ?? 36;
            } else {
              const pageTranspose = this.pages[p].transpose || 0;
              const octave = seqTypePlay === "poly" ? this.getNoteOctave(step, deg) : this.getNoteOctave(step, deg || 0);
              pitch = this.calcPitch(pat.root || 0, mode, deg || 0, octave) + pageTranspose;
            }
            const durMs = Math.max(1, Math.round(baseDur - this.noteOffEpsilonMs)); // default one step with slight shorten
            const noteVel = (seqTypePlay === "poly" || seqTypePlay === "drum")
              ? (Array.isArray(step.accented) && step.accented.includes(deg) ? 120 : 96)
              : (step.accent ? 120 : 96);
            midiEvents.push({ type: "midi_note", page: p, pitch, vel: noteVel, durMs, delayMs, chan });
          });
        }
      }
      // pattern/mute changes handled before step processing for tighter LED alignment
    }
    this.tickCount = (this.tickCount + 1) % 1024;
    const ledFrame = this.renderLED();
    return { midiEvents, ledFrame, patternSwitches, barChanges, barPlayheadChanges };
  }

  applyFollow() {
    const changes = [];
    const page = this.pages[this.currentPage];
    if (!page) return changes;
    const pat = page.patterns[page.active_pattern];
    if (!pat) return changes;
    const len = Math.max(1, pat.length_steps || 16);
    const bars = Math.max(1, Math.ceil(len / 16));
    const pos = this.playheads[this.currentPage] % len;
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

  calcPitch(root, scale_mode, degree, octave) {
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
      "whole_tone": [0, 2, 4, 6, 8, 10, 12],
      "chromatic": [0, 1, 2, 3, 4, 5, 6]
    };
    const globalScale = this.scale || { root: 0, mode: "major" };
    const scale = scales[scale_mode] || scales[globalScale.mode] || scales.major;
    const deg = clamp(degree, 0, scale.length - 1);
    return BASE_PITCH + (globalScale.root || 0) + root + scale[deg] + (octave || 0) * 12;
  }

  stepDurationMs(time_scale) {
    const div = Math.max(1, this.baseDivision || 16); // denominator of note length (1/div)
    return (60000 / this.tempo) * 4 / div * (time_scale || 1);
  }

  clampMicro(micro) {
    return 0; // micro timing disabled
  }

  slideChainLength(pat, startIdx) {
    if (!pat || !Array.isArray(pat.steps)) return 1;
    const len = Math.max(1, Math.min(pat.length_steps || 16, pat.steps.length));
    let span = 1;
    let idx = startIdx;
    while (span < len) {
      const cur = pat.steps[idx];
      if (!cur?.slide) break;
      const nextIdx = (idx + 1) % len;
      const nextStep = pat.steps[nextIdx];
      span += 1; // include the next slot even if empty to allow slide hold over a rest
      if (!nextStep?.on) break;
      if (!nextStep.slide) break; // stop after adding target if chain ends there
      idx = nextIdx;
    }
    return span;
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
      if (seqType === "mono" && (step.slide || step.tie)) return true;
      if (seqType === "mdtonal" && step.mdSlide) return true;
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
    const PATTERN_ACTIVE = this.ledLevels.pattern_active;
    const PATTERN_INACTIVE = this.ledLevels.pattern_inactive;
    const PATTERN_PENDING = this.ledLevels.pattern_pending;
    const PATTERN_MUTED = Math.max(1, Math.min(15, Math.round(PATTERN_ACTIVE * 0.4)));
    const PATTERN_HAS_DATA = Math.max(PATTERN_INACTIVE + 2, Math.min(15, Math.round(PATTERN_ACTIVE * 0.75)));
    const DEVICE_PRESENT = this.ledLevels.device_present;
    const DEVICE_ACTIVE = this.ledLevels.device_active;
    const DEVICE_HAS_DATA = Math.max(DEVICE_PRESENT - 2, PATTERN_HAS_DATA);
    const PLAYHEAD = this.ledLevels.playhead;
    const frame = new Array(WIDTH * HEIGHT).fill(OFF);
    for (let col = 0; col < 8; col++) {
      const pageIdx = col + 1;
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
      frame[7 * WIDTH + col] = stopLevel;
    }
    // indicator for control mode toggle: only bright when pattern control is active/held
    // keep the button dark when inactive; only light when pressed/latched
    const ctlActive = this.patternControlMode || this.patternControlHeld;
    const ctlLevel = ctlActive ? PATTERN_ACTIVE : OFF;
    frame[7 * WIDTH + PATTERN_CONTROL_BUTTON] = ctlLevel;
    // dim other control buttons (exclude the control button itself)
    frame[7 * WIDTH + 14] = PATTERN_INACTIVE;
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
      const pageIdx = col + 1;
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
      frame[7 * WIDTH + col] = stopLevel;
    }
    // pattern control button indicator (col 15) not visible on 8x8 crop but keep it consistent
    const ctlActive = this.patternControlMode || this.patternControlHeld;
    frame[7 * WIDTH + PATTERN_CONTROL_BUTTON] = ctlActive && blinkSlow ? 1 : 0;
    return frame;
  }

  renderLED(slideTimeMs, opts = {}) {
    const includeOctaveHint = opts.includeOctaveHint !== false;
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
    if (this.patternControlMode) {
      return this.renderPatternControlLED();
    }
    const pat = page?.patterns[page?.active_pattern];
    const heldKey = this.heldStep ? `${this.heldStep.x},${this.heldStep.y}` : null;
    const heldInfo = heldKey ? this.keyHolds.get(heldKey) : null;
    const inEditMode = this.heldStep && heldInfo && (heldInfo.editMode || (heldInfo.start && (Date.now() - heldInfo.start) >= 150));
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
              const nextStep = pat.steps[abs + 1];
              if (nextStep?.on) {
                slideStarts.push({
                  x1: x,
                  y1: clamp(6 - step.degree, 0, 6),
                  accent1: !!step.accent
                });
              }
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
            if ((seq === "mono" && (step.slide || step.tie)) || (seq === "mdtonal" && step.mdSlide)) {
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
      if (!page.sequencerStopped) {
        const ph = this.playheads[this.currentPage] % Math.max(1, pat.length_steps);
        const phBar = Math.floor(ph / 16);
        if (phBar === bar) {
          const phX = ph % 16;
          for (let yy = 0; yy < STEP_ROWS; yy++) {
            frame[yy * WIDTH + phX] = PLAYHEAD;
          }
        }
      }
      // slide/tie indication: pulse only the originating step
      if (slideStarts.length) {
        const loopMs = 900; // ~0.9s pulse
        const t = slideTimeMs !== undefined ? slideTimeMs : Date.now();
        const phase = (t % loopMs) / loopMs; // 0..1
        const pulse = (1 - Math.cos(phase * Math.PI * 2)) * 0.5; // cosine ease 0..1..0
        slideStarts.forEach((sp) => {
          const bright = sp.accent1 ? STEP_ACCENT : STEP_ON;
          const dim = Math.max(1, Math.round(bright * 0.4));
          const level = Math.round(dim + (bright - dim) * pulse);
          frame[sp.y1 * WIDTH + sp.x1] = level;
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
      frame[7 * WIDTH + 14] = PATTERN_INACTIVE;
      frame[7 * WIDTH + PATTERN_CONTROL_BUTTON] = ctlLevel;
    } else {
      for (let i = 0; i < 8; i++) {
        const dev = this.pages[i + 1];
        const isCurrent = this.currentPage === i + 1;
        const isDevStopped = dev?.sequencerStopped;
        const hasData = dev?.patterns?.some((pat, idx) => idx > 0 && pat?.steps?.some((s) => s.on));
        const pendingStop = dev?.pendingStop;
        // const pendingMute = dev?.pendingMute;
        if (pendingStop != null) {
          frame[7 * WIDTH + i] = this.pulse ? PATTERN_ACTIVE : PATTERN_PENDING;
        } else if (isCurrent) {
          frame[7 * WIDTH + i] = isDevStopped ? PATTERN_MUTED : DEVICE_ACTIVE;
        } else if (isDevStopped) {
          frame[7 * WIDTH + i] = PATTERN_INACTIVE;
      } else {
        frame[7 * WIDTH + i] = hasData ? DEVICE_HAS_DATA : DEVICE_PRESENT;
      }
      }
      // const isPending = page && page.pending_pattern;
      // const isMuted = page?.muted;
      // const isStopped = page?.sequencerStopped;
      const ctlLevel = (this.patternControlMode || this.patternControlHeld) ? PATTERN_ACTIVE : PATTERN_INACTIVE;
      frame[7 * WIDTH + 14] = PATTERN_INACTIVE;
      frame[7 * WIDTH + PATTERN_CONTROL_BUTTON] = ctlLevel;
    }
    return frame;
  }
}
// studio grid server-side state: tracks pages, patterns, playback, clock, MIDI events, monome LED frames, and import/export snapshots.
