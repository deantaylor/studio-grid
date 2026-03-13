# Getting Started

## Overview
`studio:grid` is a grid-based multi-sequencer and composer for monome grids (or without).

- Each set has up to 8 devices/pages.
- Each page has 8 patterns.
- Pattern length supports up to 128 steps.
- Export/import supports `.studiogrid`, `.sgridset`, and TD-3 `.seq`.

## Prerequisites
- Node.js 18+ (for development)
- `serialosc` running locally if using monome hardware
- WebMIDI-capable browser (Chrome/Chromium) or Electron app
- OS-visible MIDI destinations

## Start Commands
- Dev server: `npm start` (http://localhost:3000)
- Electron app: `npm run electron`
- Lint/syntax checks: `npm run lint`
- Tests: `npm test`
- Manual probes: `npm run test:manual`
- Full local gate: `npm run check`
- Build installers: `npm run dist`

## Interface Tour
- Top bar: transport, set actions, settings
- Device tabs: 8 pages, color/name controls
- Device toolbar: sequencer type, transpose, MIDI routing, TD-3 actions
- Grid canvas: 16x8 edit area
- Pattern toolbar: pattern select, bar/pattern ops, length and scale controls
- Settings modal: tempo/swing, clock source, LED levels, defaults, config persistence
