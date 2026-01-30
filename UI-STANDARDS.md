# UI Standards

## Layout spacing
- The app shell always keeps `var(--spacing-40)` on the top and bottom so the badge row and pattern toolbar never bump the window edges.
- The badge row stacks the tempo/swing/scale controls 32px below, and the resulting toolbar sits 32px above the device tab row to keep the header compact but spacious.
- Device tabs and the settings toolbar are separated by a 16px gap (an exception for visual balance); every other section-to-section gap (header→devices, grid→pattern row) is driven by `var(--spacing-24)`.
- A 24px grid wrap margin plus a pattern toolbar bottom margin of 40 ensures consistent breathing room before the next section or window bottom.

## Labels & inputs
- All inputs/selects/number fields stay transparent; only the `.label` wrapper provides a muted left border (24px tall, centered vertically, with 8px of padding between the border and text).
- Scale note badges and CC-specific labels opt-out of the border so they behave like inline text rather than decorated form controls.
- MD Tonal channel selectors keep the `-` option visible but gain `data-readonly="true"` so they look like the tempo value in external mode while remaining non-interactive.

## Transport controls
- The transport trio mirrors the pattern launcher button: 32px squares with `var(--surface)` backgrounds, tight 4px gaps, and identical icon sizing so record/play/stop never feel heavier than other controls.
- The record icon uses `var(--dev-1)` to match the device palette while play and stop icons stay on-brand with the rest of the header.

## Tasks
- [x] Logged the spacing rules above and documented the exceptions for the device toolbar/window padding.
- [x] Updated the label helper to draw a single 24px tall border and hid it on scale notes/CC labels so every row uses the same visual system.
- [x] Resized the transport buttons to 32px squares so they match the pattern launcher and aligned them within the top controls layout.
- [x] Reworked the MD Tonal channel selector into a read-only dropdown (no disabled hover state) that now shows “-” like the tempo display.
