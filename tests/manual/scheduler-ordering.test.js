import assert from "node:assert/strict";
import { AudioEventScheduler } from "../../public/scheduler.js";

function collectOrder(events) {
  const scheduled = [];
  const scheduler = new AudioEventScheduler(() => 0, { lookaheadMs: 1, scheduleAheadMs: 500 });
  scheduler.setTickTimeResolver(() => 0);
  scheduler.start((evt) => {
    scheduled.push({ type: evt.type, page: evt.page });
  });
  scheduler.enqueue(events);
  scheduler.tick();
  scheduler.stop();
  return scheduled;
}

function testPriorityOrdering() {
  const events = [
    { type: "note_on", tick: 0, page: 1, offsetMs: 0 },
    { type: "cc", tick: 0, page: 1, offsetMs: 0 },
    { type: "note_off", tick: 0, page: 1, offsetMs: 0 }
  ];
  const order = collectOrder(events).map((e) => e.type);
  assert.deepEqual(order, ["note_on", "cc", "note_off"]);
}

function testTrackOrdering() {
  const events = [
    { type: "note_on", tick: 0, page: 2, offsetMs: 0 },
    { type: "note_on", tick: 0, page: 1, offsetMs: 0 }
  ];
  const order = collectOrder(events).map((e) => e.page);
  assert.deepEqual(order, [2, 1]);
}

testPriorityOrdering();
testTrackOrdering();
console.log("Scheduler ordering tests passed");
