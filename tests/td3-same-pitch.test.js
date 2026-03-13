import assert from "node:assert/strict";
import { buildTd3Seq, parseTd3SeqBuffer, importTd3Pattern } from "../server/td3.js";
import { SGridState } from "../server/state.js";

function makeMonoStateWithFourSameNotes({ slideFirstThree = true } = {}) {
  const state = new SGridState();
  const pat = state.pages[1].patterns[1];
  pat.length_steps = 4;
  for (let i = 0; i < pat.steps.length; i++) {
    pat.steps[i] = {
      on: false,
      degree: 0,
      octave: 0,
      micro: 0,
      accent: false,
      slide: false,
      mdSlide: false,
      tie: false,
      notes: [],
      accented: [],
      noteOctaves: {},
      cc: 0
    };
  }
  for (let i = 0; i < 4; i++) {
    pat.steps[i].on = true;
    pat.steps[i].degree = 0;
    pat.steps[i].octave = 0;
    pat.steps[i].slide = slideFirstThree && i < 3;
  }
  return state;
}

async function testExportEncodesTiesForSamePitchRun() {
  const state = makeMonoStateWithFourSameNotes();
  const { buffer } = await buildTd3Seq(state);
  const parsed = parseTd3SeqBuffer(buffer);
  // step 0 is the gate; steps 1-3 should be tie slots (no gate, not rest)
  assert.equal(parsed.steps[0].gate, true, "first step should gate");
  for (let i = 1; i < 4; i++) {
    assert.equal(parsed.steps[i].rest, false, `step ${i} should not be rest`);
    assert.equal(parsed.steps[i].gate, false, `step ${i} should be encoded as tie/hold slot`);
    assert.equal(parsed.steps[i].tie, true, `step ${i} should be marked tie`);
  }
}

async function testImportMakesHeldRunPlayable() {
  const state = makeMonoStateWithFourSameNotes();
  const { buffer } = await buildTd3Seq(state);
  const importState = new SGridState();
  importTd3Pattern(importState, buffer);
  const steps = importState.pages[1].patterns[1].steps;
  const baseDeg = steps[0].degree;
  const baseOct = steps[0].octave;
  for (let i = 0; i < 4; i++) {
    assert.equal(steps[i].on, true, `imported step ${i} should be on`);
    assert.equal(steps[i].degree, baseDeg, "degree should be preserved across the run");
    assert.equal(steps[i].octave, baseOct, "octave should be preserved across the run");
    if (i > 0) {
      assert.equal(steps[i - 1].slide, true, `imported boundary ${i - 1}->${i} should be linked`);
    }
  }
}

await testExportEncodesTiesForSamePitchRun();
await testImportMakesHeldRunPlayable();
console.log("TD-3 same-pitch tie tests passed");
