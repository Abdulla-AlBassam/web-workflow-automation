// LLM repair loop suite. A scripted mock LLM stands in for the API, and a
// mini-site reproduces the JSONP failure shape live: suggestions come back as
// a script call unless the callback parameter is dropped. Proves the loop
// diagnoses, fails a bad proposal, verifies a good one, saves a named spec,
// and honours the safety rails. Run: node e2e/repair.e2e.mjs
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
// /api/article mirrors the MediaWiki query API: a bookkeeping array
// (normalized/redirects) listed before the page records, records as an array
// (formatversion 2) or an id-keyed map (format=1), and prop=info dropping
// the extract.
const ARTICLES = [
  { pageid: 8569916, ns: 0, title: 'English language', description: 'West Germanic language',
    extract: 'English is a West Germanic language of the Indo-European language family that emerged in early medieval England and has since become a global lingua franca. The language is named after the Angles, one of the Germanic peoples who migrated to Britain.' },
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
  // One record with a map of URLs inside it — the REST summary shape.
  if (url.pathname.startsWith('/api/summary/')) {
    const title = decodeURIComponent(url.pathname.slice('/api/summary/'.length)).replace(/_/g, ' ');
    const page = ARTICLES.find((a) => a.title.toLowerCase() === title.toLowerCase());
    res.writeHead(page ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(page
      ? { type: 'standard', title: page.title, description: page.description, extract: page.extract,
          content_urls: { desktop: { page: `${SITE}/wiki/x` }, mobile: { page: `${SITE}/m/x` } } }
      : { type: 'not_found' }));
    return;
  }
  if (url.pathname === '/api/article') {
    const titles = url.searchParams.get('titles') ?? '';
    const page = ARTICLES.find((a) => a.title.toLowerCase() === titles.toLowerCase());
    const query = {};
    if (page && titles !== page.title) query[/^[a-z]/.test(titles) ? 'normalized' : 'redirects'] = [{ from: titles, to: page.title }];
    const record = !page ? { ns: 0, title: titles, missing: true }
      : url.searchParams.get('prop') === 'info' ? { pageid: page.pageid, ns: 0, title: page.title }
      : page;
    query.pages = url.searchParams.get('format') === '1' ? { [String(record.pageid ?? -1)]: record } : [record];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ batchcomplete: true, query }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<html><body>mini site</body></html>');
});
site.listen(SITE_PORT);

// Scripted mock LLM: each POST /v1/messages consumes the next reply.
const SUGGEST = `${SITE}/api/suggest`;
const ARTICLE = `${SITE}/api/article`;
const wikiCall = (extra = '') => ({
  method: 'GET', url: `${ARTICLE}?titles={{query}}&explaintext=1${extra}`, body: null,
  params: [{ name: 'query', recordedValue: 'english language' }],
});
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
  // wiki session: one round, the article API with plain-text extracts.
  { diagnosis: 'The typeahead was JSONP and the article was server-rendered; the article API returns the intro as plain text.',
    action: 'propose', title: 'Wikipedia Article Lookup', call: wikiCall() },
  // wikiold session (refine): same corrected call.
  { diagnosis: 'The saved automation extracted the normalisation echo instead of the page records.',
    action: 'propose', title: 'Wikipedia Article Lookup', call: wikiCall() },
  // wikifv1 session: records keyed by page id.
  { diagnosis: 'Same API, default format.',
    action: 'propose', title: 'Wikipedia Article Lookup (v1)', call: wikiCall('&format=1') },
  // wikipart session: round 1 forgets the extract, round 2 adds it.
  { diagnosis: 'Page info should be enough.',
    action: 'propose', title: 'Wikipedia Article Lookup', call: wikiCall('&prop=info') },
  { diagnosis: 'The intro text needs the extracts prop.',
    action: 'propose', title: 'Wikipedia Article Lookup', call: wikiCall() },
  // wikistop session: round 1 partial, round 2 gives up — the partial is kept.
  { diagnosis: 'Page info should be enough.',
    action: 'propose', title: 'Wikipedia Article Lookup', call: wikiCall('&prop=info') },
  { diagnosis: 'No API returns the intro text.',
    action: 'stop', advice: 'Re-record marking only the title.' },
  // wikisum session: a single-record summary response.
  { diagnosis: 'The summary endpoint returns the title and intro directly.',
    action: 'propose', title: 'Wikipedia Summary', call: { ...wikiCall(), url: `${SITE}/api/summary/{{query}}` } },
  // jsonp session refined without marks: the model stops, the spec stays.
  { diagnosis: 'The saved call already returns the clicked result.',
    action: 'stop', advice: 'Describe what is wrong with the result.' },
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

