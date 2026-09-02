# Web workflow automation

Record a web workflow once, in your own browser, and get back a reusable
automation. The tool watches an operator demonstrate the workflow, works out
how the page actually produces its result, and generates the leanest
automation that reproduces that outcome for any new input.

The recording is evidence, not the automation. Instead of replaying clicks
the way browser-robot tools do (Browse AI, Octoparse, Axiom), the analysis
reverse-engineers the recording down to the site's own API call: the
structured HTTP request the page's JavaScript makes to fetch its data, and
invokes it directly. Per run that is faster and cheaper than driving a browser, and
the result is the server's structured JSON rather than scraped HTML. Browser
steps still exist, but only for the parts a plain HTTP request cannot reach.

Demonstrated on the public Sijilat commercial-registry lookup and generalised
against wwe.com; the recorder and analysis are site-agnostic.

## How it works

**Record → Analyse → Generate → Execute.**

### 1. Record (`extension/` + `backend/`)

An MV3 Chrome extension captures the demonstration: typed values, clicks,
navigations, text the operator highlights as wanted data, and every
fetch/XHR request the page makes, request and response bodies included,
whatever host it goes to. The data behind a search often lives on a domain
nobody would think to name (a search-as-a-service host, an API subdomain),
so nothing is filtered at capture; the analyser ranks calls by whether they
carry the typed value. Bodies are kept up to 2 MB and a longer one is cut
with the cut declared, never silently. Events stream to a local Fastify
backend as they happen.

The host you name when starting the session (the popup prefills the current
site) identifies the site on the session page. Cookies, `Authorization`
headers and password values are never retained; redaction happens in the
extension and is enforced again by the backend.

### 2. Analyse (`backend/src/analyse.ts`)

Deterministic correlation, no model in the loop:

- Which typed value landed in which request, matched exactly in JSON and
  form-encoded bodies, and in URLs in raw, percent- and plus-encoded forms.
  A value hiding inside a composite string field (a query string bundled
  into one JSON value) is matched as a bounded token, but only when nothing matched it exactly: exact evidence wins.
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
- `script`: a per-session program written by the LLM repair assistant when
  none of the above can be derived (see the repair section). It runs in an
  isolated context, returns the rows itself, and is confined to the hosts it
  was verified against.

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

1. Open the target page, click the extension icon, check the site name (it
   labels the session; capture is not limited to it), **Start**.
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

Current as of this version. There are two layers. The
deterministic pipeline correlates the value you typed against the requests
the page made and needs the outcome to come back as structured data; when
that fails, the LLM repair assistant (next section) can investigate and
write a script for the session. The limits below say which layer each
falls on, and which are policy lines drawn on purpose.

The deterministic pipeline refuses, and the assistant usually recovers:

- **Values transformed before sending.** A typed date sent as an epoch, a
  dropdown choice sent as its numeric id. Correlation is verbatim, so the
  pipeline refuses; a session script can apply the transformation.
- **JSONP and script-tag traffic.** Invisible to fetch/XHR interception;
  only the URL is recorded. The assistant probes the plain-JSON form of the
  same endpoint.
- **Server-rendered result lists.** HTML results with no API behind them
  (older sites, Next.js/RSC). The pipeline has no call to promote; a session
  script can drive a browser page and read the list.
- **Responses larger than the recorder keeps.** A body over 2 MB is cut and
  the cut declared; the assistant fetches it in full.
- **Nothing typed, something marked.** A browse-only recording of a listing
  has no parameter; the assistant can still derive a zero-parameter
  automation from the marks.

Nobody can, and the tool says so:

- **WebSockets and cross-origin iframes.** Not captured; a script could only
  guess at them, and guesses are not accepted.
- **Per-request signing, nonces and CSRF tokens.** If every request must be
  minted by page JavaScript, no direct call can be generated; a session
  script that drives the page in a browser may still work, at browser speed.
  (Anonymous token minting, as on Sijilat, is a reusable value parked in web
  storage, not signing, and is handled deterministically.)
- **Logins, CAPTCHAs and bot walls.** Out of scope by design. No credential
  capture, no CAPTCHA bypass, no authenticated areas: cookies and auth
  headers are never kept, scripts cannot send them, and a cookie-session API
  replays as 401. A site behind a Cloudflare challenge will not record
  usefully.
- **Non-text outcomes.** PDF, CSV downloads and images are not structured
  in the tool's sense.

Shape limits of the current build:

- **One-hop chains** in the deterministic pipeline: a search response feeds
  one detail call or one page. A session script may chain further.
- **URL-borne pagination.** Fetch-all triggers only for a page field carried
  in the request body; `?page=2` in a URL is not yet detected.
- **Active tab only.** Results that open in a new tab are not recorded.
- **One recording, one workflow.** A new site or a changed workflow needs a
  fresh recording and a human eye on the generated spec or script. The tool
  generalises the method, not any individual automation.

When any of these bite, the failure is explicit: the session page, the
repair console or the run says what was expected, what was found, and why
it stopped. Interrupted recordings are reviewable but never become
automations.

## When it refuses or gets it wrong: the LLM repair assistant

A recording the deterministic analyser refuses can be handed to an LLM by
clicking **Begin LLM repair** on the session page. It is always operator-
triggered, never automatic. A console on the page shows the loop as it runs:
what the model is checking, every tool it uses, each script it submits and
the verdict on it.

In plain terms: the tool first tries to work out the automation on its own,
with no model involved. When it cannot, the assistant is given everything
the tool saw during the recording and a small set of ways to look further,
and it writes a short program for that one session. The tool then runs that
program with the value you typed during the recording and checks the result
against what you marked. Only a program that passes is kept, and from then
on it is what runs for that session. The assistant never changes the tool
itself, never runs anything unchecked, and never sees or sends credentials.

