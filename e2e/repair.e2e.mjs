// LLM repair loop suite. A scripted mock model stands in for the API (tool
// calls over the streaming wire format), and a mini-site reproduces the
// failure shapes live: JSONP suggestions, an article API, a server-rendered
// results list. Proves the loop investigates with tools, rejects a script
// that fails the rails, accepts one that reproduces the recording, saves it
// into the session, replays it for a new input, confines it to its verified
// hosts, refines a saved automation, and stops at its budget.
// Run: node e2e/repair.e2e.mjs
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Script } from 'node:vm';
import { join } from 'node:path';

const BACKEND_PORT = 4893;
const LLM_PORT = 4987;
const SITE_PORT = 4989;
const SITES_PORT = 4991; // fixtures/sites.mjs, for the token-gated shape
const TOK = `http://127.0.0.1:${SITES_PORT}`;
const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJhbm9uIjp0cnVlLCJzY29wZSI6InB1YmxpYyJ9.c2lnbmF0dXJl';
const BACKEND = `http://127.0.0.1:${BACKEND_PORT}`;
const SITE = `http://127.0.0.1:${SITE_PORT}`;

const failures = [];
function check(name, cond, detail = '') {
  console.log(`${cond ? '  ok ' : 'FAIL'} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) failures.push(name);
}
async function wait(u) { for (let i = 0; i < 60; i++) { try { if ((await fetch(u)).ok) return; } catch {} await new Promise((r) => setTimeout(r, 150)); } throw new Error('timeout ' + u); }
const api = (path, body) => fetch(`${BACKEND}${path}`, body === undefined ? {} : {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json());

async function ensureFree(port) {
  const busy = await fetch(`http://127.0.0.1:${port}/`).then(() => true).catch(() => false);
  if (busy) throw new Error(`port ${port} already in use — stop whatever is running there before the suite`);
}
await ensureFree(BACKEND_PORT);
await ensureFree(LLM_PORT);
await ensureFree(SITE_PORT);
await ensureFree(SITES_PORT);

// --- mini-site ---------------------------------------------------------------
const ARTICLES = [
  { pageid: 8569916, ns: 0, title: 'English language', description: 'West Germanic language',
    extract: 'English (pronounced [ˈɪŋɡlɪʃ] ) is a West Germanic language of the Indo-European language family that emerged in early medieval England and has since become a global lingua franca. The language is named after the Angles, one of the Germanic peoples who migrated to Britain.' },
  { pageid: 10597, ns: 0, title: 'French language', description: 'Romance language',
    extract: 'French is a Romance language of the Indo-European family. Like all other Romance languages, French descended from the Vulgar Latin of the Roman Empire.' },
];
const COMPANIES = [
  { name: 'Awal Trading Co. W.L.L', cr: '139867' },
  { name: 'Delmon Trading W.L.L', cr: '91230' },
  { name: 'Gulf Line Logistics', cr: '20775' },
];
const site = createServer((req, res) => {
  const url = new URL(req.url, SITE);
  // JSONP when callback= is present, plain JSON otherwise.
  if (url.pathname === '/api/suggest') {
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const cb = url.searchParams.get('callback');
    const data = { results: COMPANIES.filter((c) => c.name.toLowerCase().includes(q)) };
    if (cb) {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(`${cb}(${JSON.stringify(data)})`);
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    }
    return;
  }
  // MediaWiki-like: prop=info drops the extract.
  if (url.pathname === '/api/article') {
    const titles = url.searchParams.get('titles') ?? '';
    const page = ARTICLES.find((a) => a.title.toLowerCase() === titles.toLowerCase());
    const record = !page ? { ns: 0, title: titles, missing: true }
      : url.searchParams.get('prop') === 'info' ? { pageid: page.pageid, ns: 0, title: page.title }
      : page;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ batchcomplete: true, query: { pages: [record] } }));
    return;
  }
  // Server-rendered results: no API behind them at all.
  if (url.pathname === '/results') {
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const hits = COMPANIES.filter((c) => c.name.toLowerCase().includes(q));
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><body><h1>Results</h1><ul>${hits.map((c) => `<li class="hit"><span class="n">${c.name}</span> <span class="cr">${c.cr}</span></li>`).join('')}</ul></body></html>`);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<html><body>mini site</body></html>');
});
site.listen(SITE_PORT);

// --- mock model ---------------------------------------------------------------
// Each POST /v1/messages consumes the next scripted assistant message and
// streams it back as SSE, the way the SDK's stream() expects.
const SUGGEST = `${SITE}/api/suggest`;
const ARTICLE = `${SITE}/api/article`;
let toolSeq = 0;
const text = (t) => ({ type: 'text', text: t });
const tool = (name, input) => ({ type: 'tool_use', id: `toolu_${++toolSeq}`, name, input });

const GOOD_SUGGEST = `async function run(ctx) {
  const res = await ctx.http.fetch('${SUGGEST}?q=' + encodeURIComponent(ctx.inputs.query));
  const data = res.json();
  return data.results.map((r) => ({ name: r.name, cr: r.cr }));
}`;
const HARDCODED = GOOD_SUGGEST.replace('encodeURIComponent(ctx.inputs.query)', "'trading'");
// The wiki recording typed into #searchInput, so that is the parameter's name.
const ARTICLE_INFO = `async function run(ctx) {
  const res = await ctx.http.fetch('${ARTICLE}?titles=' + encodeURIComponent(ctx.inputs.searchInput) + '&prop=info');
  return res.json().query.pages.map((p) => ({ title: p.title }));
}`;
const ARTICLE_FULL = `async function run(ctx) {
  const res = await ctx.http.fetch('${ARTICLE}?titles=' + encodeURIComponent(ctx.inputs.searchInput) + '&explaintext=1');
  return res.json().query.pages.map((p) => ({ title: p.title, extract: p.extract }));
}`;
const SSR_SCRIPT = `async function run(ctx) {
  const page = await ctx.browser.open('${SITE}/results?q=' + encodeURIComponent(ctx.inputs.query));
  const rows = await page.eval("[...document.querySelectorAll('li.hit')].map((li) => ({ name: li.querySelector('.n').textContent, cr: li.querySelector('.cr').textContent }))");
  await page.close();
  return rows;
}`;
// Token-gated API (the Sijilat shape): only the bearer the site itself mints
// may be sent; a forged one is dropped and the API answers 401.
const GATED_FORGED = `async function run(ctx) {
  const res = await ctx.http.fetch('${TOK}/tokened/api/search', { method: 'POST', headers: { authorization: 'Bearer forged' }, body: { q: ctx.inputs.query } });
  return (res.json().rows || []).map((r) => ({ name: r.name, city: r.city }));
}`;
const GATED_SCRIPT = `async function run(ctx) {
  const token = await ctx.site.token('${TOK}/tokened/');
  const res = await ctx.http.fetch('${TOK}/tokened/api/search', { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: { q: ctx.inputs.query } });
  return res.json().rows.map((r) => ({ name: r.name, city: r.city }));
}`;
const ZERO_PARAM = `async function run(ctx) {
  const res = await ctx.http.fetch('${SUGGEST}?q=');
  return res.json().results.map((r) => ({ name: r.name, cr: r.cr }));
}`;

const scripts = [
  // --- jsonp: investigate, fail the lint, then succeed.
  [text('The suggestion request was a script tag; checking whether it answers as JSON.'), tool('probe', { method: 'GET', url: `${SUGGEST}?q=trading&callback=cb0` })],
  [tool('probe', { method: 'GET', url: `${SUGGEST}?q=trading` })],
  [text('Writing the script.'), tool('write_script', { source: HARDCODED, title: 'Trading Name Search', summary: 'Calls the suggestion endpoint as plain JSON.' })],
  [tool('write_script', { source: GOOD_SUGGEST, title: 'Trading Name Search', summary: 'Calls the suggestion endpoint as plain JSON, parameterised on the typed name.' })],
  // --- wiki: a net_meta read, a partial script, then the full one.
  [tool('read_body', { seq: 3 })],
  [tool('write_script', { source: ARTICLE_INFO, title: 'Wikipedia Article Lookup', summary: 'Article API.' })],
  [tool('write_script', { source: ARTICLE_FULL, title: 'Wikipedia Article Lookup', summary: 'Article API with plain-text extracts.' })],
  // --- wikiold (refine): straight to the corrected script.
  [text('The saved script drops the extract.'), tool('write_script', { source: ARTICLE_FULL, title: 'Wikipedia Article Lookup', summary: 'Adds the extract field.' })],
  // --- ssr: look at the page, then drive the browser from the script.
  [tool('open_page', { url: `${SITE}/results?q=trading`, read: 'eval', expression: "[...document.querySelectorAll('li.hit')].map((li) => li.textContent)" })],
  [tool('write_script', { source: SSR_SCRIPT, title: 'Company Results (rendered)', summary: 'Loads the results page and reads the list.' })],
  // --- zeroparam: nothing typed, one mark.
  [tool('write_script', { source: ZERO_PARAM, title: 'All Companies', summary: 'Lists every company.' })],
  // --- giveup: an honest stop.
  [tool('give_up', { reason: 'The data is only ever rendered as an image.', advice: 'Re-record on a page that lists the results as text.' })],
  // --- gated, refine 1: keep the deterministic spec, change the fields.
  [tool('set_columns', { columns: [{ name: 'name', path: 'name' }, { name: 'city', path: 'city' }], summary: 'Only name and city.' })],
  // --- gated, refine 2: a forged bearer fails, the site's own bearer works.
  [tool('write_script', { source: GATED_FORGED, title: 'Gated Search', summary: 'Calls the API.' })],
  [tool('write_script', { source: GATED_SCRIPT, title: 'Gated Search', summary: 'Calls the API with the anonymous bearer the site mints.' })],
];
// --- stopme: a reply that never arrives; the operator presses Stop.
const SLOW = 'slow';
scripts.push(SLOW);
// After the script runs out the model probes forever, two at a time: the
// loop's own budget must end it.
const FOREVER = () => [tool('probe', { method: 'GET', url: `${SUGGEST}?q=x` }), tool('probe', { method: 'GET', url: `${SUGGEST}?q=y` })];

const llmRequests = [];
function sse(res, blocks) {
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  send('message_start', { type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } });
    } else {
      send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    }
    send('content_block_stop', { type: 'content_block_stop', index });
  });
  const stop = blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
  send('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
  send('message_stop', { type: 'message_stop' });
  res.end();
}
const llm = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    llmRequests.push(JSON.parse(body));
    const next = scripts.shift() ?? FOREVER();
    if (next === SLOW) {
      // Headers only, then silence: a model call still in flight when the
      // operator stops. The abort must cut it, not wait for it.
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      setTimeout(() => { if (!res.destroyed) res.end(); }, 15_000).unref();
      return;
    }
    sse(res, next);
  });
});
llm.listen(LLM_PORT);

const sites = spawn('node', ['fixtures/sites.mjs'], { cwd: process.cwd(), env: { ...process.env, PORT: String(SITES_PORT) }, stdio: 'ignore' });

const dataDir = mkdtempSync(join(tmpdir(), 'wfr-repair-'));
// The backend is spawned as node itself, not through npx: killing an npx
// wrapper leaves its child running and the next suite finds the port busy.
const backend = spawn(process.execPath, ['--import', 'tsx', 'backend/src/server.ts'], {
  cwd: process.cwd(),
  env: { ...process.env, DATA_DIR: dataDir, PORT: String(BACKEND_PORT),
    ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${LLM_PORT}`, REPAIR_MODEL: 'claude-sonnet-5' },
  stdio: 'ignore',
});

