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
values with the page's own label for the field, clicks with the clicked
element's markup, select choices with the option's visible text, forms as
submitted (method, action and named fields, so a classic POST form is not
lost to the network tap), navigations, text the operator highlights, and
every fetch/XHR request the page makes with its request and response
bodies and headers, whatever host it goes to. A field that fires no change
event, a contenteditable box or a custom combobox, is read once typing
pauses. It also keeps snapshots of the pages the operator looked at: the
visible text, a pruned copy of the DOM (no scripts, styles, handlers or
media) and the names of the page's web storage keys, taken when a page
settles, after an action or a response changed it, and when recording
stops. For a site that renders its results into the page, the snapshot is
the only record of the outcome. Bodies are kept up to 2 MB and snapshots
up to 600 KB of HTML, 40 of them a session; a longer one is cut and the
cut is declared. Page loads, pages left and the final state are never
dropped, and what the cap dropped is counted on the session page and in
the brief. Cookies, auth headers, password values and hidden form values
are stripped in the extension and again in the backend. Events stream to a
local Fastify backend as they happen.

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
server-rendered pages, and `script` for a program a model wrote for one
session. A page number in the request body or the query string, paired
with a total in the response, turns on fetch-all pagination. Marked values
become named columns. Specs carry a version and regenerate when the
generator changes. Before saving, the recorded response is checked against
all marked selections, or visible snapshot text and clicked results. A
query echoed by a response is not enough. A mismatch refuses the spec;
recordings without enough evidence, empty searches and browser extraction
are labelled unverified. This checks recorded evidence, not a live replay.

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
   the generated steps. If the direct call fails the evidence check, the
   page explains why and opens Maximum Effort Mode instead of offering Run.
   Green means the rows match recorded evidence; amber means unverified.
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
- Custom request headers the page set (an app id, a vendor `accept`).
  They are replayed, and the auth probe sends them too, so a 403 caused by
  a missing header is never mistaken for a missing bearer. Suite only.
- Typed values the page never reports. A contenteditable box and a custom
  combobox fire no change event, so the value is read once typing pauses
  and deduped against the event an ordinary input does fire. Suite only.
- Forms submitted from script and controls inside an open shadow root.
  `form.submit()` fires no submit event, so the form is described from its
  fields; a shadow control retargets its events to its host, so the
  composed path names the control itself. Suite only.
- Values chosen from a suggestion list. The list fills the box without an
  input event, so what the operator typed is only the first few keystrokes:
  the whole value is read from the navigation that followed. Keystroke
  prefixes and values typed and then abandoned are ignored, and a value has
  to be a whole query parameter or path segment of a URL to count as that
  URL's parameter. Suite only.
- Forms with several fields: one parameter each. Each parameter is named
  after the field's id, or, when that id is generated ("s0-2-46-…"), after
  the page's own label for the field ("Minimum Value in $" →
  `minimum_value`).
- Two-step lookups, search then detail, re-resolved per input. Live:
  wwe.com.
- Server-rendered detail pages read by a browser step. Live: wwe.com bios.
- Paged APIs, page number in the body or the URL, all pages fetched.
- A search that returned nothing during recording still yields a working
  automation.

## What it does not handle

Two layers. The deterministic pipeline needs the typed value to appear
unchanged in a request and the outcome to come back as structured data
supported by the recording's evidence when that evidence is available.
When it refuses, or when the workflow is more than one search (filters,
sorts, several pages), Maximum Effort Mode hands the whole recording to a
model that works it out and writes a script for the session. Each line
below says which layer it lands on and how the recovery was checked.

The pipeline refuses; the assistant can recover:

- JSONP and script-tag traffic. A script tag is neither fetch nor XHR, so
  only its URL is recorded; the brief fetches the ones that carried a typed
  value, so the model sees the JSONP shape and drops `callback=`. Live:
  Wikipedia portal.
- Responses over 2 MB. Cut and declared; the assistant fetches them in
  full. Live: Nominatim.
- Server-rendered result lists. The brief says whether a plain fetch of
  each visited page still carries the results the operator saw, so the
  script parses that HTML with `ctx.dom` and opens a browser page only
  where nothing else reaches the data. Live: UK Companies House.
- A site that walls a plain fetch and a cold deep link but serves its own
  search form. The script opens the home page, searches from the form and
  applies the filters and the sort to the results URL in the same browser
  context. Live: eBay, newly listed items above a minimum price, 60 rows
  headless.
- Nothing typed but something marked. The assistant derives a
  zero-parameter automation from the marks. Suite only.
- Values transformed before sending (a date as an epoch, a choice as an
  id). A script could apply the transformation. Not yet exercised.

Neither layer:

