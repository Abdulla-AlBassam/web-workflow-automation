// One acceptance for every model-built script, whatever wrote it: the API
// loop (effort.ts), an answer pasted back from an external model (the import
// route) and the CLI verify all go through checkCandidate, so a script is
// judged the same way on every path. Deterministic throughout: lint, execute
// with the recorded inputs, then the rows must reproduce something the
// operator saw. The contract and the rules are the text every model reads.
import { analyse, markKey, objectHasMark, responseHasMark, type Analysis } from './analyse.js';
import { SPEC_VERSION, type Spec } from './generate.js';
import type { Bearer } from '../../runner/src/browser-token.js';
import { SCRIPT_FILE, getMeta, readEvents, saveMeta, saveScript, saveSpec, status, type Meta } from './store.js';
import { lintScript, literalCarries, runScript, stringLiterals, type ScriptOk } from '../../runner/src/script.js';
import { evidenceStrings, paramNames, rowText, shortMark, type Ev } from './llm-tools.js';
import { robotsCheck, robotsNotes } from './robots.js';

const EVIDENCE_CHARS = 3_000_000;    // snapshot text the acceptance check searches
const RUN_TIMEOUT_MS = 120_000;

export type ReadToken = (loadUrl: string) => Promise<Bearer | undefined>;
export type Param = { name: string; example: string; description?: string };
export type Candidate = { source: string; title: string; summary: string; parameters: Param[]; fixed: string[] };
export type Verdict =
  | { ok: true; run: ScriptOk; missing: string[]; columns: string[]; note: string; robots: string[] }
  | { ok: false; reason: string; partial?: { run: ScriptOk; missing: string[]; columns: string[] } };

// `declare` names where the parameters are declared: the write_script tool in
// the API loop, the answer block for an external model.
export function scriptContract(declare: string): string {
  return `Plain JavaScript, no import or require. The context has JavaScript's own intrinsics plus URL and URLSearchParams and nothing else: no timers, no fetch, no TextEncoder, no structuredClone. process, globalThis, eval, Function(), Reflect, Proxy, constructor, prototype and __proto__ are refused in code (an expression you pass to a page handle's eval is not code here, so it may use them).
Define:
  async function run(ctx) { ... return rows; }
ctx.inputs        — the run's parameters by the names you declare in ${declare}. Read every one from here; never hard-code a recorded value.
ctx.http.fetch(url, { method, headers, body }) → { status, ok, url, contentType, text, json() }. body may be an object (sent as JSON) or a string. Cookie/authorization headers are dropped.
ctx.dom(html) → page handle over HTML you already fetched, no network: eval(expression), text(selector?), texts(selector), html(selector?), attr(selector, name), close(). Use it to parse server-rendered results.
ctx.browser.open(url) → page handle on a live page: goto(url), fill(selector, text), click(selector), press(selector, key), waitFor(selector, ms) → boolean, wait(ms), text(selector?), texts(selector), html(selector?), attr(selector, name), eval(expression), url(), close().
  eval takes an expression, e.g. "[...document.querySelectorAll('.row')].map(r => ({ title: r.querySelector('h3')?.textContent?.trim(), link: r.querySelector('a')?.href }))"; the result must survive JSON.
ctx.site.token(pageUrl) → the anonymous bearer the site mints for every visitor, read from its web storage after loading pageUrl. Send it as headers: { authorization: 'Bearer ' + token }. This is the ONLY credential a script may send.
ctx.log(...) — notes shown to the operator on failure. ctx.sleep(ms).
Return an array of flat row objects — one per result, plain string/number fields named as a person would name columns (title, price, link). Absolute URLs for links.`;
}

export const ACCEPTANCE_RULES = `1. Lint: reads every declared parameter from ctx.inputs; carries no recorded typed value as a literal unless you list it in "fixed" and explain why in the summary; no imports.
2. Executed with the declared example values (the recorded ones) within 120 seconds, returning at least one row.
3. Evidence: if the operator marked text, each marked selection must appear as a field value in some row. Otherwise at least one row must carry text that appears in a page snapshot the operator saw (or the typed value, or a result they clicked). Ask for plain text rather than HTML.
Hosts the accepted script contacted are recorded; later runs are confined to them.`;