// --- recordings ---------------------------------------------------------------
// The JSONP failure shape: typed input, script-only suggestion request, a
// click on a result — no captured structured response anywhere.
const jsonpEvents = () => [
  { kind: 'session_start', seq: 0 },
  { kind: 'page', url: `${SITE}/`, lang: 'en', seq: 1 },
  { kind: 'action', action: 'click', target: { tag: 'input', selector: '#q' }, seq: 2 },
  { kind: 'net_meta', method: 'GET', url: `${SUGGEST}?q=trading&callback=cb0`, status: 200, resourceType: 'script', seq: 3 },
  { kind: 'action', action: 'input', value: 'trading', target: { id: 'q' }, seq: 4 },
  { kind: 'action', action: 'click', target: { tag: 'a', text: 'Awal Trading Co. W.L.L' }, seq: 5 },
  { kind: 'nav', url: `${SITE}/company/139867`, transition: 'link', seq: 6 },
  { kind: 'session_stop', seq: 7 },
];
// The Wikipedia shape: JSONP typeahead, a click through to a server-rendered
// article, two marks on it — the title, and an intro paragraph carrying
// citation markers the API's plain text will not have.
const INTRO_MARK = 'English (pronounced [ˈɪŋɡlɪʃ] ⓘ)[1] is a West Germanic language of the Indo-European language family that emerged in early medieval England and has since become a global lingua franca.[4][5][6] The language is named after the Angles, one of the Germanic peoples who migrated to Britain.';
const wikiEvents = () => [
  { kind: 'session_start', seq: 0 },
  { kind: 'page', url: `${SITE}/`, lang: 'en', seq: 1 },
  { kind: 'action', action: 'click', target: { tag: 'input', selector: '#searchInput' }, seq: 2 },
  { kind: 'net_meta', method: 'GET', url: `${SUGGEST}?q=english%20language&callback=cb1`, status: 200, resourceType: 'script', seq: 3 },
  { kind: 'action', action: 'input', value: 'english language', target: { id: 'searchInput' }, seq: 4 },
  { kind: 'action', action: 'click', target: { tag: 'a', text: 'English language\n\nWest Germanic language' }, seq: 5 },
  { kind: 'nav', url: `${SITE}/wiki/English_language`, transition: 'link', seq: 6 },
  { kind: 'page', url: `${SITE}/wiki/English_language`, lang: 'en', seq: 7 },
  { kind: 'action', action: 'mark', text: 'English language', target: { selector: '#firstHeading' }, seq: 8 },
  { kind: 'action', action: 'mark', text: INTRO_MARK, target: { selector: '#mwAQ' }, seq: 9 },
  { kind: 'session_stop', seq: 10 },
];
// Server-rendered results: the typed value travels only in a navigation.
const ssrEvents = () => [
  { kind: 'session_start', seq: 0 },
  { kind: 'page', url: `${SITE}/search`, lang: 'en', seq: 1 },
  { kind: 'action', action: 'input', value: 'trading', target: { id: 'q' }, seq: 2 },
  { kind: 'action', action: 'submit', target: { tag: 'form', selector: 'form' }, seq: 3 },
  { kind: 'nav', url: `${SITE}/results?q=trading`, transition: 'form_submit', seq: 4 },
  { kind: 'page', url: `${SITE}/results?q=trading`, lang: 'en', seq: 5 },
  { kind: 'session_stop', seq: 6 },
];

