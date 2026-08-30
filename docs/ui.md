# UI rules

Distilled 2026-08-30 from ui-skills.com (`better-ui`, `better-typography` by shadcn, plus the site playbook), beautifului.dev (AI-tool status/approval patterns) and designsystemchecklist.com categories. Consult before touching any UI surface: extension popup, backend sessions page, timeline.

We write vanilla HTML/CSS (no component library — the surfaces are tiny). coss.com/ui and beautifului.dev are the pattern references when a new component is needed.

## Tokens

- Palette: neutral greys for structure, one accent `#2563EB`, semantic `#D64545` (recording/error) and `#1B8A5A` (success). Light theme only.
- Type: `system-ui, -apple-system, "Segoe UI", sans-serif`. Sizes 12/13/15 only. `font-variant-numeric: tabular-nums` on every count, time, and code value. `text-wrap: pretty` on copy.
- Spacing: 4px grid. Popup width 320px.

## Rules

- Concentric radius: outer = inner + padding. Card 12 / control 8 / inner 4.
- Shadows for elevation (layered, transparent), borders for structure and state only.
- Every control defines hover, active, focus-visible, and disabled. Press feedback: `scale(0.96)`, exactly.
- Transitions ≤150ms, only on named properties (`color, opacity, transform`). No entrance animations on the popup.
- Motion is never the only feedback channel: the recording pulse always sits next to the word "Recording".
- Focus: 2px `focus-visible` ring, offset 2px. Hit areas ≥ 36px visual with padding to ~44px effective.
- Contrast ≥ 4.5:1 for text. Icons use `currentColor`, one stroke weight.
