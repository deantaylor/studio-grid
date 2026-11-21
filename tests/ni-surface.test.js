import assert from "node:assert/strict";
import { test } from "node:test";
import { niControlCommand, niSurfaceSnapshot } from "../server/ni-surface.js";
import { SGridState } from "../server/state.js";

test("the NI screen uses the selected Studio Grid track, order, and frame", () => {
  const state = new SGridState();
  state.setDeviceOrder([3, 1, 2, 4, 5, 6, 7, 8]);
  state.setDeviceName(3, "SH-101");
  state.setSequencerType(3, "poly");
  state.setPage(3);
  state.setScale(-1, "minor");
  state.setPatternLength(3, 1, 32);
  state.setBarView(3, 1, 1);
  state.pages[3].patterns[2].steps[0].on = true;
  state.pages[3].pending_pattern = 2;
  const frame = Array(128).fill(0);
  frame[48] = 15;

  const surface = niSurfaceSnapshot(state, frame, "internal");
  assert.equal(surface.name, "SH-101");
  assert.equal(surface.sequencer, "Poly");
  assert.equal(surface.slots[0].page, 3);
  assert.deepEqual(surface.patterns[0], { number: 1, active: true, pending: false, occupied: false, level: 12 });
  assert.deepEqual(surface.patterns[1], { number: 2, active: false, pending: true, occupied: true, level: 6 });
  assert.equal(surface.frame[48], 15);
  assert.deepEqual(surface.parameters.map(({ value }) => value), ["120", "50", "B", "minor", "1", "32", "1x", "2"]);
  assert.deepEqual(niControlCommand(state, { slot: 2 }, "internal"), { type: "set_page", page: 1 });
  assert.deepEqual(niControlCommand(state, { pattern: 8 }, "internal"), { type: "set_pattern", pattern: 8 });
  assert.deepEqual(niControlCommand(state, { dial: -2 }, "internal"), { type: "set_note_view_offset", page: 3, offset: -2 });
});

test("NI patterns mirror the Monome selector levels including queued pulses and occupied slots", () => {
  const state = new SGridState();
  state.patternHeld = true;
  state.pages[1].pending_pattern = 2;
  state.pages[1].patterns[3].steps[0].on = true;
  state.setPatternLength(1, 3, 32);
  for (const pulse of [false, true]) {
    state.pulse = pulse;
    const levels = niSurfaceSnapshot(state, [], "internal").patterns.map(({ level }) => level);
    assert.deepEqual(levels, state.renderLED().slice(112, 120));
    assert.deepEqual(levels.slice(0, 4), [12, pulse ? 12 : 6, 11, 4]);
  }
});

test("NI dial directions shift notes in the current bar without scrolling", () => {
  const state = new SGridState();
  state.setPage(3);
  state.setPattern(2);
  state.setPatternLength(3, 2, 32);
  state.setBarView(3, 2, 1);
  state.setNoteViewOffset(3, 2);
  const pattern = state.getPattern();
  Object.assign(pattern.steps[0], { on: true, degree: 2, notes: [2] });
  const note = Object.assign(pattern.steps[31], { on: true, degree: 2, notes: [2], accent: true });

  for (const [nudge, x, degree] of [["right", 16, 2], ["up", 16, 3], ["left", 31, 3], ["down", 31, 2]]) {
    const command = niControlCommand(state, { nudge }, "internal");
    assert.equal(command.type, "shift_pattern");
    assert.equal(command.bar, 1);
    assert.equal(state.shiftPattern(command.page, command.pattern, command), true);
    assert.equal(pattern.steps[x], note);
    assert.equal(note.degree, degree);
    assert.equal(note.accent, true);
    assert.equal(pattern.steps[0].degree, 2);
    assert.equal(state.getNoteViewOffset(), 2);
  }
  assert.equal(niControlCommand(state, { nudge: "unknown" }, "internal"), null);
});

test("NI knob movement uses the existing app commands and respects the clock and bar bounds", () => {
  const state = new SGridState();
  const turn = (knob, steps = 1, clock = "internal") => niControlCommand(state, { knob, steps }, clock);
  assert.equal(turn(1, 1, "external"), null);
  assert.deepEqual(turn(1), { type: "tempo", bpm: 121 });
  assert.deepEqual(turn(2, -1), { type: "set_swing", swing: 50 });
  assert.deepEqual(turn(3, -1), { type: "set_scale", root: 11, mode: "major" });
  assert.deepEqual(turn(4), { type: "set_scale", root: 0, mode: "minor" });
  assert.deepEqual(turn(5), { type: "set_pattern", pattern: 2 });
  assert.deepEqual(turn(6), { type: "set_pattern_length", pattern: 1, length: 32, silent: true });
  assert.deepEqual(turn(7), { type: "set_pattern_time_scale", pattern: 1, scale: 2 });
  assert.deepEqual(turn(8), { type: "set_bar_view", pattern: 1, bar: 0 });
  assert.equal(turn(9), null);
});

