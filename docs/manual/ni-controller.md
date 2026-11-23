# Studio Grid Native Instruments bridge

## Setup

The macOS Studio Grid installer includes the bridge. In Studio Grid, open
**Settings → General** and turn on **Native Instruments bridge**. The
setting takes effect immediately and is saved for the next launch. Leave the
Native Instruments hardware service running and select `studiogrid` from the
controller's instance menu.

The bridge automatically registers `studiogrid` on every connected NI
controller with two 480 × 272 displays and an Encdr instance route. You can
connect controllers before or after startup. They share the same Studio Grid
session, with independent button holds and display modes.

- **Displays and mapped controls** on Komplete Kontrol S49, S61, and S88 MK2,
  Maschine MK3, and Maschine Plus.
- **Displays** on Maschine Studio and Traktor Kontrol S5 and S8.

## Controls

Use the display buttons
to switch tracks. The numbered track strip opens by default. **Track** on
Komplete Kontrol or **Channel** on Maschine toggles it. Hold **Pattern** to show the numbered pattern
strip and select a pattern with the display buttons. Release it to return to the prior view.
The calibrated S49 MK2 display-button LEDs use the closest hardware colors
to the track and edit buttons. Pattern buttons use white brightness levels
on both the screen and the hardware, following the Monome pattern selector.
**Key Mode** on the S49 MK2 and **Arranger** on Maschine MK3 and Maschine Plus
open Studio Grid's Pattern Launcher. Both follow the app's **Latch pattern
launch page** setting, and the button LED stays bright while the launcher is open.

Turn the main dial to scroll the note grid vertically. Tilt
the dial left, right, up, or down to move the current bar's notes one step or
scale row in that direction. Turn the eight display knobs to edit the values
shown beneath the grid and track details.
Hold the selected track's display button to show track setup immediately.
Knobs 1, 3, and 4 control **Type**, **MIDI Out**, and **Ch** or **MD Track**.
Release the display button to return to the regular parameters.
Press **<** or **>** to lower or raise the current track's Octave setting.
The tempo knob follows the app's external clock setting.
While Studio Grid is active on any NI controller, the Monome uses all eight
rows for notes. The saved Monome control-row preference returns when the last
active NI controller switches instances or disconnects.

Hold **Clear** on Komplete Kontrol or **Erase** on Maschine to show
**Copy Bar**, **Copy Pattern**, **Paste**, and **Clear** on the right, including
while **Pattern** is held.
Hold a grid note to show **ACCENT**, **SLIDE**, **OCT +**, and **OCT -**.
The Monome shows the held note's microtiming strip automatically. The left
display buttons are inactive during note edit and while Clear or Erase is held.
**Clear** opens a choice between clearing the current bar and the pattern.
These controls use the open Studio Grid window's clipboard and show its
alerts on the right display.

## Distribution

The macOS installer includes the bridge executable and its source archive in
the app's `Contents/Resources/ni` directory. The bridge is GPL-3.0-or-later
and runs as a separate process. See [Development and builds](development.md)
for building or previewing it from a checkout.
