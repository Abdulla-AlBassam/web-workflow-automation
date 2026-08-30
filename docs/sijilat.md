# Sijilat — live-site evidence

Captured by direct inspection on 2026-08-29. Re-verify anything load-bearing before relying on it; the site can change.

## Public CR search

- Page: `https://www.sijilat.bh/public-search-cr/search-cr-2.aspx`
- No CAPTCHA (checked homepage widget and search page). No ASP.NET ViewState despite the .aspx URLs.
- Front end: jQuery 3.6 + Bootstrap 5, DataTables, sweetalert2. Page logic in `/public-search-cr/search-cr-script.js`.
- Stable form IDs: `cr_number`, `cr_name_en`, `cr_name_ar`, `company_type`, plus company-type filter checkboxes.

## API

- Search fires AJAX to `endPoint + "CRdetails/AdvanceSearchCR_Paging"` where `endPoint = "https://api.sijilat.bh/api/"` (global, set in `/js/config.js`). Method POST, `content-type: application/json`.
- Request body is a DataTables server-side payload. The search term for an English-name lookup lands in the top-level `CR_LNM` field (Arabic name → `CR_ANM`, CR number → `CR_NO`). Language is carried as `CULT_LANG` (`"EN"`/`"AR"`), paging as `PaginationParams`. Recorded example banked at `fixtures/live-trace.sijilat.json` (search "bank" → 563 records).
- Response: `{ Status_Code, Status_Message, jsonData: { Total_Records, CR_list: [ { CR_NO, CR_LNM, CR_ANM, CM_TYP_DESC, STATUS, ... } ] } }`.

### Auth (resolves the sha256.js unknown)

- The API requires `Authorization: Bearer <token>`. Body-only replay returns **401**. `sha256.js` is not request signing; it derives the token password.
- The token is anonymous and public: the page runs `tokenRequest("sijilat_test")` (`/js/config.js`), which POSTs `endPoint + "/token"` with `grant_type=password`, `username=sijilat`, `password=HMAC-SHA256(key, "sijilat_test")` where `key` is a constant baked into the public JS. The token is cached in `localStorage.accessToken` with an `expirey_date`. Every anonymous visitor gets one automatically; it is not a user credential.
- **Runner strategy:** do not reproduce the HMAC/password step. Load the origin page in Playwright, let the site mint its own token, read `localStorage.accessToken`, then make the one direct search call with that bearer. The runner never handles the password. This is the "one browser step first" the proposal anticipated.

## Noise to filter

Third-party traffic present on every page (drop at capture via allowlist): Genesys chat (`apps.mypurecloud.de`, 4-5 iframes), AddThis, Moat ads, AppDynamics (`adrum`), Dynatrace (`ruxit`). The chat iframes mean frame-aware capture must ignore cross-origin frames.

## Behaviour notes

- Bilingual AR/EN; localisation via `lang.js`/`localize.js`, state presumably cookie-held.
- `disconnection_handler.js` exists — the site has its own session-drop handling; long idle recordings may see it fire.
- Site is monitored (AppDynamics + Dynatrace) — keep live usage low-volume, as promised in the proposal.
