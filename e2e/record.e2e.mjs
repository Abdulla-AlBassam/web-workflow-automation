// End-to-end proof of the capture path: real Chromium + the built extension
// against the local mock, asserting on the backend's export. Run: npm run e2e
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const EXT = join(root, 'extension/dist');
const BACKEND = 'http://127.0.0.1:4823';
const MOCK = 'http://127.0.0.1:4980';
const SESSION = `e2e-${Math.random().toString(36).slice(2, 8)}`;
const CR = '139867';
const PIN = 'hunter2secret';

const failures = [];
function check(name, cond, detail = '') {
  console.log(`${cond ? '  ok ' : 'FAIL '} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) failures.push(name);
}

async function waitFor(url, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${url}`);
}

// The extension build hardcodes the backend at 4823, so this suite needs that
// port and the mock's 4980. Fail fast with a clear message instead of silently
// testing against an interactively running backend.
for (const port of [4823, 4980]) {
  const busy = await fetch(`http://127.0.0.1:${port}/`).then(() => true).catch(() => false);
  if (busy) {
    console.error(`port ${port} already in use — stop the running backend/mock (npm run backend) before npm run e2e`);
    process.exit(2);
  }
}

const dataDir = mkdtempSync(join(tmpdir(), 'wfr-e2e-data-'));
const profileDir = mkdtempSync(join(tmpdir(), 'wfr-e2e-profile-'));
const procs = [
  spawn('npx', ['tsx', 'backend/src/server.ts'], { cwd: root, env: { ...process.env, DATA_DIR: dataDir }, stdio: 'inherit' }),
  spawn('node', ['fixtures/serve.mjs'], { cwd: root, stdio: 'inherit' }),
];

let context;
try {
  await waitFor(`${BACKEND}/health`);
  await waitFor(`${MOCK}/`);

  context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });

  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');

  const page = await context.newPage();
  await page.goto(`${MOCK}/`);

  const started = await sw.evaluate(async ({ session }) => {
    const [tab] = await new Promise((r) => chrome.tabs.query({ url: 'http://127.0.0.1:4980/*' }, r));
    return globalThis.wfr.start({ session, hosts: ['127.0.0.1'], tabId: tab.id });
  }, { session: SESSION });
  check('session starts', started.ok, started.error);

  await page.fill('#cr_number', CR);
  await page.fill('#secret', PIN);
  await page.click('#btn_search');
  await page.waitForSelector('#results tbody tr');

  // Highlight the first result's name: the mark chip must appear, and clicking
  // it must record the selection as wanted data.
  await page.click('#results tbody tr td:nth-child(2)', { clickCount: 3 });
  const chipEl = await page.waitForSelector('[data-wfr="chip"]', { timeout: 3000 });
  await chipEl.click();
  await page.waitForTimeout(600); // let the recorder's 250ms batch flush drain

  const stopped = await sw.evaluate(() => globalThis.wfr.stop());
  check('session stops', stopped.ok, stopped.error);

  const exportRes = await fetch(`${BACKEND}/api/sessions/${SESSION}/export`);
  check('export endpoint responds', exportRes.ok);
  const dump = await exportRes.json();
  const events = dump.events;
  const raw = JSON.stringify(dump);

  check('status is complete', dump.meta.status === 'complete', dump.meta.status);
  check('first event is session_start', events[0]?.kind === 'session_start');
  check('last event is session_stop', events.at(-1)?.kind === 'session_stop');
  check('page event captured', events.some((e) => e.kind === 'page' && e.url?.startsWith(MOCK)));
  check('CR input captured with value', events.some(
    (e) => e.kind === 'action' && e.action === 'input' && e.target?.id === 'cr_number' && e.value === CR));
  check('search click captured', events.some(
    (e) => e.kind === 'action' && e.action === 'click' && e.target?.id === 'btn_search'));
  check('marked selection captured', events.some(
    (e) => e.kind === 'action' && e.action === 'mark' && e.text === 'Awal Trading Co. W.L.L'),
    JSON.stringify(events.filter((e) => e.action === 'mark')));

  const net = events.find((e) => e.kind === 'net' && e.url?.includes('AdvanceSearchCR_Paging'));
  check('search API call captured', !!net);
  check('API method and status', net?.method === 'POST' && net?.status === 200, JSON.stringify({ m: net?.method, s: net?.status }));
  check('request body holds the typed CR', !!net?.reqBody?.includes(CR), net?.reqBody);
  check('response body holds the result', !!net?.resBody?.includes('Awal Trading'), net?.resBody?.slice(0, 120));

  check('password never leaves the page', !raw.includes(PIN));
  check('password field recorded as [REDACTED]', events.some(
    (e) => e.kind === 'action' && e.action === 'input' && e.target?.id === 'secret' && e.value === '[REDACTED]'));
  check('cross-host noise dropped', !raw.includes('/noise'));

  const seqs = events.map((e) => e.seq);
  check('seq strictly increasing, no gaps',
    seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1) && dump.integrity.seqGaps.length === 0,
    `gaps: ${JSON.stringify(dump.integrity.seqGaps)}`);
} catch (err) {
  check('harness ran to completion', false, String(err));
} finally {
  await context?.close().catch(() => {});
  for (const p of procs) p.kill();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(profileDir, { recursive: true, force: true });
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASS');
process.exit(failures.length ? 1 : 0);
