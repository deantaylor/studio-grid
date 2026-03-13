import assert from "node:assert/strict";
import { AudioEventScheduler } from "../public/scheduler.js";

const PPQN_EXT = 24;
const INT_MULT = 4;
const TICKS_PER_SECOND_INT = (120 * PPQN_EXT / 60) * INT_MULT;
const TICKS_PER_STEP_INT = (PPQN_EXT / 4) * INT_MULT;

function percentile(sorted, pct) {
  if (!sorted.length) return 0;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((pct / 100) * sorted.length)));
  return sorted[idx];
}

function runSchedulerSimulation() {
  let nowSec = 0;
  const lateness = [];
  const scheduler = new AudioEventScheduler(() => nowSec, { lookaheadMs: 25, scheduleAheadMs: 150 });
  scheduler.setTickTimeResolver((tickInt) => tickInt / TICKS_PER_SECOND_INT);
  scheduler.start((evt, targetTimeSec) => {
    const dispatchCallTimeSec = nowSec;
    const lateMs = (dispatchCallTimeSec - targetTimeSec) * 1000;
    lateness.push(lateMs);
  });

  const durationSec = 60;
  const totalSteps = Math.floor(durationSec * TICKS_PER_SECOND_INT / TICKS_PER_STEP_INT);
  const events = [];
  for (let i = 0; i < totalSteps; i += 1) {
    events.push({ type: "note_on", tick: i * TICKS_PER_STEP_INT, page: 1, offsetMs: 0 });
  }
  scheduler.enqueue(events);
  scheduler.tick();

  while (nowSec < durationSec) {
    const jitterMs = (Math.random() * 10) - 5; // +/- 5ms
    const stepSec = Math.max(0.005, (25 + jitterMs) / 1000);
    nowSec += stepSec;
    scheduler.tick();
  }

  scheduler.stop();
  const lateOnly = lateness.filter((v) => v > 0);
  const sorted = lateOnly.slice().sort((a, b) => a - b);
  const p95 = percentile(sorted, 95);
  const max = sorted.length ? sorted[sorted.length - 1] : 0;
  return { p95, max, count: lateness.length };
}

const { p95, max, count } = runSchedulerSimulation();
assert.ok(count > 0, "scheduler should dispatch events");
assert.ok(p95 <= 5, `p95 lateness should be <= 5ms (got ${p95.toFixed(2)}ms)`);
assert.ok(max <= 10, `max lateness should be <= 10ms (got ${max.toFixed(2)}ms)`);
console.log("Scheduler jitter simulation passed");
