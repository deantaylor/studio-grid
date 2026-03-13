# Projects and I/O

## TD-3 Import/Export
- Open TD-3 actions from the device toolbar.
- Export downloads `sgrid_td3_pattern.seq` for selected group/pattern.
- Import accepts `.seq` and supports scale-fit options before applying.

## Project Save/Load
- Export saves the full snapshot as `.studiogrid` via `/api/export`.
- Import accepts `.json`, `.studiogrid`, and `.sgridset`.
- New project can preserve selected metadata (device names, MIDI settings).
- Auto-load last project is available in settings.

## Config Persistence
- Settings save/restore stores app config in local storage.
- Config includes clock mode, LED levels, UI scale, default colors, and toggles.

## API Endpoints
- `GET /api/export` downloads the current set as `.studiogrid`.
- `GET /api/export-td3?group=G&pattern=P` downloads TD-3 `.seq`.

## Data Formats
- Project files: `.studiogrid`, `.sgridset`
- TD-3 files: `.seq`
