import assert from "assert";
import {
  buildTd3PatternBlock,
  parseTd3SeqBuffer,
  importTd3Pattern
} from "../server/td3.js";

const clamp = (val, min, max) => Math.max(min, Math.min(max, val));
const SCALE = {
  major: [0, 2, 4, 5, 7, 9, 11]
};
const BASE_PITCH = 48;

function calcPitch(root, mode, degree, octave) {
  const scale = SCALE[mode] || SCALE.major;
  const degIdx = clamp(degree, 0, scale.length - 1);
  return BASE_PITCH + (root || 0) + scale[degIdx] + (octave || 0) * 12;
}

function makeEmptyStep() {
  return {
    on: false,
    degree: 0,
    octave: 0,
    micro: 0,
    accent: false,
    slide: false,
    tie: false,
    mdSlide: false,
    cc: 0,
    notes: [],
    accented: []
  };
}

function makeTestPattern() {
  const steps = Array.from({ length: 16 }, () => ({
    midiNote: 0,
    accent: false,
    slide: false,
    tie: false,
    rest: true,
    td3TieSlot: false
  }));
  // Step1 NOTE C4 (60)
  steps[0] = { midiNote: 60, accent: false, slide: false, tie: false, rest: false, td3TieSlot: false };
  // Step2-3 TIE slots (gate off), mark td3TieSlot
  steps[1] = { midiNote: 60, accent: false, slide: false, tie: false, rest: false, td3TieSlot: true };
  steps[2] = { midiNote: 60, accent: false, slide: false, tie: false, rest: false, td3TieSlot: true };
  // Step4 REST
  steps[3] = { midiNote: 0, accent: false, slide: false, tie: false, rest: true, td3TieSlot: false };
  // Step5 NOTE D4 (62)
  steps[4] = { midiNote: 62, accent: false, slide: false, tie: false, rest: false, td3TieSlot: false };
  return { stepCount: 5, triplet: false, steps };
}

function parsePattern(buf) {
  const parsed = parseTd3SeqBuffer(buf);
  return parsed;
}

function buildBufferFromPattern(pat) {
  const payload = buildTd3PatternBlock(pat);
  return Buffer.from(payload);
}

function makeState() {
  const steps = Array.from({ length: 16 }, () => makeEmptyStep());
  return {
    currentPage: 1,
    scale: { root: 0, mode: "major" },
    pages: [
      null,
      {
        sequencerType: "mono",
        transpose: 0,
        active_pattern: 1,
        patterns: {
          1: {
            steps,
            length_steps: 16,
            scale_mode: "major",
            root: 0
          }
        }
      }
    ]
  };
}

function stateToTd3Pattern(state) {
  const page = state.pages[1];
  const pat = page.patterns[1];
  const stepCount = clamp(pat.length_steps || 16, 1, 16);
  const mode = pat.scale_mode || state.scale?.mode || "major";
  const pageTranspose = page.transpose || 0;
  const tdSteps = [];
  for (let i = 0; i < 16; i++) {
    const st = pat.steps[i];
    if (st.td3TieSlot) {
      tdSteps.push({ midiNote: 0, accent: false, slide: false, tie: false, rest: false, td3TieSlot: true });
      continue;
    }
    if (!st || !st.on) {
      tdSteps.push({ midiNote: 0, accent: false, slide: false, tie: false, rest: true, td3TieSlot: !!st?.td3TieSlot });
      continue;
    }
    const midiNote = calcPitch(pat.root || 0, mode, st.degree || 0, st.octave || 0) + pageTranspose - 12;
    const nextOn = i + 1 < 16 && pat.steps[i + 1] && pat.steps[i + 1].on;
    tdSteps.push({
      midiNote,
      accent: !!st.accent,
      slide: !!(st.slide && nextOn),
      tie: !!st.tie,
      rest: false,
      td3TieSlot: false
    });
  }
  return { stepCount, triplet: false, steps: tdSteps };
}

function runTest() {
  const originalPattern = makeTestPattern();
  const buf = buildBufferFromPattern(originalPattern);

  // Parse
  const parsed = parsePattern(buf);
  assert.strictEqual(parsed.stepCount, 5);
  assert.deepStrictEqual(
    parsed.steps.slice(0, 5).map((s) => ({
      rest: s.rest,
      tie: s.tie,
      td3TieSlot: !!s.td3TieSlot
    })),
    [
      { rest: false, tie: false, td3TieSlot: false }, // gate step
      { rest: false, tie: false, td3TieSlot: true },
      { rest: false, tie: false, td3TieSlot: true },
      { rest: true, tie: false, td3TieSlot: false },
      { rest: false, tie: false, td3TieSlot: false }
    ]
  );

  // Import into sequencer state
  const state = makeState();
  importTd3Pattern(state, buf, { page: 1, applyMode: "fit_current" });

  // Export back to TD-3 pattern
  const td3Pattern = stateToTd3Pattern(state);
  const roundtripBuf = buildBufferFromPattern(td3Pattern);
  const roundtripParsed = parsePattern(roundtripBuf);

  assert.deepStrictEqual(
    roundtripParsed.steps.slice(0, 5).map((s) => ({ rest: s.rest, tie: s.tie, td3TieSlot: !!s.td3TieSlot })),
    [
      { rest: false, tie: false, td3TieSlot: false },
      { rest: false, tie: false, td3TieSlot: true },
      { rest: false, tie: false, td3TieSlot: true },
      { rest: true, tie: false, td3TieSlot: false },
      { rest: false, tie: false, td3TieSlot: false }
    ]
  );

  console.log("TD-3 tie round-trip test passed");
}

runTest();
