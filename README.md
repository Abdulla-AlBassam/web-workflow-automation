# Web workflow automation

Record a web workflow once, in your own browser, and get back a reusable
automation. The tool watches an operator demonstrate the workflow, works out
how the page actually produces its result, and generates the leanest
automation that reproduces that outcome for any new input.

The recording is evidence, not the automation. Instead of replaying clicks
the way browser-robot tools do (Browse AI, Octoparse, Axiom), the analysis
reverse-engineers the recording down to the site's own API call — the
structured HTTP request the page's JavaScript makes to fetch its data — and
invokes it directly. Per run that is faster and cheaper than driving a browser, and
the result is the server's structured JSON rather than scraped HTML. Browser
steps still exist, but only for the parts a plain HTTP request cannot reach.

Demonstrated on the public Sijilat commercial-registry lookup and generalised
against wwe.com; the recorder and analysis are site-agnostic.

## How it works

**Record → Analyse → Generate → Execute.**

### 1. Record (`extension/` + `backend/`)

An MV3 Chrome extension captures the demonstration: typed values, clicks,
navigations, text the operator highlights as wanted data, and same-site
network traffic (request and response bodies included). Events stream to a
local Fastify backend as they happen.

Capture is allowlisted to the hosts you name when starting the session (the
popup prefills the current site). Cookies, `Authorization` headers and
password values are never retained; redaction happens in the extension and is
enforced again by the backend.

### 2. Analyse (`backend/src/analyse.ts`)

Deterministic correlation, no model in the loop:

- Which typed value landed in which request, matched exactly in JSON and
  form-encoded bodies, and in URLs in raw, percent- and plus-encoded forms.
  A value hiding inside a composite string field (a query string bundled
  into one JSON value, as Algolia-style APIs send) is matched as a bounded
  token, but only when nothing matched it exactly — exact evidence wins.
- Which request produced the outcome: scored by whether it carried an input
  value, succeeded, and returned a record set.
- Chains: a value from the search response (an id, a slug) found in a later
  request's URL, backed by positive evidence (a marked value in the later
  response, or a recorded click between the two), links the calls.
- Page chains: marked data that no API response carries must be rendered
  server-side. If the operator navigated to a page the search response links
  to and marked text there, that page becomes the outcome and the marked
  elements' selectors are kept.

### 3. Generate (`backend/src/generate.ts`)

Analysis becomes a parameterised JSON spec (format in `docs/spec.md`): one
parameter per distinct typed value, and the smallest set of steps that
reproduces the outcome:

- `request` — the direct API call, with parameters templated into the body
  or URL. The default and the preferred step.
- `browser-token` — added only when an unauthenticated probe of the outcome
  call fails. At run time it loads the site and discovers the anonymous
  bearer generically from web storage (JWT-shaped values, token-named JSON
  fields), and reports where it found it.
- `link` — a chained call whose URL is rebuilt per input from the search
  response, best-matching row first.
- `browser-extract` — for server-rendered outcomes: loads the linked page
  and reads the operator-marked selectors as columns.

If a numeric page field in the request pairs with a total in the response,
the spec records it and runs fetch every page, not just the first. Marked
values found in the outcome response become named columns, so runs return
exactly the fields the operator showed interest in. Specs carry a version;
one saved by an older generator regenerates automatically before use.

### 4. Execute (`runner/`)

The runner takes a spec plus new input values, executes the steps, validates
the outcome against what the recording promised, and stops with a named
reason on any mismatch: no token found, endpoint changed, selector no longer
matches, empty search. It never guesses past a failure.

## Using it

### Setup

```bash
npm install
npx playwright install chromium
npm run build:ext        # builds extension/dist
```

Load `extension/dist` as an unpacked extension at `chrome://extensions`
(Developer mode on), then start the backend:

```bash
npm run backend          # http://127.0.0.1:4823
```

### Record and run

1. Open the target page, click the extension icon, check the host allowlist,
   **Start**.
2. Perform the workflow once, exactly as a user would. To choose output
   fields, highlight the data you care about and click the **Mark data** chip
   that appears; a drag across a whole block marks its container, which
   generalises better than a single line.
3. **Stop**. The session page opens itself: analysis and spec generation ran
   automatically, and the page shows the timeline, the identified outcome
   call, and the generated steps with their reasons.
4. Enter a new value in **Run the automation** and click **Run**. Steps
   execute, the outcome is validated, results render as a table.
5. **Bulk run**: one value per line, sequential with a delay, per-input
   status, one aggregated table. **Download CSV / JSON** under any results
   table.

The same replay is available headlessly:

```bash
npm run run -- fixtures/sijilat-cr-search.spec.json cr_name_en=pharmacy
```

## What it can automate

Each shape below is covered by the test suites; those marked live were also
verified against the real site.

- **Search with the value in a request body** (JSON or form-encoded) → one
  direct API call. Live: Sijilat CR search.
- **Search with the value in the URL** (GET, any common encoding) → a
  templatised URL. Live: wwe.com search, 11,410 results replayed.
- **Search with the value inside a composite string field** (Algolia-style
  `"params": "query=x&page=0"`) → the placeholder splices into the string
  and keeps the encoding the site used.
- **Classic form-encoded posts** (`name=x&lang=en` bodies, the legacy AJAX
  shape) → the raw body is templated in place and replays form-encoded.
- **A recording whose search returned zero results** still yields a working
  automation: correlation keys on where the value went, not what came back.
- **Sites requiring an anonymous token** → a browser step acquires it at run
  time, generically. Live: Sijilat (`localStorage` bearer, discovered and
  named by the run).
