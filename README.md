# studio:grid

`studio:grid` is a grid-based multi-sequencer and composer for monome grids (or without).

## Quick Start
- Dev server: `npm start` (http://localhost:3000)
- Electron app: `npm run electron`
- Lint/syntax checks: `npm run lint`
- Test suite: `npm test`
- Manual probes: `npm run test:manual`
- Full local gate: `npm run check`
- Build installers: `npm run dist`

## Beta Releases
- Bump to next beta version (creates commit + tag): `npm version prerelease --preid=beta`
- Push commit + tag: `git push origin main --follow-tags`
- Pushing tags like `v0.1.2-beta.0` triggers `.github/workflows/beta-release.yml`
- Workflow publishes a GitHub pre-release with `.dmg` and `.exe` assets

## Documentation
- Docs index: `docs/README.md`
- User manual: `docs/manual/README.md`
- Runtime code map: `AGENTS.md`
- Feature ownership: `docs/reference/app-features.md`
- UI standards: `docs/standards/ui-standards.md`
- Specs: `docs/specs/`

## Project Layout
- `electron/`: desktop shell/bootstrap
- `server/`: HTTP, WebSocket, transport, sequencing state integration
- `public/`: browser UI and WebMIDI logic
- `tests/`: canonical regression tests
- `tests/manual/`: archived/manual behavior probes
- `fixtures/`: static fixtures and sample payloads
