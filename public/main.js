import { AudioEventScheduler } from "./scheduler.js";

const WS_URL = `ws://${location.host}`;
const WIDTH = 16;
const HEIGHT = 8;
const CELL_SIZE = 40; //32
const CELL_GAP = 16; //12
const CANVAS_WIDTH = WIDTH * CELL_SIZE + (WIDTH - 1) * CELL_GAP;
const CANVAS_HEIGHT = HEIGHT * CELL_SIZE + (HEIGHT - 1) * CELL_GAP;
const BASE_WINDOW_WIDTH = 1080;
const BASE_WINDOW_HEIGHT = 690;
const LABEL_FONT = "400 8px 'Inter', sans-serif";
const DEVICE_COLOR_TOKENS = ["--dev-1", "--dev-2", "--dev-3", "--dev-4", "--dev-5", "--dev-6", "--dev-7", "--dev-8"];
let deviceColorPalette = [];
const BASE_DEFAULT_DEVICE_COLOR = getCssVar("--dev-3") || getCssVar("--dev-1") || resolveCssColorVar("--fg");
let ledPalette = [];
const DEFAULT_STEP_ROWS = 7;
// LED brightness levels (0-16)
const STEP_ON = 8;
const STEP_MICRO = 6;
const PLAYHEAD = 10;
const PATTERN_ACTIVE = 12;
const PATTERN_INACTIVE = 4;
const DEVICE_ACTIVE = 16;
const DEVICE_PRESENT = 8;
const BASE_PITCH = 60;
const PPQN_EXT = 24;
const PPQN_INT = 96;
const INT_MULT = PPQN_INT / PPQN_EXT;
const TICKS_PER_STEP_EXT = PPQN_EXT / 4;
const TICKS_PER_STEP_INT = TICKS_PER_STEP_EXT * INT_MULT;
const TAB_PROGRESS_BAR_HEIGHT = 2;
const TAB_PROGRESS_BAR_GAP = 2;
const TAB_PROGRESS_SEG_GAP = 2;
const TAB_PROGRESS_BAR_X_PAD = 0;
const PATTERN_CONTROL_GRID_X = 15;
const PATTERN_CONTROL_GRID_Y = 7;
const ENABLE_OCTAVE_SHIFTING = true;
const NOTE_EDIT_HOLD_MS = 150;
// TD-3 import octave application:
// - "note_view_navigation": direct per-step octave assignment (works with shifted note-view navigation)
// - "legacy_octave_shift": old setStepOctave-based path
const TD3_IMPORT_OCTAVE_APPLY_MODE = "note_view_navigation";

const textContentDescriptor = Object.getOwnPropertyDescriptor(Node.prototype, "textContent");
const textContentCache = new WeakMap();
if (textContentDescriptor && textContentDescriptor.set) {
  Object.defineProperty(Node.prototype, "textContent", {
    ...textContentDescriptor,
    set(value) {
      const str = value == null ? "" : String(value);
      if (textContentCache.get(this) === str) return;
      textContentCache.set(this, str);
      textContentDescriptor.set.call(this, str);
    }
  });
}

export function clampLedLevel(level) {
  const n = Number(level);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(16, Math.round(n)));
}

export function ledVar(level) {
  return `var(--led-${clampLedLevel(level)})`;
}

let colorProbe = null;

function resolveCssColor(value) {
  if (!value) return "";
  if (!colorProbe) {
    const probe = document.createElement("span");
    probe.style.position = "absolute";
    probe.style.left = "-9999px";
    probe.style.width = "1px";
    probe.style.height = "1px";
    probe.style.visibility = "hidden";
    const parent = document.body || document.documentElement;
    if (parent) parent.append(probe);
    colorProbe = probe;
  }
  colorProbe.style.color = value;
  return getComputedStyle(colorProbe).color;
}

function resolveCssColorVar(name) {
  return resolveCssColor(`var(${name})`);
}

function refreshLedPalette() {
  ledPalette = Array.from({ length: 17 }, (_, i) => resolveCssColor(ledVar(i)));
}

function getLedColor(level) {
  if (!ledPalette.length) refreshLedPalette();
  return ledPalette[clampLedLevel(level)];
}

function refreshDevicePalette() {
  const next = DEVICE_COLOR_TOKENS.map((token) => getCssVar(token) || resolveCssColorVar("--fg")).filter(Boolean);
  if (next.length) deviceColorPalette = next;
}

function findPaletteIndex(color, palette) {
  if (!color || !Array.isArray(palette)) return -1;
  const target = String(color).toLowerCase();
  return palette.findIndex((c) => String(c).toLowerCase() === target);
}

function remapDeviceColors(prevPalette, nextPalette) {
  if (!prevPalette?.length || !nextPalette?.length) return;
  for (let i = 1; i <= 8; i += 1) {
    const idx = findPaletteIndex(deviceColors[i], prevPalette);
    if (idx >= 0 && nextPalette[idx]) deviceColors[i] = nextPalette[idx];
  }
}

function getDefaultDeviceColorForPage(page) {
  if (page <= 0) return "";
  if (multiColorDefault) {
    if (!deviceColorPalette.length) refreshDevicePalette();
    return deviceColorPalette[page - 1] || defaultDeviceColor;
  }
  if (defaultUsesMainWhite) return getCssVar("--fg");
  return defaultDeviceColor;
}

function applyMultiColorDefault(next, opts = {}) {
  const enabled = !!next;
  multiColorDefault = enabled;
  if (enabled) {
    if (!deviceColorPalette.length) refreshDevicePalette();
    for (let i = 1; i <= 8; i += 1) {
      deviceColors[i] = deviceColorPalette[i - 1] || defaultDeviceColor;
      deviceColorOverrides[i] = false;
      ws?.readyState === WebSocket.OPEN &&
        ws.send(JSON.stringify({ type: "set_device_color", page: i, color: deviceColors[i] }));
    }
    deviceColors[0] = "";
  }
  if (!opts.skipUi) updateDefaultColorTrigger();
  if (!opts.skipRender) {
    renderTabs();
    renderFrame(frames[currentPage]);
  }
}

let ws;
let midiAccess;
let midiOut = null; // for current page only
let tempo = 120;
let swing = 50;
let running = false;
let tickTimer = null;
let currentPage = 1;
let serverCurrentPage = currentPage;
let currentPattern = 1;
let selectedDevicePage = currentPage;
let activeUiPage = currentPage; // 1-8 device pages, 0 = pattern launcher
let lastFocusedDevice = currentPage;
let pendingLauncherExitPage = null;
let deviceToolbarBaseHeight = null;
let baseDivision = 16; // base step division (1/16)
let gateLength = 1; // fraction of step length (0.25..1)
let playheads = Array(9).fill(0);
let deviceHeld = false;
let draggedDevicePage = null;
let deviceHasData = Array(9).fill(null);
let deviceStopped = Array(9).fill(null);
let midiSettings = Array.from({ length: 9 }, () => ({ outId: "", channel: 1 }));
let lastTabsRenderKey = "";

const canvas = document.getElementById("grid");
const noteScrollbar = document.getElementById("note-scrollbar");
const noteScrollbarThumb = document.getElementById("note-scrollbar-thumb");
const noteScrollbarStripes = document.getElementById("note-scrollbar-stripes");
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
const midiChanLabel = document.getElementById("midi-chan-label");
const tabs = document.getElementById("page-tabs");
const deviceTabProgressCanvas = document.getElementById("device-tab-progress");
const deviceTabProgressCtx = deviceTabProgressCanvas?.getContext("2d") || null;
const clockSourceSel = document.getElementById("clock-source");
const clockSourceTopSel = document.getElementById("clock-source-top");
const clockSourceTopWrap = document.getElementById("clock-source-top-wrap");
const clockInputSel = document.getElementById("clock-input");
const clockToggleBtn = document.getElementById("clock-toggle-btn");
const clockOutToggle = document.getElementById("clock-out-enable");
const clockOutPortSel = document.getElementById("clock-out-port");
const baseNoteLenSel = document.getElementById("base-note-length");
const gateLengthSel = document.getElementById("gate-length");
const scaleRootSel = document.getElementById("scale-root");
const scaleModeSel = document.getElementById("scale-mode");
const settingsTempoInput = document.getElementById("settings-tempo");
const settingsScaleRootSel = document.getElementById("settings-scale-root");
const settingsScaleModeSel = document.getElementById("settings-scale-mode");
const transposeDisplay = document.getElementById("transpose-value");
const transposeDec = document.getElementById("transpose-dec");
const transposeInc = document.getElementById("transpose-inc");
const seqTypeWrap = document.getElementById("seq-type-wrap");
const patternLauncherType = document.getElementById("pattern-launcher-type");
// legacy device pill (optional)
const devicePill = document.getElementById("device-pill") || null;
const settingsBtn = document.getElementById("settings-btn");
const settingsModal = document.getElementById("settings-modal");
const settingsBackdrop = document.getElementById("settings-backdrop");
const settingsClose = document.getElementById("settings-close");
const settingsSaveCfg = document.getElementById("settings-save-config");
const settingsRestoreCfg = document.getElementById("settings-restore-default");
const settingsConfirm = document.getElementById("settings-confirm");
const settingsTabs = Array.from(document.querySelectorAll(".settings-tab"));
const settingsPanels = Array.from(document.querySelectorAll(".settings-panel"));
let settingsActiveTabId = "settings-panel-workflow";
const showLogToggle = document.getElementById("show-log");
const autoFillToggle = document.getElementById("auto-fill");
const autoLoadToggle = document.getElementById("auto-load-set");
const patternControlLatchToggle = document.getElementById("pattern-control-latch");
const showMonomeControlsToggle = document.getElementById("show-monome-controls");
const rotateMonomeToggle = document.getElementById("rotate-monome");
const gateLedBoostToggle = document.getElementById("gate-led-boost");
const monomeControlsWrap = document.getElementById("monome-controls-wrap");
const mdBaseSweepInput = document.getElementById("md-base-sweep");
const monoSlidePadInput = document.getElementById("mono-slide-pad");
const uiScaleSel = document.getElementById("ui-scale");
const isoBaseInput = document.getElementById("iso-base-note");
const isoBaseLabel = document.getElementById("iso-base-label");
const isoStepXInput = document.getElementById("iso-step-x");
const isoStepYInput = document.getElementById("iso-step-y");
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

let customSelectsInitialized = false;
const customSelects = new Set();
const selectValueDescriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");

if (selectValueDescriptor && !HTMLSelectElement.prototype.__customSelectPatched) {
  Object.defineProperty(HTMLSelectElement.prototype, "__customSelectPatched", {
    value: true,
    writable: false
  });
  Object.defineProperty(HTMLSelectElement.prototype, "value", {
    get() {
      return selectValueDescriptor.get.call(this);
    },
    set(val) {
      selectValueDescriptor.set.call(this, val);
      if (this.__customSelect) updateCustomSelect(this);
    }
  });
}

function getSelectLabel(select) {
  const opt = select.selectedOptions && select.selectedOptions[0];
  return opt ? opt.textContent.trim() : "";
}

function updateCustomSelect(select) {
  const custom = select.__customSelect;
  if (!custom) return;
  const { trigger, menu } = custom;
  trigger.textContent = getSelectLabel(select);
  const options = Array.from(menu.querySelectorAll(".custom-select-option"));
  options.forEach((btn) => {
    const isSelected = btn.dataset.value === select.value;
    btn.classList.toggle("is-selected", isSelected);
    btn.setAttribute("aria-selected", isSelected ? "true" : "false");
  });
  trigger.disabled = select.disabled;
}

function rebuildCustomSelect(select) {
  const custom = select.__customSelect;
  if (!custom) return;
  const { menu } = custom;
  menu.innerHTML = "";
  Array.from(select.options).forEach((opt) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "custom-select-option";
    btn.textContent = opt.textContent;
    btn.dataset.value = opt.value;
    btn.setAttribute("role", "option");
    btn.dataset.clickOnUp = "true";
    if (opt.disabled) {
      btn.disabled = true;
      btn.setAttribute("aria-disabled", "true");
    }
    btn.onclick = () => {
      if (select.disabled || opt.disabled) return;
      select.value = opt.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      closeCustomSelect(select);
    };
    menu.appendChild(btn);
  });
  updateCustomSelect(select);
}

function closeCustomSelect(select) {
  const wrap = select.closest(".select-wrap");
  if (!wrap) return;
  wrap.classList.remove("is-open");
  const custom = select.__customSelect;
  if (custom) custom.trigger.setAttribute("aria-expanded", "false");
}

function closeAllCustomSelects() {
  customSelects.forEach((sel) => closeCustomSelect(sel));
}

function openCustomSelect(select) {
  const wrap = select.closest(".select-wrap");
  const custom = select.__customSelect;
  if (!wrap || !custom) return;
  closeAllCustomSelects();
  wrap.classList.remove("opens-up");
  wrap.classList.add("is-open");
  custom.trigger.setAttribute("aria-expanded", "true");
  custom.menu.style.minWidth = `${custom.trigger.offsetWidth}px`;
  const menuHeight = custom.menu.scrollHeight;
  const rect = custom.trigger.getBoundingClientRect();
  if (rect.bottom + menuHeight > window.innerHeight && rect.top - menuHeight > 0) {
    wrap.classList.add("opens-up");
  }
  const selected = custom.menu.querySelector(".custom-select-option.is-selected");
  if (selected) selected.focus();
}

function toggleCustomSelect(select) {
  const wrap = select.closest(".select-wrap");
  if (!wrap || select.disabled) return;
  if (wrap.classList.contains("is-open")) {
    closeCustomSelect(select);
  } else {
    openCustomSelect(select);
  }
}

function handleCustomSelectKeydown(e, select) {
  if (select.disabled) return;
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    toggleCustomSelect(select);
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    openCustomSelect(select);
  } else if (e.key === "Escape") {
    closeCustomSelect(select);
  }
}

function handleCustomSelectMenuKeydown(e, select) {
  const options = Array.from(e.currentTarget.querySelectorAll(".custom-select-option"));
  const currentIndex = options.findIndex((el) => el === document.activeElement);
  if (e.key === "ArrowDown") {
    e.preventDefault();
    const next = options[Math.min(options.length - 1, currentIndex + 1)] || options[0];
    if (next) next.focus();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    const prev = options[Math.max(0, currentIndex - 1)] || options[options.length - 1];
    if (prev) prev.focus();
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeCustomSelect(select);
    select.__customSelect?.trigger.focus();
  }
}

function buildCustomSelect(select) {
  const wrap = select.closest(".select-wrap");
  if (!wrap || wrap.classList.contains("custom-select")) return;
  wrap.classList.add("custom-select");
  const sizeClass = Array.from(select.classList).find((name) => name.startsWith("input-"));
  if (sizeClass) wrap.classList.add(sizeClass);
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "custom-select-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  const menu = document.createElement("div");
  menu.className = "custom-select-menu";
  menu.setAttribute("role", "listbox");
  wrap.appendChild(trigger);
  wrap.appendChild(menu);
  select.__customSelect = { trigger, menu };
  customSelects.add(select);
  rebuildCustomSelect(select);
  trigger.addEventListener("click", (e) => {
    e.preventDefault();
    toggleCustomSelect(select);
  });
  trigger.addEventListener("keydown", (e) => handleCustomSelectKeydown(e, select));
  menu.addEventListener("keydown", (e) => handleCustomSelectMenuKeydown(e, select));
  select.addEventListener("change", () => updateCustomSelect(select));
  const observer = new MutationObserver(() => rebuildCustomSelect(select));
  observer.observe(select, { childList: true, subtree: true });
  select.__customSelect.observer = observer;
}

function initCustomSelects() {
  if (customSelectsInitialized) return;
  customSelectsInitialized = true;
  document.querySelectorAll(".select-wrap select").forEach(buildCustomSelect);
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".select-wrap.custom-select")) closeAllCustomSelects();
  });
}
const barRow = document.getElementById("bar-row");
const drumInputs = Array.from(document.querySelectorAll(".drum-note-input"));
const editingDrumInputs = new Set();
const scaleNotesWrap = document.getElementById("scale-notes");
const deviceToolbar = document.querySelector(".device-toolbar");
const patternToolbar = document.querySelector(".pattern-toolbar");
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
const tempWarmBtn = document.getElementById("temp-warm");
const tempColdBtn = document.getElementById("temp-cold");
const colorsPastelBtn = document.getElementById("colors-pastel");
const colorsSolidBtn = document.getElementById("colors-solid");
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
let pendingSetSaveResolver = null;
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
const td3ImportSysexBtn = document.getElementById("td3-import-sysex-btn");
const td3ExportSysexBtn = document.getElementById("td3-export-sysex-btn");
const td3SysexModal = document.getElementById("td3-sysex-modal");
const td3SysexTitle = document.getElementById("td3-sysex-title");
const td3SysexClose = document.getElementById("td3-sysex-close");
const td3SysexCancel = document.getElementById("td3-sysex-cancel");
const td3SysexConfirm = document.getElementById("td3-sysex-confirm");
const td3SysexGroupInput = document.getElementById("td3-sysex-group");
const td3SysexBankSelect = document.getElementById("td3-sysex-bank");
const td3SysexPatternInput = document.getElementById("td3-sysex-pattern");
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
  whole_tone: [0, 2, 4, 6, 8, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};
const formatRoot = (root) => NOTE_NAMES[((Number(root) || 0) % 12 + 12) % 12];
const formatMidiNote = (midi) => {
  const safe = Math.max(0, Math.min(127, Math.round(Number(midi) || 0)));
  const name = NOTE_NAMES[safe % 12] || "C";
  const oct = Math.floor(safe / 12) - 1;
  return `${name}${oct}`;
};
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
    if (input.classList.contains("drum-note-extra")) {
      wrap.classList.add("drum-note-extra-wrap");
    }
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    const stepper = document.createElement("button");
    stepper.type = "button";
    stepper.className = "number-stepper";
    stepper.setAttribute("aria-label", "Adjust value");
    stepper.dataset.clickOnUp = "true";
    stepper.innerHTML = "<i class=\"iconoir-arrow-separate-vertical\" aria-hidden=\"true\"></i>";
    wrap.appendChild(stepper);

    stepper.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if (input.disabled) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = stepper.getBoundingClientRect();
      const isUp = event.clientY - rect.top < rect.height / 2;
      const stepAttr = input.step;
      const stepVal = stepAttr && stepAttr !== "any" ? Number(stepAttr) : 1;
      const step = Number.isFinite(stepVal) && stepVal > 0 ? stepVal : 1;
      const decimals = stepAttr && stepAttr.includes(".") ? stepAttr.split(".")[1].length : 0;
      const minVal = input.min !== "" ? Number(input.min) : NaN;
      const maxVal = input.max !== "" ? Number(input.max) : NaN;
      const baseVal = Number.isFinite(Number(input.value))
        ? Number(input.value)
        : (Number.isFinite(minVal) ? minVal : 0);
      let next = baseVal + (isUp ? step : -step);
      if (Number.isFinite(minVal)) next = Math.max(minVal, next);
      if (Number.isFinite(maxVal)) next = Math.min(maxVal, next);
      input.value = decimals > 0 ? String(Number(next.toFixed(decimals))) : String(Math.round(next));

      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.focus();
    });

    input.dataset.stepperAttached = "true";
  });
};

initNumberSteppers();

// Trigger click handlers on press instead of release, unless opted out.
(() => {
  let lastPointerDownTarget = null;
  let lastPointerDownAt = 0;

  const isAllowedInput = (el) => {
    if (!el || el.tagName !== "INPUT") return true;
    const type = (el.type || "").toLowerCase();
    return ["button", "submit", "reset"].includes(type);
  };

  const resolveImmediateTarget = (start) => {
    let node = start;
    while (node && node !== document.documentElement) {
      if (node.dataset?.clickOnUp === "true") return null;
      if (node.disabled) return null;
      if (node.tagName === "BUTTON" || node.tagName === "A" || node.tagName === "CANVAS") return node;
      if (node.getAttribute?.("role") === "button") return node;
      if (typeof node.onclick === "function") return node;
      if (node.tagName === "INPUT" && isAllowedInput(node)) return node;
      node = node.parentElement;
    }
    return null;
  };

  document.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const target = resolveImmediateTarget(e.target);
    if (!target) return;
    if (!isAllowedInput(target)) return;
    if (target.tagName === "CANVAS" && target.id === "grid") return;
    lastPointerDownTarget = target;
    lastPointerDownAt = e.timeStamp;
    if (typeof target.onpointerdown !== "function") {
      target.click();
    }
  }, true);

document.addEventListener("click", (e) => {
  if (!e.isTrusted) return;
  const target = resolveImmediateTarget(e.target);
  if (!target) return;
  if (target === lastPointerDownTarget && e.timeStamp - lastPointerDownAt < 1000) {
    e.preventDefault();
    e.stopImmediatePropagation();
    lastPointerDownTarget = null;
  }
}, true);
})();

document.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  if (noteScrollbar.contains(e.target)) return;
  if (e.shiftKey || e.ctrlKey || e.metaKey) return;
  if (gridPointerActive || selectionBoxActive || selectionDragActive || dragPaintActive) return;
  const selection = selectionByPage[currentPage];
  if (!selection || selection.size === 0) return;
  if (e.target === canvas) {
    const hit = getGridHit(e.clientX, e.clientY);
    if (isPlayableCell(hit)) {
      const key = cellKey(hit.x, hit.y);
      if (selection.has(key)) return;
    }
  }
  clearSelection();
}, true);

// splash screen handling

const MIN_SPLASH_TIME = 2800; // ms
const splashStart = performance.now();

function hideSplash() {
  const splash = document.getElementById("splash");
  if (!splash) return;

  splash.classList.add("fade-out");
  setTimeout(() => splash.remove(), 800);
}

window.addEventListener("load", () => {
  const elapsed = performance.now() - splashStart;
  const remaining = Math.max(0, MIN_SPLASH_TIME - elapsed);

  setTimeout(hideSplash, remaining);
});

let defaultDeviceColor = BASE_DEFAULT_DEVICE_COLOR;
let settingsOpen = false;
let multiColorDefault = true;
let defaultUsesMainWhite = false;
let whiteMode = document.documentElement.dataset.white || "warm";
let colorMode = document.documentElement.dataset.colors || "pastel";

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
const noteMenuChain = document.getElementById("note-menu-chain");
const selectionRect = document.getElementById("selection-rect");
const gridWrap = document.querySelector(".grid-wrap");
const gridPanel = document.querySelector(".grid-panel");
const mainPanel = document.querySelector(".main-panel");
let noteMenuTarget = null;
let pendingNoteMenu = null;
const octaveControls = document.createElement("div");
octaveControls.className = "note-octave-controls";
octaveControls.innerHTML = `
  <button type="button" data-delta="1" aria-label="Raise octave">↑</button>
  <button type="button" data-delta="-1" aria-label="Lower octave">↓</button>
`;
document.body.append(octaveControls);
if (!ENABLE_OCTAVE_SHIFTING) octaveControls.style.display = "none";
const octaveUpBtn = octaveControls.querySelector('[data-delta="1"]');
const octaveDownBtn = octaveControls.querySelector('[data-delta="-1"]');
const microControls = document.createElement("div");
microControls.className = "note-micro-controls";
microControls.innerHTML = `
  <button type="button" data-delta="-1" aria-label="Nudge earlier"><i class="iconoir-transition-left" aria-hidden="true"></i></button>
  <button type="button" data-delta="1" aria-label="Nudge later"><i class="iconoir-transition-right" aria-hidden="true"></i></button>
`;
document.body.append(microControls);
const microLeftBtn = microControls.querySelector('[data-delta="-1"]');
const microRightBtn = microControls.querySelector('[data-delta="1"]');
let hoveredStep = null;
let octaveHoverTimer = null;
let octaveAnchorPress = null;
let isOverOctaveControls = false;
let isOverMicroControls = false;
let pendingOctaveHover = null;
let octaveHideTimer = null;
let microHideTimer = null;
let lastOctaveTarget = null;
let remoteOctaveTimer = null;
let octaveOverlayLock = false;
const selectionByPage = Array.from({ length: 9 }, () => new Set());
const selectionInfoByPage = Array.from({ length: 9 }, () => new Map());
let selectionRenderOffset = null;
let selectionBoxActive = false;
let selectionBoxMode = "replace";
let selectionBoxStart = null;
let selectionBoxPreviewCells = new Set();
let selectionDragActive = false;
let selectionDragStart = null;
let selectionMovePending = false;
let selectionCopyActive = false;
let dragPaintActive = false;
let dragPaintVisited = new Set();
let gridPointerActive = false;
let pendingStepsStateId = 1;
const pendingStepsStateRequests = new Map();
let pendingMoveStepsId = 1;
const pendingMoveStepsRequests = new Map();
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
    internalTickPeriodSec = 60 / (tempo * PPQN_EXT);
    internalStartTimeSec = getNowSec() - transportTickExt * internalTickPeriodSec;
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
  "td3-confirm",
  "td3-action-modal",
  "td3-import-sysex-btn",
  "td3-export-sysex-btn",
  "td3-sysex-modal",
  "td3-sysex-group",
  "td3-sysex-bank",
  "td3-sysex-pattern"
]);

let frames = Array.from({ length: 9 }, () => new Array(WIDTH * HEIGHT).fill(0));
let frameReady = Array(9).fill(false);
let isomorphicModes = Array(9).fill(false);
let isomorphicLayout = { base: 48, stepX: 1, stepY: 3 };
const BLANK_FRAME = new Array(WIDTH * HEIGHT).fill(0);
let suppressFrameUntilNext = Array(9).fill(false);
let overlays = Array.from({ length: 9 }, () => []);
const octaveAnchors = Array.from({ length: 9 }, () => new Set());
let transposes = Array.from({ length: 9 }, () => 0);
const NOTE_VIEW_ROW_SHIFT_MIN = -14;
const NOTE_VIEW_ROW_SHIFT_MAX = 14;
const NOTE_SCROLLBAR_THUMB_FRACTION = 1 / 5;
let noteViewOffsets = Array.from({ length: 9 }, () => 0);
const noteViewPitches = Array.from({ length: 9 }, () => []);
let noteScrollbarDrag = null;

function applyOctaveOverlaysSnapshot(snapshot) {
  if (!Array.isArray(snapshot)) return;
  const prevOverlays = overlays;
  if (!ENABLE_OCTAVE_SHIFTING) {
    overlays = Array.from({ length: 9 }, (_, idx) => {
      const micros = Array.isArray(prevOverlays?.[idx])
        ? prevOverlays[idx].filter((o) => o?.kind === "micro")
        : [];
      return micros;
    });
    return;
  }
  overlays = Array.from({ length: 9 }, (_, idx) => {
    const list = Array.isArray(snapshot[idx]) ? snapshot[idx] : [];
    return list
      .filter((o) => Number.isFinite(o?.x) && Number.isFinite(o?.y) && Number.isFinite(o?.octave))
      .map((o) => {
        return {
          x: o.x,
          y: o.y,
          kind: "octave",
          text: o.octave > 0 ? `+${o.octave}` : `${o.octave}`
        };
      });
  }).map((octs, idx) => {
    const micros = Array.isArray(prevOverlays?.[idx])
      ? prevOverlays[idx].filter((o) => o?.kind === "micro")
      : [];
    return octs.concat(micros);
  });
}

