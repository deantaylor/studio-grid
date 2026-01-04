import { AudioEventScheduler } from "./scheduler.js";

const WS_URL = `ws://${location.host}`;
const WIDTH = 16;
const HEIGHT = 8;
const CELL_SIZE = 32;
const CELL_GAP = 12;
const CANVAS_WIDTH = WIDTH * CELL_SIZE + (WIDTH - 1) * CELL_GAP;
const CANVAS_HEIGHT = HEIGHT * CELL_SIZE + (HEIGHT - 1) * CELL_GAP;
const BASE_WINDOW_WIDTH = 860;
const BASE_WINDOW_HEIGHT = window.innerHeight || document.documentElement.clientHeight || 640;
const OFF_COLOR = "#ececec";
const ON_COLOR_DEFAULT = "#ff8e8e";
let onColor = ON_COLOR_DEFAULT;
const LABEL_COLOR = (getComputedStyle(document.documentElement).getPropertyValue("--panel-strong") || "#424242").trim() || "#424242";
const LABEL_FONT = "400 8px 'Inter', sans-serif";
const DEFAULT_STEP_ROWS = 7;
const STEP_ON = 8;
const STEP_MICRO = 6;
const PLAYHEAD = 10;
const PATTERN_ACTIVE = 12;
const PATTERN_INACTIVE = 4;
const DEVICE_ACTIVE = 15;
const DEVICE_PRESENT = 8;
const BASE_PITCH = 60;
const PPQN = 24;
const TICKS_PER_STEP = 6;

let ws;
let midiAccess;
let midiOut = null; // for current page only
let tempo = 120;
let swing = 50;
let running = false;
let tickTimer = null;
let currentPage = 1;
let currentPattern = 1;
let baseDivision = 16; // denominator of base note (1/16)
let playheads = Array(9).fill(0);
let deviceHeld = false;
let draggedDevicePage = null;
let midiSettings = Array.from({ length: 9 }, () => ({ outId: "", channel: 1 }));

const canvas = document.getElementById("grid");
// fix canvas size for 40px cells with 16px gaps
canvas.width = CANVAS_WIDTH;
canvas.height = CANVAS_HEIGHT;
canvas.style.width = `${CANVAS_WIDTH}px`;
canvas.style.height = `${CANVAS_HEIGHT}px`;
const ctx = canvas.getContext("2d");
const logEl = document.getElementById("log");
const wsStatus = document.getElementById("ws-status");
const midiStatus = document.getElementById("midi-status");
const tempoInput = document.getElementById("tempo");
const tempoLabelTop = document.getElementById("tempo-label-top");
const tempoBlock = document.getElementById("tempo-block");
const swingInput = document.getElementById("swing");
const swingLabelTop = document.getElementById("swing-label-top");
const swingBlock = document.getElementById("swing-block");
const midiSel = document.getElementById("midi-out");
const midiChan = document.getElementById("midi-chan");
const tabs = document.getElementById("page-tabs");
const clockSourceSel = document.getElementById("clock-source");
const clockInputSel = document.getElementById("clock-input");
const clockToggleBtn = document.getElementById("clock-toggle-btn");
const clockOutToggle = document.getElementById("clock-out-enable");
const clockOutPortSel = document.getElementById("clock-out-port");
const baseNoteLenSel = document.getElementById("base-note-length");
const scaleRootSel = document.getElementById("scale-root");
const scaleModeSel = document.getElementById("scale-mode");
const settingsTempoInput = document.getElementById("settings-tempo");
const settingsScaleRootSel = document.getElementById("settings-scale-root");
const settingsScaleModeSel = document.getElementById("settings-scale-mode");
const transposeDisplay = document.getElementById("transpose-value");
const transposeDec = document.getElementById("transpose-dec");
const transposeInc = document.getElementById("transpose-inc");
// legacy device pill (optional)
const devicePill = document.getElementById("device-pill") || null;
const settingsBtn = document.getElementById("settings-btn");
const settingsModal = document.getElementById("settings-modal");
const settingsBackdrop = document.getElementById("settings-backdrop");
const settingsClose = document.getElementById("settings-close");
const settingsSaveCfg = document.getElementById("settings-save-config");
const settingsRestoreCfg = document.getElementById("settings-restore-default");
const settingsConfirm = document.getElementById("settings-confirm");
const showLogToggle = document.getElementById("show-log");
const autoFillToggle = document.getElementById("auto-fill");
const autoLoadToggle = document.getElementById("auto-load-set");
const allowMDExternalToggle = document.getElementById("allow-md-external");
const patternControlLatchToggle = document.getElementById("pattern-control-latch");
const mdBaseSweepInput = document.getElementById("md-base-sweep");
const monoSlidePadInput = document.getElementById("mono-slide-pad");
const uiScaleSel = document.getElementById("ui-scale");
const ledInputs = {
  step_on: document.getElementById("led-step-on"),
  step_micro: document.getElementById("led-step-micro"),
  step_accent: document.getElementById("led-step-accent"),
  playhead: document.getElementById("led-playhead"),
  pattern_active: document.getElementById("led-pat-active"),
  pattern_pending: document.getElementById("led-pat-pending"),
  pattern_inactive: document.getElementById("led-pat-inactive"),
  device_present: document.getElementById("led-dev-present"),
  device_active: document.getElementById("led-dev-active"),
};
const patternRow = document.getElementById("pattern-row");
const patternSelect = document.getElementById("pattern-select");
const patternLengthBtns = document.querySelectorAll("[data-pattern-length]");
const patternScaleToggle = document.getElementById("pattern-scale-toggle");
const barRow = document.getElementById("bar-row");
const drumInputs = Array.from(document.querySelectorAll(".drum-note-input"));
const scaleNotesWrap = document.getElementById("scale-notes");
const followBtn = document.getElementById("follow-btn");
const copyPatternBtn = document.getElementById("copy-pattern-btn");
const copyBarBtn = document.getElementById("copy-bar-btn");
const pasteBtn = document.getElementById("paste-btn");
const clearBtn = document.getElementById("clear-btn");
const confirmModal = document.getElementById("confirm-modal");
const confirmClose = document.getElementById("confirm-close");
const confirmClearCancel = document.getElementById("confirm-clear-cancel");
const confirmClearPattern = document.getElementById("confirm-clear-pattern");
const confirmClearBar = document.getElementById("confirm-clear-bar");
const seqModal = document.getElementById("seq-modal");
const seqClose = document.getElementById("seq-close");
const seqOk = document.getElementById("seq-ok");
const seqKeep = document.getElementById("seq-keep");
const seqCancel = document.getElementById("seq-cancel");
let pendingSeqType = null;
let pendingSeqKeepAllowed = true;
let pendingSeqRequestId = 0;
const seqTypeSel = document.getElementById("seq-type");
const mdTrackSel = document.getElementById("md-track");
const ccNumberInput = document.getElementById("cc-number");
const newSetBtn = document.getElementById("new-set");
const newSetModal = document.getElementById("new-set-modal");
const newSetClose = document.getElementById("new-set-close");
const newSetConfirm = document.getElementById("new-set-confirm");
const newSetCancel = document.getElementById("new-set-cancel");
const keepDeviceNamesToggle = document.getElementById("keep-device-names");
const keepMidiSettingsToggle = document.getElementById("keep-midi-settings");
const colorModal = document.getElementById("color-modal");
const colorClose = document.getElementById("color-close");
const colorOptions = document.getElementById("color-options");
let colorModalPage = null;
const defaultColorTrigger = document.getElementById("default-color-trigger");
const defaultColorModal = document.getElementById("default-color-modal");
const defaultColorModalOptions = document.getElementById("default-color-options");
const defaultColorClose = document.getElementById("default-color-close");
const renameModal = document.getElementById("rename-modal");
const renameTitle = document.getElementById("rename-title");
const renameLabel = document.getElementById("rename-label");
const renameInput = document.getElementById("rename-input");
const renameSave = document.getElementById("rename-save");
const renameCancel = document.getElementById("rename-cancel");
const saveSetModal = document.getElementById("save-set-modal");
const saveSetMessage = document.getElementById("save-set-message");
const saveSetCurrent = document.getElementById("save-set-current");
const saveSetNew = document.getElementById("save-set-new");
const saveSetCancel = document.getElementById("save-set-cancel");
const dialogModal = document.getElementById("dialog-modal");
const dialogTitle = document.getElementById("dialog-title");
const dialogMessage = document.getElementById("dialog-message");
const dialogCancel = document.getElementById("dialog-cancel");
const dialogOk = document.getElementById("dialog-ok");
let dialogOkHandler = null;
let renameTargetPage = null;
let renameTargetPattern = null;
let renameMode = "device";
const renameDefaults = {
  title: renameTitle?.textContent || "Rename Device",
  label: renameLabel?.textContent || "Name",
  maxLength: renameInput?.maxLength || 8,
  inputMode: renameInput?.inputMode || "",
  type: renameInput?.type || "text"
};
const exportTd3Btn = document.getElementById("export-td3");
const td3Modal = document.getElementById("td3-modal");
const td3Backdrop = document.getElementById("td3-backdrop");
const td3GroupInput = document.getElementById("td3-group");
const td3PatternInput = document.getElementById("td3-pattern");
const td3Close = document.getElementById("td3-close");
const td3Cancel = document.getElementById("td3-cancel");
const td3Confirm = document.getElementById("td3-confirm");
const td3ActionModal = document.getElementById("td3-action-modal");
const td3ActionClose = document.getElementById("td3-action-close");
const td3ImportBtn = document.getElementById("td3-import-btn");
const td3ExportBtn = document.getElementById("td3-export-btn");
const td3ScaleModal = document.getElementById("td3-scale-modal");
const td3ScaleClose = document.getElementById("td3-scale-close");
const td3ScaleFit = document.getElementById("td3-scale-fit");
const td3ScaleSwitch = document.getElementById("td3-scale-switch");
const td3ScaleMessage = document.getElementById("td3-scale-message");
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const SCALE_STEPS = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  harmonic_minor: [0, 2, 3, 5, 7, 8, 11],
  melodic_minor: [0, 2, 3, 5, 7, 9, 11],
  whole_tone: [0, 2, 4, 6, 8, 10, 12],
  chromatic: [0, 1, 2, 3, 4, 5, 6],
};
const formatRoot = (root) => NOTE_NAMES[((Number(root) || 0) % 12 + 12) % 12];
const formatScaleStr = (scale) => {
  if (!scale) return "major (C)";
  const mode = scale.mode || "major";
  return `${mode} (${formatRoot(scale.root)})`;
};
const td3ReplaceModal = document.getElementById("td3-replace-modal");
const td3ReplaceConfirm = document.getElementById("td3-replace-confirm");
const td3ReplaceCancel = document.getElementById("td3-replace-cancel");

const initNumberSteppers = () => {
  const numberInputs = Array.from(document.querySelectorAll("input[type=\"number\"]"));

  numberInputs.forEach((input) => {
    if (input.dataset.stepperAttached === "true") {
      return;
    }

    const wrap = document.createElement("div");
    wrap.className = "number-wrap";
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    const stepper = document.createElement("button");
    stepper.type = "button";
    stepper.className = "number-stepper";
    stepper.setAttribute("aria-label", "Adjust value");
    stepper.innerHTML = "<i class=\"iconoir-arrow-separate-vertical\" aria-hidden=\"true\"></i>";
    wrap.appendChild(stepper);

    stepper.addEventListener("click", (event) => {
      const rect = stepper.getBoundingClientRect();
      const isUp = event.clientY - rect.top < rect.height / 2;

      if (isUp) {
        input.stepUp();
      } else {
        input.stepDown();
      }

      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.focus();
    });

    input.dataset.stepperAttached = "true";
  });
};

initNumberSteppers();

const DEVICE_COLOR_PALETTE = ["#d7ff73", "#ff8e8e", "#9ad7ff", "#f0c674", "#c6b8ff"];
const BASE_DEFAULT_DEVICE_COLOR = "#ffe070";
let defaultDeviceColor = BASE_DEFAULT_DEVICE_COLOR;
const AUTO_MDTONAL_COLOR = ON_COLOR_DEFAULT;
let settingsOpen = false;
let pendingDefaultDeviceColor = null;

// context menu for device tabs
const deviceMenu = document.getElementById("device-menu");
const menuRename = document.getElementById("menu-rename");
const patternLengthMenu = document.getElementById("pattern-length-menu");
const menuPatternLengthCustom = document.getElementById("menu-pattern-length-custom");
const menuColor = document.getElementById("menu-color");
let menuTargetPage = null;
const noteMenu = document.getElementById("note-menu");
const noteMenuAccent = document.getElementById("note-menu-accent");
const noteMenuSlide = document.getElementById("note-menu-slide");
let noteMenuTarget = null;
let pendingNoteMenu = null;
const octaveControls = document.createElement("div");
octaveControls.className = "note-octave-controls";
octaveControls.innerHTML = `
  <button type="button" data-delta="1" aria-label="Raise octave">↑</button>
  <button type="button" data-delta="-1" aria-label="Lower octave">↓</button>
`;
document.body.append(octaveControls);
const octaveUpBtn = octaveControls.querySelector('[data-delta="1"]');
const octaveDownBtn = octaveControls.querySelector('[data-delta="-1"]');
let hoveredStep = null;
let octaveHoverTimer = null;
let isOverOctaveControls = false;
let pendingOctaveHover = null;
let octaveHideTimer = null;
let lastOctaveTarget = null;
let remoteOctaveTimer = null;
let recentOctaveOverlay = null;
let octaveOverlayLock = false;
let tempoDisplayMode = "input";

const formatTempoDisplay = (val) => {
  const num = Math.max(20, Math.min(300, Number(val) || tempo));
  return (Math.round(num * 10) / 10).toFixed(1);
};

// mirror key controls into settings modal inputs/selects
const initialTempoDisplay = formatTempoDisplay(tempo);
if (tempoInput) tempoInput.value = initialTempoDisplay;
if (settingsTempoInput) settingsTempoInput.value = initialTempoDisplay;
if (swingInput) swingInput.value = swing;

// unified setters so either UI (main or settings) keeps things in sync
function updateTempo(val, opts = {}) {
  const broadcast = opts.broadcast !== false;
  const next = Math.max(20, Math.min(300, Number(val) || tempo));
  tempo = next;
  displayTempoVal = next;
  const display = formatTempoDisplay(displayTempoVal);
  if (tempoInput) tempoInput.value = display;
  if (settingsTempoInput) settingsTempoInput.value = display;
      if (clockSource === "internal" && running) {
        internalTickPeriodSec = 60 / (tempo * PPQN);
        internalStartTimeSec = getNowSec() - transportTick * internalTickPeriodSec;
      }
  if (broadcast) {
    ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "tempo", bpm: tempo }));
  }
}

function lockTempoPrecision(opts = {}) {
  // Snap tempo to one decimal and optionally broadcast to the server
  const rounded = Number(formatTempoDisplay(tempo));
  updateTempo(rounded, { ...opts, broadcast: opts.broadcast !== false });
}
function updateSwing(val, opts = {}) {
  const broadcast = opts.broadcast !== false;
  const swingVal = Math.max(50, Math.min(80, Number(val) || swing));
  swing = swingVal;
  if (swingInput) swingInput.value = swingVal;
  if (broadcast) {
    ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_swing", swing: swingVal }));
  }
}

// Help catch missing DOM elements early without breaking runtime
function logMissingDom(ids) {
  ids.forEach((id) => {
    if (!document.getElementById(id)) {
      console.warn(`[ui] missing element: #${id}`);
    }
  });
}

logMissingDom([
  "grid",
  "page-tabs",
  "transport-toggle",
  "follow-btn",
  "pattern-select",
  "pattern-length-toggle",
  "pattern-scale-toggle",
  "pattern-row",
  "bar-row",
  "copy-pattern-btn",
  "copy-bar-btn",
  "paste-btn",
  "clear-btn",
  "seq-type",
  "midi-out",
  "midi-chan",
  "transpose-dec",
  "transpose-inc",
  "transpose-value",
  "md-track",
  "export-td3",
  "td3-modal",
  "td3-group",
  "td3-pattern",
  "td3-confirm"
]);

let frames = Array.from({ length: 9 }, () => new Array(WIDTH * HEIGHT).fill(0));
let overlays = Array.from({ length: 9 }, () => []);
let transposes = Array.from({ length: 9 }, () => 0);

function applyOctaveOverlaysSnapshot(snapshot) {
  if (!Array.isArray(snapshot)) return;
  overlays = Array.from({ length: 9 }, (_, idx) => {
    const list = Array.isArray(snapshot[idx]) ? snapshot[idx] : [];
    return list
      .filter((o) => Number.isFinite(o?.x) && Number.isFinite(o?.y) && Number.isFinite(o?.octave) && o.octave !== 0)
      .map((o) => ({
        x: o.x,
        y: o.y,
        rawY: o.y,
        octave: o.octave,
        text: o.octave > 0 ? `+${o.octave}` : `${o.octave}`,
        ts: Date.now()
      }));
  });
}
let scale = { root: 0, mode: "major" };
let deviceNames = Array.from({ length: 9 }, (_, i) => (i === 0 ? null : `${i}`));
let deviceNotes = Array.from({ length: 9 }, (_, i) => (i === 0 ? null : ""));
let clockSource = "external"; // default to external clock
let clockInputs = [];
let clockInputId = "IAC Driver Bus 2";
let clockOutEnabled = false;
let clockOutPortId = "";
let deviceColors = Array(9).fill(defaultDeviceColor);
deviceColors[0] = "";
let deviceColorOverrides = Array(9).fill(false);
let deviceOrder = Array.from({ length: 8 }, (_, i) => i + 1);
let setName = "default";
let currentSetFilename = null;
let pendingExportFilename = null;
let currentSetFileHandle = null;
let activePatterns = Array.from({ length: 9 }, () => 1);
let pendingPatterns = Array.from({ length: 9 }, () => null);
let patternLengths = Array.from({ length: 9 }, () => Array(9).fill(16));
let patternTimeScales = Array.from({ length: 9 }, () => Array(9).fill(1));
// pattern lengths not tracked client-side
const DEFAULT_LED_LEVELS = {
  step_on: 8,
  step_micro: 10, // align with step_on; micro timing disabled
  step_accent: 14,
  playhead: 15,
  pattern_active: 12,
  pattern_pending: 6,
  pattern_inactive: 4,
  device_present: 8,
  device_active: 15
};
let ledLevels = { ...DEFAULT_LED_LEVELS };
let midiClockIn = null;
let lastTempoPush = 0;
let lastTempoMs = 0;
let lastTempoVal = 120;
let displayTempoVal = 120;
let lastTempoDisplayMs = 0;
let audioTimeOriginMs = 0;
let scheduler = null;
let internalTickPeriodSec = 0;
let internalClockTimer = null;
let internalNextTick = 0;
let internalStartTimeSec = 0;
let externalTick = 0;
let externalTickTimes = new Map();
let lastExternalTickMs = null;
let lastSentExternalTick = -1;
let externalStartSent = false;
let autoStartPending = false;
let autoStartFirstMs = 0;
let autoStartTicks = 0;
let transportTick = 0;
let externalArmed = false;
const activeNotes = new Map();
let uiScale = 1.5;
// pattern lengths not tracked client-side
let barViews = Array.from({ length: 9 }, () => Array(9).fill(0));
let barPlayheads = Array.from({ length: 9 }, () => Array(9).fill(null));
let followEnabled = false;
let patternClipboard = null;
let barClipboard = null;
let lastCopyType = null; // "pattern" | "bar"
let autoFillBars = true;
let allowMDExternal = false;
let mdSlideSpeed = 0.6;
let mdSlideCurve = 1.0;
let mdBaseSweep = 80;
let monoSlidePad = 0.1; // fraction of a step to trim slide gates
let sequencerTypes = Array.from({ length: 9 }, () => "mono");
let gridConnected = null;
let fullScaleMode = false;
const LOCAL_CONFIG_KEY = "studio_grid_config";
let pendingTd3Import = null; // { data, page }
const DEFAULT_DRUMS = [36, 38, 41, 43, 45, 47, 55]; // C1..G1 bottom->top
let drumNotes = Array.from({ length: 9 }, () => DEFAULT_DRUMS.slice());
const DEFAULT_CC = 1;
let ccNumbers = Array.from({ length: 9 }, (_, i) => (i === 0 ? null : DEFAULT_CC));
let mdTracks = Array.from({ length: 9 }, () => 1);
let ccNumberEditing = false;
let appliedLocalSnapshot = false;
let cachedConfig = null;
let autoLoadSet = false;
let patternControlLatch = false;
let resetNamesOnNextState = false;
const TM1_NAME = "Elektron TM-1";

