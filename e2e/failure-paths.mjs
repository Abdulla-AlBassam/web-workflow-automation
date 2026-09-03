// Phase 3 failure-path suite. These prove the honesty claims in the proposal:
// interrupted recordings are not automatable, and a replay stops with a named
// reason when the page, endpoint, parameter or outcome does not match.
// Deterministic, fixture-driven, no live Sijilat. Run: node e2e/failure-paths.mjs
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { analyse } from '../backend/src/analyse.ts';
import { toSpec } from '../backend/src/generate.ts';
import { run } from '../runner/src/run.ts';
import { lintScript } from '../runner/src/script.ts';
import { sanitise } from '../backend/src/redact.ts';

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

  // 5b. A token reader that throws (a browser that cannot launch) is a named
  // stop like any other, never an exception for the server to turn into a 500.
  const tokThrows = await run(authSpec, { [pname]: '84121' },
    { readToken: async () => { throw new Error('browserType.launch: Executable doesn\'t exist\nmore lines'); } });
  check('token reader failure stops the run with a named reason',
    !tokThrows.ok && /^token step "token": browserType\.launch: Executable doesn't exist$/.test(tokThrows.stoppedReason || ''), tokThrows.stoppedReason);

  // 6. A discovered token flows into the run and its origin is reported.
  const withTok = await run(authSpec, { [pname]: '84121' },
    { readToken: async () => ({ bearer: 'stub-bearer-value-long-enough', source: 'localStorage.auth → access_token' }) });
  check('discovered token completes the run and names its source',
    withTok.ok && withTok.steps.some((s) => s.type === 'browser-token' && /localStorage\.auth/.test(s.detail)),
    withTok.stoppedReason ?? JSON.stringify(withTok.steps));
  // 7. The outcome gate generalises: any top-level status-shaped field with a
  // code-shaped value, not one site's field name; a per-query status word
  // does not qualify, and neither does a status nested in a record.
  const gate = (resBody) => toSpec(analyse({ ...baseTrace, events: baseTrace.events.map((e) => e.kind === 'net' ? { ...e, resBody } : e) }),
    { name: 'g', origin: MOCK, loadUrl: `${MOCK}/`, probeStatus: 200 }).outcome.expect;
  check('status gate: Status_Code 200 is the gate', JSON.stringify(gate('{"Status_Code":200,"RECORDS":[{"a":1}]}')) === '{"path":"Status_Code","equals":"200"}');
  check('status gate: success true is the gate', JSON.stringify(gate('{"success":true,"RECORDS":[{"a":1}]}')) === '{"path":"success","equals":"true"}');
  check('status gate: a status word that varies per query falls back to HTTP', gate('{"status":"found","RECORDS":[{"a":1}]}').path === '__http_ok');
  check('status gate: a status inside a record is not the gate', gate('{"RECORDS":[{"status":200}]}').path === '__http_ok');

  // 8. The script lint blocks the recorded value as data, and only as data:
  // an ordinary word typed as the value may still appear as a property, a
  // query-string key or a JSON field name.
  const script = `async function run(ctx) { const q = ctx.inputs.query; const r = await ctx.http.fetch('https://x/api?name=' + encodeURIComponent(q), { body: '{"list": true}' }); return r.json().list.map((x) => ({ name: x.name })); }`;
  check('lint: an ordinary word as the value passes when used as a key or property',
    lintScript(script, { query: 'name' }).length === 0 && lintScript(script, { query: 'list' }).length === 0,
    JSON.stringify([lintScript(script, { query: 'name' }), lintScript(script, { query: 'list' })]));
  check('lint: the value hard-coded as data is rejected',
    /appears literally/.test(lintScript(script.replace("'https://x/api?name=' + encodeURIComponent(q)", "'https://x/api?name=bank'"), { query: 'bank' }).join(' ')));
  check('lint: the value inside a JSON body string is rejected',
    /appears literally/.test(lintScript(`async function run(ctx) { void ctx.inputs.query; return ctx.http.fetch('https://x', { body: '{"q": "bank"}' }); }`, { query: 'bank' }).join(' ')));
  check('lint: a partial-word match does not trip',
    lintScript(`async function run(ctx) { void ctx.inputs.query; return ctx.http.fetch('https://x/embankment'); }`, { query: 'bank' }).length === 0);
  check('lint: an identifier is not a literal',
    lintScript(`async function run(ctx) { const bank = ctx.inputs.query; return [{ bank }]; }`, { query: 'bank' }).length === 0);
  check('lint: a script that ignores the input is rejected',
    /never reads inputs\.query/.test(lintScript('async function run(ctx) { return [{ a: 1 }]; }', { query: 'bank' }).join(' ')));

  // 9. Recorded request headers: the page's own headers travel into the
  // spec, credential-shaped and browser-managed ones never do, and the
  // backend scrubs a credential inside reqHeaders even if the extension
  // let it through.
  const headered = { ...baseTrace, events: baseTrace.events.map((e) => e.kind === 'net'
    ? { ...e, reqHeaders: { 'x-app-id': 'demo-app', 'Accept': 'application/vnd.demo+json', 'content-type': 'application/json', authorization: 'Bearer leaked', cookie: 'a=b', origin: 'https://x' } }
    : e) };
  const hSpec = toSpec(analyse(headered), { name: 'h', origin: MOCK, loadUrl: `${MOCK}/`, probeStatus: 200 });
  const hHeaders = hSpec.steps.at(-1).headers;
  check('headers: recorded custom header and accept carried into the spec, lowercased',
    hHeaders['x-app-id'] === 'demo-app' && hHeaders.accept === 'application/vnd.demo+json' && hHeaders['content-type'] === 'application/json',
    JSON.stringify(hHeaders));
  check('headers: credential-shaped and browser-managed names are never carried',
    !('authorization' in hHeaders) && !('cookie' in hHeaders) && !('origin' in hHeaders), JSON.stringify(hHeaders));
  check('headers: a spec without recorded headers keeps the defaults',
    spec.steps.at(-1).headers.accept === '*/*' && spec.steps.at(-1).headers['content-type'] === 'application/json; charset=utf-8',
    JSON.stringify(spec.steps.at(-1).headers));
  const scrubbed = sanitise({ kind: 'net', url: `${MOCK}/api`, reqHeaders: { Authorization: 'Bearer x', 'X-App-Id': 'demo' } }, []);
  check('headers: backend sanitiser drops a credential inside reqHeaders',
    JSON.stringify(scrubbed.reqHeaders) === '{"x-app-id":"demo"}', JSON.stringify(scrubbed));
  const empty = sanitise({ kind: 'net', url: `${MOCK}/api`, reqHeaders: { cookie: 'a=b' } }, []);
  check('headers: only-credential headers leave no reqHeaders at all', !('reqHeaders' in empty), JSON.stringify(empty));
  const hRun = await run(hSpec, { [pname]: '84121' }, { readToken: noToken });
  check('headers: replay with recorded headers still validates against the mock', hRun.ok, hRun.stoppedReason);

  // === Deterministic pipeline: stops the runner must name, not throw ===
  // run() never throws: a dependency that raises, or a site that answers
  // half a response, still comes back as { ok: false, stoppedReason }.
  const cutSpec = structuredClone(spec);
  cutSpec.steps[0].url = `${MOCK}/api/cutoff`;
  const cut = await run(cutSpec, { [pname]: '84121' }, { readToken: noToken });
  check('a response that ends early stops the run with a named reason',
    !cut.ok && /ended early/.test(cut.stoppedReason || ''), cut.stoppedReason);

  const scriptSpec = structuredClone(spec);
  scriptSpec.steps = [{ id: 'automation', type: 'script', file: 'automation.mjs', reason: 'test', hosts: [] }];
  const scriptThrows = await run(scriptSpec, { [pname]: '84121' }, {
    readToken: noToken,
    runScript: async () => { throw new Error('ENOENT: no such file or directory\nmore lines'); },
  });
  check('a script runner that throws stops the run with a named reason',
    !scriptThrows.ok && /^script step "automation": ENOENT: no such file or directory$/.test(scriptThrows.stoppedReason || ''),
    scriptThrows.stoppedReason);

  // === Deterministic pipeline: a submitted form's fields ===
  // The recorder names hidden fields without their values and redacts
  // passwords; the backend keeps the same promises on whatever arrives, and
  // tolerates a shape it does not recognise instead of throwing.
  const submitted = (form) => sanitise({ kind: 'action', action: 'submit', target: { id: 'f' }, form }, []).form;
  const fields = submitted({ method: 'POST', action: `${MOCK}/search`, fields: [
    { name: 'cr_name_en', value: 'trading' },
    { name: '__RequestVerificationToken', hidden: true, value: 'leaked-token' },
    { name: 'user_password', value: 'hunter2' },
    { name: 'OTP', value: '123456' },
    { name: 'lang', value: 'EN', label: 'English' },
    { value: 'nameless' },
    'not-a-field',
  ] }).fields;
  check('form: an ordinary field keeps its value and its label',
    fields[0].value === 'trading' && fields.find((f) => f.name === 'lang')?.label === 'English', JSON.stringify(fields));
  check('form: a hidden field is named, never valued',
    fields[1].name === '__RequestVerificationToken' && fields[1].hidden === true && !('value' in fields[1]), JSON.stringify(fields[1]));
  check('form: a secret-named field keeps no value',
    fields[2].value === '[REDACTED]' && fields[3].value === '[REDACTED]', JSON.stringify(fields.slice(2, 4)));
  check('form: a field that cannot be named is dropped', fields.length === 5, JSON.stringify(fields));
  check('form: a shape the recorder never writes is left alone, not thrown on',
    submitted('garbage') === 'garbage' && submitted({ method: 'POST' }).fields === undefined &&
    submitted({ fields: 'nope' }).fields === 'nope' && submitted(null) === null,
    JSON.stringify([submitted('garbage'), submitted({ method: 'POST' }), submitted({ fields: 'nope' })]));
} finally {
  mock.kill();
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASS');
process.exit(failures.length ? 1 : 0);
