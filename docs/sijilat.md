# Sijilat — live-site evidence

Captured by direct inspection on 2026-08-29. Re-verify anything load-bearing before relying on it; the site can change.

## Public CR search

- Page: `https://www.sijilat.bh/public-search-cr/search-cr-2.aspx`
- No CAPTCHA (checked homepage widget and search page). No ASP.NET ViewState despite the .aspx URLs.
- Front end: jQuery 3.6 + Bootstrap 5, DataTables, sweetalert2. Page logic in `/public-search-cr/search-cr-script.js`.
- Stable form IDs: `cr_number`, `cr_name_en`, `cr_name_ar`, `company_type`, plus company-type filter checkboxes.

## API

- Search fires AJAX to `endPoint + "CRdetails/AdvanceSearchCR_Paging"` where `endPoint = "https://api.sijilat.bh/api/"` (global, set in `/js/config.js`).
- Request body shape, headers, and whether the API demands signing: unknown until we record a real session. `sha256.js` is loaded by the page — possible request signing. This is the main unknown for the direct-request path.

## Noise to filter

Third-party traffic present on every page (drop at capture via allowlist): Genesys chat (`apps.mypurecloud.de`, 4-5 iframes), AddThis, Moat ads, AppDynamics (`adrum`), Dynatrace (`ruxit`). The chat iframes mean frame-aware capture must ignore cross-origin frames.

## Behaviour notes

- Bilingual AR/EN; localisation via `lang.js`/`localize.js`, state presumably cookie-held.
- `disconnection_handler.js` exists — the site has its own session-drop handling; long idle recordings may see it fire.
- Site is monitored (AppDynamics + Dynatrace) — keep live usage low-volume, as promised in the proposal.