const SCALE_ROOTS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function normalizeDeviceNames(names) {
  return Array.from({ length: 9 }, (_, i) => {
    if (i === 0) return null;
    const raw = names ? names[i] : null;
    const str = raw == null ? "" : String(raw).trim();
    return str.length ? str : `${i}`;
  });
}

function buildScaleSelectors() {
  const targetRoots = scaleRootSel ? scaleRootSel : settingsScaleRootSel;
  if (targetRoots) {
    targetRoots.innerHTML = "";
    SCALE_ROOTS.forEach((name, idx) => {
      const opt = new Option(name, idx);
      targetRoots.append(opt);
    });
    // clone to the other selector if present
    if (scaleRootSel && settingsScaleRootSel && targetRoots === scaleRootSel) {
      settingsScaleRootSel.innerHTML = scaleRootSel.innerHTML;
    }
    if (settingsScaleRootSel && scaleRootSel && targetRoots === settingsScaleRootSel) {
      scaleRootSel.innerHTML = settingsScaleRootSel.innerHTML;
    }
  }

  const modes = [
    "major", "minor", "dorian", "mixolydian", "lydian",
    "phrygian", "locrian", "harmonic_minor", "melodic_minor",
    "whole_tone", "chromatic"
  ];
  const targetModes = scaleModeSel ? scaleModeSel : settingsScaleModeSel;
  if (targetModes) {
    targetModes.innerHTML = "";
    modes.forEach((m) => {
      const label = m.replace("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
      const opt = new Option(label, m);
      targetModes.append(opt);
    });
    if (scaleModeSel && settingsScaleModeSel && targetModes === scaleModeSel) {
      settingsScaleModeSel.innerHTML = scaleModeSel.innerHTML;
    }
    if (settingsScaleModeSel && scaleModeSel && targetModes === settingsScaleModeSel) {
      scaleModeSel.innerHTML = settingsScaleModeSel.innerHTML;
    }
  }
}

function connectWS() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => {
    if (wsStatus) wsStatus.textContent = "WS: connected";
    log("WS connected");
    ws.send(JSON.stringify({ type: "subscribe_events" }));
    panicAll();
    // push saved config (LED/clock/log/auto-fill) if we have it
    pushSavedConfigToServer();
    // optionally auto-load last set if enabled
    if (!appliedLocalSnapshot && autoLoadSet) {
      try {
        const raw = localStorage.getItem("studio_grid_last_snapshot");
        if (raw) {
          const snap = JSON.parse(raw);
          ws.send(JSON.stringify({ type: "import_state", snapshot: snap }));
          appliedLocalSnapshot = true;
          log("Restoring last saved set");
        }
      } catch (e) {
        console.warn("Failed to load last set", e);
      }
    }
  };
  ws.onerror = (e) => {
    if (wsStatus) wsStatus.textContent = "WS: error";
    log("WS error — is the server running?");
    console.error(e);
  };
  ws.onclose = () => {
    if (wsStatus) wsStatus.textContent = "WS: closed";
    log("WS closed; retrying");
    setTimeout(connectWS, 2000);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "log") {
      log(msg.message);
    } else if (msg.type === "led_frame") {
      const incoming = msg.frame;
      if (Array.isArray(incoming)) {
        const page = currentPage;
        frames[page] = incoming.slice();
      }
      renderFrame(frames[currentPage]);
    } else if (msg.type === "scale") {
      if (msg.scale) scale = msg.scale;
      applyScaleUI();
    } else if (msg.type === "state") {
      tempo = msg.tempo || tempo;
      swing = msg.swing || swing;
      baseDivision = msg.baseDivision || baseDivision;
      midiSettings = msg.midi || midiSettings;
      if (typeof msg.monoSlidePad === "number") {
        monoSlidePad = Math.max(0, Math.min(0.5, Number(msg.monoSlidePad)));
      }
      if (typeof msg.setName === "string") {
        setName = msg.setName;
        updateSetTitle(setName);
      }
      if (msg.transposes) transposes = msg.transposes;
      if (msg.sequencerTypes) sequencerTypes = msg.sequencerTypes;
      if (msg.scale) scale = msg.scale;
      if (resetNamesOnNextState) {
        deviceNames = normalizeDeviceNames(null);
        resetNamesOnNextState = false;
      } else if (msg.names) {
        deviceNames = normalizeDeviceNames(msg.names);
      }
      if (msg.notes) deviceNotes = msg.notes;
      if (Array.isArray(msg.colors)) {
        deviceColors = msg.colors.slice(0, 9);
        deviceColors[0] = "";
        deviceColorOverrides = deviceColors.map((c, idx) => {
          if (idx === 0 || !c) return false;
          return c.toLowerCase() !== defaultDeviceColor.toLowerCase();
        });
      } else if (!deviceColorOverrides.some(Boolean)) {
        deviceColors = Array(9).fill(defaultDeviceColor);
        deviceColors[0] = "";
      }
      if (msg.drumNotes) drumNotes = msg.drumNotes.map((d, idx) => (idx === 0 ? null : (Array.isArray(d) ? d.slice(0, 7) : DEFAULT_DRUMS.slice())));
      if (msg.ccNumbers) ccNumbers = msg.ccNumbers.map((c, idx) => (idx === 0 ? null : (Number.isFinite(c) ? c : DEFAULT_CC)));
      if (msg.activePatterns) activePatterns = msg.activePatterns;
      if (msg.pendingPatterns) pendingPatterns = msg.pendingPatterns;
      if (msg.patternLengths) patternLengths = msg.patternLengths;
      if (msg.patternTimeScales) patternTimeScales = msg.patternTimeScales;
      if (msg.barViews) barViews = msg.barViews;
      if (msg.barPlayheads) barPlayheads = msg.barPlayheads;
      if (Array.isArray(msg.deviceOrder)) {
        deviceOrder = normalizeDeviceOrder(msg.deviceOrder);
      }
      if (typeof msg.follow === "boolean") followEnabled = msg.follow;
      if (typeof msg.autoFill === "boolean") autoFillBars = msg.autoFill;
      if (typeof msg.patternControlLatch === "boolean") patternControlLatch = msg.patternControlLatch;
      if (msg.clockSource) clockSource = msg.clockSource;
      if (typeof msg.clockOut === "boolean") clockOutEnabled = msg.clockOut;
      if (msg.clockOutDevice) clockOutPortId = msg.clockOutDevice;
      if (msg.ledLevels) ledLevels = { ...ledLevels, ...msg.ledLevels };
      if (msg.clockInput) clockInputId = msg.clockInput;
      if (clockSource === "internal" && running) {
        internalTickPeriodSec = 60 / (tempo * PPQN);
        internalStartTimeSec = getNowSec() - transportTick * internalTickPeriodSec;
      }
      if (msg.mdTracks) {
        mdTracks = msg.mdTracks.map((t, idx) => {
          if (idx === 0) return null;
          const val = Number.isFinite(t) ? t : 1;
          return Math.max(1, Math.min(16, Math.round(val)));
        });
      }
      if (Array.isArray(msg.octaveOverlays)) {
        applyOctaveOverlaysSnapshot(msg.octaveOverlays);
      }
      updatePage(msg.currentPage || currentPage, { fromServer: true });
      updateTempo(tempo, { broadcast: false });
      updateSwing(swing, { broadcast: false });
      applyScaleUI();
      applyPageTranspose();
      applyClockSourceUI();
      applyClockOutUI();
      applySeqTypeUI();
      applyDrumNotesUI();
      applyLedSettingsUI();
      applyBaseNoteLenUI();
      applyPatternScaleUI();
      applyMdSlideSpeedUI();
      applyPatternControlLatchUI();
      if (typeof msg.fullScaleMode === "boolean") {
        setFullScaleMode(msg.fullScaleMode);
      }
      if (typeof msg.gridConnected === "boolean") {
        handleGridStatus(msg.gridConnected, msg.fullScaleMode);
      }
    } else if (msg.type === "page_change") {
      updatePage(msg.page || currentPage, { fromServer: true });
    } else if (msg.type === "grid_status") {
      handleGridStatus(!!msg.connected, msg.fullScaleMode);
    } else if (msg.type === "tempo") {
      tempo = msg.bpm || tempo;
      updateTempo(tempo, { broadcast: false });
      applySeqTypeUI();
    } else if (msg.type === "swing") {
      swing = msg.swing || swing;
      updateSwing(swing, { broadcast: false });
    } else if (msg.type === "octave_overlay") {
      handleOctaveOverlayMessage(msg);
    } else if (msg.type === "accent_overlay") {
      handleAccentOverlayMessage(msg);
    } else if (msg.type === "slide_overlay") {
      handleSlideOverlayMessage(msg);
    } else if (msg.type === "step_state") {
      handleStepStateMessage(msg);
    } else if (msg.type === "transpose") {
      if (typeof msg.page === "number") transposes[msg.page] = msg.transpose;
      applyPageTranspose();
    } else if (msg.type === "seq_type") {
      if (typeof msg.page === "number" && msg.seqType) {
        sequencerTypes[msg.page] = msg.seqType;
        applySeqTypeUI();
      }
    } else if (msg.type === "md_track") {
      if (typeof msg.page === "number") {
        const val = Math.max(1, Math.min(16, Math.round(Number(msg.track) || mdTracks[msg.page] || 1)));
        mdTracks[msg.page] = val;
        applyMDTonalUI();
      }
    } else if (msg.type === "mono_slide_pad") {
      monoSlidePad = Math.max(0, Math.min(0.5, Number(msg.value) || monoSlidePad));
      applyMdSlideSpeedUI();
    } else if (msg.type === "device_name") {
      if (typeof msg.page === "number") deviceNames[msg.page] = msg.name || `Device ${msg.page}`;
      renderTabs();
    } else if (msg.type === "device_note") {
      if (typeof msg.page === "number") deviceNotes[msg.page] = msg.note || "";
      applyDeviceBadge();
    } else if (msg.type === "device_color") {
      if (typeof msg.page === "number") {
        const incoming = msg.color || defaultDeviceColor;
        deviceColors[msg.page] = incoming;
        const isDefault = incoming.toLowerCase() === defaultDeviceColor.toLowerCase();
        deviceColorOverrides[msg.page] = !isDefault;
      }
      applyDeviceBadge();
      renderPatternRow();
      renderFrame(frames[currentPage]);
    } else if (msg.type === "device_order") {
      if (Array.isArray(msg.order)) {
        deviceOrder = normalizeDeviceOrder(msg.order);
        renderTabs();
      }
    } else if (msg.type === "set_name") {
      if (typeof msg.name === "string") {
        setName = msg.name;
        updateSetTitle(setName);
      }
    } else if (msg.type === "pattern_poly_status") {
      handlePatternPolyStatus(msg);
    } else if (msg.type === "clock_source") {
      clockSource = msg.source || clockSource;
      applyClockSourceUI();
    } else if (msg.type === "clock_inputs") {
      if (Array.isArray(msg.inputs) && msg.inputs.length) {
        clockInputs = msg.inputs;
        if (msg.selected) clockInputId = msg.selected;
        populateClockInputs();
      }
    } else if (msg.type === "clock_out") {
      clockOutEnabled = !!msg.enabled;
      applyClockOutUI();
    } else if (msg.type === "clock_out_device") {
      clockOutPortId = msg.id || "";
      applyClockOutUI();
    } else if (msg.type === "clock_status") {
      const status = msg.data || {};
      if (typeof status.running === "boolean") setRunningState(status.running);
      if (status.clockSource) clockSource = status.clockSource;
      if (status.clockInput) clockInputId = status.clockInput;
      if (Number.isFinite(status.tick)) transportTick = status.tick;
      applyClockSourceUI();
    } else if (msg.type === "pattern_status") {
      if (typeof msg.page === "number") {
        const prevPattern = currentPattern;
        activePatterns[msg.page] = msg.active ?? activePatterns[msg.page];
        pendingPatterns[msg.page] = msg.pending ?? null;
        if (msg.page === currentPage) {
          if (typeof msg.active === "number") {
            currentPattern = msg.active;
          }
          const patternChanged = typeof msg.active === "number" && msg.active !== prevPattern;
          if (patternChanged) {
            hoveredStep = null;
            lastOctaveTarget = null;
            octaveOverlayLock = false;
            octaveControls.style.display = "none";
          }
          applyPatternSelectUI();
          renderPatternRow();
          applyPatternLengthUI();
          applyPatternScaleUI();
          renderBarRow();
        }
        if (Array.isArray(msg.octaveOverlays)) {
          applyOctaveOverlaysSnapshot(msg.octaveOverlays);
          if (msg.page === currentPage) renderFrame(frames[currentPage]);
        }
      }
    } else if (msg.type === "pattern_length") {
      if (typeof msg.page === "number" && typeof msg.pattern === "number") {
        if (!patternLengths[msg.page]) patternLengths[msg.page] = [];
        patternLengths[msg.page][msg.pattern] = msg.length;
        if (msg.page === currentPage) {
          applyPatternLengthUI();
          renderBarRow();
          if (!msg.silent) showToast(`Length set to ${msg.length}`);
        }
      }
    } else if (msg.type === "pattern_time_scale") {
      if (typeof msg.page === "number" && typeof msg.pattern === "number") {
        if (!patternTimeScales[msg.page]) patternTimeScales[msg.page] = [];
        patternTimeScales[msg.page][msg.pattern] = msg.scale || 1;
        if (msg.page === currentPage) {
          applyPatternScaleUI();
        }
      }
    } else if (msg.type === "bar_view") {
      if (typeof msg.page === "number" && typeof msg.pattern === "number") {
        if (!barViews[msg.page]) barViews[msg.page] = [];
        barViews[msg.page][msg.pattern] = msg.bar;
        if (msg.page === currentPage) renderBarRow();
      }
    } else if (msg.type === "bar_playhead") {
      if (typeof msg.page === "number" && typeof msg.pattern === "number") {
        if (!barPlayheads[msg.page]) barPlayheads[msg.page] = [];
        barPlayheads[msg.page][msg.pattern] = msg.bar;
        if (msg.page === currentPage) renderBarRow();
      }
    } else if (msg.type === "follow") {
      followEnabled = !!msg.enabled;
      applyFollowUI();
    } else if (msg.type === "auto_fill") {
      autoFillBars = !!msg.enabled;
      applyAutoFillUI();
    } else if (msg.type === "copy_pattern") {
      patternClipboard = msg.data;
      lastCopyType = "pattern";
      log("Pattern copied");
      showToast("Pattern copied");
    } else if (msg.type === "copy_bar") {
      barClipboard = msg.data;
      lastCopyType = "bar";
      log("Bar copied");
      showToast("Bar copied");
    } else if (msg.type === "export_state") {
      const payload = msg.data || {};
      const targetName = ensureSetFilename(pendingExportFilename || "Untitled.sgridset");
      downloadJSON(payload, targetName);
      currentSetFilename = targetName;
      setName = displaySetName(targetName || setName);
      updateSetTitle(setName);
      pendingExportFilename = null;
      currentSetFileHandle = null;
    } else if (msg.type === "export_td3") {
      if (msg.data) {
        downloadBase64Binary(msg.data, "td3_pattern.seq");
        log("TD-3 export ready");
      } else {
        log("TD-3 export failed: no data");
      }
    } else if (msg.type === "td3_import_preview") {
      if (!pendingTd3Import) return;
      if (msg.empty) {
        showToast("TD-3 pattern is empty");
        log("TD-3 import skipped: pattern is empty");
        pendingTd3Import = null;
        hideTd3BackdropIfIdle();
        return;
      }
      const detected = msg.detectedScale || { root: 0, mode: "major" };
      const current = msg.currentScale || { root: 0, mode: "major" };
      const differs = !!msg.differs;
      if (differs) {
        const detStr = formatScaleStr(detected);
        const curStr = formatScaleStr(current);
        openTd3ScaleModal(`Detected ${detStr}. Current scale is ${curStr}. Switch or fit?`);
      } else {
        finalizeTd3Import("fit_current");
      }
    } else if (msg.type === "td3_import_applied") {
      showToast("TD-3 pattern imported");
      log("TD-3 pattern applied");
    } else if (msg.type === "led_levels") {
      if (msg.levels) ledLevels = { ...ledLevels, ...msg.levels };
      applyLedSettingsUI();
    } else if (msg.type === "pattern_lengths") {
      // pattern lengths no longer handled client-side
    } else if (msg.type === "events") {
      ensureScheduler();
      scheduler?.enqueue(msg.events || []);
      scheduler?.tick();
    } else if (msg.type === "base_division") {
      baseDivision = msg.division || baseDivision;
      applyBaseNoteLenUI();
    }
  };
}

async function initMIDI() {
  try {
    midiAccess = await navigator.requestMIDIAccess({ sysex: true });
    if (midiStatus) midiStatus.textContent = "MIDI: ok";
    refreshMIDIDevices();
    midiAccess.onstatechange = refreshMIDIDevices;
  } catch (e) {
    if (midiStatus) midiStatus.textContent = "MIDI: unavailable";
    log("WebMIDI blocked or unsupported");
  }
}

function refreshMIDIDevices() {
  if (!midiSel) return;
  const prevSelectedId = midiSel.value || (midiOut && midiOut.id) || "";
  const prevClockOutId = clockOutPortId;
  if (prevSelectedId && midiAccess?.outputs && !midiAccess.outputs.get(prevSelectedId)) {
    panicAll();
  }
  midiSel.innerHTML = "";
  midiSel.append(new Option("None", ""));
  if (clockOutPortSel) {
    clockOutPortSel.innerHTML = "";
    clockOutPortSel.append(new Option("None", ""));
  }
  let firstOut = null;
  let preferredOut = null;
  const preferredOutName = "IAC Driver Bus 1";
  const outs = [];
  const ins = [];
  let tm1Out = null;
  midiAccess?.outputs.forEach((out) => {
    const opt = new Option(out.name, out.id);
    midiSel.append(opt);
    if (clockOutPortSel) {
      clockOutPortSel.append(new Option(out.name, out.id));
    }
    if (!firstOut) firstOut = out;
    if (!preferredOut && out.name.includes(preferredOutName)) preferredOut = out;
    if (!tm1Out && out.name.includes("Elektron TM-1")) tm1Out = out;
    outs.push(out.name);
  });
  midiAccess?.inputs.forEach((input) => {
    ins.push({ id: input.id, name: input.name });
  });
  clockInputs = ins;
  if (!clockInputId && ins.length) clockInputId = ins[0].id;
  populateClockInputs();
  // attach to selected clock input if using external clock
  if (clockSource === "external" && clockInputId) {
    attachClockInput(clockInputId);
  }
  if (clockOutPortSel) {
    const candidateOut = (prevClockOutId && midiAccess?.outputs.get(prevClockOutId)) ? prevClockOutId : "";
    if (candidateOut) {
      clockOutPortId = candidateOut;
      clockOutPortSel.value = candidateOut;
    } else {
      clockOutPortId = "";
      clockOutPortSel.value = "";
    }
  }
  midiSel.onchange = () => {
    panicAll();
    midiOut = midiAccess.outputs.get(midiSel.value) || null;
    log(midiOut ? `MIDI out selected: ${midiOut.name}` : "MIDI out cleared");
    midiSettings[currentPage].outId = midiOut ? midiOut.id : "";
    sendMidiConfig();
    updateTd3ExportVisibility();
  };
  // Restore previous or per-page selection if available
  const cfgId = midiSettings[currentPage]?.outId || "";
  const targetId = midiAccess?.outputs.get(cfgId)
    ? cfgId
    : (midiAccess?.outputs.get(prevSelectedId)
      ? prevSelectedId
      : (preferredOut ? preferredOut.id : ""));
  if (targetId && midiAccess?.outputs.get(targetId)) {
    midiSel.value = targetId;
    midiOut = midiAccess.outputs.get(targetId);
  } else if (firstOut && !midiOut) {
    midiSel.value = "";
    midiOut = null;
  }
  // Force TM-1 when MDTonal and external override is disabled
  enforceMDMidiOut(tm1Out);
  updateTd3ExportVisibility();
  if (midiStatus) midiStatus.textContent = `MIDI: ${midiAccess ? midiAccess.outputs.size : 0} outputs`;
  if (outs.length) log(`Available MIDI outs: ${outs.join(", ")}`);
  // keep user-selected clock source; do not auto-force external here
}

