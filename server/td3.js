import path from "path";
import { readFile } from "fs/promises";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SEQ_TEMPLATE = path.join(__dirname, "..", "TD3", "example.seq");
// TD-3 .seq layout (from SynthTribe dumps):
// [32-byte header][4-byte filler][110-byte pattern block]
const TD3_HEADER_LENGTH = 32;
const TD3_FILL_LENGTH = 4;
const TD3_PAYLOAD_OFFSET = TD3_HEADER_LENGTH + TD3_FILL_LENGTH; // 36 (fallback; prefer locateTd3Payload)
const TD3_PAYLOAD_LENGTH = 110; // pitches(32)+accent(32)+slide(32)+triplet(2)+len(2)+unk(2)+tie(4)+rest(4)
const TD3_TOTAL_LENGTH = TD3_HEADER_LENGTH + TD3_FILL_LENGTH + TD3_PAYLOAD_LENGTH; // 146
const BASE_PITCH = 48; // C3, matches state.js BASE_PITCH
const TRANSPOSE_STEP = 12; // transpose is octave-only in the UI
const OCTAVE_SHIFT_MIN = -2;
const OCTAVE_SHIFT_MAX = 2;
const TD3_IMPORT_OCTAVE_APPLY_MODES = {
  NAVIGATION: "note_view_navigation",
  LEGACY: "legacy_octave_shift"
};
const TD3_IMPORT_DEFAULT_OCTAVE_APPLY_MODE = TD3_IMPORT_OCTAVE_APPLY_MODES.NAVIGATION;
const SCALES = {
  "major": [0, 2, 4, 5, 7, 9, 11],
  "minor": [0, 2, 3, 5, 7, 8, 10],
  "dorian": [0, 2, 3, 5, 7, 9, 10],
  "mixolydian": [0, 2, 4, 5, 7, 9, 10],
  "lydian": [0, 2, 4, 6, 7, 9, 11],
  "phrygian": [0, 1, 3, 5, 7, 8, 10],
  "locrian": [0, 1, 3, 5, 6, 8, 10],
  "harmonic_minor": [0, 2, 3, 5, 7, 8, 11],
  "melodic_minor": [0, 2, 3, 5, 7, 9, 11],
  "whole_tone": [0, 2, 4, 6, 8, 10, 12],
  "chromatic": [0, 1, 2, 3, 4, 5, 6]
};

const clamp = (val, min, max) => Math.max(min, Math.min(max, val));

function writeNibbleByte(value8) {
  const v = value8 & 0xff;
  return [(v >> 4) & 0x0f, v & 0x0f];
}

function encodeMaskSeq(bits16) {
  let n = 0;
  for (let i = 0; i < 16; i++) {
    if (bits16[i]) n |= (1 << i);
  }
  const b1 = (n >> 0) & 0x0f;
  const b0 = (n >> 4) & 0x0f;
  const b3 = (n >> 8) & 0x0f;
  const b2 = (n >> 12) & 0x0f;
  // .seq masks must stay nibble-only (0x00..0x0f)
  return [b0 & 0x0f, b1 & 0x0f, b2 & 0x0f, b3 & 0x0f];
}

function encodeMaskSysex(bits16) {
  let n = 0;
  for (let i = 0; i < 16; i++) {
    if (bits16[i]) n |= (1 << i);
  }
  const b1 = (n >> 0) & 0x0f;
  const b0 = (n >> 4) & 0x0f;
  const b3 = (n >> 8) & 0x0f;
  const b2 = (n >> 12) & 0x0f;
  // SysEx-safe: low nibble only
  return [b0, b1, b2, b3];
}

export function buildTd3SysexRequestPattern(group, slot) {
  const header = [0xf0, 0x00, 0x20, 0x32, 0x00, 0x01, 0x0a, 0x77];
  return new Uint8Array([...header, group & 0x7f, slot & 0x7f, 0xf7]);
}

export function buildTd3SysexPattern(pat) {
  const body = buildTd3PatternBlock(pat, { maskEncoder: encodeMaskSysex });
  const header = [
    0xf0, 0x00, 0x20, 0x32, 0x00, 0x01, 0x0a, 0x78,
    pat.group & 0x7f,
    pat.pattern & 0x7f,
    0x00, 0x00
  ];
  return new Uint8Array([...header, ...body, 0xf7]);
}

