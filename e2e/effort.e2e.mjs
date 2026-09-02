// Maximum Effort Mode suite. A scripted mock model stands in for the API
// (streaming wire format, thinking blocks included) and a mini shop renders
// its listings server-side, so the recording holds no API call at all: only
// the pages the operator saw. Proves the loop reads snapshots, talks to the
// operator and waits for the reply, streams its thinking, rejects a script
// that bakes in a typed value or returns rows the operator never saw,
// accepts one that reproduces the final page, saves it with the declared
// parameters and the goal, replays it for new inputs, keeps the
// conversation on disk, and stops when told.
// Run: node e2e/effort.e2e.mjs
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Script } from 'node:vm';
import { join } from 'node:path';

const BACKEND_PORT = 4895;
const LLM_PORT = 4993;
const SITE_PORT = 4995;
const BACKEND = `http://127.0.0.1:${BACKEND_PORT}`;
const SITE = `http://127.0.0.1:${SITE_PORT}`;

const failures = [];
function check(name, cond, detail = '') {
  console.log(`${cond ? '  ok ' : 'FAIL'} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) failures.push(name);
}
async function wait(u) { for (let i = 0; i < 60; i++) { try { if ((await fetch(u)).ok) return; } catch {} await new Promise((r) => setTimeout(r, 150)); } throw new Error('timeout ' + u); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

// --- mini shop -----------------------------------------------------------------
// Server-rendered listings, filtered by a query and a minimum price, newest
// first. Nothing here answers as JSON.
const ITEMS = [
  { id: 101, title: 'CalDigit Element Hub', price: 189, kind: 'hub' },
  { id: 102, title: 'Anker 7-in-1 Hub', price: 45, kind: 'hub' },
  { id: 103, title: 'OWC Thunderbolt Hub', price: 129, kind: 'hub' },
  { id: 104, title: 'Satechi Slim Hub', price: 60, kind: 'hub' },
  { id: 105, title: 'Plugable Mini Hub', price: 25, kind: 'hub' },
  { id: 201, title: 'Dell Universal Dock', price: 210, kind: 'dock' },
  { id: 202, title: 'Kensington Dock', price: 95, kind: 'dock' },
];
function listing(q, min) {
  const hits = ITEMS.filter((i) => i.kind.includes(q.toLowerCase()) && i.price >= min).sort((a, b) => b.id - a.id);
  return `<!doctype html><html><body><h1>Shop</h1><form><input id="search" aria-label="Search" value="${q}"><input id="min" aria-label="Minimum price" value="${min || ''}"></form>
<ul id="results">${hits.map((i) => `<li class="item"><a class="t" href="${SITE}/p/${i.id}">${i.title}</a> <span class="p">$${i.price}</span></li>`).join('')}</ul>
<p>${hits.length} results</p><script>window.__tracking = 1;</script></body></html>`;
}
const site = createServer((req, res) => {
  const url = new URL(req.url, SITE);
  res.writeHead(200, { 'content-type': 'text/html' });
  if (url.pathname === '/shop') { res.end(listing(url.searchParams.get('q') ?? '', Number(url.searchParams.get('min') ?? 0))); return; }
  res.end('<html><body><h1>Shop</h1><form><input id="search" aria-label="Search"></form></body></html>');
});
site.listen(SITE_PORT);

// What the recorder would have captured on those pages: visible text and the
// pruned DOM (no script tag).
const textOf = (html) => html.replace(/<script>[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const domOf = (html) => html.replace(/<script>[\s\S]*?<\/script>/g, '').replace(/<!doctype html><html><body>|<\/body><\/html>/g, '');

// --- mock model ------------------------------------------------------------------
let toolSeq = 0;
const text = (t) => ({ type: 'text', text: t });
const think = (t) => ({ type: 'thinking', thinking: t });
const tool = (name, input) => ({ type: 'tool_use', id: `toolu_${++toolSeq}`, name, input });

const GOOD = `async function run(ctx) {
  const res = await ctx.http.fetch('${SITE}/shop?q=' + encodeURIComponent(ctx.inputs.query) + '&min=' + encodeURIComponent(ctx.inputs.min_price) + '&sort=new');
  const page = await ctx.dom(res.text);
  const rows = await page.eval("[...document.querySelectorAll('li.item')].slice(0, 3).map((li) => ({ title: li.querySelector('.t').textContent, price: li.querySelector('.p').textContent, link: li.querySelector('.t').getAttribute('href') }))");
  await page.close();
  return rows;
}`;
const BAKED = GOOD.replace('encodeURIComponent(ctx.inputs.query)', "'hub'");
const UNSEEN = `async function run(ctx) {
  const res = await ctx.http.fetch('${SITE}/shop?q=' + encodeURIComponent(ctx.inputs.query) + '&min=' + encodeURIComponent(ctx.inputs.min_price));
  return [{ id: 'row-' + res.status }];
}`;
const PARAMS = [{ name: 'query', example: 'hub', description: 'search text' }, { name: 'min_price', example: '50' }];

const scripts = [
  // --- shop: read the last page, ask, get the answer, think, probe, fail lint, succeed, report.
  [text('Looking at the last page you saw.'), tool('read_snapshot', {})],
  [text('The final page lists five hubs at $50 and above, newest first. Do you want every listing on that page, or only the first few?')],
  [think('Three rows: title, price, link. The listing is server-rendered, so fetch the page and parse it.'), tool('probe', { method: 'GET', url: `${SITE}/shop?q=hub&min=50&sort=new` })],
  [tool('write_script', { source: BAKED, title: 'Shop Listings', summary: 'Fetches the listing page and reads the first three items.', parameters: [{ name: 'min_price', example: '50' }] })],
  [tool('write_script', { source: GOOD, title: 'Shop Listings', summary: 'Fetches the listing page for the query and minimum price, newest first, and returns the first three items with a link each.', parameters: PARAMS })],
  [text('Saved. It takes a query and a minimum price, fetches the listing sorted newest first, and returns the first three items with title, price and link.')],
  // --- unseen: rows the operator never saw are refused; then an honest give-up.
  [tool('write_script', { source: UNSEEN, title: 'Ids', summary: 'Returns ids.', parameters: PARAMS })],
  [tool('give_up', { reason: 'The listing has no stable data.', advice: 'Record with the results visible.' })],
];
const FOREVER = () => [tool('probe', { method: 'GET', url: `${SITE}/shop?q=x` })];

const llmRequests = [];
function sse(res, blocks) {
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  send('message_start', { type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      // Two deltas: the page must join them into one bubble.
      const half = Math.ceil(b.text.length / 2);
      send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text.slice(0, half) } });
      send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text.slice(half) } });
    } else if (b.type === 'thinking') {
      send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: b.thinking } });
      send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'sig' } });
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
    sse(res, scripts.shift() ?? FOREVER());
  });
});
llm.listen(LLM_PORT);

const dataDir = mkdtempSync(join(tmpdir(), 'wfr-effort-'));
const backend = spawn(process.execPath, ['--import', 'tsx', 'backend/src/server.ts'], {
  cwd: process.cwd(),
  env: { ...process.env, DATA_DIR: dataDir, PORT: String(BACKEND_PORT), ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${LLM_PORT}` },
  stdio: 'ignore',
});

