// LLM repair loop suite. A scripted mock LLM stands in for the API, and a
// mini-site reproduces the JSONP failure shape live: suggestions come back as
// a script call unless the callback parameter is dropped. Proves the loop
// diagnoses, fails a bad proposal, verifies a good one, saves a named spec,
// and honours the safety rails. Run: node e2e/repair.e2e.mjs
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BACKEND_PORT = 4893;
const LLM_PORT = 4987;
const SITE_PORT = 4989;
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

// Mini-site: /api/suggest is JSONP when callback= is present, plain JSON
// otherwise — the exact shape that defeated capture on the Wikipedia portal.
const COMPANIES = [
  { name: 'Awal Trading Co. W.L.L', cr: '139867' },
  { name: 'Delmon Trading W.L.L', cr: '91230' },
  { name: 'Gulf Line Logistics', cr: '20775' },
];
const site = createServer((req, res) => {
  const url = new URL(req.url, SITE);
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
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<html><body>mini site</body></html>');
});
site.listen(SITE_PORT);

// Scripted mock LLM: each POST /v1/messages consumes the next reply.
const SUGGEST = `${SITE}/api/suggest`;
const scripts = [
  // jsonp session, round 1: realistic mistake — keeps the callback parameter.
  { diagnosis: 'The suggestion endpoint is JSONP; its body was never captured by fetch interception.',
    action: 'propose', title: 'Trading Name Search',
    call: { method: 'GET', url: `${SUGGEST}?q={{query}}&callback=cb0`, body: null,
      params: [{ name: 'query', recordedValue: 'trading' }] } },
  // jsonp session, round 2: drops the callback — plain JSON.
  { diagnosis: 'Dropping the callback parameter should return plain JSON from the same endpoint.',
    action: 'propose', title: 'Trading Name Search',
    call: { method: 'GET', url: `${SUGGEST}?q={{query}}`, body: null,
      params: [{ name: 'query', recordedValue: 'trading' }] } },
  // noinput session: honest stop.
  { diagnosis: 'Nothing was typed during the recording, so there is no input to parameterise.',
    action: 'stop', advice: 'Re-record and type the search value during the session, then mark the wanted data.' },
  // offhost session, round 1: tries to leave the allowlist — must be refused locally.
  { diagnosis: 'Trying an external mirror of the data.',
    action: 'propose', title: 'External Search',
    call: { method: 'GET', url: 'https://evil.example.com/api?q={{query}}', body: null,
      params: [{ name: 'query', recordedValue: 'trading' }] } },
  // offhost session, round 2: gives up.
  { diagnosis: 'No allowlisted endpoint returns the data.',
    action: 'stop', advice: 'Re-record on the allowlisted site.' },
];
const llmRequests = [];
const llm = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    llmRequests.push(JSON.parse(body));
    const script = scripts.shift() ?? { diagnosis: 'out of script', action: 'stop', advice: 'none' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_mock', type: 'message', role: 'assistant', model: 'claude-opus-5',
      content: [{ type: 'text', text: JSON.stringify(script) }],
      stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
});
llm.listen(LLM_PORT);