export function buildTd3PatternBlock(pat, { maskEncoder = encodeMaskSeq } = {}) {
  const bytes = [];
  // Build compact pools from non-rest, non-td3-tie steps; pad to 16
  const pitchPool = [];
  const accentPool = [];
  const slidePool = [];
  for (let i = 0; i < 16; i++) {
    const st = pat.steps[i];
    if (!st || st.rest || st.td3TieSlot) continue; // td3 tie slots do not start gates; gate steps may carry tie for playback
    pitchPool.push(clamp(st.midiNote, 0, 127));
    accentPool.push(!!st.accent);
    // slide flag is kept even without a following gate to preserve intent
    slidePool.push(!!st.slide);
  }
  while (pitchPool.length < 16) pitchPool.push(0x18);
  while (accentPool.length < 16) accentPool.push(false);
  while (slidePool.length < 16) slidePool.push(false);
  for (let i = 0; i < 16; i++) {
    bytes.push(...writeNibbleByte(pitchPool[i]));
  }
  for (let i = 0; i < 16; i++) bytes.push(0x00, accentPool[i] ? 0x01 : 0x00);
  for (let i = 0; i < 16; i++) bytes.push(0x00, slidePool[i] ? 0x01 : 0x00);
  bytes.push(0x00, pat.triplet ? 0x01 : 0x00);
  bytes.push(...writeNibbleByte(pat.stepCount));
  bytes.push(0x00, 0x00);
  // tie mask acts as gate mask/note pointer; set for non-rest, non-td3-tie slots (even if playback tie flag is true)
  bytes.push(...maskEncoder(pat.steps.map((s) => !!(s && !s.rest && !s.td3TieSlot))));
  bytes.push(...maskEncoder(pat.steps.map((s) => s.rest)));
  if (bytes.length !== TD3_PAYLOAD_LENGTH) throw new Error("TD-3 pattern block wrong size");
  return new Uint8Array(bytes);
}

function buildTd3SeqPayload(pat) {
  return buildTd3PatternBlock(pat);
}