// The Wikipedia shape: typed input, JSONP typeahead, a click through to a
// server-rendered article, two marks on it — the title, and an intro
// paragraph carrying citation markers the API's plain text will not have.
const INTRO_MARK = 'English is a West Germanic language of the Indo-European language family that emerged in early medieval England and has since become a global lingua franca.[4][5][6] The language is named after the Angles, one of the Germanic peoples who migrated to Britain.';
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

async function repair(session, body) {
  const text = await fetch(`${BACKEND}/api/sessions/${session}/repair`, body === undefined ? { method: 'POST' } : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.text());
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
const readSpec = (session) => JSON.parse(readFileSync(join(dataDir, session, 'spec.json'), 'utf8'));
async function recordWiki(session) {
  await api('/api/sessions', { session, hosts: ['127.0.0.1'], startedAt: 1 });
  await api(`/api/sessions/${session}/events`, { items: wikiEvents() });
  return api(`/api/sessions/${session}/stop`, {});
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

  // Scenario 4: marks decide the rows and become the columns. The bookkeeping
  // array (normalized) is listed first and has one entry, like the records;
  // evidence must pick the records, and the citation-marked paragraph must
  // still match the plain-text extract.
  const wikiStop = await recordWiki('wiki');
  check('wiki recording refuses deterministically', wikiStop.spec === false);
  const wikiLines = await repair('wiki');
  const wikiOk = wikiLines.find((l) => l.kind === 'ok');
  check('wiki: verified in one round with both marked columns',
    kinds(wikiLines).includes('saved') && /columns from your marked selections: title, extract/.test(wikiOk?.text ?? ''),
    JSON.stringify(wikiLines));
  const wikiSpec = readSpec('wiki');
  check('wiki: rows are the page records, not the normalisation echo',
    wikiSpec.outcome.extract.records === 'query.pages', wikiSpec.outcome.extract.records);
  check('wiki: columns are row-scoped title and extract',
    JSON.stringify(wikiSpec.outcome.columns) === JSON.stringify([
      { name: 'title', path: 'title', scope: 'row' }, { name: 'extract', path: 'extract', scope: 'row' }]),
    JSON.stringify(wikiSpec.outcome.columns));
  const french = await api('/api/sessions/wiki/run', { params: { query: 'French Language' } });
  const frenchRow = french.extracted?.records?.rows?.[0];
  check('wiki: a new input returns exactly the marked fields',
    french.ok && french.extracted.records.rows.length === 1 &&
    JSON.stringify(Object.keys(frenchRow)) === '["title","extract"]' &&
    frenchRow.title === 'French language' && frenchRow.extract.startsWith('French is a Romance'),
    french.stoppedReason ?? JSON.stringify(french.extracted));

  // Scenario 5: refine a saved automation whose extraction was wrong (the
  // very spec the first live repair produced): the run returns nothing
  // useful, the operator flags it, the loop replaces it.
  await recordWiki('wikiold');
  const wrong = {
    ...wikiSpec, name: 'wikiold', outcome: { fromStep: 'search', expect: { path: '__http_ok', equals: 'true' }, extract: { records: 'query.normalized' } },
    repaired: { at: '2026-09-01T21:57:22.687Z', model: 'claude-opus-5', diagnosis: 'JSONP typeahead.' },
  };
  writeFileSync(join(dataDir, 'wikiold', 'spec.json'), JSON.stringify(wrong));
  const wrongRun = await api('/api/sessions/wikiold/run', { params: { query: 'French Language' } });
  check('a records path the response lacks yields no rows, not the whole body',
    wrongRun.ok && wrongRun.extracted?.records?.count === 0, JSON.stringify(wrongRun.extracted));
  const lastRun = { params: { query: 'French Language' }, ok: true, rowCount: 0, columns: [] };
  const refineLines = await repair('wikiold', { feedback: 'I only want the article text', lastRun });
  check('refine: console shows the saved automation and the note',
    refineLines.some((l) => l.kind === 'info' && /Refining the saved automation/.test(l.text)) &&
    refineLines.some((l) => l.kind === 'info' && /Your note: I only want the article text/.test(l.text)),
    JSON.stringify(refineLines));
  check('refine: verified and updated', refineLines.some((l) => l.kind === 'saved' && /Automation updated/.test(l.text)),
    JSON.stringify(refineLines));
  const refinePack = llmRequests.map((r) => JSON.stringify(r)).find((r) => r.includes('Mode: REFINE')) ?? '';
  check('refine: model saw the current automation, the last run and the note',
    refinePack.includes('query.normalized') && refinePack.includes('0 row(s)') && refinePack.includes('I only want the article text'));
  const refined = readSpec('wikiold');
  check('refine: provenance records the mode and the note',
    refined.repaired?.mode === 'refine' && refined.repaired?.feedback === 'I only want the article text' &&
    refined.outcome.columns?.length === 2, JSON.stringify(refined.repaired));
  const refinedRun = await api('/api/sessions/wikiold/run', { params: { query: 'French Language' } });
  check('refine: the flagged input now returns the marked fields',
    refinedRun.ok && refinedRun.extracted?.records?.rows?.[0]?.extract?.startsWith('French is a Romance') &&
    Object.keys(refinedRun.extracted.records.rows[0]).length === 2,
    refinedRun.stoppedReason ?? JSON.stringify(refinedRun.extracted));
  const refinedPage = await fetch(`${BACKEND}/session/wikiold`).then((r) => r.text());
  check('refine: session page shows the refinement provenance', refinedPage.includes('Refined by the LLM repair assistant'));

  // Scenario 6: records keyed by id (MediaWiki format=1) are rows too.
  await recordWiki('wikifv1');
  const fv1Lines = await repair('wikifv1');
  check('id-keyed records: verified as rows', fv1Lines.some((l) => l.kind === 'ok' && /1 row\(s\) at query\.pages/.test(l.text)),
    JSON.stringify(fv1Lines));
  const fv1Run = await api('/api/sessions/wikifv1/run', { params: { query: 'french language' } });
  check('id-keyed records: replay returns the marked fields per record',
    fv1Run.ok && fv1Run.extracted?.records?.rows?.[0]?.title === 'French language' &&
    fv1Run.extracted.records.rows[0].extract?.startsWith('French is a Romance'),
    fv1Run.stoppedReason ?? JSON.stringify(fv1Run.extracted));

  // Scenario 7: a response carrying only some marks is fed back; the next
  // round completes it.
  await recordWiki('wikipart');
  const partLines = await repair('wikipart');
  check('partial marks: round 1 fed back with the missing selection',
    partLines.some((l) => l.kind === 'fail' && /1 of 2 marked selections located; missing: "english is a west germanic/.test(l.text)),
    JSON.stringify(partLines));
  check('partial marks: round 2 completes both columns',
    partLines.some((l) => l.kind === 'saved') && readSpec('wikipart').outcome.columns?.length === 2);

  // Scenario 8: the model gives up after a partial hit — the partial is kept.
  await recordWiki('wikistop');
  const stopLines = await repair('wikistop');
  check('partial then stop: best verified attempt kept',
    stopLines.some((l) => l.kind === 'saved' && /kept the best verified attempt: 1 of 2/.test(l.text)) &&
    readSpec('wikistop').outcome.columns?.length === 1, JSON.stringify(stopLines));

  // Scenario 9: a single-record response is the record; the URL map inside
  // it is not the row set.
  await recordWiki('wikisum');
  const sumLines = await repair('wikisum');
  check('single record: verified as one row, no stray rows path',
    sumLines.some((l) => l.kind === 'ok' && /1 row\(s\), carrying/.test(l.text)) &&
    JSON.stringify(readSpec('wikisum').outcome.extract) === '{}', JSON.stringify(sumLines));
  const sumRun = await api('/api/sessions/wikisum/run', { params: { query: 'French language' } });
  check('single record: replay returns one row with the marked fields',
    sumRun.ok && sumRun.extracted?.records?.rows?.length === 1 &&
    JSON.stringify(Object.keys(sumRun.extracted.records.rows[0])) === '["title","extract"]' &&
    sumRun.extracted.records.rows[0].title === 'French language',
    sumRun.stoppedReason ?? JSON.stringify(sumRun.extracted));

  // Scenario 10: refining without marks or a better idea leaves the spec alone.
  const before = readSpec('jsonp');
  const noBetter = await repair('jsonp', { feedback: 'rows look odd' });
  check('refine with no better proposal leaves the saved spec unchanged',
    noBetter.some((l) => l.kind === 'done' && /saved one is unchanged/.test(l.text)) &&
    JSON.stringify(readSpec('jsonp')) === JSON.stringify(before), JSON.stringify(noBetter));
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
