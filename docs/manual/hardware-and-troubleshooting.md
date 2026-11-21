# Hardware and Troubleshooting

## Hardware Grid
- Monome discovery is handled through `serialosc`.
- Hardware key presses mirror UI interactions.
- Use **Settings → General → Rotate Monome 180°** to flip the grid's keys and LEDs. Use **Save Config** to keep the orientation across app launches.
- Pattern-control latch behavior is configurable in settings.
- To scroll the note rows on a 16-column Monome, enable **Show monome controls**. Hold the second key from the right on the bottom row. Press the rightmost key to scroll up or the third key from the right to scroll down.
- LED clear is triggered on app quit and can be invoked via API paths.

## Appearance and Usability
- UI scale options: `1.0`, `1.25`, `1.5`
- Adjustable LED levels for core states (step, accent, playhead, pattern, device)
- Per-device colors and default color palette support

## Keyboard and Mouse Shortcuts
- `Shift + Arrow`: shift pattern content
- Hover popup `Up/Down`: octave nudge
- Right-click step: step context menu
- Right-click device tab: rename/color menu
- `Cmd/Ctrl + ArrowUp/ArrowDown`: transpose
- Drag device tabs to reorder devices

## Troubleshooting
- No grid input/LEDs: verify `serialosc`, replug hardware, wait for rediscovery.
- No MIDI output: verify WebMIDI permission and per-page output/channel routing.
- External clock not advancing: verify clock source is `External` and input is selected.
- Lost work after reload: export regularly or enable auto-load last project.