// --- the recording -------------------------------------------------------------
// Search "hub", see the list, set a minimum price of 50, apply, see the
// filtered list, stop. No captured API call: the outcome lives in the pages.
const FIRST = listing('hub', 0);
const FINAL = listing('hub', 50);
const shopEvents = () => [
  { kind: 'session_start', seq: 0 },
  { kind: 'page', url: `${SITE}/`, title: 'Shop', lang: 'en', seq: 1 },
  { kind: 'action', action: 'input', value: 'hub', target: { tag: 'input', id: 'search', selector: '#search', aria: 'Search' }, seq: 2 },
  { kind: 'action', action: 'enter', target: { tag: 'input', id: 'search', selector: '#search' }, seq: 3 },
  { kind: 'nav', url: `${SITE}/shop?q=hub`, transition: 'form_submit', seq: 4 },
  { kind: 'page', url: `${SITE}/shop?q=hub`, title: 'Shop', lang: 'en', seq: 5 },
  { kind: 'snapshot', reason: 'load', url: `${SITE}/shop?q=hub`, title: 'Shop', text: textOf(FIRST), html: domOf(FIRST), seq: 6 },
  { kind: 'action', action: 'input', value: '50', target: { tag: 'input', id: 'min', selector: '#min', aria: 'Minimum price' }, seq: 7 },
  { kind: 'action', action: 'click', target: { tag: 'button', selector: 'form > button', text: 'Apply' }, seq: 8 },
  { kind: 'nav', url: `${SITE}/shop?q=hub&min=50&sort=new`, transition: 'form_submit', seq: 9 },
  { kind: 'page', url: `${SITE}/shop?q=hub&min=50&sort=new`, title: 'Shop', lang: 'en', seq: 10 },
  { kind: 'snapshot', reason: 'load', url: `${SITE}/shop?q=hub&min=50&sort=new`, title: 'Shop', text: textOf(FINAL), html: domOf(FINAL), seq: 11 },
  { kind: 'snapshot', reason: 'stop', url: `${SITE}/shop?q=hub&min=50&sort=new`, title: 'Shop', text: textOf(FINAL), html: domOf(FINAL), seq: 12 },
  { kind: 'session_stop', seq: 13 },
];

