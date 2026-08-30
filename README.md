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
  typed value landed in which request body, and which request returned the
  outcome. No LLM.
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

## Record a session

Open the target page, click the extension, enter a session code and the allowed
hosts, and Start. Perform the workflow, then Stop. The session appears at
`http://127.0.0.1:4823/` — open it for the timeline, the analysis, and (once
generated) the spec.

Generate the spec for a recorded session:

```bash
curl -s -X POST 127.0.0.1:4823/api/sessions/<id>/spec \
  -H 'content-type: application/json' \
  -d '{"name":"sijilat-cr-search","origin":"https://www.sijilat.bh","loadUrl":"https://www.sijilat.bh/public-search-cr/search-cr-2.aspx","probe":true}'
```

## Replay against a new input

```bash
npm run run -- fixtures/sijilat-cr-search.spec.json cr_name_en=pharmacy
```

The runner acquires the anonymous token the site issues client-side, makes the
one direct search call, validates the outcome, and prints the extracted result.

## Tests

```bash
npm run e2e              # full capture path, real Chromium against the mock
npm run test:failures    # interrupted / missing param / missing endpoint / changed outcome / absent token
npm run typecheck
```

Tests run against `fixtures/`, never the live site. Live Sijilat use is
low-volume and operator-initiated.

## Safeguards

No CAPTCHA bypass, no authenticated areas, no credential capture. The one
authenticated call in the Sijilat demo uses the anonymous bearer token the site
mints for every visitor; the runner reads that token, it never derives or
submits a password. See `docs/sijilat.md`.
