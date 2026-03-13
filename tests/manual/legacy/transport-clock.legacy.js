import assert from "node:assert/strict";
import { TransportClock } from "../../public/transport-clock.js";

const PPQN_EXT = 24;
const INT_MULT = 4;

function testInternalClock() {
  const clock = new TransportClock({ ppqnExt: PPQN_EXT, intMult: INT_MULT });
  clock.setInternalTempo(120);
  clock.startInternal({ tickExt: 0, timeSec: 10 });
  const tickInt = 96; // one quarter note
  const timeSec = clock.tickToTimeSec(tickInt);
  assert.ok(Math.abs(timeSec - 10.5) < 1e-6, `expected 10.5s, got ${timeSec}`);
  const tickExt = clock.timeSecToTickExt(10.5);
  assert.ok(Math.abs(tickExt - 24) < 1e-6, `expected 24 ticks, got ${tickExt}`);
}

function testExternalClock() {
  const clock = new TransportClock({ ppqnExt: PPQN_EXT, intMult: INT_MULT });
  clock.syncExternal({ tickExt: 10, timeSec: 3, intervalSec: 1 });
  const tickInt = 13 * INT_MULT;
  const timeSec = clock.tickToTimeSec(tickInt);
  assert.ok(Math.abs(timeSec - 6) < 1e-6, `expected 6s, got ${timeSec}`);
  const tickExt = clock.timeSecToTickExt(6);
  assert.ok(Math.abs(tickExt - 13) < 1e-6, `expected 13 ticks, got ${tickExt}`);
}

testInternalClock();
testExternalClock();
console.log("TransportClock tests passed");
