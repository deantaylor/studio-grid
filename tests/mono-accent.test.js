import { SGridState } from "../server/state.js";

function collectStepVelocities(state, ticks = 2) {
  const seen = [];
  for (let i = 0; i < ticks; i += 1) {
    const { midiEvents } = state.tick(false, null, 0);
    midiEvents.forEach((evt) => {
      if (evt?.type === "midi_note" && evt.page === 1) {
        seen.push(evt);
      }
    });
  }
  return seen;
}

function assertVelocities(label, events, expected) {
  const velocities = events.map((evt) => evt.vel);
  console.log(label, { velocities, events });
  if (velocities.length !== expected.length) {
    console.error(`Expected ${expected.length} events.`);
    process.exit(1);
  }
  expected.forEach((val, idx) => {
    if (velocities[idx] !== val) {
      console.error(`Expected velocities ${JSON.stringify(expected)}.`);
      process.exit(1);
    }
  });
}

{
  const state = new SGridState();
  const page = state.pages[1];
  page.sequencerType = "mono";
  page.sequencerStopped = false;

  const pat = page.patterns[page.active_pattern];
  pat.length_steps = 4;

  const setMonoStep = (idx, { degree = 0, octave = 0, accent = false } = {}) => {
    const step = pat.steps[idx];
    step.on = true;
    step.degree = degree;
    step.octave = octave;
    step.micro = 0;
    step.accent = accent;
    step.slide = false;
    step.chain = false;
    step.tie = false;
    step.notes = [degree];
  };

  setMonoStep(0, { degree: 0, octave: 0, accent: false });
  setMonoStep(1, { degree: 0, octave: 0, accent: true });

  state.resetTickCounters();
  const events = collectStepVelocities(state, 2);
  assertVelocities("mono_accent_test", events, [96, 120]);
}

{
  const state = new SGridState();
  const page = state.pages[1];
  page.sequencerType = "poly";
  page.sequencerStopped = false;

  const pat = page.patterns[page.active_pattern];
  pat.length_steps = 4;

  const setPolyStep = (idx, { degree = 0, octave = 0, accent = false } = {}) => {
    const step = pat.steps[idx];
    step.on = true;
    step.degree = degree;
    step.octave = octave;
    step.micro = 0;
    step.slide = false;
    step.chain = false;
    step.tie = false;
    step.notes = [degree];
    step.accented = accent ? [degree] : [];
    step.noteOctaves = { [degree]: octave };
  };

  setPolyStep(0, { degree: 0, octave: 0, accent: false });
  setPolyStep(1, { degree: 0, octave: 0, accent: true });

  state.resetTickCounters();
  const events = collectStepVelocities(state, 2);
  assertVelocities("poly_accent_test", events, [96, 120]);
}