// Everything the acceptance compares a script against, read once per session.
export type Evidence = {
  id: string;
  meta: Meta;
  events: Ev[];
  a: Analysis;
  typed: { name: string; value: string; field: string }[];
  marks: string[];
  headerMarks: string[];
  clicked: string[];
  snapshots: Ev[];
  hay: string;
  textHay: string;
  firstPage?: string;
};

// A selection dragged across a table's header row names the columns; it is
// not a value any row carries. Demanding it as evidence makes the only
// acceptable script one that scrapes the live <thead>, so a mark taken from
// a header that no captured response answers is dropped from what the
// acceptance requires, and said so wherever marks are shown.
export function splitMarks(events: Ev[], a: Analysis): { marks: string[]; headers: string[] } {
  const headers = new Set<string>();
  for (const e of events) {
    if (e.kind !== 'action' || e.action !== 'mark' || typeof e.text !== 'string') continue;
    const t = e.target as { tag?: string; selector?: string } | undefined;
    // As an element in the selector, never as part of an id: #firstHeading.
    if (t?.tag !== 'th' && !/(^|[\s>+~,(])thead\b/i.test(t?.selector ?? '')) continue;
    if (a.calls.some((c) => responseHasMark(c.resBody, e.text as string))) continue;
    headers.add(e.text);
  }
  return { marks: a.marks.filter((m) => !headers.has(m)), headers: a.marks.filter((m) => headers.has(m)) };
}

export const headerNote = (headers: string[]) => headers.length
  ? ` (the marked table header row ${headers.map(shortMark).join(', ')} is ignored: a header names columns, it is not a value)`
  : '';

export function loadEvidence(id: string): Evidence | { error: string } {
  const meta = getMeta(id);
  if (!meta) return { error: 'unknown session' };
  const st = status(meta);
  if (st !== 'complete') return { error: `session is ${st} — only complete recordings can be worked on` };
  const events = readEvents(id);
  const a = analyse({ meta: { session: id, status: 'complete' }, events });
  const split = splitMarks(events, a);
  return {
    id, meta, events, a,
    typed: paramNames(a),
    marks: split.marks,
    headerMarks: split.headers,
    clicked: evidenceStrings(events, a),
    snapshots: events.filter((e) => e.kind === 'snapshot'),
    hay: snapshotHaystack(events),
    textHay: snapshotHaystack(events, true),
    firstPage: events.find((e) => e.kind === 'page' && typeof e.url === 'string')?.url as string | undefined,
  };
}

// Newest first: the page the operator ended on is where the rows come from,
// and a long recording of heavy pages would otherwise spend the whole budget
// before reaching it and reject a script for showing what they saw.
function snapshotHaystack(events: Ev[], textOnly = false): string {
  let out = '';
  for (let i = events.length - 1; i >= 0 && out.length < EVIDENCE_CHARS; i--) {
    const e = events[i];
    if (e.kind !== 'snapshot') continue;
    out += ' ' + markKey(String(e.text ?? '')) + (textOnly ? '' : ' ' + markKey(String(e.html ?? '')));
  }
  return out.slice(0, EVIDENCE_CHARS);
}

// How many rows carry a value the operator saw on some page: a string field
// of four or more letters and digits found in a snapshot.
function rowsSeen(rows: Record<string, unknown>[], hay: string): number {
  if (!hay) return 0;
  let n = 0;
  for (const row of rows.slice(0, 200)) {
    const hit = Object.values(row).some((v) => {
      if (typeof v !== 'string' && typeof v !== 'number') return false;
      const k = markKey(String(v));
      return k.length >= 4 && hay.includes(k);
    });
    if (hit) n++;
  }
  return n;
}

export type SpecVerdict = NonNullable<Spec['verified']> | { status: 'refused'; reason: string };

// Offline evidence only: a query echoed by an auxiliary call is not proof
// that its rows are the results. HTML attributes are not visible text either.
export function verifySpec(spec: Spec, ev: Evidence): SpecVerdict {
  if (spec.steps.find((s) => s.id === spec.outcome.fromStep)?.type === 'browser-extract') {
    return { status: 'unverified', note: 'The outcome is read from page elements on each run; no recorded response contains those rows.' };
  }
  const call = ev.a.chain?.call ?? ev.a.outcome;
  if (!call) return { status: 'unverified', note: 'No recorded outcome response is available to check.' };
  let body: unknown;
  try { body = JSON.parse(call.resBody ?? ''); } catch { body = undefined; }
  const path = spec.outcome.extract.records;
  const value = path === undefined ? body : path.split('.').reduce<unknown>((v, k) =>
    v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined, body);
  const rows = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];
  const refuse = (why: string): SpecVerdict => ({
    status: 'refused',
    reason: `${call.method} ${call.url} returns ${call.resultShape ?? `${rows.length} records`}. ${why} Nothing was built.`,
  });
  if (Array.isArray(value) && !rows.length) return { status: 'unverified', note: 'The recorded search returned no rows to check.' };
  if (ev.marks.length) {
    const missing = ev.marks.filter((m) => !rows.some((r) => objectHasMark(r, m)));
    if (missing.length) return refuse(`${ev.marks.length - missing.length} of ${ev.marks.length} marked selections located; missing: ${missing.map(shortMark).join(', ')}.`);
    return { status: 'verified', note: `All ${ev.marks.length} marked selections located.${headerNote(ev.headerMarks)}` };
  }
  const typed = new Set(ev.typed.map((p) => markKey(p.value)));
  const visible = rows.map((r) => Object.fromEntries(Object.entries(r ?? {}).filter(([, value]) =>
    (typeof value === 'string' || typeof value === 'number') && !typed.has(markKey(String(value))))));
  const seen = rowsSeen(visible, ev.textHay);
  if (seen) return { status: 'verified', note: `${seen} of ${Math.min(rows.length, 200)} rows carry text you saw.` };
  const clicked = ev.clicked.filter((s) => s.length >= 4 && !typed.has(s));
  if (visible.some((r) => clicked.some((s) => rowText(r).includes(s)))) {
    return { status: 'verified', note: 'The rows carry a result you clicked.' };
  }
  if (!ev.snapshots.length && !clicked.length) return { status: 'unverified', note: 'This recording has no page snapshots or clicked results to check.' };
  return refuse('None of its rows carries anything you saw on the page.');
}

