# Development and builds

## Run locally

Use Node.js 20.19+, 22.13+, or 24+, as supported by the repo’s development tooling.

| Command | Purpose |
|---|---|
| `npm ci` | Install development and runtime dependencies |
| `npm ci --omit=dev` | Install runtime dependencies only |
| `npm start` | Start the browser version at `http://localhost:3000` |
| `npm run electron` | Run the desktop app |
| `npm run check` | Run lint and the test suite |
| `npm run test:manual` | Run the manual timing and scheduler probes |
| `npm run dist` | Build the desktop installers with Electron Builder |

On macOS, install a current stable Rust toolchain to build the bundled
Native Instruments bridge. Packaging builds it automatically from the Encdr
sources included in the repository. For an unpackaged app, run
`npm run ni:build` once, then `npm run electron` and turn on the bridge in
**Settings → General**. The [NI controller guide](ni-controller.md) lists the
supported models.

### Live NI display preview

On macOS, run `npm run ni:build` and then `npm run electron:ni:preview`.
One window shows the two 480 × 272 NI displays side by side. On narrow screens
the panels stack. The preview follows the controller Studio Grid owns, or
shows a live track view as you edit or play when no controller is owned.

For the browser version, start `npm run dev` in one terminal and run
`STUDIO_GRID_NI_PREVIEW=1 npm run ni:bridge -- ws://127.0.0.1:3000`
in another. Closing the preview window stops that session’s NI bridge.

Set `STUDIO_GRID_NI_CONTROLLER` to limit discovery to one model
(`s49`, `s61`, `s88`, `maschine-mk3`, `maschine-plus`, `maschine-studio`,
`kontrol-s5`, or `kontrol-s8`).

## Beta releases

1. Run `npm version prerelease --preid=beta` to create the version commit and tag.
2. Push the release commit and tag with `git push origin main --follow-tags`.
3. A `v*-beta*` tag triggers the [beta release workflow](../../.github/workflows/beta-release.yml), which publishes macOS DMGs and a Windows installer.

## Code map

- [Runtime code map](../../AGENTS.md) covers the Electron shell, local server, and browser UI.
- [Feature map](../reference/app-features.md) lists entry points by feature.
- [Documentation index](../README.md) links to implementation standards and behavior specs.
