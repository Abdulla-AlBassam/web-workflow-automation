import { chromium } from 'playwright';
import { leaves } from '../../backend/src/analyse.js';

// The one browser step: load the origin so the site mints its own token, then
// find it in web storage. Nothing site-shaped survives here — any JWT-looking
// value, or a token-named field inside a stored JSON blob, qualifies; the best
// match wins and the run reports where it came from. The runner never derives
// or posts a token itself.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const JWT = /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/;

export type Bearer = { bearer: string; source: string };

type Candidate = Bearer & { score: number };

function scan(entries: { store: string; key: string; value: string }[]): Bearer | undefined {
  const cands: Candidate[] = [];
  for (const { store, key, value } of entries) {
    if (JWT.test(value.trim())) {
      cands.push({ bearer: value.trim(), source: `${store}.${key}`, score: 3 + (/token|auth/i.test(key) ? 2 : 0) });
      continue;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { continue; }
    if (!parsed || typeof parsed !== 'object') continue;
    for (const { path, value: v } of leaves(parsed)) {
      if (typeof v !== 'string' || v.length < 20) continue;
      const field = path.split('.').at(-1) ?? '';
      let score = 0;
      if (/^access_?token$/i.test(field)) score = 5;
      else if (/^(id_?token|token|jwt|bearer)$/i.test(field)) score = 4;
      else if (JWT.test(v)) score = 2;
      if (!score) continue;
      cands.push({ bearer: v, source: `${store}.${key} → ${path}`, score });
    }
  }
  cands.sort((a, b) => b.score - a.score || b.bearer.length - a.bearer.length);
  return cands[0] && { bearer: cands[0].bearer, source: cands[0].source };
}

export async function readBearerViaBrowser(loadUrl: string): Promise<Bearer | undefined> {
  const browser = await chromium.launch({ headless: true });
  try {
    // A default headless user agent gets a different page from some sites,
    // which then never mint the token. Present as a normal desktop Chrome.
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(loadUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // The token appears once the page's own token request resolves; poll for it.
    const until = Date.now() + 25_000;
    for (;;) {
      const entries = await page.evaluate(() => {
        const out: { store: string; key: string; value: string }[] = [];
        for (const store of ['localStorage', 'sessionStorage'] as const) {
          try {
            const s = window[store];
            for (let i = 0; i < s.length; i++) {
              const key = s.key(i)!;
              out.push({ store, key, value: s.getItem(key) ?? '' });
            }
          } catch { /* storage blocked in this context */ }
        }
        return out;
      });
      const hit = scan(entries);
      if (hit || Date.now() > until) return hit;
      await page.waitForTimeout(500);
    }
  } finally {
    await browser.close();
  }
}
