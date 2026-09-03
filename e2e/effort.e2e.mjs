// Maximum Effort Mode suite. A scripted mock model stands in for the API
// (streaming wire format, thinking blocks included) and a mini shop renders
// its listings server-side, so the recording holds no API call at all: only
// the pages the operator saw. Proves the loop reads snapshots, talks to the
// operator and waits for the reply, streams its thinking, rejects a script
// that bakes in a typed value or returns rows the operator never saw,
// accepts one that reproduces the final page, saves it with the declared
// parameters and the goal, replays it for new inputs, keeps the
// conversation on disk, and stops when told. Then the bring-your-own-model
// route: the exported brief carries the whole recording within a budget,
// an answer pasted back is held to the same acceptance (page route and
// CLI), and the site's robots.txt is reported, never enforced.
// Run: node e2e/effort.e2e.mjs
import { createServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

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
  if (url.pathname === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('User-agent: *\nDisallow: /shop\nDisallow: /private/\n'); return; }
  // Pages a plain fetch cannot have: a wall, a challenge, and one that bounces
  // to a sign-in.
  if (url.pathname === '/walled') { res.writeHead(403, { 'content-type': 'text/html' }); res.end('<html><body><h1>Forbidden</h1></body></html>'); return; }
  if (url.pathname === '/challenge') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><body><h1>Just a moment…</h1><p>Checking your browser before you proceed.</p></body></html>'); return; }
  if (url.pathname === '/members') { res.writeHead(302, { location: `${SITE}/login?returnUrl=/members` }); res.end(); return; }
  if (url.pathname === '/login') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><body><h1>Sign in</h1></body></html>'); return; }
  // The listing as an API, gated the way a site gates its own.
  if (url.pathname === '/api/gated') {
    if (!req.headers.authorization) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"unauthorized"}'); return; }
    const q = url.searchParams.get('q') ?? '';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: ITEMS.filter((i) => i.kind.includes(q)).map((i) => ({ name: i.title, price: i.price })) }));
    return;
  }
  // What the recorder cannot capture: data pulled in through a <script> tag.
  if (url.pathname === '/jsonp') {
    res.writeHead(200, { 'content-type': 'application/javascript' });
    res.end(`${url.searchParams.get('callback') ?? 'cb'}(${JSON.stringify({ q: url.searchParams.get('q'), suggestions: ITEMS.slice(0, 2).map((i) => i.title) })});`);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  if (url.pathname === '/shop') { res.end(listing(url.searchParams.get('q') ?? '', Number(url.searchParams.get('min') ?? 0))); return; }
  res.end('<html><body><h1>Shop</h1><form><input id="search" aria-label="Search"></form></body></html>');
});
site.listen(SITE_PORT);