export async function checkCandidate(c: Candidate, ev: Evidence, readToken: ReadToken): Promise<Verdict> {
  const params = c.parameters;
  const bad = params.find((p) => !/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(p.name));
  if (bad) return { ok: false, reason: `parameter name "${bad.name}" is not an identifier (letters, digits, underscores)` };
  const dup = params.find((p, i) => params.findIndex((q) => q.name === p.name) !== i);
  if (dup) return { ok: false, reason: `parameter "${dup.name}" is declared twice` };
  if (params.some((p) => !p.example)) return { ok: false, reason: 'every parameter needs an example: the recorded value, so the acceptance run reproduces the recording' };

  const inputs = Object.fromEntries(params.map((p) => [p.name, p.example]));
  const lint = lintScript(c.source, inputs);
  // A typed value that is not a parameter must not be baked in silently.
  const literals = stringLiterals(c.source);
  for (const { value } of ev.typed) {
    if (value.length < 3 || params.some((p) => p.example === value) || c.fixed.includes(value)) continue;
    if (literals.some((l) => literalCarries(l, value))) lint.push(`the typed value "${value}" is hard-coded — declare it as a parameter, or list it under "fixed" and say why it never changes`);
  }
  if (lint.length) return { ok: false, reason: `lint: ${lint.join('; ')}` };

  const run = await runScript(c.source, { inputs, readToken, timeoutMs: RUN_TIMEOUT_MS });
  if ('error' in run) {
    return { ok: false, reason: `the script failed: ${run.error}${run.log.length ? ` — log: ${run.log.slice(-5).join(' | ')}` : ''}` };
  }
  if (!run.rows.length) {
    return { ok: false, reason: `the script returned no rows for the recorded input(s)${run.log.length ? ` — log: ${run.log.slice(-5).join(' | ')}` : ''}` };
  }
  const columns = [...new Set(run.rows.flatMap((r) => Object.keys(r)))];
  const first = `First row: ${JSON.stringify(run.rows[0]).slice(0, 400)}`;
  const marks = ev.marks;
  if (marks.length) {
    const missing = marks.filter((m) => !run.rows.some((r) => objectHasMark(r, m)));
    if (missing.length === marks.length) {
      return { ok: false, reason: `the rows carry none of the operator's marked selections as a field value (${marks.map(shortMark).join(', ')}). ${first}` };
    }
    if (missing.length) {
      return {
        ok: false,
        reason: `${marks.length - missing.length} of ${marks.length} marked selections located; missing: ${missing.map(shortMark).join(', ')}. Add the field(s) that carry the missing text, or say why no source has it.`,
        partial: { run, missing, columns },
      };
    }
    return accepted(ev, run, columns, `all ${marks.length} marked selection(s) located`);
  }
  const seen = rowsSeen(run.rows, ev.hay);
  if (seen) return accepted(ev, run, columns, `${seen} of ${Math.min(run.rows.length, 200)} row(s) carry text the operator saw on a recorded page`);
  const text = run.rows.slice(0, 200).map(rowText).join('\n');
  const typed = ev.typed.map((p) => p.value);
  const typedHit = typed.find((v) => v.length >= 2 && text.includes(markKey(v)));
  const clicked = ev.clicked.find((s) => text.includes(s));
  if (typedHit || clicked) return accepted(ev, run, columns, typedHit ? `rows carry the typed value "${typedHit}"` : `rows carry the clicked result "${clicked}"`);
  return {
    ok: false,
    reason: `no row carries anything the operator saw: nothing from the page snapshots${typed.length ? `, not the typed value(s) ${typed.map((v) => `"${v}"`).join(', ')}` : ''}${ev.clicked.length ? `, not a clicked result (${ev.clicked.map((e) => `"${e}"`).join(', ')})` : ''}. Return fields whose plain text appears on the recorded page (titles, names, prices), not only ids or links. ${first}`,
  };
}

