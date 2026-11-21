const SCALE_MODES = [
  "major", "minor", "dorian", "mixolydian", "lydian", "phrygian", "locrian",
  "harmonic_minor", "melodic_minor", "whole_tone", "chromatic"
];
const NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
const SEQUENCER_TYPES = { mono: "Mono", poly: "Poly", drum: "Drum", cc: "Control Change", mdtonal: "MDTonal" };
const LENGTHS = [16, 32, 48, 64];
const PATTERN_SCALES = [1, 2, 4];
const NUDGE_DIRECTIONS = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const pitchClass = (value) => ((value % 12) + 12) % 12;

function stepChoice(choices, current, steps) {
  const index = choices.indexOf(current);
  if (index !== -1) return choices[clamp(index + steps, 0, choices.length - 1)];
  return steps > 0 ? (choices.find((choice) => choice > current) ?? choices.at(-1))
    : (choices.findLast((choice) => choice < current) ?? choices[0]);
}

export function niSurfaceSnapshot(state, frame, clockSource, { uiMode = true, midiOutputs = [] } = {}) {
  const page = state.currentPage;
  const track = state.pages[page];
  const pattern = state.getPattern();
  const length = pattern.length_steps;
  const midi = state.midi[page];
  const mdtonal = track.sequencerType === "mdtonal";
  const noteEdit = state.getHeldNoteEdit();
  const rowLabels = [];
  let rootNoteRow = null;
  if (!state.patternControlMode && !state.isIsomorphicMode(page) && track.sequencerType !== "cc") {
    const intervals = state.getScaleIntervals(state.scale.mode);
    for (let y = 0; y < 8; y += 1) {
      const row = state.getRowInfo(y, { uiMode });
      if (!row.stepRow) rowLabels.push("");
      else if (track.sequencerType === "drum") rowLabels.push(String(state.getDrumPitch(track, row.degree, row.octaveOffset)));
      else {
        rowLabels.push(NOTE_NAMES[pitchClass(state.scale.root + (intervals[row.degree] ?? 0))]);
        if (row.degree === 0 && row.octaveOffset === 0) rootNoteRow = y;
      }
    }
  }
  return {
    page,
    patternLauncherActive: state.patternControlMode,
    noteEdit: noteEdit ? {
      canAccent: noteEdit.info.canAccent,
      accent: noteEdit.info.accent,
      canSlide: noteEdit.canSlide,
      slide: noteEdit.info.slide,
      canOctave: state.isOctaveShiftingEnabled() && noteEdit.info.seqType !== "drum"
    } : null,
    rowLabels,
    rootNoteRow,
    slots: state.deviceOrder.map((device, index) => ({
      number: index + 1,
      page: device,
      color: state.deviceColors[device]
    })),
    name: state.deviceNames[page] || String(page),
    sequencer: SEQUENCER_TYPES[track.sequencerType] || SEQUENCER_TYPES.mono,
    trackSetupParameters: [
      { label: "Type", value: SEQUENCER_TYPES[track.sequencerType] || SEQUENCER_TYPES.mono },
      null,
      { label: "MIDI Out", value: midi.outId ? (midiOutputs.find(({ id }) => id === midi.outId)?.name || "Unavailable") : "None" },
      mdtonal ? { label: "MD Track", value: String(track.mdTrack || 1) }
        : { label: "Ch", value: String(midi.channel || 1) }
    ],
    patterns: Array.from({ length: 8 }, (_, index) => {
      const number = index + 1;
      return {
        number,
        active: number === track.active_pattern,
        pending: number === track.pending_pattern,
        occupied: state.patternHasData(page, number),
        level: state.patternSelectorLevel(page, number)
      };
    }),
    parameters: [
      { label: "Tempo", value: String(state.tempo), disabled: clockSource === "external" },
      { label: "Swing", value: String(state.swing) },
      { label: "Key", value: NOTE_NAMES[pitchClass(state.scale.root)] },
      { label: "Scale", value: state.scale.mode.replaceAll("_", " ") },
      { label: "Pattern", value: String(track.active_pattern), pending: track.pending_pattern },
      { label: "Length", value: String(length) },
      { label: "Scale", value: `${pattern.time_scale || 1}x` },
      { label: "Bar", value: String((pattern.barView || 0) + 1), count: Math.ceil(length / 16) }
    ],
    frame
  };
}

