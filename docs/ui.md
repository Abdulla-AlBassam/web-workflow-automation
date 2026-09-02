# UI rules

Dark theme rebuilt 2026-09-03 on beautifului.dev's design language (tokens, loading vocabulary, motion) over the original ui-skills.com rules. Consult before touching any UI surface: extension popup, backend session pages.

We write vanilla HTML/CSS (no component library, the surfaces are small). beautifului.dev is the pattern reference when a new component is needed.

## Tokens

- Dark only. Page `#17181a`, raised surfaces `#232427`, inset wells `#1f2022`, fields `#2b2c2f`, hover `#2a2b2e`.
- Ink scale: `#f2f3f4` / `#a5a8ad` / `#6c6f75`. Hairlines `#2e3033`, strong `#3a3c40`.
- No accent colour. Primary buttons are ink-on-white. Colour is signal only: green `#3cbb72` (ok), red `#ee5c61` (failure, recording), amber `#f68f3c` (warnings), each with a 14% alpha tint for chips and notes.
- Type: system stack. Sizes 11/12/13/15, headings tracked -0.01/-0.02em. `tabular-nums` on every count, time, and code value. `text-wrap: pretty` on copy.
- Radii: chip 6 / control 8 / card 10. Pills are full-round.
- Elevation: 1px white-alpha hairline ring plus a soft shadow (`--shadow-card`), never a plain border on a card.

## Components

- Collapsed-by-default context (`details.fold`): chevron, section icon, title, status chips right-aligned. Content is progressive disclosure; nothing informational stays expanded by default.
- "i" pills hold fixed explainers; "?" pills hold run-dependent clarifications (amber ring when present). Both are click-toggled popovers, fixed-positioned and viewport-clamped, closed on scroll or Escape.
- Loading: 3x3 pixel-grid loader (`pixel-on` 650ms, chevron wavefront delays) + shimmer label + elapsed timer. No rotating spinners anywhere.
- Status dots: green complete, red interrupted, pulsing red recording. The word sits next to the dot; motion is never the only channel.

## Rules

- Everything appears only when it is needed: warnings only when warranted, Adjust only after a run, Bulk only for single-parameter specs, dropped-events chip only when non-zero.
- Every control defines hover, active, focus-visible, and disabled. Press feedback: `scale(0.96)`, exactly.
- Transitions <=200ms on named properties; ease `cubic-bezier(.23,1,.32,1)`. No entrance animations on the popup.
- Focus: 2px white-alpha `focus-visible` ring. Hit areas >= 34px visual.
- Contrast >= 4.5:1 for text. Icons are inline SVG, `currentColor`, one stroke weight (1.4).
- `prefers-reduced-motion` freezes every animation.
