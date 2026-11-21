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
  assert.deepEqual(surface.patterns[0], { number: 1, active: true, pending: false, occupied: false });
  assert.deepEqual(surface.patterns[1], { number: 2, active: false, pending: true, occupied: true });
  assert.equal(surface.frame[48], 15);
  assert.deepEqual(surface.parameters.map(({ value }) => value), ["120", "50", "B", "minor", "1", "32", "1x", "2"]);
  assert.deepEqual(niControlCommand(state, { slot: 2 }, "internal"), { type: "set_page", page: 1 });
  assert.deepEqual(niControlCommand(state, { pattern: 8 }, "internal"), { type: "set_pattern", pattern: 8 });
  assert.deepEqual(niControlCommand(state, { dial: -2 }, "internal"), { type: "set_note_view_offset", page: 3, offset: -2 });
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
