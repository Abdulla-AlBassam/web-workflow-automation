# Web workflow automation

Record a web workflow once in your own browser and get back an automation
that reproduces the outcome for any new input.

The recording is evidence, not the automation. Browser-robot tools (Browse
AI, Octoparse, Axiom) replay clicks. This tool works out which request the
page made to fetch its result and calls that request directly, so a run is
one HTTP call returning the server's own JSON. A browser is used only for
what a plain request cannot reach.

Demonstrated on the public Sijilat commercial-registry lookup. Also run
against wwe.com and the Swiss company register (zefix.ch) deterministically;
Wikipedia both ways (deterministic from the site's search box, through the
LLM assistant from the JSONP portal); Nominatim, Hacker News search and the
UK Companies House register through the assistant, each fixed in a few
turns. Nothing in the pipeline names any site. An example Sijilat session export and its generated spec
are in `fixtures/`.

## How it works

Record, analyse, generate, execute.

Record (`extension/`, `backend/`). An MV3 Chrome extension captures typed
values, clicks, navigations, text the operator highlights, and every
fetch/XHR request the page makes with its request and response bodies,
whatever host it goes to. Bodies are kept up to 2 MB; a longer one is cut
and the cut is declared. Cookies, `Authorization` headers and password
values are stripped in the extension and again in the backend. Events
stream to a local Fastify backend as they happen.

Analyse (`backend/src/analyse.ts`). Deterministic, no model. Each typed
value is searched for in every request: JSON and form bodies, URLs in raw,
percent and plus encodings, and inside composite string fields. The request
that carried a value, succeeded and returned records is the outcome. A value
from that response found in a later request's URL, backed by a mark or a
click, makes a chain. Marked text that no response carries, on a page the
response links to, makes a page chain.

Generate (`backend/src/generate.ts`). The analysis becomes a JSON spec
(format in `docs/spec.md`): one parameter per typed value and the fewest
steps that reproduce the outcome. Step types: `request` (the default),
`browser-token` (added only when the unauthenticated probe fails; at run
time it loads the site and finds the anonymous bearer in web storage by
shape), a chained `request` with a `link`, `browser-extract` for
server-rendered pages, and `script` for a program the LLM assistant wrote
for one session. A page field paired with a total in the response turns on
fetch-all pagination. Marked values become named columns. Specs carry a
version and regenerate when the generator changes.

Execute (`runner/`). The runner takes a spec and new inputs, runs the steps,
checks the outcome against what the recording promised, and stops with a
named reason on a mismatch: no token found, endpoint changed, selector gone,
a chain with nothing to follow. A plain search with no results is a
successful run with zero rows.

## Using it

```bash
npm install
npx playwright install chromium
npm run build:ext        # builds extension/dist
npm run backend          # http://127.0.0.1:4823
```

Load `extension/dist` as an unpacked extension at `chrome://extensions`
with developer mode on.

1. Open the target page, click the extension icon, check the site name (it
   labels the session; capture is not limited to it), then Start.
2. Do the workflow once. To choose output fields, highlight the data you
   want and click the Mark data chip. In a results table, drag across the
   cells of one row; those become the columns, in that order. A header row
   is ignored. On a page of text, drag across the whole block.
3. Stop. The session page opens with the timeline, the outcome call and
   the generated steps.
4. Enter a new value under Run the automation. Results render as a table
   with CSV and JSON download.
5. Bulk run takes one value per line, runs them one at a time with a delay,
   capped at 50, and aggregates the rows.

Headless replay:

```bash
npm run run -- fixtures/sijilat-cr-search.spec.json cr_name_en=pharmacy
```

## What it handles

Every shape below is covered by the test suites. "Live" means also verified
on the real site.

- Value in a JSON or form-encoded request body. Live: Sijilat.
- Value in a URL, any common encoding. Live: wwe.com, 11,410 results
  replayed.
- Value inside a composite string field (Algolia-style `params`).
- Anonymous token required by the API. Live: Sijilat.
- Forms with several fields: one parameter each.
- Two-step lookups, search then detail, re-resolved per input. Live:
  wwe.com.
- Server-rendered detail pages read by a browser step. Live: wwe.com bios.
- Paged APIs, all pages fetched.
- A search that returned nothing during recording still yields a working
  automation.

## What it does not handle

Two layers. The deterministic pipeline needs the typed value to appear
unchanged in a request and the outcome to come back as structured data.
When it refuses, the LLM assistant can investigate and write a script for
the session. Each line below says which layer it lands on and how the
recovery was checked.

The pipeline refuses; the assistant can recover:

- JSONP and script-tag traffic. Only the URL is recorded; the assistant
  probes the plain-JSON form. Live: Wikipedia portal.
- Responses over 2 MB. Cut and declared; the assistant fetches them in
  full. Live: Nominatim.
- Server-rendered result lists. The assistant drives a browser page and
  reads the list, or finds the JSON the page can be asked for. Live: UK
  Companies House.
- Nothing typed but something marked. The assistant derives a
  zero-parameter automation from the marks. Suite only.
