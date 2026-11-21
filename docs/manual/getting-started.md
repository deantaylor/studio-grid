# Getting Started

## Overview
`studio:grid` is a grid-based multi-sequencer and composer for monome grids (or without).

- Each set has up to 8 devices/pages.
- Each page has 8 patterns.
- Pattern length supports up to 128 steps.
- Export/import supports `.studiogrid`, `.sgridset`, and TD-3 `.seq`.

## Prerequisites
- `serialosc` running locally if using monome hardware
- WebMIDI-capable browser (Chrome/Chromium) or Electron app
- OS-visible MIDI destinations

## Starting Studio Grid

Open the desktop app or run the browser version from the source checkout. See [Development and builds](development.md) for commands and dependencies.

## Interface Tour
- Top bar: transport, set actions, settings
- Device tabs: 8 pages, color/name controls
- Device toolbar: sequencer type, transpose, MIDI routing, TD-3 actions
- Grid canvas: 16x8 edit area
- Pattern toolbar: pattern select, bar/pattern ops, length and scale controls
- Settings modal: tempo/swing, clock source, LED levels, defaults, config persistence
