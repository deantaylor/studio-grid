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

See the [NI controller guide](ni-controller.md) for the optional bridge build and preview.

## Beta releases

1. Run `npm version prerelease --preid=beta` to create the version commit and tag.
2. Push the release commit and tag with `git push origin main --follow-tags`.
3. A `v*-beta*` tag triggers the [beta release workflow](../../.github/workflows/beta-release.yml), which publishes macOS DMGs and a Windows installer.

## Code map

- [Runtime code map](../../AGENTS.md) covers the Electron shell, local server, and browser UI.
- [Feature map](../reference/app-features.md) lists entry points by feature.
- [Documentation index](../README.md) links to implementation standards and behavior specs.
