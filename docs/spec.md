# Automation spec format

A spec is the Generate stage's output and the Execute stage's input. It is the "best way to automate the outcome", not a replay of clicks. JSON, versioned, human-readable.

```jsonc
{
  "version": 1,
  "name": "sijilat-cr-search",
  "origin": "https://www.sijilat.bh",
  "language": "EN",                     // recorded UI language; the runner sets it explicitly
  "parameters": [
    { "name": "query", "example": "bank", "required": true }
  ],
  "steps": [
    {
      "id": "token",
      "type": "browser-token",          // a browser step, used only where a request cannot reach
      "loadUrl": "https://www.sijilat.bh/public-search-cr/search-cr-2.aspx",
      "readToken": "localStorage.accessToken",   // JSON blob the site mints for anonymous users
      "bearerPath": "access_token",              // field inside that blob
      "reason": "endpoint returns 401 without a bearer; the site issues an anonymous token client-side"
    },
    {
      "id": "search",
      "type": "request",                // the outcome step: one direct HTTP call
      "method": "POST",
      "url": "https://api.sijilat.bh/api/CRdetails/AdvanceSearchCR_Paging",
      "headers": { "content-type": "application/json; charset=utf-8", "accept": "*/*" },
      "bearerFrom": "token",            // inject Authorization from the token step
      "bodyTemplate": { /* recorded request body with the correlated value replaced by {{query}} */ }
    }
  ],
  "outcome": {
    "fromStep": "search",
    "expect": { "path": "Status_Code", "equals": "200" },   // hard gate; mismatch stops the run
    "extract": { "total": "jsonData.Total_Records", "records": "jsonData.CR_list" }
  }
}
```

## Rules

- **Direct requests first.** A step is `type: "request"` unless the outcome genuinely cannot be reached without a browser. Browser steps (`browser-token`, later `browser-action`) carry a `reason`.
- **Parameters are correlated, not guessed.** A parameter exists because the Analyse stage found the operator's typed value inside a request body. `bodyTemplate` holds that body with the value swapped for `{{name}}`.
- **The outcome is validated, never assumed.** `outcome.expect` is a deterministic check on the final response. The runner stops with a named reason when it fails.
- **Language is explicit.** The recorded UI language is pinned into the spec so a replay does not inherit the runner's default.
- Templating is `{{name}}` substitution over the JSON body, matched by value at generate time so it survives nested fields.