export function deriveTd3PatternFromState(state, { page, pattern, tdGroup, tdPattern } = {}) {
  let pageIdx = clamp(Math.round(page || state.currentPage || 1), 1, 8);
  let pg = state.pages[pageIdx];
  if (!pg) {
    pageIdx = 1;
    pg = state.pages[pageIdx];
  }
  if (!pg) throw new Error("Page not found");
  const seqType = pg.sequencerType || "mono";
  if (seqType !== "mono") {
    throw new Error(`TD-3 export only supports mono pages (page ${pageIdx} is ${seqType})`);
  }
  let patIdx = clamp(Math.round(pattern || pg.active_pattern || 1), 1, 8);
  let pat = pg.patterns[patIdx];
  if (!pat) {
    patIdx = 1;
    pat = pg.patterns[patIdx];
  }
  if (!pat) throw new Error("Pattern not found");
  const pageTranspose = pg.transpose || 0;
  const groupSafe = clamp(Math.round(tdGroup ?? 0), 0, 3);
  const patternSafe = clamp(Math.round(tdPattern ?? 0), 0, 15);

  const calcPitch = typeof state.calcPitch === "function" ? state.calcPitch.bind(state) : null;
  const scaleMode = state.scale?.mode || pat.scale_mode || "major";
  const scale = SCALES[scaleMode] || SCALES.major;
  const globalRoot = state.scale?.root || 0;
  const patRoot = pat.root || 0;
  let maxOnIdx = -1;
  const baseStepCount = clamp(pat.length_steps || 16, 1, 16);

  const steps = [];
  let prevMidi = null;
  for (let i = 0; i < 16; i++) {
    const withinLen = i < baseStepCount;
    const st = withinLen ? (pat.steps?.[i] || null) : null;
    const active = !!(st && st.on);
    if (!active) {
      steps.push({ midiNote: 0, accent: false, slide: false, tie: false, rest: true, td3TieSlot: false });
      continue;
    }
    maxOnIdx = Math.max(maxOnIdx, i);
    const deg = st.degree || 0;
    const oct = st.octave || 0;
    const degIdx = clamp(deg, 0, scale.length - 1);
    const basePitch = calcPitch
      ? calcPitch(patRoot, scaleMode, deg, oct) + pageTranspose - 12
      : BASE_PITCH + globalRoot + patRoot + scale[degIdx] + oct * 12 + pageTranspose - 12;
    const midiNote = clamp(Math.round(basePitch), 0, 127);
    const prevLink = i > 0 && !!(pat.steps?.[i - 1]?.slide);
    const tie = prevLink && prevMidi !== null && prevMidi === midiNote;
    if (tie) {
      steps.push({
        midiNote,
        accent: false,
        slide: false,
        tie: true,
        rest: false,
        td3TieSlot: true
      });
      prevMidi = midiNote;
      continue;
    }
    let slide = !!st?.slide;
    if (slide) {
      const next = (i + 1) < baseStepCount ? pat.steps?.[i + 1] : null;
      if (next?.on) {
        const nextDeg = next.degree || 0;
        const nextOct = next.octave || 0;
        const nextIdx = clamp(nextDeg, 0, scale.length - 1);
        const nextPitch = calcPitch
          ? calcPitch(patRoot, scaleMode, nextDeg, nextOct) + pageTranspose - 12
          : BASE_PITCH + globalRoot + patRoot + scale[nextIdx] + nextOct * 12 + pageTranspose - 12;
        if (nextPitch === midiNote) {
          slide = false; // same-pitch links become ties
        }
      }
    }
    steps.push({
      midiNote,
      accent: !!st?.accent,
      slide,
      tie: false,
      rest: false,
      td3TieSlot: false
    });
    prevMidi = midiNote;
  }
  const lastActive = steps.reduce((idx, st, i) => (!st.rest || st.slide || st.tie || st.accent ? i : idx), maxOnIdx);
  const stepCount = clamp(Math.max(baseStepCount, lastActive + 1), 1, 16);

  return {
    group: groupSafe,
    pattern: patternSafe,
    triplet: false,
    stepCount,
    steps
  };
}

export function td3DestToAddress({ groupUI, bank, patternUI } = {}) {
  const groupSafe = clamp(Math.round(groupUI || 1) - 1, 0, 3);
  const bankSafe = bank === "B" ? "B" : "A";
  const patternSafe = clamp(Math.round(patternUI || 1), 1, 8);
  const slot = (bankSafe === "B" ? 8 : 0) + (patternSafe - 1);
  return { group: groupSafe, slot };
}

function resolveTemplate(templatePath) {
  const candidates = [
    templatePath,
    DEFAULT_SEQ_TEMPLATE
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch (e) {
      continue;
    }
  }
  throw new Error("TD-3 template .seq file not found");
}

export async function buildTd3Seq(state, opts = {}) {
  const td3Pattern = deriveTd3PatternFromState(state, opts);
  const templatePath = resolveTemplate(opts.templatePath);
  const template = await readFile(templatePath);
  if (template.length < TD3_TOTAL_LENGTH) throw new Error("TD-3 template is too small");
  const payload = buildTd3SeqPayload(td3Pattern);
  const buf = Buffer.from(template);
  const { offset } = locateTd3Payload(template);
  payload.forEach((b, idx) => {
    buf[offset + idx] = b;
  });
  return { buffer: buf, td3: td3Pattern };
}

export function parseTd3SeqBuffer(buf) {
  const { offset } = locateTd3Payload(buf);
  const payload = buf.slice(offset, offset + TD3_PAYLOAD_LENGTH);
  return parseTd3PatternPayload(payload);
}