async function record(session, events) {
  await api('/api/sessions', { session, hosts: ['127.0.0.1'], startedAt: 1 });
  await api(`/api/sessions/${session}/events`, { items: events });
  return api(`/api/sessions/${session}/stop`, {});
}
async function repair(session, body) {
  const t = await fetch(`${BACKEND}/api/sessions/${session}/repair`, body === undefined ? { method: 'POST' } : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.text());
  return t.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
// Every inline script on a page must parse: a bad escape in a template
// literal once emitted a raw newline into the page's JavaScript and the
// repair button died silently.
function scriptsCompile(html) {
  for (const [, src] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    try { new Script(src); } catch (e) { return `inline script does not parse: ${e.message}`; }
  }
  return '';
}
const readSpec = (session) => JSON.parse(readFileSync(join(dataDir, session, 'spec.json'), 'utf8'));
const readScript = (session) => readFileSync(join(dataDir, session, 'automation.mjs'), 'utf8');
const kinds = (lines) => lines.map((l) => l.kind);
const packText = (i) => JSON.stringify(llmRequests[i] ?? {});

try {
  await wait(`${BACKEND}/health`);

  // Scenario 1: the JSONP recording — two probes, a rejected script, a kept one.
  const stop = await record('jsonp', jsonpEvents());
  check('recording refuses deterministically', stop.spec === false);
  const lines = await repair('jsonp');
  check('probes are executed and shown', lines.filter((l) => l.kind === 'tool' && /^probe GET/.test(l.text)).length === 2, JSON.stringify(lines));
  check('a script carrying the recorded value literally is rejected by lint',
    lines.some((l) => l.kind === 'fail' && /lint: .*appears literally/.test(l.text)), JSON.stringify(lines));
  check('the parameterised script is verified and saved',
    lines.some((l) => l.kind === 'ok' && /rows carry the typed value "trading"/.test(l.text)) && kinds(lines).includes('saved'),
    JSON.stringify(lines));
  check('spend is reported', lines.some((l) => l.kind === 'info' && /Spend this repair/.test(l.text)));
  const spec = readSpec('jsonp');
  check('saved spec is a script step confined to the hosts it used',
    spec.repaired && spec.steps[0].type === 'script' && spec.steps[0].file === 'automation.mjs' &&
    JSON.stringify(spec.steps[0].hosts) === '["127.0.0.1"]' && spec.parameters[0]?.name === 'query',
    JSON.stringify(spec.steps));
  check('the script lives in the session folder', readScript('jsonp') === GOOD_SUGGEST);
  const meta = JSON.parse(readFileSync(join(dataDir, 'jsonp', 'meta.json'), 'utf8'));
  check('session titled by the assistant', meta.name === 'Trading Name Search', meta.name);
  const run = await api('/api/sessions/jsonp/run', { params: { query: 'gulf' } });
  check('the script replays a new input',
    run.ok && JSON.stringify(run.extracted?.records?.rows ?? []).includes('Gulf Line Logistics') && run.steps[0].type === 'script',
    run.stoppedReason ?? JSON.stringify(run));
  const page = await fetch(`${BACKEND}/session/jsonp`).then((r) => r.text());
  check('session page shows the provenance and the script',
    page.includes('Built by the LLM repair assistant') && page.includes('Show the session script') && page.includes('ctx.http.fetch'));
  check('session page scripts parse (spec present)', scriptsCompile(page) === '', scriptsCompile(page));
  check('repaired spec survives page-load regeneration', readSpec('jsonp').steps[0].type === 'script');
  check('the model was shown the uncaptured JSONP request and the tools',
    packText(0).includes('body not captured') && packText(0).includes('write_script') && packText(0).includes('[carries the typed value]') === false);
  check('probe results reached the model in full',
    JSON.stringify(llmRequests[2]).includes('Awal Trading Co. W.L.L') && JSON.stringify(llmRequests[1]).includes('cb0('));

  // Scenario 2: the saved script is confined to its verified hosts.
  writeFileSync(join(dataDir, 'jsonp', 'automation.mjs'), GOOD_SUGGEST.replace('127.0.0.1', 'localhost'));
  const strayed = await api('/api/sessions/jsonp/run', { params: { query: 'gulf' } });
  check('a script reaching outside its hosts is stopped',
    strayed.ok === false && /outside the hosts/.test(strayed.stoppedReason ?? ''), strayed.stoppedReason);
  writeFileSync(join(dataDir, 'jsonp', 'automation.mjs'), GOOD_SUGGEST);

  // Scenario 3: nothing typed and nothing marked — no model call at all.
  const before = llmRequests.length;
  await record('nothing', [
    { kind: 'session_start', seq: 0 },
    { kind: 'page', url: `${SITE}/company/139867`, lang: 'en', seq: 1 },
    { kind: 'action', action: 'click', target: { tag: 'a', text: 'New Homes' }, seq: 2 },
    { kind: 'session_stop', seq: 3 },
  ]);
  const noLines = await repair('nothing');
  check('nothing to parameterise or verify: advice without spending a call',
    kinds(noLines).includes('advice') && llmRequests.length === before && !existsSync(join(dataDir, 'nothing', 'spec.json')),
    JSON.stringify(noLines));
  const refusalPage = await fetch(`${BACKEND}/session/nothing`).then((r) => r.text());
  check('session page scripts parse (refusal card)', scriptsCompile(refusalPage) === '', scriptsCompile(refusalPage));

  // Scenario 4: marks decide acceptance — a partial script is fed back.
  await record('wiki', wikiEvents());
  const wikiLines = await repair('wiki');
  check('read_body on a metadata-only event explains itself',
    JSON.stringify(llmRequests.at(-1)).includes('no net event with seq 3'), JSON.stringify(llmRequests.at(-1)).slice(0, 300));
  check('partial marks: fed back with the missing selection',
    wikiLines.some((l) => l.kind === 'fail' && /1 of 2 marked selections located; missing: "english pronounced/.test(l.text)), JSON.stringify(wikiLines));
  check('both marks located: saved',
    wikiLines.some((l) => l.kind === 'ok' && /all 2 marked selection\(s\) located/.test(l.text)) && kinds(wikiLines).includes('saved'), JSON.stringify(wikiLines));
  const french = await api('/api/sessions/wiki/run', { params: { searchInput: 'French Language' } });
  const frenchRow = french.extracted?.records?.rows?.[0];
  check('wiki: a new input returns the script\'s fields',
    french.ok && JSON.stringify(Object.keys(frenchRow ?? {})) === '["title","extract"]' && frenchRow.extract.startsWith('French is a Romance'),
    french.stoppedReason ?? JSON.stringify(french.extracted));

  // Scenario 5: refine a saved automation the operator flagged.
  await record('wikiold', wikiEvents());
  writeFileSync(join(dataDir, 'wikiold', 'automation.mjs'), ARTICLE_INFO);
  writeFileSync(join(dataDir, 'wikiold', 'spec.json'), JSON.stringify({ ...readSpec('wiki'), name: 'wikiold' }));
  const lastRun = { params: { searchInput: 'French Language' }, ok: true, rowCount: 1, columns: ['title'], firstRow: { title: 'French language' } };
  const refineLines = await repair('wikiold', { feedback: 'I only want the article text', lastRun });
  check('refine: console shows the saved automation and the note',
    refineLines.some((l) => l.kind === 'info' && /Refining the saved automation/.test(l.text)) &&
    refineLines.some((l) => l.kind === 'info' && /Your note: I only want the article text/.test(l.text)), JSON.stringify(refineLines));
  check('refine: verified and updated', refineLines.some((l) => l.kind === 'saved' && /Automation updated/.test(l.text)), JSON.stringify(refineLines));
  const refinePack = llmRequests.map((r) => JSON.stringify(r)).find((r) => r.includes('MODE: REFINE')) ?? '';
  check('refine: model saw the current script, the last run and the note',
    refinePack.includes('prop=info') && refinePack.includes('1 row(s)') && refinePack.includes('I only want the article text'));
  const refined = readSpec('wikiold');
  check('refine: provenance records the mode and the note',
    refined.repaired?.mode === 'refine' && refined.repaired?.feedback === 'I only want the article text' && readScript('wikiold') === ARTICLE_FULL,
    JSON.stringify(refined.repaired));
  const refinedPage = await fetch(`${BACKEND}/session/wikiold`).then((r) => r.text());
  check('refine: session page shows the refinement provenance', refinedPage.includes('Refined by the LLM repair assistant'));

  // Scenario 6: server-rendered results — the script drives the browser.
  const ssrStop = await record('ssr', ssrEvents());
  check('server-rendered recording refuses deterministically', ssrStop.spec === false);
  const ssrLines = await repair('ssr');
  check('open_page evaluated in the page and reached the model',
    ssrLines.some((l) => l.kind === 'tool' && /^open_page/.test(l.text)) && JSON.stringify(llmRequests.at(-1)).includes('Awal Trading Co. W.L.L 139867'),
    JSON.stringify(ssrLines));
  check('browser script verified and saved', kinds(ssrLines).includes('saved'), JSON.stringify(ssrLines));
  const ssrRun = await api('/api/sessions/ssr/run', { params: { query: 'gulf' } });
  check('browser script replays a new input',
    ssrRun.ok && ssrRun.extracted?.records?.rows?.[0]?.name === 'Gulf Line Logistics' && ssrRun.extracted.records.rows[0].cr === '20775',
    ssrRun.stoppedReason ?? JSON.stringify(ssrRun));

  // Scenario 7: nothing typed but something marked — a zero-parameter listing.
  await record('zeroparam', [
    { kind: 'session_start', seq: 0 },
    { kind: 'page', url: `${SITE}/companies`, lang: 'en', seq: 1 },
    { kind: 'action', action: 'mark', text: 'Delmon Trading W.L.L', target: { selector: '#c2' }, seq: 2 },
    { kind: 'session_stop', seq: 3 },
  ]);
  const zeroLines = await repair('zeroparam');
  check('zero-parameter automation accepted on its mark', kinds(zeroLines).includes('saved') && readSpec('zeroparam').parameters.length === 0, JSON.stringify(zeroLines));
  const zeroRun = await api('/api/sessions/zeroparam/run', { params: {} });
  check('zero-parameter automation runs', zeroRun.ok && zeroRun.extracted?.records?.count === 3, zeroRun.stoppedReason ?? JSON.stringify(zeroRun));

  // Scenario 8: an honest give-up leaves no spec.
  await record('giveup', jsonpEvents());
  const giveLines = await repair('giveup');
  check('give_up ends with advice and no spec',
    giveLines.some((l) => l.kind === 'advice' && /Re-record on a page/.test(l.text)) && !existsSync(join(dataDir, 'giveup', 'spec.json')), JSON.stringify(giveLines));

  // Scenario 8b: a token-gated API (the Sijilat shape). The deterministic
  // spec carries a token step; set_columns keeps it and narrows the fields;
  // a script reaches the same API only with the bearer the site mints.
  await wait(`${TOK}/tokened/`);
  const gatedBody = await fetch(`${TOK}/tokened/api/search`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${FAKE_JWT}` }, body: '{"q":"gum"}' }).then((r) => r.text());
  const gatedStop = await record('gated', [
    { kind: 'session_start', seq: 0 },
    { kind: 'page', url: `${TOK}/tokened/`, lang: 'en', seq: 1 },
    { kind: 'action', action: 'input', value: 'gum', target: { id: 'q' }, seq: 2 },
    { kind: 'net', api: 'fetch', method: 'POST', url: `${TOK}/tokened/api/search`, status: 200, contentType: 'application/json', reqBody: '{"q":"gum"}', resBody: gatedBody, seq: 3 },
    { kind: 'session_stop', seq: 4 },
  ]);
  const gatedSpec = readSpec('gated');
  check('gated: deterministic spec with a token step', gatedStop.spec !== false && gatedSpec.steps.some((st) => st.type === 'browser-token'), JSON.stringify(gatedSpec.steps));
  const gatedCols = await repair('gated', { feedback: 'only the name and the city', lastRun: { params: { query: 'gum' }, ok: true, rowCount: 8, columns: ['id', 'name', 'city', 'active', 'tags', 'notes'] } });
  check('gated: set_columns verified by running the saved automation and saved',
    gatedCols.some((l) => l.kind === 'ok' && /fields name, city/.test(l.text)) && gatedCols.some((l) => l.kind === 'saved' && /now returns name, city/.test(l.text)), JSON.stringify(gatedCols));
  const gatedAfter = readSpec('gated');
  check('gated: spec kept its token step, gained the columns and refine provenance',
    gatedAfter.steps.some((st) => st.type === 'browser-token') && gatedAfter.outcome.columns?.length === 2 && gatedAfter.repaired?.mode === 'refine', JSON.stringify(gatedAfter.outcome));
  check('gated: the model was told how a script reaches the token',
    JSON.stringify(llmRequests.at(-1)).includes('ctx.site.token(') && JSON.stringify(llmRequests.at(-1)).includes('use set_columns'));
  const gatedRun = await api('/api/sessions/gated/run', { params: { query: 'gulf' } });
  check('gated: narrowed run returns only the chosen fields',
    gatedRun.ok && JSON.stringify(Object.keys(gatedRun.extracted?.records?.rows?.[0] ?? {})) === '["name","city"]', gatedRun.stoppedReason ?? JSON.stringify(gatedRun));
  const gatedScript = await repair('gated', { feedback: 'rewrite it as a script', lastRun: { params: { query: 'gum' }, ok: true, rowCount: 8, columns: ['name', 'city'] } });
  check('gated: a forged bearer is dropped and the attempt fails',
    gatedScript.filter((l) => l.kind === 'try').length === 2 && gatedScript.some((l) => l.kind === 'fail'), JSON.stringify(gatedScript));
  check('gated: the site\'s own bearer is accepted', gatedScript.some((l) => l.kind === 'saved') && readScript('gated').includes('ctx.site.token'), JSON.stringify(gatedScript));
  const gatedScriptRun = await api('/api/sessions/gated/run', { params: { query: 'gulf' } });
  check('gated: the script replays through the token',
    gatedScriptRun.ok && gatedScriptRun.steps[0].type === 'script' && gatedScriptRun.extracted?.records?.rows?.[0]?.name === 'Gulf Gum Trading', gatedScriptRun.stoppedReason ?? JSON.stringify(gatedScriptRun));

  // Scenario 8c: the operator stops a repair while the model call is in
  // flight. The loop ends on its own stream, with the spend, saving nothing.
  await record('stopme', jsonpEvents());
  const idle = await api('/api/sessions/stopme/repair/stop', {});
  check('stop with nothing running says so', idle.stopped === false, JSON.stringify(idle));
  const stopping = repair('stopme');
  await new Promise((r) => setTimeout(r, 600));
  const second = await fetch(`${BACKEND}/api/sessions/stopme/repair`, { method: 'POST' });
  check('a second repair of the same session is refused while one runs', second.status === 409, String(second.status));
  const t0 = Date.now();
  const stopAck = await api('/api/sessions/stopme/repair/stop', {});
  const stopLines = await stopping;
  check('stop aborts the in-flight model call promptly', stopAck.stopped === true && Date.now() - t0 < 3000, `${Date.now() - t0}ms`);
  check('stopped repair ends with a named line, the spend, and no spec',
    stopLines.some((l) => l.kind === 'done' && /^Stopped by the operator\.$/.test(l.text)) &&
    stopLines.some((l) => l.kind === 'info' && /Spend this repair/.test(l.text)) &&
    !existsSync(join(dataDir, 'stopme', 'spec.json')), JSON.stringify(stopLines.slice(-3)));
  const stopPage = await fetch(`${BACKEND}/session/stopme`).then((r) => r.text());
  check('session page carries the Stop control', stopPage.includes("stop.textContent = 'Stop'") && stopPage.includes('/repair/stop'));
  check('session page scripts parse (stop control)', scriptsCompile(stopPage) === '', scriptsCompile(stopPage));

  // Scenario 9: a model that never stops investigating hits the budget.
  await record('loop', jsonpEvents());
  const loopLines = await repair('loop');
  check('runaway investigation is ended by the loop budget',
    loopLines.some((l) => l.kind === 'done' && /No working automation found after 16 turns/.test(l.text)) && !existsSync(join(dataDir, 'loop', 'spec.json')),
    JSON.stringify(loopLines.slice(-3)));
  check('tool budget message reached the model, parallel calls counted',
    JSON.stringify(llmRequests.at(-1)).includes('Tool budget exhausted'));
  check('an identical call is refused from its third repetition',
    JSON.stringify(llmRequests.at(-1)).includes('already made this exact call') && loopLines.filter((l) => l.kind === 'tool').length === 4,
    String(loopLines.filter((l) => l.kind === 'tool').length));
} catch (err) {
  check('harness ran to completion', false, String(err));
} finally {
  backend.kill();
  sites.kill();
  site.close();
  llm.close();
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASS');
process.exit(failures.length ? 1 : 0);
