# Studio Grid Native Instruments bridge

The optional macOS bridge uses the patched Encdr and Encdr View from the
[nord-modular-ni-interface](https://github.com/deantaylor/nord-modular-ni-interface)
checkout. That implementation supplies the Native Instruments hardware-service
transport, the two macOS WebViews, and bounded asynchronous screen capture.
Leave the Native Instruments hardware service running.

From Studio Grid, run `npm run ni:build`, then `npm run electron:ni`.
The build finds an adjacent `modular-machine-mk3` checkout. Set
`STUDIO_GRID_ENCDR_SOURCE` to its path if it is elsewhere.
For a running development server, use
`npm run ni:bridge -- ws://127.0.0.1:3000` instead. The bridge uses the selected
Studio Grid instance as its only source of sequencer state and is listed as
`studiogrid` in the NI controller's instance menu.

The default device is the S49 MK2. Use `STUDIO_GRID_NI_CONTROLLER` to select
`s61`, `s88`, `maschine-mk3`, or `maschine-plus`. Use the display buttons
to switch tracks. **Track** on Komplete Kontrol or **Channel** on Maschine
toggles the numbered track strip. Hold **Pattern** to show the numbered pattern
strip and select a pattern with the display buttons. Release it to return to the prior view.
The calibrated S49 MK2 display-button LEDs use the closest hardware colors
to the track, pattern and edit buttons shown on screen.
**Key Mode** on the S49 MK2 opens Studio Grid's pattern launcher and follows
the app's **Latch pattern launch page** setting. Its LED stays bright while
the launcher is open.

Turn the main dial to scroll the note grid one row at a time. Turn the eight
display knobs to edit the values shown beneath the grid and track details.
Press **<** or **>** to lower or raise the current track's Octave setting.
The tempo knob follows the app's external clock setting.
While the bridge owns the NI controller, Studio Grid turns off the Monome
control row and uses all eight rows for notes. The saved Monome preference
returns when the controller hands off to another instance or disconnects.

Hold **Clear** on Komplete Kontrol or **Erase** on Maschine to show
**Copy Bar**, **Copy Pattern**, **Paste**, and **Clear** on the right, including
while **Pattern** is held.
**Clear** opens a choice between clearing the current bar and the pattern.
These controls use the open Studio Grid window's clipboard and show its
alerts on the right display.

Set `STUDIO_GRID_NI_PREVIEW=1` to open a desktop preview of both displays.

The development bridge is GPL-3.0-or-later and runs as a separate process.
The Electron distribution does not bundle Encdr or the bridge executable.
