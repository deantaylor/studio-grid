FULL COLOR + STATE SYSTEM SPEC (AUTHORITATIVE)
0. Core principles (non-negotiable)

All colors come from tokens (CSS variables). No hardcoded hex in components.

Warm white is default, cool white is selectable later.

Icons, grid LEDs, pattern followers are white unless explicitly stated.

Only the Device Tab uses the device color.

All interactive states are generated algorithmically, never manually.

LED brightness is discrete and deterministic (0–16).

1. Base color tokens (global)
:root{
  /* Neutrals */
  --bg: #2E2E2E;
  --surface: #3C3C3C;
  --muted: #6F6F75;
  --label: #8F8F8F;

  /* Whites */
  --fg-warm: #E6E1D4; /* default */
  --fg-cold: #F4F3FF; /* selectable later */

  /* Active white */
  --fg: var(--fg-warm);

  /* Icon color */
  --icon: var(--fg);
}

White mode toggle
:root[data-white="warm"]{ --fg: var(--fg-warm); }
:root[data-white="cold"]{ --fg: var(--fg-cold); }

2. Device color palettes
2.1 Pastel device colors (default user set)
:root{
  --dev-1: #FF786E;
  --dev-2: #FFB39A;
  --dev-3: #FFE09A;
  --dev-4: #B6F2A6;
  --dev-5: #9DE6E8;
  --dev-6: #A5C4FF;
  --dev-7: #D1B8FF;
  --dev-8: #FFB3D8;
}

2.2 Strong device colors (optional / future)
:root{
  --dev-strong-1: #FF786E;
  --dev-strong-2: #FFB347;
  --dev-strong-3: #FFD84D;
  --dev-strong-4: #7CFF6B;
  --dev-strong-5: #4DEEFF;
  --dev-strong-6: #5C8CFF;
  --dev-strong-7: #B57CFF;
  --dev-strong-8: #FF6EC7;
}

3. Color usage rules (hard rules)
3.1 Icons

All icons use --icon

--icon defaults to --fg

SVGs must use fill: currentColor

Only explicit exceptions may override icon color (e.g. “Clear Pattern”)

3.2 LEDs & indicators

Grid LEDs → white only

Pattern followers → white only

Device color never affects LEDs

3.3 Device color scope

Only the Device Tab may:

use device color as background/accent

compute smart foreground color

No other UI element inherits device color

4. Interactive state generation (algorithmic)
4.1 Global mix constants
:root{
  --mix-hover: 10%;
  --mix-pressed: 12%;
  --mix-disabled: 65%;
  --mix-ring: 25%;
  --mix-border: 8%;
}

4.2 Stateful contract

Any interactive component must set --base.

.stateful{
  --hover:    color-mix(in oklch, var(--base), var(--fg) var(--mix-hover));
  --pressed:  color-mix(in oklch, var(--base), var(--bg) var(--mix-pressed));
  --disabled: color-mix(in oklch, var(--base), var(--bg) var(--mix-disabled));
  --ring:     color-mix(in oklch, var(--base), var(--fg) var(--mix-ring));
  --border:   color-mix(in oklch, var(--base), var(--fg) var(--mix-border));

  --fg-disabled: color-mix(in oklch, var(--fg), var(--bg) 45%);
}

4.3 SRGB fallback
@supports not (color: color-mix(in oklch, #000, #fff 50%)){
  .stateful{
    --hover:    color-mix(in srgb, var(--base), var(--fg) var(--mix-hover));
    --pressed:  color-mix(in srgb, var(--base), var(--bg) var(--mix-pressed));
    --disabled: color-mix(in srgb, var(--base), var(--bg) var(--mix-disabled));
    --ring:     color-mix(in srgb, var(--base), var(--fg) var(--mix-ring));
    --border:   color-mix(in srgb, var(--base), var(--fg) var(--mix-border));
    --fg-disabled: color-mix(in srgb, var(--fg), var(--bg) 45%);
  }
}

5. Smart foreground selection (Device Tab only)
Requirement

When a device color is used as a background, text/icons must automatically choose:

--bg or

--fg
based on contrast.

JS requirement

Compute WCAG contrast against both options

Pick higher contrast

Store result in --on-device

Contract
.device-tab{
  --base: var(--device);
  background: var(--base);
  color: var(--on-device);
}

Recompute

Must recompute if:

device color changes

white mode changes (warm ↔ cold)

6. LED system (0–16)
Meaning

0 = off → surface color

16 = fully active → current white

Levels are visually even and monotonic

Tokens
:root{
  --led-0: var(--surface);

  --led-1:  color-mix(in oklch, var(--fg), var(--surface) 94%);
  --led-2:  color-mix(in oklch, var(--fg), var(--surface) 88%);
  --led-3:  color-mix(in oklch, var(--fg), var(--surface) 82%);
  --led-4:  color-mix(in oklch, var(--fg), var(--surface) 76%);
  --led-5:  color-mix(in oklch, var(--fg), var(--surface) 70%);
  --led-6:  color-mix(in oklch, var(--fg), var(--surface) 64%);
  --led-7:  color-mix(in oklch, var(--fg), var(--surface) 58%);
  --led-8:  color-mix(in oklch, var(--fg), var(--surface) 52%);
  --led-9:  color-mix(in oklch, var(--fg), var(--surface) 46%);
  --led-10: color-mix(in oklch, var(--fg), var(--surface) 40%);
  --led-11: color-mix(in oklch, var(--fg), var(--surface) 34%);
  --led-12: color-mix(in oklch, var(--fg), var(--surface) 28%);
  --led-13: color-mix(in oklch, var(--fg), var(--surface) 22%);
  --led-14: color-mix(in oklch, var(--fg), var(--surface) 16%);
  --led-15: color-mix(in oklch, var(--fg), var(--surface) 10%);
  --led-16: var(--fg);
}


SRGB fallback uses same percentages.

7. LED helper (required)
JS helper
export function clampLedLevel(level){
  const n = Number(level);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(16, Math.round(n)));
}

export function ledVar(level){
  return `var(--led-${clampLedLevel(level)})`;
}

Usage
el.style.backgroundColor = ledVar(level);

8. Explicit exclusions (do not add silently)

No semantic colors (error / warning / success)

No glow / bloom

No opacity-based LED brightness

No per-component hover colors

No device color bleed outside Device Tab

9. Acceptance criteria

Switching warm/cool white updates:

text

icons

LEDs (all 16 levels)

LED 0 == --surface

LED 16 == --fg

Device color only visible in Device Tab

All states derived from --base

No hardcoded hex colors remain in components