- WebSockets, and anything inside an iframe. A socket's messages pass
  neither the fetch nor the XHR tap. The recorder runs in the top frame by
  decision, so typed values, clicks, marks and snapshots come from it alone
  and a frame's own fetch or XHR is captured nowhere, though its document
  load still shows up as metadata; a cross-origin frame could not be read
  in any case, and same-origin result frames are rare on public search
  pages.
- A CSS selector for a control inside a shadow root. The recorder names the
  control itself, its tag, id and text, but the selector stops at the
  shadow boundary, so a browser step cannot address it and a closed root
  shows only its host; text highlighted inside one cannot be marked at all,
  because Chromium's selection API does not report it. The suite records
  such a search and replays it through the request the control fired, which
  needs no selector.
- The exact body a navigating form sent. A classic POST reaches neither the
  network tap nor `webRequest`'s body, so the recorder rebuilds it from the
  form's own fields and names a hidden field without its value: a token or
  a nonce appears as a requirement, never as data. The suite records such a
  submit with its method, action and fields, and the deterministic pipeline
  still refuses a form-driven session; the reconstruction is there for the
  model to work from.
- Per-request signing, nonces, CSRF tokens. No direct call can be
  generated. A browser-driven script might work; not exercised. Sijilat's
  reusable anonymous token is not signing and is handled.
- Logins, CAPTCHAs, bot walls. Out of scope by design. Cookies and auth
  headers are never kept and scripts cannot send them. A Cloudflare
  challenge did not record usefully (iNaturalist).
- PDF, CSV downloads and images as outcomes.
- Results opening in a new tab. Only the active tab is recorded.
- More than one hop in the deterministic chain. A script may chain further.

Why the line is where it is: an automation is handed over only when the
evidence is complete, the runner can do what is needed, and the result can
be checked without causing harm. A lookup is checked for free by re-running
it with the recorded value and comparing rows with the marks. A form that
books or submits could only be checked by submitting again, so such
workflows are not attempted. The assistant could write them; it could not
prove them, and nothing unproven is saved.

## Maximum Effort Mode

The deterministic pipeline is the fast lane: one search, one call, done.
Everything else goes through Maximum Effort Mode, on the session page. It
uses a model you already pay for, not an API key, in three steps.