What the assistant can do:

- Read the whole recording, every captured body in full.
- Send its own requests and see the full response: an API on another host,
  the JSON form of a JSONP call, a public API it knows for the site, a
  body the recorder cut.
- Open a page in a hidden browser, type and click on it, and read what
  appears, including results that only exist as rendered HTML.
- Use the anonymous bearer a site mints for every visitor (the Sijilat
  shape), read from the site's own web storage, to call a token-gated API.
- Write a script for that one session, retry when the check rejects it,
  and refine a saved automation the operator has flagged.
- Narrow a working automation to the fields the operator wants without
  rewriting it.

What it cannot do:

- Change the tool. It writes a program for one session; the recorder, the
  analyser, the runner and its own rules stay as they are.
- Save anything unchecked. A script is kept only after the tool has run it
  with the recorded input and found the marked text in the rows.
- Log in, pass a CAPTCHA, or send a cookie. Credentials are never recorded,
  and a cookie or authorisation header in a script is dropped. The one
  exception is the anonymous token the site itself issued to the browser.
- Reach beyond the hosts it proved. The saved script is confined to the
  hosts it contacted during the check.
- Touch the machine: no files, no environment, no modules, no other
  programs.
- See traffic the recorder never saw (WebSockets, cross-origin iframes).
- Work from a recording with nothing typed and nothing marked.
- Run without limit. Turns, tool calls, script attempts and tokens are
  capped, and the spend is reported.
- Future-proof anything. If the site changes, the script fails honestly
  and Fix with LLM is one click away.

The division of labour is strict. The model investigates and writes;
deterministic code decides.

The model receives the whole recording (every event, with every captured
body reachable in full) plus the analyser's verdict, and these tools:

- **read_body** reads any captured request or response body, page by page.
- **probe** sends one HTTP request and returns the whole response: an API
  the page called on another host, the JSON form of a JSONP call, a public
  API it knows for the site, a body the recorder cut.
- **open_page** loads a URL in a headless browser, optionally fills, clicks
  and waits, and returns the page's text, an element's HTML, or the result
  of a JavaScript expression evaluated in the page.
- **write_script** submits a script for this session.
- **set_columns**, in refine mode on a deterministic automation, keeps the
  automation exactly as it is (token step, pagination, everything) and
  changes only which fields each row returns. Verified by running the saved
  automation with the recorded input.

The script is a small plain-JavaScript program, `async function run(ctx)`,
that receives the run's parameters and returns rows. It runs in an isolated
context with three capabilities: send HTTP requests, drive a browser page,
and read the anonymous bearer a site mints for every visitor (the same
token step the deterministic pipeline uses), which is the only credential
it may send. No files, no environment, no modules. It is
saved as `automation.mjs` in the session's folder, shown in full on the
session page, and from then on every run of that session executes it: the
Run, Bulk and export panels work unchanged.

Acceptance is deterministic and applied to every submission:

1. Lint: the script reads every parameter from `ctx.inputs`, carries none of
   the recorded values as a literal, and imports nothing.
2. It is executed with the recorded inputs and must return rows within 90
   seconds.
3. If the operator marked text, each marked selection must appear as a
   field value in some row (letters and digits compared, so reference
   markers such as `[4]` and punctuation cannot defeat a match). A partial
   match is fed back with the missing selections named; if nothing better
   turns up, the best verified attempt is kept and the console says which
   marks it lacks.
4. If nothing was marked, some row must carry the typed value or the text
   of a result the operator clicked.

The hosts the accepted script contacted are recorded in the spec, and every
later run is confined to them: a script that reaches elsewhere is stopped
with that reason. Nothing unverified is ever saved, and a repaired session
says so on its page. When no automation is possible, the assistant gives up
with concrete advice on how to re-record. A recording with nothing typed and
nothing marked is refused before any model call, because there is nothing to
parameterise and nothing to verify against.

The same loop refines a saved automation. After any run, the session page
offers **Fix with LLM** with an optional note. The assistant receives the
current automation (the script itself, when there is one), what the last run
returned and the note; without a note it compares the marked selections with
the result itself. A verified replacement is saved over the old one and the
provenance line on the page says it was refined, quoting the note. A failed
attempt leaves the saved automation untouched.

Budget rails, enforced in code: at most 16 model turns, 20 tool calls and 6
script attempts per repair, plus a token ceiling; a call repeated with the
same arguments is refused from its third occurrence; the console reports
the estimated spend at the end. The default model is `claude-sonnet-5`;
`REPAIR_MODEL` in `.env` selects another. To enable the assistant, put
`ANTHROPIC_API_KEY=...` in a `.env` file at the project root (gitignored)
and restart the backend; without a key the button explains what is missing.
Using it sends the sanitised recording to the Anthropic API, the only part
of the tool that leaves the machine.

## Safeguards

- Cookies, auth headers and password values are never stored. Redaction is
  two-layer (extension, then backend) and asserted by the e2e suite. Every
  fetch/XHR the page makes is captured, whatever the host; third-party
  bodies stay on the machine like everything else.
- Session scripts run in an isolated context with three capabilities (HTTP,
  a browser page, and the anonymous bearer the site itself issues, the only
  credential they can send), are confined to the hosts they were verified
  against, and are shown in full on the session page. This is
  isolation against accidents, not a hardened sandbox: the code comes from
  the assistant under the tool's instructions and is saved only after it
  reproduced the recording.
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
npm run test:repair        # LLM repair loop against a scripted mock model: probes, browser, session scripts, rails, budget
npm run typecheck
```