- **Multi-field forms** → one parameter per typed value.
- **Chained lookups** (search, then a detail call keyed by a value from the
  search response) → the runner re-resolves the link per input, picking the
  best-matching row. Live: wwe.com.
- **Server-rendered detail pages** → marked elements are extracted from the
  linked page by a supervised browser step. Live: wwe.com superstar bios,
  recorded once and replayed for other names.
- **Paged APIs** (page field in the body, total in the response) → the run
  fetches all pages.
- **Bulk input lists** with aggregated, exportable results (CSV/JSON).

## What it cannot do

Honest limits, current as of this version:

- **Server-rendered result lists.** If the search results themselves are
  HTML with no API behind them (common on older sites and on Next.js/RSC
  sites), there is no call to promote and the tool refuses with a note.
  Marked single pages work (see browser-extract); a generic scraper for
  repeated HTML list structures is not built.
- **URL-borne pagination.** Fetch-all triggers only for a page field carried
  in the request body; `?page=2` in a URL is not yet detected.
- **Logins, CAPTCHAs and bot walls.** Out of scope by design. No credential
  capture, no CAPTCHA bypass, no authenticated areas. A site behind a
  Cloudflare challenge will not record usefully.
- **Per-request signing.** If every request must be individually signed by
  page JavaScript, a direct call cannot be generated. (Anonymous token
  minting, as on Sijilat, is not signing and is handled.)
- **Third-party API hosts** are captured only if added to the allowlist when
  the recording starts; the popup prefills the current site only.
- **One recording, one workflow.** A new site or a changed workflow needs a
  fresh recording and a human eye on the generated spec. The tool
  generalises the method, not any individual automation.

When any of these bite, the failure is explicit: the session page or the run
says what was expected, what was found, and why it stopped. Interrupted
recordings are reviewable but never become automations.

## When it refuses or gets it wrong: the LLM repair assistant

A recording the deterministic analyser refuses can be handed to an LLM,
by clicking **Begin LLM repair** on the session page. It is always operator-
triggered, never automatic. A console on the page shows the loop as it runs:
the model's diagnosis, each proposed call, and the result of executing it.

The division of labour is strict. The model reads a truncated digest of the
sanitised trace and proposes one direct HTTP call. Deterministic code then
executes that proposal with the recorded input values and accepts it only if
the response is structured JSON carrying evidence the operator actually saw
while recording (marked text, or the result they clicked). A failed attempt
is fed back to the model for another round, up to four; a verified one is
saved as a normal spec, the session is titled, and the Run and Bulk panels
work as usual. Nothing unverified is ever saved, and a repaired spec says so
on the session page. When no direct call can work, for example nothing was
typed during the recording, the assistant says so and explains how to
re-record instead.

What the operator marked is what a run must return. When the recording
carries marked selections, a proposal is accepted only if its response holds
them as plain fields: the validator locates each mark in the live response
(comparing letters and digits only, so reference markers such as `[4]`,
pronunciation glyphs and punctuation that page text has and API fields do not
cannot defeat a match, and a long selection matches on any shared stretch),
picks the record set by that evidence rather than by
position (the model may say where the records live, and that hint breaks
ties but never overrules the evidence), and saves the marks as the spec's
columns. A response carrying only
some of the marks is fed back to the model with the missing ones named; if
nothing better turns up, the best verified attempt is kept and the console
says which marks it lacks.

The same loop refines a saved automation. After any run, the session page
offers **Fix with LLM** with an optional note. The assistant receives the
current automation, what the last run returned (row count, columns, first
row) and the note; without a note it compares the marked selections with the
result itself. A verified replacement is saved over the old spec and the
provenance line on the page says it was refined, quoting the note. A failed
attempt leaves the saved automation untouched.

Guard rails on every proposal: hosts limited to the recording's allowlist,
GET and POST only, no custom headers, no credentials, one validation request
per round. To enable the assistant, put `ANTHROPIC_API_KEY=...` in a `.env`
file at the project root (gitignored) and restart the backend; without a key
the button explains what is missing. Note that using it sends the trace
digest to the Anthropic API, the only part of the tool that leaves the
machine.

## Safeguards

- Network capture is allowlisted per session; third-party traffic is dropped
  at capture, not at export.
- Cookies, auth headers and password values are never stored. Redaction is
  two-layer (extension, then backend) and asserted by the e2e suite.
- Live-site use is low-volume and operator-initiated; every automated run is
  started by a person. Test suites run only against local fixtures.
- The one authenticated call in the Sijilat demonstration uses the anonymous
  token the site mints for every visitor; the runner reads that token, it
  never derives or submits a credential.

## Project layout

```
extension/   MV3 recorder (popup, content script, MAIN-world network tap)
backend/     Fastify: event store, redaction, analysis, spec generation, UI
runner/      Spec execution: direct requests, token discovery, extraction
fixtures/    Local mock site, banked traces and specs (tests and demos)
e2e/         Capture e2e (real Chromium), failure paths, enhancements
docs/        Spec format, site evidence, UI rules
```

## Tests

```bash
npm run e2e                # full record→replay path in real Chromium (backend must be stopped)
npm run test:failures      # every named stop: interrupted, missing param, changed outcome, absent token
npm run test:enhancements  # pagination, bulk, URL specs, chains, extraction
npm run test:matrix        # scenario matrix: seven site shapes recorded end to end in real Chromium
npm run test:repair        # LLM repair loop against a scripted mock model and a live JSONP mini-site
npm run typecheck
```