const dataDir = mkdtempSync(join(tmpdir(), 'wfr-repair-'));
const backend = spawn('npx', ['tsx', 'backend/src/server.ts'], {
  cwd: process.cwd(),
  env: { ...process.env, DATA_DIR: dataDir, PORT: String(BACKEND_PORT),
    ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${LLM_PORT}` },
  stdio: 'ignore',
});

// The JSONP failure shape: typed input, script-only suggestion requests, a
// click on a result — no captured structured response anywhere.
const jsonpEvents = (session) => [
  { kind: 'session_start', seq: 0 },
  { kind: 'page', url: `${SITE}/`, lang: 'en', seq: 1 },
  { kind: 'action', action: 'click', target: { tag: 'input', selector: '#q' }, seq: 2 },
  { kind: 'net_meta', method: 'GET', url: `${SUGGEST}?q=trading&callback=cb0`, status: 200, resourceType: 'script', seq: 3 },
  { kind: 'action', action: 'input', value: 'trading', target: { id: 'q' }, seq: 4 },
  { kind: 'action', action: 'click', target: { tag: 'a', text: 'Awal Trading Co. W.L.L' }, seq: 5 },
  { kind: 'nav', url: `${SITE}/company/139867`, transition: 'link', seq: 6 },
  { kind: 'session_stop', seq: 7 },
];

async function repair(session) {
  const text = await fetch(`${BACKEND}/api/sessions/${session}/repair`, { method: 'POST' }).then((r) => r.text());
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
const kinds = (lines) => lines.map((l) => l.kind);

try {
  await wait(`${BACKEND}/health`);

  // Scenario 1: JSONP recording repaired in two rounds.
  await api('/api/sessions', { session: 'jsonp', hosts: ['127.0.0.1'], startedAt: 1 });
  await api('/api/sessions/jsonp/events', { items: jsonpEvents('jsonp') });
  const stop = await api('/api/sessions/jsonp/stop', {});
  check('recording refuses deterministically', stop.spec === false);

  const lines = await repair('jsonp');
  check('round 1 fails on the JSONP response', kinds(lines).includes('fail'),
    JSON.stringify(lines));
  check('round 2 verifies and saves', kinds(lines).includes('ok') && kinds(lines).includes('saved'),
    JSON.stringify(lines));
  const okLine = lines.find((l) => l.kind === 'ok');
  check('verification cites the recorded evidence', /awal trading/i.test(okLine?.text ?? ''), okLine?.text);

  const spec = JSON.parse(readFileSync(join(dataDir, 'jsonp', 'spec.json'), 'utf8'));
  check('saved spec is marked repaired and parameterised',
    !!spec.repaired && spec.steps[0].url.includes('{{query}}') && spec.parameters[0]?.name === 'query',
    JSON.stringify(spec.steps));
  const meta = JSON.parse(readFileSync(join(dataDir, 'jsonp', 'meta.json'), 'utf8'));
  check('session titled by the assistant', meta.name === 'Trading Name Search', meta.name);

  const run = await api('/api/sessions/jsonp/run', { params: { query: 'gulf' } });
  check('repaired automation replays a new input',
    run.ok && JSON.stringify(run.extracted?.records?.rows ?? []).includes('Gulf Line Logistics'),
    run.stoppedReason ?? JSON.stringify(run.extracted));

  const page = await fetch(`${BACKEND}/session/jsonp`).then((r) => r.text());
  check('session page shows the repair provenance', page.includes('Built by the LLM repair assistant'));
  const after = JSON.parse(readFileSync(join(dataDir, 'jsonp', 'spec.json'), 'utf8'));
  check('repaired spec survives page-load regeneration', !!after.repaired);

  // Scenario 2: no typed input — the assistant stops with re-record advice.
  await api('/api/sessions', { session: 'noinput', hosts: ['127.0.0.1'], startedAt: 1 });
  await api('/api/sessions/noinput/events', { items: [
    { kind: 'session_start', seq: 0 },
    { kind: 'page', url: `${SITE}/company/139867`, lang: 'en', seq: 1 },
    { kind: 'action', action: 'mark', text: 'Awal Trading Co. W.L.L', target: { selector: '#name' }, seq: 2 },
    { kind: 'session_stop', seq: 3 },
  ]});
  await api('/api/sessions/noinput/stop', {});
  const noLines = await repair('noinput');
  check('no-input recording gets advice, not a spec',
    kinds(noLines).includes('advice') && !existsSync(join(dataDir, 'noinput', 'spec.json')),
    JSON.stringify(noLines));

  // Scenario 3: a proposal outside the allowlist is refused without a request.
  await api('/api/sessions', { session: 'offhost', hosts: ['127.0.0.1'], startedAt: 1 });
  await api('/api/sessions/offhost/events', { items: jsonpEvents('offhost') });
  await api('/api/sessions/offhost/stop', {});
  const offLines = await repair('offhost');
  const offFail = offLines.find((l) => l.kind === 'fail');
  check('off-allowlist proposal is refused by the rail', /allowlist/.test(offFail?.text ?? ''),
    JSON.stringify(offLines));
  check('off-allowlist session ends with advice, no spec',
    kinds(offLines).includes('advice') && !existsSync(join(dataDir, 'offhost', 'spec.json')));

  // The digest the model received must carry the metadata-only JSONP request.
  const firstPack = JSON.stringify(llmRequests[0] ?? {});
  check('model was shown the uncaptured JSONP request', firstPack.includes('body NOT captured'));
  check('re-repair of a repaired session is refused',
    (await repair('jsonp')).some((l) => l.kind === 'error' && /already has an automation/.test(l.text)));
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
