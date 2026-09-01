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
- **Parameters are correlated, not guessed.** A parameter exists because the Analyse stage found the operator's typed value inside the outcome request (body or URL); one parameter per distinct value.
- **Chains are correlated too.** A `link` step exists because a value from the previous step's response appeared in the later request's URL, with positive evidence (a marked value in the later response, or a recorded click leading to it). The runner re-resolves the link from the fresh response on every run.
- **Columns come from marks.** The operator's highlighted text is located in the outcome response at generate time; the spec stores paths, so a new input yields the same fields for its own data.
- **The outcome is validated, never assumed.** `outcome.expect` is a deterministic check on the final response. The runner stops with a named reason when it fails.
- **Language is explicit.** The recorded UI language is pinned into the spec so a replay does not inherit the runner's default.
- Templating is `{{name}}` substitution over the JSON body and URL, matched by value at generate time so it survives nested fields.
- **Composite strings splice.** A value found *inside* a larger string field (a query string bundled into one JSON value, Algolia-style) is matched as a bounded token and spliced in place: `"params": "query={{enc:query}}&page=0"`. `{{enc:name}}` substitutes percent-encoded, `{{plus:name}}` plus-encoded, bare `{{name}}` raw — whichever encoding the recording itself used. Embedded matching runs only when no exact field or URL match carried the value, and token boundaries are enforced ("art" never matches inside "smart").