// An accepted script also gets its robots.txt report: what the site asks
// crawlers to leave alone among the URLs it just contacted.
async function accepted(ev: Evidence, run: ScriptOk, columns: string[], note: string): Promise<Verdict> {
  const robots = robotsNotes(await robotsCheck(run.urls));
  return { ok: true, run, missing: [], columns, note: `${note}${headerNote(ev.headerMarks)}`, robots };
}

// The automation a session already has, in one paragraph: what a model is
// asked to improve on. The token step's reason carries the probe status that
// put it there, which is the only place the brief says whether the outcome
// call is gated.
export function describeExisting(spec: Spec, script: string | undefined): string {
  const steps = spec.steps.map((s) => s.type === 'request'
    ? `${s.method} ${s.url}${s.bodyTemplate !== undefined ? ` body ${JSON.stringify(s.bodyTemplate).slice(0, 300)}` : ''}`
    : s.type === 'script' ? `session script (${s.file}, hosts ${s.hosts.join(', ')})`
    : `${s.type} step (${s.reason})`).join(' → ');
  const cols = spec.outcome.columns?.map((c) => c.name).join(', ');
  const built = spec.repaired ? `built by ${spec.repaired.model} in ${spec.repaired.mode ?? 'repair'} mode` : 'built by the deterministic generator';
  const base = `${steps}; parameters ${spec.parameters.map((p) => `${p.name}="${p.example}"`).join(', ') || 'none'}; rows at ${spec.outcome.extract.records ?? 'the whole response'}; ${cols ? `columns ${cols}` : 'no marked columns'}${spec.outcome.pagination ? `; all pages fetched (${'pagePath' in spec.outcome.pagination ? `page field ${spec.outcome.pagination.pagePath}` : `page parameter ${spec.outcome.pagination.pageParam}`})` : ''}; ${built}${spec.repaired?.summary ? `; built for: ${spec.repaired.summary}` : ''}`;
  return script ? `${base}\n--- current script ---\n${script.slice(0, 8000)}\n--- end script ---` : base;
}

// The accepted script becomes the session's automation: one script step,
// the declared parameters, provenance naming what built it and the goal it
// was built for. A model-given title names an untitled session.
export function saveCandidate(ev: Evidence, c: Candidate, run: ScriptOk, by: { model: string; mode: 'effort' | 'import' }, robots: string[] = []): { spec: Spec; columns: string[] } {
  const columns = [...new Set(run.rows.flatMap((r) => Object.keys(r)))];
  saveScript(ev.id, SCRIPT_FILE, c.source);
  const goal = ev.meta.goal;
  const spec: Spec = {
    version: SPEC_VERSION,
    name: ev.id,
    origin: ev.firstPage ? new URL(ev.firstPage).origin : `https://${ev.meta.hosts[0]}`,
    language: ev.a.language,
    parameters: c.parameters.map((p) => ({ name: p.name, example: p.example, required: true })),
    steps: [{ id: 'automation', type: 'script', file: SCRIPT_FILE, reason: c.summary, hosts: run.hosts, ...(robots.length ? { robots } : {}) }],
    outcome: { fromStep: 'automation', expect: { path: '__http_ok', equals: 'true' }, extract: { records: 'rows' } },
    repaired: { at: new Date().toISOString(), model: by.model, diagnosis: c.summary, summary: c.summary, mode: by.mode, ...(goal ? { feedback: goal } : {}) },
  };
  saveSpec(ev.id, spec);
  delete ev.meta.refusal;
  if (!ev.meta.name && c.title) ev.meta.name = c.title.slice(0, 80);
  saveMeta(ev.meta);
  return { spec, columns };
}