export function niControlCommand(state, data, clockSource, midiOutputs = []) {
  const { slot, pattern: patternSlot, dial, nudge, knob, steps, transposeOctave, setupPage } = data;
  if (Number.isInteger(slot) && slot >= 1 && slot <= 8) {
    const page = state.deviceOrder[slot - 1];
    return { type: "set_page", page };
  }
  if (Number.isInteger(patternSlot) && patternSlot >= 1 && patternSlot <= 8) {
    return { type: "set_pattern", pattern: patternSlot };
  }
  if (transposeOctave === 1 || transposeOctave === -1) {
    const page = state.currentPage;
    const track = state.pages[page];
    if (track.sequencerType === "drum" || track.sequencerType === "cc") return null;
    const current = track.transpose || 0;
    const transpose = clamp(Math.round(current / 12) + transposeOctave, -2, 2) * 12;
    return transpose === current ? null : { type: "set_transpose", page, transpose };
  }
  if (Number.isInteger(dial) && Math.abs(dial) <= 64 && dial !== 0) {
    return {
      type: "set_note_view_offset",
      page: state.currentPage,
      offset: state.getNoteViewOffset() + dial
    };
  }
  if (typeof nudge === "string" && Object.hasOwn(NUDGE_DIRECTIONS, nudge)) {
    if (state.getHeldNoteEdit()) return null;
    const [dx, dy] = NUDGE_DIRECTIONS[nudge];
    const page = state.currentPage;
    const pattern = state.pages[page].active_pattern;
    return { type: "shift_pattern", page, pattern, bar: state.getPattern().barView || 0, dx, dy };
  }
  if (!Number.isInteger(steps) || steps === 0 || Math.abs(steps) > 64) return null;
  const page = state.currentPage;
  const track = state.pages[page];
  if (setupPage != null && setupPage !== page) return null;
  if (setupPage === page && knob <= 4) {
    const midi = state.midi[page];
    const outId = midi.outId || "";
    const channel = midi.channel || 1;
    switch (knob) {
      case 1: {
        const seqType = stepChoice(Object.keys(SEQUENCER_TYPES), track.sequencerType, steps);
        return seqType === track.sequencerType ? null : { type: "set_seq_type", page, seqType };
      }
      case 3: {
        const choices = ["", ...midiOutputs.map(({ id }) => id)];
        const index = Math.max(0, choices.indexOf(outId));
        const next = choices[clamp(index + steps, 0, choices.length - 1)];
        return next === outId ? null : { type: "set_midi", page, outId: next, channel };
      }
      case 4: {
        if (track.sequencerType === "mdtonal") return { type: "set_md_track", page, track: clamp((track.mdTrack || 1) + steps, 1, 16) };
        return { type: "set_midi", page, outId, channel: clamp(channel + steps, 1, 16) };
      }
      default:
        return null;
    }
  }
  const pattern = state.getPattern();
  const selectedPattern = track.active_pattern;
  switch (knob) {
    case 1:
      return clockSource === "external" ? null : { type: "tempo", bpm: clamp(Math.round(state.tempo) + steps, 20, 300) };
    case 2:
      return { type: "set_swing", swing: clamp(state.swing + steps, 50, 80) };
    case 3:
      return { type: "set_scale", root: pitchClass(state.scale.root + steps), mode: state.scale.mode };
    case 4:
      return { type: "set_scale", root: state.scale.root, mode: stepChoice(SCALE_MODES, state.scale.mode, steps) };
    case 5:
      return { type: "set_pattern", pattern: clamp((track.pending_pattern || selectedPattern) + steps, 1, 8) };
    case 6:
      return { type: "set_pattern_length", pattern: selectedPattern, length: stepChoice(LENGTHS, pattern.length_steps, steps), silent: true };
    case 7:
      return { type: "set_pattern_time_scale", pattern: selectedPattern, scale: stepChoice(PATTERN_SCALES, pattern.time_scale || 1, steps) };
    case 8:
      return { type: "set_bar_view", pattern: selectedPattern, bar: clamp((pattern.barView || 0) + steps, 0, Math.ceil(pattern.length_steps / 16) - 1) };
    default:
      return null;
  }
}
