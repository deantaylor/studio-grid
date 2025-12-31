import assert from "node:assert/strict";
import { MGridState } from "./state.js";

function calcMidiClockBpm({ tempo, bars = 16, baseDivision = 16 }) {
  const state = new MGridState();
  state.setTempo(tempo);
  state.setBaseDivision(baseDivision);
  // One sequencer tick = one 16th note (base division), pulses per tick = 96/div
  const pulsesPerTick = Math.max(1, Math.round(96 / state.baseDivision));
  const ticksPerBar = 16; // 4/4: 16 sixteenth-notes per bar
  const totalTicks = ticksPerBar * bars;
  const totalPulses = pulsesPerTick * totalTicks;
  const msPerTick = state.stepDurationMs(1);
  const totalMs = msPerTick * totalTicks;
  const derivedBpm = (totalPulses * 2500) / totalMs; // pulses/sec * 60 / 24 -> pulses * 2500 / ms
  return { derivedBpm, totalPulses, totalMs, msPerTick };
}

function testMidiClockBpm() {
  const targetBpm = 133;
  const { derivedBpm, totalPulses, totalMs, msPerTick } = calcMidiClockBpm({ tempo: targetBpm, bars: 16 });
  const diff = Math.abs(derivedBpm - targetBpm);
  assert.ok(diff < 0.001, `Derived BPM should match target (got ${derivedBpm.toFixed(6)}, expected ${targetBpm})`);
  console.log(`Target BPM: ${targetBpm}`);
  console.log(`Derived BPM: ${derivedBpm.toFixed(6)}`);
  console.log(`Total pulses (16 bars): ${totalPulses}`);
  console.log(`Per-tick ms: ${msPerTick.toFixed(6)}, total ms: ${totalMs.toFixed(3)}`);
}

testMidiClockBpm();
console.log("MIDI clock BPM test passed");
