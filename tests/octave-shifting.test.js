import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import { SGridState } from "../server/state.js";

test("the UI keeps the original key dim and uses it to edit the shifted note", () => {
  const state = new SGridState();
  const step = state.getPattern().steps[0];
  Object.assign(step, { on: true, degree: 0, accent: true, micro: -3 });

  assert.equal(state.setStepOctave(0, 7, 1, { uiMode: true })?.octave, 1);
  assert.equal(step.accent, true);
  assert.equal(step.micro, -3);
  assert.deepEqual(state.octaveOverlaySnapshot()[1], []);
  assert.deepEqual(state.octaveOverlaySnapshot({ uiMode: true })[1], [{ x: 0, y: 0, octave: 1 }]);
  assert.deepEqual(state.octaveAnchorCells({ uiMode: true }), [7 * 16]);
  assert.equal(state.renderUIFrame()[7 * 16], 2);
  assert.equal(state.renderLED()[6 * 16], 2);
  assert.equal(state.getStepInfo(0, 7, { uiMode: true }).on, false);
  assert.equal(state.getStepInfo(0, 7, { uiMode: true }).octaveAnchor, true);
  assert.equal(state.setStepOctave(0, 7, 1, { uiMode: true })?.octave, 2);
  assert.deepEqual(state.octaveAnchorCells({ uiMode: true }), [7 * 16]);
  assert.equal(state.setStepOctave(0, 7, -2, { uiMode: true })?.octave, 0);
  assert.deepEqual(state.octaveAnchorCells({ uiMode: true }), []);
  assert.equal(state.getStepInfo(0, 7, { uiMode: true }).on, true);
});

test("a poly octave edit follows the scrolled row and changes only the target note", () => {
  const state = new SGridState();
  state.setSequencerType(1, "poly");
  assert.equal(state.setNoteViewOffset(1, 2), true);
  const step = state.getPattern().steps[0];
  Object.assign(step, { on: true, notes: [1, 4], noteOctaves: { 1: 1, 4: 0 }, accented: [1] });

  assert.equal(state.setStepOctave(0, 0, -1)?.octave, 0);
  assert.deepEqual(step.noteOctaves, { 1: 0, 4: 0 });
  assert.deepEqual(step.notes, [1, 4]);
  assert.deepEqual(step.accented, [1]);
  assert.equal(state.getStepInfo(0, 0).octaveAnchor, true);
  assert.equal(state.getStepInfo(0, 4).octaveAnchor, false);
  const reloaded = new SGridState();
  reloaded.loadSnapshot(state.snapshot());
  assert.equal(reloaded.getStepInfo(0, 0).octaveAnchor, true);
  assert.equal(reloaded.setStepOctave(0, 0, 1)?.octave, 1);
  assert.equal(reloaded.getStepInfo(0, 0).octaveAnchor, false);
});

test("a shifted note plays once and deleting it removes the dim key", () => {
  const state = new SGridState();
  Object.assign(state.getPattern().steps[0], { on: true, degree: 0 });
  state.setStepOctave(0, 7, 1, { uiMode: true });
  const { midiEvents } = state.tick(false, state.stepDurationMs(1), 0);
  assert.deepEqual(midiEvents.filter((event) => event.type === "midi_note").map((event) => event.pitch), [60]);
  state.handleGridKey(0, 0, 1, { uiMode: true });
  state.handleGridKey(0, 0, 0, { uiMode: true });
  assert.deepEqual(state.octaveAnchorCells({ uiMode: true }), []);
});

test("Monome octave buttons can shift the same held note more than once", async () => {
  const state = new SGridState();
  const step = state.getPattern().steps[0];
  Object.assign(step, { on: true, degree: 4 });
  state.handleGridKey(0, 2, 1);
  await setTimeout(175);

  assert.equal(state.handleGridKey(15, 3, 1)?.octave, 1);
  state.handleGridKey(15, 3, 0);
  state.handleGridKey(0, 2, 0);
  assert.equal(state.renderLED()[2 * 16], 2);

  state.handleGridKey(0, 2, 1);
  state.handleGridKey(0, 2, 0);
  assert.equal(step.octave, 1);
  assert.equal(step.accent, false);

  state.handleGridKey(0, 2, 1);
  assert.equal(state.handleGridKey(15, 2, 1)?.octave, 2);
  state.handleGridKey(15, 2, 0);
  assert.equal(state.handleGridKey(15, 2, 1)?.octave, 0);
  state.handleGridKey(15, 2, 0);
  state.handleGridKey(0, 2, 0);

  assert.equal(step.on, true);
  assert.equal(step.octave, 0);
  assert.equal(step.accent, false);
});
