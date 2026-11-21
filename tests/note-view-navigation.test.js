import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import { SGridState } from "../server/state.js";

test("the Monome modifier scrolls the note rows while both scroll LEDs stay dark", () => {
  const state = new SGridState();
  const row = 7;
  const offset = row * 16;
  state.handleGridKey(14, row, 1);

  assert.equal(state.renderLED()[offset + 15], 0);
  assert.equal(state.renderLED()[offset + 13], 0);
  assert.deepEqual(state.handleGridKey(15, row, 1), { type: "note_view_offset", page: 1, offset: 1 });
  assert.equal(state.handleGridKey(15, row, 0), null);
  assert.deepEqual(state.handleGridKey(13, row, 1), { type: "note_view_offset", page: 1, offset: 0 });

  state.setNoteViewOffset(1, 14);
  assert.equal(state.renderLED()[offset + 15], 0);
  assert.equal(state.renderLED()[offset + 13], 0);
  assert.equal(state.handleGridKey(15, row, 1), null);
  assert.equal(state.handleGridKey(15, row, 0), null);
  state.setNoteViewOffset(1, -14);
  assert.equal(state.renderLED()[offset + 13], 0);
  assert.equal(state.renderLED()[offset + 15], 0);
});

test("releasing a scroll key after the modifier leaves the unlatched launcher alone", () => {
  const state = new SGridState();
  state.patternControlLatch = false;
  state.handleGridKey(14, 7, 1);
  assert.equal(state.handleGridKey(15, 7, 1)?.offset, 1);
  state.handleGridKey(14, 7, 0);
  assert.equal(state.handleGridKey(15, 7, 0), null);
  assert.equal(state.patternControlMode, false);

  assert.deepEqual(state.handleGridKey(15, 7, 1), { type: "pattern_control", enabled: true });
  assert.deepEqual(state.handleGridKey(15, 7, 0), { type: "pattern_control", enabled: false });
});

test("scrolling and microtiming use the bottom keys according to which mode started first", async () => {
  const state = new SGridState();
  const step = state.getPattern().steps[2];
  Object.assign(step, { on: true, degree: 5 });
  state.handleGridKey(14, 7, 1);
  state.handleGridKey(2, 1, 1);
  await setTimeout(175);

  assert.equal(state.microtiming.active, true);
  assert.equal(state.handleGridKey(15, 7, 1)?.type, "note_view_offset");
  assert.equal(step.micro, 0);
  state.handleGridKey(14, 7, 0);
  assert.equal(state.handleGridKey(15, 7, 0), null);
  state.handleGridKey(2, 1, 0);

  state.handleGridKey(2, 2, 1);
  await setTimeout(175);
  assert.equal(state.handleGridKey(14, 7, 1)?.type, "micro");
  assert.equal(state.handleGridKey(15, 7, 1)?.type, "micro");
  assert.equal(state.getNoteViewOffset(), 1);
  state.handleGridKey(14, 7, 0);
  state.handleGridKey(15, 7, 0);
  state.handleGridKey(2, 2, 0);
});

test("the app launcher and eighth-row note at the same coordinates remain independent", () => {
  const state = new SGridState();
  const launcher = { uiMode: true, patternLauncher: true };
  const note = { uiMode: true };
  state.handleGridKey(14, 7, 1);

  assert.deepEqual(state.handleGridKey(15, 7, 1, launcher), { type: "pattern_control", enabled: true });
  assert.equal(state.getNoteViewOffset(), 0);
  assert.deepEqual(state.handleGridKey(15, 7, 1, launcher), { type: "pattern_control", enabled: false });

  state.handleGridKey(15, 7, 1, note);
  state.handleGridKey(15, 7, 0, note);
  assert.equal(state.getStepInfo(15, 7, note).on, true);
  assert.equal(state.patternControlMode, false);
});

test("the scrollbar gets the active bar's unique pitches, including offscreen poly notes", () => {
  const state = new SGridState();
  state.setSequencerType(1, "poly");
  const pattern = state.getPattern();
  pattern.length_steps = 17;
  Object.assign(pattern.steps[0], {
    on: true, notes: [0, 4], noteOctaves: { 0: -1, 4: 2 }, octaveOrigins: { 4: 0 }
  });
  Object.assign(pattern.steps[1], { on: true, notes: [4], noteOctaves: { 4: 2 } });
  Object.assign(pattern.steps[16], { on: true, notes: [2] });
  Object.assign(pattern.steps[17], { on: true, notes: [5] });
  assert.deepEqual(state.noteViewPitches(), [-7, 18]);

  state.setBarView(1, 1, 1);
  assert.deepEqual(state.noteViewPitches(), [2]);
  state.setSequencerType(1, "cc");
  assert.deepEqual(state.noteViewPitches(), []);
});

test("the eighth-row layout shows notes on its top row at the upper scroll limit", () => {
  const state = new SGridState();
  state.setNoteViewOffset(1, 14);
  const step = state.getPattern().steps[1];
  Object.assign(step, { on: true, degree: 0, octave: 3 });

  assert.deepEqual(state.noteViewPitches(), [21]);
  assert.ok(state.renderUIFrame()[1] > 0);
});
