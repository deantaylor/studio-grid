import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { SGridState } from "../server/state.js";

test("Create Chain reports the accepted range and the outline follows chain edits", () => {
  const state = new SGridState();
  const uiMode = true;
  const y = 3;
  const { degree, octaveOffset: octave } = state.getRowInfo(y, { uiMode });
  const pattern = state.getPattern();
  for (const x of [2, 3, 4]) {
    Object.assign(pattern.steps[x], { on: true, degree, octave });
  }
  pattern.steps[2].slide = true;
  assert.deepEqual(state.noteChainSpans({ uiMode }), []);
  assert.equal(state.createChainFromSelection([{ x: 2, y }, { x: 4, y }], { uiMode }).ok, false);
  assert.deepEqual(
    state.createChainFromSelection([4, 2, 3].map((x) => ({ x, y })), { uiMode }),
    { ok: true, startX: 2, endX: 4, degree, octave }
  );
  assert.deepEqual(state.noteChainSpans({ uiMode }), [{ startX: 2, endX: 4, y }]);
  assert.deepEqual(state.noteChainSpans(), [{ startX: 2, endX: 4, y: y - 1 }]);

  pattern.steps[3].chain = false;
  assert.deepEqual(state.noteChainSpans({ uiMode }), [{ startX: 2, endX: 3, y }]);
});

test("poly outlines follow each pitch and clip at bar boundaries", () => {
  const state = new SGridState();
  state.setSequencerType(1, "poly");
  const pattern = state.getPattern();
  pattern.length_steps = 19;
  for (const x of [15, 16, 17]) {
    Object.assign(pattern.steps[x], {
      on: true, notes: [0, 2], noteSlides: x < 17 ? { 0: true } : {}
    });
  }
  assert.deepEqual(state.noteChainSpans(), [{ startX: 15, endX: 15, y: 6, continuesRight: true }]);
  pattern.barView = 1;
  assert.deepEqual(state.noteChainSpans(), [{ startX: 0, endX: 1, y: 6, continuesLeft: true }]);
  state.microtiming.active = true;
  assert.deepEqual(state.noteChainSpans(), []);
});

test("shortening a mono chain removes only the steps beyond its new end", () => {
  const state = new SGridState();
  const y = 3;
  state.createChainFromRange(2, 7, y);
  state.handleGridKey(8, y, 1);
  state.handleGridKey(8, y, 0);
  assert.equal(state.shortenNoteChain(2, 6, 4, y), false);
  assert.equal(state.shortenNoteChain(2, 7, 4, y), true);
  assert.deepEqual(state.noteChainSpans(), [{ startX: 2, endX: 4, y }]);
  assert.deepEqual(state.getPattern().steps.flatMap((step, x) => step.on ? [x] : []), [2, 3, 4, 8]);
  assert.equal(state.shortenNoteChain(2, 4, 2, y), true);
  assert.deepEqual(state.noteChainSpans(), []);
  assert.equal(state.getPattern().steps[2].on, true);
});

test("shortening a poly chain preserves the other pitches in its tail", () => {
  const state = new SGridState();
  state.setSequencerType(1, "poly");
  state.createChainFromRange(2, 6, 4);
  state.createChainFromRange(3, 6, 5);
  assert.equal(state.shortenNoteChain(2, 6, 3, 4), true);
  assert.deepEqual(state.noteChainSpans(), [{ startX: 2, endX: 3, y: 4 }, { startX: 3, endX: 6, y: 5 }]);
  assert.deepEqual(state.getPattern().steps[6].notes, [1]);
});

