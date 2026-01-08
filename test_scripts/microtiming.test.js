import assert from "node:assert/strict";
import { SGridState } from "../server/state.js";

function setupState() {
  const state = new SGridState();
  const pat = state.pages[1].patterns[1];
  pat.length_steps = 2;
  pat.steps[0].on = true;
  pat.steps[0].degree = 0;
  pat.steps[1].on = true;
  pat.steps[1].degree = 0;
  return { state, pat };
}

function testMicroClamp() {
  const { state } = setupState();
  const res = state.setStepMicroOffset(0, 6, 999);
  assert.ok(res, "setStepMicroOffset should return a result");
  assert.equal(res.microOffset, 23, "micro offset clamps to max internal ticks per step");
  const back = state.setStepMicroOffset(0, 6, -999);
  assert.equal(back.microOffset, -23, "micro offset clamps negative values");
}

function testEarlyWrapScheduling() {
  const { state } = setupState();
  // Set step 0 to a negative micro offset so it should schedule early in the next window.
  state.setStepMicroOffset(0, 6, -23);
  const stepMs = state.stepDurationMs(1);

  // Process step 0 (transport tick 0), then step 1 (transport tick 6).
  state.tick(false, stepMs, 0);
  const { midiEvents } = state.tick(false, stepMs, 6);
  const early = midiEvents.find((ev) => ev.type === "midi_note" && Number.isFinite(ev.tick) && ev.tick > 24 && ev.tick < 48);
  assert.ok(early, "expected early-scheduled note event for wrapped step 0");
  assert.ok(early.tick > 24, "early event should occur after current step start");
}

testMicroClamp();
testEarlyWrapScheduling();
console.log("Microtiming tests passed");
