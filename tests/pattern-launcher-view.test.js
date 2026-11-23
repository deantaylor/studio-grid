import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import { SGridState } from "../server/state.js";

const LAUNCHER_KEY = [15, 7];

test("transport resets preserve the launcher until its control is released", () => {
  const state = new SGridState();
  state.patternControlLatch = false;
  assert.equal(state.handleGridKey(...LAUNCHER_KEY, 1)?.enabled, true);
  state.resetTickCounters();
  assert.equal(state.patternControlMode, true);
  assert.equal(state.patternControlHeld, true);
  assert.equal(state.handleGridKey(...LAUNCHER_KEY, 0)?.enabled, false);
});

test("the launcher frame and keys take precedence over the isomorphic view", () => {
  const state = new SGridState();
  state.setIsomorphicMode(1, true);
  assert.equal(state.handleGridKey(2, 3, 1)?.type, "isomorphic_note");
  assert.equal(state.handleGridKey(...LAUNCHER_KEY, 1)?.enabled, true);
  assert.deepEqual(state.renderLED(), state.renderPatternControlLED());
  assert.deepEqual(state.renderUIFrame(), state.renderPatternControlLED());
  assert.equal(state.handleGridKey(2, 3, 1), null);
  assert.equal(state.handleGridKey(...LAUNCHER_KEY, 1)?.enabled, false);
  assert.equal(state.handleGridKey(2, 3, 1)?.type, "isomorphic_note");
});

test("opening the launcher cancels a held note's microtiming edit", async () => {
  const state = new SGridState();
  const step = state.getPattern().steps[2];
  Object.assign(step, { on: true, degree: state.getRowInfo(4).degree });
  state.handleGridKey(2, 4, 1);
  await setTimeout(175);
  assert.equal(state.microtiming.active, true);

  assert.equal(state.handleGridKey(...LAUNCHER_KEY, 1, { patternLauncher: true })?.enabled, true);
  assert.equal(state.microtiming.active, false);
  assert.equal(state.getHeldNoteEdit(), null);
  assert.deepEqual(state.renderLED(), state.renderPatternControlLED());
  state.handleGridKey(8, 0, 1);
  state.handleGridKey(2, 4, 0);
  assert.equal(step.micro, 0);
  assert.equal(step.on, true);
});