function start() {
  if (clockSource === "external") {
    if (!externalArmed) {
      externalArmed = true;
      ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_external_arm", enabled: true }));
      log("External clock armed");
    } else {
      externalArmed = false;
      ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_external_arm", enabled: false }));
      log("External clock disarmed");
    }
    return;
  }
  startInternalTransport();
}
function stop() {
  if (clockSource === "external") {
    externalArmed = false;
    ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_external_arm", enabled: false }));
    log("External clock disarmed");
    return;
  }
  stopInternalTransport();
}

function startInternalTransport() {
  ensureScheduler();
  internalTickPeriodSec = 60 / (tempo * PPQN);
  internalStartTimeSec = getNowSec();
  internalNextTick = 0;
  transportTick = 0;
  scheduler?.clear();
  setRunningState(true);
  ws?.readyState === WebSocket.OPEN &&
    ws.send(JSON.stringify({ type: "transport", action: "start", tick: 0 }));
  if (clockOutEnabled) sendMidiClockTransport("start");
  startInternalClockLoop();
}

function stopInternalTransport() {
  stopInternalClockLoop();
  setRunningState(false);
  transportTick = 0;
  scheduler?.clear();
  ws?.readyState === WebSocket.OPEN &&
    ws.send(JSON.stringify({ type: "transport", action: "stop" }));
  if (clockOutEnabled) sendMidiClockTransport("stop");
  panicAll();
}

function setRunningState(isRunning) {
  running = !!isRunning;
  const transportBtn = document.getElementById("transport-toggle");
  if (!transportBtn) return;
  const icon = transportBtn.querySelector("i");
  transportBtn.title = running ? "Stop" : "Play";
  transportBtn.setAttribute("aria-pressed", running);
  transportBtn.classList.toggle("active", running);
  if (icon) icon.className = running ? "iconoir-pause-solid" : "iconoir-play-solid";
}

function toggleTransport() {
  if (running) {
    stop();
  } else {
    start();
  }
}

function audioTimeToPerfMs(timeSec) {
  if (!audioTimeOriginMs) audioTimeOriginMs = performance.now();
  return audioTimeOriginMs + timeSec * 1000;
}

function resolveTickTime(tick) {
  if (clockSource === "internal" && internalTickPeriodSec > 0) {
    return internalStartTimeSec + tick * internalTickPeriodSec;
  }
  return externalTickTimes.get(tick);
}

function getNowSec() {
  if (!audioTimeOriginMs) audioTimeOriginMs = performance.now();
  return (performance.now() - audioTimeOriginMs) / 1000;
}

function ensureScheduler() {
  if (scheduler) return;
  scheduler = new AudioEventScheduler(() => getNowSec(), { lookaheadMs: 15, scheduleAheadMs: 150 });
  scheduler.setTickTimeResolver(resolveTickTime);
  scheduler.start(scheduleMidiEvent);
}

function startInternalClockLoop() {
  stopInternalClockLoop();
  internalClockTimer = setInterval(() => {
    if (clockSource !== "internal") return;
    const now = getNowSec();
    if (!Number.isFinite(now)) return;
    while (internalStartTimeSec + internalNextTick * internalTickPeriodSec <= now) {
      const tickTime = internalStartTimeSec + internalNextTick * internalTickPeriodSec;
      handleInternalTick(internalNextTick, tickTime);
      internalNextTick += 1;
    }
  }, 10);
}

function stopInternalClockLoop() {
  if (internalClockTimer) clearInterval(internalClockTimer);
  internalClockTimer = null;
}

function handleInternalTick(tick, tickTimeSec) {
  transportTick = tick;
  if (tick % TICKS_PER_STEP === 0) {
    ws?.readyState === WebSocket.OPEN &&
      ws.send(JSON.stringify({ type: "clockTicks", ticks: [{ tick, intervalMs: internalTickPeriodSec * 1000 }] }));
  }
  if (clockOutEnabled) {
    sendMidiClockPulse(audioTimeToPerfMs(tickTimeSec));
  }
}

function getMidiOutForPage(page) {
  const cfg = midiSettings[page] || midiSettings[currentPage] || {};
  return cfg.outId && midiAccess?.outputs.get(cfg.outId);
}

function getMidiChannelForPage(page, fallbackChan) {
  const cfg = midiSettings[page] || midiSettings[currentPage] || {};
  if (Number.isFinite(fallbackChan)) return fallbackChan;
  return cfg.channel || 1;
}

function noteKey(out, channel) {
  return `${out?.id || "none"}:${channel || 1}`;
}

function trackNoteOn(out, channel, note) {
  if (!out) return;
  const key = noteKey(out, channel);
  if (!activeNotes.has(key)) activeNotes.set(key, new Set());
  activeNotes.get(key).add(note);
}

function trackNoteOff(out, channel, note) {
  if (!out) return;
  const key = noteKey(out, channel);
  const notes = activeNotes.get(key);
  if (!notes) return;
  notes.delete(note);
  if (!notes.size) activeNotes.delete(key);
}

function scheduleMidiEvent(evt, targetTimeSec) {
  const out = getMidiOutForPage(evt.page);
  if (!out) return;
  const channel = getMidiChannelForPage(evt.page, evt.channel);
  const safeTime = Math.max(targetTimeSec, getNowSec() + 0.001);
  const ts = audioTimeToPerfMs(safeTime);
  if (evt.type === "note_on") {
    const status = 0x90 + (channel - 1);
    const vel = Math.max(0, Math.min(127, Math.round(evt.velocity || 0)));
    sendMIDISafe(out, [status, evt.note, vel], ts);
    trackNoteOn(out, channel, evt.note);
  } else if (evt.type === "note_off") {
    const status = 0x80 + (channel - 1);
    sendMIDISafe(out, [status, evt.note, 0], ts);
    const delay = Math.max(0, ts - performance.now());
    setTimeout(() => trackNoteOff(out, channel, evt.note), delay);
  } else if (evt.type === "cc") {
    const status = 0xb0 + (channel - 1);
    const ccNum = Math.max(0, Math.min(127, Math.round(evt.cc || 0)));
    const ccVal = Math.max(0, Math.min(127, Math.round(evt.value || 0)));
    sendMIDISafe(out, [status, ccNum, ccVal], ts);
  }
}

function panicAll() {
  if (!midiAccess) return;
  activeNotes.forEach((notes, key) => {
    const [outId, chanStr] = key.split(":");
    const out = midiAccess.outputs.get(outId);
    const channel = Math.max(1, Math.min(16, Number(chanStr) || 1));
    if (!out) return;
    notes.forEach((note) => {
      const status = 0x80 + (channel - 1);
      sendMIDISafe(out, [status, note, 0], performance.now());
    });
    sendMIDISafe(out, [0xb0 + (channel - 1), 123, 0], performance.now());
    sendMIDISafe(out, [0xb0 + (channel - 1), 120, 0], performance.now());
  });
  activeNotes.clear();
}

function sendMIDISafe(out, bytes, ts) {
  if (!out || !Array.isArray(bytes) || !bytes.length) return;
  const status = bytes[0] & 0xf0;
  if (status === 0xc0) {
    console.warn("Blocked program change message", bytes);
    return;
  }
  out.send(bytes, ts);
}

function sendMIDI(page, pitch, vel, durMs, delayMs, chan) {
  const cfg = midiSettings[page] || midiSettings[currentPage] || {};
  const out = cfg.outId && midiAccess?.outputs.get(cfg.outId);
  const channel = (chan && Number.isFinite(chan)) ? chan : (cfg.channel || 1);
  if (!out) {
    // log suppressed to avoid spam
    return;
  }
  const statusOn = 0x90 + (channel - 1);
  const statusOff = 0x80 + (channel - 1);
  const now = window.performance.now();
  const onTs = now + Math.max(0, delayMs);
  const offTs = now + Math.max(0, delayMs + durMs);
  sendMIDISafe(out, [statusOn, pitch, vel], onTs);
  sendMIDISafe(out, [statusOff, pitch, 0], offTs);
  trackNoteOn(out, channel, pitch);
  const delay = Math.max(0, offTs - performance.now());
  setTimeout(() => trackNoteOff(out, channel, pitch), delay);
}

function sendMIDICC(page, cc, value, delayMs, chan) {
  const cfg = midiSettings[page] || midiSettings[currentPage] || {};
  const out = cfg.outId && midiAccess?.outputs.get(cfg.outId);
  const channel = (chan && Number.isFinite(chan)) ? chan : (cfg.channel || 1);
  if (!out) return;
  const status = 0xb0 + (channel - 1);
  const now = window.performance.now();
  const ts = now + Math.max(0, delayMs || 0);
  const ccNum = Math.max(0, Math.min(127, Math.round(cc || 0)));
  const ccVal = Math.max(0, Math.min(127, Math.round(value || 0)));
  sendMIDISafe(out, [status, ccNum, ccVal], ts);
}

function sendMidiClockPulse(timestampMs) {
  if (!clockOutEnabled) return;
  const out =
    (clockOutPortId && midiAccess?.outputs.get(clockOutPortId)) ||
    ((midiSettings[currentPage] || {}).outId && midiAccess?.outputs.get(midiSettings[currentPage].outId));
  if (!out) return;
  const ts = Number.isFinite(timestampMs) ? timestampMs : window.performance.now();
  sendMIDISafe(out, [0xf8], ts);
}

function sendMidiClockTransport(kind) {
  if (!clockOutEnabled) return;
  const out =
    (clockOutPortId && midiAccess?.outputs.get(clockOutPortId)) ||
    ((midiSettings[currentPage] || {}).outId && midiAccess?.outputs.get(midiSettings[currentPage].outId));
  if (!out) return;
  const status = kind === "start" ? 0xfa : (kind === "stop" ? 0xfc : null);
  if (status == null) return;
  sendMIDISafe(out, [status], window.performance.now());
}

function renderFrame(frame) {
  const deviceColor = getDeviceDisplayColor(currentPage);
  onColor = deviceColor || ON_COLOR_DEFAULT;
  const safeFrame = Array.isArray(frame) ? frame : new Array(WIDTH * HEIGHT).fill(0);
  const displayFrame = safeFrame.slice();
  const patIdx = activePatterns[currentPage] || 1;
  const len = (patternLengths[currentPage] && patternLengths[currentPage][patIdx]) || 16;
  const bars = Math.max(1, Math.ceil(len / 16));
  const bar = (barViews[currentPage] && barViews[currentPage][patIdx]) || 0;
  const rem = len % 16;
  const lastBar = Math.max(0, bars - 1);
  if (rem > 0 && bar === lastBar) {
    const dimLevel = Math.max(1, Math.round((ledLevels.pattern_inactive || 4) * 0.5));
    const rows = getStepRows();
    for (let x = rem; x < 16; x++) {
      for (let y = 0; y < rows; y++) {
        const idx = y * WIDTH + x;
        displayFrame[idx] = Math.max(1, Math.min(displayFrame[idx] || dimLevel, dimLevel));
      }
    }
  }
  if (!Array.isArray(frame)) frames[currentPage] = safeFrame;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  displayFrame.forEach((level, idx) => {
    const x = idx % WIDTH;
    const y = Math.floor(idx / WIDTH);
    const px = x * (CELL_SIZE + CELL_GAP);
    const py = y * (CELL_SIZE + CELL_GAP);
    if (level <= 0) {
      ctx.fillStyle = OFF_COLOR;
    } else {
      const t = Math.min(1, level / 15);
      ctx.fillStyle = lerpColor(OFF_COLOR, onColor || ON_COLOR_DEFAULT, t);
    }
    if (typeof ctx.roundRect === "function") {
      ctx.beginPath();
      ctx.roundRect(px, py, CELL_SIZE, CELL_SIZE, 2);
      ctx.fill();
    } else {
      ctx.fillRect(px, py, CELL_SIZE, CELL_SIZE);
    }
  });

  // overlays
  const now = Date.now();
  const currentOverlays = overlays[currentPage] || [];
  // keep numeric octave overlays persistent; only age out non-numeric markers
  const filtered = currentOverlays.filter((o) => {
    const isNumeric = /^[-+]?\d/.test(o.text);
    const drawY = getOverlayDrawY(o);
    if (drawY < 0 || drawY >= HEIGHT) return false;
    const level = displayFrame[drawY * WIDTH + o.x] || 0;
    if (!isNumeric && level <= 0) return false;
    if (isNumeric) return true;
    return (now - (o.ts || now)) < 1500;
  });
  overlays[currentPage] = filtered;
  overlays[currentPage].forEach((o) => {
    ctx.save();
    const drawY = getOverlayDrawY(o);
    const px = o.x * (CELL_SIZE + CELL_GAP);
    const py = drawY * (CELL_SIZE + CELL_GAP);
    ctx.translate(px, py);
    ctx.fillStyle = LABEL_COLOR;
    ctx.font = LABEL_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(o.text, CELL_SIZE / 2, CELL_SIZE / 2);
    ctx.restore();
  });
}

function setFrame(frame, x, y, level) {
  frame[y * WIDTH + x] = level;
}

function lerpColor(hex1, hex2, t) {
  const c1 = hexToRgb(hex1);
  const c2 = hexToRgb(hex2);
  const r = Math.round(c1.r + (c2.r - c1.r) * t);
  const g = Math.round(c1.g + (c2.g - c1.g) * t);
  const b = Math.round(c1.b + (c2.b - c1.b) * t);
  return `rgb(${r}, ${g}, ${b})`;
}

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  const int = parseInt(h, 16);
  return {
    r: (int >> 16) & 255,
    g: (int >> 8) & 255,
    b: int & 255
  };
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  logEl.textContent = `${line}\n${logEl.textContent}`.slice(0, 4000);
}

// UI wiring
if (tempoInput) {
  const commitTempo = () => updateTempo(tempoInput.value);
  const nudgeTempo = (delta) => {
    const cur = Number(tempoInput.value);
    const safe = Number.isFinite(cur) ? Math.round(cur + delta) : Math.round(tempo);
    tempoInput.value = safe;
    commitTempo();
  };
  tempoInput.step = "1";
  tempoInput.onchange = commitTempo;
  tempoInput.onblur = commitTempo;
  tempoInput.onkeydown = (e) => {
    if (e.key === "Enter") {
      commitTempo();
      tempoInput.blur();
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      nudgeTempo(1);
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      nudgeTempo(-1);
    }
  };
}
if (tempoLabelTop) {
  tempoLabelTop.onclick = () => {
    if (!swingBlock || !tempoBlock) return;
    tempoBlock.classList.add("hidden");
    swingBlock.classList.remove("hidden");
    if (swingInput) swingInput.focus();
  };
}

if (settingsTempoInput) {
  const commitSettingsTempo = () => {
    if (settingsOpen) return;
    updateTempo(settingsTempoInput.value);
  };
  const nudgeSettingsTempo = (delta) => {
    const cur = Number(settingsTempoInput.value);
    const safe = Number.isFinite(cur) ? Math.round(cur + delta) : Math.round(tempo);
    settingsTempoInput.value = safe;
    if (!settingsOpen) commitSettingsTempo();
  };
  settingsTempoInput.step = "1";
  settingsTempoInput.onchange = commitSettingsTempo;
  settingsTempoInput.onblur = commitSettingsTempo;
  settingsTempoInput.onkeydown = (e) => {
    if (e.key === "Enter") {
      commitSettingsTempo();
      settingsTempoInput.blur();
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      nudgeSettingsTempo(1);
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      nudgeSettingsTempo(-1);
    }
  };
}
if (swingLabelTop) {
  swingLabelTop.onclick = () => {
    if (!swingBlock || !tempoBlock) return;
    swingBlock.classList.add("hidden");
    tempoBlock.classList.remove("hidden");
    if (tempoInput) tempoInput.focus();
  };
}
const transportToggle = document.getElementById("transport-toggle");
if (transportToggle) {
  transportToggle.onclick = toggleTransport;
  setRunningState(running);
}

function handleClockSourceChange(prev, next) {
  if (prev === next) return;
  if (prev === "internal") stopInternalClockLoop();
  if (running) {
    ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "transport", action: "stop" }));
    setRunningState(false);
    if (clockOutEnabled) sendMidiClockTransport("stop");
  }
  transportTick = 0;
  externalTick = 0;
  externalTickTimes = new Map();
  lastExternalTickMs = null;
  lastSentExternalTick = -1;
  externalStartSent = false;
  autoStartPending = false;
  autoStartFirstMs = 0;
  autoStartTicks = 0;
  externalArmed = false;
  ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_external_arm", enabled: false }));
  scheduler?.clear();
  panicAll();
}

if (clockToggleBtn) {
  clockToggleBtn.onclick = () => {
    const prev = clockSource;
    const next = prev === "external" ? "internal" : "external";
    clockSource = next;
    handleClockSourceChange(prev, next);
    ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_clock_source", source: next }));
    if (prev === "external" && next === "internal") {
      lockTempoPrecision({ broadcast: true });
    }
    applyClockSourceUI();
    if (clockSource === "external" && clockInputSel && clockInputSel.value) {
      clockInputId = clockInputSel.value;
      ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_clock_input", name: clockInputId }));
      attachClockInput(clockInputId);
    }
    if (clockSource !== "external") {
      externalArmed = false;
      ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_external_arm", enabled: false }));
    }
  };
}
if (clockSourceSel) {
  clockSourceSel.onchange = () => {
    if (settingsOpen) return;
    const prev = clockSource;
    clockSource = clockSourceSel.value;
    handleClockSourceChange(prev, clockSource);
    ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_clock_source", source: clockSource }));
    if (prev === "external" && clockSource === "internal") {
      lockTempoPrecision({ broadcast: true });
    }
    applyClockSourceUI();
    if (clockSource === "external" && clockInputSel && clockInputSel.value) {
      clockInputId = clockInputSel.value;
      ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_clock_input", name: clockInputId }));
      attachClockInput(clockInputId);
    }
    if (clockSource !== "external") {
      externalArmed = false;
      ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_external_arm", enabled: false }));
    }
  };
}

if (clockInputSel) {
  clockInputSel.onchange = () => {
    if (settingsOpen) return;
    const name = clockInputSel.value;
    clockInputId = name;
    ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_clock_input", name }));
    if (clockSource === "external") attachClockInput(clockInputId);
  };
}

function applyClockSourceUI() {
  if (clockSourceSel && !settingsOpen) clockSourceSel.value = clockSource || "internal";
  const wrap = document.getElementById("clock-source-wrap");
  if (wrap) wrap.classList.remove("hidden"); // keep clock input visible for both sources
  if (clockToggleBtn) {
    clockToggleBtn.textContent = clockSource === "external" ? "Ext" : "Int";
    clockToggleBtn.classList.toggle("active", clockSource === "external");
  }
  if (clockSource === "external" && clockInputId) {
    attachClockInput(clockInputId);
  } else {
    detachClockInput();
  }
  tempoDisplayMode = clockSource === "external" ? "display" : "input";
  const tempoWrap = tempoInput?.closest(".tempo-block");
  if (tempoInput && tempoWrap) {
    tempoInput.readOnly = clockSource === "external";
    tempoInput.classList.toggle("readonly", clockSource === "external");
  }
  if (clockSource === "external" && tempoInput) {
    tempoInput.value = formatTempoDisplay(tempo);
  }
  const transportBtn = document.getElementById("transport-toggle");
  if (transportBtn) transportBtn.classList.remove("hidden");
}

function populateClockInputs() {
  if (!clockInputSel) return;
  clockInputSel.innerHTML = "";
  if (!clockInputs.length) {
    const opt = new Option("No MIDI inputs", "");
    opt.disabled = true;
    opt.selected = true;
    clockInputSel.append(opt);
    return;
  }
  clockInputs.forEach((entry, idx) => {
    const name = entry.name || entry;
    const id = entry.id || entry;
    const opt = new Option(name, id);
    clockInputSel.append(opt);
    if (!clockInputId && idx === 0) clockInputId = id;
  });
  if (clockInputId) clockInputSel.value = clockInputId;
  log(`Clock inputs: ${clockInputs.map((i) => i.name || i).join(", ") || "none"}`);
}
function attachClockInput(id) {
  if (!midiAccess) return;
  const byId = midiAccess.inputs.get(id);
  const byName = Array.from(midiAccess.inputs.values()).find((inp) => inp.name === id);
  const target = byId || byName || null;
  if (midiClockIn && midiClockIn !== target) {
    midiClockIn.onmidimessage = null;
  }
  midiClockIn = target;
  if (!midiClockIn) {
    log("No MIDI clock input available");
    return;
  }
  midiClockIn.onmidimessage = handleClockMessage;
  log(`Listening for MIDI clock on ${midiClockIn.name}`);
}

