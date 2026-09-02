// Scenario-matrix acceptance suite: real Chromium + the built extension
// recording against eight mini-sites (fixtures/sites.mjs), each a distinct
// real-world shape — composite-string APIs, form posts, Arabic data, token
// gates, header gates, server-rendered pages, awkward values, pagination. Positive
// scenarios must record, generate and replay; negative ones must refuse with
// a reason. Run: npm run test:matrix (needs ports 4823 and 4985 free).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const EXT = join(root, 'extension/dist');
const BACKEND = 'http://127.0.0.1:4823';
const SITES = 'http://127.0.0.1:4985';

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

const api = (path, body) => fetch(`${BACKEND}${path}`, body === undefined ? {} : {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json());

for (const port of [4823, 4985]) {
  const busy = await fetch(`http://127.0.0.1:${port}/`).then(() => true).catch(() => false);
  if (busy) {
    console.error(`port ${port} already in use — stop the running backend (npm run backend) before npm run test:matrix`);
    process.exit(2);
  }
}

const dataDir = mkdtempSync(join(tmpdir(), 'wfr-matrix-data-'));
const profileDir = mkdtempSync(join(tmpdir(), 'wfr-matrix-profile-'));
// The backend is spawned as node itself, not through npx: killing an npx
// wrapper leaves its child running and the next suite finds the port busy.
const procs = [
  spawn(process.execPath, ['--import', 'tsx', 'backend/src/server.ts'], { cwd: root, env: { ...process.env, DATA_DIR: dataDir }, stdio: 'ignore' }),
  spawn('node', ['fixtures/sites.mjs'], { cwd: root, env: { ...process.env, PORT: '4985' }, stdio: 'ignore' }),
];

let context;
try {
  await waitFor(`${BACKEND}/health`);
  await waitFor(`${SITES}/`);

  context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');

  // Record one scenario: open the mini-site, start a session on its tab,
  // drive the workflow, flush, stop. Returns the backend's stop result.
  async function record(path, session, drive) {
    const page = await context.newPage();
    await page.goto(`${SITES}${path}`);
    const started = await sw.evaluate(async ({ session, pattern }) => {
      const [tab] = await new Promise((r) => chrome.tabs.query({ url: pattern }, r));
      if (!tab) return { ok: false, error: 'tab not found' };
      return globalThis.wfr.start({ session, hosts: ['127.0.0.1'], tabId: tab.id });
    }, { session, pattern: `${SITES}${path}*` });
    check(`${session}: session starts`, started.ok, started.error);
    await drive(page);
    await page.waitForTimeout(700); // let the recorder's batch flush drain
    const stopped = await sw.evaluate(() => globalThis.wfr.stop());
    check(`${session}: session stops`, stopped.ok, stopped.error);
    await page.close();
    return stopped;
  }

  const search = async (page, value) => {
    await page.fill('#q', value);
    await page.click('#go');
    await page.waitForSelector('#results tbody tr');
  };

  // 1. Composite-string API (Algolia shape): the typed value travels inside
  // one string field, percent-encoded.
  await record('/algolia/', 'mx-algolia', (p) => search(p, 'gulf gum'));
  const algSpec = await api('/api/sessions/mx-algolia/spec', {});
  check('algolia: placeholder spliced into the composite string',
    algSpec.steps?.at(-1)?.bodyTemplate?.params === 'query={{enc:query}}&hitsPerPage=30&page=0',
    JSON.stringify(algSpec.steps?.at(-1)?.bodyTemplate));
  const algRun = await api('/api/sessions/mx-algolia/run', { params: { query: 'smith + jones' } });
  check('algolia: replay re-encodes a value carrying + and spaces',
    algRun.ok && algRun.extracted?.records?.rows?.[0]?.name === 'Smith + Jones Ltd',
    algRun.stoppedReason ?? JSON.stringify(algRun.extracted?.records?.rows));

  // 2. Recording a search with zero results still yields a working spec:
  // correlation keys on where the value went, not on what came back.
  await record('/algolia/', 'mx-empty', (p) => Promise.all([
    p.fill('#q', 'zzzz-none'),
    p.click('#go'),
  ]).then(() => p.waitForTimeout(400)));
  const emptySpec = await api('/api/sessions/mx-empty/spec', {});
  check('empty recording: spec still generated', !!emptySpec.steps, emptySpec.error);
  const emptyRun = await api('/api/sessions/mx-empty/run', { params: { query: 'gulf gum' } });
  check('empty recording: replay with a real value finds rows',
    emptyRun.ok && emptyRun.extracted?.records?.rows?.[0]?.name === 'Gulf Gum Trading',
    emptyRun.stoppedReason);

  // 3. Classic form-encoded POST (legacy AJAX shape).
  await record('/form/', 'mx-form', (p) => search(p, 'gulf gum'));
  const formSpec = await api('/api/sessions/mx-form/spec', {});
  const formStep = formSpec.steps?.at(-1);
  check('form: spec generated with a spliced form body',
    typeof formStep?.bodyTemplate === 'string' && /\{\{(plus|enc):query\}\}/.test(formStep.bodyTemplate),
    JSON.stringify(formStep?.bodyTemplate));
  check('form: content type preserved',
    formStep?.headers?.['content-type'] === 'application/x-www-form-urlencoded',
    formStep?.headers?.['content-type']);
  const formRun = await api('/api/sessions/mx-form/run', { params: { query: "o'brien & sons" } });
  check('form: replay form-encodes a value carrying & and quotes',
    formRun.ok && formRun.extracted?.records?.rows?.[0]?.name === "O'Brien & Sons (Holdings)",
    formRun.stoppedReason ?? JSON.stringify(formRun.extracted?.records?.rows));

  // 4. Arabic UI and data, end to end.
  await record('/arabic/', 'mx-arabic', (p) => search(p, 'المنامة'));
  const arSpec = await api('/api/sessions/mx-arabic/spec', {});
  check('arabic: spec generated with the Arabic example', arSpec.parameters?.[0]?.example === 'المنامة',
    JSON.stringify(arSpec.parameters));
  check('arabic: recorded language pinned', arSpec.language === 'AR', arSpec.language);
  const arRun = await api('/api/sessions/mx-arabic/run', { params: { query: 'الخليج' } });
  check('arabic: replay with a different Arabic value',
    arRun.ok && arRun.extracted?.records?.rows?.[0]?.name === 'بيت الخليج للأغذية',
    arRun.stoppedReason ?? JSON.stringify(arRun.extracted?.records?.rows));

  // 5. Token-gated API: probe gets 401, the spec gains a browser-token step,
  // and the run discovers the bearer from the site's own web storage.
  await record('/tokened/', 'mx-token', (p) => search(p, 'gulf gum'));
  const tokSpec = await api('/api/sessions/mx-token/spec', {});
  check('tokened: browser-token step generated',
    tokSpec.steps?.[0]?.type === 'browser-token' && tokSpec.steps?.at(-1)?.bearerFrom === 'token',
    JSON.stringify(tokSpec.steps?.map((s) => s.type)));
  const tokRun = await api('/api/sessions/mx-token/run', { params: { query: 'smith' } });
  check('tokened: run discovers the bearer and names its source',
    tokRun.ok && tokRun.steps?.some((s) => s.type === 'browser-token' && /localStorage\.accessToken/.test(s.detail)),
    tokRun.stoppedReason ?? JSON.stringify(tokRun.steps));
  check('tokened: gated replay returns rows',
    tokRun.extracted?.records?.rows?.[0]?.name === 'Smith + Jones Ltd',
    JSON.stringify(tokRun.extracted?.records?.rows));

  // 6. Server-rendered results (negative): the value only ever travels in a
  // page navigation URL, so there is no call to promote — the session must
  // refuse, not produce a hollow spec.
  await record('/ssr/', 'mx-ssr', async (p) => {
    await p.fill('#q', 'gulf');
    await Promise.all([p.waitForURL('**/ssr/results*'), p.click('#go')]);
  });
  const ssrSpec = await api('/api/sessions/mx-ssr/spec', {});
  check('ssr: refuses to generate a spec', !ssrSpec.steps, JSON.stringify(ssrSpec).slice(0, 200));

  // 7. Awkward values and data: specials in the typed value (URL-borne),
  // nulls, booleans and arrays in the rows.
  await record('/quirks/', 'mx-quirks', (p) => search(p, "o'brien & sons"));
  const qSpec = await api('/api/sessions/mx-quirks/spec', {});
  check('quirks: URL templatised around an encoded special-character value',
    qSpec.steps?.at(-1)?.url?.includes('{{query}}'), qSpec.steps?.at(-1)?.url);
  const qRun = await api('/api/sessions/mx-quirks/run', { params: { query: 'smith + jones' } });
  const qRow = qRun.extracted?.records?.rows?.[0];
  check('quirks: replay resolves a + value against the URL',
    qRun.ok && qRow?.name === 'Smith + Jones Ltd', qRun.stoppedReason ?? JSON.stringify(qRow));
  check('quirks: nulls, booleans and unicode survive the pipeline',
    qRow?.active === false && qRow?.notes === 'était & öß' && Array.isArray(qRow?.tags),
    JSON.stringify(qRow));

  // 8. Paged API recorded in the browser: the replay fetches every page.
  await record('/paged/', 'mx-paged', (p) => search(p, 'gum'));
  const pgSpec = await api('/api/sessions/mx-paged/spec', {});
  check('paged: pagination detected from the recording',
    pgSpec.outcome?.pagination?.pagePath === 'page', JSON.stringify(pgSpec.outcome?.pagination));
  const pgRun = await api('/api/sessions/mx-paged/run', { params: { query: 'gum' } });
  check('paged: replay fetches all pages',
    pgRun.ok && pgRun.extracted?.records?.count === 8 &&
    pgRun.steps?.some((s) => s.type === 'pagination'),
    pgRun.stoppedReason ?? `count=${pgRun.extracted?.records?.count}`);
  // 9. Header-gated API: the page set a custom header and its own accept;
  // the recorder keeps them, the probe sends them (so the 403 without them is
  // never misread as a missing bearer), and the spec replays them.
  await record('/headered/', 'mx-headered', (p) => search(p, 'gulf gum'));
  const hdSpec = await api('/api/sessions/mx-headered/spec', {});
  const hdStep = hdSpec.steps?.at(-1);
  check('headered: no token step is added for a header-caused 403',
    hdSpec.steps?.every((s) => s.type === 'request'), JSON.stringify(hdSpec.steps?.map((s) => s.type)));
  check('headered: the recorded custom header and accept are in the spec',
    hdStep?.headers?.['x-app-id'] === 'demo-app' && hdStep?.headers?.accept === 'application/vnd.demo+json',
    JSON.stringify(hdStep?.headers));
  const hdRun = await api('/api/sessions/mx-headered/run', { params: { query: 'smith' } });
  check('headered: replay sends the headers and returns rows',
    hdRun.ok && hdRun.extracted?.records?.rows?.[0]?.name === 'Smith + Jones Ltd',
    hdRun.stoppedReason ?? JSON.stringify(hdRun.extracted?.records?.rows));
} catch (err) {
  check('harness ran to completion', false, String(err?.stack ?? err).slice(0, 400));
} finally {
  await context?.close().catch(() => {});
  for (const p of procs) p.kill();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(profileDir, { recursive: true, force: true });
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASS');
process.exit(failures.length ? 1 : 0);