test("track setup uses the selected track and maps knobs one, three and four", () => {
  const state = new SGridState();
  const midiOutputs = [{ id: "synth", name: "Synth MIDI" }, { id: "drum", name: "Drum MIDI" }];
  state.setPage(3);
  state.setMidiConfig(3, { outId: "synth", channel: 7 });
  const setup = () => niSurfaceSnapshot(state, [], "internal", { midiOutputs }).trackSetupParameters;
  const turn = (knob, steps = 1, setupPage = 3) => niControlCommand(state, { knob, steps, setupPage }, "internal", midiOutputs);
  assert.deepEqual(setup(), [{ label: "Type", value: "Mono" }, null, { label: "MIDI Out", value: "Synth MIDI" }, { label: "Ch", value: "7" }]);
  assert.deepEqual(turn(1), { type: "set_seq_type", page: 3, seqType: "poly" });
  assert.equal(turn(2), null);
  assert.deepEqual(turn(3), { type: "set_midi", page: 3, outId: "drum", channel: 7 });
  assert.deepEqual(turn(3, -1), { type: "set_midi", page: 3, outId: "", channel: 7 });
  assert.deepEqual(turn(4, 12), { type: "set_midi", page: 3, outId: "synth", channel: 16 });
  assert.deepEqual(turn(5), { type: "set_pattern", pattern: 2 });
  assert.equal(turn(3, 1, 2), null);
  state.setSequencerType(3, "mdtonal");
  assert.deepEqual(setup()[3], { label: "MD Track", value: "1" });
  assert.deepEqual(turn(4), { type: "set_md_track", page: 3, track: 2 });
});

test("NI row labels follow the visible scale and drum grid and disappear in the launcher", () => {
  const state = new SGridState();
  const labels = (uiMode = true) => niSurfaceSnapshot(state, [], "internal", { uiMode }).rowLabels;
  assert.deepEqual(labels(), ["C", "B", "A", "G", "F", "E", "D", "C"]);
  state.setNoteViewOffset(1, 1);
  assert.deepEqual(labels(), ["D", "C", "B", "A", "G", "F", "E", "D"]);
  assert.equal(labels(false).at(-1), "");
  state.setSequencerType(1, "drum");
  state.setNoteViewOffset(1, 0);
  state.setDrumNote(1, 7, 65);
  assert.deepEqual(labels(), [65, ...state.pages[1].drumNotes.slice(0, 7).reverse()].map(String));
  state.patternControlMode = true;
  assert.deepEqual(labels(), []);
});

test("NI marks the home root once, follows scrolling, and omits the marker in other modes", () => {
  const state = new SGridState();
  const root = (uiMode = true) => niSurfaceSnapshot(state, [], "internal", { uiMode }).rootNoteRow;
  assert.equal(root(), 7);
  assert.equal(root(false), 6);
  state.setNoteViewOffset(1, -2);
  assert.equal(root(), 5);
  state.setNoteViewOffset(1, 1);
  assert.equal(root(), null);
  state.setNoteViewOffset(1, 0);
  state.patternControlMode = true;
  assert.equal(root(), null);
  state.patternControlMode = false;
  for (const type of ["drum", "cc"]) {
    state.setSequencerType(1, type);
    assert.equal(root(), null);
  }
});

test("NI page arrows transpose the current track within the Octave selector's range", () => {
  const state = new SGridState();
  state.setPage(3);
  const arrow = (transposeOctave) => niControlCommand(state, { transposeOctave }, "internal");
  assert.deepEqual(arrow(-1), { type: "set_transpose", page: 3, transpose: -12 });
  assert.deepEqual(arrow(1), { type: "set_transpose", page: 3, transpose: 12 });
  state.setTranspose(3, 24);
  assert.equal(arrow(1), null);
  assert.deepEqual(arrow(-1), { type: "set_transpose", page: 3, transpose: 12 });
  state.setTranspose(3, -24);
  assert.equal(arrow(-1), null);
  for (const type of ["drum", "cc"]) {
    state.setSequencerType(3, type);
    assert.equal(arrow(1), null);
  }
});
