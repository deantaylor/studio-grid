import assert from "node:assert/strict";
import { SGridState } from "../server/state.js";

function makeFlatPattern(steps = 8) {
  const state = new SGridState();
  const pat = state.pages[1].patterns[1];
  pat.length_steps = steps;
  for (let i = 0; i < steps; i++) {
    pat.steps[i].on = true;
    pat.steps[i].degree = 0;
    pat.steps[i].octave = 0;
  }
  return state;
}

function collectNoteOnTimes({ state, ticks }) {
  const starts = [];
  let now = 0;
  for (let i = 0; i < ticks; i++) {
    const { midiEvents } = state.tick(false, null); // internal clock path
    midiEvents
      .filter((ev) => ev.type === "midi_note")
      .forEach((ev) => {
        const start = now + (ev.delayMs || 0);
        starts.push(start);
      });
    // advance simulated time by internal base interval
    const stepMs = state.stepDurationMs(1);
    now += stepMs;
  }
  return { starts, stepMs: state.stepDurationMs(1) };
}

function deltas(arr) {
  const out = [];
  for (let i = 1; i < arr.length; i++) out.push(arr[i] - arr[i - 1]);
  return out;
}

function testInternalClockAccuracyAt130() {
  const state = makeFlatPattern(16);
  state.setTempo(130);
  const { starts, stepMs } = collectNoteOnTimes({ state, ticks: 16 });
  const intervals = deltas(starts);
  const expected = stepMs;
  const maxDiff = intervals.reduce((m, v) => Math.max(m, Math.abs(v - expected)), 0);
  const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;

  assert.ok(Math.abs(avg - expected) < 0.01, `avg interval should match expected (${avg} vs ${expected})`);
  assert.ok(maxDiff < 0.05, `max deviation should be small (got ${maxDiff} ms)`);

  console.log(`Expected step (ms): ${expected.toFixed(3)}`);
  console.log(`Avg interval (ms): ${avg.toFixed(3)}`);
  console.log(`Max deviation (ms): ${maxDiff.toFixed(3)}`);
}

testInternalClockAccuracyAt130();
console.log("Internal clock accuracy test passed");