test("note cursor cells report individual and chained notes independently of the playhead", () => {
  const state = new SGridState();
  const y = 3;
  const { degree, octaveOffset: octave } = state.getRowInfo(y);
  Object.assign(state.getPattern().steps[0], { on: true, degree, octave });
  state.createChainFromRange(2, 4, y);
  assert.deepEqual(state.noteViewActiveCells(), [48, 50, 51, 52]);
  assert.deepEqual(state.noteViewActiveCells({ uiMode: true }), [64, 66, 67, 68]);
  state.setNoteViewOffset(1, 1);
  assert.deepEqual(state.noteViewActiveCells(), [64, 66, 67, 68]);
  state.patternControlMode = true;
  assert.equal(state.noteViewActiveCells(), null);
  state.patternControlMode = false;
  state.setSequencerType(1, "cc");
  assert.equal(state.noteViewActiveCells(), null);
});

test("the Monome hold gesture can fill empty steps after entering note edit mode", async () => {
  const state = new SGridState();
  const y = 3;
  const { degree, octaveOffset: octave } = state.getRowInfo(y);
  const pattern = state.getPattern();
  Object.assign(pattern.steps[2], { on: true, degree, octave });
  state.handleGridKey(2, y, 1);
  await setTimeout(175);
  assert.equal(state.microtiming.active, true);
  const events = state.handleGridKey(4, y, 1);
  assert.deepEqual(events, [
    { type: "slide", x: 2, y, slide: true },
    { type: "slide", x: 3, y, slide: true },
    { type: "note_chain_created", startX: 2, endX: 4, degree, octave }
  ]);
  assert.equal(state.microtiming.active, false);
  state.handleGridKey(4, y, 0);
  state.handleGridKey(2, y, 0);
  assert.equal(pattern.steps[2].accent, false);
  assert.deepEqual(state.noteChainSpans(), [{ startX: 2, endX: 4, y }]);
});

test("overlapping quick Monome presses leave independent notes on the same row", async () => {
  const state = new SGridState();
  const keys = [2, 3, 5];
  for (const x of keys) assert.equal(state.handleGridKey(x, 0, 1, { monome: true }), null);
  for (const x of [5, 2, 3]) state.handleGridKey(x, 0, 0, { monome: true });
  await setTimeout(175);
  assert.equal(state.microtiming.active, false);
  assert.deepEqual(state.noteChainSpans(), []);
  assert.deepEqual(state.getPattern().steps.flatMap((step, x) => step.on ? [x] : []), keys);
  for (const x of keys) state.handleGridKey(x, 0, 1, { monome: true });
  for (const x of [2, 5, 3]) state.handleGridKey(x, 0, 0, { monome: true });
  assert.ok(state.getPattern().steps.every((step) => !step.on));
});

test("Monome LEDs sweep left to right, peak, and blend back into the chain wave", () => {
  const state = new SGridState();
  const y = 3;
  const start = Date.now();
  state.createChainFromRange(2, 5, y);
  const levels = (frame) => frame.slice(y * 16 + 2, y * 16 + 6);
  assert.deepEqual(levels(state.renderMonomeFrame(start)), [0, 0, 0, 0]);
  const partial = levels(state.renderMonomeFrame(start + 100));
  assert.equal(partial[0], 15);
  assert.deepEqual(partial.slice(2), [0, 0]);
  assert.deepEqual(levels(state.renderMonomeFrame(start + 280)), [15, 15, 15, 15]);
  const fadeAt = start + 410;
  const base = levels(state.renderLED(fadeAt));
  const fading = levels(state.renderMonomeFrame(fadeAt));
  assert.ok(fading.every((level, i) => level < 15 && level > base[i]));
  assert.deepEqual(levels(state.renderMonomeFrame(start + 750)), levels(state.renderLED(start + 750)));
  assert.notDeepEqual(levels(state.renderLED(0)), levels(state.renderLED(200)));
});

test("a new Monome anchor stays dark through the hold and lights on an ordinary release", async () => {
  for (const uiMode of [false, true]) {
    const state = new SGridState();
    const x = 2;
    const y = 3;
    const opts = { uiMode, monome: true };
    const level = () => state.renderMonomeFrame(Date.now(), opts)[y * 16 + x];
    state.handleGridKey(x, y, 1, opts);
    assert.equal(level(), 0);
    await setTimeout(175);
    assert.equal(state.microtiming.active, true);
    assert.equal(level(), 0);
    state.handleGridKey(x, y, 0, opts);
    assert.ok(level() > 0);
  }
});

