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
- The Automation card's "i" (and the refusal card's) says in plain English what the tool builds on its own, with examples, and sends anything more to Maximum Effort Mode. Its chips say what the automation actually does: a deterministic spec shows its step count and "direct requests" or "N browser steps"; a session script shows "opens a browser" or "direct requests" read from its source, its provenance and robots.txt. A script's summary lives in the provenance note, never in the "?".
- Loading: 3x3 pixel-grid loader (`pixel-on` 650ms, chevron wavefront delays) + shimmer label + elapsed timer. No rotating spinners anywhere.
- Status dots: green complete, red interrupted, pulsing red recording. The word sits next to the dot; motion is never the only channel.

## Maximum Effort card

- Last card on the session page, `id="effort"`. Open when the session has no automation, closed when it has one.
- Goal textarea first, then the brief row: Full | Chat-sized seg, Export brief, an "i" pill, the export status.
- The paste box and Verify & save appear only once a brief has been exported.
- A verified answer gets an ok note and a "View & run" button that reloads the page. A rejection gets a fail note carrying the exact reason, plus the line telling the operator to paste it back. A 409 is a warning note with nothing to paste back.
- Past entries sit in a `fold-sub`: "Past conversation · N messages" when the log holds model or operator messages, "History · N entries" when it holds import outcomes only.
- "Not what I wanted?" (`btn btn-quiet`) sits under a run result in the Run card, and only when this card is on the page. It opens the fold, scrolls to it and focuses the goal.
- `#effort` in the URL opens the fold on load and on hashchange: a hash alone cannot open a closed `details`.

## Rules

- Everything appears only when it is needed: warnings only when warranted, Bulk only for single-parameter specs, dropped-events chip only when non-zero.
- Every control defines hover, active, focus-visible, and disabled. Press feedback: `scale(0.96)`, exactly.
- Transitions <=200ms on named properties; ease `cubic-bezier(.23,1,.32,1)`. No entrance animations on the popup.
- Focus: 2px white-alpha `focus-visible` ring. Hit areas >= 34px visual.
- Contrast >= 4.5:1 for text. Icons are inline SVG, `currentColor`, one stroke weight (1.4).
- `prefers-reduced-motion` freezes every animation.

Deterministic evidence: the Automation card shows a green "matches what you
saw" chip or an amber "unverified" chip; the "?" explains the verdict.
A refusal shows the recorded call and the reason, omits Run, and opens
Maximum Effort Mode. The Automation "i" remains available on both cards.
