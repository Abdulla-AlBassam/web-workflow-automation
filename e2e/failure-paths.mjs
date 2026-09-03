// Phase 3 failure-path suite. These prove the honesty claims in the proposal:
// interrupted recordings are not automatable, and a replay stops with a named
// reason when the page, endpoint, parameter or outcome does not match.
// Deterministic, fixture-driven, no live Sijilat. Run: node e2e/failure-paths.mjs
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { analyse } from '../backend/src/analyse.ts';
import { SPEC_VERSION, toSpec } from '../backend/src/generate.ts';
import { run } from '../runner/src/run.ts';
import { lintScript, runScript } from '../runner/src/script.ts';
import { sanitise } from '../backend/src/redact.ts';
import { robotsCheck } from '../backend/src/robots.ts';
import { parseEnv } from '../backend/src/env.ts';

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

  const throwerSpec = structuredClone(spec);
  throwerSpec.steps = [{ id: 'automation', type: 'script', file: 'automation.mjs', reason: 'test', hosts: [] }];
  const scriptThrows = await run(throwerSpec, { [pname]: '84121' }, {
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
  // === 10. The session-script sandbox =======================================
  // A script now arrives from outside (a model the operator chose, pasted
  // back), so these prove the boundary rather than the good intentions: the
  // context is built inside itself over a bridge that passes only strings, so
  // no value the script can name leads back to this process; and it runs in a
  // worker thread, so even a script that never yields is cut at the deadline
  // and takes nothing with it.

  // 10a. Nothing reachable from the script leads to this process. The crawl
  // walks every own property and prototype of everything it can name and asks
  // each value for a Function constructor that can see `process`.
  const CRAWL = `async function run(ctx) {
    void ctx.inputs.q;
    const res = await ctx.http.fetch('${MOCK}/api/urlsearch?q=trading');
    let caught; try { await ctx.http.fetch('ftp://elsewhere/'); } catch (e) { caught = e; }
    const seen = new Set();
    const hits = [];
    const queue = [[globalThis, 'globalThis'], [ctx, 'ctx'], [res, 'response'], [caught, 'error'],
      [ctx.sleep(0), 'promise'], [(function () { return this; })(), 'this'], [run, 'run']];
    const reaches = (v) => {
      for (const c of [v && v.constructor, Object.getPrototypeOf(v)]) {
        try {
          if (typeof c !== 'function' || typeof c.constructor !== 'function') continue;
          const g = c.constructor('return this')();
          if (g && (g.process || g.require || g.Buffer)) return true;
        } catch (e) { /* refused, which is the point */ }
      }
      return false;
    };
    let n = 0;
    while (queue.length && n++ < 60000) {
      const [v, path] = queue.shift();
      if (v === null || (typeof v !== 'object' && typeof v !== 'function') || seen.has(v)) continue;
      seen.add(v);
      if (reaches(v)) { hits.push(path); continue; }
      if (path.split('.').length > 7) continue;
      let names;
      try { names = Object.getOwnPropertyNames(v); } catch (e) { continue; }
      for (const k of names) {
        let d;
        try { d = Object.getOwnPropertyDescriptor(v, k); } catch (e) { continue; }
        if (!d) continue;
        if ('value' in d) queue.push([d.value, path + '.' + k]);
        if (d.get) queue.push([d.get, path + '.get ' + k]);
      }
      try { const p = Object.getPrototypeOf(v); if (p) queue.push([p, path + '.proto']); } catch (e) {}
    }
    return [{ visited: seen.size, hits: hits.join(', ') }];
  }`;
  const crawl = await runScript(CRAWL, { inputs: { q: 'trading' }, timeoutMs: 30_000 });
  check('sandbox: no value the script can reach leads back to this process',
    crawl.rows?.[0].hits === '' && crawl.rows[0].visited > 500, JSON.stringify(crawl.rows?.[0] ?? crawl.error));

  // 10b. The same, named path by path: each of these used to be a host object.
  const REACH = `async function run(ctx) {
    const out = (v) => { try { return typeof v.constructor.constructor('return this')().process; } catch (e) { return 'threw'; } };
    const res = await ctx.http.fetch('${MOCK}/api/urlsearch?q=' + ctx.inputs.q);
    let caught; try { await ctx.http.fetch('ftp://elsewhere/'); } catch (e) { caught = e; }
    const slept = ctx.sleep(0); await slept;
    const page = await ctx.dom('<b>hi</b>');
    const rows = await page.eval("[...document.querySelectorAll('b')].map(b => ({ t: b.textContent }))");
    await page.close();
    return [{ json: out(JSON), log: out(ctx.log), response: out(res), error: out(caught),
      promise: out(slept), inputs: out(ctx.inputs), page: out(page), evaluated: out(rows), q: ctx.inputs.q }];
  }`;
  const reach = await runScript(REACH, { inputs: { q: 'trading' }, timeoutMs: 60_000 });
  const reached = Object.entries(reach.rows?.[0] ?? {}).filter(([k, v]) => k !== 'q' && v !== 'undefined');
  check('sandbox: process is undefined through JSON, ctx.log, a response, a caught error, a promise, inputs, a page and its eval',
    reach.rows?.length === 1 && reached.length === 0, JSON.stringify(reached.length ? reached : reach.error));

  // 10c. A synchronous loop is cut. The vm timeout covers compilation only and
  // a timer cannot fire while the thread spins, so this is what the worker is for.
  const spun = Date.now();
  const spin = await runScript('async function run(ctx) { void ctx.inputs.q; for (;;) {} }', { inputs: { q: 'trading' }, timeoutMs: 1500 });
  const spinMs = Date.now() - spun;
  check('sandbox: a script that loops forever is cut at the deadline',
    spin.error === 'the script exceeded 1.5s' && spinMs < 4000, `${spin.error} after ${spinMs}ms`);

  // 10d. And one that simply never resolves.
  const stalled = await runScript('async function run(ctx) { void ctx.inputs.q; await new Promise(() => {}); }', { inputs: { q: 'trading' }, timeoutMs: 1200 });
  check('sandbox: a script that never resolves is cut too', stalled.error === 'the script exceeded 1.2s', stalled.error);

  // 10e. A browser the cut script opened is closed with it: the runner owns
  // the browser, so terminating the script's thread cannot orphan one.
  const chromiums = () => execFileSync('ps', ['-A', '-o', 'pid=,ppid=,comm=']).toString().split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => Number(p[1]) === process.pid && /chrom/i.test(p.slice(2).join(' ')))
    .map((p) => Number(p[0]));
  const launched = new Set();
  const watch = setInterval(() => chromiums().forEach((pid) => launched.add(pid)), 300);
  const hung = await runScript(`async function run(ctx) {
    void ctx.inputs.q;
    const page = await ctx.browser.open('${MOCK}/');
    await page.text('body');
    await new Promise(() => {});
  }`, { inputs: { q: 'trading' }, timeoutMs: 6000 });
  clearInterval(watch);
  for (let i = 0; i < 40 && chromiums().length; i++) await new Promise((r) => setTimeout(r, 250));
  check('sandbox: a browser opened by a script that then hangs is disposed with it',
    hung.error === 'the script exceeded 6s' && launched.size > 0 && chromiums().length === 0,
    `${hung.error}; launched ${[...launched]}, still running ${chromiums()}`);

  // 10f. The bearer route is a contacted host like any other.
  const tokenRun = await runScript(`async function run(ctx) {
    const bearer = await ctx.site.token('${MOCK}/');
    return [{ q: ctx.inputs.q, length: bearer.length }];
  }`, { inputs: { q: 'trading' }, readToken: async () => ({ bearer: 'stub-bearer-value-long-enough', source: 'localStorage.auth' }) });
  check('sandbox: ctx.site.token records the page it loaded as a contacted host and URL',
    tokenRun.rows?.[0].length === 29 && tokenRun.hosts.includes('127.0.0.1') && tokenRun.urls.includes(`${MOCK}/`),
    JSON.stringify(tokenRun));

  // 10g. The URL list backs the robots.txt report, so it is bounded.
  const many = await runScript(`async function run(ctx) {
    void ctx.inputs.q;
    for (let i = 0; i < 250; i++) await ctx.http.fetch('${MOCK}/api/urlsearch?i=' + i);
    return [{ done: true }];
  }`, { inputs: { q: 'trading' }, timeoutMs: 60_000 });
  check('sandbox: the contacted-URL list stops at 200', many.urls?.length === 200, String(many.urls?.length ?? many.error));

  // 10h. What a script can legitimately need beyond the bare intrinsics is
  // rebuilt inside the context, and it behaves.
  const built = await runScript(`const TOP = new URL('${MOCK}/a/b/c').origin;
  async function run(ctx) {
    const u = new URL('${MOCK}/api/urlsearch?a=1#f');
    u.searchParams.set('q', ctx.inputs.q);
    return [{ href: u.href, origin: u.origin, path: u.pathname, top: TOP,
      relative: new URL('../x/y', '${MOCK}/a/b/c').href,
      encoded: new URLSearchParams({ name: 'a b', mark: '&' }).toString() }];
  }`, { inputs: { q: 'a b&c' } });
  check('sandbox: URL and URLSearchParams are rebuilt in the context and parse as the host does',
    built.rows?.[0].href === `${MOCK}/api/urlsearch?a=1&q=a+b%26c#f` && built.rows[0].relative === `${MOCK}/a/x/y`
    && built.rows[0].encoded === 'name=a+b&mark=%26' && built.rows[0].top === MOCK, JSON.stringify(built.rows?.[0] ?? built.error));

  // 10i. The lint is belt and braces over that boundary: the shapes a session
  // script has no honest use for, read from code with strings and comments
  // blanked, so an expression a page evaluates still passes.
  const lint = (src) => lintScript(src, { q: 'trading' }).join(' ');
  for (const [what, body] of [
    ['constructor', 'return [{}].constructor;'],
    ['prototype', 'return Array.prototype.slice.call([]);'],
    ['__proto__', 'return ({}).__proto__;'],
    ['Function(', 'return new Function("return 1")();'],
    ['Reflect', 'return Reflect.get({}, "a");'],
    ['Proxy', 'return new Proxy({}, {});'],
  ]) {
    check(`lint: ${what} in code is refused`, /must not reference/.test(lint(`async function run(ctx) { void ctx.inputs.q; ${body} }`)), lint(`async function run(ctx) { void ctx.inputs.q; ${body} }`));
  }
  check('lint: a dynamic import is refused', /must not import/.test(lint('async function run(ctx) { void ctx.inputs.q; return import("node:fs"); }')));
  const evaluated = `async function run(ctx) {
    // the page evaluates prototype tricks, not this script: Reflect, Proxy
    const page = await ctx.dom('<a href="/x">x</a>');
    return page.eval("Array.prototype.slice.call(document.querySelectorAll('a')).map(a => ({ href: a.constructor.name, q: '" + ctx.inputs.q + "' }))");
  }`;
  check('lint: the same words inside a string or a comment are not refused', lint(evaluated) === '', lint(evaluated));

  // 10j. Every way a script step can fail is a named stop, never a throw.
  const scriptSpec = {
    version: SPEC_VERSION, name: 'script', origin: MOCK, language: 'EN',
    parameters: [{ name: 'q', example: 'trading', required: true }],
    steps: [{ id: 'automation', type: 'script', file: 'automation.mjs', reason: 'test', hosts: ['127.0.0.1'] }],
    outcome: { fromStep: 'automation', expect: { path: '__http_ok', equals: 'true' }, extract: { records: 'rows' } },
  };
  const withScript = (runner) => ({ readToken: noToken, extractPage: async () => ({ httpStatus: 200, texts: [] }), runScript: runner });
  const noRunner = await run(scriptSpec, { q: 'trading' }, { readToken: noToken, extractPage: async () => ({ httpStatus: 200, texts: [] }) });
  check('script step: no runner available stops the run',
    !noRunner.ok && /no script runner available/.test(noRunner.stoppedReason || ''), noRunner.stoppedReason);
  const scriptFailed = await run(scriptSpec, { q: 'trading' }, withScript(async () => ({ error: 'the endpoint answered 500', hosts: [], log: [] })));
  check('script step: a failing script stops the run with its own reason',
    !scriptFailed.ok && scriptFailed.stoppedReason === 'script step "automation": the endpoint answered 500', scriptFailed.stoppedReason);
  const scriptHung = await run(scriptSpec, { q: 'trading' }, withScript((file, inputs, hosts) =>
    runScript('async function run(ctx) { void ctx.inputs.q; for (;;) {} }', { inputs, hosts, timeoutMs: 1200 })));
  check('script step: a script that hangs stops the run with a named reason',
    !scriptHung.ok && scriptHung.stoppedReason === 'script step "automation": the script exceeded 1.2s', scriptHung.stoppedReason);
  const scriptRan = await run(scriptSpec, { q: 'trading' }, withScript((file, inputs, hosts) => runScript(
    `async function run(ctx) { const r = await ctx.http.fetch('${MOCK}/api/urlsearch?q=' + encodeURIComponent(ctx.inputs.q)); return r.json().RECORDS; }`,
    { inputs, hosts })));
  check('script step: a working script replays and its rows become the outcome',
    scriptRan.ok && scriptRan.extracted?.records.count === 5, scriptRan.stoppedReason ?? JSON.stringify(scriptRan.extracted));
  const offHost = await run(scriptSpec, { q: 'trading' }, withScript((file, inputs, hosts) => runScript(
    'async function run(ctx) { void ctx.inputs.q; return ctx.http.fetch("http://elsewhere.invalid/"); }', { inputs, hosts })));
  check('script step: a host outside the verified list stops the run',
    !offHost.ok && /outside the hosts this automation was verified against/.test(offHost.stoppedReason || ''), offHost.stoppedReason);
  // --- bring your own model: robots.txt reading and the .env loader ----------
  // robotsCheck reports what a site asks every crawler to leave alone. Each
  // rule shape below is one a real robots.txt uses, and a file served as HTML
  // is a site's 404 page, not a set of rules.
  const ROBOTS_PORT = 4997; // dedicated port: no other suite uses it
  const robotsBusy = await fetch(`http://127.0.0.1:${ROBOTS_PORT}/`).then(() => true).catch(() => false);
  if (robotsBusy) throw new Error(`port ${ROBOTS_PORT} already in use — stop whatever is running there before the suite`);
  const ROBOTS_TXT = [
    '# what this file asks of crawlers',
    'User-agent: BadBot',
    'Disallow: /private/',
    '',
    'User-agent: *',
    'Disallow: /shop',
    'Allow: /shop/public',
    'Disallow: /shop*sort=',
    'Disallow: /*.json$',
    'Disallow: /comment   # a trailing comment, not part of the path',
    '',
  ].join('\n');
  // The same file on two origins: rules for 127.0.0.1, a page for localhost.
  const robotsServer = createServer((req, res) => {
    const asHtml = String(req.headers.host ?? '').startsWith('localhost');
    res.writeHead(200, { 'content-type': asHtml ? 'text/html' : 'text/plain' });
    res.end(ROBOTS_TXT);
  });
  await new Promise((resolve) => robotsServer.listen(ROBOTS_PORT, resolve));
  try {
    const R = `http://127.0.0.1:${ROBOTS_PORT}`;
    const L = `http://localhost:${ROBOTS_PORT}`;
    const hits = await robotsCheck([
      `${R}/shop?sort=price`, `${R}/shop/public`, `${R}/data/x.json`, `${R}/data/x.json?v=1`,
      `${R}/private/thing`, `${R}/comment/page`, `${R}/about`, `${L}/shop`,
    ]);
    const seen = JSON.stringify([...hits]);
    check('robots: a wildcard rule matches the query it names', hits.get(`${R}/shop?sort=price`) === '/shop*sort=', seen);
    check('robots: a longer Allow beats the Disallow above it', !hits.has(`${R}/shop/public`), seen);
    check('robots: a $ anchor matches only at the end', hits.get(`${R}/data/x.json`) === '/*.json$' && !hits.has(`${R}/data/x.json?v=1`), seen);
    check('robots: a group for another agent does not apply', !hits.has(`${R}/private/thing`), seen);
    check('robots: a trailing comment is not part of the pattern', hits.get(`${R}/comment/page`) === '/comment', seen);
    check('robots: a path no rule names is not reported', !hits.has(`${R}/about`), seen);
    check('robots: a robots.txt served as HTML is ignored', !hits.has(`${L}/shop`), seen);
  } finally {
    robotsServer.close();
  }

  // The .env loader: quotes are the file's syntax, not part of the secret.
  const env = parseEnv([
    '# a comment',
    '',
    'ANTHROPIC_API_KEY="sk-quoted"',
    "REPAIR_MODEL='claude-sonnet-5'",
    'EFFORT_LEVEL=xhigh  ',
    'DATABASE_URL=postgres://u:p@h/db?a=1&b=2',
    'QUOTE_INSIDE=he said "hi"',
    'not a key: ignored',
  ].join('\n'));
  check('env: matching quotes are stripped', env.ANTHROPIC_API_KEY === 'sk-quoted' && env.REPAIR_MODEL === 'claude-sonnet-5', JSON.stringify(env));
  check('env: unquoted values, an = inside the value, comments and blanks',
    env.EFFORT_LEVEL === 'xhigh' && env.DATABASE_URL === 'postgres://u:p@h/db?a=1&b=2' && Object.keys(env).length === 5, JSON.stringify(env));
  check('env: a quote that is not a wrapper is kept', env.QUOTE_INSIDE === 'he said "hi"', JSON.stringify(env));
} finally {
  mock.kill();
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASS');
process.exit(failures.length ? 1 : 0);