// What the recorder would have captured on those pages: visible text and the
// pruned DOM (no script tag).
// innerText puts each block on its own line; the fixture's text must too,
// or the brief's fetch check has nothing line-shaped to look for.
const textOf = (html) => html.replace(/<script>[\s\S]*?<\/script>/g, '').replace(/<\/(li|h1|p|form)>/g, '\n').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
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
// The same script under the generator's own names (search, min): what a
// bare script without a JSON block is held to.
const PLAIN = GOOD.replace('ctx.inputs.query', 'ctx.inputs.search').replace('ctx.inputs.min_price', 'ctx.inputs.min');

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
    // A port probe from another suite runner arrives with no body; it must
    // not bring this run down.
    if (!body) { res.writeHead(400).end(); return; }
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
    page.includes('Maximum Effort Mode') && page.includes('Built in Maximum Effort Mode') && page.includes('The final page lists five hubs') && page.includes('Export brief') && page.includes(GOAL));
  check('session page scripts parse', scriptsCompile(page) === '', scriptsCompile(page));
  const pack = llmRequests[0]?.messages?.[0]?.content?.[0]?.text ?? '';
  check('the pack showed the route, the snapshots and the typed labels',
    pack.includes('same page, query changed: min=50 sort=new') && pack.includes('#12 (stop)') && pack.includes('label="Minimum price"') &&
    pack.includes(GOAL) && JSON.stringify(llmRequests[0].tools).includes('read_snapshot'), pack.slice(0, 1500));

  // Scenario 3: bring your own model. The brief carries the goal, the rules,
  // the answer format and the evidence; a budget cuts and says so; the
  // answer pasted back passes the same acceptance as the loop, by page route
  // and by CLI; robots.txt is reported on the saved automation.
  const noise = JSON.stringify(Array.from({ length: 900 }, (_, i) => ({ id: i, name: `noise item ${i}`, note: 'x'.repeat(80) })));
  const byomEvents = shopEvents();
  byomEvents.splice(-1, 0, { kind: 'net', method: 'GET', url: `${SITE}/api/noise`, status: 200, contentType: 'application/json', resHeaders: { 'x-total-count': '900' }, resBody: noise, seq: 13 });
  byomEvents[byomEvents.length - 1].seq = 14;
  const byomStop = await record('byom', byomEvents);
  check('byom: refused deterministically before any brief', byomStop.spec === false);
  const fresh = await fetch(`${BACKEND}/session/byom`).then((r) => r.text());
  check('byom: paste box hidden until a brief exists', fresh.includes('id="import-block" hidden') && fresh.includes('Export brief') && fresh.includes('Chat-sized'));

  const briefRes = await fetch(`${BACKEND}/api/sessions/byom/brief`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: GOAL }) });
  const brief = await briefRes.text();
  check('brief: served as a markdown download', briefRes.status === 200 && /text\/markdown/.test(briefRes.headers.get('content-type') ?? '') && /filename="byom-brief.md"/.test(briefRes.headers.get('content-disposition') ?? ''), `${briefRes.status} ${briefRes.headers.get('content-type')}`);
  check('brief: goal, contract, acceptance rules and answer format',
    brief.includes(`## Goal\n\n${GOAL}`) && brief.includes('ctx.dom(html)') && brief.includes('## Acceptance') && brief.includes('"source": "async function run(ctx) { ... }"') && brief.includes('npm run verify -- byom'));
  check('brief: route, typed values with labels and suggested names, analyser verdict flagged',
    brief.includes('same page, query changed: min=50 sort=new') && /"50" into .*\(label "Minimum price"\) → suggested parameter name `min`/.test(brief) && brief.includes('(a guess'), brief.match(/### Values the operator typed[\s\S]{0,300}/)?.[0]);
  check('brief: every snapshot text in full and the last page HTML',
    brief.includes('### Snapshot #6 (load)') && brief.includes('### Snapshot #12 (stop)') && brief.includes('CalDigit Element Hub $189') && brief.includes('### Snapshot #12 — pruned HTML') && brief.includes('<li class="item">'));
  check('brief: plain-fetch check says the listing is server-rendered and names the robots rule',
    /→ HTTP 200 text\/html, \d+ chars; \d+ of \d+ visible lines from the snapshot present → the content is in the plain response/.test(brief) && brief.includes('robots.txt disallows /shop for all agents') && brief.includes('### The last page as a plain fetch returns it'),
    brief.match(/### What a plain HTTP fetch[\s\S]{0,600}/)?.[0]);
  check('brief: captured call in full with its response headers, nothing cut at the default budget',
    brief.includes('#### #13 GET ' + SITE + '/api/noise → 200 application/json') && brief.includes('"x-total-count":"900"') && brief.includes('noise item 899') && brief.includes('Nothing: the whole recording fit'));
  check('brief: goal persisted, BRIEF.md written, export stamped',
    readMeta('byom').goal === GOAL && readMeta('byom').briefAt > 0 && existsSync(join(dataDir, 'byom', 'BRIEF.md')) && readFileSync(join(dataDir, 'byom', 'BRIEF.md'), 'utf8') === brief);
  const small = await fetch(`${BACKEND}/api/sessions/byom/brief?budget=70000&probe=0`).then((r) => r.text());
  check('brief: a budget cuts the least valuable evidence and says so; probe=0 skips the fetch',
    small.length <= 70000 && small.includes('## Left out by the budget') && /call #13 GET .*: (cut at|left out entirely)/.test(small) && small.includes('CalDigit Element Hub $189') && small.includes('Not checked (export with ?probe=0'),
    `${small.length} ${small.match(/## Left out by the budget[\s\S]{0,300}/)?.[0]}`);
  const exported = await fetch(`${BACKEND}/session/byom`).then((r) => r.text());
  check('byom: paste box shown once a brief exists and the page scripts parse', exported.includes('<div id="import-block">') && scriptsCompile(exported) === '', scriptsCompile(exported));

  const importAnswer = (text) => fetch(`${BACKEND}/api/sessions/byom/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
  const nothing = await importAnswer('I could not work it out, sorry.');
  check('import: a reply with no answer in it is refused with instructions', nothing.status === 422 && /REJECTED: no answer found/.test(nothing.body.error), JSON.stringify(nothing.body));
  const baked = await importAnswer('Here you go:\n```json\n' + JSON.stringify({ title: 'Baked', summary: 's', parameters: [{ name: 'min_price', example: '50' }], fixed: [], source: BAKED }) + '\n```\n');
  check('import: a baked-in typed value is refused with the loop\'s own wording', baked.status === 422 && /^REJECTED: lint: .*typed value "hub" is hard-coded/.test(baked.body.error), JSON.stringify(baked.body));
  const bareWrong = await importAnswer('```js\n' + GOOD + '\n```');
  check('import: a bare script is held to the typed values under the generator\'s names', bareWrong.status === 422 && /never reads inputs\.search/.test(bareWrong.body.error), JSON.stringify(bareWrong.body));
  const bareOk = await importAnswer(PLAIN);
  check('import: a bare script that reads them is verified and saved', bareOk.status === 200 && bareOk.body.ok && /^Automation saved — 3 of 3 row\(s\) carry text the operator saw/.test(bareOk.body.text) && JSON.stringify(bareOk.body.parameters) === '["search","min"]', JSON.stringify(bareOk.body));
  check('import: robots.txt reported, not enforced', bareOk.body.robots?.length === 1 && /robots\.txt on 127\.0\.0\.1:\d+ disallows \/shop for all agents; this automation fetches/.test(bareOk.body.robots[0]) && readSpec('byom').steps[0].robots?.length === 1, JSON.stringify(bareOk.body.robots));
  const answer = 'Here is the automation.\n\n```json\n' + JSON.stringify({ title: 'Shop Listings BYOM', summary: 'Fetches the listing page for the query and minimum price, newest first, and returns the first three items.', parameters: PARAMS, fixed: [], source: GOOD }, null, 2) + '\n```\n\nIt takes a query and a minimum price.';
  const good = await importAnswer(answer);
  check('import: the JSON block inside a whole reply is verified and saved with its title',
    good.status === 200 && /saved as "Shop Listings BYOM"/.test(good.body.text) && JSON.stringify(good.body.parameters) === '["query","min_price"]', JSON.stringify(good.body));
  const byomSpec = readSpec('byom');
  check('import: spec carries external provenance, the goal and the declared parameters',
    byomSpec.repaired?.mode === 'import' && byomSpec.repaired.model === 'external' && byomSpec.repaired.feedback === GOAL && byomSpec.steps[0].type === 'script' && JSON.stringify(byomSpec.parameters.map((p) => p.name)) === '["query","min_price"]' && readMeta('byom').name === 'Shop Listings BYOM',
    JSON.stringify({ repaired: byomSpec.repaired, parameters: byomSpec.parameters }));
  const byomReplay = await api('/api/sessions/byom/run', { params: { query: 'dock', min_price: '100' } });
  check('import: the saved automation replays new inputs', byomReplay.ok && byomReplay.extracted?.records?.rows?.[0]?.title === 'Dell Universal Dock', byomReplay.stoppedReason ?? JSON.stringify(byomReplay.extracted));
  const byomLog = readLog('byom');
  check('import: both outcomes are logged for the page',
    byomLog.filter((l) => l.kind === 'fail').length === 2 && byomLog.filter((l) => l.kind === 'saved').length === 2 && byomLog.some((l) => l.kind === 'info' && /imported for verification: "Shop Listings BYOM"/.test(l.text)) && !byomLog.some((l) => l.kind === 'start'),
    JSON.stringify(byomLog.map((l) => l.kind)));
  const byomPage = await fetch(`${BACKEND}/session/byom`).then((r) => r.text());
  check('import: session page shows the external provenance, the robots note and the history',
    byomPage.includes('external model') && byomPage.includes('Built by an external model from the exported brief') && byomPage.includes('robots.txt') && byomPage.includes('disallows /shop for all agents') && byomPage.includes('History · ') && scriptsCompile(byomPage) === '', scriptsCompile(byomPage));

  // The CLI: an agent in the repository verifies its candidate without the
  // page. Spawned asynchronously: the mini shop it fetches lives in this
  // process, and a blocking spawn would starve it.
  const cli = (...args) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'backend/src/verify.ts', ...args], { cwd: process.cwd(), env: { ...process.env, DATA_DIR: dataDir } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  const folder = join(dataDir, 'byom');
  writeFileSync(join(folder, 'automation.candidate.mjs'), BAKED);
  writeFileSync(join(folder, 'candidate.json'), JSON.stringify({ title: 'CLI Listings', summary: 'From the CLI.', parameters: [{ name: 'min_price', example: '50' }], fixed: [] }));
  const rejected = await cli('byom');
  check('cli: REJECTED with the reason and exit 1', rejected.status === 1 && /^REJECTED: lint: .*"hub" is hard-coded/m.test(rejected.stdout), `${rejected.status} ${rejected.stdout} ${rejected.stderr}`.slice(0, 400));
  writeFileSync(join(folder, 'automation.candidate.mjs'), GOOD);
  writeFileSync(join(folder, 'candidate.json'), JSON.stringify({ title: 'CLI Listings', summary: 'From the CLI.', parameters: PARAMS, fixed: [] }));
  const passed = await cli('byom');
  check('cli: PASS with rows, columns, hosts and the robots note, exit 0, nothing saved without --save',
    passed.status === 0 && /^PASS — 3 of 3 row\(s\)/m.test(passed.stdout) && /columns title, price, link/.test(passed.stdout) && /^note: robots\.txt/m.test(passed.stdout) && /add --save/.test(passed.stdout) && readMeta('byom').name === 'Shop Listings BYOM',
    `${passed.status} ${passed.stdout} ${passed.stderr}`.slice(0, 400));
  writeFileSync(join(folder, 'answer.md'), answer.replace('Shop Listings BYOM', 'Answer File'));
  const saved = await cli('byom', join(folder, 'answer.md'), '--save');
  check('cli: a whole reply file passes and --save makes it the automation',
    saved.status === 0 && /saved as the session's automation/.test(saved.stdout) && readSpec('byom').repaired.mode === 'import' && readLog('byom').at(-1).kind === 'saved' && /Answer File/.test(readLog('byom').at(-1).text),
    `${saved.status} ${saved.stdout} ${saved.stderr}`.slice(0, 400));
  const usage = await cli();
  check('cli: usage on no arguments, exit 2', usage.status === 2 && /usage: npm run verify/.test(usage.stderr));

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

  // === Session page: the route out of a wrong result ==========================
  // A deterministic automation can run perfectly and return the wrong thing,
  // so the Run card carries a way into Maximum Effort Mode; the fold opens
  // for the #effort anchor; the history label counts what the log holds; a
  // runrow lines its controls up; and the footer names the port in use.
  // Two sessions of one typed value: ui-run ends with a saved automation,
  // ui-open never gets one.
  const ONE = `async function run(ctx) {
  const res = await ctx.http.fetch('${SITE}/shop?q=' + encodeURIComponent(ctx.inputs.search));
  const found = [...res.text.matchAll(/<a class="t"[^>]*>([^<]+)<\\/a> <span class="p">([^<]+)<\\/span>/g)];
  return found.slice(0, 3).map((m) => ({ title: m[1], price: m[2] }));
}`;
  const oneEvents = () => [
    { kind: 'session_start', seq: 0 },
    { kind: 'page', url: `${SITE}/`, title: 'Shop', lang: 'en', seq: 1 },
    { kind: 'action', action: 'input', value: 'hub', target: { tag: 'input', id: 'search', selector: '#search', aria: 'Search' }, seq: 2 },
    { kind: 'action', action: 'enter', target: { tag: 'input', id: 'search', selector: '#search' }, seq: 3 },
    { kind: 'nav', url: `${SITE}/shop?q=hub`, transition: 'form_submit', seq: 4 },
    { kind: 'page', url: `${SITE}/shop?q=hub`, title: 'Shop', lang: 'en', seq: 5 },
    { kind: 'snapshot', reason: 'load', url: `${SITE}/shop?q=hub`, title: 'Shop', text: textOf(FIRST), html: domOf(FIRST), seq: 6 },
    { kind: 'snapshot', reason: 'stop', url: `${SITE}/shop?q=hub`, title: 'Shop', text: textOf(FIRST), html: domOf(FIRST), seq: 7 },
    { kind: 'session_stop', seq: 8 },
  ];
  const importInto = (session, text) => fetch(`${BACKEND}/api/sessions/${session}/import`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

  await record('ui-run', oneEvents());
  // A conversation the operator already had, so the import outcomes below
  // land on top of it and the label has to choose between the two counts.
  writeFileSync(join(dataDir, 'ui-run', 'effort.jsonl'), [
    { kind: 'start', text: new Date().toISOString(), t: 1 },
    { kind: 'you', text: 'the top 3 listings with title and price', t: 2 },
    { kind: 'think', text: 'The listing is server-rendered, so fetch the page and parse it.', t: 3 },
    { kind: 'say', text: 'I will fetch the listing page and read the first three items.', t: 4 },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const convoOnly = await fetch(`${BACKEND}/session/ui-run`).then((r) => r.text());
  check('history: a conversation alone is counted as messages',
    convoOnly.includes('Past conversation · 3 messages'), convoOnly.match(/Past conversation[^<]*|History[^<]*/)?.[0]);

  const uiBad = await importInto('ui-run', ONE.replace('encodeURIComponent(ctx.inputs.search)', "'hub'"));
  check('ui-run: the hard-coded answer is refused, leaving a fail in the log', uiBad.status === 422, JSON.stringify(uiBad.body).slice(0, 200));
  const uiGood = await importInto('ui-run', ONE);
  check('ui-run: the one-parameter answer is verified and saved',
    uiGood.status === 200 && JSON.stringify(uiGood.body.parameters) === '["search"]', JSON.stringify(uiGood.body).slice(0, 300));
  const uiLog = readLog('ui-run');
  check('history: a mixed log still counts messages, not entries',
    uiLog.some((l) => l.kind === 'fail') && uiLog.some((l) => l.kind === 'saved') && uiLog.length > 3 &&
    (await fetch(`${BACKEND}/session/ui-run`).then((r) => r.text())).includes('Past conversation · 3 messages'),
    JSON.stringify(uiLog.map((l) => l.kind)));

  await record('ui-open', oneEvents());
  await importInto('ui-open', ONE.replace('encodeURIComponent(ctx.inputs.search)', "'hub'"));
  const openPage = await fetch(`${BACKEND}/session/ui-open`).then((r) => r.text());
  check('history: import outcomes alone are counted as entries', openPage.includes('History · 2 entries'), openPage.match(/Past conversation[^<]*|History[^<]*/)?.[0]);

  const runPage = await fetch(`${BACKEND}/session/ui-run`).then((r) => r.text());
  check('fold: closed once the session has an automation, open while it has none',
    /<details class="fold" id="effort">/.test(runPage) && /<details class="fold" id="effort" open>/.test(openPage),
    `${runPage.match(/<details class="fold" id="effort"[^>]*>/)?.[0]} | ${openPage.match(/<details class="fold" id="effort"[^>]*>/)?.[0]}`);
  check('the way out of a wrong result is rendered with the Run card, and only with the effort card',
    runPage.includes('>Not what I wanted?</button>') && runPage.includes('id="to-effort-row"') && !openPage.includes('id="to-effort-row"'));
  check('session pages still parse', scriptsCompile(runPage) === '' && scriptsCompile(openPage) === '', scriptsCompile(runPage) || scriptsCompile(openPage));

  // The import note: our own rejections carry `error`, Fastify's own bodies
  // carry the line worth reading in `message`, and a 409 is not the answer's
  // fault so it is a warning with nothing to paste back.
  const malformed = await fetch(`${BACKEND}/api/sessions/ui-run/import`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":',
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  check('import: a body Fastify itself rejects answers in its own shape, where `message` is the useful line',
    malformed.status === 400 && typeof malformed.body.message === 'string' && malformed.body.message !== malformed.body.error,
    JSON.stringify(malformed.body));
  check('the import note prefers that message, then our error, then the status, and warns rather than fails on a 409',
    runPage.includes("res.message || res.error || ('HTTP ' + r.status)") && runPage.includes("r.status === 409") &&
    runPage.includes("e.message || e.error || ('HTTP ' + r.status)"));

  check('the sidebar names the port actually serving the page',
    runPage.includes(`<div class="side-foot mono">127.0.0.1:${BACKEND_PORT}</div>`) && !runPage.includes('4823'),
    runPage.match(/<div class="side-foot[^>]*>[^<]*</)?.[0]);

  // In a real browser: run, reject the result, land in the fold with the goal
  // focused; the #effort anchor opens it on its own; the runrow controls sit
  // on one line.
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 420 } });
    await page.goto(`${BACKEND}/session/ui-run`);
    check('browser: the way out waits for a result', await page.isHidden('#to-effort-row'));
    await page.click('#run-btn');
    await page.waitForSelector('#to-effort-row', { state: 'visible', timeout: 20000 });
    const before = await page.evaluate(() => ({
      open: document.getElementById('effort').open,
      top: document.getElementById('effort').getBoundingClientRect().top,
      h: innerHeight,
    }));
    check('browser: the result renders with the fold closed and out of sight',
      !before.open && before.top >= before.h, JSON.stringify(before));
    await page.click('#to-effort');
    await page.waitForFunction(() => {
      const r = document.getElementById('effort').getBoundingClientRect();
      return r.top >= 0 && r.top < innerHeight - 40;
    }, null, { timeout: 5000 }).catch(() => {});
    const after = await page.evaluate(() => {
      const r = document.getElementById('effort').getBoundingClientRect();
      return { open: document.getElementById('effort').open, top: r.top, h: innerHeight, focus: document.activeElement.id };
    });
    check('browser: "Not what I wanted?" opens the fold, scrolls to it and focuses the goal',
      after.open && after.top >= 0 && after.top < after.h - 40 && after.focus === 'effort-goal', JSON.stringify(after));

    // Both segs, the Export brief button and the pills beside them: centres
    // within 2px of the control they sit next to.
    const mids = await page.evaluate(() => {
      const mid = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
      const row = document.getElementById('brief-btn').parentElement;
      const head = document.getElementById('seg-single').closest('.card-head');
      return {
        briefSeg: mid(row.querySelector('.seg')), briefBtn: mid(document.getElementById('brief-btn')), briefPill: mid(row.querySelector('.pw')),
        headSeg: mid(head.querySelector('.seg')), headTitle: mid(head.querySelector('h2')), headPill: mid(head.querySelector('.pw')),
      };
    });
    const near = (a, b) => Math.abs(a - b) <= 2;
    check('browser: the brief row lines the seg, the button and the pill up',
      near(mids.briefSeg, mids.briefBtn) && near(mids.briefPill, mids.briefBtn), JSON.stringify(mids));
    check('browser: the Run card head lines the seg, the heading and the pill up',
      near(mids.headSeg, mids.headTitle) && near(mids.headPill, mids.headTitle), JSON.stringify(mids));

    await page.goto(`${BACKEND}/session/ui-run#effort`);
    await page.waitForFunction(() => document.getElementById('effort').open, null, { timeout: 5000 }).catch(() => {});
    check('browser: the #effort anchor opens the closed fold on load',
      await page.evaluate(() => document.getElementById('effort').open));

    await page.goto(`${BACKEND}/session/ui-open`);
    check('browser: a session with no automation lands with the fold already open',
      await page.evaluate(() => document.getElementById('effort').open && !document.getElementById('to-effort-row')));

    // The whole paste-and-save flow from the anchor, which is where "View &
    // run" has to escape the hash to reach the automation it just saved.
    const briefed = await fetch(`${BACKEND}/api/sessions/ui-open/brief?probe=0`);
    await briefed.text();
    check('the brief marks the session as exported', briefed.status === 200 && readMeta('ui-open').briefAt > 0, String(briefed.status));
    // Via another page: a goto that only changes the hash does not reload.
    await page.goto(`${BACKEND}/session/ui-run`);
    await page.goto(`${BACKEND}/session/ui-open#effort`);
    check('browser: the paste box is on the page once a brief exists', await page.isVisible('#import-text'));
    await page.fill('#import-text', ONE);
    await page.click('#import-btn');
    await page.waitForSelector('#import-out .ok-note', { timeout: 30000 });
    await page.click('#import-out button');
    await page.waitForSelector('#run-btn', { timeout: 10000 });
    check('browser: "View & run" leaves #effort behind and lands on the Run card',
      new URL(page.url()).hash === '' && await page.evaluate(() => !document.getElementById('effort').open),
      page.url());
  } finally {
    await browser.close();
  }
  // ==========================================================================
  // Bring your own model: what the brief spends its budget on, what it says
  // about pages and calls it cannot reach, and what the routes refuse.
  // ==========================================================================

  // A recording whose first page is enormous: the page the operator ended on
  // must survive the budget, the one they passed through may be cut.
  const PAD = Array.from({ length: 4_000 }, (_, i) => `padding line ${i} of a very long first page`).join('\n');
  const bigEvents = shopEvents();
  bigEvents[6] = { ...bigEvents[6], text: `${textOf(FIRST)}\n${PAD}` };
  await record('big', bigEvents);
  const beforeExport = await fetch(`${BACKEND}/session/big`).then((r) => r.text());
  const bigFull = await fetch(`${BACKEND}/api/sessions/big/brief?probe=0`).then((r) => r.text());
  const bigChat = await fetch(`${BACKEND}/api/sessions/big/brief?probe=0&budget=300000`).then((r) => r.text());
  check('budget: a chat-sized brief keeps the last page whole and cuts the huge earlier one',
    bigChat.length <= 300_000 && bigChat.includes('### Snapshot #12 (stop) — visible text') &&
    bigChat.includes('CalDigit Element Hub $189') && bigChat.includes('3 results') &&
    /snapshot #6 text: (cut at \d+ of \d+ chars|left out entirely)/.test(bigChat),
    `${bigChat.length} chars; ${bigChat.match(/## Left out by the budget[\s\S]{0,300}/)?.[0]}`);
  check('budget: the last page comes before the pages the operator passed through',
    bigChat.indexOf('### Snapshot #12 (stop)') < bigChat.indexOf('### Snapshot #6 (load)') &&
    bigChat.indexOf('### Snapshot #12 — pruned HTML') < bigChat.indexOf('### Snapshot #6 (load)'),
    `#12 text ${bigChat.indexOf('### Snapshot #12 (stop)')}, #12 html ${bigChat.indexOf('### Snapshot #12 — pruned HTML')}, #6 ${bigChat.indexOf('### Snapshot #6 (load)')}`);
  const cutAt = Number(bigChat.match(/CUT HERE by the brief's budget: (\d+) of \d+/)?.[1] ?? 0);
  check('budget: no single item takes more than a quarter of a chat-sized brief', cutAt > 0 && cutAt <= 300_000 / 4, String(cutAt));
  check('budget: the full export cuts nothing and carries the whole first page',
    bigFull.includes('Nothing: the whole recording fit') && bigFull.includes('padding line 3999 of a very long first page'), bigFull.length + ' chars');
  check('brief: the contract names the whole context a script gets, and what is refused in code',
    bigFull.includes("The context has JavaScript's own intrinsics plus URL and URLSearchParams and nothing else: no timers, no fetch, no TextEncoder, no structuredClone.") &&
    bigFull.includes('process, globalThis, eval, Function(), Reflect, Proxy, constructor, prototype and __proto__ are refused in code'),
    bigFull.match(/## The script[\s\S]{0,500}/)?.[0]);
  check('brief: the task says what the recording deliberately does not carry',
    bigFull.includes('Hidden form values are named in the recording but never kept') &&
    bigFull.includes('fetch the form page at run time and read the current values out of it with ctx.dom before submitting') &&
    bigFull.includes("lists the page's web-storage key NAMES only, never their values") &&
    bigFull.includes('read it at run time with ctx.site.token(pageUrl)'),
    bigFull.match(/^\d\. Hidden form values[\s\S]{0,600}/m)?.[0]);
  const chatFolder = bigChat.match(/Session folder[^\n]*/)?.[0] ?? '';
  const fullFolder = bigFull.match(/Session folder[^\n]*/)?.[0] ?? '';
  check('budget: the chat-sized brief names the session folder relative to the repository, not from a home directory',
    fullFolder === `Session folder on the operator's machine: ${join(dataDir, 'big')}` &&
    chatFolder.startsWith('Session folder, relative to the repository root: ') && !chatFolder.includes(`: ${dataDir}`),
    `${fullFolder} | ${chatFolder}`);
  const afterExport = await fetch(`${BACKEND}/session/big`).then((r) => r.text());
  check('a GET export leaves the page ready for the answer',
    beforeExport.includes('id="import-block" hidden') && afterExport.includes('<div id="import-block">') &&
    readMeta('big').briefAt > 0 && existsSync(join(dataDir, 'big', 'BRIEF.md')), `${readMeta('big').briefAt}`);

  // Pages a plain fetch cannot have: the brief must say which, not "the
  // content is missing".
  await record('walls', [
    { kind: 'session_start', seq: 0 },
    { kind: 'page', url: `${SITE}/`, title: 'Shop', lang: 'en', seq: 1 },
    { kind: 'action', action: 'input', value: 'hub', target: { tag: 'input', id: 'search', selector: '#search' }, seq: 2 },
    { kind: 'nav', url: `${SITE}/walled`, transition: 'link', seq: 3 },
    { kind: 'nav', url: `${SITE}/challenge`, transition: 'link', seq: 4 },
    { kind: 'nav', url: `${SITE}/members`, transition: 'link', seq: 5 },
    { kind: 'session_stop', seq: 6 },
  ]);
  const walls = await fetch(`${BACKEND}/api/sessions/walls/brief`).then((r) => r.text());
  const wallLine = (path) => walls.split('\n').find((l) => l.startsWith(`- ${SITE}${path} →`)) ?? '';
  check('fetch check: a refusal status is called a bot wall, not missing content',
    /→ HTTP 403 .*; refused \(bot wall or blocked\): a plain fetch does not get this page; use ctx\.browser, or record differently$/.test(wallLine('/walled')), wallLine('/walled'));
  check('fetch check: a challenge page is called a bot wall too',
    /→ HTTP 200 .*; refused \(bot wall or blocked\)/.test(wallLine('/challenge')), wallLine('/challenge'));
  check('fetch check: a redirect to a sign-in page is called out of scope',
    /\(redirected to .*\/login\?returnUrl=\/members\); redirected to a login page: this page needs a session the tool does not keep \(out of scope\)$/.test(wallLine('/members')), wallLine('/members'));

  // A gated API and the automation the session already has.
  const gatedStop = await record('gated', [
    { kind: 'session_start', seq: 0 },
    { kind: 'page', url: `${SITE}/shop`, title: 'Shop', lang: 'en', seq: 1 },
    { kind: 'action', action: 'input', value: 'hub', target: { tag: 'input', id: 'search', selector: '#search', aria: 'Search' }, seq: 2 },
    { kind: 'net', method: 'GET', url: `${SITE}/api/gated?q=hub`, status: 200, contentType: 'application/json',
      resBody: JSON.stringify({ results: [{ name: 'CalDigit Element Hub', price: 189 }, { name: 'OWC Thunderbolt Hub', price: 129 }] }), seq: 3 },
    { kind: 'snapshot', reason: 'load', url: `${SITE}/shop`, title: 'Shop', text: textOf(FIRST), html: domOf(FIRST), seq: 4 },
    { kind: 'session_stop', seq: 5 },
  ]);
  check('gated: the deterministic generator still builds a spec for it', gatedStop.spec === true);
  const gated = await fetch(`${BACKEND}/api/sessions/gated/brief`).then((r) => r.text());
  check('brief: the call that carried the typed value is replayed and reported as gated',
    gated.includes(`- #3 GET ${SITE}/api/gated?q=hub replayed without cookies or credentials → HTTP 401: gated; obtain the site's anonymous bearer with ctx.site.token('${SITE}/shop') and send it as authorization`),
    gated.match(/The calls that carried a typed value[\s\S]{0,400}/)?.[0]);
  const existing = gated.match(/### The automation this session already has\n\n([\s\S]*?)\n\n###/)?.[1] ?? '';
  check('brief: the automation the session already has is described, token step and probe status included',
    existing.includes('browser-token step (direct call needs a bearer token (probe returned 401)') &&
    existing.includes(`GET ${SITE}/api/gated?q={{`) && existing.includes('parameters search="hub"') && existing.includes('built by the deterministic generator'),
    existing);
  check('brief: a session with no automation says so', walls.includes('### The automation this session already has\n\nNone: the deterministic analyser refused.'),
    walls.match(/### The automation this session already has[\s\S]{0,200}/)?.[0]);

  // JSONP: the recorder kept the URL, the export fetches the body.
  const jsonpEvents = shopEvents();
  jsonpEvents.splice(-1, 0, { kind: 'net_meta', method: 'GET', url: `${SITE}/jsonp?callback=cb&q=hub`, status: 200, resourceType: 'script', seq: 13 });
  jsonpEvents[jsonpEvents.length - 1].seq = 14;
  await record('jsonp', jsonpEvents);
  const jsonp = await fetch(`${BACKEND}/api/sessions/jsonp/brief`).then((r) => r.text());
  check('brief: a script-tag body the recorder could not capture is fetched at export and explained',
    jsonp.includes(`### A script-tag response the recorder could not capture, ${SITE}/jsonp?callback=cb&q=hub`) &&
    jsonp.includes('almost certainly JSONP') && jsonp.includes('`callback=`') && jsonp.includes('cb({"q":"hub"'),
    jsonp.match(/### A script-tag response[\s\S]{0,600}/)?.[0]);
  const jsonpSkipped = await fetch(`${BACKEND}/api/sessions/jsonp/brief?probe=0`).then((r) => r.text());
  check('brief: probe=0 skips the script-tag fetch like the page fetches',
    !jsonpSkipped.includes('### A script-tag response') && jsonpSkipped.includes('Not checked (export with ?probe=0'));

  // A header row marked by mistake names columns; it is not a value any row
  // carries, and demanding it would only be satisfied by scraping the header.
  const headerEvents = shopEvents();
  headerEvents.splice(-1, 0,
    { kind: 'action', action: 'mark', text: 'Title Price Link', target: { tag: 'tr', selector: '#results > thead > tr' }, seq: 13 },
    { kind: 'action', action: 'mark', text: 'OWC Thunderbolt Hub $129', target: { tag: 'tr', selector: '#results > tbody > tr:nth-child(2)' }, seq: 14 },
    // "thead" hides inside plenty of ids: this one is a heading, and required.
    { kind: 'action', action: 'mark', text: 'Satechi Slim Hub', target: { tag: 'h1', selector: '#firstHeading' }, seq: 15 });
  headerEvents[headerEvents.length - 1].seq = 16;
  await record('header', headerEvents);
  const headerBrief = await fetch(`${BACKEND}/api/sessions/header/brief?probe=0`).then((r) => r.text());
  check('marks: the brief says a marked table header row is ignored, and only that one',
    headerBrief.includes('- "OWC Thunderbolt Hub $129"') && headerBrief.includes('- "Satechi Slim Hub"\n') &&
    headerBrief.includes('- "Title Price Link" — ignored: a table header row, not a value'),
    headerBrief.match(/### Marked text[\s\S]{0,300}/)?.[0]);
  const importTo = (session, text) => fetch(`${BACKEND}/api/sessions/${session}/import`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const headerImport = await importTo('header', answer);
  check('marks: an answer carrying the row but not the header is accepted, and the note says why',
    headerImport.status === 200 && /all 2 marked selection\(s\) located \(the marked table header row "title price link" is ignored: a header names columns, it is not a value\)/.test(headerImport.body.note),
    JSON.stringify(headerImport.body));

  // One writer per session: an import holds it while the script runs.
  await record('lock', shopEvents());
  const SLOW = GOOD.replace('async function run(ctx) {', 'async function run(ctx) {\n  await ctx.sleep(1500);');
  const slowAnswer = JSON.stringify({ title: 'Slow', summary: 'Sleeps, then reads the listing.', parameters: PARAMS, fixed: [], source: SLOW });
  const firstImport = importTo('lock', slowAnswer);
  await sleep(300);
  const secondImport = await importTo('lock', slowAnswer);
  const effortDuring = await fetch(`${BACKEND}/api/sessions/lock/effort`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const firstDone = await firstImport;
  check('lock: a second import while one is verifying is refused',
    secondImport.status === 409 && /already being verified/.test(secondImport.body.error ?? ''), JSON.stringify(secondImport));
  check('lock: Maximum Effort Mode is refused while an answer is being verified', effortDuring.status === 409, String(effortDuring.status));
  const laterImport = await importTo('lock', slowAnswer);
  check('lock: the first import completed and a later one proceeds',
    firstDone.status === 200 && laterImport.status === 200, `${firstDone.status} ${laterImport.status}`);

  // curl, with no JSON wrapper: the body is the goal, then the answer.
  await record('curl', shopEvents());
  const asText = (path, body) => fetch(`${BACKEND}${path}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body });
  const goalRes = await asText('/api/sessions/curl/brief?probe=0', 'every hub on the final page');
  const goalBrief = await goalRes.text();
  check('curl: a text/plain body on the brief route is the goal',
    goalRes.status === 200 && goalBrief.includes('## Goal\n\nevery hub on the final page') && readMeta('curl').goal === 'every hub on the final page',
    `${goalRes.status} ${goalBrief.match(/## Goal[\s\S]{0,80}/)?.[0]}`);
  const textImport = await asText('/api/sessions/curl/import', answer);
  check('curl: a text/plain body on the import route is the answer',
    textImport.status === 200 && readSpec('curl').repaired.mode === 'import', `${textImport.status} ${await textImport.text()}`.slice(0, 300));

  // What the model gets back when its answer will not parse.
  await record('parse', shopEvents());
  const trailing = await importTo('parse', '```json\n{\n  "title": "x",\n  "parameters": [1,2,],\n  "source": "async function run(ctx) { return []; }"\n}\n```');
  check('parse: a trailing comma is refused with the block, the position and the rule',
    trailing.status === 422 && /^REJECTED: json block #1 does not parse: .*position \d+/.test(trailing.body.error) && /no trailing commas, no comments/.test(trailing.body.error),
    JSON.stringify(trailing.body));
  const commented = await importTo('parse', '```json\n{\n  // the script\n  "source": "async function run(ctx) { return []; }"\n}\n```');
  check('parse: a comment is refused the same way',
    commented.status === 422 && /^REJECTED: json block #1 does not parse: .*position \d+/.test(commented.body.error), JSON.stringify(commented.body));
  const twoBlocks = await importTo('parse',
    'The shape first:\n```json\n' + JSON.stringify({ title: 'Example', summary: 'shape only', parameters: [], fixed: [], source: 'async function run(ctx) { return [{ a: 1 }]; }' }) +
    '\n```\nAnd the answer:\n```json\n' + JSON.stringify({ title: 'Real Answer', summary: 'Fetches the listing and returns the first three items.', parameters: PARAMS, fixed: [], source: GOOD }) + '\n```');
  check('parse: with two json blocks the last one carrying source is used',
    twoBlocks.status === 200 && /saved as "Real Answer"/.test(twoBlocks.body.text ?? ''), JSON.stringify(twoBlocks.body));
  const asLines = await importTo('parse', '```json\n' + JSON.stringify({ title: 'Lines', summary: 's', parameters: PARAMS, fixed: [], source: GOOD.split('\n') }) + '\n```');
  check('parse: a source given as an array of lines is refused with the fix named',
    asLines.status === 422 && asLines.body.error === 'REJECTED: json block #1: "source" is an array of lines. Send the whole script as ONE JSON string, its lines joined with \\n.',
    JSON.stringify(asLines.body));
  const asNumber = await importTo('parse', '```json\n' + JSON.stringify({ source: 42 }) + '\n```');
  check('parse: a source of any other type is refused too',
    asNumber.status === 422 && /"source" is a number\. Send the whole script as ONE JSON string/.test(asNumber.body.error ?? ''), JSON.stringify(asNumber.body));

  // Boundaries: every bad request is answered, none of them is a 500.
  const badBody = await fetch(`${BACKEND}/api/sessions/parse/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text": ' });
  check('boundary: malformed JSON is a 400', badBody.status === 400, String(badBody.status));
  const unknownBrief = await fetch(`${BACKEND}/api/sessions/nope/brief`);
  const unknownImport = await importTo('nope', 'anything');
  check('boundary: an unknown session is a 404 on both routes', unknownBrief.status === 404 && unknownImport.status === 404, `${unknownBrief.status} ${unknownImport.status}`);
  await api('/api/sessions', { session: 'live', hosts: ['127.0.0.1'], startedAt: Date.now() });
  const liveBrief = await fetch(`${BACKEND}/api/sessions/live/brief`);
  const liveImport = await importTo('live', 'anything');
  check('boundary: a session still recording is a 409 on both routes',
    liveBrief.status === 409 && liveImport.status === 409 && /only complete recordings/.test(liveImport.body.error ?? ''),
    `${liveBrief.status} ${JSON.stringify(liveImport)}`);
  const notText = await fetch(`${BACKEND}/api/sessions/parse/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 42 }) })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
  check('boundary: a non-string text is a 422 keeping the {error} shape the page reads',
    notText.status === 422 && /^REJECTED: "text" must be a string/.test(notText.body.error ?? ''), JSON.stringify(notText));
  // Declared, not sent: the backend refuses on the length alone, which is the
  // point — 64 MB never reaches it.
  const huge = await new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: BACKEND_PORT, path: '/api/sessions/parse/import', method: 'POST',
      headers: { 'content-type': 'text/plain', 'content-length': String(65 * 1024 * 1024) } });
    req.on('response', (res) => { res.resume(); req.destroy(); resolve(res.statusCode); });
    req.on('error', (e) => reject(e));
    req.write('x'.repeat(1024));
  });
  const health = await fetch(`${BACKEND}/health`).then((r) => r.json());
  check('boundary: a body over the limit is a 413 and the backend still answers', huge === 413 && health.ok === true, `${huge} ${JSON.stringify(health)}`);

  // The acceptance searches the pages the operator saw for the rows a script
  // returns. Four heavy pages ahead of the one that matters fill that budget,
  // so it is read newest first: a script showing the final page is accepted.
  const heavy = (seq) => ({
    kind: 'snapshot', reason: 'load', url: `${SITE}/heavy/${seq}`, title: 'Heavy',
    text: `page ${seq} `.repeat(1) + 'x'.repeat(250_000), html: `<p>${'y'.repeat(700_000)}</p>`, seq,
  });
  await record('deep', [
    { kind: 'session_start', seq: 0 },
    { kind: 'page', url: `${SITE}/heavy/1`, title: 'Heavy', lang: 'en', seq: 1 },
    { kind: 'action', action: 'input', value: 'zzz', target: { tag: 'input', id: 'search', selector: '#search' }, seq: 2 },
    heavy(3), heavy(4), heavy(5), heavy(6),
    { kind: 'snapshot', reason: 'stop', url: `${SITE}/heavy/last`, title: 'Heavy', text: 'Marmalade Sky Widget\n1 result', html: '<ul><li>Marmalade Sky Widget</li></ul>', seq: 7 },
    { kind: 'session_stop', seq: 8 },
  ]);
  const deep = await importTo('deep', 'async function run(ctx) { void ctx.inputs.search; return [{ title: \'Marmalade Sky Widget\' }]; }');
  check('acceptance: the last page is searched even when earlier pages fill the evidence budget',
    deep.status === 200 && /1 of 1 row\(s\) carry text the operator saw/.test(deep.body.text ?? ''), JSON.stringify(deep).slice(0, 300));

  // The brief of a session that already has a script shows the script itself.
  const afterImport = await fetch(`${BACKEND}/api/sessions/byom/brief?probe=0`).then((r) => r.text());
  check('brief: a session that already has an imported script shows it in full',
    afterImport.includes('session script (automation.mjs, hosts 127.0.0.1)') && afterImport.includes('built by external in import mode') &&
    afterImport.includes('--- current script ---') && afterImport.includes('ctx.inputs.query'),
    afterImport.match(/### The automation this session already has[\s\S]{0,300}/)?.[0]);

  // === Automation fold: a script's marks were checked at acceptance ==========
  // The amber "marks unmatched" chip is the deterministic generator's verdict
  // on its columns; a script automation saved with its marks located must
  // not wear it.
  const headerPage = await fetch(`${BACKEND}/session/header`).then((r) => r.text());
  check('a script automation whose marks were located shows no unmatched-marks chip',
    headerPage.includes('external model') && !headerPage.includes('marks unmatched') && !/\d+\/\d+ marks/.test(headerPage) && scriptsCompile(headerPage) === '',
    headerPage.match(/<span class="chip[^>]*>[^<]*marks[^<]*<\/span>/g)?.join(' ') ?? scriptsCompile(headerPage));
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
