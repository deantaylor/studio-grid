export class AudioEventScheduler {
  constructor(timeProvider, { lookaheadMs = 15, scheduleAheadMs = 150 } = {}) {
    this.timeProvider = timeProvider;
    this.lookaheadMs = lookaheadMs;
    this.scheduleAheadSec = scheduleAheadMs / 1000;
    this.queue = [];
    this.resolveTickTime = null;
    this.timer = null;
    this.scheduleFn = null;
  }

  setTimeProvider(provider) {
    this.timeProvider = provider;
  }

  setTickTimeResolver(resolver) {
    this.resolveTickTime = resolver;
  }

  enqueue(events) {
    if (!Array.isArray(events) || !events.length) return;
    events.forEach((evt) => {
      if (!evt || typeof evt.tick !== "number") return;
      this.queue.push({ ...evt });
    });
  }

  clear() {
    this.queue = [];
  }

  start(scheduleFn) {
    this.scheduleFn = scheduleFn;
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.lookaheadMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  nowSec() {
    if (!this.timeProvider) return null;
    if (typeof this.timeProvider === "function") return this.timeProvider();
    if (typeof this.timeProvider.currentTime === "number") return this.timeProvider.currentTime;
    return null;
  }

  tick() {
    if (!this.scheduleFn || !this.resolveTickTime) return;
    const now = this.nowSec();
    if (!Number.isFinite(now)) return;
    const horizon = now + this.scheduleAheadSec;
    const nextQueue = [];
    this.queue.forEach((evt) => {
      const baseTime = this.resolveTickTime(evt.tick);
      if (!Number.isFinite(baseTime)) {
        nextQueue.push(evt);
        return;
      }
      const targetTime = baseTime + (Number(evt.offsetMs) || 0) / 1000;
      if (targetTime <= horizon) {
        this.scheduleFn(evt, targetTime);
      } else {
        nextQueue.push(evt);
      }
    });
    this.queue = nextQueue;
  }
}
