# Workflow capture and outcome automation

A tool that records an operator demonstrating a web workflow, works out how the
page produces its result, and generates the best automation for that outcome.
The recording is evidence for analysis, not the automation itself: the generated
plan prefers a direct API call and uses a browser step only where a request
cannot reach. Demonstrated on the public Sijilat company lookup; the recorder
and analysis work on other pages too.

## Pipeline

**Record → Analyse → Generate → Execute.**

- **Record** — an MV3 Chrome extension (`extension/`) captures ordered operator
  actions and same-site network traffic, streamed to a local Fastify backend
  (`backend/`). Cookies, auth headers and password values are never retained;
  traffic is allowlisted to the target hosts.
- **Analyse** (`backend/src/analyse.ts`) — deterministic correlation: which
  typed value landed in which request body or URL (encoded forms included),
  and which request returned the outcome. No LLM.
- **Generate** (`backend/src/generate.ts`) — a parameterised spec
  (`docs/spec.md`) that prefers one direct request. A body-only probe
  (`backend/src/probe.ts`) decides whether an auth step is needed.
- **Execute** (`runner/`) — replays a spec against a new input under
  supervision, validates the outcome, and stops with a named reason on any
  mismatch.

## Setup

```bash
npm install
npx playwright install chromium
npm run build:ext        # builds extension/dist
```

Load `extension/dist` as an unpacked extension at `chrome://extensions`
(Developer mode on). Start the backend:

```bash
npm run backend          # http://127.0.0.1:4823
```

## Record and automate — the whole loop

1. Open the target page, click the extension, enter a session code, **Start**.
2. Perform the workflow once. Click **Stop**.
3. The session page opens by itself. Stopping triggers analysis and spec
   generation automatically — the page shows the timeline, which request
   produced the outcome, and the generated automation.
4. Type a new value into the **Run the automation** box and click **Run**. The
   generated steps execute (token step if needed, then one direct call), the
   outcome is validated, and the results render on the page. When the API is
   page-based, the runner detects it and fetches every page, not just the
   first.
5. **Bulk run**: paste one value per line and Run all — rows execute
   sequentially with a delay, statuses show per input, and results aggregate
   into one table. **Download CSV / JSON** buttons appear under any results
   table.

No terminal involved after setup. The same replay is also available as a CLI:

```bash
npm run run -- fixtures/sijilat-cr-search.spec.json cr_name_en=pharmacy
```

## Tests

```bash
npm run e2e                # full capture path, real Chromium against the mock
npm run test:failures      # interrupted / missing param / missing endpoint / changed outcome / absent token
npm run test:enhancements  # pagination detection, fetch-all replay, sequential bulk runs
npm run typecheck
```

Tests run against `fixtures/`, never the live site. Live Sijilat use is
low-volume and operator-initiated.

## Safeguards

No CAPTCHA bypass, no authenticated areas, no credential capture. The one
authenticated call in the Sijilat demo uses the anonymous bearer token the site
mints for every visitor; the runner reads that token, it never derives or
submits a password. See `docs/sijilat.md`.