function detachClockInput() {
  if (midiClockIn) midiClockIn.onmidimessage = null;
  midiClockIn = null;
  externalTick = 0;
  externalTickTimes = new Map();
  lastExternalTickMs = null;
  lastSentExternalTick = -1;
  externalStartSent = false;
  autoStartPending = false;
  autoStartFirstMs = 0;
  autoStartTicks = 0;
}

function handleClockMessage(evt) {
  if (clockSource !== "external") return;
  const [status, data1, data2] = evt.data || [];
  if (status === 0xfa) {
    ensureScheduler();
    externalTick = 0;
    externalTickTimes = new Map();
    lastExternalTickMs = null;
    lastSentExternalTick = -1;
    externalStartSent = true;
    autoStartPending = false;
    autoStartFirstMs = 0;
    autoStartTicks = 0;
    autoStartPending = false;
    autoStartFirstMs = 0;
    autoStartTicks = 0;
    transportTick = 0;
    scheduler?.clear();
    setRunningState(true);
    ws?.readyState === WebSocket.OPEN &&
      ws.send(JSON.stringify({ type: "transport", action: "start", tick: 0 }));
    if (clockOutEnabled) sendMidiClockTransport("start");
    log(`MIDI Start from ${midiClockIn?.name || "clock in"}`);
    return;
  }
  if (status === 0xfc || status === 0xfd) {
    setRunningState(false);
    scheduler?.clear();
    externalTickTimes = new Map();
    lastExternalTickMs = null;
    lastSentExternalTick = -1;
    externalStartSent = false;
    autoStartPending = false;
    autoStartFirstMs = 0;
    autoStartTicks = 0;
    autoStartPending = false;
    autoStartFirstMs = 0;
    autoStartTicks = 0;
    ws?.readyState === WebSocket.OPEN &&
      ws.send(JSON.stringify({ type: "transport", action: "stop" }));
    if (clockOutEnabled) sendMidiClockTransport("stop");
    panicAll();
    log(`MIDI Stop from ${midiClockIn?.name || "clock in"}`);
    return;
  }
  if (status === 0xfb) {
    setRunningState(true);
    ws?.readyState === WebSocket.OPEN &&
      ws.send(JSON.stringify({ type: "transport", action: "continue", tick: transportTick }));
    if (clockOutEnabled) sendMidiClockTransport("start");
    log(`MIDI Continue from ${midiClockIn?.name || "clock in"}`);
    return;
  }
  if (status === 0xf2) {
    const spp = ((data2 || 0) << 7) | (data1 || 0);
    const tick = spp * TICKS_PER_STEP;
    transportTick = tick;
    externalTick = tick;
    lastSentExternalTick = tick - 1;
    autoStartPending = false;
    autoStartFirstMs = 0;
    autoStartTicks = 0;
    autoStartPending = false;
    autoStartFirstMs = 0;
    autoStartTicks = 0;
    ws?.readyState === WebSocket.OPEN &&
      ws.send(JSON.stringify({ type: "transport", action: "continue", tick }));
    return;
  }
  if (status !== 0xf8) return; // not a clock tick
  ensureScheduler();
  const nowMs = Number.isFinite(evt.timeStamp) ? evt.timeStamp : performance.now();
  if (!audioTimeOriginMs) audioTimeOriginMs = nowMs;
  const nowSec = (nowMs - audioTimeOriginMs) / 1000;
  const intervalMs = lastExternalTickMs ? (nowMs - lastExternalTickMs) : null;
  lastExternalTickMs = nowMs;

  transportTick = externalTick;
  if (externalTick <= lastSentExternalTick) {
    externalTick += 1;
    return;
  }
  externalTickTimes.set(externalTick, nowSec);
  if (externalTickTimes.size > 1024) {
    const cutoff = externalTick - 512;
    externalTickTimes.forEach((_, key) => {
      if (key < cutoff) externalTickTimes.delete(key);
    });
  }

  if (!running) {
    if (!autoStartPending && !externalStartSent) {
      autoStartPending = true;
      autoStartFirstMs = nowMs;
      autoStartTicks = 0;
    }
    if (autoStartPending && !externalStartSent) {
      autoStartTicks += 1;
      const elapsed = nowMs - autoStartFirstMs;
      const ready = elapsed >= 120 || autoStartTicks >= TICKS_PER_STEP;
      if (ready) {
        autoStartPending = false;
        externalStartSent = true;
        scheduler?.clear();
        setRunningState(true);
        ws?.readyState === WebSocket.OPEN &&
          ws.send(JSON.stringify({ type: "transport", action: "start", tick: externalTick }));
        if (clockOutEnabled) sendMidiClockTransport("start");
      }
    }
  }

  ws?.readyState === WebSocket.OPEN &&
    ws.send(JSON.stringify({
      type: "clockTicks",
      ticks: [{ tick: externalTick, intervalMs }]
    }));

  if (clockOutEnabled) sendMidiClockPulse(nowMs);
  lastSentExternalTick = externalTick;
  externalTick += 1;

  if (Number.isFinite(intervalMs)) {
    const bpmEstimate = 60000 / (intervalMs * PPQN);
    if (Number.isFinite(bpmEstimate)) {
      const smoothed = lastTempoMs ? (0.7 * lastTempoVal + 0.3 * bpmEstimate) : bpmEstimate;
      lastTempoMs = nowMs;
      lastTempoVal = smoothed;
      tempo = Math.max(20, Math.min(300, smoothed));
      const displaySmoothed = lastTempoDisplayMs
        ? (0.85 * displayTempoVal + 0.15 * tempo)
        : tempo;
      const nowUiMs = nowMs;
      const diff = Math.abs(displaySmoothed - displayTempoVal);
      if (diff >= 0.2 || (nowUiMs - lastTempoDisplayMs) > 400) {
        displayTempoVal = displaySmoothed;
        lastTempoDisplayMs = nowUiMs;
        const display = formatTempoDisplay(displayTempoVal);
        if (tempoInput) tempoInput.value = display;
        if (settingsTempoInput) settingsTempoInput.value = display;
      }
      const nowTs = Date.now();
      if (nowTs - lastTempoPush > 300) {
        lastTempoPush = nowTs;
        ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "tempo", bpm: tempo }));
      }
    }
  }
}
document.getElementById("export").onclick = () => {
  if (currentSetFilename) {
    openSaveSetModal();
    return;
  }
  const suggested = setName && setName.toLowerCase() !== "default" ? setName : "Untitled";
  if (window.showSaveFilePicker) {
    requestSaveHandle(suggested)
      .then((handle) => {
        if (handle?.name) {
          currentSetFilename = handle.name;
          setName = displaySetName(handle.name || setName);
          updateSetTitle(setName);
        }
        return saveSnapshotToHandle(handle);
      })
      .catch(() => {
        log("Save canceled");
      });
    return;
  }
  startExport(suggested);
};
const anyTd3ModalOpen = () =>
  [td3Modal, td3ActionModal, td3ScaleModal, td3ReplaceModal].some((modal) => modal && !modal.classList.contains("hidden"));
const showTd3Backdrop = () => td3Backdrop?.classList.remove("hidden");
const hideTd3BackdropIfIdle = () => {
  if (!td3Backdrop) return;
  td3Backdrop.classList.toggle("hidden", !anyTd3ModalOpen());
};

const openTd3Modal = () => {
  if (td3Modal) td3Modal.classList.remove("hidden");
  showTd3Backdrop();
};
const closeTd3Modal = () => {
  if (td3Modal) td3Modal.classList.add("hidden");
  hideTd3BackdropIfIdle();
};

const openTd3ActionModal = () => {
  if (td3ActionModal) td3ActionModal.classList.remove("hidden");
  showTd3Backdrop();
};
const closeTd3ActionModal = () => {
  if (td3ActionModal) td3ActionModal.classList.add("hidden");
  hideTd3BackdropIfIdle();
};
const openTd3ScaleModal = (msg) => {
  if (td3ScaleMessage && msg) td3ScaleMessage.textContent = msg;
  if (td3ScaleModal) td3ScaleModal.classList.remove("hidden");
  showTd3Backdrop();
};
const closeTd3ScaleModal = () => {
  if (td3ScaleModal) td3ScaleModal.classList.add("hidden");
  hideTd3BackdropIfIdle();
};
const openTd3ReplaceModal = () => {
  if (td3ReplaceModal) td3ReplaceModal.classList.remove("hidden");
  showTd3Backdrop();
};
const closeTd3ReplaceModal = () => {
  if (td3ReplaceModal) td3ReplaceModal.classList.add("hidden");
  hideTd3BackdropIfIdle();
};

