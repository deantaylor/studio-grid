import assert from "node:assert/strict";
import { MGridState } from "./state.js";

function makeFlatPattern(steps = 8) {
  const state = new MGridState();
  const pat = state.pages[1].patterns[1];
  pat.length_steps = steps;
  for (let i = 0; i < steps; i++) {
    pat.steps[i].on = true;
    pat.steps[i].degree = 0;
    pat.steps[i].octave = 0;
  }
  return state;
}

function collectNoteOnTimes({ state, intervalsMs }) {
  const starts = [];
  let now = 0;
  intervalsMs.forEach((interval) => {
    const { midiEvents } = state.tick(false, interval);
    midiEvents
      .filter((ev) => ev.type === "midi_note")
      .forEach((ev) => {
        const start = now + (ev.delayMs || 0);
        starts.push(start);
      });
    now += interval;
  });
  return starts;
}

function deltas(arr) {
  const out = [];
  for (let i = 1; i < arr.length; i++) {
    out.push(arr[i] - arr[i - 1]);
  }
  return out;
}

function maxAbsDiff(a, b) {
  let max = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    max = Math.max(max, Math.abs(a[i] - b[i]));
  }
  return max;
}

function testNoteTimingConsistency() {
  // Slightly jittery external clock intervals (ms per 16th).
  const intervals = [90, 85, 92, 88, 90, 87, 93, 89];
  const state = makeFlatPattern(intervals.length);
  const starts = collectNoteOnTimes({ state, intervalsMs: intervals });
  assert.equal(starts.length, intervals.length, "one note per tick");

  const measured = deltas(starts);
  const expected = intervals.slice(0, measured.length);
  const maxDiff = maxAbsDiff(measured, expected);
  assert.ok(
    maxDiff < 1.1,
    `measured intervals should match incoming pulses (max diff ${maxDiff.toFixed(2)}ms)`
  );

  console.log("Note timing intervals (ms):", measured.map((n) => n.toFixed(2)).join(", "));
  console.log("Max diff vs incoming intervals:", maxDiff.toFixed(3), "ms");
}

testNoteTimingConsistency();
console.log("Note timing consistency test passed");
