// Operator tool: records ONE live Sijilat lookup through the real extension
// and banks the sanitised trace as a fixture. Low-volume by design — a single
// search per run, per the access safeguards in CLAUDE.md.
// Usage: node tools/record-live.mjs [search-term]
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const EXT = join(root, 'extension/dist');
const BACKEND = 'http://127.0.0.1:4823';
const SEARCH_URL = 'https://www.sijilat.bh/public-search-cr/search-cr-2.aspx';
const TERM = process.argv[2] ?? 'bank';
const SESSION = `live-${TERM.replace(/\W+/g, '-')}-${Math.random().toString(36).slice(2, 6)}`;

async function waitFor(url, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${url}`);
}

const dataDir = join(root, 'backend/data');
const profileDir = mkdtempSync(join(tmpdir(), 'wfr-live-'));
const backend = spawn('npx', ['tsx', 'backend/src/server.ts'], {
  cwd: root, env: { ...process.env, DATA_DIR: dataDir }, stdio: 'inherit',
});

let context;
try {
  await waitFor(`${BACKEND}/health`);

  // Headed on purpose: live recording is operator-supervised, and the site
  // serves headless user agents a different page.
  context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');

  const page = await context.newPage();
  console.log(`loading ${SEARCH_URL} …`);
  await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('#cr_name_en', { timeout: 30_000 });

  const started = await sw.evaluate(async ({ session }) => {
    const [tab] = await new Promise((r) => chrome.tabs.query({ url: 'https://www.sijilat.bh/*' }, r));
    return globalThis.wfr.start({ session, hosts: ['sijilat.bh'], tabId: tab.id });
  }, { session: SESSION });
  if (!started.ok) throw new Error(`start failed: ${started.error}`);
  console.log(`recording session ${SESSION}`);

  await page.fill('#cr_name_en', TERM);
  // Plain "Search" only: the page also has an "Advanced Search" toggler that
  // must not be hit, and hidden header buttons that share the text.
  const buttons = await page.locator('button:has-text("Search"), input[type="submit"]').all();
  let clicked = false;
  for (const loc of buttons) {
    const text = ((await loc.textContent().catch(() => '')) ?? '').trim();
    if (/advanced/i.test(text)) continue;
    if (!(await loc.isVisible().catch(() => false))) continue;
    console.log(`clicking "${text || '(submit)'}"`);
    await loc.click();
    clicked = true;
    break;
  }
  if (!clicked) {
    console.log('no search control found; pressing Enter in the field');
    await page.press('#cr_name_en', 'Enter');
  }

  // Wait for the search API round-trip rather than a DOM guess.
  await page.waitForResponse((r) => r.url().includes('AdvanceSearchCR'), { timeout: 30_000 })
    .catch(() => console.log('warning: no AdvanceSearchCR response observed within 30s'));
  await page.waitForTimeout(1500); // batch flush + any trailing paging calls

  await sw.evaluate(() => globalThis.wfr.stop());
  const dump = await (await fetch(`${BACKEND}/api/sessions/${SESSION}/export`)).json();

  const out = join(root, 'fixtures/live-trace.sijilat.json');
  writeFileSync(out, JSON.stringify(dump, null, 2));
  const nets = dump.events.filter((e) => e.kind === 'net');
  console.log(`\nbanked ${out}`);
  console.log(`events: ${dump.events.length}, net (with bodies): ${nets.length}, status: ${dump.meta.status}`);
  for (const n of nets) console.log(`  ${n.method} ${n.url} → ${n.status} (${(n.resBody ?? '').length}b)`);
} finally {
  await context?.close().catch(() => {});
  backend.kill();
  rmSync(profileDir, { recursive: true, force: true });
}
