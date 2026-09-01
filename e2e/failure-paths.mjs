// Phase 3 failure-path suite. These prove the honesty claims in the proposal:
// interrupted recordings are not automatable, and a replay stops with a named
// reason when the page, endpoint, parameter or outcome does not match.
// Deterministic, fixture-driven, no live Sijilat. Run: node e2e/failure-paths.mjs
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { analyse } from '../backend/src/analyse.ts';
import { toSpec } from '../backend/src/generate.ts';
import { run } from '../runner/src/run.ts';

const MOCK_PORT = 4983; // dedicated port: never collide with an interactive mock or backend
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const failures = [];
function check(name, cond, detail = '') {
  console.log(`${cond ? '  ok ' : 'FAIL'} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) failures.push(name);
}
const noToken = async () => { throw new Error('token reader must not be called on a no-auth spec'); };

async function wait(u) { for (let i = 0; i < 60; i++) { try { if ((await fetch(u)).ok) return; } catch {} await new Promise((r) => setTimeout(r, 150)); } throw new Error('timeout ' + u); }

const busy = await fetch(`${MOCK}/`).then(() => true).catch(() => false);
if (busy) throw new Error(`port ${MOCK_PORT} already in use — stop whatever is running there before the suite`);

const mock = spawn('node', ['fixtures/serve.mjs'], { cwd: process.cwd(), env: { ...process.env, PORT: String(MOCK_PORT) }, stdio: 'ignore' });
try {
  await wait(`${MOCK}/`);

  // Build a clean mock spec once, by analysing a synthetic complete trace.
  const baseTrace = {
    meta: { session: 'synthetic', status: 'complete' },
    events: [
      { kind: 'session_start', seq: 0 },
      { kind: 'page', url: `${MOCK}/`, lang: 'en', seq: 1 },
      { kind: 'action', action: 'input', value: '139867', target: { id: 'cr_number' }, seq: 2 },
      { kind: 'net', method: 'POST', url: `${MOCK}/api/CRdetails/AdvanceSearchCR_Paging`, status: 200,
        reqBody: JSON.stringify({ CR_NO: '139867', PAGE: 1 }),
        resBody: JSON.stringify({ TOTAL: 1, RECORDS: [{ CR_NO: '139867', NAME_EN: 'Awal Trading Co. W.L.L' }] }), seq: 3 },
      { kind: 'session_stop', seq: 4 },
    ],
  };
  const spec = toSpec(analyse(baseTrace), { name: 'mock', origin: MOCK, loadUrl: `${MOCK}/`, probeStatus: 200 });
  const pname = spec.parameters[0].name;

  // 0. Happy path still passes, so a stop below means the mutation, not the setup.
  const good = await run(spec, { [pname]: '84121' }, { readToken: noToken });
  check('baseline: valid input replays and validates', good.ok, good.stoppedReason);

  // 1. Interrupted recording is not plan-eligible.
  const interrupted = { meta: { session: 'x', status: 'interrupted' }, events: baseTrace.events.slice(0, 4) };
  let refused = false;
  try { toSpec(analyse(interrupted), { name: 'x', origin: MOCK, loadUrl: `${MOCK}/`, probeStatus: 200 }); }
  catch (e) { refused = /not plan-eligible/.test(e.message); }
  check('interrupted session refuses spec generation', refused);

  // 2. Missing parameter stops with a named reason.
  const noParam = await run(spec, {}, { readToken: noToken });
  check('missing parameter stops the run', !noParam.ok && /missing required parameter/.test(noParam.stoppedReason || ''), noParam.stoppedReason);

  // 3. Missing endpoint (changed/removed target) stops with a named reason.
  const deadSpec = structuredClone(spec);
  deadSpec.steps[0].url = `${MOCK}/api/CRdetails/GONE`;
  const dead = await run(deadSpec, { [pname]: '84121' }, { readToken: noToken });
  check('missing endpoint stops the run', !dead.ok, dead.stoppedReason);
  check('  and names the outcome mismatch', /outcome check failed|failed to reach/.test(dead.stoppedReason || ''), dead.stoppedReason);

  // 4. Changed outcome shape: the response no longer matches what success looks like.
  const shapeSpec = structuredClone(spec);
  shapeSpec.outcome.expect = { path: 'Status_Code', equals: '200' }; // mock returns TOTAL, not Status_Code
  const shape = await run(shapeSpec, { [pname]: '84121' }, { readToken: noToken });
  check('changed outcome shape stops the run', !shape.ok && /outcome check failed/.test(shape.stoppedReason || ''), shape.stoppedReason);

  // 5. A token step that yields no token stops with a named reason (wrong page / auth gone).
  const authSpec = structuredClone(spec);
  authSpec.steps.unshift({ id: 'token', type: 'browser-token', loadUrl: `${MOCK}/`, reason: 'test' });
  authSpec.steps[1].bearerFrom = 'token';
  const noTok = await run(authSpec, { [pname]: '84121' }, { readToken: async () => undefined });
  check('absent token stops the run', !noTok.ok && /issued no recognisable token/.test(noTok.stoppedReason || ''), noTok.stoppedReason);

  // 6. A discovered token flows into the run and its origin is reported.
  const withTok = await run(authSpec, { [pname]: '84121' },
    { readToken: async () => ({ bearer: 'stub-bearer-value-long-enough', source: 'localStorage.auth → access_token' }) });
  check('discovered token completes the run and names its source',
    withTok.ok && withTok.steps.some((s) => s.type === 'browser-token' && /localStorage\.auth/.test(s.detail)),
    withTok.stoppedReason ?? JSON.stringify(withTok.steps));
} finally {
  mock.kill();
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASS');
process.exit(failures.length ? 1 : 0);
