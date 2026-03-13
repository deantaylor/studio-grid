# Sequencing

## Editing the Grid
- Toggle a step by clicking or pressing a cell.
- Remove an active step by pressing it again.
- Hold or hover an active step for octave controls (mono/poly/mdtonal).
- Right-click active steps for accent/slide options where supported.
- Hold an active note and press the step to the right to set slide.

## Chain Behavior
- You can create extended note chains across consecutive active notes.
- Removing a note inside a chain removes downstream notes.
- Removing the first note removes the full chain.
- Octave-shifting a chained note stops the chain and truncates following notes.

## Pattern Editing
- Shift + arrow keys nudges current pattern content.
- Copy/paste supports full pattern and current bar.
- Clear supports bar or full pattern.
- Follow mode pins bar view to playhead when enabled.
- Pattern speed supports `1x`, `2x`, `4x`.
- Pattern length supports up to 128 steps.
- Auto-fill can duplicate existing bars when extending length.

## Sequencer Types
- Mono: single note per step with accent/slide
- Poly: multi-note per step with per-note accent/octave/chains
- Drum: row-based drum notes
- CC: per-step CC values
- MDTonal: Machinedrum tonal sequencing with slide support

## Patterns, Bars, and Switching
- Each device has 8 patterns.
- Pattern switches queue at end-of-pattern.
- Bar view buttons select the active 16-step chunk.

## MIDI, Clock, and Transport
- Transport supports play/stop from UI and hardware interactions.
- Clock source can be internal or external MIDI clock.
- Tempo and swing are adjustable from top bar and settings.
- Base note length supports `1/8`, `1/16`, `1/32`.
- MIDI output and channel are per-page.

## Scale and Transpose
- Global scale supports root + mode selection.
- Per-page transpose is `+/- 2` octaves.
- Octave overlays mirror between UI and hardware.
