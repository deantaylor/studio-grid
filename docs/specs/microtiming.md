## FEATURE: Per-Note Microtiming (Internal 96 PPQN, External 24 PPQN)

### GOAL

Allow **individual notes** to be nudged **early/late** while staying locked to the existing global transport and quantized-start model.

Microtiming must:

- be **per note (per step cell)**
- be **tempo-relative** (musically stable under BPM change)
- be **deterministic** (integer grid in musical space; no ms storage)
- reuse the existing transport timing system (no second clock)
- keep **external clock IO at 24 PPQN**

---

## TIMING MODEL (Internal Tick Domain)

### Concept

We keep external clock and UI semantics at 24 PPQN, but we schedule notes in an **internal** 96 PPQN domain.

### Definitions

- External clock:
  - `PPQN_EXT = 24`
  - `TICKS_PER_STEP_EXT = 6` (16th note at 24 PPQN)
- Internal timing:
  - `PPQN_INT = 96`
  - `INT_MULT = PPQN_INT / PPQN_EXT = 4`
  - `TICKS_PER_STEP_INT = TICKS_PER_STEP_EXT * INT_MULT = 24`

### Conversion helpers

```
extToIntTick(tExt) = tExt * INT_MULT
intToExtTick(tInt) = tInt / INT_MULT
```

**Rule:** All sequencing/scheduling uses internal ticks. External clock input/output remains 24 PPQN.

---

## STORAGE (State)

Store microtiming as **integer internal ticks**:

- `microInt: int` (stored in `step.micro` and `step.noteMicros`)
- units: **internal ticks** (1/96 of a beat)
- default: `0`

Backward compatibility:

- snapshots carry `microFormat: "int96"` when saved
- legacy values (24 PPQN / fractional) are converted on load:
  - `microInt = round(legacy * INT_MULT)`

---

## BOUNDS (No Step Crossing)

Let `stepsPerBeat` be derived from the sequencer grid:

- `stepsPerBeat = baseDivision / 4`
- `ticksPerStepInt = PPQN_INT / stepsPerBeat`
- `M = ticksPerStepInt - 1`
- Constraint: `microInt ∈ [-M .. +M]`

For the current app (16ths):

- `ticksPerStepInt = 96 / 4 = 24`
- `M = 23`

**Important:** clamp at write-time. Do not spill across adjacent steps.

---

## EVENT TIME MODEL (Swing + Microtiming)

Microtiming is applied **after** swing.

```
baseStepTickInt =
  patternStartTickInt
  + stepIndex * TICKS_PER_STEP_INT
  + swingOffsetInt(stepIndex)

eventTickInt = baseStepTickInt + microInt
```

Swing is expressed in internal ticks:

```
swingOffsetInt = round(TICKS_PER_STEP_INT * swingAmount)
```

---

## SCHEDULING (Internal Ticks)

All event comparisons are done in internal ticks:

- Window: `(fromTickInt, toTickInt]`
- Fire if `eventTickInt > fromTickInt && eventTickInt <= toTickInt`

**Step 0 early wrap:**

If `eventTickInt` goes negative within a loop, wrap with positive modulo:

```
eventTickInt = ((eventTickInt % patternTicksInt) + patternTicksInt) % patternTicksInt
```

Where:

- `patternTicksInt = length_steps * TICKS_PER_STEP_INT`

---

## CLOCK IO (Unchanged)

- **Clock in:** still 24 PPQN.
- **Clock out:** still 24 PPQN.
- Internal ticks are derived from external ticks using `INT_MULT`.

No protocol changes for MIDI clock or other external timing formats.

---

## LED / HARDWARE INTERACTION

### Activation + nudging workflow

1. Enter **Note Edit Mode** (existing mode)
2. Press the **Left Adjacent Button** to activate **Microtiming Edit**
3. While Microtiming Edit is active:
   - **Left Adjacent Button** nudges timing **earlier** (`microInt -= 1`)
   - **Right Adjacent Button** nudges timing **later** (`microInt += 1`)

### LED behavior (match octave shifting semantics)

- `microInt > 0` -> right LED on
- `microInt < 0` -> left LED on
- `microInt == 0` -> no indicator (or both off, matching octave UI rules)

---

## UI (Canvas) — HOVER ICONS + AMOUNT

### Hover affordance

Use the same hover method as octave shifting:

- show octave shifting icons
- show microtiming icons:
  - left: `transition-left`
  - right: `transition-right`

### Amount display

Show the microtiming amount as an overlay on the active note (same style as octave):

- `+n` for positive offsets
- `n` for negative offsets
- `0` hidden (match octave behavior)

Overlay should disappear after 2 seconds unless another shift occurs.

---

## IMPLEMENTATION REQUIREMENTS

- No new clock; internal ticks are derived from external ticks.
- All scheduling uses internal ticks.
- All external-facing clock semantics remain 24 PPQN.
- Keep integers for exact values: bar ticks, step ticks, microInt, pattern ticks.
