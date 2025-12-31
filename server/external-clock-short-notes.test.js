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

function collectNoteEvents(state, { ticks = 8, tickIntervalMs }) {
  const events = [];
  let now = 0;
  for (let i = 0; i < ticks; i++) {
    const { midiEvents } = state.tick(false, tickIntervalMs);
    midiEvents
      .filter((ev) => ev.type === "midi_note")
      .forEach((ev) => {
        const start = now + (ev.delayMs || 0);
        const end = start + (ev.durMs || 0);
        events.push({ start, end, pitch: ev.pitch });
      });
    now += tickIntervalMs;
  }
  return events;
}

function audibleDurations(events) {
  const lastOffByPitch = new Map();
  return events.map((ev) => {
    const prevOff = lastOffByPitch.get(ev.pitch) ?? -Infinity;
    // If the previous note-off for this pitch lands after the new note starts,
    // it will prematurely cut the new note on most synths.
    const interrupt = prevOff > ev.start ? prevOff : Infinity;
    const audibleEnd = Math.min(ev.end, interrupt);
    const dur = Math.max(0, audibleEnd - ev.start);
    lastOffByPitch.set(ev.pitch, ev.end);
    return dur;
  });
}

function testExternalClockUsesPulseIntervalsForGates() {
  // Simulate an external clock running faster (180 BPM) than the sequencer tempo (120 BPM).
  // Gate lengths should follow the external pulse spacing, not the slower tempo-derived length.
  const state = makeFlatPattern(8);
  state.setTempo(120); // internal gate length ~125ms (minus epsilon)
  const extSixteenthMs = (60000 / 180) / 4; // ~83ms between ticks from external clock
  const events = collectNoteEvents(state, { ticks: 8, tickIntervalMs: extSixteenthMs });
  const durations = audibleDurations(events);

  assert.equal(events.length, 8, "should emit one note per step");
  const expected = extSixteenthMs - state.noteOffEpsilonMs;
  durations.forEach((d, idx) => {
    assert.ok(d > expected * 0.8, `gate ${idx} should not be heavily shortened`);
    assert.ok(Math.abs(d - expected) < 10, `gate ${idx} should track external interval`);
  });
}

testExternalClockUsesPulseIntervalsForGates();
console.log("External clock short-gate test passed");
