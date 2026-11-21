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

test("eight-row note edit keeps the held key and microtiming strip in place at both edges", async () => {
  const options = { uiMode: true };
  for (const row of [0, 7]) {
    const state = new SGridState();
    state.pages[1].sequencerStopped = true;
    const { degree, octaveOffset } = state.getRowInfo(row, options);
    const step = state.getPattern().steps[2];
    Object.assign(step, { on: true, degree, octave: octaveOffset });
    state.handleGridKey(2, row, 1, options);
    await setTimeout(175);
    assert.ok(state.getHeldNoteEdit());
    assert.equal(state.microtiming.active, true);
    const timingRow = row === 0 ? 7 : 0;
    const frame = state.renderUIFrame();
    assert.ok(frame[row * 16 + 2] > 0);
    assert.ok(frame[timingRow * 16 + 7] > frame[timingRow * 16 + 6]);
    assert.equal(state.handleGridKey(8, timingRow, 1, options)?.microOffset, 1);
    state.handleGridKey(8, timingRow, 0, options);
    state.handleGridKey(2, row, 0, options);
    assert.equal(state.microtiming.active, false);
    assert.equal(state.getHeldNoteEdit(), null);
    assert.equal(step.on, true);
    assert.equal(step.micro, 1);
    assert.equal(step.accent, false);
  }
});

test("NI note actions edit the held poly note through repeated octave changes", async () => {
  const state = new SGridState();
  const options = { uiMode: true };
  state.setSequencerType(1, "poly");
  const step = state.getPattern().steps[4];
  Object.assign(step, { on: true, notes: [0, 4] });
  state.handleGridKey(4, 7, 1, options);
  await setTimeout(175);
  assert.equal(state.editHeldNote("octave_up")?.octave, 1);
  assert.equal(state.editHeldNote("octave_up")?.octave, 2);
  assert.equal(state.editHeldNote("accent")?.accent, true);
  assert.equal(state.editHeldNote("slide")?.slide, true);
  assert.equal(state.editHeldNote("slide")?.slide, false);
  assert.equal(state.editHeldNote("octave_down")?.octave, 1);
  state.handleGridKey(4, 7, 0, options);
  assert.deepEqual(step.accented, [0]);
  assert.equal(state.getNoteOctave(step, 0), 1);
  assert.equal(state.getNoteOctave(step, 4), 0);
  assert.equal(state.editHeldNote("accent"), null);

  state.handleGridKey(4, 7, 1, options);
  await setTimeout(175);
  assert.equal(state.getHeldNoteEdit()?.hold.octaveAnchor, true);
  assert.equal(state.editHeldNote("slide")?.slide, true);
  state.handleGridKey(4, 7, 0, options);
  assert.deepEqual(step.noteSlides, { 0: true });
});
