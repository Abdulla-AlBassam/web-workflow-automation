// P1 feature suite: pagination detection + fetch-all replay, and sequential
// runs (the server side of bulk). Fixture-driven. Run: node e2e/enhancements.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BACKEND = 'http://127.0.0.1:4823';
const MOCK = 'http://127.0.0.1:4980';
const failures = [];
function check(name, cond, detail = '') {
  console.log(`${cond ? '  ok ' : 'FAIL'} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) failures.push(name);
}
async function wait(u) { for (let i = 0; i < 60; i++) { try { if ((await fetch(u)).ok) return; } catch {} await new Promise((r) => setTimeout(r, 150)); } throw new Error('timeout ' + u); }
const api = (path, body) => fetch(`${BACKEND}${path}`, body === undefined ? {} : {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json());

const dataDir = mkdtempSync(join(tmpdir(), 'wfr-enh-'));
const procs = [
  spawn('npx', ['tsx', 'backend/src/server.ts'], { cwd: process.cwd(), env: { ...process.env, DATA_DIR: dataDir }, stdio: 'ignore' }),
  spawn('node', ['fixtures/serve.mjs'], { cwd: process.cwd(), stdio: 'ignore' }),
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
} catch (err) {
  check('harness ran to completion', false, String(err));
} finally {
  for (const p of procs) p.kill();
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASS');
process.exit(failures.length ? 1 : 0);
