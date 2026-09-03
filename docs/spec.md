# Automation spec format

A spec is the Generate stage's output and the Execute stage's input. It is the "best way to automate the outcome", not a replay of clicks. JSON, versioned, human-readable.

```jsonc
{
  "version": 6,
  "name": "sijilat-cr-search",
  "origin": "https://www.sijilat.bh",
  "language": "EN",                     // recorded UI language; the runner sets it explicitly
  "parameters": [
    // One per distinct typed value found in the outcome call.
    { "name": "query", "example": "bank", "required": true }
  ],
  "steps": [
    {
      "id": "token",
      "type": "browser-token",          // a browser step, used only where a request cannot reach
      "loadUrl": "https://www.sijilat.bh/public-search-cr/search-cr-2.aspx",
      "reason": "endpoint returns 401 without a bearer; the site issues one client-side, read back from its web storage"
      // The token itself is discovered at run time: any JWT-looking storage
      // value or token-named field in a stored JSON blob; the run reports
      // where it came from. Nothing site-shaped is recorded.
    },
    {
      "id": "search",
      "type": "request",                // one direct HTTP call
      "method": "POST",
      "url": "https://api.sijilat.bh/api/CRdetails/AdvanceSearchCR_Paging",
      "headers": { "content-type": "application/json; charset=utf-8", "accept": "*/*" },
                                        // the headers the page itself set on the recorded call (an app id,
                                        // a vendor accept), lowercased; credential-shaped and browser-managed
                                        // names are never recorded, so never here
      "bearerFrom": "token",            // inject Authorization from the token step
      "bodyTemplate": { /* recorded request body with correlated values replaced by {{query}} */ }
    },
    {
      "id": "extract",                  // server-rendered outcomes only
      "type": "browser-extract",        // browser step: load the linked page, read marked elements
      "url": "https://www.example.com/superstars/{{link}}",
      "reason": "the marked data is rendered into the page rather than returned by an API",
      "link": { "fromStep": "search", "rowsPath": "items", "path": "url", "pick": "best-match", "encoded": false },
      "extracts": [
        { "name": "h3", "selector": "div.bio > h3" }   // from the operator's marked selections
      ]
    },
    {
      "id": "automation",               // a session script, written by a model loop (Adjust or Maximum Effort Mode)
      "type": "script",                 // runner/src/script.ts executes it in an isolated context
      "file": "automation.mjs",         // in the session folder; defines async function run(ctx) → rows
      "reason": "the results are rendered server-side; the script drives the page and reads the list",
      "hosts": ["www.example.com"],     // hosts it was verified against; later runs are confined to them
      "robots": ["robots.txt on www.example.com disallows /search for all agents; ..."]
      // present when robots.txt disallowed a URL the script reached on
      // acceptance: reported to the operator, never enforced.
      // A script spec's outcome is { "extract": { "records": "rows" } }: the
      // rows the script returns are the result set, no columns projected.
    },
    {
      "id": "detail",                   // present only for chained workflows
      "type": "request",
      "method": "GET",
      "url": "https://api.example.com/company/{{link}}",
      "headers": { "accept": "*/*" },
      "link": {
        "fromStep": "search",           // the response that feeds this step
        "rowsPath": "RECORDS",          // record set the link value lives in (omitted when top-level)
        "path": "CR_NO",                // row-relative path of the link value
        "pick": "best-match",           // which row a new input follows: best parameter match, else first
        "encoded": false                // whether the URL carried it percent-encoded
      }
    }
  ],
  "outcome": {
    "fromStep": "search",               // "detail" when chained
    "expect": { "path": "Status_Code", "equals": "200" },   // hard gate; mismatch stops the run
    "extract": { "total": "jsonData.Total_Records", "records": "jsonData.CR_list" },
    "columns": [                        // present when the operator marked text while recording
      { "name": "NAME_EN", "path": "NAME_EN", "scope": "row" }
      // scope "row" resolves against each record; "body" against the whole response
    ],
    "pagination": { "pagePath": "PaginationParams.Page" }   // page-based outcomes: runner fetches all pages
  }
}
```

## Rules

- **Direct requests first.** A step is `type: "request"` unless the outcome genuinely cannot be reached without a browser. Browser steps (`browser-token`, later `browser-action`) carry a `reason`.
- **Headers are the page's own.** A request step sends the headers the page's code set on the recorded call, minus anything credential-shaped (`cookie`, `authorization`, `x-api-key`) or browser-managed (`origin`, `referer`, `user-agent`). `accept` defaults to `*/*` and `content-type` to the body's shape only when the page set neither. The auth probe sends the same set, so the probe classifies exactly the request the spec will make.
- **Parameters are correlated, not guessed.** A parameter exists because the Analyse stage found the operator's typed value inside the outcome request (body or URL); one parameter per distinct value.
- **Chains are correlated too.** A `link` step exists because a value from the previous step's response appeared in the later request's URL, with positive evidence (a marked value in the later response, or a recorded click leading to it). The runner re-resolves the link from the fresh response on every run.
- **Columns come from marks.** The operator's highlighted text is located in the outcome response at generate time; the spec stores paths, so a new input yields the same fields for its own data. Matching compares letters and digits only (reference markers, pronunciation glyphs and punctuation are ignored), accepts any shared 80-character stretch of a long selection, prefers an exact field over a containing one, and a field inside the record set over one elsewhere.
- **Record sets may be keyed.** `extract.records` resolves to an array, or to a map of records keyed by id (MediaWiki `pages`), or to one bare record; a path the response lacks yields zero rows, never the whole response as one row.
- **Model-built specs carry provenance.** A spec written by a model loop has `repaired: { at, model, diagnosis, mode, feedback?, summary? }`; `mode` is `repair` (the analyser had refused), `refine` (a run was flagged, `feedback` holding the operator's note) `effort` (Maximum Effort Mode's API loop, `feedback` holding the operator's goal and `summary` the model's account of what the automation returns and which recorded choices are baked in) or `import` (the same shape written by an external model from the exported brief and verified on import; `model` is `external`). Such specs are never regenerated.
- **The outcome is validated, never assumed.** `outcome.expect` is a deterministic check on the final response. The runner stops with a named reason when it fails.
- **Language is explicit.** The recorded UI language is pinned into the spec so a replay does not inherit the runner's default.
- Templating is `{{name}}` substitution over the JSON body and URL, matched by value at generate time so it survives nested fields.
- **Composite strings splice.** A value found *inside* a larger string field (a query string bundled into one JSON value, Algolia-style) is matched as a bounded token and spliced in place: `"params": "query={{enc:query}}&page=0"`. `{{enc:name}}` substitutes percent-encoded, `{{plus:name}}` fully form-encoded (spaces as `+`, everything else percent-escaped), bare `{{name}}` raw — whichever encoding the recording itself used. Form-encoded request bodies (`name=x&lang=en`) keep their raw string shape with placeholders spliced in and replay with the `application/x-www-form-urlencoded` content type. Embedded matching runs only when no exact field or URL match carried the value, and token boundaries are enforced ("art" never matches inside "smart").
