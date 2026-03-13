These files are archived probes and behavior checks that are not part of the default `npm test` suite.

Run them explicitly with:
- `npm run test:manual`

They currently fall into one of these categories:
- they target APIs that no longer exist in the current codebase
- they assert behavior that no longer matches the shipped runtime

Keep them here until they are either updated into canonical regression tests or removed.

Legacy probes that depend on removed modules or intentionally stale behavior are kept in `tests/manual/legacy/`.