// V8 reports a bad JSON either by position or by quoting the text around it,
// on several lines; a model asked to fix its own block needs a position, and
// the operator pasting the refusal back needs one line.
function jsonError(body: string, e: Error): string {
  const quoted = e.message.match(/\.\.\."([\s\S]*?)"\.\.\./)?.[1];
  const at = quoted ? body.indexOf(quoted) : -1;
  const message = e.message.replace(/\s+/g, ' ');
  return /at position \d+/.test(message) || at < 0 ? message : `${message} (near position ${at})`;
}

// The answer an external model gives back: the JSON block the brief asks
// for, or a bare script (parameters then default to the typed values, so a
// script that never reads them is refused with the reason the model needs).
// Every refusal names itself: a model told only "no answer found" for a
// trailing comma sends the same reply back.
export function parseCandidate(text: string, ev: Evidence): Candidate | { error: string } {
  const raw = text.trim();
  const shape = (o: Record<string, unknown>): Candidate => ({
    source: String(o.source ?? ''),
    title: String(o.title ?? '').trim().slice(0, 80),
    summary: String(o.summary ?? '').trim().slice(0, 1200),
    parameters: (Array.isArray(o.parameters) ? o.parameters as Record<string, unknown>[] : [])
      .map((p) => ({ name: String(p?.name ?? '').trim(), example: String(p?.example ?? ''), ...(p?.description ? { description: String(p.description).slice(0, 200) } : {}) }))
      .filter((p) => p.name),
    fixed: Array.isArray(o.fixed) ? (o.fixed as unknown[]).map(String) : [],
  });
  const fences = [...raw.matchAll(/```([\w-]*)[^\n]*\n([\s\S]*?)```/g)].map((m) => ({ lang: m[1].toLowerCase(), body: m[2] }));
  const json = fences.filter((f) => f.lang === 'json' || (!f.lang && f.body.trim().startsWith('{')));
  const blocks = (raw.startsWith('{') ? [raw] : []).concat(json.map((f) => f.body.trim()));

  // A model often shows the shape first and answers second, so the last block
  // that actually carries a source wins; the other outcomes are kept to
  // explain the refusal if none does.
  let found: Candidate | undefined;
  let badSource: string | undefined;
  let badJson: string | undefined;
  blocks.forEach((body, i) => {
    const where = `json block #${i + 1}`;
    let v: unknown;
    try { v = JSON.parse(body); } catch (e) {
      badJson = `${where} does not parse: ${jsonError(body, e as Error)}. JSON here is strict: no trailing commas, no comments, and the script must be one JSON string with its newlines escaped as \\n.`;
      return;
    }
    if (!v || typeof v !== 'object') return;
    const source = (v as { source?: unknown }).source;
    if (source === undefined) return;
    if (typeof source === 'string') { found = shape(v as Record<string, unknown>); return; }
    badSource = `${where}: "source" is ${Array.isArray(source) ? 'an array of lines' : `a ${typeof source}`}. Send the whole script as ONE JSON string, its lines joined with \\n.`;
  });
  if (found) return found;
  if (badSource) return { error: badSource };
  if (badJson) return { error: badJson };

  const scriptFence = fences.find((f) => !json.includes(f) && (/^(js|javascript|mjs)$/.test(f.lang) || /async\s+function\s+run\s*\(/.test(f.body)));
  const source = scriptFence ? scriptFence.body : /async\s+function\s+run\s*\(/.test(raw) ? raw : undefined;
  if (source) {
    return {
      source,
      title: '',
      summary: 'Script imported from an external model without a summary.',
      parameters: ev.typed.map((p) => ({ name: p.name, example: p.value })),
      fixed: [],
    };
  }
  return { error: 'no answer found: paste the model\'s reply containing one fenced ```json block with {title, summary, parameters, fixed, source}, or a script defining async function run(ctx)' };
}