- Values transformed before sending (a date as an epoch, a choice as an
  id). A script could apply the transformation. Not yet exercised.

Neither layer:

- WebSockets and cross-origin iframes. Not captured.
- Per-request signing, nonces, CSRF tokens. No direct call can be
  generated. A browser-driven script might work; not exercised. Sijilat's
  reusable anonymous token is not signing and is handled.
- Logins, CAPTCHAs, bot walls. Out of scope by design. Cookies and auth
  headers are never kept and scripts cannot send them. A Cloudflare
  challenge did not record usefully (iNaturalist).
- PDF, CSV downloads and images as outcomes.
- Results opening in a new tab. Only the active tab is recorded.
- URL-borne pagination (`?page=2`). Only a page field in the body is
  detected.
- More than one hop in the deterministic chain. A script may chain further.

Why the line is where it is: an automation is handed over only when the
evidence is complete, the runner can do what is needed, and the result can
be checked without causing harm. A lookup is checked for free by re-running
it with the recorded value and comparing rows with the marks. A form that
books or submits could only be checked by submitting again, so such
workflows are not attempted. The assistant could write them; it could not
prove them, and nothing unproven is saved.

## The LLM repair assistant

When the deterministic analysis refuses, or a saved automation returns the
wrong thing, the session page offers a button. Nothing runs without it. A
console shows what the model checks, each tool it uses, each script it
submits and the verdict.

The model gets the whole recording, every body readable in full, plus the
analyser's verdict, and five tools: read a captured body page by page;
probe an endpoint and see the whole response (an API on another host, the
JSON form of a JSONP call, a public API it knows, a body the recorder cut);
open a page in a headless browser, fill, click, and read text, HTML or the
result of an expression evaluated in the page; write a script; and, when
refining a deterministic automation, set columns, which keeps the automation
as it is and changes only the fields returned.

The script is plain JavaScript, `async function run(ctx)`, taking the run's
parameters and returning rows. It runs in an isolated context with three
capabilities: HTTP requests, a browser page, and the anonymous bearer a site
issues to every visitor, read from the site's web storage. That bearer is
the only credential it can send; any other authorisation header is dropped.
No files, no environment, no modules. It is saved as `automation.mjs` in the
session folder, shown in full on the session page, and runs for every later
run of that session.

Acceptance is deterministic. The script must read every parameter from
`ctx.inputs`, carry none of the recorded values as a literal, and import
nothing. It is executed with the recorded inputs and must return rows within
90 seconds. If text was marked, each mark must appear as a field value in
some row; a partial match is fed back with the missing marks named, and the
best verified attempt is kept if nothing better arrives. If nothing was
marked, some row must carry the typed value or the text of a result the
operator clicked. The hosts the script contacted are saved and every later
run is confined to them. A recording with nothing typed and nothing marked
is refused before any model call.

Refine works the same way. After a run, Fix with LLM takes an optional note;
the assistant sees the current automation, the last run and the note, and a
verified replacement overwrites the old one with its provenance shown on the
page.

Rails: 16 model turns, 20 tool calls, 6 script attempts, a token ceiling,
and a repeated identical call refused from its third occurrence. A Stop
button ends the loop at once; a partly verified attempt is kept, nothing
else is saved. The console reports the estimated spend. Default model `claude-sonnet-5`; `REPAIR_MODEL`
overrides it. Put `ANTHROPIC_API_KEY=...` in a `.env` file at the project
root and restart the backend. This is the only part of the tool that sends
anything off the machine, and it sends the sanitised recording.

The assistant cannot change the tool, save anything unchecked, log in, pass
a CAPTCHA, send a cookie, reach beyond its verified hosts, touch the
filesystem, see traffic the recorder never saw, or run without limit. If a
site changes, the script fails with a reason and the button is there again.

## Safeguards

- Cookies, auth headers and password values are never stored. Redaction is
  two-layer and asserted by the e2e suite.
- Session scripts are isolated against accidents, not hardened against a
  hostile author: the code comes from the assistant under the tool's
  instructions, is shown in full, and is saved only after it reproduced the
  recording.
- Every run is started by a person. Stopping a recording sends one
  request on its own: the recorded outcome call, replayed without
  credentials, so the generator learns whether a token step is needed.
  Test suites use local fixtures only.
- The one authenticated call in the Sijilat demonstration uses the
  anonymous token the site issues to every visitor. The runner reads it; it
  never derives or submits a credential.

## Layout and tests

```
extension/   MV3 recorder (popup, content script, MAIN-world network tap)
backend/     Fastify: event store, redaction, analysis, spec generation, UI, repair loop
runner/      Spec execution: requests, token discovery, page extraction, session scripts
fixtures/    Mock sites, a banked Sijilat trace and specs
e2e/         Test suites
docs/        Spec format, site evidence, UI rules
```

```bash
npm run e2e                # record to replay in real Chromium (stop the backend first)
npm run test:failures      # every named stop
npm run test:enhancements  # pagination, bulk, URL specs, chains, marks
npm run test:matrix        # seven site shapes recorded end to end in real Chromium
npm run test:repair        # repair loop against a scripted mock model
npm run typecheck
```