async function triggerTd3Export(tdGroup, tdPattern) {
  const safeGroup = Math.max(1, Math.min(16, Math.round(tdGroup || 5)));
  const safePattern = Math.max(1, Math.min(16, Math.round(tdPattern || 8)));
  const params = new URLSearchParams({ group: safeGroup, pattern: safePattern });
  try {
    const resp = await fetch(`/api/export-td3?${params.toString()}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    downloadBlob(blob, "td3_pattern.seq");
    log("Exported TD-3 .seq");
  } catch (e) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "export_td3", group: safeGroup, pattern: safePattern }));
      log("TD-3 export requested via WS (HTTP failed)");
    } else {
      log("TD-3 export failed (no connection)");
    }
  }
}

function launchTd3ImportPicker() {
  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = ".seq";
  picker.onchange = () => {
    const file = picker.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const buf = new Uint8Array(ev.target.result);
      const b64 = btoa(String.fromCharCode(...buf));
      pendingTd3Import = { data: b64, page: currentPage };
      const hasData = patternHasData(currentPage);
      if (hasData) {
        openTd3ReplaceModal();
        return;
      }
      ws?.readyState === WebSocket.OPEN &&
        ws.send(JSON.stringify({ type: "td3_import_preview", data: b64, page: currentPage }));
    };
    reader.readAsArrayBuffer(file);
  };
  picker.click();
}

function finalizeTd3Import(mode = "fit_current") {
  if (!pendingTd3Import) return;
  ws?.readyState === WebSocket.OPEN &&
    ws.send(JSON.stringify({ type: "td3_import_apply", data: pendingTd3Import.data, page: pendingTd3Import.page, mode }));
  pendingTd3Import = null;
}

if (exportTd3Btn) exportTd3Btn.onclick = openTd3ActionModal;
if (td3ActionClose) td3ActionClose.onclick = closeTd3ActionModal;
if (td3ExportBtn) td3ExportBtn.onclick = () => {
  closeTd3ActionModal();
  openTd3Modal();
};
if (td3ImportBtn) {
  td3ImportBtn.onclick = () => {
    closeTd3ActionModal();
    launchTd3ImportPicker();
  };
}
if (td3Close) td3Close.onclick = closeTd3Modal;
if (td3Cancel) td3Cancel.onclick = closeTd3Modal;
if (td3Confirm) {
  td3Confirm.onclick = () => {
    const groupVal = Number(td3GroupInput?.value || 5);
    const patVal = Number(td3PatternInput?.value || 8);
    closeTd3Modal();
    triggerTd3Export(groupVal, patVal);
  };
}
if (td3ScaleClose) td3ScaleClose.onclick = () => {
  closeTd3ScaleModal();
  pendingTd3Import = null;
};
if (td3ScaleFit) td3ScaleFit.onclick = () => {
  closeTd3ScaleModal();
  finalizeTd3Import("fit_current");
};
if (td3ScaleSwitch) td3ScaleSwitch.onclick = () => {
  closeTd3ScaleModal();
  finalizeTd3Import("switch_scale");
};
if (td3ReplaceCancel) {
  td3ReplaceCancel.onclick = () => {
    pendingTd3Import = null;
    closeTd3ReplaceModal();
  };
}
if (td3ReplaceConfirm) {
  td3ReplaceConfirm.onclick = () => {
    if (pendingTd3Import && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "td3_import_preview", data: pendingTd3Import.data, page: pendingTd3Import.page }));
    } else if (!ws || ws.readyState !== WebSocket.OPEN) {
      log("WS not connected; cannot import");
      pendingTd3Import = null;
    }
    closeTd3ReplaceModal();
  };
}
document.getElementById("import").onclick = () => {
  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = "application/json,.json,.sgridset";
  picker.onchange = () => {
    const file = picker.files?.[0];
    if (!file) return;
    const fileName = file.name || "Untitled";
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        if (!data.setName) data.setName = deriveSetNameFromFilename(fileName);
        if (ws?.readyState === WebSocket.OPEN) {
          currentSetFilename = ensureSetFilename(fileName);
          currentSetFileHandle = null;
          ws.send(JSON.stringify({ type: "import_state", snapshot: data }));
          log("Import sent to server");
          showToast(`${fileName} loaded`);
        } else {
          log("WS not connected; cannot import");
        }
      } catch (e) {
        log("Import failed: invalid JSON");
      }
    };
    reader.readAsText(file);
  };
  picker.click();
};
function syncSettingsInputs() {
  if (settingsTempoInput) settingsTempoInput.value = formatTempoDisplay(tempo);
  if (uiScaleSel) uiScaleSel.value = String(uiScale || 1.5);
  if (clockSourceSel) clockSourceSel.value = clockSource || "internal";
  if (clockInputSel && clockInputId) clockInputSel.value = clockInputId;
  if (clockOutToggle) clockOutToggle.checked = !!clockOutEnabled;
  if (clockOutPortSel && clockOutPortId) clockOutPortSel.value = clockOutPortId;
  if (autoFillToggle) autoFillToggle.checked = !!autoFillBars;
  if (autoLoadToggle) autoLoadToggle.checked = !!autoLoadSet;
  if (patternControlLatchToggle) patternControlLatchToggle.checked = !!patternControlLatch;
  if (allowMDExternalToggle) allowMDExternalToggle.checked = !!allowMDExternal;
  if (mdBaseSweepInput) mdBaseSweepInput.value = mdBaseSweep;
  if (monoSlidePadInput) monoSlidePadInput.value = Math.round((monoSlidePad || 0) * 100);
  if (baseNoteLenSel) applyBaseNoteLenUI();
  Object.entries(ledInputs).forEach(([k, el]) => {
    if (el) el.value = ledLevels[k] ?? 0;
  });
  if (settingsOpen && pendingDefaultDeviceColor) {
    updateDefaultColorTrigger(pendingDefaultDeviceColor, { preview: true });
  } else {
    updateDefaultColorTrigger();
  }
}

function applySettingsFromInputs() {
  if (settingsTempoInput) updateTempo(settingsTempoInput.value);
  if (uiScaleSel) applyUiScale(uiScaleSel.value);

  if (clockSourceSel) {
    const prev = clockSource;
    const next = clockSourceSel.value === "external" ? "external" : "internal";
    const changed = prev !== next;
    if (changed) {
      clockSource = next;
      handleClockSourceChange(prev, next);
      if (prev === "external" && next === "internal") {
        lockTempoPrecision({ broadcast: true });
      }
    }
    if (changed) {
      ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_clock_source", source: clockSource }));
    }
    applyClockSourceUI();
  }

  if (clockInputSel) {
    const name = clockInputSel.value;
    clockInputId = name;
    ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_clock_input", name }));
    if (clockSource === "external") attachClockInput(clockInputId);
  }

  if (clockOutToggle) {
    clockOutEnabled = !!clockOutToggle.checked;
    ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_clock_out", enabled: clockOutEnabled }));
  }
  if (clockOutPortSel) {
    clockOutPortId = clockOutPortSel.value || "";
    ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_clock_out_device", id: clockOutPortId, name: clockOutPortId }));
  }
  if (autoFillToggle) {
    autoFillBars = !!autoFillToggle.checked;
    ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_auto_fill", enabled: autoFillBars }));
  }
  if (autoLoadToggle) {
    autoLoadSet = !!autoLoadToggle.checked;
  }
  if (showLogToggle) {
    const show = showLogToggle.checked;
    document.getElementById("log").classList.toggle("hidden", !show);
  }
  if (patternControlLatchToggle) {
    patternControlLatch = !!patternControlLatchToggle.checked;
    ws?.readyState === WebSocket.OPEN &&
      ws.send(JSON.stringify({ type: "set_pattern_control_latch", enabled: patternControlLatch }));
  }
  if (allowMDExternalToggle) {
    allowMDExternal = !!allowMDExternalToggle.checked;
    enforceMDMidiOut();
  }
  if (baseNoteLenSel) {
    let val = Math.max(1, Math.min(32, Math.round(Number(baseNoteLenSel.value) || baseDivision || 16)));
    if (val <= 4) val = val * 4;
    if (val === 6) val = 24;
    baseDivision = val;
    baseNoteLenSel.value = String(val);
    ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_base_division", division: val }));
  }

  Object.entries(ledInputs).forEach(([k, el]) => {
    if (!el) return;
    const val = Math.max(0, Math.min(15, Math.round(Number(el.value) || 0)));
    ledLevels[k] = val;
  });
  ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_led_levels", levels: { ...ledLevels } }));

  if (mdBaseSweepInput) {
    const val = Math.max(20, Math.min(200, Math.round(Number(mdBaseSweepInput.value) || mdBaseSweep)));
    mdBaseSweep = val;
    mdBaseSweepInput.value = val;
    ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_md_slide_params", factor: mdSlideSpeed, curve: mdSlideCurve, baseMs: mdBaseSweep }));
  }
  if (monoSlidePadInput) {
    const pct = Math.max(0, Math.min(50, Math.round(Number(monoSlidePadInput.value) || (monoSlidePad * 100))));
    monoSlidePad = pct / 100;
    monoSlidePadInput.value = pct;
    ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_mono_slide_pad", value: monoSlidePad }));
  }

  if (pendingDefaultDeviceColor) {
    defaultDeviceColor = pendingDefaultDeviceColor;
    applyDefaultDeviceColor();
    applyDeviceBadge();
    renderTabs();
    renderFrame(frames[currentPage]);
  }
  updateDefaultColorTrigger();
}

if (settingsBtn && settingsModal && settingsBackdrop) {
  const openSettings = () => {
    settingsOpen = true;
    pendingDefaultDeviceColor = defaultDeviceColor;
    syncSettingsInputs();
    settingsModal.classList.remove("hidden");
    settingsBackdrop.classList.remove("hidden");
  };
  const closeSettings = () => {
    settingsOpen = false;
    pendingDefaultDeviceColor = null;
    updateDefaultColorTrigger();
    settingsModal.classList.add("hidden");
    settingsBackdrop.classList.add("hidden");
  };
  const confirmSettings = () => {
    if (!settingsOpen) return;
    applySettingsFromInputs();
    closeSettings();
  };
  settingsBtn.onclick = openSettings;
  if (settingsClose) settingsClose.onclick = closeSettings;
  settingsBackdrop.onclick = closeSettings;
  if (settingsConfirm) settingsConfirm.onclick = confirmSettings;
  Object.entries(ledInputs).forEach(([k, el]) => {
    if (!el) return;
    el.oninput = () => {
      if (settingsOpen) return;
      const val = Math.max(0, Math.min(15, Math.round(Number(el.value) || 0)));
      ledLevels[k] = val;
      ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_led_levels", levels: { [k]: val } }));
    };
  });
  if (showLogToggle) {
    showLogToggle.onchange = () => {
      if (settingsOpen) return;
      const show = showLogToggle.checked;
      document.getElementById("log").classList.toggle("hidden", !show);
    };
  }
  if (allowMDExternalToggle) {
    allowMDExternalToggle.onchange = () => {
      if (settingsOpen) return;
      allowMDExternal = !!allowMDExternalToggle.checked;
      enforceMDMidiOut();
    };
  }
  if (patternControlLatchToggle) {
    patternControlLatchToggle.onchange = () => {
      if (settingsOpen) return;
      patternControlLatch = !!patternControlLatchToggle.checked;
      ws?.readyState === WebSocket.OPEN &&
        ws.send(JSON.stringify({ type: "set_pattern_control_latch", enabled: patternControlLatch }));
    };
  }
  if (mdBaseSweepInput) {
    const commitBaseSweep = () => {
      if (settingsOpen) return;
      const val = Math.max(20, Math.min(200, Math.round(Number(mdBaseSweepInput.value) || mdBaseSweep)));
      mdBaseSweep = val;
      mdBaseSweepInput.value = val;
      ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_md_slide_params", factor: mdSlideSpeed, curve: mdSlideCurve, baseMs: mdBaseSweep }));
    };
    mdBaseSweepInput.addEventListener("change", commitBaseSweep);
    mdBaseSweepInput.addEventListener("blur", commitBaseSweep);
  }
  if (monoSlidePadInput) {
    const commitMonoSlidePad = () => {
      if (settingsOpen) return;
      const pct = Math.max(0, Math.min(50, Math.round(Number(monoSlidePadInput.value) || (monoSlidePad * 100))));
      monoSlidePad = pct / 100;
      monoSlidePadInput.value = pct;
      ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_mono_slide_pad", value: monoSlidePad }));
    };
    monoSlidePadInput.addEventListener("change", commitMonoSlidePad);
    monoSlidePadInput.addEventListener("blur", commitMonoSlidePad);
  }
  if (baseNoteLenSel) {
    const commitBaseDivision = () => {
      if (settingsOpen) return;
      let val = Math.max(1, Math.min(32, Math.round(Number(baseNoteLenSel.value) || baseDivision || 16)));
      if (val <= 4) val = val * 4; // migrate old per-beat values (2->8, 4->16)
      if (val === 6) val = 24; // migrate old 6-per-beat
      baseDivision = val;
      baseNoteLenSel.value = String(val);
      ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_base_division", division: val }));
    };
    baseNoteLenSel.addEventListener("change", commitBaseDivision);
  }
}

if (settingsSaveCfg) {
  settingsSaveCfg.onclick = () => {
    try {
      const cfg = {
        ledLevels,
        clockSource,
        clockInput: clockInputId,
        clockOut: !!clockOutEnabled,
        clockOutDevice: clockOutPortId,
        showLog: !!(showLogToggle && showLogToggle.checked),
        autoFill: !!autoFillBars,
        autoLoadSet: !!autoLoadSet,
        allowMDExternal: !!allowMDExternal,
        baseDivision,
        midiSettings,
        patternControlLatch,
        defaultDeviceColor
      };
      localStorage.setItem(LOCAL_CONFIG_KEY, JSON.stringify(cfg));
      // keep old key for backward compat
      localStorage.setItem("mgrid_led_config", JSON.stringify(ledLevels));
      cachedConfig = cfg;
      pushSavedConfigToServer();
      log("Saved config");
      showToast("Config saved");
    } catch (e) {
      log("Unable to save config");
    }
  };
}
if (settingsRestoreCfg) {
  settingsRestoreCfg.onclick = () => {
    if (settingsOpen) {
      if (allowMDExternalToggle) allowMDExternalToggle.checked = false;
      if (clockOutToggle) clockOutToggle.checked = false;
      if (clockOutPortSel) clockOutPortSel.value = "";
      if (autoFillToggle) autoFillToggle.checked = true;
      if (autoLoadToggle) autoLoadToggle.checked = false;
      if (patternControlLatchToggle) patternControlLatchToggle.checked = false;
      if (baseNoteLenSel) baseNoteLenSel.value = "16";
      if (mdBaseSweepInput) mdBaseSweepInput.value = 80;
      if (monoSlidePadInput) monoSlidePadInput.value = 10;
      Object.entries(ledInputs).forEach(([k, el]) => {
        if (el) el.value = DEFAULT_LED_LEVELS[k] ?? 0;
      });
      showToast("Defaults staged");
      return;
    }
    allowMDExternal = false;
    enforceMDMidiOut();
    if (allowMDExternalToggle) allowMDExternalToggle.checked = false;
    clockOutEnabled = false;
    applyClockOutUI();
    ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_clock_out", enabled: clockOutEnabled }));
    clockOutPortId = "";
    if (clockOutPortSel) clockOutPortSel.value = "";
    ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_clock_out_device", id: "" }));
    autoFillBars = true;
    applyAutoFillUI();
    ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_auto_fill", enabled: autoFillBars }));
    autoLoadSet = false;
    if (autoLoadToggle) autoLoadToggle.checked = false;
    patternControlLatch = false;
    applyPatternControlLatchUI();
    ws?.readyState === WebSocket.OPEN &&
      ws.send(JSON.stringify({ type: "set_pattern_control_latch", enabled: patternControlLatch }));
    ledLevels = { ...DEFAULT_LED_LEVELS };
    applyLedSettingsUI();
    ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_led_levels", levels: ledLevels }));
    baseDivision = 16;
    applyBaseNoteLenUI();
    ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_base_division", division: baseDivision }));
    monoSlidePad = 0.1;
    applyMdSlideSpeedUI();
    ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_mono_slide_pad", value: monoSlidePad }));
    if (showLogToggle) {
      showLogToggle.checked = false;
      document.getElementById("log").classList.add("hidden");
    }
    try {
      localStorage.removeItem("mgrid_led_config");
      localStorage.removeItem(LOCAL_CONFIG_KEY);
    } catch (e) {}
    cachedConfig = null;
    showToast("Defaults restored");
    log("Restored default config");
  };
}

renderDefaultColorOptions();
updateDefaultColorTrigger();
if (defaultColorTrigger) {
  defaultColorTrigger.onclick = openDefaultColorModal;
}

function normalizeDeviceOrder(order) {
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

function updateSetTitle(name) {
  const preferred = currentSetFilename ? displaySetName(currentSetFilename) : name;
  const safe = String(preferred || "default").trim() || "default";
  const display = safe.toLowerCase() === "default" ? "Untitled" : safe;
  document.title = `studio:grid — ${display}`;
}

function deriveSetNameFromFilename(filename) {
  const raw = String(filename || "").trim();
  if (!raw) return "default";
  const base = raw.replace(/\.[^.]+$/, "");
  return base || "default";
}

function ensureSetFilename(name) {
  const raw = String(name || "").trim();
  if (!raw) return "Untitled.sgridset";
  const cleaned = raw.replace(/[\\/:*?"<>|]+/g, "-");
  if (/\.(sgridset|json)$/i.test(cleaned)) return cleaned;
  return `${cleaned}.sgridset`;
}

function displaySetName(name) {
  const raw = String(name || "").trim();
  if (!raw) return "Untitled";
  return raw.replace(/\.(sgridset|json)$/i, "") || "Untitled";
}

async function saveSnapshotToHandle(handle) {
  if (!handle) return false;
  const resp = await fetch("/api/export");
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  const payload = data.data || data;
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(payload, null, 2));
  await writable.close();
  currentSetFileHandle = handle;
  currentSetFilename = handle.name || currentSetFilename;
  setName = displaySetName(currentSetFilename || setName);
  updateSetTitle(setName);
  showToast("Set saved");
  log("Saved current set");
  return true;
}

async function requestSaveHandle(defaultName) {
  if (!window.showSaveFilePicker) return null;
  const suggested = ensureSetFilename(defaultName || "Untitled.sgridset");
  return window.showSaveFilePicker({
    suggestedName: suggested,
    types: [
      {
        description: "Studio Grid Set",
        accept: {
          "application/json": [".sgridset"]
        }
      }
    ],
    excludeAcceptAllOption: true
  });
}

function startExport(name) {
  const targetName = ensureSetFilename(name || "Untitled.sgridset");
  setName = displaySetName(targetName || setName);
  updateSetTitle(setName);
  pendingExportFilename = targetName;
  currentSetFileHandle = null;
  fetch("/api/export")
    .then((resp) => {
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return resp.json();
    })
    .then((data) => {
      const payload = data.data || data;
      downloadJSON(payload, targetName);
      currentSetFilename = targetName;
      setName = displaySetName(targetName || setName);
      updateSetTitle(setName);
      pendingExportFilename = null;
      log("Exported set");
    })
    .catch(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "export_state" }));
        log("Export requested via WS (HTTP failed)");
      } else {
        pendingExportFilename = null;
        log("Export failed (no connection)");
      }
    });
}

function openConfirmDialog(message, onConfirm) {
  if (!dialogModal) {
    onConfirm?.();
    return;
  }
  if (dialogTitle) dialogTitle.textContent = "Confirm";
  if (dialogMessage) dialogMessage.textContent = message || "Are you sure?";
  dialogOkHandler = typeof onConfirm === "function" ? onConfirm : null;
  dialogModal.classList.remove("hidden");
}

function openSaveSetModal() {
  if (!saveSetModal) {
    startExport(currentSetFilename || "Untitled.sgridset");
    return;
  }
  const display = displaySetName(currentSetFilename || "Untitled.sgridset");
  if (saveSetMessage) {
    saveSetMessage.textContent = `Save current set as "${display}"?`;
  }
  saveSetModal.classList.remove("hidden");
  if (saveSetCurrent) {
    saveSetCurrent.onclick = () => {
      saveSetModal.classList.add("hidden");
      const target = displaySetName(currentSetFilename || "Untitled.sgridset");
      openConfirmDialog(`Are you sure you want to save over "${target}"?`, () => {
        if (currentSetFileHandle) {
          saveSnapshotToHandle(currentSetFileHandle).catch(() => {
            showToast("Save failed");
            log("Save failed");
          });
        } else if (window.showSaveFilePicker) {
          requestSaveHandle(currentSetFilename || `${target}.sgridset`)
            .then((handle) => {
              if (handle?.name) {
                currentSetFilename = handle.name;
                setName = displaySetName(handle.name || setName);
                updateSetTitle(setName);
              }
              return saveSnapshotToHandle(handle);
            })
            .catch(() => {
              log("Save canceled");
            });
        } else {
          startExport(currentSetFilename || "Untitled.sgridset");
        }
      });
    };
  }
  if (saveSetNew) {
    saveSetNew.onclick = () => {
      saveSetModal.classList.add("hidden");
      const suggested = setName && setName.toLowerCase() !== "default" ? setName : "Untitled";
      if (window.showSaveFilePicker) {
        requestSaveHandle(suggested)
          .then((handle) => {
            if (handle?.name) {
              currentSetFilename = handle.name;
              setName = displaySetName(handle.name || setName);
              updateSetTitle(setName);
            }
            return saveSnapshotToHandle(handle);
          })
          .catch(() => {
            log("Save canceled");
          });
      } else {
        startExport(suggested);
      }
    };
  }
  if (saveSetCancel) {
    saveSetCancel.onclick = () => {
      saveSetModal.classList.add("hidden");
    };
  }
}

function clearDragTargets() {
  tabs?.querySelectorAll(".drag-target").forEach((el) => el.classList.remove("drag-target"));
}

function applyDeviceReorder(fromPage, toPage) {
  const order = normalizeDeviceOrder(deviceOrder);
  const fromIdx = order.indexOf(fromPage);
  const toIdx = order.indexOf(toPage);
  if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
  order.splice(fromIdx, 1);
  order.splice(toIdx, 0, fromPage);
  deviceOrder = order;
  renderTabs();
  ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_device_order", order }));
}

function renderTabs() {
  tabs.innerHTML = "";
  const order = normalizeDeviceOrder(deviceOrder);
  order.forEach((page) => {
    const btn = document.createElement("button");
    const label = deviceNames[page] && deviceNames[page].trim().length ? deviceNames[page] : `${page}`;
    btn.textContent = label;
    btn.dataset.page = page;
    const isActive = page === currentPage;
    const activeBg = getDeviceDisplayColor(page);
    const inactiveBg = "var(--panel-strong)";
    if (isActive) btn.classList.add("active");
    btn.style.background = isActive ? activeBg : inactiveBg;
    btn.style.color = isActive ? contrastForColor(activeBg) : "var(--surface)";
    btn.style.boxShadow = "none";
    btn.style.border = "none";
    btn.onclick = () => {
        updatePage(page, { fromServer: false });
        ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_page", page }));
    };
    btn.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      menuTargetPage = page;
      openDeviceMenu(e.clientX, e.clientY);
    };
    btn.draggable = true;
    btn.addEventListener("dragstart", (e) => {
      draggedDevicePage = page;
      btn.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
    });
    btn.addEventListener("dragend", () => {
      draggedDevicePage = null;
      btn.classList.remove("dragging");
      clearDragTargets();
    });
    btn.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (draggedDevicePage == null || draggedDevicePage === page) return;
      btn.classList.add("drag-target");
    });
    btn.addEventListener("dragleave", () => {
      btn.classList.remove("drag-target");
    });
    btn.addEventListener("drop", (e) => {
      e.preventDefault();
      btn.classList.remove("drag-target");
      if (draggedDevicePage == null || draggedDevicePage === page) return;
      applyDeviceReorder(draggedDevicePage, page);
    });
    tabs.append(btn);
  });
  applyDeviceBadge();
}

function renderPatternRow() {
  if (!patternRow) return;
  patternRow.innerHTML = "";
}

function renderBarRow() {
  if (!barRow) return;
  barRow.innerHTML = "";
  const patIdx = activePatterns[currentPage] || 1;
  const len = (patternLengths[currentPage] && patternLengths[currentPage][patIdx]) || 16;
  const bars = Math.max(1, Math.ceil(len / 16));
  const maxButtons = 4;
  const storedBar = (barViews[currentPage] && barViews[currentPage][patIdx]) || 0;
  const playingBar = (barPlayheads[currentPage] && barPlayheads[currentPage][patIdx] != null)
    ? barPlayheads[currentPage][patIdx]
    : null;
  const playingBarClamped = playingBar == null ? null : Math.min(playingBar, maxButtons - 1);
  const currentBar = Math.min(storedBar, bars - 1);
  if (storedBar !== currentBar) {
    if (!barViews[currentPage]) barViews[currentPage] = [];
    barViews[currentPage][patIdx] = currentBar;
  }
  for (let i = 0; i < maxButtons; i++) {
    const btn = document.createElement("button");
    btn.className = "bar-btn";
    const isPlaying = playingBarClamped === i;
    const icon = document.createElement("i");
    icon.className = `iconoir-number-${i + 1}-square${isPlaying ? "-solid" : ""}`;
    icon.setAttribute("aria-hidden", "true");
    btn.append(icon);
    if (isPlaying) btn.classList.add("playing");
    const enabled = i < bars;
    if (i === currentBar) btn.classList.add("active");
    if (!enabled) {
      btn.classList.add("disabled");
      btn.disabled = true;
    } else {
      btn.onclick = () => {
        if (!barViews[currentPage]) barViews[currentPage] = [];
        barViews[currentPage][patIdx] = i;
        if (followEnabled) {
          followEnabled = false;
          applyFollowUI();
          ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_follow", enabled: false }));
        }
        ws?.readyState === WebSocket.OPEN &&
          ws.send(JSON.stringify({ type: "set_bar_view", pattern: patIdx, bar: i }));
        renderBarRow();
      };
    }
    barRow.append(btn);
  }
}

function applyPatternLengthUI() {
  if (!patternLengthBtns || !patternLengthBtns.length) return;
  const patIdx = activePatterns[currentPage] || 1;
  const len = (patternLengths[currentPage] && patternLengths[currentPage][patIdx]) || 16;
  patternLengthBtns.forEach((btn) => {
    btn.textContent = String(len);
    btn.dataset.patternLength = String(len);
    btn.classList.toggle("active", true);
  });
}

function applyPatternSelectUI() {
  if (!patternSelect) return;
  const patIdx = activePatterns[currentPage] || 1;
  patternSelect.value = String(patIdx);
}

function applyPatternScaleUI() {
  if (!patternScaleToggle) return;
  const patIdx = activePatterns[currentPage] || 1;
  const scaleVal = (patternTimeScales[currentPage] && patternTimeScales[currentPage][patIdx]) || 1;
  patternScaleToggle.textContent = `${scaleVal}x`;
  patternScaleToggle.dataset.patternScale = String(scaleVal);
}

function updatePage(page, { fromServer = false } = {}) {
  if (!page || page < 1 || page > 8) return;
  currentPage = page;
  renderTabs();
  applyPageMidi();
  applyPageTranspose();
  applyDeviceBadge();
  renderPatternRow();
  applyPatternSelectUI();
  applyPatternLengthUI();
  applyPatternScaleUI();
  applySeqTypeUI();
  applyDrumNotesUI();
  applyCCUI();
  renderBarRow();
  renderFrame(frames[currentPage]);
  if (!fromServer) {
    ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_page", page }));
  }
}

function applyPageMidi() {
  const cfg = midiSettings[currentPage] || { outId: "", channel: 1 };
  midiChan.value = cfg.channel || 1;
  if (cfg.outId && midiAccess?.outputs.get(cfg.outId)) {
    midiSel.value = cfg.outId;
    midiOut = midiAccess.outputs.get(cfg.outId);
  } else {
    midiSel.value = "";
    midiOut = null;
  }
  enforceMDMidiOut();
  updateTd3ExportVisibility();
}

midiChan.onchange = () => {
  const ch = Math.max(1, Math.min(16, Number(midiChan.value) || 1));
  midiSettings[currentPage].channel = ch;
  sendMidiConfig();
};

const TD3_NAME_REGEX = /td[-\\s]?3/i;
function updateTd3ExportVisibility() {
  if (!exportTd3Btn) return;
  const type = sequencerTypes[currentPage] || "mono";
  const cfg = midiSettings[currentPage] || {};
  const out = cfg.outId && midiAccess?.outputs.get(cfg.outId);
  const isTd3 = !!(out && TD3_NAME_REGEX.test(out.name || ""));
  const show = isTd3 && type === "mono";
  exportTd3Btn.classList.toggle("hidden", !show);
}

function sendMidiConfig() {
  ws?.readyState === WebSocket.OPEN &&
    ws.send(JSON.stringify({ type: "set_midi", page: currentPage, outId: midiSettings[currentPage].outId, channel: midiSettings[currentPage].channel }));
}

function resetMidiSettings() {
  midiSettings = Array.from({ length: 9 }, () => ({ outId: "", channel: 1 }));
  midiOut = null;
  if (midiSel) midiSel.value = "";
  if (midiChan) midiChan.value = 1;
  applyPageMidi();
  for (let i = 1; i <= 8; i++) {
    ws?.readyState === WebSocket.OPEN &&
      ws.send(JSON.stringify({ type: "set_midi", page: i, outId: "", channel: 1 }));
  }
}

function applyPageTranspose() {
  const val = transposes[currentPage] ?? 0;
  const oct = Math.max(-2, Math.min(2, Math.round(val / 12)));
  const type = sequencerTypes[currentPage] || "mono";
  const disableTranspose = type === "drum" || type === "cc";
  if (transposeDisplay) transposeDisplay.textContent = `${oct}`;
  if (transposeDec) transposeDec.disabled = disableTranspose || oct <= -2;
  if (transposeInc) transposeInc.disabled = disableTranspose || oct >= 2;
}

function applySeqTypeUI() {
  if (!seqTypeSel) return;
  const type = sequencerTypes[currentPage] || "mono";
  seqTypeSel.value = type;
  const transposeWrap = document.querySelector(".transpose-switch");
  if (transposeWrap) transposeWrap.classList.toggle("hidden", false);
  if (midiChan) midiChan.disabled = type === "mdtonal";
  applyPageTranspose();
  applyDrumNotesUI();
  applyScaleNotesUI();
  applyCCUI();
  applyMDTonalUI();
  enforceMDMidiOut();
  updateTd3ExportVisibility();
  applyDeviceBadge();
  const hasOverride = deviceColorOverrides[currentPage];
  if (type === "mdtonal" && !hasOverride) {
    // Auto-apply MDTonal color when no user override
    deviceColors[currentPage] = AUTO_MDTONAL_COLOR;
    applyDeviceBadge();
  } else if (!hasOverride) {
    // Return to default when leaving MDTonal without a custom color
    deviceColors[currentPage] = defaultDeviceColor;
  }
  renderTabs();
  renderFrame(frames[currentPage]);
}

function applyDrumNotesUI() {
  const type = sequencerTypes[currentPage] || "mono";
  const drumWrap = document.getElementById("drum-notes");
  if (drumWrap) drumWrap.classList.toggle("hidden", type !== "drum");
  if (!drumInputs.length) return;
  if (!Array.isArray(drumNotes[currentPage])) drumNotes[currentPage] = DEFAULT_DRUMS.slice();
  const map = drumNotes[currentPage] || DEFAULT_DRUMS;
  drumInputs.forEach((input) => {
    const row = Number(input.dataset.row);
    if (Number.isFinite(row)) {
      const val = map[row] ?? DEFAULT_DRUMS[row] ?? 36;
      input.value = val;
      input.disabled = type !== "drum";
    }
  });
}

function applyScaleNotesUI() {
  if (!scaleNotesWrap) return;
  const type = sequencerTypes[currentPage] || "mono";
  const show = type === "mono" || type === "poly" || type === "mdtonal";
  scaleNotesWrap.classList.toggle("hidden", !show);
  if (!show) return;

  const mode = scale?.mode || "major";
  const root = Number(scale?.root) || 0;
  const steps = SCALE_STEPS[mode] || SCALE_STEPS.major;
  const labels = [];
  const rows = getStepRows();
  for (let row = 0; row < rows; row += 1) {
    const degree = (fullScaleMode && row === 0) ? 0 : (rows - 1 - row);
    const note = NOTE_NAMES[((root + steps[degree]) % 12 + 12) % 12];
    labels.push(note);
  }

  scaleNotesWrap.innerHTML = labels
    .map((note) => `<span class="scale-note label">${note}</span>`)
    .join("");
}

function applyCCUI() {
  const type = sequencerTypes[currentPage] || "mono";
  const ccWrap = document.getElementById("cc-config");
  if (ccWrap) ccWrap.classList.toggle("hidden", type !== "cc");
  const raw = ccNumbers[currentPage];
  const safe = Math.max(0, Math.min(127, Number.isFinite(raw) ? raw : DEFAULT_CC));
  if (ccNumberInput) {
    // avoid wiping in-progress edits
    if (!ccNumberEditing) ccNumberInput.value = safe;
    ccNumberInput.disabled = type !== "cc";
  }
}

function applyMDTonalUI() {
  const type = sequencerTypes[currentPage] || "mono";
  const wrap = document.getElementById("md-config");
  if (wrap) wrap.classList.toggle("hidden", type !== "mdtonal");
  if (mdTrackSel) {
    const current = Math.max(1, Math.min(16, Math.round(mdTracks[currentPage] || 1)));
    mdTrackSel.value = `${current}`;
    mdTrackSel.disabled = type !== "mdtonal";
  }
  enforceMDMidiOut();
}

function enforceMDMidiOut(explicitTM1 = null) {
  if (!midiSel || !midiAccess) return;
  const type = sequencerTypes[currentPage] || "mono";
  const tm1 = explicitTM1 || Array.from(midiAccess.outputs.values()).find((o) => o.name.includes(TM1_NAME));
  if (type !== "mdtonal") {
    midiSel.disabled = false;
    return;
  }
  if (!allowMDExternal && tm1) {
    midiSel.value = tm1.id;
    midiOut = tm1;
    midiSettings[currentPage].outId = tm1.id;
    sendMidiConfig();
    midiSel.disabled = true;
    log("MDTonal: locked MIDI out to Elektron TM-1");
  } else if (!allowMDExternal && !tm1) {
    midiSel.disabled = true;
    log("MDTonal: Elektron TM-1 not found; select another output from settings override");
  } else {
    midiSel.disabled = false;
  }
}

function sendGridTapFromClient(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor((clientX - rect.left) / (rect.width / WIDTH));
  const y = Math.floor((clientY - rect.top) / (rect.height / HEIGHT));
  if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
  // send a full press+release tap so mouse input only toggles notes on/off
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "grid_key", x, y, s: 1 }));
    ws.send(JSON.stringify({ type: "grid_key", x, y, s: 0 }));
  }
}

function handleCanvasContextMenu(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor((clientX - rect.left) / (rect.width / WIDTH));
  const y = Math.floor((clientY - rect.top) / (rect.height / HEIGHT));
  if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) {
    closeNoteMenu();
    return;
  }
  if (y >= getStepRows()) {
    closeNoteMenu();
    return;
  }
  closeNoteMenu();
  if (ws?.readyState === WebSocket.OPEN) {
    pendingNoteMenu = { x, y, clientX, clientY };
    ws.send(JSON.stringify({ type: "get_step_state", x, y }));
  }
}

canvas.addEventListener("click", (e) => {
  sendGridTapFromClient(e.clientX, e.clientY);
});
canvas.addEventListener("mousemove", (e) => {
  const rect = canvas.getBoundingClientRect();
  const scaleX = rect.width / CANVAS_WIDTH;
  const scaleY = rect.height / CANVAS_HEIGHT;
  const relX = (e.clientX - rect.left) / scaleX;
  const relY = (e.clientY - rect.top) / scaleY;
  const x = Math.floor(relX / (CELL_SIZE + CELL_GAP));
  const y = Math.floor(relY / (CELL_SIZE + CELL_GAP));
  const anchor = hoveredStep;
  const withinHoverBand = anchor && x === anchor.x && y >= anchor.y - 1 && y <= anchor.y + 1;
  const movedCell = !anchor || anchor.x !== x || anchor.y !== y;

  if (octaveHoverTimer && !withinHoverBand) {
    clearTimeout(octaveHoverTimer);
    octaveHoverTimer = null;
  }
  if (movedCell && pendingOctaveHover) {
    pendingOctaveHover = null;
  }
  if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) {
    hoveredStep = null;
    if (!isOverOctaveControls) octaveControls.style.display = "none";
    return;
  }
  const seqType = sequencerTypes[currentPage] || "mono";
  const inStepRows = y < getStepRows();
  const allowedSeq = seqType !== "drum" && seqType !== "cc";
  if (!inStepRows || !allowedSeq) {
    hoveredStep = null;
    if (!isOverOctaveControls) octaveControls.style.display = "none";
    return;
  }

  const frame = frames[currentPage] || [];
  const val = frame[y * WIDTH + x] || 0;
  const playVal = ledLevels.playhead || 0;
  if (!running && playVal > 0 && val === playVal) {
    hoveredStep = null;
    if (!isOverOctaveControls) octaveControls.style.display = "none";
    return;
  }
  if (val <= 0) {
    hoveredStep = null;
    if (!isOverOctaveControls) octaveControls.style.display = "none";
    return;
  }

  const target = withinHoverBand && anchor ? anchor : { x, y };
  hoveredStep = target;
  if (withinHoverBand && (octaveHoverTimer || pendingOctaveHover || octaveControls.style.display === "flex")) return;

  if (octaveControls.style.display === "flex" && movedCell && !isOverOctaveControls) {
    octaveControls.style.display = "none";
  }

  octaveHoverTimer = setTimeout(() => {
    pendingOctaveHover = {
      x: target.x,
      y: target.y,
      rectLeft: rect.left,
      rectTop: rect.top,
      scaleX,
      scaleY
    };
    ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "get_step_state", x: target.x, y: target.y }));
  }, 500);
});
canvas.addEventListener("mouseleave", () => {
  pendingOctaveHover = null;
  if (octaveHoverTimer) {
    clearTimeout(octaveHoverTimer);
    octaveHoverTimer = null;
  }
  if (octaveHideTimer) clearTimeout(octaveHideTimer);
  octaveHideTimer = setTimeout(() => {
    if (!isOverOctaveControls) {
      octaveControls.style.display = "none";
      hoveredStep = null;
    }
  }, 300);
});
canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  handleCanvasContextMenu(e.clientX, e.clientY);
});

function nudgeStepOctave(delta) {
  const target = hoveredStep || lastOctaveTarget;
  if (!target) return;
  const { x, y } = target;
  const msg = { page: currentPage, x, y, delta };
  handleOctaveOverlayMessage(msg);
  ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_step_octave", x, y, delta }));
}

function showOctaveControls(hover) {
  if (!hover) return;
  const { x, y, rectLeft, rectTop, scaleX, scaleY } = hover;
  hoveredStep = { x, y };
  lastOctaveTarget = { x, y };
  const hasUp = y > 0;
  const hasDown = y < getStepRows() - 1;
  if (!hasUp && !hasDown) {
    if (!isOverOctaveControls) octaveControls.style.display = "none";
    return;
  }
  const btnSize = 24 * scaleX;
  const distY = (CELL_SIZE + CELL_GAP) * scaleY;
  const gapPx = hasUp && hasDown
    ? Math.max(0, 2 * distY - btnSize)
    : Math.max(0, distY - btnSize);
  octaveControls.style.rowGap = `${gapPx}px`;
  [octaveUpBtn, octaveDownBtn].forEach((btn) => {
    if (btn) {
      btn.style.width = `${btnSize}px`;
      btn.style.height = `${btnSize}px`;
    }
  });
  const centerX = rectLeft + (x * (CELL_SIZE + CELL_GAP) + CELL_SIZE / 2) * scaleX;
  const centerUp = rectTop + ((y - 1) * (CELL_SIZE + CELL_GAP) + CELL_SIZE / 2) * scaleY;
  const centerDown = rectTop + ((y + 1) * (CELL_SIZE + CELL_GAP) + CELL_SIZE / 2) * scaleY;
  if (hasUp && octaveUpBtn) {
    octaveUpBtn.style.display = "flex";
  } else if (octaveUpBtn) {
    octaveUpBtn.style.display = "none";
  }
  if (hasDown && octaveDownBtn) {
    octaveDownBtn.style.display = "flex";
  } else if (octaveDownBtn) {
    octaveDownBtn.style.display = "none";
  }
  const top = hasUp ? (centerUp - btnSize / 2) : (centerDown - btnSize / 2);
  octaveControls.style.left = `${centerX - btnSize / 2}px`;
  octaveControls.style.top = `${top}px`;
  octaveControls.style.display = "flex";
}

function showOctaveControlsFromOverlay(msg) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = rect.width / CANVAS_WIDTH;
  const scaleY = rect.height / CANVAS_HEIGHT;
  if (octaveHideTimer) {
    clearTimeout(octaveHideTimer);
    octaveHideTimer = null;
  }
  hoveredStep = { x: msg.x, y: msg.y };
  lastOctaveTarget = { x: msg.x, y: msg.y };
  octaveOverlayLock = !!msg.fromHold;
  const hover = {
    x: msg.x,
    y: msg.y,
    rectLeft: rect.left,
    rectTop: rect.top,
    scaleX,
    scaleY
  };
  showOctaveControls(hover);
  // keep arrows visible until user exits (mouse leave or edit exit); no auto-hide timer
  if (remoteOctaveTimer) {
    clearTimeout(remoteOctaveTimer);
    remoteOctaveTimer = null;
  }
}

if (octaveUpBtn) octaveUpBtn.onclick = () => nudgeStepOctave(1);
if (octaveDownBtn) octaveDownBtn.onclick = () => nudgeStepOctave(-1);
octaveControls.addEventListener("mouseenter", () => {
  isOverOctaveControls = true;
  if (octaveHideTimer) {
    clearTimeout(octaveHideTimer);
    octaveHideTimer = null;
  }
});
octaveControls.addEventListener("mouseleave", () => {
  isOverOctaveControls = false;
  if (octaveHideTimer) clearTimeout(octaveHideTimer);
  octaveHideTimer = setTimeout(() => {
    if (!hoveredStep) octaveControls.style.display = "none";
  }, 150);
});
octaveControls.addEventListener("click", (e) => {
  if (e.target !== octaveControls) return;
  sendGridTapFromClient(e.clientX, e.clientY);
});
octaveControls.addEventListener("contextmenu", (e) => {
  if (e.target !== octaveControls) return;
  e.preventDefault();
  handleCanvasContextMenu(e.clientX, e.clientY);
});

connectWS();
initMIDI();
buildScaleSelectors();
applyScaleUI();
applySeqTypeUI();
renderTabs();
renderPatternRow();
applyPatternSelectUI();
applyPatternLengthUI();
applyPatternScaleUI();
renderBarRow();
applyAutoFillUI();
renderFrame(frames[currentPage]);
applyLedSettingsUI();
loadSavedConfig();
if (uiScaleSel) {
  uiScaleSel.value = "1.5";
  uiScaleSel.onchange = () => {
    if (settingsOpen) return;
    applyUiScale(uiScaleSel.value);
  };
}
applyUiScale(uiScaleSel?.value || uiScale || 1.5);
applyPatternControlLatchUI();
updateSetTitle(setName);

function patternHasData(page) {
  const frame = frames[page] || [];
  // Only consider step rows (exclude bottom device row)
  const playVal = ledLevels.playhead || 0;
  const rows = getStepRows();
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < WIDTH; x++) {
      if (isBarSelectorCell(x, y)) continue;
      const v = frame[y * WIDTH + x] || 0;
      if (v > 0 && v !== playVal) return true; // ignore playhead-only columns
    }
  }
  return false;
}

function isBarSelectorCell(x, y) {
  if (fullScaleMode) return false;
  return y === 7 && x >= 9 && x <= 12;
}

if (seqTypeSel) {
  seqTypeSel.addEventListener("change", () => {
    const val = seqTypeSel.value;
    const type = val === "poly" ? "poly" : val === "drum" ? "drum" : val === "cc" ? "cc" : val === "mdtonal" ? "mdtonal" : "mono";
    // Only prompt if the current pattern has data; otherwise switch immediately
    const hasData = patternHasData(currentPage);
    if (hasData) {
      pendingSeqType = type;
      // revert UI until user confirms
      seqTypeSel.value = sequencerTypes[currentPage] || "mono";
      const supportsPoly = type === "poly" || type === "drum";
      if (supportsPoly) {
        setSeqModalKeepAllowed(true);
        openSeqModal();
      } else if (ws?.readyState === WebSocket.OPEN) {
        pendingSeqRequestId += 1;
        const reqId = pendingSeqRequestId;
        setSeqModalKeepAllowed(false);
        openSeqModal();
        ws.send(JSON.stringify({
          type: "pattern_poly_check",
          page: currentPage,
          pattern: activePatterns[currentPage] || 1,
          requestId: reqId
        }));
      } else {
        setSeqModalKeepAllowed(true);
        openSeqModal();
      }
    } else {
      pendingSeqType = null;
      applySeqChange(type, false);
    }
  });
}

function addOverlay(page, x, y, octave, delta) {
  const pageIdx = Number.isFinite(page) ? page : currentPage;
  if (!overlays[pageIdx]) overlays[pageIdx] = [];
  const val = Number.isFinite(octave) ? octave : (Number.isFinite(delta) ? delta : 0);
  if (!val) {
    // remove any existing numeric overlay when returning to zero
    overlays[pageIdx] = overlays[pageIdx].filter((o) => {
      if (!/^[-+]?\d/.test(o.text)) return true;
      return !(o.x === x && getOverlayRawY(o) === y);
    });
    if (pageIdx === currentPage) renderFrame(frames[currentPage]);
    return;
  }
  const text = val > 0 ? `+${val}` : `${val}`;
  const ts = Date.now();
  overlays[pageIdx] = overlays[pageIdx].filter((o) => {
    if (!/^[-+]?\d/.test(o.text)) return true;
    return !(o.x === x && getOverlayRawY(o) === y);
  });
  overlays[pageIdx].push({ x, y, rawY: y, octave: val, text, ts });
  if (pageIdx === currentPage) renderFrame(frames[currentPage]);
}

function clearOverlayAt(pageIdx, x, y) {
  if (!overlays[pageIdx]) overlays[pageIdx] = [];
  overlays[pageIdx] = overlays[pageIdx].filter((o) => {
    if (!/^[-+]?\d/.test(o.text)) return true;
    return !(o.x === x && getOverlayRawY(o) === y);
  });
}

function handleOctaveOverlayMessage(msg) {
  const pageIdx = Number.isFinite(msg.page) ? msg.page : currentPage;
  if (msg.clearAll) {
    overlays[pageIdx] = [];
    if (pageIdx === currentPage) renderFrame(frames[currentPage]);
    hoveredStep = null;
    lastOctaveTarget = null;
    octaveOverlayLock = false;
    octaveControls.style.display = "none";
    return;
  }
  if (msg.clear) {
    if (Array.isArray(msg.clears) && msg.clears.length) {
      msg.clears.forEach(({ x, y }) => clearOverlayAt(pageIdx, x, y));
    } else {
      clearOverlayAt(pageIdx, msg.x, msg.y);
    }
    if (pageIdx === currentPage) renderFrame(frames[currentPage]);
    hoveredStep = null;
    lastOctaveTarget = null;
    octaveOverlayLock = false;
    octaveControls.style.display = "none";
    return;
  }
  const val = Number.isFinite(msg.octave) ? msg.octave : (Number.isFinite(msg.delta) ? msg.delta : 0);
  const rawY = Number.isFinite(msg.rawY) ? msg.rawY : unmapOverlayY(msg.y, val, fullScaleMode);
  addOverlay(pageIdx, msg.x, rawY, msg.octave, msg.delta);
  if (!msg.silent) {
    const overlayPage = pageIdx;
    recentOctaveOverlay = {
      page: overlayPage,
      x: msg.x,
      y: msg.y,
      ts: Date.now()
    };
    if (!Number.isFinite(overlayPage) || overlayPage === currentPage) {
      showOctaveControlsFromOverlay(msg);
    }
  }
}

function handleAccentOverlayMessage(msg) {
  addAccentOverlay(msg.page, msg.x, msg.y, msg.accent);
}

function handleSlideOverlayMessage(msg) {
  addSlideOverlay(msg.page, msg.x, msg.y, msg.slide);
}

function addAccentOverlay(page, x, y, accent) {
  const pageIdx = Number.isFinite(page) ? page : currentPage;
  if (!overlays[pageIdx]) overlays[pageIdx] = [];
  // remove any existing accent overlay but do not show a popup
  overlays[pageIdx] = overlays[pageIdx].filter((o) => !(o.x === x && o.y === y && o.text === "A"));
  if (accent) overlays[pageIdx].push({ x, y, text: "A", ts: Date.now() });
  if (pageIdx === currentPage) renderFrame(frames[currentPage]);
}

function addSlideOverlay(page, x, y, slide) {
  const pageIdx = Number.isFinite(page) ? page : currentPage;
  if (!overlays[pageIdx]) overlays[pageIdx] = [];
  // remove any existing slide overlay but do not show a popup
  overlays[pageIdx] = overlays[pageIdx].filter((o) => !(o.x === x && o.y === y && o.text === "S"));
  if (slide) overlays[pageIdx].push({ x, y, text: "S", ts: Date.now() });
  if (pageIdx === currentPage) renderFrame(frames[currentPage]);
}

function handleStepStateMessage(msg) {
  if (typeof msg.page === "number" && msg.page !== currentPage) return;
  // Context menu path
  if (pendingNoteMenu && msg.x === pendingNoteMenu.x && msg.y === pendingNoteMenu.y) {
    const { clientX, clientY } = pendingNoteMenu;
    pendingNoteMenu = null;
    if (!msg.on) {
      closeNoteMenu();
    } else {
      noteMenuTarget = {
        x: msg.x,
        y: msg.y,
        accent: !!msg.accent,
        slide: !!msg.slide,
        canSlide: !!msg.canSlide,
        canAccent: !!msg.canAccent
      };
      openNoteMenu(clientX, clientY, msg);
    }
    return;
  }
  // Octave hover path
  if (pendingOctaveHover && msg.x === pendingOctaveHover.x && msg.y === pendingOctaveHover.y) {
    const hover = pendingOctaveHover;
    pendingOctaveHover = null;
    if (!msg.on) {
      hoveredStep = null;
      if (!isOverOctaveControls) octaveControls.style.display = "none";
      return;
    }
    hoveredStep = { x: msg.x, y: msg.y };
    showOctaveControls(hover);
  }
}

if (scaleRootSel) {
  scaleRootSel.onchange = () => {
    scale.root = Number(scaleRootSel.value) || 0;
    if (settingsScaleRootSel) settingsScaleRootSel.value = scale.root;
    sendScale();
  };
}
if (scaleModeSel) {
  scaleModeSel.onchange = () => {
    scale.mode = scaleModeSel.value;
    if (settingsScaleModeSel) settingsScaleModeSel.value = scale.mode;
    sendScale();
  };
}

if (settingsScaleRootSel) {
  settingsScaleRootSel.onchange = () => {
    scale.root = Number(settingsScaleRootSel.value) || 0;
    if (scaleRootSel) scaleRootSel.value = settingsScaleRootSel.value;
    sendScale();
    applyScaleUI();
  };
}
if (settingsScaleModeSel) {
  settingsScaleModeSel.onchange = () => {
    scale.mode = settingsScaleModeSel.value;
    if (scaleModeSel) scaleModeSel.value = settingsScaleModeSel.value;
    sendScale();
    applyScaleUI();
  };
}

function applyScaleUI() {
  if (scaleRootSel) scaleRootSel.value = scale.root ?? 0;
  if (scaleModeSel) scaleModeSel.value = scale.mode || "major";
  if (settingsScaleRootSel) settingsScaleRootSel.value = scale.root ?? 0;
  if (settingsScaleModeSel) settingsScaleModeSel.value = scale.mode || "major";
  applyScaleNotesUI();
}

function applyUiScale(val) {
  const num = Math.max(1, Math.min(1.5, Number(val) || 1));
  uiScale = num;
  document.documentElement.style.setProperty("--ui-scale", uiScale);
  if (uiScaleSel) uiScaleSel.value = String(uiScale);
  // Resize the Electron window to match scale (no-op in browser)
  if (typeof window.resizeTo === "function" && window.innerWidth) {
    const w = Math.round(BASE_WINDOW_WIDTH * uiScale);
    const h = Math.round(BASE_WINDOW_HEIGHT * uiScale);
    try {
      window.resizeTo(w, h);
    } catch (e) {
      // ignore if blocked
    }
  }
}

function sendScale() {
  ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_scale", root: Number(scale.root) || 0, mode: scale.mode || "major" }));
}

const adjustTranspose = (delta) => {
  const type = sequencerTypes[currentPage] || "mono";
  if (type === "drum" || type === "cc") return;
  const current = transposes[currentPage] ?? 0;
  const oct = Math.max(-2, Math.min(2, Math.round(current / 12) + delta));
  const semis = oct * 12;
  transposes[currentPage] = semis;
  applyPageTranspose();
  ws?.readyState === WebSocket.OPEN &&
    ws.send(JSON.stringify({ type: "set_transpose", page: currentPage, transpose: semis }));
};
if (transposeDec) transposeDec.addEventListener("click", () => adjustTranspose(-1));
if (transposeInc) transposeInc.addEventListener("click", () => adjustTranspose(1));

if (swingInput) {
  swingInput.addEventListener("change", () => updateSwing(swingInput.value));
}
if (patternLengthBtns && patternLengthBtns.length) {
  const lenCycle = [16, 32, 48, 64];
  patternLengthBtns.forEach((btn) => {
    btn.onclick = () => {
      const patIdx = activePatterns[currentPage] || 1;
      const current = (patternLengths[currentPage] && patternLengths[currentPage][patIdx]) || 16;
      const nextIdx = (lenCycle.indexOf(current) + 1) % lenCycle.length;
      const nextLen = lenCycle[nextIdx];
      if (!patternLengths[currentPage]) patternLengths[currentPage] = [];
      patternLengths[currentPage][patIdx] = nextLen;
      ws?.readyState === WebSocket.OPEN &&
        ws.send(JSON.stringify({ type: "set_pattern_length", pattern: patIdx, length: nextLen }));
      applyPatternLengthUI();
      renderBarRow();
      showToast(`Length set to ${nextLen}`);
    };
    btn.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openPatternLengthMenu(e.clientX, e.clientY);
    };
  });
}

function setPattern(val) {
  const pat = Math.max(1, Math.min(8, Number(val) || 1));
  activePatterns[currentPage] = pat;
  currentPattern = pat;
  pendingPatterns[currentPage] = null;
  if (patternSelect) patternSelect.value = String(pat);
  ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_pattern", pattern: pat }));
  applyPatternSelectUI();
  applyPatternLengthUI();
  applyPatternScaleUI();
  renderBarRow();
  renderFrame(frames[currentPage]);
}

if (patternSelect) {
  patternSelect.onchange = () => setPattern(patternSelect.value);
}

if (patternScaleToggle) {
  const scaleCycle = [1, 2, 4];
  patternScaleToggle.onclick = () => {
    const patIdx = activePatterns[currentPage] || 1;
    const current = Number(patternScaleToggle.dataset.patternScale) || 1;
    const nextIdx = (scaleCycle.indexOf(current) + 1) % scaleCycle.length;
    const nextVal = scaleCycle[nextIdx];
    if (!patternTimeScales[currentPage]) patternTimeScales[currentPage] = [];
    patternTimeScales[currentPage][patIdx] = nextVal;
    ws?.readyState === WebSocket.OPEN &&
      ws.send(JSON.stringify({ type: "set_pattern_time_scale", pattern: patIdx, scale: nextVal }));
    applyPatternScaleUI();
    showToast(`Scale set to ${nextVal}x`);
  };
}

function applyFollowUI() {
  if (!followBtn) return;
  followBtn.classList.toggle("active", followEnabled);
}

function applyAutoFillUI() {
  if (!autoFillToggle) return;
  autoFillToggle.checked = !!autoFillBars;
}

function applyClockOutUI() {
  if (clockOutToggle) clockOutToggle.checked = !!clockOutEnabled;
  if (clockOutPortSel) {
    const opts = Array.from(clockOutPortSel.options || []);
    const has = opts.some((o) => o.value === clockOutPortId);
    if (clockOutPortId && has) {
      clockOutPortSel.value = clockOutPortId;
    } else if (opts.length) {
      clockOutPortSel.value = opts[0].value;
      clockOutPortId = clockOutPortSel.value;
    }
  }
}

if (followBtn) {
  followBtn.onclick = () => {
    followEnabled = !followEnabled;
    applyFollowUI();
    ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_follow", enabled: followEnabled }));
  };
}

if (autoFillToggle) {
  autoFillToggle.onchange = () => {
    if (settingsOpen) return;
    autoFillBars = !!autoFillToggle.checked;
    ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_auto_fill", enabled: autoFillBars }));
  };
}
if (clockOutToggle) {
  clockOutToggle.onchange = () => {
    if (settingsOpen) return;
    clockOutEnabled = !!clockOutToggle.checked;
    ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_clock_out", enabled: clockOutEnabled }));
  };
}
if (clockOutPortSel) {
  clockOutPortSel.onchange = () => {
    if (settingsOpen) return;
    clockOutPortId = clockOutPortSel.value || "";
    ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_clock_out_device", id: clockOutPortId, name: clockOutPortId }));
  };
}

if (copyPatternBtn) {
  copyPatternBtn.onclick = () => {
    ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "copy_pattern" }));
    showToast("Pattern copied");
  };
}

if (copyBarBtn) {
  copyBarBtn.onclick = () => {
    const patIdx = activePatterns[currentPage] || 1;
    const bar = (barViews[currentPage] && barViews[currentPage][patIdx]) || 0;
    ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "copy_bar", bar }));
    showToast("Bar copied");
  };
}

if (pasteBtn) {
  pasteBtn.onclick = () => {
    const patIdx = activePatterns[currentPage] || 1;
    const bar = (barViews[currentPage] && barViews[currentPage][patIdx]) || 0;
    if (lastCopyType === "pattern" && patternClipboard) {
      ws?.readyState === WebSocket.OPEN &&
        ws.send(JSON.stringify({ type: "paste_pattern", data: patternClipboard }));
      showToast("Pattern pasted");
    } else if (lastCopyType === "bar" && barClipboard) {
      ws?.readyState === WebSocket.OPEN &&
        ws.send(JSON.stringify({ type: "paste_bar", bar, data: barClipboard }));
      showToast("Bar pasted");
    } else {
      log("Nothing to paste");
    }
  };
}

function showConfirmModal(show) {
  if (!confirmModal) return;
  confirmModal.classList.toggle("hidden", !show);
  settingsBackdrop?.classList.toggle("hidden", !show);
}

function isCurrentPatternEmpty() {
  const snap = frames[currentPage] || [];
  const rows = getStepRows();
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < WIDTH; x++) {
      if (isBarSelectorCell(x, y)) continue;
      const v = snap[y * WIDTH + x] || 0;
      if (v > 0) return false;
    }
  }
  return true;
}

function isCurrentBarEmpty() {
  const snap = frames[currentPage] || [];
  const rows = getStepRows();
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < WIDTH; x++) {
      if (isBarSelectorCell(x, y)) continue;
      const v = snap[y * WIDTH + x] || 0;
      if (v > 0) return false;
    }
  }
  return true;
}

if (clearBtn) {
  clearBtn.onclick = () => {
    if (isCurrentPatternEmpty()) {
      ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "clear_pattern" }));
      showToast("Pattern cleared");
      return;
    }
    showConfirmModal(true);
  };
}
if (confirmClose) {
  confirmClose.onclick = () => showConfirmModal(false);
}
if (confirmClearCancel) {
  confirmClearCancel.onclick = () => showConfirmModal(false);
}
if (confirmClearPattern) {
  confirmClearPattern.onclick = () => {
    ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "clear_pattern" }));
    showToast("Pattern cleared");
    showConfirmModal(false);
  };
}
if (confirmClearBar) {
  confirmClearBar.onclick = () => {
    const patIdx = activePatterns[currentPage] || 1;
    const bar = (barViews[currentPage] && barViews[currentPage][patIdx]) || 0;
    if (isCurrentBarEmpty()) {
      ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "clear_bar", bar }));
      showToast(`Bar ${bar + 1} cleared`);
      showConfirmModal(false);
      return;
    }
    ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "clear_bar", bar }));
    showToast(`Bar ${bar + 1} cleared`);
    showConfirmModal(false);
  };
}

function handleGridStatus(connected, nextFullScaleMode = null) {
  const prev = gridConnected;
  gridConnected = !!connected;
  if (typeof nextFullScaleMode === "boolean") {
    setFullScaleMode(nextFullScaleMode);
  }
  if (gridConnected === prev) return;
  showToast(gridConnected ? "Grid connected" : "Grid disconnected");
}

function getStepRows() {
  return fullScaleMode ? 8 : DEFAULT_STEP_ROWS;
}

function mapOverlayY(y, octave, useFullScale) {
  if (!useFullScale) return y;
  if (y === 6 && Number(octave) === 1) return 0;
  return y + 1;
}

function unmapOverlayY(y, octave, useFullScale) {
  if (!useFullScale) return y;
  if (y === 0) return 6;
  return Math.max(0, Math.min(6, y - 1));
}

function getOverlayRawY(overlay) {
  return Number.isFinite(overlay?.rawY) ? overlay.rawY : overlay.y;
}

function getOverlayDrawY(overlay) {
  const rawY = getOverlayRawY(overlay);
  if (!Number.isFinite(rawY)) return overlay?.y ?? 0;
  if (Number.isFinite(overlay?.octave)) {
    return mapOverlayY(rawY, overlay.octave, fullScaleMode);
  }
  return rawY;
}

function setFullScaleMode(next) {
  const enabled = !!next;
  if (fullScaleMode === enabled) return;
  fullScaleMode = enabled;
  document.documentElement.classList.toggle("full-scale", fullScaleMode);
  applyScaleNotesUI();
  renderFrame(frames[currentPage]);
}


function applyDeviceBadge() {
  if (devicePill) devicePill.textContent = deviceNames[currentPage] || `(unnamed ${currentPage})`;
  const color = getDeviceDisplayColor(currentPage);
  onColor = color || ON_COLOR_DEFAULT;
  document.documentElement.style.setProperty("--accent-active", color);
  updateDefaultColorTrigger();
}

function applyLedSettingsUI() {
  Object.entries(ledInputs).forEach(([k, el]) => {
    if (el) el.value = ledLevels[k] ?? 0;
  });
  if (showLogToggle) {
    const show = showLogToggle.checked;
    document.getElementById("log").classList.toggle("hidden", !show);
  }
  if (allowMDExternalToggle) {
    allowMDExternalToggle.checked = !!allowMDExternal;
  }
  applyPatternControlLatchUI();
}

function applyMdSlideSpeedUI() {
  if (mdBaseSweepInput) {
    mdBaseSweepInput.value = mdBaseSweep;
  }
  if (monoSlidePadInput) {
    monoSlidePadInput.value = Math.round((monoSlidePad || 0) * 100);
  }
}

function applyBaseNoteLenUI() {
  if (baseNoteLenSel) {
    const allowed = ["8", "16", "32"];
    const val = String(baseDivision || 16);
    baseNoteLenSel.value = allowed.includes(val) ? val : "16";
  }
}

function applyPatternControlLatchUI() {
  if (patternControlLatchToggle) {
    patternControlLatchToggle.checked = !!patternControlLatch;
  }
}

function contrastForColor(hex) {
  if (!hex || typeof hex !== "string" || !hex.startsWith("#")) return "#f5f6f7";
  const norm = hex.length === 4
    ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
    : hex;
  const int = parseInt(norm.slice(1), 16);
  if (Number.isNaN(int)) return "#f5f6f7";
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  return luma > 180 ? "#1a1e14" : "#f5f6f7";
}

function renderDefaultColorOptions() {
  if (!defaultColorModalOptions) return;
  defaultColorModalOptions.innerHTML = "";
  const activeColor = (settingsOpen && pendingDefaultDeviceColor) ? pendingDefaultDeviceColor : defaultDeviceColor;
  DEVICE_COLOR_PALETTE.forEach((c) => {
    const sw = document.createElement("button");
    sw.className = "color-swatch";
    sw.style.background = c;
    sw.setAttribute("aria-label", `Default color ${c}`);
    sw.onclick = () => {
      if (settingsOpen) {
        pendingDefaultDeviceColor = c;
        defaultColorModalOptions.querySelectorAll(".color-swatch").forEach((btn) => {
          btn.classList.toggle("selected", btn === sw);
        });
        updateDefaultColorTrigger(c, { preview: true });
        closeDefaultColorModal();
        return;
      }
      defaultDeviceColor = c;
      applyDefaultDeviceColor();
      applyDeviceBadge();
      renderTabs();
      renderFrame(frames[currentPage]);
      updateDefaultColorTrigger();
      closeDefaultColorModal();
    };
    if (c.toLowerCase() === (activeColor || BASE_DEFAULT_DEVICE_COLOR).toLowerCase()) {
      sw.classList.add("selected");
    }
    defaultColorModalOptions.append(sw);
  });
}

function applyDefaultDeviceColor() {
  for (let i = 1; i <= 8; i++) {
    if (!deviceColorOverrides[i]) deviceColors[i] = defaultDeviceColor;
  }
}

function updateDefaultColorTrigger(colorOverride, opts = {}) {
  const preview = !!opts.preview;
  const color = colorOverride || (settingsOpen && pendingDefaultDeviceColor) || defaultDeviceColor;
  if (defaultColorTrigger) {
    defaultColorTrigger.style.background = color;
    defaultColorTrigger.style.borderColor = "var(--border)";
  }
  if (!preview && document?.documentElement?.style) {
    document.documentElement.style.setProperty("--cta", color);
  }
}

function openDefaultColorModal() {
  closeDeviceMenu();
  closeNoteMenu();
  closeColorModal();
  renderDefaultColorOptions();
  if (defaultColorModal) defaultColorModal.classList.remove("hidden");
}
function closeDefaultColorModal() {
  if (defaultColorModal) defaultColorModal.classList.add("hidden");
}

function getDeviceDisplayColor(page) {
  const type = sequencerTypes[page] || "mono";
  const override = deviceColorOverrides[page];
  const base = deviceColors[page] || defaultDeviceColor;
  if (override) return base;
  if (type === "mdtonal") return AUTO_MDTONAL_COLOR;
  return defaultDeviceColor;
}

function loadSavedConfig() {
  try {
    const rawFull = localStorage.getItem(LOCAL_CONFIG_KEY);
    const rawLegacy = localStorage.getItem("mgrid_led_config");
    const parsed = rawFull ? JSON.parse(rawFull) : (rawLegacy ? { ledLevels: JSON.parse(rawLegacy) } : null);
    if (!parsed || typeof parsed !== "object") return;
    if (parsed.ledLevels) ledLevels = { ...DEFAULT_LED_LEVELS, ...parsed.ledLevels };
    if (typeof parsed.clockSource === "string") {
      clockSource = parsed.clockSource === "external" ? "external" : "internal";
      if (clockSourceSel) clockSourceSel.value = clockSource;
    }
    if (parsed.clockInput) {
      clockInputId = parsed.clockInput;
      if (clockInputSel) clockInputSel.value = clockInputId;
    }
    if (Array.isArray(parsed.midiSettings)) {
      midiSettings = parsed.midiSettings.slice(0, 9).map((m) => m || { outId: "", channel: 1 });
      applyPageMidi();
    }
    if (Number.isFinite(parsed.baseDivision)) {
      let div = Math.round(parsed.baseDivision);
      if (div <= 4) div = div * 4; // migrate old per-beat values (2->8, 4->16)
      if (div === 6) div = 24;
      baseDivision = Math.max(1, Math.min(32, div));
      applyBaseNoteLenUI();
    }
  if (typeof parsed.autoFill === "boolean") {
    autoFillBars = parsed.autoFill;
    if (autoFillToggle) autoFillToggle.checked = autoFillBars;
  }
  if (parsed.defaultDeviceColor && /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.test(parsed.defaultDeviceColor)) {
    defaultDeviceColor = parsed.defaultDeviceColor;
      applyDefaultDeviceColor();
    }
    if (typeof parsed.allowMDExternal === "boolean" && allowMDExternalToggle) {
      allowMDExternal = parsed.allowMDExternal;
      allowMDExternalToggle.checked = allowMDExternal;
    }
    if (typeof parsed.patternControlLatch === "boolean" && patternControlLatchToggle) {
      patternControlLatch = parsed.patternControlLatch;
      applyPatternControlLatchUI();
    }
  if (typeof parsed.patternControlLatch === "boolean") {
    patternControlLatch = parsed.patternControlLatch;
    applyPatternControlLatchUI();
  }
  if (typeof parsed.autoLoadSet === "boolean" && autoLoadToggle) {
    autoLoadToggle.checked = parsed.autoLoadSet;
    autoLoadSet = parsed.autoLoadSet;
  }
    if (typeof parsed.patternControlLatch === "boolean") {
      patternControlLatch = parsed.patternControlLatch;
      applyPatternControlLatchUI();
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "set_pattern_control_latch", enabled: patternControlLatch }));
      }
    }
  if (typeof parsed.showLog === "boolean" && showLogToggle) {
    showLogToggle.checked = parsed.showLog;
    document.getElementById("log").classList.toggle("hidden", !parsed.showLog);
  }
  if (typeof parsed.clockOut === "boolean") {
    clockOutEnabled = !!parsed.clockOut;
    applyClockOutUI();
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "set_clock_out", enabled: clockOutEnabled }));
    }
  }
  if (parsed.clockOutDevice) {
    clockOutPortId = parsed.clockOutDevice;
    applyClockOutUI();
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "set_clock_out_device", id: clockOutPortId, name: clockOutPortId }));
    }
  }
  if (parsed.defaultDeviceColor && /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.test(parsed.defaultDeviceColor)) {
    defaultDeviceColor = parsed.defaultDeviceColor;
    applyDefaultDeviceColor();
    updateDefaultColorTrigger();
  } else {
      updateDefaultColorTrigger();
    }
    cachedConfig = parsed;
  applyLedSettingsUI();
  applyBaseNoteLenUI();
  applyMdSlideSpeedUI();
  applyPatternControlLatchUI();
  log("Loaded saved config");
  } catch (e) {
    log("Failed to load saved config");
  }
}

function pushSavedConfigToServer() {
  if (!cachedConfig || !ws || ws.readyState !== WebSocket.OPEN) return;
  if (cachedConfig.ledLevels) ws.send(JSON.stringify({ type: "set_led_levels", levels: cachedConfig.ledLevels }));
  if (cachedConfig.clockSource) ws.send(JSON.stringify({ type: "set_clock_source", source: cachedConfig.clockSource }));
  if (cachedConfig.clockInput) ws.send(JSON.stringify({ type: "set_clock_input", id: cachedConfig.clockInput, name: cachedConfig.clockInput }));
  if (typeof cachedConfig.clockOut === "boolean") {
    clockOutEnabled = !!cachedConfig.clockOut;
    applyClockOutUI();
    ws.send(JSON.stringify({ type: "set_clock_out", enabled: clockOutEnabled }));
  }
  if (cachedConfig.clockOutDevice) {
    clockOutPortId = cachedConfig.clockOutDevice;
    applyClockOutUI();
    ws.send(JSON.stringify({ type: "set_clock_out_device", id: clockOutPortId, name: clockOutPortId }));
  }
  if (typeof cachedConfig.autoFill === "boolean") ws.send(JSON.stringify({ type: "set_auto_fill", enabled: cachedConfig.autoFill }));
  if (typeof cachedConfig.allowMDExternal === "boolean") {
    allowMDExternal = !!cachedConfig.allowMDExternal;
    enforceMDMidiOut();
  }
  if (cachedConfig.defaultDeviceColor && /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.test(cachedConfig.defaultDeviceColor)) {
    defaultDeviceColor = cachedConfig.defaultDeviceColor;
    applyDefaultDeviceColor();
  }
  if (typeof cachedConfig.baseDivision === "number") {
    let div = Math.round(cachedConfig.baseDivision);
    if (div <= 4) div = div * 4; // migrate old per-beat values
    if (div === 6) div = 24;
    baseDivision = Math.max(1, Math.min(32, div));
    ws.send(JSON.stringify({ type: "set_base_division", division: baseDivision }));
  }
  if (typeof cachedConfig.patternControlLatch === "boolean") {
    patternControlLatch = !!cachedConfig.patternControlLatch;
    applyPatternControlLatchUI();
    ws.send(JSON.stringify({ type: "set_pattern_control_latch", enabled: patternControlLatch }));
  }
  if (Array.isArray(cachedConfig.midiSettings)) {
    cachedConfig.midiSettings.forEach((m, idx) => {
      const page = idx;
      if (!m || page === 0) return;
      const outId = m.outId || "";
      const channel = m.channel || 1;
      ws.send(JSON.stringify({ type: "set_midi", page, outId, channel }));
    });
  }
}

function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function downloadBase64Binary(data, filename, mime = "application/octet-stream") {
  try {
    const byteStr = atob(data);
    const len = byteStr.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = byteStr.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: mime });
    downloadBlob(blob, filename);
  } catch (e) {
    log("TD-3 export failed to download");
  }
}

// inputs removed from panel; keep guards in case they return
const tabDeviceNameInput = null;
const deviceNotesInput = null;
const tabDeviceColorInput = null;


if (drumInputs.length) {
  drumInputs.forEach((input) => {
    input.addEventListener("change", () => {
      const row = Number(input.dataset.row);
      if (!Number.isFinite(row)) return;
      const val = Math.max(0, Math.min(127, Math.round(Number(input.value) || 0)));
      if (!Array.isArray(drumNotes[currentPage])) drumNotes[currentPage] = DEFAULT_DRUMS.slice();
      drumNotes[currentPage][row] = val;
      input.value = val;
      ws?.readyState === WebSocket.OPEN &&
        ws.send(JSON.stringify({ type: "set_drum_note", page: currentPage, row, note: val }));
    });
  });
}

if (ccNumberInput) {
  const commitCcNumber = () => {
    const val = Math.max(0, Math.min(127, Math.round(Number(ccNumberInput.value) || DEFAULT_CC)));
    ccNumbers[currentPage] = val;
    ccNumberInput.value = val;
    ws?.readyState === WebSocket.OPEN &&
      ws.send(JSON.stringify({ type: "set_cc_number", page: currentPage, cc: val }));
  };
  ccNumberInput.addEventListener("focus", () => {
    ccNumberEditing = true;
  });
  ccNumberInput.addEventListener("blur", () => {
    ccNumberEditing = false;
    commitCcNumber();
  });
  ccNumberInput.addEventListener("change", commitCcNumber);
  ccNumberInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      ccNumberInput.blur();
    }
  });
}

if (mdTrackSel) {
  mdTrackSel.addEventListener("change", () => {
    const val = Math.max(1, Math.min(16, Math.round(Number(mdTrackSel.value) || 1)));
    mdTracks[currentPage] = val;
    mdTrackSel.value = `${val}`;
    ws?.readyState === WebSocket.OPEN &&
      ws.send(JSON.stringify({ type: "set_md_track", page: currentPage, track: val }));
  });
}

function openSeqModal() {
  if (seqModal && seqModal.classList.contains("hidden")) seqModal.classList.remove("hidden");
}
function closeSeqModal() {
  if (seqModal && !seqModal.classList.contains("hidden")) seqModal.classList.add("hidden");
}

function setSeqModalKeepAllowed(allowed) {
  pendingSeqKeepAllowed = !!allowed;
  if (seqKeep) seqKeep.classList.toggle("hidden", !pendingSeqKeepAllowed);
}

function handlePatternPolyStatus(msg) {
  if (!msg || msg.requestId !== pendingSeqRequestId || !pendingSeqType) return;
  const allowKeep = !msg.multi;
  setSeqModalKeepAllowed(allowKeep);
  openSeqModal();
}

function applySeqChange(type, clearPattern = true) {
  const safeType = type === "poly" || type === "drum" || type === "cc" || type === "mdtonal" ? type : "mono";
  sequencerTypes[currentPage] = safeType;
  ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_seq_type", page: currentPage, seqType: safeType }));
  if (clearPattern) {
    const patIdx = activePatterns[currentPage] || 1;
    patternLengths[currentPage] = patternLengths[currentPage] || [];
    patternLengths[currentPage][patIdx] = 16;
    patternTimeScales[currentPage] = patternTimeScales[currentPage] || [];
    patternTimeScales[currentPage][patIdx] = 1;
    if (!barViews[currentPage]) barViews[currentPage] = [];
    barViews[currentPage][patIdx] = 0;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "set_pattern_length", pattern: patIdx, length: 16, silent: true }));
      ws.send(JSON.stringify({ type: "set_pattern_time_scale", pattern: patIdx, scale: 1 }));
      ws.send(JSON.stringify({ type: "set_bar_view", pattern: patIdx, bar: 0 }));
      ws.send(JSON.stringify({ type: "clear_pattern", pattern: patIdx }));
    }
  }
  applyDrumNotesUI();
  applyPatternLengthUI();
  applyPatternScaleUI();
  applySeqTypeUI();
  renderBarRow();
  closeSeqModal();
}

if (seqOk) {
  seqOk.onclick = () => {
    if (pendingSeqType) applySeqChange(pendingSeqType, true);
    pendingSeqType = null;
  };
}
if (seqKeep) {
  seqKeep.onclick = () => {
    if (!pendingSeqKeepAllowed) return;
    if (pendingSeqType) applySeqChange(pendingSeqType, false);
    pendingSeqType = null;
  };
}
if (seqCancel) {
  seqCancel.onclick = () => {
    pendingSeqType = null;
    // reset select to current type
    seqTypeSel.value = sequencerTypes[currentPage] || "mono";
    setSeqModalKeepAllowed(true);
    closeSeqModal();
  };
}
if (seqClose) {
  seqClose.onclick = () => {
    pendingSeqType = null;
    seqTypeSel.value = sequencerTypes[currentPage] || "mono";
    setSeqModalKeepAllowed(true);
    closeSeqModal();
  };
}

// Toast helper
let toastTimer = null;
function showToast(text) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = text || "";
  el.classList.remove("hidden");
  el.classList.remove("fade-out");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.add("fade-out");
    setTimeout(() => el.classList.add("hidden"), 200);
  }, 2000);
}

// New set modal controls
if (newSetBtn && newSetModal) {
  const openNewSetModal = () => newSetModal.classList.remove("hidden");
  const closeNewSetModal = () => newSetModal.classList.add("hidden");
  newSetBtn.onclick = openNewSetModal;
  if (newSetClose) newSetClose.onclick = closeNewSetModal;
  if (newSetCancel) newSetCancel.onclick = closeNewSetModal;
  if (newSetConfirm) {
    newSetConfirm.onclick = () => {
      // reset server state (patterns) but keep current config
      const keepNames = !!(keepDeviceNamesToggle && keepDeviceNamesToggle.checked);
      const keepMidi = !!(keepMidiSettingsToggle && keepMidiSettingsToggle.checked);
      ws?.readyState === WebSocket.OPEN &&
        ws.send(JSON.stringify({ type: "new_set", keepDeviceNames: keepNames, keepMidi, defaultColor: defaultDeviceColor }));
      currentSetFilename = null;
      currentSetFileHandle = null;
      if (!keepNames) {
        deviceNames = normalizeDeviceNames(null);
        resetNamesOnNextState = true;
        applyDeviceBadge();
        renderTabs();
      }
      if (!keepMidi) {
        resetMidiSettings();
      }
      closeNewSetModal();
      showToast("Started new set");
    };
  }
}

function openColorModal(page) {
  closeDeviceMenu();
  closeNoteMenu();
  closeDefaultColorModal();
  colorModalPage = page;
  if (colorOptions) {
    colorOptions.innerHTML = "";
    DEVICE_COLOR_PALETTE.forEach((c) => {
      const sw = document.createElement("button");
      sw.className = "color-swatch";
      sw.style.background = c;
      sw.setAttribute("aria-label", `Color ${c}`);
      sw.onclick = () => {
        deviceColors[page] = c;
        const isDefault = c.toLowerCase() === defaultDeviceColor.toLowerCase();
        deviceColorOverrides[page] = !isDefault;
        applyDeviceBadge();
        renderTabs();
        renderFrame(frames[currentPage]);
        ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_device_color", page, color: c }));
        closeColorModal();
      };
      colorOptions.append(sw);
    });
  }
  if (colorModal) colorModal.classList.remove("hidden");
}
function closeColorModal() {
  if (colorModal) colorModal.classList.add("hidden");
  colorModalPage = null;
}
if (colorClose) colorClose.onclick = closeColorModal;
if (defaultColorClose) defaultColorClose.onclick = closeDefaultColorModal;
function isTypingTarget(el) {
  if (!el) return false;
  const tag = (el.tagName || "").toLowerCase();
  if (["input", "textarea", "select", "option", "button"].includes(tag)) return true;
  return !!el.isContentEditable || !!el.closest?.("[contenteditable='true']");
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeColorModal();
    closeDefaultColorModal();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    if (isTypingTarget(e.target)) return;
    e.preventDefault();
    adjustTranspose(e.key === "ArrowUp" ? 1 : -1);
    return;
  }
  if ((e.code === "Space" || e.key === " ") && clockSource === "internal") {
    if (isTypingTarget(e.target)) return;
    e.preventDefault();
    toggleTransport();
    return;
  }
  if (e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown")) {
    if (isTypingTarget(e.target)) return;
    const patIdx = activePatterns[currentPage] || 1;
    const bar = (barViews[currentPage] && barViews[currentPage][patIdx]) || 0;
    const payload = { type: "shift_pattern", page: currentPage, pattern: patIdx, bar, dx: 0, dy: 0 };
    if (e.key === "ArrowLeft") payload.dx = -1;
    if (e.key === "ArrowRight") payload.dx = 1;
    if (e.key === "ArrowUp") payload.dy = -1;
    if (e.key === "ArrowDown") payload.dy = 1;
    e.preventDefault();
    ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(payload));
  }
});

function configureRenameModal({ title, label, maxLength, inputMode, value }) {
  if (renameTitle) renameTitle.textContent = title || renameDefaults.title;
  if (renameLabel) {
    const textNode = Array.from(renameLabel.childNodes).find((n) => n.nodeType === 3);
    if (textNode) textNode.textContent = label || renameDefaults.label;
  }
  if (renameInput) {
    renameInput.type = renameDefaults.type;
    renameInput.maxLength = maxLength || renameDefaults.maxLength;
    renameInput.inputMode = inputMode || renameDefaults.inputMode || "";
    renameInput.value = value || "";
  }
}

function openRenameModalForDevice(page) {
  if (!renameModal || !renameInput) return;
  renameMode = "device";
  renameTargetPattern = null;
  renameTargetPage = page ?? currentPage;
  const currentName = deviceNames[renameTargetPage] || `${renameTargetPage}`;
  configureRenameModal({
    title: "Rename Device",
    label: "Name",
    maxLength: 10,
    inputMode: "",
    value: currentName.slice(0, 10)
  });
  renameModal.classList.remove("hidden");
  setTimeout(() => renameInput?.focus(), 0);
}

function openRenameModalForPatternLength() {
  if (!renameModal || !renameInput) return;
  renameMode = "pattern_length";
  renameTargetPage = null;
  renameTargetPattern = activePatterns[currentPage] || 1;
  const current = (patternLengths[currentPage] && patternLengths[currentPage][renameTargetPattern]) || 16;
  configureRenameModal({
    title: "Custom Pattern Length",
    label: "Length (1-64)",
    maxLength: 2,
    inputMode: "numeric",
    value: String(current)
  });
  renameModal.classList.remove("hidden");
  setTimeout(() => renameInput?.focus(), 0);
}
function closeRenameModal() {
  if (renameModal) renameModal.classList.add("hidden");
  renameTargetPage = null;
  renameTargetPattern = null;
  renameMode = "device";
  configureRenameModal({
    title: renameDefaults.title,
    label: renameDefaults.label,
    maxLength: renameDefaults.maxLength,
    inputMode: renameDefaults.inputMode,
    value: ""
  });
}
if (renameCancel) renameCancel.onclick = closeRenameModal;
if (renameInput) {
  renameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      renameSave?.click();
    } else if (e.key === "Escape") {
      closeRenameModal();
    }
  });
}
if (renameSave) {
  renameSave.onclick = () => {
    const raw = (renameInput?.value || "").trim();
    if (!raw.length) return closeRenameModal();
    if (renameMode === "pattern_length") {
      const parsed = Math.max(1, Math.min(64, Math.round(Number(raw) || 0)));
      if (!parsed) return closeRenameModal();
      const patIdx = renameTargetPattern || (activePatterns[currentPage] || 1);
      if (!patternLengths[currentPage]) patternLengths[currentPage] = [];
      patternLengths[currentPage][patIdx] = parsed;
      ws?.readyState === WebSocket.OPEN &&
        ws.send(JSON.stringify({ type: "set_pattern_length", pattern: patIdx, length: parsed }));
      applyPatternLengthUI();
      renderBarRow();
      showToast(`Length set to ${parsed}`);
      closeRenameModal();
      return;
    }
    if (!renameTargetPage && renameTargetPage !== 0) return closeRenameModal();
    const trimmed = raw.slice(0, 10);
    deviceNames[renameTargetPage] = trimmed;
    applyDeviceBadge();
    renderTabs();
    ws?.readyState === WebSocket.OPEN &&
      ws.send(JSON.stringify({ type: "set_device_name", page: renameTargetPage, name: trimmed }));
    closeRenameModal();
  };
}

if (dialogCancel) {
  dialogCancel.onclick = () => {
    dialogModal?.classList.add("hidden");
    dialogOkHandler = null;
  };
}
if (dialogOk) {
  dialogOk.onclick = () => {
    const handler = dialogOkHandler;
    dialogModal?.classList.add("hidden");
    dialogOkHandler = null;
    handler?.();
  };
}

function openDeviceMenu(x, y) {
  if (!deviceMenu) return openColorModal(menuTargetPage || currentPage);
  closeNoteMenu();
  closeColorModal();
  closeDefaultColorModal();
  closePatternLengthMenu();
  const scale = Number(uiScale) || 1;
  const menuRect = deviceMenu.getBoundingClientRect();
  const menuW = menuRect.width / scale;
  const menuH = menuRect.height / scale;
  const vw = window.innerWidth / scale;
  const vh = window.innerHeight / scale;
  let left = x / scale;
  let top = y / scale;
  if (left + menuW > vw) left = vw - menuW - 8;
  if (top + menuH > vh) top = vh - menuH - 8;
  deviceMenu.style.left = `${left}px`;
  deviceMenu.style.top = `${top}px`;
  deviceMenu.classList.remove("hidden");
}
function closeDeviceMenu() {
  if (deviceMenu) deviceMenu.classList.add("hidden");
}

function openPatternLengthMenu(x, y) {
  if (!patternLengthMenu) return;
  closeDeviceMenu();
  closeNoteMenu();
  closeColorModal();
  closeDefaultColorModal();
  const scale = Number(uiScale) || 1;
  const menuRect = patternLengthMenu.getBoundingClientRect();
  const menuW = menuRect.width / scale;
  const menuH = menuRect.height / scale;
  const vw = window.innerWidth / scale;
  const vh = window.innerHeight / scale;
  let left = x / scale;
  let top = y / scale;
  if (left + menuW > vw) left = vw - menuW - 8;
  if (top + menuH > vh) top = vh - menuH - 8;
  patternLengthMenu.style.left = `${left}px`;
  patternLengthMenu.style.top = `${top}px`;
  patternLengthMenu.classList.remove("hidden");
}
function closePatternLengthMenu() {
  if (patternLengthMenu) patternLengthMenu.classList.add("hidden");
}

function openNoteMenu(x, y, info = {}) {
  if (!noteMenu) return;
  closeDeviceMenu();
  closePatternLengthMenu();
  closeColorModal();
  closeDefaultColorModal();
  const scale = Number(uiScale) || 1;
  const menuRect = noteMenu.getBoundingClientRect();
  const menuW = menuRect.width / scale;
  const menuH = menuRect.height / scale;
  const vw = window.innerWidth / scale;
  const vh = window.innerHeight / scale;
  let left = x / scale;
  let top = y / scale;
  if (left + menuW > vw) left = vw - menuW - 8;
  if (top + menuH > vh) top = vh - menuH - 8;
  if (noteMenuAccent) {
    noteMenuAccent.classList.toggle("active", !!info.accent);
    noteMenuAccent.disabled = !info.canAccent;
    noteMenuAccent.textContent = info.accent ? "Turn off Accent" : "Accent";
  }
  if (noteMenuSlide) {
    const showSlide = !!info.canSlide;
    noteMenuSlide.classList.toggle("hidden", !showSlide);
    noteMenuSlide.classList.toggle("active", !!info.slide);
    noteMenuSlide.disabled = !showSlide;
    if (!showSlide) {
      noteMenuSlide.textContent = "Slide";
    } else {
      noteMenuSlide.textContent = info.slide ? "Turn off Slide" : "Slide";
    }
  }
  noteMenu.style.left = `${left}px`;
  noteMenu.style.top = `${top}px`;
  noteMenu.classList.remove("hidden");
}
function closeNoteMenu() {
  if (noteMenu) noteMenu.classList.add("hidden");
  noteMenuTarget = null;
  pendingNoteMenu = null;
}
document.addEventListener("click", (e) => {
  if (deviceMenu && !deviceMenu.classList.contains("hidden") && !deviceMenu.contains(e.target)) {
    closeDeviceMenu();
  }
  if (patternLengthMenu && !patternLengthMenu.classList.contains("hidden") && !patternLengthMenu.contains(e.target)) {
    closePatternLengthMenu();
  }
  if (noteMenu && !noteMenu.classList.contains("hidden") && !noteMenu.contains(e.target)) {
    closeNoteMenu();
  }
});
document.addEventListener("contextmenu", (e) => {
  if (deviceMenu && !deviceMenu.classList.contains("hidden") && !deviceMenu.contains(e.target)) {
    closeDeviceMenu();
  }
  if (patternLengthMenu && !patternLengthMenu.classList.contains("hidden") && !patternLengthMenu.contains(e.target)) {
    closePatternLengthMenu();
  }
  if (noteMenu && !noteMenu.classList.contains("hidden") && !noteMenu.contains(e.target)) {
    closeNoteMenu();
  }
});
if (menuColor) {
  menuColor.onclick = () => {
    closeDeviceMenu();
    if (menuTargetPage) openColorModal(menuTargetPage);
  };
}
// Rename removed from panel; keep menu handler if present
if (menuRename) {
  menuRename.onclick = () => {
    closeDeviceMenu();
    if (!menuTargetPage) return;
    if (renameModal && renameInput) {
      openRenameModalForDevice(menuTargetPage);
      return;
    }
    const currentName = deviceNames[menuTargetPage] || `${menuTargetPage}`;
    const newName = prompt("Rename device", currentName);
    if (newName !== null && newName.trim().length) {
      const trimmed = newName.trim().slice(0, 10);
      deviceNames[menuTargetPage] = trimmed;
      applyDeviceBadge();
      renderTabs();
      ws?.readyState === WebSocket.OPEN &&
        ws.send(JSON.stringify({ type: "set_device_name", page: menuTargetPage, name: trimmed }));
    }
  };
}
if (menuPatternLengthCustom) {
  menuPatternLengthCustom.onclick = () => {
    closePatternLengthMenu();
    openRenameModalForPatternLength();
  };
}
if (noteMenuAccent) {
  noteMenuAccent.onclick = () => {
    if (!noteMenuTarget || !noteMenuTarget.canAccent) return closeNoteMenu();
    const next = !noteMenuTarget.accent;
    handleAccentOverlayMessage({ page: currentPage, x: noteMenuTarget.x, y: noteMenuTarget.y, accent: next });
    ws?.readyState === WebSocket.OPEN &&
      ws.send(JSON.stringify({ type: "set_step_accent", x: noteMenuTarget.x, y: noteMenuTarget.y, accent: next }));
    closeNoteMenu();
  };
}
if (noteMenuSlide) {
  noteMenuSlide.onclick = () => {
    if (!noteMenuTarget || !noteMenuTarget.canSlide) return closeNoteMenu();
    const next = !noteMenuTarget.slide;
    handleSlideOverlayMessage({ page: currentPage, x: noteMenuTarget.x, y: noteMenuTarget.y, slide: next });
    ws?.readyState === WebSocket.OPEN &&
      ws.send(JSON.stringify({ type: "set_step_slide", x: noteMenuTarget.x, y: noteMenuTarget.y, slide: next }));
    closeNoteMenu();
  };
}
// studio grid frontend logic: handles UI, WebSocket sync, WebMIDI, rendering the grid canvas, and local config caching.
