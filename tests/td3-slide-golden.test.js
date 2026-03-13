import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importTd3Pattern } from "../server/td3.js";
import { SGridState } from "../server/state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEQ_PATH = path.join(__dirname, "..", "fixtures", "td3", "example.seq");
const FIXTURE_PATH = path.join(__dirname, "fixtures", "td3-slide-playback.json");

function collectPlaybackEvents({ ticks = 128 } = {}) {
  const state = new SGridState();
  state.pages[1].sequencerType = "mono";
  return readFile(SEQ_PATH)
    .then((buf) => {
      importTd3Pattern(state, buf, { page: 1, applyMode: "fit_current" });
      const output = [];
      for (let i = 0; i < ticks; i++) {
        const { midiEvents } = state.tick(false, null);
        const step = state.playheads[1] ?? 0;
        output.push({
          tick: i,
          step,
          events: midiEvents.map((evt) => ({
            type: evt.type,
            page: evt.page,
            pitch: evt.pitch,
            vel: evt.vel,
            cc: evt.cc,
            value: evt.value,
            durMs: evt.durMs,
            delayMs: evt.delayMs,
            chan: evt.chan,
            accent: !!evt.accent,
            td3Slide: !!evt.td3Slide
          }))
        });
      }
      return output;
    });
}

async function testTd3SlideGoldenMaster() {
  const expectedRaw = await readFile(FIXTURE_PATH, "utf-8");
  const expected = JSON.parse(expectedRaw);
  const actual = await collectPlaybackEvents({ ticks: expected.length });
  assert.deepEqual(actual, expected);
}

await testTd3SlideGoldenMaster();
console.log("TD-3 slide playback golden master passed");