State the goal in a sentence: what the automation should return ("the top
5 listings on the final page, with title, price and a link to each").

Export the brief. One Markdown file carries the goal; the script contract
and the acceptance rules the answer will be held to; the answer format; and
the sanitised recording, in order of worth: the route with the query
parameters that changed at each step (a sort, a filter, a price bound shows
up here by name), every typed value with the page's own label and a
suggested parameter name, marks and clicked results (a table header row
marked by mistake is listed as ignored, and the acceptance does not ask for
it), the analyser's verdict flagged as a guess, the automation the session
already has, and what a plain fetch gets today: each visited page with its
status and size and whether the visible results are in the plain response,
a bot wall or a redirect to a login page named for what it is, the site's
robots.txt rule where one applies, and each call that carried a typed value
replayed without credentials, so the brief says plainly whether the outcome
call is gated and how to obtain the site's anonymous bearer if it is.

Then the bodies: the recording in order, the last page's text and pruned
DOM, the pages before it, anything the page pulled in through a script tag
(fetched at export, since the recorder only saw the URL, and usually JSONP),
and the captured calls in full with their request and response headers,
those carrying a typed value or structured records first. The last page as a
plain fetch returns it sits with the snapshots when that page is where the
results are, and after the calls when they are not. "Full" is capped at
4 MB, for an agent that reads files; "Chat-sized" at 600 KB, for a chat
window, where no single item may take more than a quarter of the budget and
the session folder is named relative to the repository rather than from a
home directory; `?budget=` on the API takes any size. What the budget cut is
listed at the end, never dropped silently. The file is also written as
`BRIEF.md` in the session folder. Snapshots show whatever was on the screen.

Paste the answer back. The model answers with one JSON block: title,
summary, parameters with the recorded values as examples, any typed value
it chose to fix, and the script as one string. The tool reads that block out
of the whole reply (the last block carrying a script, when the model showed
the shape first; a bare script is accepted too, with the typed values as its
parameters) and verifies it exactly as the API loop verified its own
attempts. A pass becomes the session's automation, with "external model"
as its provenance, and the Run card takes over. A fail shows the exact
rejection text, ready to paste back to the model: a bad block is named by
its position in the reply and the position of the error in it. Both
outcomes are kept in the session's history.

With Claude Code or another agent working in this repository: open the
session folder (`backend/data/<session>/`), read `BRIEF.md`, write
`automation.candidate.mjs` and a `candidate.json` (`{title, summary,
parameters, fixed}`) beside it, and run

```bash
npm run verify -- <session>
```

until it prints PASS, then `npm run verify -- <session> --save`. The same
command takes a whole reply file or a JSON block as its second argument.
Exit codes: 0 PASS, 1 REJECTED, 2 usage.

From any other tool, both steps are one curl each: `curl -s
'http://127.0.0.1:4823/api/sessions/<session>/brief?budget=600000' -o
brief.md` exports it, and `curl --data-binary @answer.md -H 'content-type:
text/plain' http://127.0.0.1:4823/api/sessions/<session>/import` verifies
the reply, answering 200 with what was saved or 422 with the rejection.

The script is plain JavaScript, `async function run(ctx)`, taking the
parameters the model declares (named as a person would: `query`,
`min_price`) and returning rows. It runs in an isolated context with four
capabilities: HTTP requests, a DOM over HTML it already fetched (so a
server-rendered listing is parsed with selectors, no browser), a live
browser page, and the anonymous bearer a site issues to every visitor. That
bearer is the only credential it can send. No files, no environment, no
modules. It is saved as `automation.mjs` in the session folder, shown in
full on the session page, and runs for every later run of that session.

Acceptance is deterministic and the same on every path (`backend/src/candidate.ts`
serves the import route, the CLI and the API loop alike). The script must
read every declared parameter from `ctx.inputs`, carry no typed value as a
literal unless it declares that value fixed and says why, and import
nothing. It is executed with the recorded values and must return rows
within 120 seconds. If text was marked, every mark must appear as a field
value in some row. Otherwise at least one row must carry text that appears
in a page snapshot the operator saw, or the typed value, or a result they
clicked. A script whose rows the operator never saw is rejected with that
reason. The hosts the accepted script contacted are saved and every later
run is confined to them.

robots.txt is read, never enforced. On the acceptance run the tool fetches
each contacted host's robots.txt and, where a URL the script reached is
disallowed for all agents, says so in the automation's notes and on the
saved spec. Whether to run it is the operator's call.

The API loop is still in the code (`backend/src/effort.ts`, routes
`/effort`, `/effort/say`, `/effort/stop`) and covered by its suite, but
nothing on the page calls it: at frontier prices a single run cost dollars,
and the brief gives the same model the same evidence for nothing. The older
assistant, Adjust (`backend/src/repair.ts`, route `/repair`), is out of
the page for the same reason: a small change to an automation ("only the
name and the city") is a new goal on the brief. Its code and its suite
remain. Nothing in the app needs an API key.

## Safeguards

- Cookies, auth headers and password values are never stored. Redaction is
  two-layer and asserted by the e2e suite.
- A session script sees JavaScript's own intrinsics and the four capabilities
  it is given. Both ctx and everything it returns are built inside the
  script's own context, over a bridge that carries only strings, so no object
  of this process is reachable from it. A lint refuses the shapes a script has
  no honest use for, and it runs in a worker thread the runner terminates on
  the deadline, so one that loops forever is cut rather than taking the
  backend with it. That is containment, not a boundary against a determined
  hostile author: the worker shares this process, and an escape from Node's vm
  would reach it. Which is why the script is shown in full, saved only after
  it reproduced the recording, and comes from a model the operator chose.
- Every run is started by a person. Stopping a recording sends one
  request on its own: the recorded outcome call, replayed with the page's
  own headers but without credentials, so the generator learns whether a
  token step is needed. Exporting a brief fetches each visited page once,
  replays the calls that carried a typed value without credentials, fetches
  any script-tag URL that carried one, and reads each host's robots.txt,
  all without cookies (`probe=0` skips it); accepting a script fetches
  robots.txt for the hosts it reached. Test suites use local fixtures only.
- The one authenticated call in the Sijilat demonstration uses the
  anonymous token the site issues to every visitor. The runner reads it; it
  never derives or submits a credential.

## Layout and tests

```
extension/   MV3 recorder (popup, content script, MAIN-world network tap)
backend/     Fastify: event store, redaction, analysis, spec generation, UI, model loops
runner/      Spec execution: requests, token discovery, page extraction, session scripts
fixtures/    Mock sites, a banked Sijilat trace and specs
e2e/         Test suites
docs/        Spec format, site evidence, UI rules
```

```bash
npm run e2e                # record to replay in real Chromium (stop the backend first)
npm run test:failures      # every named stop, the script sandbox, robots.txt and .env
npm run test:enhancements  # pagination in body and URL, bulk, chains, marks, snapshot cap
npm run test:matrix        # eleven site shapes recorded end to end in real Chromium
npm run test:repair        # repair loop (dormant) against a scripted mock model
npm run test:effort        # Maximum Effort Mode, the brief and its budget, verdicts and refusals
npm run typecheck
```
