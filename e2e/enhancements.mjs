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
const procs = [
  spawn('npx', ['tsx', 'backend/src/server.ts'], { cwd: process.cwd(), env: { ...process.env, DATA_DIR: dataDir, PORT: String(BACKEND_PORT) }, stdio: 'ignore' }),
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
} catch (err) {
  check('harness ran to completion', false, String(err));
} finally {
  for (const p of procs) p.kill();
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASS');
process.exit(failures.length ? 1 : 0);