function clearNumericOverlays(pageIdx) {
  if (!overlays[pageIdx]) return;
  overlays[pageIdx] = overlays[pageIdx].filter((o) => !/^[-+]?\d/.test(o.text));
}

function resetOctaveOverlayUI() {
  if (octaveAnchorPress) clearTimeout(octaveAnchorPress.timer);
  octaveAnchorPress = null;
  if (octaveHoverTimer) clearTimeout(octaveHoverTimer);
  octaveHoverTimer = null;
  pendingOctaveHover = null;
  hoveredStep = null;
  lastOctaveTarget = null;
  octaveOverlayLock = false;
  octaveControls.style.display = "none";
  microControls.style.display = "none";
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
const hasElectronSave = !!window.electronAPI?.saveSet;
const NON_DIRTY_WS_TYPES = new Set([
  "subscribe_events",
  "register_ni_ui",
  "ni_ui_toast",
  "midi_log",
  "transport",
  "clockTicks",
  "get_step_state",
  "get_steps_state",
  "copy_bar",
  "copy_pattern",
  "copy_steps",
  "export_state",
  "export_td3",
  "td3_export_sysex",
  "td3_import_preview",
  "td3_import_payload_preview",
  "set_external_arm",
  "set_follow",
  "set_auto_fill",
  "set_base_division",
  "set_gate_length",
  "set_gate_led_boost",
  "set_led_levels",
  "set_pattern_control_latch",
  "set_midi",
  "set_monome_controls",
  "set_monome_rotation",
  "set_mono_slide_pad",
  "set_clock_source",
  "set_clock_input",
  "set_clock_out",
  "set_clock_out_device",
  "set_md_slide_params",
  "set_page",
  "set_pattern"
]);
let isDirty = false;
let pendingDirtyReset = true;
let receivedStateOnce = false;
const UNDO_HISTORY_LIMIT = 50;
let undoHistory = [];
let redoHistory = [];
let undoInitialized = false;
let undoSnapshotTimer = null;
let undoSnapshotInFlight = false;
let undoSnapshotQueued = false;
let pendingUndoReset = false;
let applyingUndoRedo = false;
window.electronAPI?.setDirty?.(isDirty);
let activePatterns = Array.from({ length: 9 }, () => 1);
let pendingPatterns = Array.from({ length: 9 }, () => null);
let patternLengths = Array.from({ length: 9 }, () => Array(9).fill(16));
let patternTimeScales = Array.from({ length: 9 }, () => Array(9).fill(1));
// pattern lengths not tracked client-side
const DEFAULT_LED_LEVELS = {
  step_on: 8,
  step_micro: 10, // align with step_on; micro timing disabled
  step_accent: 14,
  playhead: 16,
  pattern_active: 12,
  pattern_pending: 6,
  pattern_inactive: 4,
  device_present: 8,
  device_active: 16
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
let externalIntervalEstMs = null;
let externalPredictedTickMs = null;
let externalWarmupTicks = 0;
let lastSentExternalTick = -1;
let externalStartSent = false;
let autoStartPending = false;
let autoStartFirstMs = 0;
let autoStartTicks = 0;
let transportTickExt = 0;
let deviceTabProgressRaf = null;
let deviceTabProgressCssWidth = 0;
let deviceTabProgressCssHeight = 0;
const deviceTabHoldTimers = new Map();
const deviceTabHoldFired = new Set();
const DEVICE_TAB_HOLD_MS = 300;
let externalArmed = false;
const activeNotes = new Map();
const lastScheduledNoteOff = new Map();
let uiScale = 1; //default Scale UI
let uiScaleInitialized = false;
// pattern lengths not tracked client-side
let barViews = Array.from({ length: 9 }, () => Array(9).fill(0));
let barPlayheads = Array.from({ length: 9 }, () => Array(9).fill(null));
let followEnabled = false;
let patternClipboard = null;
let barClipboard = null;
let lastCopyType = null; // "pattern" | "bar"
let autoFillBars = true;
let mdSlideSpeed = 0.6;
let mdSlideCurve = 1.0;
let mdBaseSweep = 80;
let monoSlidePad = 0.1; // fraction of a step to trim slide gates
let sequencerTypes = Array.from({ length: 9 }, () => "mono");
let gridConnected = false;
let fullScaleMode = false;
let showMonomeControls = true;
let monomeRotation = 0;
let niControllerActive = false;
let gateLedBoost = false;
let gridDevices = [];
let monomeControlsAvailable = false;
const LOCAL_CONFIG_KEY = "studio_grid_config";
let pendingTd3Import = null; // { data, page, kind }
let pendingTd3SysexExport = null; // { output }
const DEFAULT_DRUMS = [36, 38, 41, 43, 45, 47, 55, 60]; // C1..C2 bottom->top
let drumNotes = Array.from({ length: 9 }, () => DEFAULT_DRUMS.slice());
const DEFAULT_CC = 1;
let ccNumbers = Array.from({ length: 9 }, (_, i) => (i === 0 ? null : DEFAULT_CC));
let mdTracks = Array.from({ length: 9 }, () => 1);
let ccNumberEditing = false;
let appliedLocalSnapshot = false;
let cachedConfig = null;
let autoLoadSet = false;
let patternControlLatch = true;
let patternControlActive = false;
let resetNamesOnNextState = false;
let barFlashTimer = null;
const MIN_MIDI_LEAD_MS = 5;
const EXT_CLOCK_ALPHA = 0.05;
const EXT_CLOCK_PHASE_ALPHA = 0.15;
const EXT_CLOCK_OUTLIER_FRAC = 0.25;
const EXT_CLOCK_WARMUP_TICKS = 24;
const CLOCK_DEBUG = new URLSearchParams(window.location.search).has("clockDebug")
  || window.localStorage.getItem("clockDebug") === "1";
const MIDI_LOG = new URLSearchParams(window.location.search).has("midiLog")
  || window.localStorage.getItem("midiLog") === "1";
const CLOCK_DEBUG_REPORT_MS = 5000;
const clockDebug = CLOCK_DEBUG ? {
  lastReportMs: 0,
  lastServerLogMs: 0,
  extObs: makeStats(),
  extEst: makeStats(),
  leadClock: makeStats(),
  leadNote: makeStats()
} : null;
let midiLogAnnounced = false;
const lastSentState = {
  clockSource: null,
  clockInputId: null,
  clockOutEnabled: null,
  clockOutPortId: null,
  autoFillBars: null,
  patternControlLatch: null,
  showMonomeControls: null,
  gateLedBoost: null,
  baseDivision: null,
  gateLength: null,
  mdSlideParams: { factor: null, curve: null, baseMs: null },
  monoSlidePad: null,
  isomorphicLayout: { base: null, stepX: null, stepY: null },
  ledLevels: {},
  midiSettings: Array.from({ length: 9 }, () => ({ outId: null, channel: null }))
};

function resetLastSentState() {
  lastSentState.clockSource = null;
  lastSentState.clockInputId = null;
  lastSentState.clockOutEnabled = null;
  lastSentState.clockOutPortId = null;
  lastSentState.autoFillBars = null;
  lastSentState.patternControlLatch = null;
  lastSentState.showMonomeControls = null;
  lastSentState.gateLedBoost = null;
  lastSentState.baseDivision = null;
  lastSentState.gateLength = null;
  lastSentState.mdSlideParams = { factor: null, curve: null, baseMs: null };
  lastSentState.monoSlidePad = null;
  lastSentState.isomorphicLayout = { base: null, stepX: null, stepY: null };
  lastSentState.ledLevels = {};
  lastSentState.midiSettings = Array.from({ length: 9 }, () => ({ outId: null, channel: null }));
}

const SCALE_ROOTS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function normalizeDeviceNames(names) {
  return Array.from({ length: 9 }, (_, i) => {
    if (i === 0) return null;
    const raw = names ? names[i] : null;
    const str = raw == null ? "" : String(raw).trim();
    return str.length ? str : `${i}`;
  });
}

function hasLargeGrid(devices = null) {
  const list = Array.isArray(devices) ? devices : gridDevices;
  return list.some((d) => d?.connected && ((d?.cols || 0) > 8 || (d?.rows || 0) > 8));
}

function updateMonomeControlsAvailability(devices = null) {
  const available = gridConnected && hasLargeGrid(devices);
  monomeControlsAvailable = available;
  if (monomeControlsWrap) monomeControlsWrap.classList.toggle("hidden", !available);
}

function applyMonomeControlsUI() {
  if (!showMonomeControlsToggle) return;
  showMonomeControlsToggle.checked = showMonomeControls && !niControllerActive;
  showMonomeControlsToggle.disabled = niControllerActive;
  showMonomeControlsToggle.title = niControllerActive ? "The NI controller is using the full note grid" : "";
}

function applyGateLedBoostUI() {
  if (gateLedBoostToggle) gateLedBoostToggle.checked = !!gateLedBoost;
}

function resolveClockInputId(value) {
  if (!value || !Array.isArray(clockInputs)) return "";
  const match = clockInputs.find((entry) => entry?.id === value || entry?.name === value);
  return match ? match.id : value;
}

function sendClockSourceIfChanged(source) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (lastSentState.clockSource === source) return;
  lastSentState.clockSource = source;
  ws.send(JSON.stringify({ type: "set_clock_source", source }));
}

function sendClockInputIfChanged(id) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!id) return;
  if (lastSentState.clockInputId === id) return;
  lastSentState.clockInputId = id;
  ws.send(JSON.stringify({ type: "set_clock_input", id, name: id }));
}

function sendClockOutIfChanged(enabled) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (lastSentState.clockOutEnabled === enabled) return;
  lastSentState.clockOutEnabled = enabled;
  ws.send(JSON.stringify({ type: "set_clock_out", enabled }));
}

function sendClockOutDeviceIfChanged(id) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (lastSentState.clockOutPortId === id) return;
  lastSentState.clockOutPortId = id;
  ws.send(JSON.stringify({ type: "set_clock_out_device", id, name: id }));
}

function sendAutoFillIfChanged(enabled) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (lastSentState.autoFillBars === enabled) return;
  lastSentState.autoFillBars = enabled;
  ws.send(JSON.stringify({ type: "set_auto_fill", enabled }));
}

function sendPatternControlLatchIfChanged(enabled) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (lastSentState.patternControlLatch === enabled) return;
  lastSentState.patternControlLatch = enabled;
  ws.send(JSON.stringify({ type: "set_pattern_control_latch", enabled }));
}

function sendMonomeControlsIfChanged(enabled) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (lastSentState.showMonomeControls === enabled) return;
  lastSentState.showMonomeControls = enabled;
  ws.send(JSON.stringify({ type: "set_monome_controls", enabled }));
}

function applyMonomeRotation(degrees, { send = false } = {}) {
  monomeRotation = degrees === 180 ? 180 : 0;
  if (rotateMonomeToggle) rotateMonomeToggle.checked = monomeRotation === 180;
  if (send && ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "set_monome_rotation", degrees: monomeRotation }));
  }
}

function sendGateLedBoostIfChanged(enabled) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (lastSentState.gateLedBoost === enabled) return;
  lastSentState.gateLedBoost = enabled;
  ws.send(JSON.stringify({ type: "set_gate_led_boost", enabled }));
}

function sendPatternControlToggleFromUI(action) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const sendLauncherKey = (s) => ws.send(JSON.stringify({
    type: "grid_key", x: PATTERN_CONTROL_GRID_X, y: PATTERN_CONTROL_GRID_Y, s, patternLauncher: true
  }));
  if (action === "enter") {
    sendLauncherKey(1);
    return;
  }
  if (action === "exit") {
    // Send both press+release so exit works regardless of latch setting.
    sendLauncherKey(1);
    sendLauncherKey(0);
    return;
  }
  sendLauncherKey(patternControlLatch ? 1 : (patternControlActive ? 0 : 1));
}

function sendBaseDivisionIfChanged(division) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (lastSentState.baseDivision === division) return;
  lastSentState.baseDivision = division;
  ws.send(JSON.stringify({ type: "set_base_division", division }));
}

function sendGateLengthIfChanged(length) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (lastSentState.gateLength === length) return;
  lastSentState.gateLength = length;
  ws.send(JSON.stringify({ type: "set_gate_length", length }));
}

function sendMdSlideParamsIfChanged(factor, curve, baseMs) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const prev = lastSentState.mdSlideParams || {};
  if (prev.factor === factor && prev.curve === curve && prev.baseMs === baseMs) return;
  lastSentState.mdSlideParams = { factor, curve, baseMs };
  ws.send(JSON.stringify({ type: "set_md_slide_params", factor, curve, baseMs }));
}

function sendMonoSlidePadIfChanged(value) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (lastSentState.monoSlidePad === value) return;
  lastSentState.monoSlidePad = value;
  ws.send(JSON.stringify({ type: "set_mono_slide_pad", value }));
}

function sendIsomorphicLayoutIfChanged(layout) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const next = sanitizeIsomorphicLayout(layout);
  const prev = lastSentState.isomorphicLayout || {};
  if (prev.base === next.base && prev.stepX === next.stepX && prev.stepY === next.stepY) return;
  lastSentState.isomorphicLayout = { ...next };
  ws.send(JSON.stringify({ type: "set_isomorphic_layout", layout: next }));
}