export function parseTd3PatternPayload(payload) {
  if (!payload || payload.length < TD3_PAYLOAD_LENGTH) {
    throw new Error("TD-3 payload is too small");
  }
  const data = payload.length === TD3_PAYLOAD_LENGTH ? payload : payload.slice(0, TD3_PAYLOAD_LENGTH);
  const pitches = [];
  for (let i = 0; i < 32; i += 2) {
    const hi = data[i] & 0x0f;
    const lo = data[i + 1] & 0x0f;
    pitches.push((hi << 4) | lo);
  }
  const accentPool = [];
  for (let i = 0; i < 16; i++) accentPool.push((data[32 + i * 2 + 1] & 1) === 1);
  const slidePool = [];
  for (let i = 0; i < 16; i++) slidePool.push((data[64 + i * 2 + 1] & 1) === 1);
  const triplet = (data[96 + 1] & 1) === 1;
  const stepCount = ((data[98] & 0x0f) << 4) | (data[99] & 0x0f);
  const gateMask = decodeMask(data.slice(102, 106)); // gates/attacks (TD-3 label "tie")
  const rest = decodeMask(data.slice(106, 110));
  // TD-3 stores a compact pool of pitches/flags; advance the pool only when the gate mask is set
  let poolIdx = 0;
  let lastGatePitch = null;
  const steps = [];
  for (let i = 0; i < 16; i++) {
    if (rest[i]) {
      steps.push({ midiNote: 0, accent: false, slide: false, rest: true, tie: false, td3TieSlot: false });
      continue;
    }
    const gateOn = !!gateMask[i];
    if (gateOn) {
      const poolPos = poolIdx;
      const noteVal = (pitches[poolPos] & 0x7f) + 12; // TD-3 stores one octave lower
      const acc = !!accentPool[poolPos];
      const sl = !!slidePool[poolPos];
      steps.push({
        midiNote: noteVal,
        accent: acc,
        slide: sl,
        rest: false,
        tie: false,
        gate: true,
        td3TieSlot: false
      });
      lastGatePitch = noteVal;
      poolIdx = Math.min(poolIdx + 1, pitches.length - 1);
      continue;
    }
    // tie slot: reuse last gate pitch if available
    if (lastGatePitch === null) {
      steps.push({ midiNote: 0, accent: false, slide: false, rest: true, tie: false, td3TieSlot: false });
      continue;
    }
    steps.push({
      midiNote: lastGatePitch,
      accent: false,
      slide: false,
      rest: false,
      tie: true,
      gate: false,
      td3TieSlot: true
    });
  }
  return { stepCount, triplet, steps };
}

function decodeMask(bytes4) {
  const [b0, b1, b2, b3] = bytes4.map((x) => x & 0x0f);
  const val = (b1 << 0) | (b0 << 4) | (b3 << 8) | (b2 << 12);
  return Array.from({ length: 16 }, (_, i) => ((val >> i) & 1) === 1);
}

