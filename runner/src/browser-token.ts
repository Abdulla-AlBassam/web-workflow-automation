import { chromium } from 'playwright';

// The one browser step: load the origin so the site mints its own anonymous
// token, then read it back. The runner never derives or posts the token itself.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export async function readTokenViaBrowser(loadUrl: string, readToken: string): Promise<string | undefined> {
  const store = readToken.replace(/^localStorage\./, '');
  const browser = await chromium.launch({ headless: true });
  try {
    // A default headless user agent gets a different page from this site, which
    // then never mints the anonymous token. Present as a normal desktop Chrome.
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(loadUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // The token is written once the page's own token request resolves.
    await page.waitForFunction((k) => !!localStorage.getItem(k), store, { timeout: 25_000 }).catch(() => {});
    return await page.evaluate((k) => localStorage.getItem(k) ?? undefined, store);
  } finally {
    await browser.close();
  }
}