async function record(session, events) {
  await api('/api/sessions', { session, hosts: ['127.0.0.1'], startedAt: 1 });
  await api(`/api/sessions/${session}/events`, { items: events });
  return api(`/api/sessions/${session}/stop`, {});
}
// Reads the stream line by line as it arrives, so the test can react (reply,
// stop) the way the operator would.
function effort(session, goal, onLine) {
  return fetch(`${BACKEND}/api/sessions/${session}/effort`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal }),
  }).then(async (r) => {
    const lines = [];
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!l) continue;
        const e = JSON.parse(l);
        lines.push(e);
        onLine?.(e, lines);
      }
    }
    return lines;
  });
}
function scriptsCompile(html) {
  for (const [, src] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    try { new Script(src); } catch (e) { return `inline script does not parse: ${e.message}`; }
  }
  return '';
}
const readSpec = (session) => JSON.parse(readFileSync(join(dataDir, session, 'spec.json'), 'utf8'));
const readMeta = (session) => JSON.parse(readFileSync(join(dataDir, session, 'meta.json'), 'utf8'));
const readLog = (session) => readFileSync(join(dataDir, session, 'effort.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const kinds = (lines) => lines.map((l) => l.kind);
const GOAL = 'the top 3 listings on the final page with title, price and a link to each';

try {
  await wait(`${BACKEND}/health`);
  await wait(`${SITE}/`);

  // Scenario 1: the shop recording, start to finish, with a reply and a stop.
  const stop = await record('shop', shopEvents());
  check('server-rendered recording refuses deterministically', stop.spec === false);
  const idle = await api('/api/sessions/shop/effort/say', { text: 'hello?' });
  check('a message with nothing running is refused', /not running/.test(idle.error ?? ''), JSON.stringify(idle));

  let replied = false;
  let stoppedAt = 0;
  let awaits = 0;
  const run = effort('shop', GOAL, async (e) => {
    if (e.kind !== 'await') return;
    awaits++;
    if (!replied) {
      replied = true;
      const second = await fetch(`${BACKEND}/api/sessions/shop/effort`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      check('a second start while one runs is refused', second.status === 409, String(second.status));
      const ack = await api('/api/sessions/shop/effort/say', { text: 'Just the first 3, with links.' });
      check('the operator\'s reply is accepted while the model waits', ack.ok === true, JSON.stringify(ack));
    } else {
      stoppedAt = Date.now();
      await api('/api/sessions/shop/effort/stop', {});
    }
  });
  const lines = await run;
  const k = kinds(lines);
  check('the goal is shown as the operator\'s first message', lines.some((l) => l.kind === 'you' && l.text === GOAL));
  check('the snapshot count is reported', lines.some((l) => l.kind === 'info' && /3 page snapshot\(s\)/.test(l.text)), JSON.stringify(lines.filter((l) => l.kind === 'info')));
  check('read_snapshot shown and the final page reached the model',
    lines.some((l) => l.kind === 'tool' && /^read_snapshot last page text/.test(l.text)) &&
    JSON.stringify(llmRequests[1]).includes('CalDigit Element Hub $189') && JSON.stringify(llmRequests[1]).includes('3 results'),
    JSON.stringify(lines.filter((l) => l.kind === 'tool')));
  check('prose is streamed as deltas and closed per block',
    lines.filter((l) => l.kind === 'say' && l.delta).length >= 4 && lines.filter((l) => l.kind === 'block' && l.text === 'say').length >= 3);
  check('thinking is streamed', lines.some((l) => l.kind === 'block' && l.text === 'think') && lines.some((l) => l.kind === 'think' && l.delta && /server-rendered/.test(l.text)));
  const awaitIdx = k.indexOf('await');
  const youIdx = lines.findIndex((l) => l.kind === 'you' && /first 3/.test(l.text));
  check('the model hands over, waits, and the reply is echoed after the wait', awaitIdx > 0 && youIdx > awaitIdx, `${awaitIdx} ${youIdx}`);
  check('the reply reached the model as the next user message',
    JSON.stringify(llmRequests[2]?.messages?.at(-1) ?? {}).includes('Just the first 3, with links.'), JSON.stringify(llmRequests[2]?.messages?.at(-1)).slice(0, 200));
  check('a baked-in typed value is rejected by name',
    lines.some((l) => l.kind === 'fail' && /typed value "hub" is hard-coded/.test(l.text)), JSON.stringify(lines.filter((l) => l.kind === 'fail')));
  check('the parameterised script is verified against the snapshots and saved',
    lines.some((l) => l.kind === 'ok' && /3 of 3 row\(s\) carry text the operator saw/.test(l.text)) &&
    lines.some((l) => l.kind === 'saved' && /parameters query, min_price/.test(l.text)), JSON.stringify(lines.filter((l) => ['ok', 'saved'].includes(l.kind))));
  check('the model was told it was accepted and asked to report',
    JSON.stringify(llmRequests[5]?.messages?.at(-1) ?? {}).includes('ACCEPTED and saved'));
  check('stop while the model waits ends promptly with the automation kept',
    awaits === 2 && lines.some((l) => l.kind === 'done' && /Stopped by the operator\. The saved automation stands\./.test(l.text)) && Date.now() - stoppedAt < 3000,
    JSON.stringify(lines.slice(-3)));
  check('spend is reported', lines.some((l) => l.kind === 'info' && /^Spend:/.test(l.text)));

  const spec = readSpec('shop');
  check('spec: script step, declared parameters, effort provenance with the goal',
    spec.steps[0].type === 'script' && JSON.stringify(spec.parameters.map((p) => p.name)) === '["query","min_price"]' &&
    spec.repaired?.mode === 'effort' && spec.repaired.feedback === GOAL && JSON.stringify(spec.steps[0].hosts) === '["127.0.0.1"]',
    JSON.stringify({ steps: spec.steps, parameters: spec.parameters, repaired: spec.repaired }));
  const meta = readMeta('shop');
  check('meta carries the goal and the title', meta.goal === GOAL && meta.name === 'Shop Listings', JSON.stringify(meta));
  const replay = await api('/api/sessions/shop/run', { params: { query: 'dock', min_price: '100' } });
  check('the automation replays new inputs through a parsed page',
    replay.ok && replay.extracted?.records?.rows?.length === 1 && replay.extracted.records.rows[0].title === 'Dell Universal Dock' && /\/p\/201$/.test(replay.extracted.records.rows[0].link),
    replay.stoppedReason ?? JSON.stringify(replay.extracted));
  const log = readLog('shop');
  check('the conversation is kept on disk, deltas joined per block',
    log[0]?.kind === 'start' && log.some((l) => l.kind === 'think' && /server-rendered/.test(l.text)) &&
    log.some((l) => l.kind === 'say' && /^The final page lists five hubs/.test(l.text)) && !log.some((l) => l.delta) &&
    log.some((l) => l.kind === 'you' && /first 3/.test(l.text)) && log.some((l) => l.kind === 'saved'),
    JSON.stringify(log.map((l) => l.kind)));
  const page = await fetch(`${BACKEND}/session/shop`).then((r) => r.text());
  check('session page shows the mode, its provenance, and the past conversation',
    page.includes('Maximum Effort Mode') && page.includes('Built in Maximum Effort Mode') && page.includes('The final page lists five hubs') && page.includes('Start again') && page.includes(GOAL));
  check('session page scripts parse', scriptsCompile(page) === '', scriptsCompile(page));
  const pack = llmRequests[0]?.messages?.[0]?.content?.[0]?.text ?? '';
  check('the pack showed the route, the snapshots and the typed labels',
    pack.includes('same page, query changed: min=50 sort=new') && pack.includes('#12 (stop)') && pack.includes('label="Minimum price"') &&
    pack.includes(GOAL) && JSON.stringify(llmRequests[0].tools).includes('read_snapshot'), pack.slice(0, 1500));

  // Scenario 2: rows the operator never saw are refused; give_up ends honestly.
  await record('unseen', shopEvents());
  const unseen = await effort('unseen', 'ids only');
  check('rows carrying nothing the operator saw are rejected',
    unseen.some((l) => l.kind === 'fail' && /no row carries anything the operator saw/.test(l.text)), JSON.stringify(unseen.filter((l) => l.kind === 'fail')));
  check('give_up ends with advice and no spec',
    unseen.some((l) => l.kind === 'advice' && /Record with the results visible/.test(l.text)) && unseen.some((l) => l.kind === 'done' && /No automation is possible/.test(l.text)) &&
    !existsSync(join(dataDir, 'unseen', 'spec.json')), JSON.stringify(unseen.slice(-3)));
  const refusalPage = await fetch(`${BACKEND}/session/unseen`).then((r) => r.text());
  check('refused session page points at Maximum Effort Mode and parses',
    refusalPage.includes('href="#effort"') && !refusalPage.includes('Begin LLM repair') && scriptsCompile(refusalPage) === '', scriptsCompile(refusalPage));
} catch (err) {
  check('harness ran to completion', false, String(err));
} finally {
  backend.kill();
  site.close();
  llm.close();
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASS');
process.exit(failures.length ? 1 : 0);