function sendLedLevelsIfChanged(levels) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!levels || typeof levels !== "object") return;
  const delta = {};
  Object.entries(levels).forEach(([key, value]) => {
    if (lastSentState.ledLevels[key] !== value) delta[key] = value;
  });
  const keys = Object.keys(delta);
  if (!keys.length) return;
  keys.forEach((key) => {
    lastSentState.ledLevels[key] = delta[key];
  });
  ws.send(JSON.stringify({ type: "set_led_levels", levels: delta }));
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
  const rawSend = ws.send.bind(ws);
  ws.send = (data) => {
    try {
      const msg = typeof data === "string" ? JSON.parse(data) : data;
      if (msg?.type === "import_state" && !applyingUndoRedo) {
        resetUndoHistory();
      }
      if (receivedStateOnce && shouldMarkDirty(msg)) {
        setDirty(true);
        queueUndoSnapshot();
      }
    } catch (e) {
      // ignore serialization/inspection errors and continue sending raw payload
    }
    return rawSend(data);
  };
  ws.onopen = () => {
    if (wsStatus) wsStatus.textContent = "WS: connected";
    log("WS connected");
    resetLastSentState();
    ws.send(JSON.stringify({ type: "subscribe_events" }));
    ws.send(JSON.stringify({ type: "register_ni_ui", desktop: !!window.electronAPI }));
    if (MIDI_LOG && !midiLogAnnounced) {
      midiLogAnnounced = true;
      const payload = { kind: "enabled", nowTs: Number(performance.now().toFixed(3)) };
      console.log("[midi-log]", payload);
      ws.send(JSON.stringify({ type: "midi_log", data: payload }));
    }
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
          log("Restoring last saved project");
        }
      } catch (e) {
        console.warn("Failed to load last project", e);
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
    if (clockDebug && (msg.type === "tempo" || msg.type === "clock_status")) {
      const now = performance.now();
      if ((now - clockDebug.lastServerLogMs) > 2000) {
        clockDebug.lastServerLogMs = now;
        if (msg.type === "clock_status") {
          const serverTick = msg?.data?.tick;
          const predictedTick = getInterpolatedTransportTickExt();
          const tickDelta = Number.isFinite(serverTick) ? (serverTick - predictedTick) : null;
          console.log("[clock-debug] server clock_status", {
            tickDelta: Number.isFinite(tickDelta) ? tickDelta.toFixed(3) : "n/a",
            serverTick,
            predictedTick: Number.isFinite(predictedTick) ? predictedTick.toFixed(3) : "n/a"
          });
        } else if (msg.type === "tempo") {
          console.log("[clock-debug] server tempo", msg.bpm);
        }
      }
    }
    if (msg.type === "ni_edit") {
      const buttons = {
        copy_bar: copyBarBtn,
        copy_pattern: copyPatternBtn,
        paste: pasteBtn,
        clear_bar: confirmClearBar,
        clear_pattern: confirmClearPattern
      };
      if (msg.action === "paste" && !lastCopyType) showToast("Nothing to paste");
      else if (Object.hasOwn(buttons, msg.action)) buttons[msg.action]?.click();
    } else if (msg.type === "log") {
      log(msg.message);
    } else if (msg.type === "error") {
      const text = String(msg.message || "Server error");
      log(text);
      showToast(text);
      pendingTd3SysexExport = null;
    } else if (msg.type === "led_frame") {
      const incoming = msg.frame;
      let targetPage = serverCurrentPage;
      if (!Number.isFinite(targetPage) || targetPage < 1 || targetPage > 8) {
        targetPage = currentPage;
      }
      if (Array.isArray(incoming)) {
        frames[targetPage] = incoming.slice();
        octaveAnchors[targetPage] = new Set(msg.octaveAnchors || []);
        frameReady[targetPage] = true;
        suppressFrameUntilNext[targetPage] = false;
      }
      if (msg.deviceHasData) deviceHasData = msg.deviceHasData;
      if (msg.deviceStopped) deviceStopped = msg.deviceStopped;
      if (Array.isArray(msg.octaveOverlays)) {
        applyOctaveOverlaysSnapshot(msg.octaveOverlays);
      }
      if (targetPage === currentPage) {
        renderFrame(frames[currentPage]);
      }
      renderDeviceTabProgressFrame();
    } else if (msg.type === "scale") {
      if (msg.scale) scale = msg.scale;
      applyScaleUI();
    } else if (msg.type === "state") {
      tempo = msg.tempo || tempo;
      swing = msg.swing || swing;
      baseDivision = msg.baseDivision || baseDivision;
      if (typeof msg.gateLength === "number") {
        gateLength = normalizeGateLength(msg.gateLength);
        applyGateLengthUI();
      }
      midiSettings = msg.midi || midiSettings;
      if (typeof msg.monoSlidePad === "number") {
        monoSlidePad = Math.max(0, Math.min(0.5, Number(msg.monoSlidePad)));
      }
      if (typeof msg.setName === "string") {
        setName = msg.setName;
        updateSetTitle(setName);
      }
      if (msg.transposes) transposes = msg.transposes;
      if (Array.isArray(msg.noteViewOffsets)) {
        noteViewOffsets = msg.noteViewOffsets.map((v, idx) => (idx === 0 ? null : (Number.isFinite(v) ? Math.max(NOTE_VIEW_ROW_SHIFT_MIN, Math.min(NOTE_VIEW_ROW_SHIFT_MAX, Math.round(v))) : 0)));
      }
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
        if (!multiColorDefault) {
          deviceColors = msg.colors.slice(0, 9);
          deviceColors[0] = "";
          deviceColorOverrides = deviceColors.map((c, idx) => {
            if (idx === 0 || !c) return false;
            const defaultForPage = getDefaultDeviceColorForPage(idx);
            return c.toLowerCase() !== defaultForPage.toLowerCase();
          });
        } else {
          applyMultiColorDefault(true, { skipRender: true, skipUi: true });
        }
      } else if (!deviceColorOverrides.some(Boolean)) {
        deviceColors = Array(9).fill(defaultDeviceColor);
        deviceColors[0] = "";
      }
      if (msg.drumNotes) drumNotes = msg.drumNotes.map((d, idx) => (idx === 0 ? null : (Array.isArray(d) ? d.slice(0, 8) : DEFAULT_DRUMS.slice())));
      if (msg.ccNumbers) ccNumbers = msg.ccNumbers.map((c, idx) => (idx === 0 ? null : (Number.isFinite(c) ? c : DEFAULT_CC)));
      if (msg.activePatterns) activePatterns = msg.activePatterns;
      if (msg.pendingPatterns) pendingPatterns = msg.pendingPatterns;
      if (msg.patternLengths) patternLengths = msg.patternLengths;
      if (msg.patternTimeScales) patternTimeScales = msg.patternTimeScales;
      if (msg.barViews) barViews = msg.barViews;
      if (msg.barPlayheads) barPlayheads = msg.barPlayheads;
      if (Array.isArray(msg.isomorphicModes)) {
        isomorphicModes = msg.isomorphicModes.map((v, idx) => (idx === 0 ? null : !!v));
      }
      if (msg.isomorphicLayout) {
        isomorphicLayout = sanitizeIsomorphicLayout(msg.isomorphicLayout);
        applyIsomorphicLayoutUI();
      }
      if (msg.deviceHasData) deviceHasData = msg.deviceHasData;
      if (msg.deviceStopped) deviceStopped = msg.deviceStopped;
      if (Array.isArray(msg.deviceOrder)) {
        deviceOrder = normalizeDeviceOrder(msg.deviceOrder);
      }
      if (typeof msg.follow === "boolean") followEnabled = msg.follow;
      if (typeof msg.autoFill === "boolean") autoFillBars = msg.autoFill;
      if (typeof msg.patternControlLatch === "boolean") patternControlLatch = msg.patternControlLatch;
      if (typeof msg.gateLedBoost === "boolean") {
        gateLedBoost = msg.gateLedBoost;
        applyGateLedBoostUI();
      }
      if (msg.clockSource) clockSource = msg.clockSource;
      if (typeof msg.clockOut === "boolean") clockOutEnabled = msg.clockOut;
      if (msg.clockOutDevice) clockOutPortId = msg.clockOutDevice;
      if (msg.ledLevels) ledLevels = { ...ledLevels, ...msg.ledLevels };
      if (msg.clockInput) clockInputId = msg.clockInput;
      if (clockSource === "internal" && running) {
        internalTickPeriodSec = 60 / (tempo * PPQN_EXT);
        internalStartTimeSec = getNowSec() - transportTickExt * internalTickPeriodSec;
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
      if (typeof msg.currentPage === "number") {
        serverCurrentPage = msg.currentPage;
        if (Array.isArray(msg.noteViewPitches)) noteViewPitches[serverCurrentPage] = msg.noteViewPitches;
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
      if (typeof msg.gridConnected === "boolean" || typeof msg.fullScaleMode === "boolean" || typeof msg.showMonomeControls === "boolean") {
        const nextConnected = typeof msg.gridConnected === "boolean" ? msg.gridConnected : gridConnected;
        handleGridStatus(nextConnected, msg);
      }
      if (!receivedStateOnce || pendingDirtyReset) {
        setDirty(false);
        pendingDirtyReset = false;
        receivedStateOnce = true;
      }
      if (pendingUndoReset && !applyingUndoRedo) {
        pendingUndoReset = false;
        queueUndoSnapshot({ force: true, replace: true });
      } else if (!undoInitialized) {
        queueUndoSnapshot({ force: true, replace: true });
      }
    } else if (msg.type === "page_change") {
      if (Array.isArray(msg.octaveOverlays)) {
        applyOctaveOverlaysSnapshot(msg.octaveOverlays);
      }
      if (typeof msg.page === "number") {
        serverCurrentPage = msg.page;
      }
      updatePage(msg.page || currentPage, { fromServer: true });
    } else if (msg.type === "isomorphic_mode") {
      const page = Number.isFinite(msg.page) ? msg.page : currentPage;
      if (page >= 1 && page <= 8) {
        isomorphicModes[page] = !!msg.enabled;
        if (page === currentPage) renderNoteScrollbar();
      }
    } else if (msg.type === "isomorphic_layout") {
      if (msg.layout) {
        isomorphicLayout = sanitizeIsomorphicLayout(msg.layout);
        applyIsomorphicLayoutUI();
      }
    } else if (msg.type === "grid_status") {
      handleGridStatus(!!msg.connected, msg);
    } else if (msg.type === "tempo") {
      tempo = msg.bpm || tempo;
      updateTempo(tempo, { broadcast: false });
      applySeqTypeUI();
    } else if (msg.type === "swing") {
      swing = msg.swing || swing;
      updateSwing(swing, { broadcast: false });
    } else if (msg.type === "octave_overlay") {
      handleOctaveOverlayMessage(msg);
    } else if (msg.type === "micro_overlay") {
      handleMicroOverlayMessage(msg);
    } else if (msg.type === "accent_overlay") {
      handleAccentOverlayMessage(msg);
    } else if (msg.type === "slide_overlay") {
      handleSlideOverlayMessage(msg);
    } else if (msg.type === "step_state") {
      handleStepStateMessage(msg);
    } else if (msg.type === "steps_state") {
      handleStepsStateMessage(msg);
    } else if (msg.type === "move_steps_result") {
      handleMoveStepsResult(msg);
    } else if (msg.type === "transpose") {
      if (typeof msg.page === "number") transposes[msg.page] = msg.transpose;
      applyPageTranspose();
    } else if (msg.type === "note_view_offset") {
      if (typeof msg.page === "number") {
        const next = Math.max(NOTE_VIEW_ROW_SHIFT_MIN, Math.min(NOTE_VIEW_ROW_SHIFT_MAX, Math.round(Number(msg.offset) || 0)));
        noteViewOffsets[msg.page] = next;
        if (msg.page === currentPage) applyScaleNotesUI();
      }
    } else if (msg.type === "note_view_pitches") {
      if (msg.page >= 1 && msg.page <= 8 && Array.isArray(msg.pitches)) {
        noteViewPitches[msg.page] = msg.pitches;
        if (msg.page === currentPage) renderNoteScrollbar();
      }
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
        const incoming = msg.color || getDefaultDeviceColorForPage(msg.page);
        const defaultForPage = getDefaultDeviceColorForPage(msg.page);
        if (multiColorDefault && !deviceColorOverrides[msg.page] && incoming.toLowerCase() !== defaultForPage.toLowerCase()) {
          return;
        }
        deviceColors[msg.page] = incoming;
        const isDefault = incoming.toLowerCase() === defaultForPage.toLowerCase();
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
      if (typeof status.running === "boolean" && status.running !== running) setRunningState(status.running);
      const clockChanged = (status.clockSource && status.clockSource !== clockSource)
        || (status.clockInput && status.clockInput !== clockInputId);
      if (status.clockSource) clockSource = status.clockSource;
      if (status.clockInput) clockInputId = status.clockInput;
      if (Number.isFinite(status.tick)) setTransportTickExt(status.tick);
      if (clockChanged) applyClockSourceUI();
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
            microControls.style.display = "none";
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
        renderDeviceTabProgressFrame();
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
        renderDeviceTabProgressFrame();
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
      if (Array.isArray(msg.octaveOverlays)) {
        applyOctaveOverlaysSnapshot(msg.octaveOverlays);
        if (msg.page === currentPage) renderFrame(frames[currentPage]);
      }
    } else if (msg.type === "pattern_control") {
      const wasActive = patternControlActive;
      patternControlActive = !!msg.enabled;
      if (patternControlActive) {
        if (!wasActive) lastFocusedDevice = currentPage;
        activeUiPage = 0;
        selectedDevicePage = 0;
        pendingLauncherExitPage = null;
      } else {
        const nextPage = pendingLauncherExitPage || lastFocusedDevice || currentPage;
        pendingLauncherExitPage = null;
        activeUiPage = nextPage;
        selectedDevicePage = nextPage;
        updatePage(nextPage, { fromServer: false });
      }
      applyPatternLauncherTypeUI();
      renderTabs();
      renderDeviceTabProgressFrame();
      if (msg.enabled) {
        clearNumericOverlays(currentPage);
        resetOctaveOverlayUI();
        renderFrame(frames[currentPage]);
      } else if (Array.isArray(msg.octaveOverlays)) {
        applyOctaveOverlaysSnapshot(msg.octaveOverlays);
        renderFrame(frames[currentPage]);
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
      const targetName = ensureSetFilename(pendingExportFilename || "Untitled.studiogrid");
      downloadJSON(payload, targetName);
      currentSetFilename = targetName;
      setName = displaySetName(targetName || setName);
      updateSetTitle(setName);
      pendingExportFilename = null;
      currentSetFileHandle = null;
      setDirty(false);
    } else if (msg.type === "export_td3") {
      if (msg.data) {
        downloadBase64Binary(msg.data, "sgrid_td3_pattern.seq");
        log("TD-3 export ready");
      } else {
        log("TD-3 export failed: no data");
      }
    } else if (msg.type === "td3_export_sysex") {
      if (!pendingTd3SysexExport?.output) {
        log("TD-3 SysEx export ignored (no output)");
        return;
      }
      if (msg.data) {
        const bytes = Uint8Array.from(atob(msg.data), (c) => c.charCodeAt(0));
        sendSysex(pendingTd3SysexExport.output, bytes);
        log("TD-3 SysEx sent");
        showToast("TD-3 pattern sent");
      } else {
        log("TD-3 SysEx export failed: no data");
        showToast("TD-3 SysEx export failed");
      }
      pendingTd3SysexExport = null;
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
    } else if (msg.type === "live_note") {
      if (Number.isFinite(msg.note)) {
        sendLiveMidiNote(msg.page || currentPage, msg.note, 96, !!msg.on);
      }
    } else if (msg.type === "base_division") {
      baseDivision = msg.division || baseDivision;
      applyBaseNoteLenUI();
    } else if (msg.type === "gate_length") {
      if (typeof msg.length === "number") {
        gateLength = normalizeGateLength(msg.length);
        applyGateLengthUI();
      }
    } else if (msg.type === "gate_led_boost") {
      if (typeof msg.enabled === "boolean") {
        gateLedBoost = msg.enabled;
        applyGateLedBoostUI();
      }
    }
  };
}

async function initMIDI() {
  try {
    midiAccess = await requestMidiAccessSysex();
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
  const preferredOutName = "None"; // default midi outport name preference
  const outs = [];
  const ins = [];
  midiAccess?.outputs.forEach((out) => {
    const opt = new Option(out.name, out.id);
    midiSel.append(opt);
    if (clockOutPortSel) {
      clockOutPortSel.append(new Option(out.name, out.id));
    }
    if (!firstOut) firstOut = out;
    if (!preferredOut && out.name.includes(preferredOutName)) preferredOut = out;
    outs.push(out.name);
  });
  midiAccess?.inputs.forEach((input) => {
    ins.push({ id: input.id, name: input.name });
  });
  clockInputs = ins;
  const resolvedClockInputId = resolveClockInputId(clockInputId);
  if (resolvedClockInputId) clockInputId = resolvedClockInputId;
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
  internalTickPeriodSec = 60 / (tempo * PPQN_EXT);
  internalStartTimeSec = getNowSec();
  internalNextTick = 0;
  setTransportTickExt(0);
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
  setTransportTickExt(0);
  scheduler?.clear();
  ws?.readyState === WebSocket.OPEN &&
    ws.send(JSON.stringify({ type: "transport", action: "stop" }));
  if (clockOutEnabled) sendMidiClockTransport("stop");
  panicAll();
}

function setRunningState(isRunning) {
  running = !!isRunning;
  const transportBtn = document.getElementById("transport-toggle");
  if (transportBtn) {
    const icon = transportBtn.querySelector("i");
    transportBtn.title = running ? "Stop" : "Play";
    transportBtn.setAttribute("aria-pressed", running);
    transportBtn.setAttribute("aria-label", running ? "Stop" : "Play");
    transportBtn.classList.toggle("active", running);
    if (icon) icon.className = running ? "iconoir-pause" : "iconoir-play";
  }
  if (running) {
    startDeviceTabProgressLoop();
  } else {
    stopDeviceTabProgressLoop();
    renderDeviceTabProgressFrame();
  }
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

function extToIntTick(tExt) {
  return tExt * INT_MULT;
}

function intToExtTick(tInt) {
  return tInt / INT_MULT;
}

function setTransportTickExt(tickExt) {
  transportTickExt = tickExt;
  if (tickExt % PPQN_EXT === 0) {
    flashPlayingBar();
  }
}

function flashPlayingBar() {
  const btn = document.querySelector(".bar-row .bar-btn.playing");
  if (!btn) return;
  btn.classList.remove("flash");
  // restart animation by forcing reflow
  void btn.offsetWidth;
  btn.classList.add("flash");
  if (barFlashTimer) clearTimeout(barFlashTimer);
  barFlashTimer = setTimeout(() => {
    btn.classList.remove("flash");
  }, 120);
}

function resolveTickTime(tickInt) {
  if (clockSource === "internal" && internalTickPeriodSec > 0) {
    return internalStartTimeSec + (tickInt / INT_MULT) * internalTickPeriodSec;
  }
  const tickExt = intToExtTick(tickInt);
  const baseTickExt = Math.floor(tickExt);
  const baseTime = externalTickTimes.get(baseTickExt);
  const extIntervalMs = Number.isFinite(externalIntervalEstMs) ? externalIntervalEstMs : null;
  const extTickPeriodSec = extIntervalMs
    ? (extIntervalMs / 1000)
    : (tempo > 0 ? 60 / (tempo * PPQN_EXT) : null);
  if (Number.isFinite(baseTime) && Number.isFinite(extTickPeriodSec)) {
    return baseTime + (tickExt - baseTickExt) * extTickPeriodSec;
  }
  if (clockSource === "external" && Number.isFinite(extTickPeriodSec)) {
    if (Number.isFinite(externalPredictedTickMs) && audioTimeOriginMs) {
      const lastTickSec = (externalPredictedTickMs - audioTimeOriginMs) / 1000;
      return lastTickSec + (tickExt - transportTickExt) * extTickPeriodSec;
    }
  }
  return baseTime;
}

function getNowSec() {
  if (!audioTimeOriginMs) audioTimeOriginMs = performance.now();
  return (performance.now() - audioTimeOriginMs) / 1000;
}

function makeStats() {
  return { count: 0, mean: 0, m2: 0, min: Infinity, max: -Infinity };
}

function updateStats(stats, value) {
  if (!stats || !Number.isFinite(value)) return;
  stats.count += 1;
  const delta = value - stats.mean;
  stats.mean += delta / stats.count;
  stats.m2 += delta * (value - stats.mean);
  stats.min = Math.min(stats.min, value);
  stats.max = Math.max(stats.max, value);
}

function summarizeStats(stats) {
  if (!stats || !stats.count) return "n=0";
  const variance = stats.count > 1 ? (stats.m2 / (stats.count - 1)) : 0;
  const std = Math.sqrt(variance);
  return `n=${stats.count} mean=${stats.mean.toFixed(3)}ms min=${stats.min.toFixed(3)}ms max=${stats.max.toFixed(3)}ms std=${std.toFixed(3)}ms`;
}

function resetStats(stats) {
  if (!stats) return;
  stats.count = 0;
  stats.mean = 0;
  stats.m2 = 0;
  stats.min = Infinity;
  stats.max = -Infinity;
}

function maybeReportClockDebug(nowMs) {
  if (!clockDebug || !Number.isFinite(nowMs)) return;
  if (!clockDebug.lastReportMs) clockDebug.lastReportMs = nowMs;
  if (nowMs - clockDebug.lastReportMs < CLOCK_DEBUG_REPORT_MS) return;
  clockDebug.lastReportMs = nowMs;
  console.log(
    "[clock-debug]",
    "extObs:", summarizeStats(clockDebug.extObs),
    "extEst:", summarizeStats(clockDebug.extEst),
    "leadClock:", summarizeStats(clockDebug.leadClock),
    "leadNote:", summarizeStats(clockDebug.leadNote)
  );
  resetStats(clockDebug.extObs);
  resetStats(clockDebug.extEst);
  resetStats(clockDebug.leadClock);
  resetStats(clockDebug.leadNote);
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
  setTransportTickExt(tick);
  if (tick % TICKS_PER_STEP_EXT === 0) {
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

function noteEventKey(out, channel, note) {
  return `${noteKey(out, channel)}:${note}`;
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
  const nowPerf = performance.now();
  let targetPerf = audioTimeToPerfMs(targetTimeSec);
  if (evt.type === "note_on") {
    const key = noteEventKey(out, channel, evt.note);
    const lastOff = lastScheduledNoteOff.get(key);
    if (Number.isFinite(lastOff) && targetPerf <= lastOff + 0.5) {
      targetPerf = lastOff + 1;
    }
  }
  const ts = Math.max(targetPerf, nowPerf);
  if (evt.type === "note_on") {
    const status = 0x90 + (channel - 1);
    const vel = Math.max(0, Math.min(127, Math.round(evt.velocity || 0)));
    sendMIDISafe(out, [status, evt.note, vel], ts);
    trackNoteOn(out, channel, evt.note);
  } else if (evt.type === "note_off") {
    const status = 0x80 + (channel - 1);
    sendMIDISafe(out, [status, evt.note, 0], ts);
    const key = noteEventKey(out, channel, evt.note);
    lastScheduledNoteOff.set(key, ts);
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
  let sendTime = ts;
  if (Number.isFinite(sendTime)) {
    const now = performance.now();
    if (sendTime < now) sendTime = now;
    if (MIDI_LOG && (status === 0x80 || status === 0x90)) {
      const note = bytes[1];
      const vel = bytes[2] ?? 0;
      const kind = (status === 0x80 || vel === 0) ? "note_off" : "note_on";
      const payload = {
        kind,
        note,
        velocity: vel,
        targetTs: Number.isFinite(ts) ? Number(ts.toFixed(3)) : "n/a",
        sendTs: Number.isFinite(sendTime) ? Number(sendTime.toFixed(3)) : "n/a",
        nowTs: Number(now.toFixed(3)),
        leadMs: Number.isFinite(sendTime) ? Number((sendTime - now).toFixed(3)) : "n/a"
      };
      console.log("[midi-log]", payload);
      ws?.readyState === WebSocket.OPEN &&
        ws.send(JSON.stringify({ type: "midi_log", data: payload }));
    } else if (MIDI_LOG) {
      console.log("[midi-log]", { kind: "non_note", status: bytes[0], nowTs: Number(now.toFixed(3)) });
    }
    if (clockDebug) {
      const lead = sendTime - now;
      if (bytes[0] === 0xf8) {
        updateStats(clockDebug.leadClock, lead);
      } else if (status === 0x80 || status === 0x90 || status === 0xb0) {
        updateStats(clockDebug.leadNote, lead);
      }
      maybeReportClockDebug(now);
    }
  }
  out.send(bytes, sendTime);
}

function sendLiveMidiNote(page, note, velocity, isOn) {
  const out = getMidiOutForPage(page);
  if (!out) return;
  const channel = getMidiChannelForPage(page);
  const status = (isOn ? 0x90 : 0x80) + (channel - 1);
  const vel = isOn ? Math.max(0, Math.min(127, Math.round(velocity || 96))) : 0;
  sendMIDISafe(out, [status, Math.max(0, Math.min(127, Math.round(note || 0))), vel], performance.now());
  if (isOn) {
    trackNoteOn(out, channel, note);
  } else {
    trackNoteOff(out, channel, note);
  }
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
  const safeFrame = Array.isArray(frame) ? frame : new Array(WIDTH * HEIGHT).fill(0);
  const displayFrame = safeFrame.slice();
  const patIdx = activePatterns[currentPage] || 1;
  const len = (patternLengths[currentPage] && patternLengths[currentPage][patIdx]) || 16;
  const bars = Math.max(1, Math.ceil(len / 16));
  const bar = (barViews[currentPage] && barViews[currentPage][patIdx]) || 0;
  const rem = len % 16;
  const lastBar = Math.max(0, bars - 1);
  if (rem > 0 && bar === lastBar) {
    const dimLevel = Math.max(1, clampLedLevel((ledLevels.pattern_inactive || 4) * 0.5));
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
    ctx.fillStyle = getLedColor(level);
    if (typeof ctx.roundRect === "function") {
      ctx.beginPath();
      ctx.roundRect(px, py, CELL_SIZE, CELL_SIZE, 2);
      ctx.fill();
    } else {
      ctx.fillRect(px, py, CELL_SIZE, CELL_SIZE);
    }
  });

  const selection = selectionByPage[currentPage];
  const surfaceColor = resolveCssColorVar("--surface") || resolveCssColorVar("--panel-strong") || resolveCssColorVar("--bg");
  const fgColor = resolveCssColorVar("--fg") || "#fff";
  const strokeBase = mixColors(fgColor, surfaceColor, 0.7);
  const selectionStroke = colorWithAlpha(strokeBase, 0.75);
  const selectionFill = colorWithAlpha(strokeBase, 0.3);
  if (selection && selection.size) {
    ctx.save();
    ctx.strokeStyle = selectionStroke;
    ctx.lineWidth = 2;
    ctx.fillStyle = selectionFill;
    const offset = selectionRenderOffset || { dx: 0, dy: 0 };
    selection.forEach((key) => {
      const { x, y } = parseCellKey(key);
      const useWrap = !!selectionRenderOffset;
      const drawX = useWrap ? wrapIndex(x + (offset.dx || 0), WIDTH) : x;
      const drawY = useWrap ? wrapIndex(y + (offset.dy || 0), getEffectiveStepRows()) : y;
      if (drawX < 0 || drawX >= WIDTH || drawY < 0 || drawY >= HEIGHT) return;
      const px = drawX * (CELL_SIZE + CELL_GAP) + 1;
      const py = drawY * (CELL_SIZE + CELL_GAP) + 1;
      if (typeof ctx.roundRect === "function") {
        ctx.beginPath();
        ctx.roundRect(px, py, CELL_SIZE - 2, CELL_SIZE - 2, 2);
        ctx.fill();
        ctx.stroke();
      } else {
        ctx.fillRect(px, py, CELL_SIZE - 2, CELL_SIZE - 2);
        ctx.strokeRect(px, py, CELL_SIZE - 2, CELL_SIZE - 2);
      }
    });
    ctx.restore();
  }

  if (selectionBoxPreviewCells && selectionBoxPreviewCells.size) {
    ctx.save();
    ctx.fillStyle = selectionFill;
    selectionBoxPreviewCells.forEach((key) => {
      const { x, y } = parseCellKey(key);
      if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
      const px = x * (CELL_SIZE + CELL_GAP) + 1;
      const py = y * (CELL_SIZE + CELL_GAP) + 1;
      if (typeof ctx.roundRect === "function") {
        ctx.beginPath();
        ctx.roundRect(px, py, CELL_SIZE - 2, CELL_SIZE - 2, 2);
        ctx.fill();
      } else {
        ctx.fillRect(px, py, CELL_SIZE - 2, CELL_SIZE - 2);
      }
    });
    ctx.restore();
  }

  // overlays
  const now = Date.now();
  const currentOverlays = overlays[currentPage] || [];
  const octaveEnabled = ENABLE_OCTAVE_SHIFTING;
  // keep numeric octave overlays persistent only when octave shifting is enabled; micro overlays expire
  const filtered = currentOverlays.filter((o) => {
    const isNumeric = /^[-+]?\d/.test(o.text);
    const isOctaveOverlay = o.kind === "octave";
    const drawY = getOverlayDrawY(o);
    if (drawY < 0 || drawY >= HEIGHT) return false;
    if (!octaveEnabled && (isOctaveOverlay || (isNumeric && o.kind !== "micro"))) return false;
    if (Number.isFinite(o.expiresAt) && now > o.expiresAt) return false;
    const level = displayFrame[drawY * WIDTH + o.x] || 0;
    if (o.kind === "micro") return true;
    if (!isNumeric && level <= 0) return false;
    if (isNumeric) return octaveEnabled;
    return (now - (o.ts || now)) < 1500;
  });
  overlays[currentPage] = filtered;
  const combinedOverlays = new Map();
  const singleOverlays = [];
  overlays[currentPage].forEach((o) => {
    const drawY = getOverlayDrawY(o);
    const isNumeric = octaveEnabled && /^[-+]?\d/.test(o.text);
    const isMicro = o.kind === "micro";
    if (isMicro || isNumeric) {
      const key = `${o.x}:${drawY}`;
      const entry = combinedOverlays.get(key) || {
        x: o.x,
        microText: null,
        octaveText: null,
        microDrawY: null,
        octaveDrawY: null
      };
      if (isMicro) {
        entry.microText = o.text;
        entry.microDrawY = drawY;
      } else {
        entry.octaveText = o.text;
        entry.octaveDrawY = drawY;
      }
      combinedOverlays.set(key, entry);
      return;
    }
    singleOverlays.push({ x: o.x, drawY, text: o.text, useSurface: false });
  });
  const overlayRenderList = [];
  combinedOverlays.forEach((entry) => {
    const microText = entry.microText;
    const octaveText = entry.octaveText;
    const microVal = Number(microText ?? 0);
    const octaveVal = Number(octaveText ?? 0);
    if (!octaveEnabled) {
      if (microText == null || microVal === 0) return;
      const drawY = entry.microDrawY;
      if (!Number.isFinite(drawY)) return;
      overlayRenderList.push({ x: entry.x, drawY, text: microText, useSurface: true });
      return;
    }
    if (microVal === 0 && octaveVal === 0) return;
    const text = microVal && octaveVal ? `${microText} | ${octaveText}` : (microVal ? microText : octaveText);
    const drawY = Number.isFinite(entry.octaveDrawY) ? entry.octaveDrawY : entry.microDrawY;
    if (!Number.isFinite(drawY)) return;
    overlayRenderList.push({ x: entry.x, drawY, text, useSurface: true });
  });
  overlayRenderList.push(...singleOverlays);
  overlayRenderList.forEach((o) => {
    ctx.save();
    const px = o.x * (CELL_SIZE + CELL_GAP);
    const py = o.drawY * (CELL_SIZE + CELL_GAP);
    ctx.translate(px, py);
    ctx.fillStyle = o.useSurface
      ? (getCssVar("--surface") || getCssVar("--label"))
      : (getCssVar("--label") || getCssVar("--muted"));
    ctx.font = LABEL_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(o.text, CELL_SIZE / 2, CELL_SIZE / 2);
    ctx.restore();
  });
}

function renderFrameIfReady() {
  if (!frameReady[currentPage] || suppressFrameUntilNext[currentPage]) return;
  renderFrame(frames[currentPage]);
}

function setFrame(frame, x, y, level) {
  frame[y * WIDTH + x] = level;
}

function parseColorToRgb(color) {
  if (!color || typeof color !== "string") return null;
  const raw = color.trim();
  if (raw.startsWith("#")) {
    const hex = raw.length === 4
      ? `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`
      : raw;
    const int = parseInt(hex.slice(1), 16);
    if (Number.isNaN(int)) return null;
    return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
  }
  if (raw.startsWith("rgb")) {
    const parts = raw.replace(/rgba?\(|\)/g, "").split(",").map((v) => Number(v.trim()));
    const [r, g, b] = parts;
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
      return { r, g, b };
    }
  }
  return null;
}

function srgbToLin(c) {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function getRelativeLuminance(rgb) {
  if (!rgb) return 0;
  const r = srgbToLin(rgb.r);
  const g = srgbToLin(rgb.g);
  const b = srgbToLin(rgb.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function getContrastRatio(colorA, colorB) {
  const rgbA = parseColorToRgb(colorA);
  const rgbB = parseColorToRgb(colorB);
  if (!rgbA || !rgbB) return 0;
  const lumA = getRelativeLuminance(rgbA);
  const lumB = getRelativeLuminance(rgbB);
  const lighter = Math.max(lumA, lumB);
  const darker = Math.min(lumA, lumB);
  return (lighter + 0.05) / (darker + 0.05);
}

function colorWithAlpha(color, alpha) {
  const base = color || resolveCssColorVar("--bg");
  const rgb = parseColorToRgb(base);
  if (!rgb) return base || "transparent";
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

function mixColors(colorA, colorB, weightA = 0.5) {
  const rgbA = parseColorToRgb(colorA);
  const rgbB = parseColorToRgb(colorB);
  if (!rgbA || !rgbB) return colorA || colorB || "transparent";
  const w = Math.max(0, Math.min(1, weightA));
  const r = Math.round(rgbA.r * w + rgbB.r * (1 - w));
  const g = Math.round(rgbA.g * w + rgbB.g * (1 - w));
  const b = Math.round(rgbA.b * w + rgbB.b * (1 - w));
  return `rgb(${r}, ${g}, ${b})`;
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
  tempoLabelTop.onclick = (event) => {
    if (!clockSourceTopWrap) return;
    event.preventDefault();
    event.stopPropagation();
    const isHidden = clockSourceTopWrap.classList.contains("hidden");
    clockSourceTopWrap.classList.toggle("hidden", !isHidden);
    if (isHidden && clockSourceTopSel) clockSourceTopSel.focus();
  };
}

if (settingsTempoInput) {
  const commitSettingsTempo = () => {
    updateTempo(settingsTempoInput.value);
  };
  const nudgeSettingsTempo = (delta) => {
    const cur = Number(settingsTempoInput.value);
    const safe = Number.isFinite(cur) ? Math.round(cur + delta) : Math.round(tempo);
    settingsTempoInput.value = safe;
    commitSettingsTempo();
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
  swingLabelTop.onclick = null;
}
const transportToggle = document.getElementById("transport-toggle");
if (transportToggle) {
  transportToggle.onclick = toggleTransport;
  setRunningState(running);
}

document.addEventListener("click", (event) => {
  if (!clockSourceTopWrap || clockSourceTopWrap.classList.contains("hidden")) return;
  if (clockSourceTopWrap.contains(event.target) || tempoLabelTop?.contains(event.target)) {
    return;
  }
  clockSourceTopWrap.classList.add("hidden");
});

function handleClockSourceChange(prev, next) {
  if (prev === next) return;
  if (prev === "internal") stopInternalClockLoop();
  if (running) {
    ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "transport", action: "stop" }));
    setRunningState(false);
    if (clockOutEnabled) sendMidiClockTransport("stop");
  }
  setTransportTickExt(0);
  externalTick = 0;
  externalTickTimes = new Map();
  lastExternalTickMs = null;
  externalIntervalEstMs = null;
  externalPredictedTickMs = null;
  externalWarmupTicks = 0;
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

function updateClockSource(next) {
  const prev = clockSource;
  if (prev === next) return;
  clockSource = next;
  handleClockSourceChange(prev, next);
  sendClockSourceIfChanged(next);
  if (prev === "external" && next === "internal") {
    lockTempoPrecision({ broadcast: true });
  }
  applyClockSourceUI();
  if (clockSource === "external" && clockInputSel && clockInputSel.value) {
    const resolved = resolveClockInputId(clockInputSel.value);
    if (resolved) {
      clockInputId = resolved;
      sendClockInputIfChanged(clockInputId);
      attachClockInput(clockInputId);
    }
  }
  if (clockSource !== "external") {
    externalArmed = false;
    ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_external_arm", enabled: false }));
  }
}

if (clockToggleBtn) {
  clockToggleBtn.onclick = () => {
    const next = clockSource === "external" ? "internal" : "external";
    updateClockSource(next);
  };
}
if (clockSourceSel) {
  clockSourceSel.onchange = () => {
    updateClockSource(clockSourceSel.value);
  };
}
if (clockSourceTopSel) {
  clockSourceTopSel.onchange = () => {
    updateClockSource(clockSourceTopSel.value);
    if (clockSourceTopWrap) clockSourceTopWrap.classList.add("hidden");
  };
}

if (clockInputSel) {
  clockInputSel.onchange = () => {
    const next = resolveClockInputId(clockInputSel.value);
    if (!next || next === clockInputId) return;
    clockInputId = next;
    sendClockInputIfChanged(clockInputId);
    if (clockSource === "external") attachClockInput(clockInputId);
  };
}

function applyClockSourceUI() {
  if (clockSourceSel) clockSourceSel.value = clockSource || "internal";
  if (clockSourceTopSel) clockSourceTopSel.value = clockSource || "internal";
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
    if (clockSource === "external") {
      tempoInput.tabIndex = -1;
    } else {
      tempoInput.removeAttribute("tabindex");
    }
  }
  const tempoStepperWrap = tempoInput?.closest(".number-wrap");
  if (tempoStepperWrap) {
    tempoStepperWrap.dataset.stepperHidden = "false";
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
  const resolvedClockInputId = resolveClockInputId(clockInputId);
  if (resolvedClockInputId) clockInputId = resolvedClockInputId;
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
  externalIntervalEstMs = null;
  externalPredictedTickMs = null;
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
    externalIntervalEstMs = null;
    externalPredictedTickMs = null;
    externalWarmupTicks = 0;
    lastSentExternalTick = -1;
    externalStartSent = true;
    autoStartPending = false;
    autoStartFirstMs = 0;
    autoStartTicks = 0;
    autoStartPending = false;
    autoStartFirstMs = 0;
    autoStartTicks = 0;
    setTransportTickExt(0);
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
    externalIntervalEstMs = null;
    externalPredictedTickMs = null;
    externalWarmupTicks = 0;
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
      ws.send(JSON.stringify({ type: "transport", action: "continue", tick: transportTickExt }));
    if (clockOutEnabled) sendMidiClockTransport("start");
    log(`MIDI Continue from ${midiClockIn?.name || "clock in"}`);
    return;
  }
  if (status === 0xf2) {
    const spp = ((data2 || 0) << 7) | (data1 || 0);
    const tick = spp * TICKS_PER_STEP_EXT;
    setTransportTickExt(tick);
    externalTick = tick;
    lastSentExternalTick = tick - 1;
    externalPredictedTickMs = null;
    externalWarmupTicks = 0;
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
  const intervalObsMs = lastExternalTickMs ? (nowMs - lastExternalTickMs) : null;
  lastExternalTickMs = nowMs;
  if (Number.isFinite(intervalObsMs) && intervalObsMs > 0) {
    if (externalWarmupTicks < EXT_CLOCK_WARMUP_TICKS) {
      externalIntervalEstMs = intervalObsMs;
      externalWarmupTicks += 1;
    } else if (!Number.isFinite(externalIntervalEstMs)) {
      externalIntervalEstMs = intervalObsMs;
    } else {
      const maxDev = externalIntervalEstMs * EXT_CLOCK_OUTLIER_FRAC;
      const clampedObs = Math.min(externalIntervalEstMs + maxDev, Math.max(externalIntervalEstMs - maxDev, intervalObsMs));
      externalIntervalEstMs = externalIntervalEstMs + EXT_CLOCK_ALPHA * (clampedObs - externalIntervalEstMs);
    }
  }
  let predictedMs = externalPredictedTickMs;
  if (!Number.isFinite(predictedMs)) {
    predictedMs = nowMs;
  } else if (Number.isFinite(externalIntervalEstMs)) {
    predictedMs += externalIntervalEstMs;
  } else if (Number.isFinite(intervalObsMs)) {
    predictedMs += intervalObsMs;
  } else {
    predictedMs = nowMs;
  }
  const phaseError = nowMs - predictedMs;
  if (Number.isFinite(phaseError)) {
    predictedMs += phaseError * EXT_CLOCK_PHASE_ALPHA;
  }
  externalPredictedTickMs = predictedMs;
  const nowSecObserved = (nowMs - audioTimeOriginMs) / 1000;
  const intervalMs = (externalWarmupTicks && externalWarmupTicks <= EXT_CLOCK_WARMUP_TICKS)
    ? intervalObsMs
    : (Number.isFinite(externalIntervalEstMs) ? externalIntervalEstMs : intervalObsMs);
  if (clockDebug) {
    updateStats(clockDebug.extObs, intervalObsMs);
    updateStats(clockDebug.extEst, externalIntervalEstMs);
    maybeReportClockDebug(nowMs);
  }

  setTransportTickExt(externalTick);
  if (externalTick <= lastSentExternalTick) {
    externalTick += 1;
    return;
  }
  // Anchor tick times to observed clock to avoid cumulative drift in note gating.
  externalTickTimes.set(externalTick, nowSecObserved);
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
      const ready = elapsed >= 120 || autoStartTicks >= TICKS_PER_STEP_EXT;
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

  // Send smoothed timing to avoid per-tick jitter feeding back into the server clock model.
  ws?.readyState === WebSocket.OPEN &&
    ws.send(JSON.stringify({
      type: "clockTicks",
      ticks: [{ tick: externalTick, intervalMs }]
    }));

  if (clockOutEnabled) sendMidiClockPulse(nowMs);
  lastSentExternalTick = externalTick;
  externalTick += 1;

  if (Number.isFinite(intervalMs)) {
    const bpmEstimate = 60000 / (intervalMs * PPQN_EXT);
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
  const hasNamedSet = currentSetFilename
    && displaySetName(currentSetFilename).toLowerCase() !== "untitled";
  if (hasNamedSet) {
    openSaveSetModal();
    return;
  }
  const suggested = setName && setName.toLowerCase() !== "default" ? setName : "Untitled";
  if (hasElectronSave) {
    openSaveNameModal(suggested).then((name) => {
      if (!name) return;
      saveSnapshotToElectron(name, { overwrite: false }).catch(() => {
        showToast("Save failed");
        log("Save failed");
      });
    });
    return;
  }
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
  [td3Modal, td3ActionModal, td3ScaleModal, td3ReplaceModal, td3SysexModal]
    .some((modal) => modal && !modal.classList.contains("hidden"));
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

let td3SysexMode = "export";
const openTd3SysexModal = (mode = "export") => {
  td3SysexMode = mode === "import" ? "import" : "export";
  if (td3SysexTitle) td3SysexTitle.textContent = td3SysexMode === "import" ? "Import from TD-3" : "Write to TD-3 ";
  if (td3SysexConfirm) td3SysexConfirm.textContent = td3SysexMode === "import" ? "Read pattern" : "Write pattern";
  if (td3SysexModal) td3SysexModal.classList.remove("hidden");
  showTd3Backdrop();
};
const closeTd3SysexModal = () => {
  if (td3SysexModal) td3SysexModal.classList.add("hidden");
  hideTd3BackdropIfIdle();
};

async function requestMidiAccessSysex() {
  if (midiAccess) return midiAccess;
  midiAccess = await navigator.requestMIDIAccess({ sysex: true });
  refreshMIDIDevices();
  midiAccess.onstatechange = refreshMIDIDevices;
  return midiAccess;
}

function findTd3Ports(access) {
  if (!access) return { input: null, output: null };
  let input = null;
  let output = null;
  access.inputs?.forEach((inp) => {
    if (!input && TD3_NAME_REGEX.test(inp.name || "")) input = inp;
  });
  access.outputs?.forEach((out) => {
    if (!output && TD3_NAME_REGEX.test(out.name || "")) output = out;
  });
  return { input, output };
}

function sendSysex(output, data) {
  if (!output) throw new Error("MIDI output unavailable");
  output.send(data);
}

function buildTd3SysexRequestPattern(group, slot) {
  return new Uint8Array([0xf0, 0x00, 0x20, 0x32, 0x00, 0x01, 0x0a, 0x77, group & 0x7f, slot & 0x7f, 0xf7]);
}

function td3DestToAddress({ groupUI, bank, patternUI } = {}) {
  const groupSafe = Math.max(0, Math.min(3, Math.round(groupUI || 1) - 1));
  const bankSafe = bank === "B" ? "B" : "A";
  const patternSafe = Math.max(1, Math.min(8, Math.round(patternUI || 1)));
  const slot = (bankSafe === "B" ? 8 : 0) + (patternSafe - 1);
  return { group: groupSafe, slot };
}

function resolveTd3Ports(access) {
  const found = findTd3Ports(access);
  const selectedOut = midiOut && TD3_NAME_REGEX.test(midiOut.name || "") ? midiOut : null;
  return { input: found.input, output: selectedOut || found.output };
}

function requestTd3Pattern({ input, output }, { group, slot }, { timeoutMs = 3500 } = {}) {
  return new Promise((resolve, reject) => {
    if (!input || !output) {
      reject(new Error("TD-3 MIDI ports unavailable"));
      return;
    }
    let timeoutId = null;
    let fallbackResponse = null;
    const handler = (evt) => {
      const data = evt?.data ? new Uint8Array(evt.data) : null;
      if (!data || data.length < 122) return;
      if (data[0] !== 0xf0 || data[7] !== 0x78 || data[data.length - 1] !== 0xf7) return;
      if (data[1] !== 0x00 || data[2] !== 0x20 || data[3] !== 0x32 || data[4] !== 0x00 || data[5] !== 0x01 || data[6] !== 0x0a) return;
      if (data[8] !== (group & 0x7f) || data[9] !== (slot & 0x7f)) {
        // Some firmware/ports can report an unexpected address; keep the first valid payload as fallback.
        if (!fallbackResponse) fallbackResponse = data;
        return;
      }
      cleanup();
      resolve(data);
    };
    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      input.removeEventListener("midimessage", handler);
    };
    timeoutId = setTimeout(() => {
      if (fallbackResponse) {
        cleanup();
        resolve(fallbackResponse);
        return;
      }
      cleanup();
      reject(new Error("TD-3 SysEx response timeout"));
    }, Math.max(250, timeoutMs));
    input.addEventListener("midimessage", handler);
    sendSysex(output, buildTd3SysexRequestPattern(group, slot));
  });
}

async function importTd3PatternFromSynth(state, midiPorts, {
  groupUI,
  bank,
  patternUI,
  page,
  applyMode,
  timeoutMs
} = {}) {
  const access = midiAccess || await requestMidiAccessSysex();
  const ports = midiPorts || resolveTd3Ports(access);
  const { group, slot } = td3DestToAddress({ groupUI, bank, patternUI });
  const resp = await requestTd3Pattern(ports, { group, slot }, { timeoutMs });
  const payload = resp.slice(12, 122);
  const b64 = btoa(String.fromCharCode(...payload));
  pendingTd3Import = { data: b64, page: page || currentPage, kind: "sysex" };
  if (applyMode === "fit_current" || applyMode === "switch_scale") {
    finalizeTd3Import(applyMode);
    return;
  }
  const hasData = patternHasData(currentPage);
  if (hasData) {
    openTd3ReplaceModal();
    return;
  }
  requestTd3ImportPreview(pendingTd3Import);
}

async function exportTd3PatternToSynth(state, midiPorts, {
  page,
  pattern,
  groupUI,
  bank,
  patternUI
} = {}) {
  const access = midiAccess || await requestMidiAccessSysex();
  const ports = midiPorts || resolveTd3Ports(access);
  const { group, slot } = td3DestToAddress({ groupUI, bank, patternUI });
  if (!ports.output) throw new Error("TD-3 MIDI output unavailable");
  if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("WS not connected");
  pendingTd3SysexExport = { output: ports.output };
  ws.send(JSON.stringify({ type: "td3_export_sysex", group, slot, page, pattern }));
}

async function triggerTd3Export(tdGroup, tdPattern) {
  const safeGroup = Math.max(1, Math.min(16, Math.round(tdGroup || 5)));
  const safePattern = Math.max(1, Math.min(16, Math.round(tdPattern || 8)));
  const params = new URLSearchParams({ group: safeGroup, pattern: safePattern });
  try {
    const resp = await fetch(`/api/export-td3?${params.toString()}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    downloadBlob(blob, "sgrid_td3_pattern.seq");
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

function requestTd3ImportPreview(entry, { silent = false } = {}) {
  if (!entry || !ws || ws.readyState !== WebSocket.OPEN) {
    if (!silent) {
      log("WS not connected; cannot import");
      pendingTd3Import = null;
    }
    return;
  }
  const type = entry.kind === "sysex" ? "td3_import_payload_preview" : "td3_import_preview";
  ws.send(JSON.stringify({ type, data: entry.data, page: entry.page }));
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
      pendingTd3Import = { data: b64, page: currentPage, kind: "seq" };
      const hasData = patternHasData(currentPage);
      if (hasData) {
        openTd3ReplaceModal();
        return;
      }
      requestTd3ImportPreview(pendingTd3Import, { silent: true });
    };
    reader.readAsArrayBuffer(file);
  };
  picker.click();
}

function finalizeTd3Import(mode = "fit_current") {
  if (!pendingTd3Import) return;
  const type = pendingTd3Import.kind === "sysex" ? "td3_import_payload_apply" : "td3_import_apply";
  ws?.readyState === WebSocket.OPEN &&
    ws.send(JSON.stringify({
      type,
      data: pendingTd3Import.data,
      page: pendingTd3Import.page,
      mode,
      octaveApplyMode: TD3_IMPORT_OCTAVE_APPLY_MODE
    }));
  pendingTd3Import = null;
}

if (exportTd3Btn) exportTd3Btn.onclick = openTd3ActionModal;
if (td3ActionClose) td3ActionClose.onclick = closeTd3ActionModal;
if (td3ExportBtn) td3ExportBtn.onclick = () => {
  closeTd3ActionModal();
  triggerTd3Export();
};
if (td3ImportBtn) {
  td3ImportBtn.onclick = () => {
    closeTd3ActionModal();
    launchTd3ImportPicker();
  };
}
if (td3ExportSysexBtn) {
  td3ExportSysexBtn.onclick = () => {
    closeTd3ActionModal();
    openTd3SysexModal("export");
  };
}
if (td3ImportSysexBtn) {
  td3ImportSysexBtn.onclick = () => {
    closeTd3ActionModal();
    openTd3SysexModal("import");
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
if (td3SysexClose) td3SysexClose.onclick = closeTd3SysexModal;
if (td3SysexCancel) td3SysexCancel.onclick = closeTd3SysexModal;
if (td3SysexConfirm) {
  td3SysexConfirm.onclick = async () => {
    const groupUI = Number(td3SysexGroupInput?.value || 1);
    const bank = td3SysexBankSelect?.value || "A";
    const patternUI = Number(td3SysexPatternInput?.value || 1);
    closeTd3SysexModal();
    try {
      if (td3SysexMode === "import") {
        await importTd3PatternFromSynth(null, null, { groupUI, bank, patternUI, page: currentPage });
        log("TD-3 SysEx import requested");
      } else {
        await exportTd3PatternToSynth(null, null, { groupUI, bank, patternUI, page: currentPage });
        log("TD-3 SysEx export requested");
      }
    } catch (e) {
      const msg = String(e?.message || e || "TD-3 SysEx failed");
      log(`TD-3 SysEx failed: ${msg}`);
      showToast(msg);
    }
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
    requestTd3ImportPreview(pendingTd3Import);
    closeTd3ReplaceModal();
  };
}
document.getElementById("import").onclick = () => {
  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = "application/json,.json,.sgridset,.studiogrid";
  picker.onchange = () => {
    const file = picker.files?.[0];
    if (!file) return;
    const fileName = file.name || "Untitled";
    const reader = new FileReader();
    reader.onload = (ev) => {
      const raw = String(ev.target.result || "");
      if (ws?.readyState === WebSocket.OPEN) {
        currentSetFilename = ensureSetFilename(fileName);
        currentSetFileHandle = null;
        ws.send(JSON.stringify({ type: "import_state", snapshot: raw, filename: fileName }));
        log("Import sent to server");
        showToast(`${fileName} loaded`);
      } else {
        log("WS not connected; cannot import");
      }
    };
    reader.readAsText(file);
  };
  picker.click();
};
function normalizeBaseDivision(value) {
  const allowed = [12, 16, 24, 32];
  const fallback = 16;
  let val = Math.round(Number(value) || fallback);
  if (val <= 4) val = val * 4; // migrate old per-beat values (2->8, 4->16)
  if (val === 6) val = 24; // migrate old 6-per-beat
  if (!allowed.includes(val)) val = fallback;
  return val;
}

function normalizeGateLength(value) {
  const allowed = [0.25, 0.5, 0.75, 1];
  let val = Number(value);
  if (!Number.isFinite(val)) return 1;
  if (val > 1.01) val = val / 100;
  val = Math.round(val * 100) / 100;
  return allowed.includes(val) ? val : 1;
}

function sanitizeIsomorphicLayout(layout = {}) {
  const base = Math.max(0, Math.min(127, Math.round(Number(layout.base ?? 24) || 0)));
  const stepX = Math.max(-24, Math.min(24, Math.round(Number(layout.stepX ?? 1) || 0)));
  const stepY = Math.max(-24, Math.min(24, Math.round(Number(layout.stepY ?? 3) || 0)));
  return { base, stepX, stepY };
}

function applyIsomorphicLayoutUI() {
  if (isoBaseInput) isoBaseInput.value = String(isomorphicLayout.base ?? 24);
  if (isoStepXInput) isoStepXInput.value = String(isomorphicLayout.stepX ?? 1);
  if (isoStepYInput) isoStepYInput.value = String(isomorphicLayout.stepY ?? 3);
  if (isoBaseLabel) isoBaseLabel.textContent = formatMidiNote(isomorphicLayout.base ?? 24);
}

function syncSettingsInputs() {
  if (settingsTempoInput) settingsTempoInput.value = formatTempoDisplay(tempo);
  if (uiScaleSel) uiScaleSel.value = String(uiScale || 1);
  if (clockSourceSel) clockSourceSel.value = clockSource || "internal";
  if (clockInputSel && clockInputId) {
    const resolved = resolveClockInputId(clockInputId);
    if (resolved) clockInputId = resolved;
    clockInputSel.value = clockInputId;
  }
  if (clockOutToggle) clockOutToggle.checked = !!clockOutEnabled;
  if (clockOutPortSel && clockOutPortId) clockOutPortSel.value = clockOutPortId;
  if (autoFillToggle) autoFillToggle.checked = !!autoFillBars;
  if (autoLoadToggle) autoLoadToggle.checked = !!autoLoadSet;
  if (patternControlLatchToggle) patternControlLatchToggle.checked = !!patternControlLatch;
  applyMonomeControlsUI();
  applyMonomeRotation(monomeRotation);
  if (gateLedBoostToggle) gateLedBoostToggle.checked = !!gateLedBoost;
  if (mdBaseSweepInput) mdBaseSweepInput.value = mdBaseSweep;
  if (monoSlidePadInput) monoSlidePadInput.value = Math.round((monoSlidePad || 0) * 100);
  if (baseNoteLenSel) applyBaseNoteLenUI();
  if (gateLengthSel) applyGateLengthUI();
  applyIsomorphicLayoutUI();
  Object.entries(ledInputs).forEach(([k, el]) => {
    if (el) el.value = ledLevels[k] ?? 0;
  });
  setToggleActive([tempWarmBtn, tempColdBtn], whiteMode);
  setToggleActive([colorsPastelBtn, colorsSolidBtn], colorMode);
  updateDefaultColorTrigger();
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
    if (changed) sendClockSourceIfChanged(clockSource);
    applyClockSourceUI();
  }

  if (clockInputSel) {
    const next = resolveClockInputId(clockInputSel.value);
    if (next && next !== clockInputId) {
      clockInputId = next;
      sendClockInputIfChanged(clockInputId);
      if (clockSource === "external") attachClockInput(clockInputId);
    }
  }

  if (clockOutToggle) {
    const next = !!clockOutToggle.checked;
    if (clockOutEnabled !== next) {
      clockOutEnabled = next;
      sendClockOutIfChanged(clockOutEnabled);
    }
  }
  if (clockOutPortSel) {
    const next = clockOutPortSel.value || "";
    if (clockOutPortId !== next) {
      clockOutPortId = next;
      sendClockOutDeviceIfChanged(clockOutPortId);
    }
  }
  if (autoFillToggle) {
    const next = !!autoFillToggle.checked;
    if (autoFillBars !== next) {
      autoFillBars = next;
      sendAutoFillIfChanged(autoFillBars);
    }
  }
  if (autoLoadToggle) {
    autoLoadSet = !!autoLoadToggle.checked;
  }
  if (showLogToggle) {
    const show = showLogToggle.checked;
    document.getElementById("log").classList.toggle("hidden", !show);
  }
  if (patternControlLatchToggle) {
    const next = !!patternControlLatchToggle.checked;
    if (patternControlLatch !== next) {
      patternControlLatch = next;
      sendPatternControlLatchIfChanged(patternControlLatch);
    }
  }
  if (showMonomeControlsToggle && !niControllerActive) {
    const next = !!showMonomeControlsToggle.checked;
    if (showMonomeControls !== next) {
      showMonomeControls = next;
      sendMonomeControlsIfChanged(showMonomeControls);
    }
  }
  if (gateLedBoostToggle) {
    const next = !!gateLedBoostToggle.checked;
    if (gateLedBoost !== next) {
      gateLedBoost = next;
      sendGateLedBoostIfChanged(gateLedBoost);
    }
  }
  if (baseNoteLenSel) {
    const val = normalizeBaseDivision(baseNoteLenSel.value || baseDivision || 16);
    if (baseDivision !== val) {
      baseDivision = val;
      baseNoteLenSel.value = String(val);
      sendBaseDivisionIfChanged(baseDivision);
    }
  }
  if (gateLengthSel) {
    const val = normalizeGateLength(gateLengthSel.value || gateLength || 1);
    if (gateLength !== val) {
      gateLength = val;
      gateLengthSel.value = String(Math.round(val * 100));
      sendGateLengthIfChanged(gateLength);
    }
  }

  const ledUpdates = {};
  Object.entries(ledInputs).forEach(([k, el]) => {
    if (!el) return;
    const val = clampLedLevel(el.value);
    if (ledLevels[k] !== val) {
      ledLevels[k] = val;
      ledUpdates[k] = val;
    }
  });
  if (Object.keys(ledUpdates).length) sendLedLevelsIfChanged(ledUpdates);

  if (mdBaseSweepInput) {
    const val = Math.max(20, Math.min(200, Math.round(Number(mdBaseSweepInput.value) || mdBaseSweep)));
    if (mdBaseSweep !== val) {
      mdBaseSweep = val;
      mdBaseSweepInput.value = val;
      sendMdSlideParamsIfChanged(mdSlideSpeed, mdSlideCurve, mdBaseSweep);
    }
  }
  if (monoSlidePadInput) {
    const pct = Math.max(0, Math.min(50, Math.round(Number(monoSlidePadInput.value) || (monoSlidePad * 100))));
    const next = pct / 100;
    if (monoSlidePad !== next) {
      monoSlidePad = next;
      monoSlidePadInput.value = pct;
      sendMonoSlidePadIfChanged(monoSlidePad);
    }
  }
  if (isoBaseInput || isoStepXInput || isoStepYInput) {
    const next = sanitizeIsomorphicLayout({
      base: isoBaseInput ? isoBaseInput.value : isomorphicLayout.base,
      stepX: isoStepXInput ? isoStepXInput.value : isomorphicLayout.stepX,
      stepY: isoStepYInput ? isoStepYInput.value : isomorphicLayout.stepY
    });
    if (next.base !== isomorphicLayout.base || next.stepX !== isomorphicLayout.stepX || next.stepY !== isomorphicLayout.stepY) {
      isomorphicLayout = next;
      applyIsomorphicLayoutUI();
      sendIsomorphicLayoutIfChanged(isomorphicLayout);
    }
  }

  updateDefaultColorTrigger();
}

function setSettingsTab(panelId) {
  settingsActiveTabId = panelId || settingsActiveTabId;
  settingsTabs.forEach((btn) => {
    const active = btn.dataset.tab === settingsActiveTabId;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
  settingsPanels.forEach((panel) => {
    panel.classList.toggle("is-active", panel.id === settingsActiveTabId);
  });
}

  if (settingsBtn && settingsModal && settingsBackdrop) {
    const openSettings = () => {
    settingsOpen = true;
    syncSettingsInputs();
    setSettingsTab(settingsActiveTabId);
    settingsModal.classList.remove("hidden");
    settingsBackdrop.classList.remove("hidden");
  };
  const closeSettings = () => {
    settingsOpen = false;
    updateDefaultColorTrigger();
    settingsModal.classList.add("hidden");
    settingsBackdrop.classList.add("hidden");
  };
  const confirmSettings = () => {
    if (!settingsOpen) return;
    closeSettings();
  };
  if (settingsTabs.length) {
    settingsTabs.forEach((btn) => {
      btn.onclick = () => setSettingsTab(btn.dataset.tab);
    });
  }
  settingsBtn.onclick = openSettings;
  if (settingsClose) settingsClose.onclick = closeSettings;
  settingsBackdrop.onclick = closeSettings;
  if (settingsConfirm) settingsConfirm.onclick = confirmSettings;
  const updatePendingTemp = (mode) => {
    applyWhiteMode(mode);
    if (settingsOpen) syncSettingsInputs();
  };
  const updatePendingColors = (mode) => {
    applyColorMode(mode);
    if (settingsOpen) syncSettingsInputs();
  };
  if (tempWarmBtn) tempWarmBtn.onclick = () => updatePendingTemp("warm");
  if (tempColdBtn) tempColdBtn.onclick = () => updatePendingTemp("cold");
  if (colorsPastelBtn) colorsPastelBtn.onclick = () => updatePendingColors("pastel");
  if (colorsSolidBtn) colorsSolidBtn.onclick = () => updatePendingColors("solid");
  Object.entries(ledInputs).forEach(([k, el]) => {
    if (!el) return;
    el.oninput = () => {
      const val = clampLedLevel(el.value);
      ledLevels[k] = val;
      sendLedLevelsIfChanged({ [k]: val });
    };
  });
  if (showLogToggle) {
    showLogToggle.onchange = () => {
      const show = showLogToggle.checked;
      document.getElementById("log").classList.toggle("hidden", !show);
    };
  }
  if (patternControlLatchToggle) {
    patternControlLatchToggle.onchange = () => {
      patternControlLatch = !!patternControlLatchToggle.checked;
      sendPatternControlLatchIfChanged(patternControlLatch);
    };
  }
  if (showMonomeControlsToggle) {
    showMonomeControlsToggle.onchange = () => {
      if (niControllerActive) return;
      showMonomeControls = !!showMonomeControlsToggle.checked;
      sendMonomeControlsIfChanged(showMonomeControls);
    };
  }
  if (rotateMonomeToggle) {
    rotateMonomeToggle.onchange = () => applyMonomeRotation(rotateMonomeToggle.checked ? 180 : 0, { send: true });
  }
  if (gateLedBoostToggle) {
    gateLedBoostToggle.onchange = () => {
      gateLedBoost = !!gateLedBoostToggle.checked;
      sendGateLedBoostIfChanged(gateLedBoost);
    };
  }
  if (mdBaseSweepInput) {
    const commitBaseSweep = () => {
      const val = Math.max(20, Math.min(200, Math.round(Number(mdBaseSweepInput.value) || mdBaseSweep)));
      mdBaseSweep = val;
      mdBaseSweepInput.value = val;
      sendMdSlideParamsIfChanged(mdSlideSpeed, mdSlideCurve, mdBaseSweep);
    };
    mdBaseSweepInput.addEventListener("change", commitBaseSweep);
    mdBaseSweepInput.addEventListener("blur", commitBaseSweep);
  }
  if (monoSlidePadInput) {
    const commitMonoSlidePad = () => {
      const pct = Math.max(0, Math.min(50, Math.round(Number(monoSlidePadInput.value) || (monoSlidePad * 100))));
      monoSlidePad = pct / 100;
      monoSlidePadInput.value = pct;
      sendMonoSlidePadIfChanged(monoSlidePad);
    };
    monoSlidePadInput.addEventListener("change", commitMonoSlidePad);
    monoSlidePadInput.addEventListener("blur", commitMonoSlidePad);
  }
  if (baseNoteLenSel) {
    const commitBaseDivision = () => {
      const val = normalizeBaseDivision(baseNoteLenSel.value || baseDivision || 16);
      baseDivision = val;
      baseNoteLenSel.value = String(val);
      sendBaseDivisionIfChanged(baseDivision);
    };
    baseNoteLenSel.addEventListener("change", commitBaseDivision);
  }
  if (gateLengthSel) {
    const commitGateLength = () => {
      const val = normalizeGateLength(gateLengthSel.value || gateLength || 1);
      gateLength = val;
      gateLengthSel.value = String(Math.round(val * 100));
      sendGateLengthIfChanged(gateLength);
    };
    gateLengthSel.addEventListener("change", commitGateLength);
  }
  if (isoBaseInput || isoStepXInput || isoStepYInput) {
    const commitIsoLayout = () => {
      const next = sanitizeIsomorphicLayout({
        base: isoBaseInput ? isoBaseInput.value : isomorphicLayout.base,
        stepX: isoStepXInput ? isoStepXInput.value : isomorphicLayout.stepX,
        stepY: isoStepYInput ? isoStepYInput.value : isomorphicLayout.stepY
      });
      isomorphicLayout = next;
      applyIsomorphicLayoutUI();
      sendIsomorphicLayoutIfChanged(isomorphicLayout);
    };
    if (isoBaseInput) {
      isoBaseInput.addEventListener("change", commitIsoLayout);
      isoBaseInput.addEventListener("blur", commitIsoLayout);
    }
    if (isoStepXInput) {
      isoStepXInput.addEventListener("change", commitIsoLayout);
      isoStepXInput.addEventListener("blur", commitIsoLayout);
    }
    if (isoStepYInput) {
      isoStepYInput.addEventListener("change", commitIsoLayout);
      isoStepYInput.addEventListener("blur", commitIsoLayout);
    }
  }
}

if (settingsSaveCfg) {
  settingsSaveCfg.onclick = () => {
    try {
      applySettingsFromInputs();
      const cfg = {
        ledLevels,
        clockSource,
        clockInput: clockInputId,
        clockOut: !!clockOutEnabled,
        clockOutDevice: clockOutPortId,
        showLog: !!(showLogToggle && showLogToggle.checked),
        autoFill: !!autoFillBars,
        autoLoadSet: !!autoLoadSet,
        baseDivision,
        gateLength,
        midiSettings,
        patternControlLatch,
        showMonomeControls,
        monomeRotation,
        gateLedBoost,
        defaultDeviceColor,
        multiColorDefault,
        defaultUsesMainWhite,
        whiteMode,
        colorMode,
        uiScale,
        isomorphicLayout
      };
      localStorage.setItem(LOCAL_CONFIG_KEY, JSON.stringify(cfg));
      // keep old key for backward compat
      localStorage.setItem("sgrid_led_config", JSON.stringify(ledLevels));
      cachedConfig = cfg;
      pushSavedConfigToServer({ skipClockSource: true });
      log("Saved config");
      showToast("Config saved");
    } catch (e) {
      log("Unable to save config");
    }
  };
}
if (settingsRestoreCfg) {
  settingsRestoreCfg.onclick = () => {
    clockOutEnabled = false;
    applyClockOutUI();
    sendClockOutIfChanged(clockOutEnabled);
    clockOutPortId = "";
    if (clockOutPortSel) clockOutPortSel.value = "";
    sendClockOutDeviceIfChanged(clockOutPortId);
    autoFillBars = true;
    applyAutoFillUI();
    sendAutoFillIfChanged(autoFillBars);
    autoLoadSet = false;
    if (autoLoadToggle) autoLoadToggle.checked = false;
    patternControlLatch = false;
    applyPatternControlLatchUI();
    sendPatternControlLatchIfChanged(patternControlLatch);
    showMonomeControls = true;
    applyMonomeControlsUI();
    sendMonomeControlsIfChanged(showMonomeControls);
    applyMonomeRotation(0, { send: true });
    gateLedBoost = false;
    applyGateLedBoostUI();
    sendGateLedBoostIfChanged(gateLedBoost);
    ledLevels = { ...DEFAULT_LED_LEVELS };
    applyLedSettingsUI();
    sendLedLevelsIfChanged(ledLevels);
    baseDivision = 16;
    applyBaseNoteLenUI();
    sendBaseDivisionIfChanged(baseDivision);
    gateLength = 1;
    applyGateLengthUI();
    sendGateLengthIfChanged(gateLength);
    monoSlidePad = 0.1;
    applyMdSlideSpeedUI();
    sendMonoSlidePadIfChanged(monoSlidePad);
    isomorphicLayout = { base: 24, stepX: 1, stepY: 3 };
    applyIsomorphicLayoutUI();
    sendIsomorphicLayoutIfChanged(isomorphicLayout);
    applyWhiteMode("warm");
    applyColorMode("pastel");
    multiColorDefault = false;
    defaultUsesMainWhite = false;
    if (showLogToggle) {
      showLogToggle.checked = false;
      document.getElementById("log").classList.add("hidden");
    }
    if (uiScaleSel) {
      uiScaleSel.value = "1";
    }
    applyUiScale("1");
    try {
      localStorage.removeItem("mgrid_led_config");
      localStorage.removeItem(LOCAL_CONFIG_KEY);
    } catch (e) {
      // ignore localStorage errors while restoring defaults
    }
    cachedConfig = null;
    showToast("Defaults restored");
    log("Restored default config");
  };
}

applyWhiteMode(whiteMode, { skipRefresh: true });
applyColorMode(colorMode, { skipRefresh: true, skipUi: true });
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
  if (!raw) return "Untitled.studiogrid";
  const cleaned = raw.replace(/[\\/:*?"<>|]+/g, "-");
  if (/\.(studiogrid|sgridset|json)$/i.test(cleaned)) return cleaned;
  return `${cleaned}.studiogrid`;
}

function displaySetName(name) {
  const raw = String(name || "").trim();
  if (!raw) return "Untitled";
  return raw.replace(/\.(studiogrid|sgridset|json)$/i, "") || "Untitled";
}

function setDirty(next) {
  const safe = !!next;
  if (isDirty === safe) return;
  isDirty = safe;
  window.electronAPI?.setDirty?.(isDirty);
}

function resetUndoHistory() {
  undoHistory = [];
  redoHistory = [];
  undoInitialized = false;
  pendingUndoReset = true;
  if (undoSnapshotTimer) {
    clearTimeout(undoSnapshotTimer);
    undoSnapshotTimer = null;
  }
}

function queueUndoSnapshot({ force = false, replace = false } = {}) {
  if ((!receivedStateOnce && !force) || applyingUndoRedo) return;
  if (undoSnapshotTimer) clearTimeout(undoSnapshotTimer);
  const delay = force ? 0 : 250;
  undoSnapshotTimer = setTimeout(() => {
    undoSnapshotTimer = null;
    captureUndoSnapshot({ replace });
  }, delay);
}

async function captureUndoSnapshot({ replace = false } = {}) {
  if (undoSnapshotInFlight) {
    undoSnapshotQueued = true;
    return;
  }
  undoSnapshotInFlight = true;
  try {
    const resp = await fetch("/api/export");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const payload = data.data || data;
    const snapshot = JSON.stringify(payload);
    if (replace || !undoHistory.length) {
      undoHistory = [snapshot];
      redoHistory = [];
    } else if (undoHistory[undoHistory.length - 1] !== snapshot) {
      undoHistory.push(snapshot);
      if (undoHistory.length > UNDO_HISTORY_LIMIT) undoHistory.shift();
      redoHistory = [];
    }
    undoInitialized = true;
  } catch (e) {
    console.warn("Undo snapshot failed", e);
  } finally {
    undoSnapshotInFlight = false;
    if (undoSnapshotQueued) {
      undoSnapshotQueued = false;
      captureUndoSnapshot();
    }
  }
}

function applySnapshotFromHistory(snapshot) {
  if (!snapshot || ws?.readyState !== WebSocket.OPEN) return;
  let payload = snapshot;
  if (typeof snapshot === "string") {
    try {
      payload = JSON.parse(snapshot);
    } catch (e) {
      console.warn("Undo snapshot parse failed", e);
      return;
    }
  }
  applyingUndoRedo = true;
  ws.send(JSON.stringify({ type: "import_state", snapshot: payload }));
  setTimeout(() => {
    applyingUndoRedo = false;
  }, 0);
}

function performUndo() {
  if (undoHistory.length < 2) return;
  const current = undoHistory.pop();
  redoHistory.push(current);
  const target = undoHistory[undoHistory.length - 1];
  applySnapshotFromHistory(target);
}

function performRedo() {
  if (!redoHistory.length) return;
  const next = redoHistory.pop();
  undoHistory.push(next);
  applySnapshotFromHistory(next);
}

if (window.electronAPI?.onAppUndoRedo) {
  window.electronAPI.onAppUndoRedo((payload) => {
    if (isTypingTarget(document.activeElement)) return;
    if (payload?.action === "undo") performUndo();
    if (payload?.action === "redo") performRedo();
  });
}

if (window.electronAPI?.onAppMenuAction) {
  window.electronAPI.onAppMenuAction((payload) => {
    const action = payload?.action;
    if (action === "new-project") {
      newSetBtn?.click();
    } else if (action === "load-project") {
      document.getElementById("import")?.click();
    } else if (action === "save-project") {
      openSaveSetModal();
    } else if (action === "save-project-as") {
      saveProjectAsNew();
    } else if (action === "settings") {
      settingsBtn?.click();
    }
  });
}

function shouldMarkDirty(msg) {
  if (!msg || typeof msg !== "object") return false;
  const type = msg.type;
  if (!type) return false;
  if (type === "import_state") {
    pendingDirtyReset = true;
    return false;
  }
  return !NON_DIRTY_WS_TYPES.has(type);
}

async function saveBeforeQuit() {
  if (!isDirty) return false;
  const suggested = setName && setName.toLowerCase() !== "default" ? setName : "Untitled";
  const hasNamedSet = currentSetFilename
    && displaySetName(currentSetFilename).toLowerCase() !== "untitled";
  let targetName = hasNamedSet ? currentSetFilename : suggested;
  if (hasElectronSave) {
    if (!hasNamedSet) {
      const picked = await openSaveNameModal(suggested);
      if (!picked) return false;
      targetName = picked;
    }
    const overwrite = hasNamedSet;
    await saveSnapshotToElectron(targetName, { overwrite });
    return true;
  }
  if (currentSetFileHandle) {
    await saveSnapshotToHandle(currentSetFileHandle);
    return true;
  }
  if (window.showSaveFilePicker) {
    const handle = await requestSaveHandle(targetName);
    if (handle?.name) {
      currentSetFilename = handle.name;
      setName = displaySetName(handle.name || setName);
      updateSetTitle(setName);
    }
    await saveSnapshotToHandle(handle);
    return true;
  }
  startExport(targetName);
  return true;
}

if (window.electronAPI?.onSaveBeforeQuit) {
  window.electronAPI.onSaveBeforeQuit(async () => {
    if (!isDirty) {
      window.electronAPI?.respondSaveBeforeQuit?.(true);
      return;
    }
    try {
      await saveBeforeQuit();
      window.electronAPI?.respondSaveBeforeQuit?.(true);
    } catch (e) {
      showToast("Save failed");
      log("Save failed");
      window.electronAPI?.respondSaveBeforeQuit?.(false);
    }
  });
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
  showToast("Project saved");
  log("Saved current project");
  setDirty(false);
  return true;
}

async function saveSnapshotToElectron(name, { overwrite = false } = {}) {
  if (!hasElectronSave) return false;
  const resp = await fetch("/api/export");
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  const payload = data.data || data;
  const targetName = ensureSetFilename(name || "Untitled.studiogrid");
  const result = await window.electronAPI.saveSet({ name: targetName, data: payload, overwrite });
  if (result?.filename) {
    currentSetFilename = result.filename;
    currentSetFileHandle = null;
    setName = displaySetName(result.filename || setName);
    updateSetTitle(setName);
  }
  showToast("Project saved");
  log("Saved current project");
  setDirty(false);
  return true;
}

async function requestSaveHandle(defaultName) {
  if (!window.showSaveFilePicker) return null;
  const suggested = ensureSetFilename(defaultName || "Untitled.studiogrid");
  return window.showSaveFilePicker({
    suggestedName: suggested,
    types: [
      {
        description: "studio grid Project",
        accept: {
          "application/json": [".studiogrid", ".sgridset"]
        }
      }
    ],
    excludeAcceptAllOption: true
  });
}

function startExport(name) {
  const targetName = ensureSetFilename(name || "Untitled.studiogrid");
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
      setDirty(false);
      log("Exported project");
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
  if (dialogCancel) dialogCancel.textContent = "Cancel";
  if (dialogOk) dialogOk.textContent = "OK";
  if (dialogOk) dialogOk.removeAttribute("disabled");
  if (dialogCancel) dialogCancel.removeAttribute("disabled");
  dialogOkHandler = typeof onConfirm === "function" ? onConfirm : null;
  dialogModal.classList.remove("hidden");
}

function saveProjectAsNew() {
  const suggested = setName && setName.toLowerCase() !== "default" ? setName : "Untitled";
  if (hasElectronSave) {
    openSaveNameModal(suggested).then((name) => {
      if (!name) return;
      saveSnapshotToElectron(name, { overwrite: false }).catch(() => {
        showToast("Save failed");
        log("Save failed");
      });
    });
    return;
  }
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
}

function openSaveSetModal() {
  if (!saveSetModal) {
    if (hasElectronSave) {
      saveSnapshotToElectron(currentSetFilename || "Untitled.studiogrid", { overwrite: true }).catch(() => {
        showToast("Save failed");
        log("Save failed");
      });
      return;
    }
    startExport(currentSetFilename || "Untitled.studiogrid");
    return;
  }
  const display = displaySetName(currentSetFilename || "Untitled.studiogrid");
  if (saveSetMessage) {
    saveSetMessage.textContent = `Save current project as "${display}"?`;
  }
  saveSetModal.classList.remove("hidden");
  if (saveSetCurrent) {
    saveSetCurrent.onclick = () => {
      saveSetModal.classList.add("hidden");
      const target = displaySetName(currentSetFilename || "Untitled.studiogrid");
      openConfirmDialog(`Are you sure you want to save over "${target}"?`, () => {
        if (hasElectronSave) {
          saveSnapshotToElectron(currentSetFilename || `${target}.studiogrid`, { overwrite: true }).catch(() => {
            showToast("Save failed");
            log("Save failed");
          });
          return;
        }
        if (currentSetFileHandle) {
          saveSnapshotToHandle(currentSetFileHandle).catch(() => {
            showToast("Save failed");
            log("Save failed");
          });
        } else if (window.showSaveFilePicker) {
          requestSaveHandle(currentSetFilename || `${target}.studiogrid`)
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
          startExport(currentSetFilename || "Untitled.studiogrid");
        }
      });
    };
  }
  if (saveSetNew) {
    saveSetNew.onclick = () => {
      saveSetModal.classList.add("hidden");
      saveProjectAsNew();
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

function buildTabsRenderKey() {
  const order = normalizeDeviceOrder(deviceOrder);
  const activePage = activeUiPage;
  const activeColor = activePage ? getDeviceDisplayColor(activePage) : null;
  const nameKey = order.map((page) => deviceNames[page] || "").join("|");
  const patternKey = order
    .map((page) => {
      const patIdx = activePatterns[page] || 1;
      const len = (patternLengths[page] && patternLengths[page][patIdx]) || null;
      const hasPattern = Number.isFinite(len) && len > 0;
      return `${patIdx}:${hasPattern ? 1 : 0}`;
    })
    .join("|");
  const configKey = [
    defaultDeviceColor,
    multiColorDefault ? 1 : 0,
    defaultUsesMainWhite ? 1 : 0,
    whiteMode || "",
    colorMode || ""
  ].join("|");
  return `${order.join(",")}|${activePage}|${activeColor || ""}|${nameKey}|${patternKey}|${configKey}`;
}

function renderTabs({ force = false } = {}) {
  const nextKey = buildTabsRenderKey();
  if (!force && nextKey === lastTabsRenderKey) return;
  lastTabsRenderKey = nextKey;
  tabs.innerHTML = "";
  const order = normalizeDeviceOrder(deviceOrder);
  order.forEach((page) => {
    const btn = document.createElement("button");
    const label = deviceNames[page] && deviceNames[page].trim().length ? deviceNames[page] : `${page}`;
    btn.textContent = label;
    btn.dataset.page = page;
    const isActive = activeUiPage === page;
    const activeBg = getDeviceDisplayColor(page);
    const patIdx = activePatterns[page] || 1;
    const len = (patternLengths[page] && patternLengths[page][patIdx]) || null;
    const hasPattern = Number.isFinite(len) && len > 0;
    if (isActive) btn.classList.add("active");
    if (!hasPattern) btn.classList.add("no-pattern");
    btn.classList.toggle("device-tab", isActive);
    if (isActive) {
      btn.style.setProperty("--device", activeBg);
      btn.style.setProperty("--on-device", contrastForColor(activeBg));
    }
    const focusPage = () => {
      if (activeUiPage === page) return;
      if (activeUiPage === 0) {
        if (patternControlActive) {
          pendingLauncherExitPage = page;
          sendPatternControlToggleFromUI("exit");
          return;
        }
      }
      activeUiPage = page;
      selectedDevicePage = page;
      applyPatternLauncherTypeUI();
      renderTabs();
      renderDeviceTabProgressFrame();
      updatePage(page, { fromServer: false, deferFrame: !frameReady[page] });
    };
    const handleTap = () => {
      if (activeUiPage === page) return;
      focusPage();
    };
    btn.onpointerdown = (e) => {
      if (e.button !== 0) return;
      if (activeUiPage !== page) return;
      if (deviceTabHoldTimers.has(page)) {
        clearTimeout(deviceTabHoldTimers.get(page));
        deviceTabHoldTimers.delete(page);
      }
      deviceTabHoldFired.delete(page);
      const timer = setTimeout(() => {
        deviceTabHoldTimers.delete(page);
        deviceTabHoldFired.add(page);
        ws?.readyState === WebSocket.OPEN &&
          ws.send(JSON.stringify({ type: "set_isomorphic_mode", page, enabled: !isomorphicModes[page] }));
      }, DEVICE_TAB_HOLD_MS);
      deviceTabHoldTimers.set(page, timer);
    };
    btn.onpointerup = (e) => {
      if (e.button !== 0) return;
      if (deviceTabHoldTimers.has(page)) {
        clearTimeout(deviceTabHoldTimers.get(page));
        deviceTabHoldTimers.delete(page);
      }
      const wasHold = deviceTabHoldFired.has(page);
      deviceTabHoldFired.delete(page);
      if (wasHold) return;
      handleTap();
    };
    btn.onpointerleave = () => {
      if (deviceTabHoldTimers.has(page)) {
        clearTimeout(deviceTabHoldTimers.get(page));
        deviceTabHoldTimers.delete(page);
      }
      deviceTabHoldFired.delete(page);
    };
    btn.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      focusPage();
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
  const launcherBtn = document.createElement("button");
  launcherBtn.type = "button";
  launcherBtn.classList.add("pattern-launcher");
  launcherBtn.dataset.patternLauncher = "true";
  const launcherActive = activeUiPage === 0;
  launcherBtn.title = launcherActive ? "Pattern Launcher (active)" : "Pattern Launcher";
  launcherBtn.setAttribute("aria-pressed", launcherActive ? "true" : "false");
  if (launcherActive) launcherBtn.classList.add("active");
  launcherBtn.innerHTML = "<i class=\"iconoir-table\" aria-hidden=\"true\"></i>";
  launcherBtn.onclick = (e) => {
    e.preventDefault();
    if (activeUiPage === 0 || patternControlActive) return;
    lastFocusedDevice = currentPage;
    sendPatternControlToggleFromUI("enter");
  };
  tabs.append(launcherBtn);
  applyDeviceBadge();
  renderDeviceTabProgressFrame();
}

function getInterpolatedTransportTickExt() {
  if (!running) return transportTickExt;
  const nowSec = getNowSec();
  if (clockSource === "internal" && internalTickPeriodSec > 0) {
    return (nowSec - internalStartTimeSec) / internalTickPeriodSec;
  }
  if (clockSource === "external" && tempo > 0) {
    if (!Number.isFinite(externalPredictedTickMs) || !audioTimeOriginMs) return transportTickExt;
    const lastTickSec = (externalPredictedTickMs - audioTimeOriginMs) / 1000;
    const tickPeriodSec = Number.isFinite(externalIntervalEstMs)
      ? (externalIntervalEstMs / 1000)
      : (60 / (tempo * PPQN_EXT));
    return transportTickExt + Math.max(0, (nowSec - lastTickSec) / tickPeriodSec);
  }
  return transportTickExt;
}

function getInterpolatedTransportTickInt() {
  return extToIntTick(getInterpolatedTransportTickExt());
}

function syncDeviceTabProgressCanvas() {
  if (!deviceTabProgressCanvas || !tabs) return;
  const rect = tabs.getBoundingClientRect();
  if (!rect.width) return;
  const dpr = window.devicePixelRatio || 1;
  const nextWidth = Math.max(1, Math.round(rect.width * dpr));
  const nextHeight = Math.max(1, Math.round(TAB_PROGRESS_BAR_HEIGHT * dpr));
  if (deviceTabProgressCanvas.width !== nextWidth) deviceTabProgressCanvas.width = nextWidth;
  if (deviceTabProgressCanvas.height !== nextHeight) deviceTabProgressCanvas.height = nextHeight;
  if (deviceTabProgressCssWidth !== rect.width) {
    deviceTabProgressCanvas.style.width = `${rect.width}px`;
    deviceTabProgressCssWidth = rect.width;
  }
  if (deviceTabProgressCssHeight !== TAB_PROGRESS_BAR_HEIGHT) {
    deviceTabProgressCanvas.style.height = `${TAB_PROGRESS_BAR_HEIGHT}px`;
    deviceTabProgressCssHeight = TAB_PROGRESS_BAR_HEIGHT;
  }
}

function startDeviceTabProgressLoop() {
  if (deviceTabProgressRaf != null) return;
  const loop = (timeNow) => {
    deviceTabProgressRaf = requestAnimationFrame(loop);
    renderDeviceTabProgressFrame(timeNow);
  };
  deviceTabProgressRaf = requestAnimationFrame(loop);
}

function stopDeviceTabProgressLoop() {
  if (deviceTabProgressRaf == null) return;
  cancelAnimationFrame(deviceTabProgressRaf);
  deviceTabProgressRaf = null;
}

function renderDeviceTabProgressFrame(timeNow = performance.now()) {
  if (!deviceTabProgressCanvas || !deviceTabProgressCtx || !tabs) return;
  syncDeviceTabProgressCanvas();
  const canvasRect = deviceTabProgressCanvas.getBoundingClientRect();
  if (!canvasRect.width) return;
  const dpr = window.devicePixelRatio || 1;
  deviceTabProgressCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  deviceTabProgressCtx.clearRect(0, 0, canvasRect.width, TAB_PROGRESS_BAR_HEIGHT);
  const transportTickNow = getInterpolatedTransportTickInt();
  const syncZeroTick = 0;
  const beatTicks = PPQN_INT;
  const beatIndex = Math.floor((transportTickNow - syncZeroTick) / beatTicks);
  const blinkOn = (beatIndex % 2) === 0;
  const baseBg = resolveCssColorVar("--panel-strong") || resolveCssColorVar("--surface");
  const mutedBg = colorWithAlpha(baseBg, 0.6);
  const followColor = resolveCssColorVar("--fg");
  const tabButtons = tabs.querySelectorAll("button");
  tabButtons.forEach((btn) => {
    const page = Number(btn.dataset.page);
    if (!Number.isFinite(page)) return;
    const tabRect = btn.getBoundingClientRect();
    const tabX = tabRect.left - canvasRect.left;
    const deviceColor = followColor;
    const patIdx = activePatterns[page] || 1;
    const lengthSteps = (patternLengths[page] && patternLengths[page][patIdx]) || null;
    const timeScaleRaw = (patternTimeScales[page] && patternTimeScales[page][patIdx]) || 1;
    const timeScale = Number.isFinite(timeScaleRaw) && timeScaleRaw > 0 ? timeScaleRaw : 1;
    const hasPatternLength = Number.isFinite(lengthSteps) && lengthSteps > 0;
    const playheadEntry = barPlayheads[page];
    const playingBar = Array.isArray(playheadEntry) ? playheadEntry[patIdx] : playheadEntry;
    const playheadKnown = playheadEntry !== undefined;
    const hasPlayhead = Number.isFinite(playingBar);
    const isQueued = pendingPatterns[page] != null;
    const isSelected = page === selectedDevicePage;
    let pageHasData = deviceHasData[page];
    if (page === currentPage) {
      pageHasData = patternHasData(currentPage);
      deviceHasData[page] = pageHasData;
    }
    const hasDataKnown = pageHasData === true || pageHasData === false;
    const showSequencer = (hasDataKnown ? pageHasData : true) || isSelected;
    const hasPattern = hasPatternLength && showSequencer;
    const hasPlayableData = pageHasData === true;
    const pageStopped = deviceStopped[page] === true;
    const allowEmptyPlay = isSelected && !hasPlayableData;
    const isStopped = hasPattern && !allowEmptyPlay && hasPlayableData && (pageStopped || !running || (playheadKnown && !hasPlayhead));
    const isPlaying = running && hasPattern && (hasPlayableData || allowEmptyPlay) && !pageStopped && (!playheadKnown || hasPlayhead);
    const stoppedFill = resolveCssColorVar("--muted");
    const deviceState = {
      hasPattern,
      isPlaying,
      isStopped,
      isQueued,
      isSelected,
      lengthSteps,
      timeScale,
      barX: tabX,
      barW: tabRect.width,
      bgColor: hasPattern ? baseBg : mutedBg,
      fillColor: deviceColor,
      stoppedFillColor: stoppedFill,
      syncZeroTick,
      blinkOn
    };
    drawDeviceTabProgress(deviceTabProgressCtx, { x: tabX, y: 0, width: tabRect.width }, deviceState, transportTickNow, timeNow);
  });
  const launcherBtn = tabs.querySelector("button[data-pattern-launcher=\"true\"]");
  if (launcherBtn) {
    const tabRect = launcherBtn.getBoundingClientRect();
    const tabX = tabRect.left - canvasRect.left;
    const launcherFill = followColor;
    const showClock = running;
    const launcherState = {
      hasPattern: showClock,
      isPlaying: showClock,
      isStopped: false,
      isQueued: false,
      isSelected: false,
      lengthSteps: 16,
      barX: tabX,
      barW: tabRect.width,
      bgColor: baseBg,
      fillColor: launcherFill,
      stoppedFillColor: baseBg,
      syncZeroTick,
      blinkOn
    };
    drawDeviceTabProgress(deviceTabProgressCtx, { x: tabX, y: 0, width: tabRect.width }, launcherState, transportTickNow, timeNow);
  }
}

function drawDeviceTabProgress(ctx, tabRect, deviceState, transportTickNow, timeNow) {
  if (!deviceState || !ctx) return;
  const barW = tabRect.width - 2 * TAB_PROGRESS_BAR_X_PAD;
  if (barW <= 0) return;
  const barX = tabRect.x + TAB_PROGRESS_BAR_X_PAD;
  const barY = tabRect.y;
  const barH = TAB_PROGRESS_BAR_HEIGHT;
  const lengthSteps = deviceState.lengthSteps;
  let visualBars = 1;
  if (deviceState.hasPattern) {
    const equalBars = lengthSteps === 16 || lengthSteps === 32 || lengthSteps === 48 || lengthSteps === 64;
    visualBars = equalBars ? Math.min(4, Math.max(1, Math.ceil(lengthSteps / 16))) : 1;
  }
  const gapTotal = (visualBars - 1) * TAB_PROGRESS_SEG_GAP;
  const segW = (barW - gapTotal) / visualBars;
  if (segW <= 0) return;
  for (let i = 0; i < visualBars; i += 1) {
    const sx = barX + i * (segW + TAB_PROGRESS_SEG_GAP);
    ctx.fillStyle = deviceState.bgColor;
    ctx.fillRect(sx, barY, segW, barH);
  }
  if (deviceState.isStopped && deviceState.hasPattern) {
    ctx.fillStyle = deviceState.stoppedFillColor;
    for (let i = 0; i < visualBars; i += 1) {
      const sx = barX + i * (segW + TAB_PROGRESS_SEG_GAP);
      ctx.fillRect(sx, barY, segW, barH);
    }
    return;
  }
  if (!deviceState.isPlaying || !deviceState.hasPattern) return;
  const patternTicks = Math.max(1, lengthSteps * TICKS_PER_STEP_INT * (deviceState.timeScale || 1));
  const baseTick = transportTickNow - deviceState.syncZeroTick;
  const mod = ((baseTick % patternTicks) + patternTicks) % patternTicks;
  const phase = mod / patternTicks;
  let segIndex = visualBars - 1;
  let segFill = 1;
  let acc = 0;
  for (let i = 0; i < visualBars; i += 1) {
    const barSteps = visualBars === 1
      ? lengthSteps
      : Math.max(0, Math.min(16, lengthSteps - i * 16));
    const frac = barSteps / lengthSteps;
    const next = acc + frac;
    if (phase <= next || i === visualBars - 1) {
      segIndex = i;
      segFill = frac > 0 ? (phase - acc) / frac : 0;
      break;
    }
    acc = next;
  }
  const flicker = deviceState.isQueued;
  const fillAlpha = flicker ? (deviceState.blinkOn ? 1 : 0.35) : 1;
  ctx.fillStyle = colorWithAlpha(deviceState.fillColor, fillAlpha);
  for (let i = 0; i < visualBars; i += 1) {
    const sx = barX + i * (segW + TAB_PROGRESS_SEG_GAP);
    if (i < segIndex) {
      ctx.fillRect(sx, barY, segW, barH);
    } else if (i === segIndex) {
      const fillW = Math.max(0, Math.min(segW, segW * Math.max(0, Math.min(1, segFill))));
      if (fillW > 0) ctx.fillRect(sx, barY, fillW, barH);
    }
  }
}

function getCssVar(name, fallback) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name);
  const val = raw ? raw.trim() : "";
  if (!val) return fallback || "";
  if (val.startsWith("var(")) {
    const match = val.match(/var\((--[^)\s,]+)/);
    if (match) return getCssVar(match[1], fallback);
  }
  return val || fallback || "";
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
    btn.textContent = String(i + 1);
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
        clearNumericOverlays(currentPage);
        resetOctaveOverlayUI();
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

function updatePage(page, { fromServer = false, deferFrame = false } = {}) {
  if (!page || page < 1 || page > 8) return;
  const prevPage = currentPage;
  currentPage = page;
  if (!patternControlActive) lastFocusedDevice = page;
  if (!patternControlActive) activeUiPage = page;
  selectedDevicePage = activeUiPage;
  if (prevPage !== page) {
    suppressFrameUntilNext[page] = true;
    frameReady[page] = false;
    renderFrame(BLANK_FRAME);
  }
  const deferFrameRender = deferFrame || !frameReady[page] || suppressFrameUntilNext[page];
  renderTabs();
  applyPageMidi();
  applyPageTranspose();
  applyDeviceBadge();
  renderPatternRow();
  applyPatternSelectUI();
  applyPatternLengthUI();
  applyPatternScaleUI();
  applySeqTypeUI({ deferFrame: deferFrameRender });
  applyDrumNotesUI();
  applyCCUI();
  renderBarRow();
  if (!deferFrameRender) renderFrameIfReady();
  updateSelectionPopover();
  updateSelectionRectFromCells(selectionByPage[currentPage]);
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
  updateTd3ExportVisibility();
}

midiChan.onchange = () => {
  if (!midiSettings[currentPage]) {
    midiSettings[currentPage] = { outId: midiSel?.value || "", channel: 1 };
  }
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

function sendMidiConfig(page = currentPage) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const cfg = midiSettings[page] || { outId: "", channel: 1 };
  const outId = cfg.outId || "";
  const channel = cfg.channel || 1;
  const last = lastSentState.midiSettings[page] || {};
  if (last.outId === outId && last.channel === channel) return;
  lastSentState.midiSettings[page] = { outId, channel };
  ws.send(JSON.stringify({ type: "set_midi", page, outId, channel }));
}

function resetMidiSettings() {
  midiSettings = Array.from({ length: 9 }, () => ({ outId: "", channel: 1 }));
  midiOut = null;
  if (midiSel) midiSel.value = "";
  if (midiChan) midiChan.value = 1;
  applyPageMidi();
  for (let i = 1; i <= 8; i++) {
    sendMidiConfig(i);
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
  const transposeWrap = document.querySelector(".transpose-switch");
  if (transposeWrap) transposeWrap.classList.toggle("hidden", type === "cc");
}

function applySeqTypeUI({ deferFrame = false } = {}) {
  if (!seqTypeSel) return;
  const type = sequencerTypes[currentPage] || "mono";
  seqTypeSel.value = type;
  const transposeWrap = document.querySelector(".transpose-switch");
  if (transposeWrap) transposeWrap.classList.toggle("hidden", false);
  if (midiChan) {
    const disableChan = type === "mdtonal";
    midiChan.dataset.readonly = disableChan ? "true" : "false";
    midiChan.setAttribute("aria-readonly", disableChan ? "true" : "false");
    if (disableChan) {
      midiChan.value = "";
      midiChan.tabIndex = -1;
    } else {
      midiChan.value = String(midiSettings[currentPage]?.channel || 1);
      midiChan.removeAttribute("tabindex");
    }
  }
  applyPageTranspose();
  applyDrumNotesUI();
  applyScaleNotesUI();
  applyCCUI();
  applyMDTonalUI();
  updateTd3ExportVisibility();
  applyDeviceBadge();
  applyPatternLauncherTypeUI();
  const hasOverride = deviceColorOverrides[currentPage];
  renderTabs();
  if (!deferFrame) renderFrameIfReady();
}

function applyPatternLauncherTypeUI() {
  if (!seqTypeWrap || !patternLauncherType) return;
  renderNoteScrollbar();
  const showLauncher = activeUiPage === 0;
  const type = sequencerTypes[currentPage] || "mono";
  seqTypeWrap.classList.toggle("hidden", showLauncher);
  patternLauncherType.classList.toggle("hidden", !showLauncher);
  if (patternToolbar) patternToolbar.classList.toggle("hidden", showLauncher);
  if (scaleNotesWrap) {
    const showScaleNotes = type === "mono" || type === "poly" || type === "mdtonal" || type === "cc";
    scaleNotesWrap.classList.toggle("hidden", showLauncher || !showScaleNotes);
  }
  const transposeWrap = document.querySelector(".transpose-switch");
  if (transposeWrap) {
    transposeWrap.classList.toggle("hidden", showLauncher || type === "cc");
  }
  if (midiSel) {
    const midiLabel = midiSel.closest("label");
    if (midiLabel) midiLabel.classList.toggle("hidden", showLauncher);
  }
  if (midiChan) {
    const chanLabel = midiChan.closest("label");
    if (chanLabel) chanLabel.classList.toggle("hidden", showLauncher);
  }
  if (midiChanLabel) midiChanLabel.classList.toggle("hidden", showLauncher || type === "mdtonal");
  const mdWrap = document.getElementById("md-config");
  if (mdWrap) mdWrap.classList.toggle("hidden", showLauncher || type !== "mdtonal");
  const ccWrap = document.getElementById("cc-config");
  if (ccWrap) ccWrap.classList.toggle("hidden", showLauncher || type !== "cc");
  if (exportTd3Btn) {
    if (showLauncher) exportTd3Btn.classList.add("hidden");
    else updateTd3ExportVisibility();
  }
  const disableControls = (el) => {
    if (!el) return;
    el.disabled = showLauncher;
  };
  disableControls(seqTypeSel);
  disableControls(transposeDec);
  disableControls(transposeInc);
  disableControls(midiSel);
  disableControls(midiChan);
  disableControls(patternSelect);
  disableControls(patternScaleToggle);
  patternLengthBtns.forEach((btn) => {
    btn.disabled = showLauncher;
  });
  [copyPatternBtn, copyBarBtn, pasteBtn, clearBtn, followBtn].forEach(disableControls);
  if (barRow) {
    barRow.querySelectorAll("button").forEach((btn) => {
      btn.disabled = showLauncher;
    });
  }
  if (deviceToolbar) {
    if (!showLauncher) {
      deviceToolbarBaseHeight = deviceToolbar.offsetHeight || deviceToolbarBaseHeight;
      deviceToolbar.style.minHeight = "";
    } else if (deviceToolbarBaseHeight) {
      deviceToolbar.style.minHeight = `${deviceToolbarBaseHeight}px`;
    }
  }
}

function applyDrumNotesUI() {
  const type = sequencerTypes[currentPage] || "mono";
  const drumWrap = document.getElementById("drum-notes");
  if (drumWrap) {
    drumWrap.classList.toggle("hidden", type !== "drum");
    drumWrap.classList.toggle("full-scale-extra", fullScaleMode && type === "drum");
    drumWrap.classList.toggle("compact", !fullScaleMode && type === "drum");
  }
  if (!drumInputs.length) return;
  if (!Array.isArray(drumNotes[currentPage])) drumNotes[currentPage] = DEFAULT_DRUMS.slice();
  if (drumNotes[currentPage].length < 8) {
    drumNotes[currentPage] = drumNotes[currentPage].concat(DEFAULT_DRUMS.slice(drumNotes[currentPage].length));
  }
  const map = drumNotes[currentPage] || DEFAULT_DRUMS;
  drumInputs.forEach((input) => {
    const row = Number(input.dataset.row);
    if (Number.isFinite(row)) {
      const val = map[row] ?? DEFAULT_DRUMS[row] ?? 36;
      const allowExtra = fullScaleMode && type === "drum";
      const isExtra = row === 7;
      const disabled = type !== "drum" || (isExtra && !allowExtra);
      input.disabled = disabled;
      if (disabled) editingDrumInputs.delete(input);
      if (disabled || !editingDrumInputs.has(input)) {
        input.value = val;
      }
    }
  });
}

function applyScaleNotesUI() {
  renderNoteScrollbar();
  if (!scaleNotesWrap) return;
  const type = sequencerTypes[currentPage] || "mono";
  const show = type === "mono" || type === "poly" || type === "mdtonal" || type === "cc";
  scaleNotesWrap.classList.toggle("hidden", !show);
  if (!show) return;

  const labels = [];
  const rows = getStepRows();
  if (type === "cc") {
    // Only label the 7 active CC rows; row 7 (bottom) is disabled when grid not connected
    const ccRows = fullScaleMode ? DEFAULT_STEP_ROWS : rows;
    for (let row = 0; row < ccRows; row += 1) {
      const t = (6 - row) / 6;
      labels.push({ text: String(Math.round(t * 127)), isRoot: false, homeHint: null });
    }
  } else {
    const mode = scale?.mode || "major";
    const root = Number(scale?.root) || 0;
    const steps = SCALE_STEPS[mode] || SCALE_STEPS.major;
    const rowShift = Math.max(NOTE_VIEW_ROW_SHIFT_MIN, Math.min(NOTE_VIEW_ROW_SHIFT_MAX, Math.round(Number(noteViewOffsets[currentPage]) || 0)));
    const noteNameForIndex = (index) => {
      const degree = ((index % 7) + 7) % 7;
      const semis = root + (steps[degree] || 0);
      return NOTE_NAMES[((semis % 12) + 12) % 12] || "C";
    };
    // "Home" marker: only the sequencer's base/root note position (index 0),
    // not every octave repetition of the root degree.
    const isHomeRootIndex = (index) => index === 0;
    const minVisibleIndex = rowShift;
    const maxVisibleIndex = rowShift + Math.max(0, rows - 1);
    let offscreenHomeDirection = null;
    if (0 < minVisibleIndex) offscreenHomeDirection = "down";
    else if (0 > maxVisibleIndex) offscreenHomeDirection = "up";
    for (let row = 0; row < rows; row += 1) {
      const rowIndex = (rows - 1) - row;
      const noteIndex = rowIndex + rowShift;
      const isRoot = isHomeRootIndex(noteIndex);
      let homeHint = null;
      if (!isRoot && offscreenHomeDirection === "up" && row === 0) homeHint = "up";
      if (!isRoot && offscreenHomeDirection === "down" && row === rows - 1) homeHint = "down";
      labels.push({ text: noteNameForIndex(noteIndex), isRoot, homeHint });
    }
  }

  scaleNotesWrap.innerHTML = labels
    .map((item) => {
      const classes = ["scale-note"];
      if (item.isRoot) classes.push("scale-note-root");
      if (item.homeHint === "up") classes.push("scale-note-home-up");
      if (item.homeHint === "down") classes.push("scale-note-home-down");
      return `<span class="${classes.join(" ")}">${item.text}</span>`;
    })
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
}

function sendGridTapFromClient(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor((clientX - rect.left) / (rect.width / WIDTH));
  const y = Math.floor((clientY - rect.top) / (rect.height / HEIGHT));
  if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
  if (noteMenu && !noteMenu.classList.contains("hidden") && noteMenuTarget && noteMenuTarget.x === x && noteMenuTarget.y === y) {
    closeNoteMenu();
  }
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
  const seqType = sequencerTypes[currentPage] || "mono";
  if (seqType === "cc") {
    closeNoteMenu();
    return;
  }
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

function cellKey(x, y) {
  return `${x}:${y}`;
}

function parseCellKey(key) {
  const [x, y] = key.split(":").map((v) => Number(v));
  return { x, y };
}

function getGridHit(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = rect.width / CANVAS_WIDTH;
  const scaleY = rect.height / CANVAS_HEIGHT;
  const relX = (clientX - rect.left) / scaleX;
  const relY = (clientY - rect.top) / scaleY;
  const inBounds = relX >= 0 && relX <= CANVAS_WIDTH && relY >= 0 && relY <= CANVAS_HEIGHT;
  const step = CELL_SIZE + CELL_GAP;
  const x = Math.floor(relX / step);
  const y = Math.floor(relY / step);
  if (!inBounds || x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) {
    return { inBounds: false, rect, scaleX, scaleY, relX, relY };
  }
  const offsetX = relX - x * step;
  const offsetY = relY - y * step;
  const inCell = offsetX >= 0 && offsetX <= CELL_SIZE && offsetY >= 0 && offsetY <= CELL_SIZE;
  return { inBounds: true, inCell, x, y, rect, scaleX, scaleY, relX, relY };
}

function clampRel(hit) {
  return {
    relX: Math.max(0, Math.min(CANVAS_WIDTH, hit.relX)),
    relY: Math.max(0, Math.min(CANVAS_HEIGHT, hit.relY))
  };
}

function clearSelection() {
  const selection = selectionByPage[currentPage];
  const infoMap = selectionInfoByPage[currentPage];
  if (!selection || !infoMap || selection.size === 0) return;
  selection.clear();
  infoMap.clear();
  selectionRenderOffset = null;
  selectionBoxPreviewCells.clear();
  hideSelectionRect();
  updateSelectionPopover();
  renderFrameIfReady();
}

function cancelSelectionActions() {
  selectionBoxActive = false;
  selectionDragActive = false;
  selectionRenderOffset = null;
  selectionBoxStart = null;
  selectionBoxPreviewCells.clear();
  gridPointerActive = false;
  dragPaintActive = false;
  dragPaintVisited.clear();
  hideSelectionRect();
  selectionCopyActive = false;
}

function clearSelectedNotes() {
  const selection = selectionByPage[currentPage];
  if (!selection || !selection.size) return;
  if (ws?.readyState !== WebSocket.OPEN) return;
  selection.forEach((key) => {
    const { x, y } = parseCellKey(key);
    ws.send(JSON.stringify({ type: "grid_key", x, y, s: 1 }));
    ws.send(JSON.stringify({ type: "grid_key", x, y, s: 0 }));
  });
  clearSelection();
}

function getSelectionTargetsForEdit(target) {
  if (!target) return [];
  if (target.octaveAnchor) return [target];
  const selection = selectionByPage[currentPage];
  if (selection && selection.size) {
    const key = cellKey(target.x, target.y);
    if (selection.has(key)) {
      return Array.from(selection).map(parseCellKey);
    }
  }
  return [target];
}

function applySelectionDelta(target, kind, delta) {
  const targets = getSelectionTargetsForEdit(target);
  if (!targets.length) return;
  const infoMap = selectionInfoByPage[currentPage];
  targets.forEach(({ x, y }) => {
    if (kind === "octave") {
      if (!ENABLE_OCTAVE_SHIFTING) return;
      ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_step_octave", x, y, delta }));
      const key = cellKey(x, y);
      const info = infoMap?.get(key);
      if (info) info.octave = (Number(info.octave) || 0) + delta;
    } else if (kind === "micro") {
      ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_step_micro", x, y, delta }));
      const key = cellKey(x, y);
      const info = infoMap?.get(key);
      if (info) info.microOffset = (Number(info.microOffset) || 0) + delta;
    }
  });
  renderFrameIfReady();
}

function applySelectionToggle(target, kind, nextVal) {
  const targets = getSelectionTargetsForEdit(target);
  if (!targets.length) return;
  const infoMap = selectionInfoByPage[currentPage];
  targets.forEach(({ x, y }) => {
    const key = cellKey(x, y);
    const info = infoMap?.get(key);
    if (kind === "accent") {
      if (info?.canAccent === false) return;
      ws?.readyState === WebSocket.OPEN &&
        ws.send(JSON.stringify({ type: "set_step_accent", x, y, accent: !!nextVal }));
      if (info) info.accent = !!nextVal;
    } else if (kind === "slide") {
      if (info?.canSlide === false) return;
      ws?.readyState === WebSocket.OPEN &&
        ws.send(JSON.stringify({ type: "set_step_slide", x, y, slide: !!nextVal }));
      if (info) info.slide = !!nextVal;
    }
  });
  renderFrameIfReady();
}

function getChainSelectionForMenu(target) {
  const selection = selectionByPage[currentPage];
  const infoMap = selectionInfoByPage[currentPage];
  if (!selection || !infoMap || selection.size < 2) return null;
  if (target && !selection.has(cellKey(target.x, target.y))) return null;
  const seqType = sequencerTypes[currentPage] || "mono";
  if (!(seqType === "mono" || seqType === "poly")) return null;
  const items = [];
  selection.forEach((key) => {
    const info = infoMap.get(key);
    if (!info?.on) return;
    const { x, y } = parseCellKey(key);
    items.push({ x, y, info });
  });
  if (items.length !== selection.size) return null;
  const first = items[0];
  const degree = first?.info?.degree;
  const octave = Number.isFinite(first?.info?.octave) ? first.info.octave : 0;
  if (degree == null) return null;
  for (const item of items) {
    if (item.info.seqType !== seqType) return null;
    if (item.info.degree !== degree) return null;
    const itemOct = Number.isFinite(item.info.octave) ? item.info.octave : 0;
    if (itemOct !== octave) return null;
  }
  const xs = items.map((item) => item.x);
  const uniqueX = new Set(xs);
  if (uniqueX.size !== items.length) return null;
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  if (items.length !== (maxX - minX + 1)) return null;
  return { steps: items.map(({ x, y }) => ({ x, y })) };
}

function isPlayableCell(hit) {
  return hit?.inBounds && hit.inCell && hit.y >= 0 && hit.y < getEffectiveStepRows();
}

function toggleGridCell(x, y) {
  if (ws?.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "grid_key", x, y, s: 1 }));
  ws.send(JSON.stringify({ type: "grid_key", x, y, s: 0 }));
}

function requestStepsState(steps, callback) {
  if (ws?.readyState !== WebSocket.OPEN) return;
  const requestId = pendingStepsStateId++;
  pendingStepsStateRequests.set(requestId, callback);
  ws.send(JSON.stringify({ type: "get_steps_state", requestId, steps }));
}

function requestMoveSteps(steps, dx, dy, callback) {
  if (ws?.readyState !== WebSocket.OPEN) return;
  const requestId = pendingMoveStepsId++;
  pendingMoveStepsRequests.set(requestId, callback);
  ws.send(JSON.stringify({ type: "move_steps", requestId, steps, dx, dy }));
}

function requestCopySteps(steps, dx, dy, callback) {
  if (ws?.readyState !== WebSocket.OPEN) return;
  const requestId = pendingMoveStepsId++;
  pendingMoveStepsRequests.set(requestId, callback);
  ws.send(JSON.stringify({ type: "copy_steps", requestId, steps, dx, dy }));
}

function updateSelectionRectFromCanvasBox(box) {
  if (!selectionRect || !gridWrap) return;
  const gridRect = canvas.getBoundingClientRect();
  const wrapRect = gridWrap.getBoundingClientRect();
  const left = wrapRect.left;
  const top = wrapRect.top;
  const offsetX = gridRect.left - left;
  const offsetY = gridRect.top - top;
  selectionRect.style.left = `${offsetX + box.left}px`;
  selectionRect.style.top = `${offsetY + box.top}px`;
  selectionRect.style.width = `${box.width}px`;
  selectionRect.style.height = `${box.height}px`;
  selectionRect.classList.remove("hidden");
}

function hideSelectionRect() {
  if (selectionRect) selectionRect.classList.add("hidden");
}

function getSelectionBounds(selection, offset = { dx: 0, dy: 0 }) {
  const keys = Array.from(selection || []);
  if (!keys.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  keys.forEach((key) => {
    const { x, y } = parseCellKey(key);
    const adjX = x + (offset.dx || 0);
    const adjY = y + (offset.dy || 0);
    minX = Math.min(minX, adjX);
    minY = Math.min(minY, adjY);
    maxX = Math.max(maxX, adjX);
    maxY = Math.max(maxY, adjY);
  });
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

function updateSelectionRectFromCells(selection, offset = { dx: 0, dy: 0 }) {
  hideSelectionRect();
}

function wrapIndex(val, max) {
  if (!max) return 0;
  const mod = val % max;
  return mod < 0 ? mod + max : mod;
}

function clampMicroInput(raw) {
  const stepsPerBeat = Math.max(1, Math.round((baseDivision || 16) / 4));
  const ticksPerStepInt = Math.round(PPQN_INT / stepsPerBeat);
  const max = Math.max(1, ticksPerStepInt - 1);
  const val = Math.round(Number(raw) || 0);
  return Math.max(-max, Math.min(max, val));
}

function applySelectionState(infos, mode, page = currentPage) {
  const selection = selectionByPage[page];
  const infoMap = selectionInfoByPage[page];
  if (!selection || !infoMap) return;
  if (mode === "replace") {
    selection.clear();
    infoMap.clear();
  }
  infos.forEach((info) => {
    if (!info?.on) return;
    const key = cellKey(info.x, info.y);
    if (mode === "remove") {
      selection.delete(key);
      infoMap.delete(key);
    } else {
      selection.add(key);
      infoMap.set(key, info);
    }
  });
  if (page === currentPage) {
    selectionRenderOffset = null;
    updateSelectionPopover();
    updateSelectionRectFromCells(selection);
    renderFrameIfReady();
  }
}

function updateSelectionPopover() {}

function positionSelectionPopover() {}

function selectionMoveIsValid(selection, dx, dy) {
  return !!(selection && selection.size);
}

function performSelectionMove(dx, dy, opts = {}) {
  if (selectionMovePending) return;
  const selection = selectionByPage[currentPage];
  if (!selection || selection.size === 0) return;
  if (!selectionMoveIsValid(selection, dx, dy)) return;
  const steps = Array.from(selection).map(parseCellKey);
  selectionMovePending = true;
  const request = selectionCopyActive ? "copy_steps" : "move_steps";
  const requestFn = selectionCopyActive ? requestCopySteps : requestMoveSteps;
  requestFn(steps, dx, dy, (result) => {
    selectionMovePending = false;
    if (!result?.ok) {
      showToast(result?.reason || "Selection move failed");
      updateSelectionRectFromCells(selection);
      renderFrameIfReady();
      return;
    }
    const nextSelection = new Set();
    const nextInfoMap = new Map();
    const infoMap = selectionInfoByPage[currentPage];
    selection.forEach((key) => {
      const { x, y } = parseCellKey(key);
      const nx = wrapIndex(x + dx, WIDTH);
      const ny = wrapIndex(y + dy, getEffectiveStepRows());
      const nextKey = cellKey(nx, ny);
      nextSelection.add(nextKey);
      const info = infoMap.get(key);
      if (info) nextInfoMap.set(nextKey, { ...info, x: nx, y: ny });
    });
    selectionByPage[currentPage] = nextSelection;
    selectionInfoByPage[currentPage] = nextInfoMap;
    updateSelectionRectFromCells(nextSelection);
    updateSelectionPopover();
    renderFrameIfReady();
    const page = currentPage;
    requestStepsState(Array.from(nextSelection).map(parseCellKey), (stepsState) => {
      applySelectionState(stepsState, "replace", page);
    });
    selectionCopyActive = false;
    if (typeof opts.onDone === "function") opts.onDone();
  });
}

function collectCellsInBox(start, end) {
  const step = CELL_SIZE + CELL_GAP;
  const minX = Math.min(start.relX, end.relX);
  const maxX = Math.max(start.relX, end.relX);
  const minY = Math.min(start.relY, end.relY);
  const maxY = Math.max(start.relY, end.relY);
  const firstX = Math.max(0, Math.floor(minX / step));
  const lastX = Math.min(WIDTH - 1, Math.floor(maxX / step));
  const firstY = Math.max(0, Math.floor(minY / step));
  const lastY = Math.min(HEIGHT - 1, Math.floor(maxY / step));
  const rows = getEffectiveStepRows();
  const cells = [];
  for (let y = firstY; y <= lastY; y += 1) {
    if (y >= rows) continue;
    for (let x = firstX; x <= lastX; x += 1) {
      const centerX = x * step + CELL_SIZE / 2;
      const centerY = y * step + CELL_SIZE / 2;
      if (centerX >= minX && centerX <= maxX && centerY >= minY && centerY <= maxY) {
        cells.push({ x, y });
      }
    }
  }
  return cells;
}

function updateSelectionFromCells(cells, mode) {
  const page = currentPage;
  if (!cells.length) {
    if (mode === "replace") {
      applySelectionState([], "replace", page);
    }
    return;
  }
  requestStepsState(cells, (steps) => {
    applySelectionState(steps, mode, page);
  });
}

function finishSelectionBox(hit) {
  if (!selectionBoxActive || !selectionBoxStart) return;
  const clamped = clampRel(hit);
  const end = { ...hit, ...clamped };
  const cells = collectCellsInBox(selectionBoxStart, end);
  selectionBoxActive = false;
  selectionBoxStart = null;
  selectionBoxPreviewCells.clear();
  hideSelectionRect();
  updateSelectionFromCells(cells, selectionBoxMode);
}

function startSelectionBox(hit, mode) {
  const clamped = clampRel(hit);
  selectionBoxActive = true;
  selectionBoxMode = mode;
  selectionBoxStart = { relX: clamped.relX, relY: clamped.relY, scaleX: hit.scaleX, scaleY: hit.scaleY };
  updateSelectionRectFromCanvasBox({ left: clamped.relX * hit.scaleX, top: clamped.relY * hit.scaleY, width: 1, height: 1 });
}

function applySelectionOctave(target) {
  if (!ENABLE_OCTAVE_SHIFTING) return;
  const selection = selectionByPage[currentPage];
  const infoMap = selectionInfoByPage[currentPage];
  if (!selection || !selection.size || !Number.isFinite(target)) return;
  const seqType = sequencerTypes[currentPage] || "mono";
  const minOct = (seqType === "poly" || seqType === "drum") ? -3 : -2;
  const maxOct = (seqType === "poly" || seqType === "drum") ? 4 : 2;
  const nextOct = Math.max(minOct, Math.min(maxOct, Math.round(target)));
  selection.forEach((key) => {
    const info = infoMap.get(key);
    if (!info?.on) return;
    const delta = nextOct - (Number(info.octave) || 0);
    if (!delta) return;
    ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_step_octave", x: info.x, y: info.y, delta }));
    info.octave = (Number(info.octave) || 0) + delta;
  });
  updateSelectionPopover();
  renderFrameIfReady();
}

function applySelectionMicro(target) {
  const selection = selectionByPage[currentPage];
  const infoMap = selectionInfoByPage[currentPage];
  if (!selection || !selection.size || !Number.isFinite(target)) return;
  const nextMicro = clampMicroInput(target);
  selection.forEach((key) => {
    const info = infoMap.get(key);
    if (!info?.on) return;
    const delta = nextMicro - (Number(info.microOffset) || 0);
    if (!delta) return;
    ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "set_step_micro", x: info.x, y: info.y, delta }));
    info.microOffset = (Number(info.microOffset) || 0) + delta;
  });
  updateSelectionPopover();
  renderFrameIfReady();
}

function applySelectionAccent(nextVal) {
  const selection = selectionByPage[currentPage];
  const infoMap = selectionInfoByPage[currentPage];
  if (!selection || !selection.size) return;
  selection.forEach((key) => {
    const info = infoMap.get(key);
    if (!info?.on || info.canAccent === false) return;
    ws?.readyState === WebSocket.OPEN &&
      ws.send(JSON.stringify({ type: "set_step_accent", x: info.x, y: info.y, accent: !!nextVal }));
    info.accent = !!nextVal;
  });
  updateSelectionPopover();
  renderFrameIfReady();
}

function applySelectionSlide(nextVal) {
  const selection = selectionByPage[currentPage];
  const infoMap = selectionInfoByPage[currentPage];
  if (!selection || !selection.size) return;
  selection.forEach((key) => {
    const info = infoMap.get(key);
    if (!info?.on || info.canSlide === false) return;
    ws?.readyState === WebSocket.OPEN &&
      ws.send(JSON.stringify({ type: "set_step_slide", x: info.x, y: info.y, slide: !!nextVal }));
    info.slide = !!nextVal;
  });
  updateSelectionPopover();
  renderFrameIfReady();
}

canvas.addEventListener("mousemove", (e) => {
  if (gridPointerActive || octaveAnchorPress) return;
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
  if (withinHoverBand && octaveControls.style.display === "flex") return;

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
    if (!isOverMicroControls) microControls.style.display = "none";
    return;
  }
  const seqType = sequencerTypes[currentPage] || "mono";
  const inStepRows = y < getStepRows();
  const allowEdit = seqType !== "cc";
  if (!inStepRows || !allowEdit) {
    hoveredStep = null;
    if (!isOverOctaveControls) octaveControls.style.display = "none";
    if (!isOverMicroControls) microControls.style.display = "none";
    updateSelectionPopover();
    return;
  }

  const frame = frames[currentPage] || [];
  const val = frame[y * WIDTH + x] || 0;
  const playVal = ledLevels.playhead || 0;
  if (!running && playVal > 0 && val === playVal && !octaveAnchors[currentPage].has(y * WIDTH + x)) {
    hoveredStep = null;
    if (!isOverOctaveControls) octaveControls.style.display = "none";
    if (!isOverMicroControls) microControls.style.display = "none";
    updateSelectionPopover();
    return;
  }
  if (val <= 0) {
    hoveredStep = null;
    if (!isOverOctaveControls) octaveControls.style.display = "none";
    if (!isOverMicroControls) microControls.style.display = "none";
    updateSelectionPopover();
    return;
  }

  const target = withinHoverBand && anchor ? anchor : { x, y };
  hoveredStep = target;
  updateSelectionPopover();
  if (withinHoverBand && (octaveHoverTimer || pendingOctaveHover)) return;

  if (octaveControls.style.display === "flex" && movedCell && !isOverOctaveControls) {
    octaveControls.style.display = "none";
    if (!isOverMicroControls) microControls.style.display = "none";
  }

  octaveHoverTimer = setTimeout(() => {
    octaveHoverTimer = null;
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

canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || octaveAnchorPress) return;
  const hit = getGridHit(e.clientX, e.clientY);
  if (!hit.inBounds) return;
  const playable = isPlayableCell(hit);
  if (playable && octaveAnchors[currentPage].has(hit.y * WIDTH + hit.x)) {
    resetOctaveOverlayUI();
    const page = currentPage;
    const { x, y, rect, scaleX, scaleY } = hit;
    const timer = setTimeout(() => {
      if (currentPage !== page || !octaveAnchors[page].has(y * WIDTH + x)) return;
      showOctaveControls({ x, y, rectLeft: rect.left, rectTop: rect.top, scaleX, scaleY, octaveAnchor: true });
    }, NOTE_EDIT_HOLD_MS);
    octaveAnchorPress = { pointerId: e.pointerId, timer };
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }
  const selection = selectionByPage[currentPage];
  const hasSelection = selection && selection.size > 0;
  const key = playable ? cellKey(hit.x, hit.y) : null;
  const isSelectedCell = key && selection?.has(key);
  const mode = e.shiftKey ? "add" : (e.metaKey || e.ctrlKey ? "remove" : "replace");

  gridPointerActive = true;
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch (err) {
    // ignore if not supported
  }
  selectionRenderOffset = null;
  if (octaveHoverTimer) {
    clearTimeout(octaveHoverTimer);
    octaveHoverTimer = null;
  }
  pendingOctaveHover = null;
  hoveredStep = null;
  octaveControls.style.display = "none";
  microControls.style.display = "none";

  if ((e.shiftKey || e.metaKey || e.ctrlKey) && playable) {
    updateSelectionFromCells([{ x: hit.x, y: hit.y }], mode);
    updateSelectionRectFromCells(selectionByPage[currentPage]);
    renderFrameIfReady();
    e.preventDefault();
    return;
  }

  if (playable && isSelectedCell && hasSelection) {
    selectionDragActive = true;
    selectionDragStart = { x: hit.x, y: hit.y };
    selectionRenderOffset = { dx: 0, dy: 0 };
    selectionCopyActive = e.altKey;
    updateSelectionRectFromCells(selection, selectionRenderOffset);
    e.preventDefault();
    return;
  }

  if (playable) {
    dragPaintActive = true;
    dragPaintVisited = new Set([key]);
    toggleGridCell(hit.x, hit.y);
    e.preventDefault();
    return;
  }

  if (hit.inBounds && !hit.inCell) {
    startSelectionBox(hit, mode);
    e.preventDefault();
  }
});

for (const eventName of ["pointerup", "pointercancel", "lostpointercapture"]) {
  canvas.addEventListener(eventName, (event) => {
    if (octaveAnchorPress?.pointerId !== event.pointerId) return;
    clearTimeout(octaveAnchorPress.timer);
    octaveAnchorPress = null;
  });
}

canvas.addEventListener("pointermove", (e) => {
  if (!gridPointerActive) return;
  const hit = getGridHit(e.clientX, e.clientY);
  if (dragPaintActive && isPlayableCell(hit)) {
    const key = cellKey(hit.x, hit.y);
    if (!dragPaintVisited.has(key)) {
      dragPaintVisited.add(key);
      toggleGridCell(hit.x, hit.y);
    }
    return;
  }
  if (selectionBoxActive && selectionBoxStart) {
    const clamped = clampRel(hit);
    const left = Math.min(selectionBoxStart.relX, clamped.relX) * selectionBoxStart.scaleX;
    const top = Math.min(selectionBoxStart.relY, clamped.relY) * selectionBoxStart.scaleY;
    const width = Math.abs(selectionBoxStart.relX - clamped.relX) * selectionBoxStart.scaleX;
    const height = Math.abs(selectionBoxStart.relY - clamped.relY) * selectionBoxStart.scaleY;
    updateSelectionRectFromCanvasBox({ left, top, width, height });
    const boxCells = collectCellsInBox(selectionBoxStart, { ...hit, ...clamped });
    const frame = frames[currentPage] || [];
    selectionBoxPreviewCells = new Set();
    boxCells.forEach(({ x, y }) => {
      if ((frame[y * WIDTH + x] || 0) > 0) {
        selectionBoxPreviewCells.add(cellKey(x, y));
      }
    });
    renderFrameIfReady();
    return;
  }
  if (selectionDragActive && selectionDragStart && hit.inCell) {
    const dx = hit.x - selectionDragStart.x;
    const dy = hit.y - selectionDragStart.y;
    if (!dx && !dy) return;
    selectionRenderOffset = { dx, dy };
    updateSelectionRectFromCells(selectionByPage[currentPage], selectionRenderOffset);
    renderFrameIfReady();
  }
});

canvas.addEventListener("pointerup", (e) => {
  if (!gridPointerActive) return;
  if (dragPaintActive) {
    dragPaintActive = false;
    dragPaintVisited.clear();
  } else if (selectionBoxActive && selectionBoxStart) {
    const hit = getGridHit(e.clientX, e.clientY);
    finishSelectionBox(hit);
  } else if (selectionDragActive && selectionRenderOffset) {
    const selection = selectionByPage[currentPage];
    const dx = selectionRenderOffset.dx || 0;
    const dy = selectionRenderOffset.dy || 0;
    selectionDragActive = false;
    selectionDragStart = null;
    selectionRenderOffset = null;
    if (dx !== 0 || dy !== 0) {
      performSelectionMove(dx, dy);
    } else {
      updateSelectionRectFromCells(selection);
      updateSelectionPopover();
      renderFrameIfReady();
    }
    selectionCopyActive = false;
  }
  gridPointerActive = false;
  try {
    canvas.releasePointerCapture(e.pointerId);
  } catch (err) {
    // ignore if not captured
  }
});

canvas.addEventListener("pointercancel", (e) => {
  dragPaintActive = false;
  selectionBoxActive = false;
  selectionDragActive = false;
  selectionRenderOffset = null;
  selectionBoxStart = null;
  dragPaintVisited.clear();
  selectionBoxPreviewCells.clear();
  gridPointerActive = false;
  hideSelectionRect();
  selectionCopyActive = false;
  try {
    canvas.releasePointerCapture(e.pointerId);
  } catch (err) {
    // ignore if not captured
  }
});

const selectionDragRoots = [gridWrap, gridPanel, mainPanel, document.body].filter(Boolean);
selectionDragRoots.forEach((root) => {
  root.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (e.target === canvas) return;
    if (e.target.closest("button, input, select, textarea")) return;
    if (gridPanel) {
      const rect = gridPanel.getBoundingClientRect();
      const withinBand = e.clientY >= rect.top && e.clientY <= rect.bottom;
      if (!withinBand) return;
    }
    const hit = getGridHit(e.clientX, e.clientY);
    const mode = e.shiftKey ? "add" : (e.metaKey || e.ctrlKey ? "remove" : "replace");
    gridPointerActive = true;
    startSelectionBox(hit, mode);
    try {
      root.setPointerCapture(e.pointerId);
    } catch (err) {
      // ignore if not supported
    }
    e.preventDefault();
  });

  root.addEventListener("pointermove", (e) => {
    if (!selectionBoxActive || !selectionBoxStart) return;
    const hit = getGridHit(e.clientX, e.clientY);
    const clamped = clampRel(hit);
    const left = Math.min(selectionBoxStart.relX, clamped.relX) * selectionBoxStart.scaleX;
    const top = Math.min(selectionBoxStart.relY, clamped.relY) * selectionBoxStart.scaleY;
    const width = Math.abs(selectionBoxStart.relX - clamped.relX) * selectionBoxStart.scaleX;
    const height = Math.abs(selectionBoxStart.relY - clamped.relY) * selectionBoxStart.scaleY;
    updateSelectionRectFromCanvasBox({ left, top, width, height });
  });

  root.addEventListener("pointerup", (e) => {
    if (!selectionBoxActive || !selectionBoxStart) return;
    const hit = getGridHit(e.clientX, e.clientY);
    finishSelectionBox(hit);
    gridPointerActive = false;
    try {
      root.releasePointerCapture(e.pointerId);
    } catch (err) {
      // ignore if not captured
    }
  });

  root.addEventListener("pointercancel", (e) => {
    selectionBoxActive = false;
    selectionBoxStart = null;
    selectionBoxPreviewCells.clear();
    gridPointerActive = false;
    hideSelectionRect();
    try {
      root.releasePointerCapture(e.pointerId);
    } catch (err) {
      // ignore if not captured
    }
  });
});

canvas.addEventListener("mouseleave", () => {
  pendingOctaveHover = null;
  if (octaveHoverTimer) {
    clearTimeout(octaveHoverTimer);
    octaveHoverTimer = null;
  }
  if (octaveHideTimer) clearTimeout(octaveHideTimer);
  octaveHideTimer = setTimeout(() => {
    if (!isOverOctaveControls && !isOverMicroControls) {
      octaveControls.style.display = "none";
      microControls.style.display = "none";
      hoveredStep = null;
    }
  }, 300);
});
canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  handleCanvasContextMenu(e.clientX, e.clientY);
});

function nudgeStepOctave(delta) {
  if (!ENABLE_OCTAVE_SHIFTING) return;
  const target = hoveredStep || lastOctaveTarget;
  if (!target) return;
  applySelectionDelta(target, "octave", delta);
}

function nudgeStepMicro(delta) {
  const target = hoveredStep || lastOctaveTarget;
  if (!target) return;
  applySelectionDelta(target, "micro", delta);
}

function showOctaveControls(hover) {
  if (!hover) return;
  if (!ENABLE_OCTAVE_SHIFTING) {
    octaveControls.style.display = "none";
    showMicroControls(hover);
    return;
  }
  const seqType = sequencerTypes[currentPage] || "mono";
  const allowOctave = seqType !== "drum" && seqType !== "cc";
  const { x, y, rectLeft, rectTop, scaleX, scaleY, octaveAnchor } = hover;
  hoveredStep = { x, y, octaveAnchor };
  lastOctaveTarget = hoveredStep;
  if (!allowOctave) {
    if (!isOverOctaveControls) octaveControls.style.display = "none";
    showMicroControls(hover);
    return;
  }
  const atEdge = y === 0 || y === getStepRows() - 1;
  const btnSize = 24 * scaleX;
  const rowHeight = (CELL_SIZE + CELL_GAP) * scaleY;
  const columnGap = 4 * scaleX;
  const width = atEdge ? 2 * btnSize + columnGap : btnSize;
  const centerX = rectLeft + (x * (CELL_SIZE + CELL_GAP) + CELL_SIZE / 2) * scaleX;
  const topRow = y === 0 ? 1 : y - 1;
  const top = rectTop + topRow * rowHeight + (CELL_SIZE * scaleY - btnSize) / 2;
  const left = Math.max(rectLeft, Math.min(centerX - width / 2, rectLeft + CANVAS_WIDTH * scaleX - width));
  octaveControls.style.flexDirection = atEdge ? "row" : "column";
  octaveControls.style.columnGap = `${columnGap}px`;
  octaveControls.style.rowGap = `${Math.max(0, 2 * rowHeight - btnSize)}px`;
  [octaveUpBtn, octaveDownBtn].forEach((btn) => {
    btn.style.width = `${btnSize}px`;
    btn.style.height = `${btnSize}px`;
  });
  octaveControls.style.left = `${left}px`;
  octaveControls.style.top = `${top}px`;
  octaveControls.style.display = "flex";
  if (octaveAnchor) microControls.style.display = "none";
  else showMicroControls(hover);
}

function showMicroControls(hover) {
  if (!hover) return;
  const { x, y, rectLeft, rectTop, scaleX, scaleY } = hover;
  hoveredStep = { x, y };
  lastOctaveTarget = { x, y };
  const hasLeft = x > 0;
  const hasRight = x < WIDTH - 1;
  if (!hasLeft && !hasRight) {
    if (!isOverMicroControls) microControls.style.display = "none";
    return;
  }
  const btnSize = 24 * scaleX;
  const distX = (CELL_SIZE + CELL_GAP) * scaleX;
  const count = (hasLeft ? 1 : 0) + (hasRight ? 1 : 0);
  const gapPx = count > 1 ? Math.max(0, 2 * distX - btnSize) : 0;
  microControls.style.columnGap = `${gapPx}px`;
  [microLeftBtn, microRightBtn].forEach((btn) => {
    if (btn) {
      btn.style.width = `${btnSize}px`;
      btn.style.height = `${btnSize}px`;
    }
  });
  if (microLeftBtn) microLeftBtn.style.display = hasLeft ? "flex" : "none";
  if (microRightBtn) microRightBtn.style.display = hasRight ? "flex" : "none";
  const rowWidth = btnSize * count + gapPx * Math.max(0, count - 1);
  const centerX = rectLeft + (x * (CELL_SIZE + CELL_GAP) + CELL_SIZE / 2) * scaleX;
  const centerY = rectTop + (y * (CELL_SIZE + CELL_GAP) + CELL_SIZE / 2) * scaleY;
  microControls.style.left = `${centerX - rowWidth / 2}px`;
  microControls.style.top = `${centerY - btnSize / 2}px`;
  microControls.style.display = "flex";
}

function showOctaveControlsFromOverlay(msg) {
  if (!ENABLE_OCTAVE_SHIFTING) return;
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
    scaleY,
    octaveAnchor: msg.octaveAnchor
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
if (microLeftBtn) microLeftBtn.onclick = () => nudgeStepMicro(-1);
if (microRightBtn) microRightBtn.onclick = () => nudgeStepMicro(1);
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
    if (!hoveredStep) microControls.style.display = "none";
  }, 150);
});
octaveControls.addEventListener("click", (e) => {
  if (e.target !== octaveControls) return;
  sendGridTapFromClient(e.clientX, e.clientY);
});
octaveControls.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  handleCanvasContextMenu(e.clientX, e.clientY);
});
microControls.addEventListener("click", (e) => {
  if (e.target !== microControls) return;
  sendGridTapFromClient(e.clientX, e.clientY);
});
microControls.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  handleCanvasContextMenu(e.clientX, e.clientY);
});
microControls.addEventListener("mouseenter", () => {
  isOverMicroControls = true;
  if (microHideTimer) {
    clearTimeout(microHideTimer);
    microHideTimer = null;
  }
});
microControls.addEventListener("mouseleave", () => {
  isOverMicroControls = false;
  if (microHideTimer) clearTimeout(microHideTimer);
  microHideTimer = setTimeout(() => {
    if (!hoveredStep) microControls.style.display = "none";
  }, 150);
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
initCustomSelects();
loadSavedConfig();
if (uiScaleSel) {
  uiScaleSel.value = "1";
  uiScaleSel.onchange = () => {
    applyUiScale(uiScaleSel.value);
  };
}
applyUiScale(uiScaleSel?.value || uiScale || 1);
applyPatternControlLatchUI();
window.addEventListener("resize", () => {
  syncDeviceTabProgressCanvas();
  renderDeviceTabProgressFrame();
  positionSelectionPopover();
  updateSelectionRectFromCells(selectionByPage[currentPage], selectionRenderOffset || { dx: 0, dy: 0 });
});
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

function addMicroOverlay(page, x, y, microOffset, delta, octave, opts = {}) {
  const pageIdx = Number.isFinite(page) ? page : currentPage;
  if (!overlays[pageIdx]) overlays[pageIdx] = [];
  const rawVal = Number.isFinite(microOffset) ? microOffset : (Number.isFinite(delta) ? delta : 0);
  const showZero = !!opts.showZero;
  if (!rawVal && !showZero) {
    overlays[pageIdx] = overlays[pageIdx].filter((o) => !(o.kind === "micro" && o.x === x && getOverlayRawY(o) === y));
    if (pageIdx === currentPage) renderFrame(frames[currentPage]);
    return;
  }
  const text = rawVal > 0 ? `+${rawVal}` : `${rawVal}`;
  const ts = Date.now();
  overlays[pageIdx] = overlays[pageIdx].filter((o) => !(o.kind === "micro" && o.x === x && getOverlayRawY(o) === y));
  overlays[pageIdx].push({
    x,
    y,
    rawY: y,
    text,
    ts,
    kind: "micro",
    octave: Number.isFinite(octave) ? octave : undefined
  });
  if (pageIdx === currentPage) renderFrame(frames[currentPage]);
}

function handleOctaveOverlayMessage(msg) {
  const page = Number.isFinite(msg.page) ? msg.page : currentPage;
  if (msg.clearAll) {
    overlays[page] = [];
    octaveAnchors[page].clear();
    if (page === currentPage) renderFrame(frames[page]);
  }
  if (page !== currentPage) return;
  if (msg.clearAll || msg.clear || msg.changed) {
    resetOctaveOverlayUI();
    return;
  }
  if (!ENABLE_OCTAVE_SHIFTING || !msg.fromHold) return;
  const y = msg.y + Number(fullScaleMode) - Number(!!msg.uiMode);
  if (y >= 0 && y < getStepRows()) {
    cancelSelectionActions();
    clearSelection();
    showOctaveControlsFromOverlay({ ...msg, y });
  }
}

function handleMicroOverlayMessage(msg) {
  const pageIdx = Number.isFinite(msg.page) ? msg.page : currentPage;
  const rawY = Number.isFinite(msg.rawY) ? msg.rawY : unmapOverlayY(msg.y, 0, fullScaleMode);
  addMicroOverlay(pageIdx, msg.x, rawY, msg.microOffset, msg.delta, msg.octave, { showZero: !!msg.showZero });
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
// if (accent) overlays[pageIdx].push({ x, y, text: "A", ts: Date.now() }); //remove accent overlay display for now
  if (pageIdx === currentPage) renderFrame(frames[currentPage]);
}

function addSlideOverlay(page, x, y, slide) {
  const pageIdx = Number.isFinite(page) ? page : currentPage;
  if (!overlays[pageIdx]) overlays[pageIdx] = [];
  // remove any existing slide overlay but do not show a popup
  overlays[pageIdx] = overlays[pageIdx].filter((o) => !(o.x === x && o.y === y && o.text === "S"));
// if (slide) overlays[pageIdx].push({ x, y, text: "S", ts: Date.now() }); //remove slide overlay display for now
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
      const chainRequest = getChainSelectionForMenu({ x: msg.x, y: msg.y });
      noteMenuTarget = {
        x: msg.x,
        y: msg.y,
        accent: !!msg.accent,
        slide: !!msg.slide,
        canSlide: !!msg.canSlide,
        canAccent: !!msg.canAccent,
        canChain: !!chainRequest,
        chainSteps: chainRequest?.steps || null
      };
      openNoteMenu(clientX, clientY, { ...msg, canChain: !!chainRequest });
    }
    return;
  }
  // Octave hover path
  if (pendingOctaveHover && msg.x === pendingOctaveHover.x && msg.y === pendingOctaveHover.y) {
    const hover = pendingOctaveHover;
    pendingOctaveHover = null;
    if (!msg.on && !msg.octaveAnchor) {
      hoveredStep = null;
      if (!isOverOctaveControls) octaveControls.style.display = "none";
      if (!isOverMicroControls) microControls.style.display = "none";
      return;
    }
    showOctaveControls({ ...hover, octaveAnchor: msg.octaveAnchor });
    if (msg.octaveAnchor) return;
    handleMicroOverlayMessage({
      page: msg.page,
      x: msg.x,
      y: msg.y,
      microOffset: msg.microOffset,
      delta: 0,
      octave: msg.octave,
      showZero: true
    });
  }
}

function handleStepsStateMessage(msg) {
  const requestId = msg.requestId;
  if (!requestId) return;
  const cb = pendingStepsStateRequests.get(requestId);
  if (!cb) return;
  pendingStepsStateRequests.delete(requestId);
  cb(Array.isArray(msg.steps) ? msg.steps : []);
}

function handleMoveStepsResult(msg) {
  const requestId = msg.requestId;
  if (!requestId) return;
  const cb = pendingMoveStepsRequests.get(requestId);
  if (!cb) return;
  pendingMoveStepsRequests.delete(requestId);
  cb(msg);
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
  const num = Math.max(0.75, Math.min(1.25, Number(val) || 1));
  const prev = uiScale;
  uiScale = num;
  // Measure natural (zoom:1) content dimensions before applying the new scale.
  // Temporarily setting --ui-scale to 1 forces a synchronous reflow at zoom:1, giving
  // accurate unscaled dimensions. No visible flicker — the browser paints only after
  // this synchronous task completes, so only the final state (zoom:num) is rendered.
  const appShellEl = document.getElementById("app-shell");
  document.documentElement.style.setProperty("--ui-scale", 1);
  // Only measure height from the DOM — the app width is fixed by design (BASE_WINDOW_WIDTH).
  // Measuring scrollWidth from body/documentElement can return inflated values from
  // absolutely-positioned elements (menus, toasts) that extend beyond the layout width.
  const naturalH = appShellEl
    ? Math.max(appShellEl.scrollHeight || 0, BASE_WINDOW_HEIGHT)
    : BASE_WINDOW_HEIGHT;
  document.documentElement.style.setProperty("--ui-scale", num);
  if (uiScaleSel) uiScaleSel.value = String(num);
  // Send exact target dimensions so the main process doesn't have to guess from BASE_HEIGHT.
  // main.cjs already supports { scale, width, height } and uses the provided values directly.
  window.electronAPI?.resizeForScale?.({
    scale: num,
    width: Math.round(BASE_WINDOW_WIDTH * num),
    height: Math.round(naturalH * num)
  });
  // Fallback resize for non-Electron browser context (window.resizeTo sets outer window
  // size which conflicts with Electron's setContentSize — only use when electronAPI absent)
  if (!window.electronAPI && (!uiScaleInitialized || num !== prev)) {
    uiScaleInitialized = true;
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
  if (window.electronAPI) uiScaleInitialized = true;
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

function setNoteViewOffsetFromUI(offset) {
  const type = sequencerTypes[currentPage] || "mono";
  if (type === "cc") return;
  if (ws?.readyState !== WebSocket.OPEN) return;
  const current = noteViewOffsets[currentPage] || 0;
  const next = Math.max(NOTE_VIEW_ROW_SHIFT_MIN, Math.min(NOTE_VIEW_ROW_SHIFT_MAX, Math.round(offset)));
  if (next === current) return;
  noteViewOffsets[currentPage] = next;
  applyScaleNotesUI();
  ws.send(JSON.stringify({ type: "set_note_view_offset", page: currentPage, offset: next }));
}

function shiftNoteView(delta) {
  setNoteViewOffsetFromUI((noteViewOffsets[currentPage] || 0) + delta);
}

function renderNoteScrollbar() {
  const offset = noteViewOffsets[currentPage] || 0;
  const rows = getStepRows();
  const offscreenPitches = noteViewPitches[currentPage].filter((pitch) => pitch < offset || pitch >= offset + rows);
  const dragging = noteScrollbarDrag?.page === currentPage;
  const hidden = activeUiPage === 0 || isomorphicModes[currentPage] || sequencerTypes[currentPage] === "cc"
    || (!dragging && offscreenPitches.length === 0);
  noteScrollbar.classList.toggle("hidden", hidden);
  if (hidden) return;
  const range = NOTE_VIEW_ROW_SHIFT_MAX - NOTE_VIEW_ROW_SHIFT_MIN;
  const thumbPosition = (NOTE_VIEW_ROW_SHIFT_MAX - offset) / range;
  noteScrollbar.setAttribute("aria-valuenow", offset);
  noteScrollbarThumb.style.top = `${100 * (1 - NOTE_SCROLLBAR_THUMB_FRACTION) * thumbPosition}%`;

  const highestPitch = NOTE_VIEW_ROW_SHIFT_MAX + rows - 1;
  const pitchCount = range + rows;
  noteScrollbarStripes.replaceChildren(...offscreenPitches.map((pitch) => {
    const stripe = document.createElement("span");
    const row = Math.max(0, Math.min(pitchCount - 1, highestPitch - pitch));
    stripe.className = "note-scrollbar-stripe";
    stripe.style.top = `${100 * (row + 0.5) / pitchCount}%`;
    return stripe;
  }));
}

function moveNoteScrollbar({ clientY, shiftKey }) {
  const track = noteScrollbar.getBoundingClientRect();
  const travel = track.height * (1 - NOTE_SCROLLBAR_THUMB_FRACTION);
  const ratio = (clientY - track.top - noteScrollbarDrag.grabOffset) / travel;
  const target = NOTE_VIEW_ROW_SHIFT_MAX - ratio * (NOTE_VIEW_ROW_SHIFT_MAX - NOTE_VIEW_ROW_SHIFT_MIN);
  if (shiftKey || ratio <= 0 || ratio >= 1) {
    setNoteViewOffsetFromUI(target);
    return;
  }
  const startOffset = noteScrollbarDrag.startOffset;
  const rows = getStepRows();
  const delta = target - startOffset;
  const views = Math.sign(delta) * Math.round(Math.abs(delta) / rows);
  setNoteViewOffsetFromUI(startOffset + views * rows);
}

noteScrollbar.style.setProperty("--note-scrollbar-thumb-height", `${100 * NOTE_SCROLLBAR_THUMB_FRACTION}%`);
noteScrollbar.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || noteScrollbarDrag) return;
  event.preventDefault();
  event.stopPropagation();
  noteScrollbar.focus();
  const thumb = noteScrollbarThumb.getBoundingClientRect();
  const onThumb = event.clientY >= thumb.top && event.clientY <= thumb.bottom;
  noteScrollbarDrag = {
    pointer: event.pointerId,
    page: currentPage,
    startOffset: noteViewOffsets[currentPage] || 0,
    grabOffset: onThumb ? event.clientY - thumb.top : thumb.height / 2
  };
  noteScrollbar.setPointerCapture(event.pointerId);
  if (!onThumb) moveNoteScrollbar(event);
});
noteScrollbar.addEventListener("pointermove", (event) => {
  if (noteScrollbarDrag?.pointer === event.pointerId && noteScrollbarDrag.page === currentPage) {
    moveNoteScrollbar(event);
  }
});
noteScrollbar.addEventListener("lostpointercapture", (event) => {
  if (noteScrollbarDrag?.pointer !== event.pointerId) return;
  noteScrollbarDrag = null;
  renderNoteScrollbar();
});
noteScrollbar.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const offset = noteViewOffsets[currentPage] || 0;
  const step = event.shiftKey ? 1 : getStepRows();
  const offsets = {
    ArrowUp: offset + step, ArrowDown: offset - step,
    PageUp: offset + step, PageDown: offset - step,
    Home: NOTE_VIEW_ROW_SHIFT_MAX, End: NOTE_VIEW_ROW_SHIFT_MIN
  };
  if (!Object.hasOwn(offsets, event.key)) return;
  event.preventDefault();
  event.stopPropagation();
  setNoteViewOffsetFromUI(offsets[event.key]);
});

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
  clearNumericOverlays(currentPage);
  resetOctaveOverlayUI();
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
    autoFillBars = !!autoFillToggle.checked;
    sendAutoFillIfChanged(autoFillBars);
  };
}
if (clockOutToggle) {
  clockOutToggle.onchange = () => {
    clockOutEnabled = !!clockOutToggle.checked;
    sendClockOutIfChanged(clockOutEnabled);
  };
}
if (clockOutPortSel) {
  clockOutPortSel.onchange = () => {
    clockOutPortId = clockOutPortSel.value || "";
    sendClockOutDeviceIfChanged(clockOutPortId);
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

function handleGridStatus(connected, status) {
  const prev = gridConnected;
  gridConnected = !!connected;
  if (Array.isArray(status.devices)) gridDevices = status.devices;
  updateMonomeControlsAvailability();
  const preference = status.monomeControlsPreference ?? status.showMonomeControls;
  if (typeof preference === "boolean") showMonomeControls = preference;
  if (status.monomeRotation === 0 || status.monomeRotation === 180) applyMonomeRotation(status.monomeRotation);
  niControllerActive = status.niControllerActive === true;
  applyMonomeControlsUI();
  if (typeof status.fullScaleMode === "boolean") setFullScaleMode(status.fullScaleMode);
  if (gridConnected === prev) return;
  showToast(gridConnected ? "Grid connected" : "Grid disconnected");
}

function getStepRows() {
  return fullScaleMode ? 8 : DEFAULT_STEP_ROWS;
}

// Returns the number of interactive rows for the current sequencer type.
// CC always uses 7 rows (no extra row even when grid is disconnected).
function getEffectiveStepRows() {
  if ((sequencerTypes[currentPage] || "mono") === "cc") return DEFAULT_STEP_ROWS;
  return getStepRows();
}

function mapOverlayY(y, octave, useFullScale) {
  if (!useFullScale) return y;
  if (y === 6 && Number(octave) >= 1) return 0;
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
  if (overlay?.kind === "octave") return overlay.y;
  const rawY = getOverlayRawY(overlay);
  if (!Number.isFinite(rawY)) return overlay?.y ?? 0;
  if (Number.isFinite(overlay?.octave)) {
    return mapOverlayY(rawY, overlay.octave, fullScaleMode);
  }
  if (overlay?.kind === "micro" && fullScaleMode) {
    return mapOverlayY(rawY, 0, fullScaleMode);
  }
  return rawY;
}

function setFullScaleMode(next) {
  const enabled = !!next;
  if (fullScaleMode === enabled) return;
  fullScaleMode = enabled;
  cancelSelectionActions();
  clearSelection();
  resetOctaveOverlayUI();
  document.documentElement.classList.toggle("full-scale", fullScaleMode);
  applyScaleNotesUI();
  applyDrumNotesUI();
  renderFrameIfReady();
}

function refreshUiColors() {
  refreshLedPalette();
  refreshDevicePalette();
  renderTabs({ force: true });
  renderDeviceTabProgressFrame();
  renderFrameIfReady();
}

function setToggleActive(group, value) {
  if (!group) return;
  group.forEach((btn) => {
    if (!btn) return;
    const matches = btn.dataset.value === value;
    btn.classList.toggle("active", matches);
    btn.setAttribute("aria-pressed", matches ? "true" : "false");
  });
}

function applyWhiteMode(next, opts = {}) {
  const mode = next === "cold" ? "cold" : "warm";
  whiteMode = mode;
  document.documentElement.dataset.white = mode;
  setToggleActive([tempWarmBtn, tempColdBtn], mode);
  if (defaultUsesMainWhite && !multiColorDefault) {
    defaultDeviceColor = getCssVar("--fg");
    applyDefaultDeviceColor();
    updateDefaultColorTrigger();
  }
  if (!opts.skipRefresh) refreshUiColors();
}

function applyColorMode(next, opts = {}) {
  const mode = next === "solid" ? "solid" : "pastel";
  colorMode = mode;
  const prevPalette = deviceColorPalette.slice();
  document.documentElement.dataset.colors = mode;
  refreshDevicePalette();
  if (!opts.skipRemap) remapDeviceColors(prevPalette, deviceColorPalette);
  const idx = findPaletteIndex(defaultDeviceColor, prevPalette);
  if (!opts.skipRemap && idx >= 0 && deviceColorPalette[idx]) {
    defaultDeviceColor = deviceColorPalette[idx];
    applyDefaultDeviceColor();
  }
  if (!opts.skipRemap && multiColorDefault) {
    applyMultiColorDefault(true, { skipRender: true, skipUi: true });
  }
  setToggleActive([colorsPastelBtn, colorsSolidBtn], mode);
  if (!opts.skipUi) {
    renderDefaultColorOptions();
    updateDefaultColorTrigger();
  }
  if (!opts.skipRefresh) refreshUiColors();
}

const whiteModeObserver = new MutationObserver((mutations) => {
  if (mutations.some((m) => m.attributeName === "data-white")) {
    refreshUiColors();
  }
});
whiteModeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-white"] });


function applyDeviceBadge() {
  if (devicePill) devicePill.textContent = deviceNames[currentPage] || `(unnamed ${currentPage})`;
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
    const allowed = ["12", "16", "24", "32"];
    const val = String(baseDivision || 16);
    baseNoteLenSel.value = allowed.includes(val) ? val : "16";
  }
}

function applyGateLengthUI() {
  if (gateLengthSel) {
    const allowed = ["25", "50", "75", "100"];
    const val = String(Math.round((gateLength || 1) * 100));
    gateLengthSel.value = allowed.includes(val) ? val : "100";
  }
}

function applyPatternControlLatchUI() {
  if (patternControlLatchToggle) {
    patternControlLatchToggle.checked = !!patternControlLatch;
  }
}

function contrastForColor(color) {
  const fg = resolveCssColorVar("--fg");
  const bg = resolveCssColorVar("--bg");
  const fgContrast = getContrastRatio(color, fg);
  const bgContrast = getContrastRatio(color, bg);
  return fgContrast >= bgContrast ? fg : bg;
}

function renderDefaultColorOptions() {
  if (!defaultColorModalOptions) return;
  if (!deviceColorPalette.length) refreshDevicePalette();
  defaultColorModalOptions.innerHTML = "";
  const activeColor = defaultDeviceColor;
  const activeMulti = multiColorDefault;
  const activeWhite = defaultUsesMainWhite;
  const applySingleColor = (c) => {
    defaultDeviceColor = c;
    multiColorDefault = false;
    defaultUsesMainWhite = false;
    applyDefaultDeviceColor();
    applyDeviceBadge();
    renderTabs();
    renderFrame(frames[currentPage]);
    updateDefaultColorTrigger();
    closeDefaultColorModal();
  };
  const applyMainWhite = () => {
    const white = getCssVar("--fg");
    defaultDeviceColor = white;
    multiColorDefault = false;
    defaultUsesMainWhite = true;
    applyDefaultDeviceColor();
    applyDeviceBadge();
    renderTabs();
    renderFrame(frames[currentPage]);
    updateDefaultColorTrigger();
    closeDefaultColorModal();
  };
  const applyMultiColor = () => {
    defaultUsesMainWhite = false;
    applyMultiColorDefault(true);
    updateDefaultColorTrigger();
    closeDefaultColorModal();
  };
  const whiteSwatch = document.createElement("button");
  whiteSwatch.className = "color-swatch";
  whiteSwatch.dataset.value = "main-white";
  whiteSwatch.style.setProperty("--base", "var(--fg)");
  whiteSwatch.setAttribute("aria-label", "Default color main white");
  whiteSwatch.onclick = applyMainWhite;
  if (activeWhite) whiteSwatch.classList.add("selected");
  defaultColorModalOptions.append(whiteSwatch);

  const multiSwatch = document.createElement("button");
  multiSwatch.className = "color-swatch";
  multiSwatch.dataset.value = "multicolor";
  multiSwatch.style.setProperty("--base",
    "linear-gradient(90deg, var(--dev-1), var(--dev-2), var(--dev-3), var(--dev-4), var(--dev-5), var(--dev-6), var(--dev-7), var(--dev-8))"
  );
  multiSwatch.setAttribute("aria-label", "Default color multicolor");
  multiSwatch.onclick = applyMultiColor;
  if (activeMulti) multiSwatch.classList.add("selected");
  defaultColorModalOptions.append(multiSwatch);

  deviceColorPalette.forEach((c) => {
    const sw = document.createElement("button");
    sw.className = "color-swatch";
    sw.dataset.value = c;
    sw.style.setProperty("--base", c);
    sw.setAttribute("aria-label", `Default color ${c}`);
    sw.onclick = () => applySingleColor(c);
    if (!activeMulti && !activeWhite && c.toLowerCase() === (activeColor || BASE_DEFAULT_DEVICE_COLOR).toLowerCase()) {
      sw.classList.add("selected");
    }
    defaultColorModalOptions.append(sw);
  });
}

function applyDefaultDeviceColor() {
  if (multiColorDefault) {
    if (!deviceColorPalette.length) refreshDevicePalette();
    for (let i = 1; i <= 8; i++) {
      deviceColors[i] = deviceColorPalette[i - 1] || defaultDeviceColor;
      deviceColorOverrides[i] = false;
    }
    return;
  }
  for (let i = 1; i <= 8; i++) {
    if (!deviceColorOverrides[i]) deviceColors[i] = getDefaultDeviceColorForPage(i);
  }
}

function updateDefaultColorTrigger(colorOverride) {
  const color = colorOverride || defaultDeviceColor;
  const isMulti = multiColorDefault;
  const usesMainWhite = defaultUsesMainWhite;
  if (defaultColorTrigger) {
    if (isMulti) {
      defaultColorTrigger.style.setProperty("--base",
        "linear-gradient(90deg, var(--dev-1), var(--dev-2), var(--dev-3), var(--dev-4), var(--dev-5), var(--dev-6), var(--dev-7), var(--dev-8))"
      );
    } else if (usesMainWhite) {
      defaultColorTrigger.style.setProperty("--base", "var(--fg)");
    } else {
      defaultColorTrigger.style.setProperty("--base", color);
    }
    defaultColorTrigger.style.borderColor = "var(--border)";
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
  if (multiColorDefault) return base;
  return defaultDeviceColor;
}

function loadSavedConfig() {
  try {
    const rawFull = localStorage.getItem(LOCAL_CONFIG_KEY);
    const rawLegacy = localStorage.getItem("sgrid_led_config");
    const parsed = rawFull ? JSON.parse(rawFull) : (rawLegacy ? { ledLevels: JSON.parse(rawLegacy) } : null);
    if (!parsed || typeof parsed !== "object") return;
    if (parsed.whiteMode) applyWhiteMode(parsed.whiteMode, { skipRefresh: true });
    if (parsed.colorMode) applyColorMode(parsed.colorMode, { skipRefresh: true });
    if (parsed.ledLevels) ledLevels = { ...DEFAULT_LED_LEVELS, ...parsed.ledLevels };
    if (typeof parsed.multiColorDefault === "boolean") multiColorDefault = parsed.multiColorDefault;
    if (typeof parsed.defaultUsesMainWhite === "boolean") defaultUsesMainWhite = parsed.defaultUsesMainWhite;
    if (typeof parsed.clockSource === "string") {
      clockSource = parsed.clockSource === "external" ? "external" : "internal";
      if (clockSourceSel) clockSourceSel.value = clockSource;
    }
    if (parsed.clockInput) {
      clockInputId = parsed.clockInput;
      const resolved = resolveClockInputId(clockInputId);
      if (resolved) clockInputId = resolved;
      if (clockInputSel) clockInputSel.value = clockInputId;
    }
    if (Array.isArray(parsed.midiSettings)) {
      midiSettings = parsed.midiSettings.slice(0, 9).map((m) => m || { outId: "", channel: 1 });
      applyPageMidi();
    }
    if (Number.isFinite(parsed.baseDivision)) {
      baseDivision = normalizeBaseDivision(parsed.baseDivision);
      applyBaseNoteLenUI();
    }
    if (Number.isFinite(parsed.gateLength)) {
      gateLength = normalizeGateLength(parsed.gateLength);
      applyGateLengthUI();
    }
    if (parsed.isomorphicLayout) {
      isomorphicLayout = sanitizeIsomorphicLayout(parsed.isomorphicLayout);
      applyIsomorphicLayoutUI();
    }
  if (typeof parsed.autoFill === "boolean") {
    autoFillBars = parsed.autoFill;
    if (autoFillToggle) autoFillToggle.checked = autoFillBars;
  }
  if (parsed.defaultDeviceColor && /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.test(parsed.defaultDeviceColor)) {
    defaultDeviceColor = parsed.defaultDeviceColor;
      applyDefaultDeviceColor();
    }
    if (typeof parsed.patternControlLatch === "boolean" && patternControlLatchToggle) {
      patternControlLatch = parsed.patternControlLatch;
      applyPatternControlLatchUI();
    }
  if (typeof parsed.patternControlLatch === "boolean") {
    patternControlLatch = parsed.patternControlLatch;
    applyPatternControlLatchUI();
  }
  if (typeof parsed.showMonomeControls === "boolean") {
    showMonomeControls = parsed.showMonomeControls;
    applyMonomeControlsUI();
  }
  if (parsed.monomeRotation === 0 || parsed.monomeRotation === 180) applyMonomeRotation(parsed.monomeRotation);
  if (typeof parsed.gateLedBoost === "boolean") {
    gateLedBoost = parsed.gateLedBoost;
    applyGateLedBoostUI();
  }
  if (typeof parsed.autoLoadSet === "boolean" && autoLoadToggle) {
    autoLoadToggle.checked = parsed.autoLoadSet;
    autoLoadSet = parsed.autoLoadSet;
  }
    if (typeof parsed.patternControlLatch === "boolean") {
      patternControlLatch = parsed.patternControlLatch;
      applyPatternControlLatchUI();
      if (ws?.readyState === WebSocket.OPEN) {
        sendPatternControlLatchIfChanged(patternControlLatch);
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
      sendClockOutIfChanged(clockOutEnabled);
    }
  }
  if (parsed.clockOutDevice) {
    clockOutPortId = parsed.clockOutDevice;
    applyClockOutUI();
    if (ws?.readyState === WebSocket.OPEN) {
      sendClockOutDeviceIfChanged(clockOutPortId);
    }
  }
  if (Number.isFinite(parsed.uiScale)) {
    applyUiScale(parsed.uiScale);
  }
    if (parsed.defaultDeviceColor && /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.test(parsed.defaultDeviceColor)) {
      defaultDeviceColor = parsed.defaultDeviceColor;
    }
  if (multiColorDefault) {
    applyMultiColorDefault(true, { skipRender: true, skipUi: true });
  } else if (defaultUsesMainWhite) {
    defaultDeviceColor = getCssVar("--fg");
    applyDefaultDeviceColor();
  } else {
    applyDefaultDeviceColor();
  }
  updateDefaultColorTrigger();
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

function pushSavedConfigToServer(opts = {}) {
  if (!cachedConfig || !ws || ws.readyState !== WebSocket.OPEN) return;
  const skipClockSource = !!opts.skipClockSource;
  if (cachedConfig.ledLevels) {
    sendLedLevelsIfChanged(cachedConfig.ledLevels);
  }
  if (cachedConfig.clockSource && !skipClockSource) {
    clockSource = cachedConfig.clockSource;
    sendClockSourceIfChanged(clockSource);
  }
  if (cachedConfig.clockInput) {
    clockInputId = cachedConfig.clockInput;
    sendClockInputIfChanged(clockInputId);
  }
  if (typeof cachedConfig.clockOut === "boolean") {
    clockOutEnabled = !!cachedConfig.clockOut;
    applyClockOutUI();
    sendClockOutIfChanged(clockOutEnabled);
  }
  if (cachedConfig.clockOutDevice) {
    clockOutPortId = cachedConfig.clockOutDevice;
    applyClockOutUI();
    sendClockOutDeviceIfChanged(clockOutPortId);
  }
  if (typeof cachedConfig.autoFill === "boolean") {
    autoFillBars = !!cachedConfig.autoFill;
    sendAutoFillIfChanged(autoFillBars);
  }
  if (cachedConfig.defaultDeviceColor && /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.test(cachedConfig.defaultDeviceColor)) {
    defaultDeviceColor = cachedConfig.defaultDeviceColor;
  }
  if (typeof cachedConfig.multiColorDefault === "boolean") {
    multiColorDefault = cachedConfig.multiColorDefault;
  }
  if (typeof cachedConfig.defaultUsesMainWhite === "boolean") {
    defaultUsesMainWhite = cachedConfig.defaultUsesMainWhite;
  }
  if (multiColorDefault) {
    applyMultiColorDefault(true, { skipRender: true, skipUi: true });
  } else if (defaultUsesMainWhite) {
    defaultDeviceColor = getCssVar("--fg");
    applyDefaultDeviceColor();
  } else {
    applyDefaultDeviceColor();
  }
  if (typeof cachedConfig.baseDivision === "number") {
    baseDivision = normalizeBaseDivision(cachedConfig.baseDivision);
    sendBaseDivisionIfChanged(baseDivision);
  }
  if (typeof cachedConfig.gateLength === "number") {
    gateLength = normalizeGateLength(cachedConfig.gateLength);
    sendGateLengthIfChanged(gateLength);
  }
  if (cachedConfig.isomorphicLayout) {
    isomorphicLayout = sanitizeIsomorphicLayout(cachedConfig.isomorphicLayout);
    applyIsomorphicLayoutUI();
    sendIsomorphicLayoutIfChanged(isomorphicLayout);
  }
  if (typeof cachedConfig.patternControlLatch === "boolean") {
    patternControlLatch = !!cachedConfig.patternControlLatch;
    applyPatternControlLatchUI();
    sendPatternControlLatchIfChanged(patternControlLatch);
  }
  if (typeof cachedConfig.showMonomeControls === "boolean") {
    showMonomeControls = !!cachedConfig.showMonomeControls;
    applyMonomeControlsUI();
    sendMonomeControlsIfChanged(showMonomeControls);
  }
  if (cachedConfig.monomeRotation === 0 || cachedConfig.monomeRotation === 180) {
    applyMonomeRotation(cachedConfig.monomeRotation, { send: true });
  }
  if (typeof cachedConfig.gateLedBoost === "boolean") {
    gateLedBoost = !!cachedConfig.gateLedBoost;
    applyGateLedBoostUI();
    sendGateLedBoostIfChanged(gateLedBoost);
  }
  if (Array.isArray(cachedConfig.midiSettings)) {
    cachedConfig.midiSettings.forEach((m, idx) => {
      const page = idx;
      if (!m || page === 0) return;
      const outId = m.outId || "";
      const channel = m.channel || 1;
      if (!midiSettings[page]) midiSettings[page] = { outId: "", channel: 1 };
      midiSettings[page].outId = outId;
      midiSettings[page].channel = channel;
      sendMidiConfig(page);
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
    input.addEventListener("focus", () => {
      editingDrumInputs.add(input);
    });
    input.addEventListener("blur", () => {
      editingDrumInputs.delete(input);
    });
    input.addEventListener("change", () => {
      const row = Number(input.dataset.row);
      if (!Number.isFinite(row)) return;
      if (row === 7 && !fullScaleMode) return;
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
  if (text && ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "ni_ui_toast", text }));
  }
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
      showToast("Started new project");
    };
  }
}

function openColorModal(page) {
  closeDeviceMenu();
  closeNoteMenu();
  closeDefaultColorModal();
  if (!deviceColorPalette.length) refreshDevicePalette();
  colorModalPage = page;
  if (colorOptions) {
    colorOptions.innerHTML = "";
    deviceColorPalette.forEach((c) => {
      const sw = document.createElement("button");
      sw.className = "color-swatch";
      sw.style.setProperty("--base", c);
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
  const key = String(e.key || "").toLowerCase();
  if ((e.metaKey || e.ctrlKey) && key === "z" && !e.shiftKey) {
    if (isTypingTarget(e.target)) return;
    e.preventDefault();
    performUndo();
    return;
  }
  if (((e.metaKey || e.ctrlKey) && e.shiftKey && key === "z") || (e.ctrlKey && key === "y")) {
    if (isTypingTarget(e.target)) return;
    e.preventDefault();
    performRedo();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    if (isTypingTarget(e.target)) return;
    e.preventDefault();
    adjustTranspose(e.key === "ArrowUp" ? 1 : -1);
    return;
  }
  if (!e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    if (isTypingTarget(e.target)) return;
    e.preventDefault();
    shiftNoteView(e.key === "ArrowUp" ? 1 : -1);
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
    const selection = selectionByPage[currentPage];
    if (selection && selection.size) {
      const dx = e.key === "ArrowLeft" ? -1 : (e.key === "ArrowRight" ? 1 : 0);
      const dy = e.key === "ArrowUp" ? -1 : (e.key === "ArrowDown" ? 1 : 0);
      e.preventDefault();
      performSelectionMove(dx, dy);
      return;
    }
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
  if ((e.key === "Backspace" || e.key === "Delete") && !isTypingTarget(e.target)) {
    const selection = selectionByPage[currentPage];
    if (selection && selection.size) {
      e.preventDefault();
      clearSelectedNotes();
    }
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

function openSaveNameModal(defaultName) {
  return new Promise((resolve) => {
    if (!renameModal || !renameInput) {
      resolve(null);
      return;
    }
    pendingSetSaveResolver = resolve;
    renameMode = "set_name";
    const display = displaySetName(defaultName || "Untitled");
    configureRenameModal({
      title: "Save Project As",
      label: "Project name",
      maxLength: 40,
      inputMode: "",
      value: display
    });
    renameModal.classList.remove("hidden");
    setTimeout(() => renameInput?.focus(), 0);
  });
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
  const prevMode = renameMode;
  if (renameModal) renameModal.classList.add("hidden");
  renameTargetPage = null;
  renameTargetPattern = null;
  renameMode = "device";
  if (prevMode === "set_name" && pendingSetSaveResolver) {
    pendingSetSaveResolver(null);
    pendingSetSaveResolver = null;
  }
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
    if (renameMode === "set_name") {
      const resolver = pendingSetSaveResolver;
      pendingSetSaveResolver = null;
      closeRenameModal();
      resolver?.(raw);
      return;
    }
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
  if (noteMenuChain) {
    const showChain = !!info.canChain;
    noteMenuChain.classList.toggle("hidden", !showChain);
    noteMenuChain.disabled = !showChain;
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
document.addEventListener("pointerdown", (e) => {
  if (deviceMenu && !deviceMenu.classList.contains("hidden") && !deviceMenu.contains(e.target)) {
    closeDeviceMenu();
  }
  if (patternLengthMenu && !patternLengthMenu.classList.contains("hidden") && !patternLengthMenu.contains(e.target)) {
    closePatternLengthMenu();
  }
  if (noteMenu && !noteMenu.classList.contains("hidden") && !noteMenu.contains(e.target)) {
    closeNoteMenu();
  }
}, true);
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
    applySelectionToggle(noteMenuTarget, "accent", next);
    closeNoteMenu();
  };
}
if (noteMenuSlide) {
  noteMenuSlide.onclick = () => {
    if (!noteMenuTarget || !noteMenuTarget.canSlide) return closeNoteMenu();
    const next = !noteMenuTarget.slide;
    applySelectionToggle(noteMenuTarget, "slide", next);
    closeNoteMenu();
  };
}
if (noteMenuChain) {
  noteMenuChain.onclick = () => {
    if (!noteMenuTarget || !noteMenuTarget.canChain || !noteMenuTarget.chainSteps?.length) {
      return closeNoteMenu();
    }
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "create_chain", steps: noteMenuTarget.chainSteps }));
    }
    closeNoteMenu();
  };
}

// studio grid frontend logic: handles UI, WebSocket sync, WebMIDI, rendering the grid canvas, and local config caching.
