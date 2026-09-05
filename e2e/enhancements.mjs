// P1 feature suite: pagination detection + fetch-all replay, and sequential
// runs (the server side of bulk). Fixture-driven. Run: node e2e/enhancements.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Dedicated ports: the suite must never talk to an interactively running
// backend (npm run backend) or its data directory.
const BACKEND_PORT = 4891;
const MOCK_PORT = 4981;
const BACKEND = `http://127.0.0.1:${BACKEND_PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
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
await ensureFree(MOCK_PORT);

const dataDir = mkdtempSync(join(tmpdir(), 'wfr-enh-'));
// The backend is spawned as node itself, not through npx: killing an npx
// wrapper leaves its child running and the next suite finds the port busy.
const procs = [
  spawn(process.execPath, ['--import', 'tsx', 'backend/src/server.ts'], { cwd: process.cwd(), env: { ...process.env, DATA_DIR: dataDir, PORT: String(BACKEND_PORT) }, stdio: 'ignore' }),
  spawn('node', ['fixtures/serve.mjs'], { cwd: process.cwd(), env: { ...process.env, PORT: String(MOCK_PORT) }, stdio: 'ignore' }),
];

try {
  await wait(`${BACKEND}/health`);
  await wait(`${MOCK}/`);

  // A recording of a "trading" name search: the mock paginates at 2/page and
  // holds 5 matching companies, so fetch-all must make 3 calls.
  await api('/api/sessions', { session: 'enh', hosts: ['127.0.0.1'], startedAt: 1 });
  await api('/api/sessions/enh/events', { items: [
    { kind: 'session_start', seq: 0 },
    { kind: 'page', url: `${MOCK}/`, lang: 'en', seq: 1 },
    { kind: 'action', action: 'input', value: 'trading', target: { id: 'cr_name_en' }, seq: 2 },
    { kind: 'net', method: 'POST', url: `${MOCK}/api/CRdetails/AdvanceSearchCR_Paging`, status: 200,
      reqBody: JSON.stringify({ CR_NAME_EN: 'trading', PAGE: 1 }),
      resBody: JSON.stringify({ TOTAL: 5, RECORDS: [{ CR_NO: '139867', NAME_EN: 'Awal Trading Co. W.L.L' }, { CR_NO: '91230', NAME_EN: 'Delmon Trading W.L.L' }] }), seq: 3 },
    { kind: 'session_stop', seq: 4 },
  ]});
  const stop = await api('/api/sessions/enh/stop', {});
  check('stop auto-generates the spec', stop.spec === true);

  const spec = await api('/api/sessions/enh/spec', {});
  check('pagination detected', spec.outcome?.pagination?.pagePath === 'PAGE', JSON.stringify(spec.outcome?.pagination));
  check('total path generalised', spec.outcome?.extract?.total === 'TOTAL', spec.outcome?.extract?.total);

  const res = await api('/api/sessions/enh/run', { params: { cr_name_en: 'trading' } });
  check('paginated run succeeds', res.ok, res.stoppedReason);
  check('all pages fetched', res.extracted?.records?.count === 5 && res.extracted?.records?.rows?.length === 5,
    `count=${res.extracted?.records?.count}`);
  check('pagination step reported', res.steps?.some((s) => s.type === 'pagination'), JSON.stringify(res.steps));

  // Single-result run: no pagination step, one row, full rows present.
  const one = await api('/api/sessions/enh/run', { params: { cr_name_en: 'manama foods' } });
  check('single-page run has no pagination step', one.ok && !one.steps.some((s) => s.type === 'pagination'));
  check('rows carry the full record', one.extracted?.records?.rows?.[0]?.NAME_EN === 'Manama Foods B.S.C');

  // Sequential runs, the server side of bulk: distinct inputs, distinct rows.
  const values = ['gulf line', 'isa town'];
  const results = [];
  for (const v of values) results.push(await api('/api/sessions/enh/run', { params: { cr_name_en: v } }));
  check('sequential bulk-style runs all succeed', results.every((r) => r.ok));
  check('bulk rows are input-specific',
    results[0].extracted.records.rows[0].NAME_EN.includes('Gulf Line') &&
    results[1].extracted.records.rows[0].NAME_EN.includes('Isa Town'));

  // GET-style workflow: the typed value travels URL-encoded in the query
  // string (the wwe.com shape), no request body at all.
  await api('/api/sessions', { session: 'urly', hosts: ['127.0.0.1'], startedAt: 1 });
  await api('/api/sessions/urly/events', { items: [
    { kind: 'session_start', seq: 0 },
    { kind: 'page', url: `${MOCK}/`, lang: 'en', seq: 1 },
    { kind: 'action', action: 'input', value: 'gulf line', target: { id: 'cr_name_en' }, seq: 2 },
    { kind: 'net', method: 'GET', url: `${MOCK}/api/urlsearch?q=gulf%20line`, status: 200,
      resBody: JSON.stringify({ TOTAL: 1, RECORDS: [{ CR_NO: '20775', NAME_EN: 'Gulf Line Logistics' }] }), seq: 3 },
    { kind: 'session_stop', seq: 4 },
  ]});
  await api('/api/sessions/urly/stop', {});
  const urlSpec = await api('/api/sessions/urly/spec', {});
  check('URL-borne value produces a spec', !!urlSpec.steps, urlSpec.error);
  check('URL is templatised', urlSpec.steps?.at(-1)?.url?.includes('{{cr_name_en}}'), urlSpec.steps?.at(-1)?.url);
  check('GET step has no body', urlSpec.steps?.at(-1)?.bodyTemplate === undefined);
  const urlRun = await api('/api/sessions/urly/run', { params: { cr_name_en: 'isa town' } });
  check('GET replay with encoded new input works', urlRun.ok && urlRun.extracted?.records?.rows?.[0]?.NAME_EN === 'Isa Town Trading Co.',
    urlRun.stoppedReason ?? JSON.stringify(urlRun.extracted?.records?.rows?.[0]));

  // Multi-parameter workflow: two typed values, both landing in the request
  // body, must yield two parameters and a run that honours both.
  await api('/api/sessions', { session: 'multi', hosts: ['127.0.0.1'], startedAt: 1 });
  await api('/api/sessions/multi/events', { items: [
    { kind: 'session_start', seq: 0 },
    { kind: 'page', url: `${MOCK}/`, lang: 'en', seq: 1 },
    { kind: 'action', action: 'input', value: '139867', target: { id: 'cr_number' }, seq: 2 },
    { kind: 'action', action: 'input', value: 'trading', target: { id: 'cr_name_en' }, seq: 3 },
    { kind: 'net', method: 'POST', url: `${MOCK}/api/CRdetails/AdvanceSearchCR_Paging`, status: 200,
      reqBody: JSON.stringify({ CR_NO: '139867', CR_NAME_EN: 'trading', PAGE: 1 }),
      resBody: JSON.stringify({ TOTAL: 1, RECORDS: [{ CR_NO: '139867', NAME_EN: 'Awal Trading Co. W.L.L' }] }), seq: 4 },
    { kind: 'session_stop', seq: 5 },
  ]});
  await api('/api/sessions/multi/stop', {});
  const multiSpec = await api('/api/sessions/multi/spec', {});
  check('two typed values become two parameters',
    multiSpec.parameters?.length === 2 &&
    multiSpec.parameters.some((p) => p.name === 'cr_number') &&
    multiSpec.parameters.some((p) => p.name === 'cr_name_en'),
    JSON.stringify(multiSpec.parameters));
  const multiRun = await api('/api/sessions/multi/run', { params: { cr_number: '84121', cr_name_en: 'manama' } });
  check('multi-parameter run honours both values',
    multiRun.ok && multiRun.extracted?.records?.rows?.[0]?.NAME_EN === 'Manama Foods B.S.C',
    multiRun.stoppedReason ?? JSON.stringify(multiRun.extracted?.records?.rows));
  const multiMiss = await api('/api/sessions/multi/run', { params: { cr_number: '84121' } });
  check('missing second parameter stops the run',
    !multiMiss.ok && /missing required parameter/.test(multiMiss.stoppedReason ?? ''), multiMiss.stoppedReason);

  // Marked selections become columns: the operator highlighted one field, so
  // runs return exactly that field per row, generalised to new inputs.
  await api('/api/sessions', { session: 'marked', hosts: ['127.0.0.1'], startedAt: 1 });
  await api('/api/sessions/marked/events', { items: [
    { kind: 'session_start', seq: 0 },
    { kind: 'page', url: `${MOCK}/`, lang: 'en', seq: 1 },
    { kind: 'action', action: 'input', value: 'gulf line', target: { id: 'cr_name_en' }, seq: 2 },
    { kind: 'net', method: 'GET', url: `${MOCK}/api/urlsearch?q=gulf%20line`, status: 200,
      resBody: JSON.stringify({ TOTAL: 1, RECORDS: [{ CR_NO: '20775', NAME_EN: 'Gulf Line Logistics', STATUS: 'DELETED' }] }), seq: 3 },
    { kind: 'action', action: 'mark', text: 'Gulf Line Logistics', seq: 4 },
    { kind: 'session_stop', seq: 5 },
  ]});
  await api('/api/sessions/marked/stop', {});
  const markedSpec = await api('/api/sessions/marked/spec', {});
  check('marked value becomes a row-scoped column',
    markedSpec.outcome?.columns?.length === 1 &&
    markedSpec.outcome.columns[0].path === 'NAME_EN' &&
    markedSpec.outcome.columns[0].scope === 'row',
    JSON.stringify(markedSpec.outcome?.columns));
  const markedRun = await api('/api/sessions/marked/run', { params: { cr_name_en: 'isa town' } });
  check('run projects rows to the marked column only',
    markedRun.ok &&
    markedRun.extracted?.records?.rows?.length === 1 &&
    markedRun.extracted.records.rows[0].NAME_EN === 'Isa Town Trading Co.' &&
    Object.keys(markedRun.extracted.records.rows[0]).length === 1,
    markedRun.stoppedReason ?? JSON.stringify(markedRun.extracted?.records?.rows));

  // A selection dragged across several cells of one row picks those columns,
  // in the order seen; a marked header row is labels, not data, and is
  // ignored rather than defeating the projection.
  await api('/api/sessions', { session: 'rowmark', hosts: ['127.0.0.1'], startedAt: 1 });
  await api('/api/sessions/rowmark/events', { items: [
    { kind: 'session_start', seq: 0 },
    { kind: 'page', url: `${MOCK}/`, lang: 'en', seq: 1 },
    { kind: 'action', action: 'input', value: 'gulf line', target: { id: 'cr_name_en' }, seq: 2 },
    { kind: 'net', method: 'GET', url: `${MOCK}/api/urlsearch?q=gulf%20line`, status: 200,
      resBody: JSON.stringify({ TOTAL: 1, RECORDS: [{ CR_NO: '20775', BRANCH: '1', NAME_EN: 'Gulf Line Logistics', NAME_AR: 'الخط الخليجي', STATUS: 'DELETED', TYPE: 'WLL' }] }), seq: 3 },
    { kind: 'action', action: 'mark', text: 'CR No. Commercial Name (EN) Status', target: { tag: 'th' }, seq: 4 },
    { kind: 'action', action: 'mark', text: '20775-1 Gulf Line Logistics DELETED', seq: 5 },
    { kind: 'session_stop', seq: 6 },
  ]});
  await api('/api/sessions/rowmark/stop', {});
  const rowmarkSpec = await api('/api/sessions/rowmark/spec', {});
  check('a row-wide selection becomes its cells\' columns, in order; the header mark is ignored',
    JSON.stringify((rowmarkSpec.outcome?.columns ?? []).map((c) => c.path)) === '["CR_NO","NAME_EN","STATUS"]',
    JSON.stringify(rowmarkSpec.outcome?.columns));
  const rowmarkRun = await api('/api/sessions/rowmark/run', { params: { cr_name_en: 'isa town' } });
  check('row-wide selection: runs return exactly those columns',
    rowmarkRun.ok && JSON.stringify(Object.keys(rowmarkRun.extracted?.records?.rows?.[0] ?? {})) === '["CR_NO","NAME_EN","STATUS"]',
    rowmarkRun.stoppedReason ?? JSON.stringify(rowmarkRun.extracted?.records?.rows));

  // Chained workflow (the wwe.com shape): the search response's CR number
  // feeds a detail call, and the marked bio lives in the detail response.
  const awalBio = 'Awal Trading opened its first Manama storefront in 1978 and now supplies building materials across the Northern Governorate.';
  await api('/api/sessions', { session: 'chain', hosts: ['127.0.0.1'], startedAt: 1 });
  await api('/api/sessions/chain/events', { items: [
    { kind: 'session_start', seq: 0 },
    { kind: 'page', url: `${MOCK}/`, lang: 'en', seq: 1 },
    { kind: 'action', action: 'input', value: 'awal', target: { id: 'cr_name_en' }, seq: 2 },
    { kind: 'net', method: 'POST', url: `${MOCK}/api/CRdetails/AdvanceSearchCR_Paging`, status: 200,
      reqBody: JSON.stringify({ CR_NAME_EN: 'awal', PAGE: 1 }),
      resBody: JSON.stringify({ TOTAL: 1, RECORDS: [{ CR_NO: '139867', NAME_EN: 'Awal Trading Co. W.L.L' }] }), seq: 3 },
    { kind: 'action', action: 'click', target: { tag: 'a', text: 'Awal Trading Co. W.L.L' }, seq: 4 },
    { kind: 'net', method: 'GET', url: `${MOCK}/api/company/139867`, status: 200,
      resBody: JSON.stringify({ CR_NO: '139867', NAME_EN: 'Awal Trading Co. W.L.L', STATUS: 'ACTIVE', BIO: awalBio }), seq: 5 },
    { kind: 'action', action: 'mark', text: 'Awal Trading Co. W.L.L', seq: 6 },
    { kind: 'action', action: 'mark', text: awalBio, seq: 7 },
    { kind: 'session_stop', seq: 8 },
  ]});
  await api('/api/sessions/chain/stop', {});
  const chainSpec = await api('/api/sessions/chain/spec', {});
  const detailStep = chainSpec.steps?.find((s) => s.link);
  check('chain detected: detail step follows the search',
    !!detailStep && detailStep.link.rowsPath === 'RECORDS' && detailStep.link.path === 'CR_NO' &&
    detailStep.url.includes('{{link}}'),
    JSON.stringify(chainSpec.steps));
  check('outcome moves to the chained call with marked columns',
    chainSpec.outcome?.fromStep === 'detail' &&
    chainSpec.outcome.columns?.some((c) => c.path === 'BIO') &&
    chainSpec.outcome.columns?.some((c) => c.path === 'NAME_EN'),
    JSON.stringify(chainSpec.outcome));
  const chainRun = await api('/api/sessions/chain/run', { params: { cr_name_en: 'manama' } });
  check('chained replay resolves the link for a new input',
    chainRun.ok &&
    chainRun.extracted?.records?.rows?.[0]?.NAME_EN === 'Manama Foods B.S.C' &&
    /cold-storage/.test(chainRun.extracted.records.rows[0].BIO ?? ''),
    chainRun.stoppedReason ?? JSON.stringify(chainRun.extracted?.records?.rows));
  const chainMiss = await api('/api/sessions/chain/run', { params: { cr_name_en: 'zzz-no-such' } });
  check('empty search stops the chain with a named reason',
    !chainMiss.ok && /no records at RECORDS/.test(chainMiss.stoppedReason ?? ''), chainMiss.stoppedReason);

  // Server-rendered outcome (the real wwe.com bio shape): the marked bio
  // exists only in the page HTML, so the spec gains a browser-extract step
  // that follows the link and reads the marked elements. The name mark ALSO
  // appears in the search API response — the page must still win.
  await api('/api/sessions', { session: 'pagex', hosts: ['127.0.0.1'], startedAt: 1 });
  await api('/api/sessions/pagex/events', { items: [
    { kind: 'session_start', seq: 0 },
    { kind: 'page', url: `${MOCK}/`, lang: 'en', seq: 1 },
    { kind: 'action', action: 'input', value: 'awal', target: { id: 'cr_name_en' }, seq: 2 },
    { kind: 'net', method: 'POST', url: `${MOCK}/api/CRdetails/AdvanceSearchCR_Paging`, status: 200,
      reqBody: JSON.stringify({ CR_NAME_EN: 'awal', PAGE: 1 }),
      resBody: JSON.stringify({ TOTAL: 1, RECORDS: [{ CR_NO: '139867', NAME_EN: 'Awal Trading Co. W.L.L' }] }), seq: 3 },
    { kind: 'action', action: 'click', target: { tag: 'a', text: 'page' }, seq: 4 },
    { kind: 'nav', url: `${MOCK}/company/139867`, seq: 5 },
    { kind: 'action', action: 'mark', text: 'Awal Trading Co. W.L.L', target: { id: 'co_name', tag: 'h1', selector: '#co_name' }, seq: 6 },
    { kind: 'action', action: 'mark', text: awalBio, target: { id: 'co_bio', tag: 'p', selector: '#co_bio' }, seq: 7 },
    { kind: 'session_stop', seq: 8 },
  ]});
  await api('/api/sessions/pagex/stop', {});
  const pageSpec = await api('/api/sessions/pagex/spec', {});
  const exStep = pageSpec.steps?.find((s) => s.type === 'browser-extract');
  check('server-rendered outcome gains a browser-extract step',
    !!exStep && exStep.url.includes('{{link}}') && exStep.extracts?.length === 2 && exStep.link?.rowsPath === 'RECORDS',
    JSON.stringify(pageSpec.steps));
  check('marked page elements become columns',
    pageSpec.outcome?.fromStep === 'extract' &&
    pageSpec.outcome.columns?.map((c) => c.name).join(',') === 'co_name,co_bio',
    JSON.stringify(pageSpec.outcome));
  const pageRun = await api('/api/sessions/pagex/run', { params: { cr_name_en: 'manama' } });
  check('browser-extract replay reads a new company page',
    pageRun.ok &&
    pageRun.extracted?.records?.rows?.[0]?.co_name === 'Manama Foods B.S.C' &&
    /cold-storage/.test(pageRun.extracted.records.rows[0].co_bio ?? ''),
    pageRun.stoppedReason ?? JSON.stringify(pageRun.extracted?.records?.rows));

  // A marked element that no longer exists on the page stops the run with a
  // named reason instead of returning a hollow row.
  const pagexSpecPath = join(dataDir, 'pagex', 'spec.json');
  const px = JSON.parse(readFileSync(pagexSpecPath, 'utf8'));
  px.steps.find((s) => s.type === 'browser-extract').extracts[1].selector = '#gone';
  writeFileSync(pagexSpecPath, JSON.stringify(px));
  const pageMiss = await api('/api/sessions/pagex/run', { params: { cr_name_en: 'manama' } });
  check('missing marked element stops the run',
    !pageMiss.ok && /nothing at selector "#gone"/.test(pageMiss.stoppedReason ?? ''), pageMiss.stoppedReason);

  // A link living in a nested list that is NOT the record set (the wwe.com
  // group.items shape) still becomes row-relative, not a fixed recorded index.
  await api('/api/sessions', { session: 'nested', hosts: ['127.0.0.1'], startedAt: 1 });
  await api('/api/sessions/nested/events', { items: [
    { kind: 'session_start', seq: 0 },
    { kind: 'page', url: `${MOCK}/`, lang: 'en', seq: 1 },
    { kind: 'action', action: 'input', value: 'awal', target: { id: 'cr_name_en' }, seq: 2 },
    { kind: 'net', method: 'POST', url: `${MOCK}/api/CRdetails/AdvanceSearchCR_Paging`, status: 200,
      reqBody: JSON.stringify({ CR_NAME_EN: 'awal', PAGE: 1 }),
      resBody: JSON.stringify({ TOTAL: 1, RECORDS: [{ NAME_EN: 'Awal Trading Co. W.L.L' }],
        REFS: { hits: [{ id: '139867' }] } }), seq: 3 },
    { kind: 'action', action: 'click', target: { tag: 'a' }, seq: 4 },
    { kind: 'net', method: 'GET', url: `${MOCK}/api/company/139867`, status: 200,
      resBody: JSON.stringify({ CR_NO: '139867', NAME_EN: 'Awal Trading Co. W.L.L', BIO: awalBio }), seq: 5 },
    { kind: 'action', action: 'mark', text: awalBio, seq: 6 },
    { kind: 'session_stop', seq: 7 },
  ]});
  await api('/api/sessions/nested/stop', {});
  const nestedSpec = await api('/api/sessions/nested/spec', {});
  const nestedLink = nestedSpec.steps?.find((s) => s.link)?.link;
  check('nested-list link is row-relative',
    nestedLink?.rowsPath === 'REFS.hits' && nestedLink?.path === 'id', JSON.stringify(nestedLink));

  // Composite-string correlation (the Algolia shape): the typed value hides
  // URL-encoded inside one string field; the spec splices an encoding-aware
  // placeholder and the replay re-encodes the new input the same way.
  await api('/api/sessions', { session: 'embed', hosts: ['127.0.0.1'], startedAt: 1 });
  await api('/api/sessions/embed/events', { items: [
    { kind: 'session_start', seq: 0 },
    { kind: 'page', url: `${MOCK}/`, lang: 'en', seq: 1 },
    { kind: 'action', action: 'input', value: 'gulf line', target: { id: 'q' }, seq: 2 },
    { kind: 'net', method: 'POST', url: `${MOCK}/api/bundle/search`, status: 200,
      reqBody: JSON.stringify({ indexName: 'companies', params: 'query=gulf%20line&hitsPerPage=30&page=0' }),
      resBody: JSON.stringify({ nbHits: 1, hits: [{ CR_NO: '20775', NAME_EN: 'Gulf Line Logistics' }] }), seq: 3 },
    { kind: 'session_stop', seq: 4 },
  ]});
  await api('/api/sessions/embed/stop', {});
  const embSpec = await api('/api/sessions/embed/spec', {});
  check('embedded value spliced with an encoding-aware placeholder',
    embSpec.steps?.at(-1)?.bodyTemplate?.params === 'query={{enc:query}}&hitsPerPage=30&page=0',
    JSON.stringify(embSpec.steps?.at(-1)?.bodyTemplate));
  const embRun = await api('/api/sessions/embed/run', { params: { query: 'isa town' } });
  check('embedded replay re-encodes the new input',
    embRun.ok && embRun.extracted?.records?.rows?.[0]?.NAME_EN === 'Isa Town Trading Co.',
    embRun.stoppedReason ?? JSON.stringify(embRun.extracted?.records?.rows));

  // Plus-encoded variant of the same shape keeps its own encoding.
  await api('/api/sessions', { session: 'embplus', hosts: ['127.0.0.1'], startedAt: 1 });
  await api('/api/sessions/embplus/events', { items: [
    { kind: 'session_start', seq: 0 },
    { kind: 'page', url: `${MOCK}/`, lang: 'en', seq: 1 },
    { kind: 'action', action: 'input', value: 'gulf line', target: { id: 'q' }, seq: 2 },
    { kind: 'net', method: 'POST', url: `${MOCK}/api/bundle/search`, status: 200,
      reqBody: JSON.stringify({ params: 'query=gulf+line&page=0' }),
      resBody: JSON.stringify({ nbHits: 1, hits: [{ CR_NO: '20775', NAME_EN: 'Gulf Line Logistics' }] }), seq: 3 },
    { kind: 'session_stop', seq: 4 },
  ]});
  await api('/api/sessions/embplus/stop', {});
  const plusSpec = await api('/api/sessions/embplus/spec', {});
  check('plus-encoded embedding keeps its encoding',
    plusSpec.steps?.at(-1)?.bodyTemplate?.params === 'query={{plus:query}}&page=0',
    JSON.stringify(plusSpec.steps?.at(-1)?.bodyTemplate));

  // Word boundaries: "art" inside "smart" is not a correlation, so the
  // session has no outcome and refuses to generate a spec.
  await api('/api/sessions', { session: 'embx', hosts: ['127.0.0.1'], startedAt: 1 });
  await api('/api/sessions/embx/events', { items: [
    { kind: 'session_start', seq: 0 },
    { kind: 'page', url: `${MOCK}/`, lang: 'en', seq: 1 },
    { kind: 'action', action: 'input', value: 'art', target: { id: 'q' }, seq: 2 },
    { kind: 'net', method: 'POST', url: `${MOCK}/api/bundle/search`, status: 200,
      reqBody: JSON.stringify({ params: 'query=smart&page=0' }),
      resBody: JSON.stringify({ nbHits: 1, hits: [{ NAME_EN: 'Smart Co.' }] }), seq: 3 },
    { kind: 'session_stop', seq: 4 },
  ]});
  const embxStop = await api('/api/sessions/embx/stop', {});
  check('embedded matching respects word boundaries', embxStop.spec === false);

  // An exact field match wins outright: no embedded fallback touches other
  // strings that happen to contain the same value.
  await api('/api/sessions', { session: 'embp', hosts: ['127.0.0.1'], startedAt: 1 });
  await api('/api/sessions/embp/events', { items: [
    { kind: 'session_start', seq: 0 },
    { kind: 'page', url: `${MOCK}/`, lang: 'en', seq: 1 },
    { kind: 'action', action: 'input', value: 'trading', target: { id: 'cr_name_en' }, seq: 2 },
    { kind: 'net', method: 'POST', url: `${MOCK}/api/CRdetails/AdvanceSearchCR_Paging`, status: 200,
      reqBody: JSON.stringify({ CR_NAME_EN: 'trading', ECHO: 'query=trading&x=1', PAGE: 1 }),
      resBody: JSON.stringify({ TOTAL: 1, RECORDS: [{ CR_NO: '139867', NAME_EN: 'Awal Trading Co. W.L.L' }] }), seq: 3 },
    { kind: 'session_stop', seq: 4 },
  ]});
  await api('/api/sessions/embp/stop', {});
  const embpSpec = await api('/api/sessions/embp/spec', {});
  check('exact field match wins over embedded fallback',
    embpSpec.steps?.at(-1)?.bodyTemplate?.CR_NAME_EN === '{{cr_name_en}}' &&
    embpSpec.steps?.at(-1)?.bodyTemplate?.ECHO === 'query=trading&x=1',
    JSON.stringify(embpSpec.steps?.at(-1)?.bodyTemplate));

  // A spec saved by an older generator (no pagination, old version) must be
  // regenerated before use, not executed as-is.
  const specPath = join(dataDir, 'enh', 'spec.json');
  const stale = JSON.parse(readFileSync(specPath, 'utf8'));
  stale.version = 1;
  delete stale.outcome.pagination;
  writeFileSync(specPath, JSON.stringify(stale));
  const upgraded = await api('/api/sessions/enh/run', { params: { cr_name_en: 'trading' } });
  check('stale spec regenerated on run', upgraded.ok && upgraded.extracted?.records?.count === 5,
    `count=${upgraded.extracted?.records?.count}`);
  check('regenerated spec persisted', JSON.parse(readFileSync(specPath, 'utf8')).version !== 1);

  // A finished session is a reusable automation, so it can carry an operator-
  // given title. The id (directory, URLs) never changes.
  const named = await api('/api/sessions/enh/name', { name: '  Trading Name Search  ' });
  check('rename trims and saves the title', named.ok && named.name === 'Trading Name Search');
  const listed = await api('/api/sessions');
  check('list carries the title alongside the stable id',
    listed.find((s) => s.session === 'enh')?.name === 'Trading Name Search');
  const detailHtml = await fetch(`${BACKEND}/session/enh`).then((r) => r.text());
  check('session page shows the title', detailHtml.includes('Trading Name Search'));
  const cleared = await api('/api/sessions/enh/name', { name: '' });
  check('empty rename reverts to the id', cleared.ok && cleared.name === null &&
    (await api('/api/sessions')).find((s) => s.session === 'enh')?.name === undefined);

  // === Deterministic pipeline: URL-borne pagination and recorder-field noise ===

  // The page number rides in the query string rather than the body. Five
  // "trading" hits at 2 per page means the replay must make three calls.
  await api('/api/sessions', { session: 'urlpage', hosts: ['127.0.0.1'], startedAt: 1 });
  await api('/api/sessions/urlpage/events', { items: [
    { kind: 'session_start', seq: 0 },
    { kind: 'page', url: `${MOCK}/`, lang: 'en', seq: 1 },
    { kind: 'action', action: 'input', value: 'trading', target: { id: 'cr_name_en' }, seq: 2 },
    { kind: 'net', method: 'GET', url: `${MOCK}/api/urlsearch?q=trading&page=1`, status: 200,
      resBody: JSON.stringify({ TOTAL: 5, RECORDS: [{ CR_NO: '139867', NAME_EN: 'Awal Trading Co. W.L.L' }, { CR_NO: '91230', NAME_EN: 'Delmon Trading W.L.L' }] }), seq: 3 },
    { kind: 'session_stop', seq: 4 },
  ]});
  await api('/api/sessions/urlpage/stop', {});
  const urlPageSpec = await api('/api/sessions/urlpage/spec', {});
  check('URL page parameter detected as pagination',
    urlPageSpec.outcome?.pagination?.pageParam === 'page', JSON.stringify(urlPageSpec.outcome?.pagination));
  check('URL pagination keeps the page number out of the parameters',
    urlPageSpec.parameters?.length === 1 && urlPageSpec.steps?.at(-1)?.url?.endsWith('?q={{cr_name_en}}&page=1'),
    urlPageSpec.steps?.at(-1)?.url);
  const urlPageRun = await api('/api/sessions/urlpage/run', { params: { cr_name_en: 'trading' } });
  check('URL-paginated replay fetches every page',
    urlPageRun.ok && urlPageRun.extracted?.records?.count === 5 &&
    urlPageRun.steps?.some((s) => s.type === 'pagination'),
    urlPageRun.stoppedReason ?? `count=${urlPageRun.extracted?.records?.count}`);
  // Rewriting the page number re-serialises the whole query string, so a
  // value carrying a space must still reach the site as that value.
  const urlPageSpaced = await api('/api/sessions/urlpage/run', { params: { cr_name_en: ' Trading' } });
  check('URL pagination: a spaced value survives the page rewrite',
    urlPageSpaced.ok && urlPageSpaced.extracted?.records?.count === 5,
    urlPageSpaced.stoppedReason ?? `count=${urlPageSpaced.extracted?.records?.count}`);
  const urlPageOne = await api('/api/sessions/urlpage/run', { params: { cr_name_en: 'gulf line' } });
  check('URL pagination: a single-page result makes no extra call',
    urlPageOne.ok && urlPageOne.extracted?.records?.count === 1 &&
    !urlPageOne.steps.some((s) => s.type === 'pagination'),
    urlPageOne.stoppedReason ?? JSON.stringify(urlPageOne.steps));

  // A page number with no total in the response is not evidence of paging:
  // nothing would tell the replay when to stop.
  await api('/api/sessions', { session: 'urlnototal', hosts: ['127.0.0.1'], startedAt: 1 });
  await api('/api/sessions/urlnototal/events', { items: [
    { kind: 'session_start', seq: 0 },
    { kind: 'page', url: `${MOCK}/`, lang: 'en', seq: 1 },
    { kind: 'action', action: 'input', value: 'gulf line', target: { id: 'cr_name_en' }, seq: 2 },
    { kind: 'net', method: 'GET', url: `${MOCK}/api/urlsearch?q=gulf%20line&page=1`, status: 200,
      resBody: JSON.stringify({ RECORDS: [{ CR_NO: '20775', NAME_EN: 'Gulf Line Logistics' }] }), seq: 3 },
    { kind: 'session_stop', seq: 4 },
  ]});
  await api('/api/sessions/urlnototal/stop', {});
  const noTotalSpec = await api('/api/sessions/urlnototal/spec', {});
  check('a URL page number without a total is not pagination',
    !!noTotalSpec.steps && noTotalSpec.outcome?.pagination === undefined,
    JSON.stringify(noTotalSpec.outcome));

  // Mid-pagination failures stop with a named reason rather than returning a
  // short result as though it were the whole set.
  const urlPagePath = join(dataDir, 'urlpage', 'spec.json');
  const urlPageSaved = JSON.parse(readFileSync(urlPagePath, 'utf8'));
  const breakPages = (mode) => {
    const broken = structuredClone(urlPageSaved);
    broken.steps.at(-1).url += `&break=${mode}`;
    writeFileSync(urlPagePath, JSON.stringify(broken));
    return api('/api/sessions/urlpage/run', { params: { cr_name_en: 'trading' } });
  };
  const gone = await breakPages('500');
  check('a page that fails mid-pagination stops with a named reason',
    !gone.ok && /pagination failed at page 2: outcome check no longer matched \(HTTP 500\)/.test(gone.stoppedReason ?? ''),
    gone.stoppedReason);
  const notJson = await breakPages('html');
  check('a page that stops being JSON stops with a named reason',
    !notJson.ok && /pagination failed at page 2: response was not JSON/.test(notJson.stoppedReason ?? ''),
    notJson.stoppedReason);
  writeFileSync(urlPagePath, JSON.stringify(urlPageSaved));

  // A page field the API types as a string is pagination too, and the replay
  // must send a string back: the strict endpoint rejects a number outright.
  await api('/api/sessions', { session: 'strpage', hosts: ['127.0.0.1'], startedAt: 1 });
  await api('/api/sessions/strpage/events', { items: [
    { kind: 'session_start', seq: 0 },
    { kind: 'page', url: `${MOCK}/`, lang: 'en', seq: 1 },
    { kind: 'action', action: 'input', value: 'trading', target: { id: 'cr_name_en' }, seq: 2 },
    { kind: 'net', method: 'POST', url: `${MOCK}/api/strictpage`, status: 200,
      reqBody: JSON.stringify({ CR_NAME_EN: 'trading', PAGE: '1' }),
      resBody: JSON.stringify({ TOTAL: 5, RECORDS: [{ CR_NO: '139867', NAME_EN: 'Awal Trading Co. W.L.L' }, { CR_NO: '91230', NAME_EN: 'Delmon Trading W.L.L' }] }), seq: 3 },
    { kind: 'session_stop', seq: 4 },
  ]});
  await api('/api/sessions/strpage/stop', {});
  const strPageSpec = await api('/api/sessions/strpage/spec', {});
  check('a string-typed page field is pagination too',
    strPageSpec.outcome?.pagination?.pagePath === 'PAGE', JSON.stringify(strPageSpec.outcome?.pagination));
  const strPageRun = await api('/api/sessions/strpage/run', { params: { cr_name_en: 'trading' } });
  check('the replay re-issues the page as the string the recording used',
    strPageRun.ok && strPageRun.extracted?.records?.count === 5,
    strPageRun.stoppedReason ?? `count=${strPageRun.extracted?.records?.count}`);

  // The recorder's richer fields (submit forms, select labels, click HTML,
  // response headers, snapshots) are evidence for the model loops, not inputs
  // to the correlation: a malformed one must not cost a session its
  // automation, its analysis or its page.
  await api('/api/sessions', { session: 'noisy', hosts: ['127.0.0.1'], startedAt: 1 });
  await api('/api/sessions/noisy/events', { items: [
    { kind: 'session_start', seq: 0 },
    { kind: 'page', url: `${MOCK}/`, lang: 'en', seq: 1 },
    { kind: 'action', action: 'input', value: 'trading', target: { id: 'cr_name_en' }, seq: 2 },
    { kind: 'action', action: 'change', value: 'EN', label: 'English', target: { id: 'lang' }, seq: 3 },
    { kind: 'action', action: 'click', target: { id: 'go' }, html: `<div>${'x'.repeat(120_000)}</div>`, seq: 4 },
    { kind: 'action', action: 'submit', target: { id: 'f1' }, form: 'garbage', seq: 5 },
    { kind: 'action', action: 'submit', target: { id: 'f2' }, form: { method: 'POST' }, seq: 6 },
    { kind: 'snapshot', url: `${MOCK}/`, reason: 'load', text: 'Awal Trading Co. W.L.L', storage: null, seq: 7 },
    { kind: 'net', method: 'POST', url: `${MOCK}/api/CRdetails/AdvanceSearchCR_Paging`, status: 200,
      reqHeaders: { 'x-app-id': 'demo' }, resHeaders: { 'content-type': 'application/json' },
      reqBody: JSON.stringify({ CR_NAME_EN: 'trading', PAGE: 1 }),
      resBody: JSON.stringify({ TOTAL: 5, RECORDS: [{ CR_NO: '139867', NAME_EN: 'Awal Trading Co. W.L.L' }, { CR_NO: '91230', NAME_EN: 'Delmon Trading W.L.L' }] }), seq: 8 },
    { kind: 'session_stop', seq: 9 },
  ]});
  const noisyStop = await api('/api/sessions/noisy/stop', {});
  check('malformed recorder fields do not stop the analysis', noisyStop.spec === true);
  const noisyRun = await api('/api/sessions/noisy/run', { params: { cr_name_en: 'trading' } });
  check('a recording carrying them still replays',
    noisyRun.ok && noisyRun.extracted?.records?.count === 5,
    noisyRun.stoppedReason ?? `count=${noisyRun.extracted?.records?.count}`);
  const noisyPage = await fetch(`${BACKEND}/session/noisy`);
  check('its session page still renders',
    noisyPage.status === 200 && (await noisyPage.text()).includes('Timeline'), String(noisyPage.status));
  // --- snapshot cap: a chatty page must not fill a session with 600 KB page
  // states, and what the cap dropped is counted, never silent ----------------

  const snap = (seq, reason) => ({
    kind: 'snapshot', reason, url: `${MOCK}/`, title: 'Mock',
    text: `state ${seq} of the page`, html: `<p>state ${seq}</p>`, seq,
  });
  await api('/api/sessions', { session: 'snaps', hosts: ['127.0.0.1'], startedAt: 1 });
  await api('/api/sessions/snaps/events', { items: [
    { kind: 'session_start', seq: 0 },
    { kind: 'page', url: `${MOCK}/`, lang: 'en', seq: 1 },
    snap(2, 'load'),
    ...Array.from({ length: 45 }, (_, i) => snap(3 + i, 'change')),
    snap(48, 'stop'),
    { kind: 'session_stop', seq: 49 },
  ]});
  const snapped = (await fetch(`${BACKEND}/api/sessions/snaps/export`).then((r) => r.json()));
  const kept = snapped.events.filter((e) => e.kind === 'snapshot');
  // Forty against the cap (the load and 39 changes), plus the stop state,
  // which is never dropped: nothing else records how the page ended.
  check('snapshot cap keeps 40 and the final state', kept.length === 41, `kept=${kept.length}`);
  check('snapshot cap keeps the states nothing else records',
    kept[0].reason === 'load' && kept.at(-1).reason === 'stop',
    JSON.stringify([kept[0]?.reason, kept.at(-1)?.reason]));
  check('what the cap dropped is counted', snapped.meta.snapshotsDropped === 6, `dropped=${snapped.meta.snapshotsDropped}`);
  check('the sanitiser drop count is untouched by the cap', snapped.meta.dropped === 0, `dropped=${snapped.meta.dropped}`);
  const snapHtml = await fetch(`${BACKEND}/session/snaps`).then((r) => r.text());
  check('the session page says how many snapshots were dropped', snapHtml.includes('6 snapshots dropped'));

  // A session under the cap carries no count and no chip.
  await api('/api/sessions', { session: 'snapfew', hosts: ['127.0.0.1'], startedAt: 1 });
  await api('/api/sessions/snapfew/events', { items: [
    { kind: 'session_start', seq: 0 },
    { kind: 'page', url: `${MOCK}/`, lang: 'en', seq: 1 },
    snap(2, 'load'), snap(3, 'change'), snap(4, 'stop'),
    { kind: 'session_stop', seq: 5 },
  ]});
  const few = await fetch(`${BACKEND}/api/sessions/snapfew/export`).then((r) => r.json());
  check('a session under the cap keeps every snapshot',
    few.events.filter((e) => e.kind === 'snapshot').length === 3 && few.meta.snapshotsDropped === undefined,
    JSON.stringify(few.meta.snapshotsDropped));
  const fewHtml = await fetch(`${BACKEND}/session/snapfew`).then((r) => r.text());
  check('a session under the cap shows no chip', !fewHtml.includes('snapshots dropped'));
} catch (err) {
  check('harness ran to completion', false, String(err));
} finally {
  for (const p of procs) p.kill();
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASS');
process.exit(failures.length ? 1 : 0);
