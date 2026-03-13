import assert from "node:assert/strict";
import { SGridState } from "../server/state.js";

function setupState() {
  const state = new SGridState();
  state.setScale(0, "chromatic");
  state.setIsomorphicLayout({ base: 60, stepX: 1, stepY: 3 });
  return state;
}

function getMidi(state, x, y) {
  const page = state.pages[1];
  const info = state.getIsomorphicNoteInfo(x, y, page);
  return info.midi;
}

function testStepX() {
  const state = setupState();
  const base = getMidi(state, 0, 6);
  const right = getMidi(state, 1, 6);
  assert.equal(right - base, 1, "moving +1 in x should change pitch by stepX semitones");
}

function testStepY() {
  const state = setupState();
  const base = getMidi(state, 0, 6);
  const up = getMidi(state, 0, 5);
  assert.equal(up - base, 3, "moving +1 in y should change pitch by stepY semitones");
}

function testOctaveVector() {
  const state = setupState();
  const base = getMidi(state, 0, 6);
  const octave = getMidi(state, 9, 5); // 9*1 + 1*3 = 12
  assert.equal(octave - base, 12, "vector sum of 12 semitones should produce an octave");
  const baseClass = ((base % 12) + 12) % 12;
  const octClass = ((octave % 12) + 12) % 12;
  assert.equal(octClass, baseClass, "octave should preserve pitch class");
}

testStepX();
testStepY();
testOctaveVector();
console.log("Isomorphic layout tests passed");