test("chains of different lengths share a loop and keep smooth fades", () => {
  const loopMs = 1000;
  for (const size of [2, 4, 16]) {
    const state = new SGridState();
    const y = 3;
    state.createChainFromRange(0, size - 1, y);
    const levels = (time) => state.renderLED(time).slice(y * 16, y * 16 + size);
    const stepMs = loopMs / size;
    const start = levels(0);
    assert.deepEqual(levels(stepMs), [start.at(-1), ...start.slice(0, -1)]);
    assert.deepEqual(levels(loopMs), start);
    assert.deepEqual(state.renderUIFrame(0).slice((y + 1) * 16, (y + 1) * 16 + size), start);
    const frames = Array.from({ length: 384 }, (_, i) => levels(i * 8));
    assert.ok(frames.every((frame) => frame.every((level) => level >= 2)));
    if (size <= 4) {
      assert.ok(frames.slice(2).every((frame, i) =>
        frame.every((level, x) => Math.abs(level - frames[i][x]) <= 1)
      ));
    }
    for (let x = 0; x < size; x++) {
      const peakTime = x * stepMs;
      assert.equal(levels(peakTime)[x], 13);
      const trough = frames.findIndex((frame, i) => i * 8 > peakTime && frame[x] === 2);
      assert.ok(trough >= 0);
      assert.ok(frames.slice(trough + 1).some((frame) => frame[x] === 13));
    }
  }
});

test("the wave stays in phase as the playhead moves through the chain", () => {
  const state = new SGridState();
  const y = 3;
  state.createChainFromRange(2, 5, y);
  const getChain = (frame, row) => frame.slice(row * 16 + 2, row * 16 + 6);
  const expected = getChain(state.renderLED(375), y);
  for (let step = 0; step <= 6; step++) {
    state.tick(false, 100);
    assert.equal(state.playheads[1], step);
    const frame = state.renderLED(375);
    assert.deepEqual(getChain(frame, y), expected);
    assert.deepEqual(getChain(state.renderUIFrame(1375), y + 1), expected);
    assert.equal(frame[step], state.ledLevels.playhead);
  }
});

test("two endpoints fill and chain an empty range in the current bar", () => {
  const state = new SGridState();
  const pattern = state.getPattern();
  pattern.length_steps = 21;
  pattern.barView = 1;
  const opts = { uiMode: true };
  assert.equal(state.createChainFromRange(1, 5, 0, opts), null);
  assert.equal(pattern.steps[17].on, false);
  assert.deepEqual(state.createChainFromRange(1, 4, 0, opts), {
    ok: true, startX: 1, endX: 4, degree: 0, octave: 1
  });
  assert.deepEqual(pattern.steps.slice(17, 21).map(({ on, octave, chain }) => [on, octave, chain]), [
    [true, 1, true], [true, 1, true], [true, 1, true], [true, 1, false]
  ]);
  assert.equal(pattern.steps[16].on, false);
  assert.deepEqual(state.noteChainSpans(opts), [{ startX: 1, endX: 4, y: 0 }]);
});

test("the endpoint gesture preserves other voices in a poly pattern", () => {
  const state = new SGridState();
  state.setSequencerType(1, "poly");
  const pattern = state.getPattern();
  Object.assign(pattern.steps[3], {
    on: true, degree: 2, notes: [2], slide: true, accented: [2], noteMicros: { 2: 2 }
  });
  assert.equal(state.createChainFromRange(2, 4, 6)?.ok, true);
  assert.deepEqual(pattern.steps[3].notes, [2, 0]);
  assert.deepEqual(pattern.steps[3].accented, [2]);
  assert.equal(pattern.steps[3].noteMicros[2], 2);
  assert.equal(state.hasPolyNoteSlide(pattern.steps[3], 2), true);
  assert.deepEqual(state.noteChainSpans(), [{ startX: 2, endX: 4, y: 6 }]);
});