function locateTd3Payload(buf) {
  if (!buf || buf.length < TD3_PAYLOAD_LENGTH) throw new Error("TD-3 file too small");
  for (let off = 0; off <= buf.length - TD3_PAYLOAD_LENGTH; off++) {
    // pitches: 32 bytes, nibble only
    let ok = true;
    for (let i = 0; i < 32; i++) {
      const b = buf[off + i];
      if (b > 0x0f) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const data = buf.slice(off, off + TD3_PAYLOAD_LENGTH);
    // accent bytes: even byte must be 0, odd byte 0/1
    for (let i = 0; i < 16 && ok; i++) {
      if (data[32 + i * 2] !== 0x00) ok = false;
      const v = data[32 + i * 2 + 1];
      if (v !== 0x00 && v !== 0x01) ok = false;
    }
    if (!ok) continue;
    // slide bytes
    for (let i = 0; i < 16 && ok; i++) {
      if (data[64 + i * 2] !== 0x00) ok = false;
      const v = data[64 + i * 2 + 1];
      if (v !== 0x00 && v !== 0x01) ok = false;
    }
    if (!ok) continue;
    const tripA = data[96];
    const tripB = data[97];
    if (tripA !== 0x00) {
      ok = false;
    } else if (tripB !== 0x00 && tripB !== 0x01) {
      ok = false;
    }
    if (!ok) continue;
    const stepCount = ((data[98] & 0x0f) << 4) | (data[99] & 0x0f);
    if (stepCount < 1 || stepCount > 16) continue;
    // mask bytes must be nibble-only (0x00..0x0f)
    for (let i = 102; i <= 109 && ok; i++) {
      if (data[i] > 0x0f) ok = false;
    }
    if (!ok) continue;
    return { offset: off };
  }
  throw new Error("TD-3 payload not found in file");
}

export function detectScale(notes) {
  const pitchClassCounts = new Array(12).fill(0);
  const notePcs = [];
  notes.forEach((n) => {
    const pc = ((Math.round(n) % 12) + 12) % 12;
    pitchClassCounts[pc] += 1;
    notePcs.push(pc);
  });
  // No notes: default to major / root 0
  const hasNotes = pitchClassCounts.some((c) => c > 0);
  if (!hasNotes) return { mode: "major", root: 0 };

  const pcDistance = (pc, pcs) => {
    let min = 12;
    for (const p of pcs) {
      const dist = Math.min((pc - p + 12) % 12, (p - pc + 12) % 12);
      if (dist < min) min = dist;
    }
    return min;
  };

  let best = { mode: "major", root: 0, cost: Infinity, coverage: 0, rootHits: 0, rootProximity: Infinity, firstRootPos: Infinity };
  Object.entries(SCALES).forEach(([mode, degrees]) => {
    for (let root = 0; root < 12; root++) {
      const pcs = degrees.map((d) => (d + root) % 12);
      let cost = 0;
      let covered = 0;
      const rootPc = root % 12;
      let rootHits = pitchClassCounts[rootPc] || 0;
      let rootProximity = 0;
      const firstRootIdx = notePcs.findIndex((pc) => pc === rootPc);
      const firstRootPos = firstRootIdx === -1 ? Number.POSITIVE_INFINITY : firstRootIdx;
      for (let pc = 0; pc < 12; pc++) {
        const count = pitchClassCounts[pc];
        if (!count) continue;
        const dist = pcDistance(pc, pcs);
        if (dist === 0) covered += 1;
        cost += dist * count;
        // proximity to tonic pitch class (helps disambiguate modes sharing the same set)
        const tonicDist = Math.min((pc - rootPc + 12) % 12, (rootPc - pc + 12) % 12);
        rootProximity += tonicDist * count;
      }
      const better =
        cost < best.cost ||
        (cost === best.cost && covered > best.coverage) ||
        (cost === best.cost && covered === best.coverage && rootHits > best.rootHits) ||
        (cost === best.cost && covered === best.coverage && rootHits === best.rootHits && firstRootPos < best.firstRootPos) ||
        (cost === best.cost &&
          covered === best.coverage &&
          rootHits === best.rootHits &&
          firstRootPos === best.firstRootPos &&
          rootProximity < best.rootProximity);
      if (better) {
        best = { mode, root, cost, coverage: covered, rootHits, rootProximity, firstRootPos };
      }
    }
  });
  return { mode: best.mode, root: best.root };
}

function chooseTransposeForNotes(notes, scale, transposeRange = 24) {
  if (!notes.length) return 0;
  let best = { transpose: 0, zeroCount: -1, absOctave: Infinity, cost: Infinity };
  for (let t = -transposeRange; t <= transposeRange; t += TRANSPOSE_STEP) {
    let cost = 0;
    let maxPenalty = 0;
    let zeroCount = 0;
    let absOctave = 0;
    for (const n of notes) {
      const { error, penalty, octave } = mapNoteToScale(n, scale, t, true);
      cost += error;
      maxPenalty = Math.max(maxPenalty, penalty);
      if (octave === 0) zeroCount += 1;
      absOctave += Math.abs(octave);
    }
    const total = cost + maxPenalty * 10; // heavily penalize out-of-range octaves
    const better =
      zeroCount > best.zeroCount ||
      (zeroCount === best.zeroCount && absOctave < best.absOctave) ||
      (zeroCount === best.zeroCount && absOctave === best.absOctave && total < best.cost);
    if (better) best = { transpose: t, zeroCount, absOctave, cost: total };
  }
  return best.transpose;
}

function mapNoteToScale(note, scale, transpose, allowPenalty = false) {
  const base = 48; // BASE_PITCH from state
  const targetRoot = scale.root || 0;
  const degrees = SCALES[scale.mode] || SCALES.major;
  let best = { degree: 0, octave: 0, error: Infinity, penalty: 0 };
  degrees.forEach((deg, idx) => {
    const ideal = base + targetRoot + transpose + deg;
    const oct = Math.round((note - ideal) / 12);
    const pitch = ideal + oct * 12;
    const err = Math.abs(note - pitch);
    const penalty = (oct < OCTAVE_SHIFT_MIN || oct > OCTAVE_SHIFT_MAX) ? (allowPenalty ? 1000 : 0) : 0;
    const total = err + penalty;
    if (total < best.error + best.penalty) {
      best = { degree: idx, octave: clamp(oct, OCTAVE_SHIFT_MIN, OCTAVE_SHIFT_MAX), error: err, penalty };
    }
  });
  return best;
}

function normalizeTd3OctaveApplyMode(raw) {
  return raw === TD3_IMPORT_OCTAVE_APPLY_MODES.LEGACY
    ? TD3_IMPORT_OCTAVE_APPLY_MODES.LEGACY
    : TD3_IMPORT_DEFAULT_OCTAVE_APPLY_MODE;
}

function applyTd3PatternParsed(state, parsed, { page, applyMode = "fit_current", octaveApplyMode } = {}) {
  const pageIdx = clamp(Math.round(page || state.currentPage || 1), 1, 8);
  const pg = state.pages[pageIdx];
  if (!pg) throw new Error("Page not found");
  const patIdx = clamp(pg.active_pattern || 1, 1, 8);
  const pat = pg.patterns[patIdx];
  if (!pat) throw new Error("Pattern not found");

  const notes = parsed.steps.filter((s) => !s.rest).map((s) => s.midiNote);
  const detectedScale = detectScale(notes);
  const currentScale = state.scale || { root: 0, mode: "major" };
  const targetScale = applyMode === "switch_scale" ? detectedScale : currentScale;
  const transpose = chooseTransposeForNotes(notes, targetScale);
  const octaveMode = normalizeTd3OctaveApplyMode(octaveApplyMode);
  const useLegacyOctavePath = octaveMode === TD3_IMPORT_OCTAVE_APPLY_MODES.LEGACY;

  // apply transpose to page
  pg.transpose = clamp(Math.round(transpose / TRANSPOSE_STEP) * TRANSPOSE_STEP, -24, 24);
  const importedLength = clamp(parsed.stepCount || 16, 1, 16);
  pat.scale_mode = targetScale.mode;
  pat.root = 0;
  pat.length_steps = importedLength;
  pat.time_scale = 1;
  pat.change_mode = "end_of_pattern";
  pat.barView = 0;

  const maxSrc = Math.min(importedLength, 16);
  const parsedSteps = parsed.steps.slice(0, maxSrc);

  // Build steps directly from TD-3 data; convert TD-3 ties into links on the previous step
  const emptyStep = () => ({
    on: false,
    degree: 0,
    octave: 0,
    micro: 0,
    accent: false,
    slide: false,
    chain: false,
    tie: false,
    mdSlide: false,
    cc: 0,
    notes: [],
    accented: []
  });

  const newSteps = [];
  const octaveDeltas = [];
  let lastGateMapping = null;
  for (let i = 0; i < maxSrc && newSteps.length < 16; i++) {
    const src = parsedSteps[i];
    if (!src || src.rest) {
      newSteps.push(emptyStep());
      octaveDeltas.push(0);
      continue;
    }
    if (src.tie) {
      if (!lastGateMapping) {
        newSteps.push(emptyStep());
        octaveDeltas.push(0);
        continue;
      }
      const tieStep = emptyStep();
      tieStep.on = true;
      tieStep.degree = lastGateMapping.degree;
      tieStep.octave = useLegacyOctavePath ? 0 : clamp(lastGateMapping.octave || 0, OCTAVE_SHIFT_MIN, OCTAVE_SHIFT_MAX);
      tieStep.tie = false;
      tieStep.td3TieSlot = false;
      if (newSteps.length > 0 && newSteps[newSteps.length - 1].on) {
        newSteps[newSteps.length - 1].slide = true; // link boundary into this tie
      }
      newSteps.push(tieStep);
      octaveDeltas.push(lastGateMapping.octave || 0);
      continue;
    }
    const mapping = mapNoteToScale(src.midiNote, targetScale, pg.transpose);
    lastGateMapping = mapping;
    const nextSrc = parsedSteps[i + 1];
    const isLast = i === maxSrc - 1;
    const slideAllowed = !!src.slide && (isLast || (!!nextSrc && !nextSrc.rest));
    newSteps.push({
      on: true,
      degree: mapping.degree,
      octave: useLegacyOctavePath ? 0 : clamp(mapping.octave || 0, OCTAVE_SHIFT_MIN, OCTAVE_SHIFT_MAX),
      micro: 0,
      accent: !!src.accent,
      slide: slideAllowed,
      chain: false,
      tie: false,
      mdSlide: false,
      cc: 0,
      notes: [],
      accented: [],
      td3TieSlot: false
    });
    octaveDeltas.push(mapping.octave || 0);
  }
  while (newSteps.length < 16) {
    newSteps.push(emptyStep());
    octaveDeltas.push(0);
  }
  pat.steps = newSteps;
  pat.length_steps = importedLength;
  let appliedOctaveMode = TD3_IMPORT_OCTAVE_APPLY_MODES.NAVIGATION;
  if (useLegacyOctavePath) {
    appliedOctaveMode = TD3_IMPORT_OCTAVE_APPLY_MODES.LEGACY;
    const prevPage = state.currentPage;
    state.currentPage = pageIdx;
    newSteps.forEach((st, idx) => {
      const delta = octaveDeltas[idx];
      if (!st?.on) return;
      if (!delta) {
        st.octave = 0;
        return;
      }
      const y = clamp(6 - (st.degree || 0), 0, 6);
      const res = state.setStepOctave(idx, y, delta, { uiMode: false, skipChainClear: true });
      if (!res) {
        // Fallback keeps legacy mode from dropping octaves when octave shifting is hidden or row-shifted.
        st.octave = clamp(delta, OCTAVE_SHIFT_MIN, OCTAVE_SHIFT_MAX);
        appliedOctaveMode = TD3_IMPORT_OCTAVE_APPLY_MODES.NAVIGATION;
      }
    });
    state.currentPage = prevPage;
  }

  return {
    detectedScale,
    appliedScale: targetScale,
    transpose: pg.transpose,
    page: pageIdx,
    pattern: patIdx,
    octaveApplyMode: appliedOctaveMode
  };
}

export function importTd3Pattern(state, buf, { page, applyMode = "fit_current", octaveApplyMode } = {}) {
  const parsed = parseTd3SeqBuffer(buf);
  return applyTd3PatternParsed(state, parsed, { page, applyMode, octaveApplyMode });
}

export function importTd3PatternPayload(state, payload, { page, applyMode = "fit_current", octaveApplyMode } = {}) {
  const parsed = parseTd3PatternPayload(payload);
  return applyTd3PatternParsed(state, parsed, { page, applyMode, octaveApplyMode });
}

function deriveSlideChainFlags(steps, len) {
  const count = Math.min(len || 0, Array.isArray(steps) ? steps.length : 0);
  const flags = Array(count).fill(false);
  if (!Array.isArray(steps) || !steps.length) return flags;

  const findNextGate = (start) => {
    for (let i = start + 1; i < count; i++) {
      const st = steps[i];
      if (!st || st.rest) return -1; // rest breaks a slide chain
      if (st.gate === false) continue;
      return i;
    }
    return -1;
  };

  const findPrevGate = (start) => {
    for (let i = start - 1; i >= 0; i--) {
      const st = steps[i];
      if (!st || st.rest) return -1;
      if (st.gate === false) continue;
      return i;
    }
    return -1;
  };

  // Honor explicit slide bits only on gated steps; do not propagate across tie slots
  for (let i = 0; i < count; i++) {
    const st = steps[i];
    if (!st || st.rest || st.gate === false || !st.slide) continue;
    flags[i] = true;
  }

  return flags;
}
