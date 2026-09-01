import { chromium } from 'playwright';
import { UA } from './browser-token.js';

// The browser step for server-rendered outcomes: load the linked page, read
// the elements the operator marked while recording. A selector that matches
// nothing returns undefined so the runner can stop with a named reason.
export type PageExtract = { httpStatus: number; texts: (string | undefined)[] };

export async function extractPageViaBrowser(url: string, selectors: string[]): Promise<PageExtract> {
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // Marked elements may hydrate after load; give the first one a moment.
    await page.waitForSelector(selectors[0], { timeout: 15_000 }).catch(() => {});
    const texts: (string | undefined)[] = [];
    for (const sel of selectors) {
      texts.push(await page.locator(sel).first().innerText({ timeout: 2_000 })
        .then((t) => t.replace(/\s+/g, ' ').trim())
        .catch(() => undefined));
    }
    return { httpStatus: res?.status() ?? 0, texts };
  } finally {
    await browser.close();
  }
}
