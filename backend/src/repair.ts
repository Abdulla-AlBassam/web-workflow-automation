// LLM repair loop. When a recording refuses to generate an automation, or a
// saved automation returns something other than what the operator marked,
// an operator-triggered assistant investigates the recording with tools —
// read any captured body in full, probe the site, open pages in a browser —
// and writes a small script for THIS session (runner/src/script.ts). The
// script is executed with the recorded inputs and must reproduce what the
// operator marked or saw before it is saved; from then on every run of the
// session executes that script. The LLM investigates and writes;
// deterministic code decides. Nothing unverified ever becomes a spec.
import Anthropic from '@anthropic-ai/sdk';
import { analyse, leaves, markKey, objectHasMark, type Analysis } from './analyse.js';
import { SPEC_VERSION, paramName, type Spec } from './generate.js';
import type { RunResult } from '../../runner/src/run.js';
import type { Bearer } from '../../runner/src/browser-token.js';
import { SCRIPT_FILE, getMeta, getScript, getSpec, readEvents, saveMeta, saveScript, saveSpec, status } from './store.js';
import { UA } from '../../runner/src/browser-token.js';
import { browserSession, cleanHeaders, lintScript, runScript, type ScriptOk } from '../../runner/src/script.js';

export type Emit = (kind: string, text: string) => void;

// Refining a saved automation: what the last run returned, as the session
// page saw it, and the operator's note on what was wrong with it. The two
// callbacks let the loop execute a saved spec and mint tokens the way the
// server does (cached per origin).
export type RepairInput = {
  feedback?: string;
  lastRun?: unknown;
  runSpec?: (spec: Spec, params: Record<string, string>) => Promise<RunResult>;
  readToken?: (loadUrl: string) => Promise<Bearer | undefined>;
};

export const MODEL = process.env.REPAIR_MODEL ?? 'claude-sonnet-5';

// Budget rails, all enforced here: the loop ends when any is reached.
const MAX_TURNS = 16;            // model calls
const MAX_TOOL_CALLS = 20;       // tool executions across the loop
const MAX_INPUT_TOKENS = 900_000; // cumulative, cache reads included
const MAX_SCRIPT_TRIES = 6;

const PAGE_CHARS = 12_000;       // one read_body page
const OVERVIEW_BODY = 240;       // body preview per net event in the overview
const CANDIDATE_BODY = 1_500;    // preview for calls carrying the typed value
const OVERVIEW_EVENTS = 400;

// Public list prices per million tokens, for the spend line at the end.
const PRICE: Record<string, { in: number; out: number }> = {
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-opus-5': { in: 5, out: 25 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};

const SYSTEM = `You are the repair assistant inside a local web-workflow automation tool. An operator recorded themselves demonstrating a workflow in a browser: typing a value, clicking, sometimes highlighting ("marking") the text they want every run to return. A deterministic analyser tries to turn the recording into an automation on its own. You are called when it could not, or when the automation it produced returned the wrong thing.

Your job: work out how the outcome the operator demonstrated can be reached again for ANY input value, then write a script that does it for this session. Investigate first, then write; do not guess when a tool can tell you.

TOOLS
- read_body: read a captured request or response body in full, page by page (the overview shows only previews). Pass seq for a recorded event, or probe for a probe result.
- probe: send one HTTP request and see the full response. Use it to test an endpoint you suspect (an API the page called on another host, a JSON variant of a JSONP call, a documented public API for the site), and to re-fetch bodies the recorder cut.
- open_page: load a URL in a headless browser, optionally act on it (fill, click, press, wait), and read its text, an element's HTML, or the result of a JavaScript expression evaluated in the page. Use it when results are rendered server-side or built by page scripts with no plain API.
- write_script: submit the script. It is linted, executed with the recorded inputs, and accepted only if it reproduces the recording (see ACCEPTANCE). On failure you get the reason and can submit again.
- set_columns: REFINE mode only, when the saved automation is a deterministic spec (not a script) and the operator wants fewer or different fields. Keeps the saved automation exactly as it is (its token step, pagination, everything) and only changes which fields each row returns. Always prefer this over rewriting a working automation as a script.
- give_up: when no automation is possible from this recording; say what the operator should do differently when re-recording.

Do not repeat a call you have already made with the same arguments; the answer will not change. If the browser route is not producing results after two tries, step back: look for the API in the recording and use it directly.

THE SCRIPT
Plain JavaScript (no import, require, process, eval). Define:
  async function run(ctx) { ... return rows; }
ctx.inputs   — the run's parameters, e.g. ctx.inputs.query (names given below). Read every parameter from here; never hard-code the recorded value.
ctx.http.fetch(url, { method, headers, body }) → { status, ok, url, contentType, text, json() }. body may be an object (sent as JSON) or a string. Cookie/authorization headers are dropped.
ctx.site.token(pageUrl) → the anonymous bearer the site mints for every visitor, read from its own web storage after loading pageUrl. Send it as headers: { authorization: 'Bearer ' + token }. This is the ONLY credential a script may send; any other authorization header is dropped. Use it whenever the API answers 401 (a saved automation with a browser-token step tells you the page URL to load).
ctx.browser.open(url) → page. page.goto(url), fill(selector, text), click(selector), press(selector, key), waitFor(selector, ms) → boolean, wait(ms), text(selector?) → string, texts(selector) → string[], html(selector?) → string, attr(selector, name), eval(expression) → JSON value evaluated in the page (e.g. "[...document.querySelectorAll('.row')].map(r => ({ name: r.querySelector('.n')?.textContent }))"), url(), close().
ctx.log(...)  — notes shown to the operator on failure. ctx.sleep(ms).
Return an array of flat row objects — one row per result, plain string/number fields, named as a person would name columns. Prefer a direct API call over driving the browser; use the browser only when no request returns the data.

ACCEPTANCE (deterministic, applied to every submission)
1. Lint: reads every ctx.inputs.<name>; contains no recorded value as a literal; no imports.
2. Executed with the recorded inputs within 90 seconds, returning at least one row.
3. If the operator marked text: each marked selection must appear as a field value in some row (plain text; citation markers and whitespace are ignored). Ask APIs for plain text rather than HTML. A partial match is reported so you can add the missing field.
4. If nothing was marked: some row must carry the typed value, or the text of a result the operator clicked.
Hosts the accepted script contacted are recorded; later runs are confined to them.

STYLE
Be brief in prose: one or two sentences before a tool call, stating what you are checking. Prefer endpoints seen in the recording; prefer the smallest response that carries the marked data (no polygons, no HTML when text is available). Never send credentials. When done, write_script; when impossible, give_up with concrete re-recording advice.`;

// --- trace overview -------------------------------------------------------

// A compact description of a JSON value: keys with types, arrays with length
// and the shape of their first element. Cheap to read, enough to plan a call.
function shapeOf(v: unknown, depth = 0): string {
  if (depth > 3) return '…';
  if (Array.isArray(v)) return v.length ? `[${v.length} × ${shapeOf(v[0], depth + 1)}]` : '[]';
  if (v && typeof v === 'object') {
    const entries = Object.entries(v);
    const inner = entries.slice(0, 14).map(([k, x]) => `${k}: ${shapeOf(x, depth + 1)}`).join(', ');
    return `{${inner}${entries.length > 14 ? `, …${entries.length - 14} more` : ''}}`;
  }
  if (typeof v === 'string') return `"${v.length > 40 ? v.slice(0, 40) + '…' : v}"`;
  return String(v);
}

function tryJson(s: unknown): unknown {
  if (typeof s !== 'string') return undefined;
  try { return JSON.parse(s); } catch { return undefined; }
}

function overview(events: Record<string, unknown>[], a: Analysis): string {
  const candidates = new Set(a.calls.filter((c) => c.matches.length).map((c) => c.seq));
  const lines: string[] = [];
  for (const e of events) {
    if (lines.length >= OVERVIEW_EVENTS) { lines.push(`… (${events.length - OVERVIEW_EVENTS} more events not listed; read_body still reaches them by seq)`); break; }
    const seq = `#${e.seq ?? '?'}`;
    const kind = String(e.kind);
    if (kind === 'net_meta') {
      const rt = String(e.resourceType ?? '');
      if (/image|stylesheet|font|media|ping/.test(rt)) continue;
      lines.push(`${seq} net_meta ${e.method} ${e.url} → ${e.status} (${rt}; body not captured — a script tag is JSONP or a page script)`);
    } else if (kind === 'net') {
      const body = String(e.resBody ?? '');
      const parsed = tryJson(body);
      const cut = typeof e.resTruncated === 'number' ? ` CUT by the recorder at ${body.length} of ${e.resTruncated} chars (probe the URL for the full body)` : '';
      const preview = candidates.has(Number(e.seq)) ? CANDIDATE_BODY : OVERVIEW_BODY;
      const flag = candidates.has(Number(e.seq)) ? ' [carries the typed value]' : '';
      const req = e.reqBody ? ` reqBody(${String(e.reqBody).length} chars): ${String(e.reqBody).slice(0, 200)}` : '';
      const hdr = e.reqHeaders && typeof e.reqHeaders === 'object'
        ? ` reqHeaders ${JSON.stringify(e.reqHeaders).slice(0, 300)}` : '';
      lines.push(`${seq} net ${e.method} ${e.url} → ${e.status} ${e.contentType ?? ''}${flag}${cut}${hdr}${req}`);
      lines.push(`     resBody(${body.length} chars)${parsed !== undefined ? ` shape ${shapeOf(parsed).slice(0, 600)}` : ''}: ${body.slice(0, preview).replace(/\s+/g, ' ')}${body.length > preview ? '…' : ''}`);
    } else if (kind === 'action') {
      const t = e.target as { selector?: string; text?: string; tag?: string; href?: string } | undefined;
      const text = t?.text ? ` text="${String(t.text).slice(0, 100).replace(/\n/g, ' / ')}"` : '';
      const value = e.value !== undefined ? ` value="${e.value}"` : '';
      const mark = e.action === 'mark' ? ` marked="${String(e.text ?? '').slice(0, 300)}"` : '';
      const href = t?.href ? ` href="${t.href}"` : '';
      lines.push(`${seq} action ${e.action} <${t?.tag ?? '?'}> ${t?.selector ?? ''}${value}${mark}${text}${href}`);
    } else if (kind === 'nav' || kind === 'page') {
      lines.push(`${seq} ${kind} ${e.url}${e.title ? ` "${String(e.title).slice(0, 80)}"` : ''}`);
    } else {
      lines.push(`${seq} ${kind}`);
    }
  }
  return lines.join('\n');
}

// Parameter names for the typed inputs, one per distinct value, by the
// generator's own rule (see paramName).
function paramNames(a: Analysis): { name: string; value: string; field: string }[] {
  const out: { name: string; value: string; field: string }[] = [];
  const used = new Set<string>();
  for (const i of a.inputs) {
    if (out.some((o) => o.value === i.value)) continue;
    const base = paramName(i.field);
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
    used.add(name);
    out.push({ name, value: i.value, field: i.field });
  }
  return out;
}

// Strings the operator demonstrably saw as results: text of links clicked
// after the last typed value (never form buttons), plus the marks.
function evidenceStrings(events: Record<string, unknown>[], a: Analysis): string[] {
  const out = new Set<string>();
  for (const m of a.marks) if (markKey(m)) out.add(markKey(m).slice(0, 60));
  const lastInput = Math.max(-1, ...events.filter((e) => e.kind === 'action' && e.action === 'input').map((e) => Number(e.seq) || 0));
  for (const e of events) {
    if (e.kind !== 'action' || e.action !== 'click' || (Number(e.seq) || 0) < lastInput) continue;
    const t = e.target as { text?: string; tag?: string; type?: string } | undefined;
    if (!t || t.tag === 'button' || t.tag === 'input' || t.tag === 'select' || t.tag === 'label' || t.tag === 'form') continue;
    const n = markKey(String(t.text ?? '').split('\n')[0]);
    if (n.length >= 4) out.add(n.slice(0, 60));
  }
  return [...out];
}

const shortMark = (m: string) => `"${markKey(m).slice(0, 60)}"`;

function describeSpec(spec: Spec, script: string | undefined): string {
  const steps = spec.steps.map((s) => s.type === 'request'
    ? `${s.method} ${s.url}${s.bodyTemplate !== undefined ? ` body ${JSON.stringify(s.bodyTemplate).slice(0, 300)}` : ''}`
    : s.type === 'script' ? `session script (${s.file}, hosts ${s.hosts.join(', ')})`
    : `${s.type} step`).join(' → ');
  const cols = spec.outcome.columns?.map((c) => c.name).join(', ');
  const base = `${steps}; rows at ${spec.outcome.extract.records ?? 'the whole response'}; ${cols ? `columns ${cols}` : 'no marked columns'}`;
  return script ? `${base}\n--- current script ---\n${script.slice(0, 6000)}\n--- end script ---` : base;
}

// The page reports the last run in its own words; only its shape is trusted.
function describeRun(r: unknown): string {
  const run = (r ?? {}) as { ok?: boolean; stoppedReason?: string; columns?: unknown; rowCount?: unknown; firstRow?: unknown };
  if (run.ok === false) return `stopped — ${String(run.stoppedReason ?? 'no reason given').slice(0, 300)}`;
  const cols = !Array.isArray(run.columns) ? 'unknown columns'
    : run.columns.length ? run.columns.map(String).join(', ').slice(0, 300) : 'no columns';
  const first = run.firstRow === undefined ? '' : `; first row: ${JSON.stringify(run.firstRow).slice(0, 400)}`;
  return `${Number(run.rowCount) || 0} row(s) with columns ${cols}${first}`;
}

// --- acceptance -------------------------------------------------------------

type Verdict =
  | { ok: true; run: ScriptOk; missing: string[]; columns: string[]; note: string }
  | { ok: false; reason: string; partial?: { run: ScriptOk; missing: string[]; columns: string[] } };

function rowText(row: unknown): string {
  return markKey([...leaves(row)].map(({ value }) => (typeof value === 'string' || typeof value === 'number' ? String(value) : '')).join(' '));
}

async function accept(source: string, params: { name: string; value: string }[], marks: string[], evidence: string[], readToken: ToolCtx['readToken']): Promise<Verdict> {
  const inputs = Object.fromEntries(params.map((p) => [p.name, p.value]));
  const lint = lintScript(source, inputs);
  if (lint.length) return { ok: false, reason: `lint: ${lint.join('; ')}` };
  const run = await runScript(source, { inputs, readToken });
  if ('error' in run) {
    return { ok: false, reason: `the script failed: ${run.error}${run.log.length ? ` — log: ${run.log.slice(-5).join(' | ')}` : ''}` };
  }
  if (!run.rows.length) {
    return { ok: false, reason: `the script returned no rows for the recorded input(s)${run.log.length ? ` — log: ${run.log.slice(-5).join(' | ')}` : ''}` };
  }
  const columns = [...new Set(run.rows.flatMap((r) => Object.keys(r)))];
  const missing = marks.filter((m) => !run.rows.some((r) => objectHasMark(r, m)));
  if (marks.length) {
    if (missing.length === marks.length) {
      return {
        ok: false,
        reason: `the rows carry none of the operator's marked selections as a field value (${marks.map(shortMark).join(', ')}). First row: ${JSON.stringify(run.rows[0]).slice(0, 400)}`,
      };
    }
    const note = missing.length ? `${marks.length - missing.length} of ${marks.length} marked selections located` : `all ${marks.length} marked selection(s) located`;
    if (missing.length) {
      return {
        ok: false,
        reason: `${note}; missing: ${missing.map(shortMark).join(', ')}. Add the field(s) that carry the missing text, or say why no source has it.`,
        partial: { run, missing, columns },
      };
    }
    return { ok: true, run, missing, columns, note };
  }
  // No marks: the typed value, or a clicked result, must be in the rows.
  const hay = run.rows.slice(0, 200).map(rowText).join('\n');
  const typed = params.find((p) => p.value.length >= 2 && hay.includes(markKey(p.value)));
  const seen = evidence.find((ev) => hay.includes(ev));
  if (!typed && !seen) {
    return {
      ok: false,
      reason: `the rows carry neither the typed value (${params.map((p) => `"${p.value}"`).join(', ')}) nor a result the operator clicked${evidence.length ? ` (${evidence.map((e) => `"${e}"`).join(', ')})` : ''}. First row: ${JSON.stringify(run.rows[0]).slice(0, 400)}`,
    };
  }
  return { ok: true, run, missing: [], columns, note: typed ? `rows carry the typed value "${typed.value}"` : `rows carry the clicked result "${seen}"` };
}

// --- tools -------------------------------------------------------------------

const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'read_body',
    description: 'Read a captured request/response body (by event seq) or a probe result (by probe id) in pages. Returns the page of text plus the total length and, for JSON, its shape.',
    input_schema: {
      type: 'object',
      properties: {
        seq: { type: 'integer', description: 'seq of a recorded net event' },
        probe: { type: 'integer', description: 'id of an earlier probe result' },
        part: { type: 'string', enum: ['response', 'request'], description: 'which body (default response)' },
        offset: { type: 'integer', description: 'character offset to start from (default 0)' },
        length: { type: 'integer', description: `characters to return (max ${PAGE_CHARS})` },
      },
      additionalProperties: false,
    },
    strict: true,
  } as Anthropic.Beta.BetaTool,
  {
    name: 'probe',
    description: 'Send one HTTP request (no cookies, no credentials) and see the response: status, content type, length, JSON shape and the first 4000 characters. The full body is kept as a probe result for read_body. To call a token-gated API, pass bearerFrom: the page URL whose anonymous bearer should be read and sent.',
    input_schema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST'] },
        url: { type: 'string' },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        body: { description: 'request body: an object (sent as JSON) or a string' },
        bearerFrom: { type: 'string', description: 'page URL to load for the site\'s anonymous bearer, sent as authorization' },
      },
      required: ['method', 'url'],
      additionalProperties: false,
    },
  },
  {
    name: 'open_page',
    description: 'Load a URL in a headless browser, optionally perform actions on it, then read the page: its visible text, the HTML of one element, or the JSON result of a JavaScript expression evaluated in the page.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        actions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              do: { type: 'string', enum: ['fill', 'click', 'press', 'wait'] },
              selector: { type: 'string' },
              value: { type: 'string', description: 'text to fill, key to press, or selector to wait for' },
            },
            required: ['do'],
            additionalProperties: false,
          },
        },
        read: { type: 'string', enum: ['text', 'html', 'eval'], description: 'what to return (default text)' },
        selector: { type: 'string', description: 'for text/html: limit to this element' },
        expression: { type: 'string', description: 'for eval: a JavaScript expression evaluated in the page' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_script',
    description: 'Submit the session script. It is linted, executed with the recorded inputs and checked against the recording; the result tells you whether it was accepted and, if not, exactly why.',
    input_schema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'the full script defining async function run(ctx)' },
        title: { type: 'string', description: 'short human name for the automation, e.g. "Wikipedia Article Lookup"' },
        summary: { type: 'string', description: 'one or two sentences: what the recording needed and how the script reaches the outcome' },
      },
      required: ['source', 'title', 'summary'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_columns',
    description: 'Refine mode, deterministic spec only: keep the saved automation and change which fields each row returns. Paths are relative to a record of the result set (dot-separated for nested fields). Verified by running the saved automation with the recorded input.',
    input_schema: {
      type: 'object',
      properties: {
        columns: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, path: { type: 'string' } },
            required: ['name', 'path'],
            additionalProperties: false,
          },
        },
        summary: { type: 'string', description: 'one sentence: what changed and why' },
      },
      required: ['columns', 'summary'],
      additionalProperties: false,
    },
  },
  {
    name: 'give_up',
    description: 'Declare that no automation can be derived from this recording, with concrete advice on how to re-record so that one can.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string' },
        advice: { type: 'string' },
      },
      required: ['reason', 'advice'],
      additionalProperties: false,
    },
  },
];

type ToolCtx = {
  events: Record<string, unknown>[];
  probes: { url: string; text: string }[];
  signal: AbortSignal;
  emit: Emit;
  readToken: (loadUrl: string) => Promise<Bearer | undefined>;
};

function pageOf(text: string, offset: number | undefined, length: number | undefined, label: string): string {
  const from = Math.max(0, offset ?? 0);
  const len = Math.min(PAGE_CHARS, Math.max(1, length ?? PAGE_CHARS));
  const parsed = tryJson(text);
  const head = `${label}: ${text.length} chars${parsed !== undefined ? `; JSON shape ${shapeOf(parsed).slice(0, 800)}` : ''}; showing ${from}–${Math.min(text.length, from + len)}`;
  return `${head}\n${text.slice(from, from + len)}${from + len < text.length ? `\n…(${text.length - from - len} more chars; call again with offset ${from + len})` : ''}`;
}

async function runTool(name: string, input: Record<string, unknown>, ctx: ToolCtx): Promise<string> {
  if (name === 'read_body') {
    const part = input.part === 'request' ? 'reqBody' : 'resBody';
    if (typeof input.probe === 'number') {
      const p = ctx.probes[input.probe];
      if (!p) return `no probe #${input.probe}`;
      return pageOf(p.text, input.offset as number, input.length as number, `probe #${input.probe} ${p.url}`);
    }
    const e = ctx.events.find((x) => x.kind === 'net' && Number(x.seq) === Number(input.seq));
    if (!e) return `no net event with seq ${input.seq} (net_meta events have no captured body — probe the URL instead)`;
    const text = String(e[part] ?? '');
    const cut = part === 'resBody' && typeof e.resTruncated === 'number' ? ` (CUT by the recorder; the full response was ${e.resTruncated} chars — probe the URL to fetch it in full)` : '';
    return pageOf(text, input.offset as number, input.length as number, `#${e.seq} ${part} of ${e.method} ${e.url}${cut}`);
  }
  if (name === 'probe') {
    const method = String(input.method ?? 'GET').toUpperCase();
    const url = String(input.url ?? '');
    const issued = new Set<string>();
    let bearerNote = '';
    if (typeof input.bearerFrom === 'string' && input.bearerFrom) {
      const tok = await ctx.readToken(input.bearerFrom).catch(() => undefined);
      if (!tok) return `probe not sent: no recognisable token after loading ${input.bearerFrom}`;
      issued.add(tok.bearer);
      bearerNote = ` with the bearer from ${tok.source}`;
    }
    const headers = cleanHeaders({ ...((input.headers as Record<string, string>) ?? {}), ...(issued.size ? { authorization: `Bearer ${[...issued][0]}` } : {}) }, issued);
    let body: string | undefined;
    if (input.body !== undefined && input.body !== null) {
      body = typeof input.body === 'string' ? input.body : JSON.stringify(input.body);
      if (typeof input.body !== 'string' && !headers['content-type']) headers['content-type'] = 'application/json; charset=utf-8';
    }
    ctx.emit('tool', `probe ${method} ${url}${bearerNote}`);
    try {
      const res = await fetch(url, { method, headers, ...(body === undefined ? {} : { body }), signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]) });
      const text = (await res.text()).slice(0, 8 * 1024 * 1024);
      const id = ctx.probes.push({ url, text }) - 1;
      const parsed = tryJson(text);
      return `probe #${id}: HTTP ${res.status} ${res.headers.get('content-type') ?? ''}; ${text.length} chars${parsed !== undefined ? `; JSON shape ${shapeOf(parsed).slice(0, 800)}` : ''}\n${text.slice(0, 4000)}${text.length > 4000 ? `\n…(read_body with probe ${id} for the rest)` : ''}`;
    } catch (e) {
      return `probe failed: ${(e as Error).message}`;
    }
  }
  if (name === 'open_page') {
    const url = String(input.url ?? '');
    ctx.emit('tool', `open_page ${url}${Array.isArray(input.actions) && input.actions.length ? ` (${input.actions.length} action(s))` : ''}`);
    const session = browserSession(undefined, ctx.signal);
    try {
      const page = await session.open(url);
      for (const act of (input.actions as { do: string; selector?: string; value?: string }[]) ?? []) {
        if (act.do === 'fill') await page.fill(String(act.selector), String(act.value ?? ''));
        else if (act.do === 'click') await page.click(String(act.selector));
        else if (act.do === 'press') await page.press(String(act.selector ?? 'body'), String(act.value ?? 'Enter'));
        else if (act.do === 'wait') {
          if (act.value && !/^\d+$/.test(act.value)) await page.waitFor(act.value);
          else if (act.selector) await page.waitFor(act.selector);
          else await page.wait(Number(act.value) || 1500);
        }
      }
      const read = String(input.read ?? 'text');
      const selector = input.selector ? String(input.selector) : undefined;
      let out: string;
      if (read === 'html') out = await page.html(selector);
      else if (read === 'eval') out = JSON.stringify(await page.eval(String(input.expression ?? 'null')), null, 1);
      else out = await page.text(selector);
      return `page ${page.url()}\n${out.slice(0, PAGE_CHARS)}${out.length > PAGE_CHARS ? `\n…(${out.length - PAGE_CHARS} more chars; narrow with selector or eval)` : ''}`;
    } catch (e) {
      return `open_page failed: ${(e as Error).message}`;
    } finally {
      await session.dispose();
    }
  }
  return `unknown tool ${name}`;
}

// --- set_columns ---------------------------------------------------------------

function resolvePath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((n, k) => (n && typeof n === 'object' ? (n as Record<string, unknown>)[k] : undefined), obj);
}

// Keep a working deterministic automation and change only its projection.
// Verified by running the saved spec with the recorded input: every column
// must resolve to a value in at least one record, and the marks (if any)
// must still be among the returned fields.
async function setColumns(
  args: Record<string, unknown>, existing: Spec | undefined, isScript: boolean,
  params: { name: string; value: string }[], marks: string[],
  runSpec: RepairInput['runSpec'], emit: Emit,
): Promise<{ saved: Spec; note: string } | { reason: string }> {
  if (!existing || isScript) return { reason: 'set_columns applies only to a saved deterministic automation; this session has none' };
  if (!runSpec) return { reason: 'the saved automation cannot be executed here' };
  const cols = Array.isArray(args.columns) ? (args.columns as { name?: unknown; path?: unknown }[])
    .map((c) => ({ name: String(c.name ?? '').trim().slice(0, 60), path: String(c.path ?? '').trim() }))
    .filter((c) => c.name && c.path) : [];
  if (!cols.length) return { reason: 'no columns given' };
  emit('try', `set_columns ${cols.map((c) => `${c.name}←${c.path}`).join(', ')} — running the saved automation with the recorded input…`);
  const bare: Spec = { ...existing, outcome: { ...existing.outcome, columns: undefined } };
  const result = await runSpec(bare, Object.fromEntries(params.map((p) => [p.name, p.value])));
  if (!result.ok) return { reason: `the saved automation stopped: ${result.stoppedReason}` };
  const rows = ((result.extracted?.records as { rows?: unknown[] } | undefined)?.rows ?? []);
  if (!rows.length) return { reason: 'the saved automation returned no rows for the recorded input' };
  const empty = cols.filter((c) => !rows.some((r) => { const v = resolvePath(r, c.path); return v !== undefined && v !== null && v !== ''; }));
  if (empty.length) {
    return { reason: `no record has a value at ${empty.map((c) => `"${c.path}"`).join(', ')}. Fields of the first record: ${Object.keys(rows[0] as object).join(', ')}` };
  }
  const projected = rows.map((r) => Object.fromEntries(cols.map((c) => [c.name, resolvePath(r, c.path)])));
  const missing = marks.filter((m) => !projected.some((r) => objectHasMark(r, m)));
  if (missing.length) return { reason: `the chosen fields drop the operator's marked selection(s) ${missing.map(shortMark).join(', ')}; include the field(s) that carry them` };
  const saved: Spec = {
    ...existing,
    outcome: { ...existing.outcome, columns: cols.map((c) => ({ name: c.name, path: c.path, scope: 'row' as const })) },
    repaired: { at: new Date().toISOString(), model: MODEL, diagnosis: String(args.summary ?? 'columns changed').slice(0, 600), mode: 'refine' },
  };
  emit('ok', `verified: ${rows.length} row(s), fields ${cols.map((c) => c.name).join(', ')}`);
  return { saved, note: `now returns ${cols.map((c) => c.name).join(', ')} (${rows.length} row(s) for the recorded input)` };
}

// --- the loop ----------------------------------------------------------------

function estimateSpend(model: string, usage: { input: number; cacheRead: number; cacheWrite: number; output: number }): string {
  const p = PRICE[model];
  if (!p) return `${usage.input + usage.cacheRead + usage.cacheWrite} input / ${usage.output} output tokens`;
  const usd = (usage.input * p.in + usage.cacheRead * p.in * 0.1 + usage.cacheWrite * p.in * 1.25 + usage.output * p.out) / 1e6;
  return `≈ $${usd.toFixed(2)} (${usage.input + usage.cacheRead + usage.cacheWrite} input / ${usage.output} output tokens)`;
}

export async function repairSession(id: string, emit: Emit, signal: AbortSignal, input: RepairInput = {}): Promise<void> {
  const meta = getMeta(id);
  if (!meta) { emit('error', 'unknown session'); return; }
  if (status(meta) !== 'complete') { emit('error', `session is ${status(meta)} — only complete recordings can be repaired`); return; }
  const existing = getSpec(id) as Spec | undefined;
  const existingScript = existing?.steps.find((s) => s.type === 'script');
  const mode = existing ? 'refine' : 'repair';
  const feedback = (input.feedback ?? '').trim();

  emit('info', 'Reading the recording…');
  const events = readEvents(id);
  const a = analyse({ meta: { session: id, status: 'complete' }, events });
  const marks = a.marks;
  const params = paramNames(a);
  const evidence = evidenceStrings(events, a);

  if (existing) {
    emit('info', `Refining the saved automation: ${describeSpec(existing, undefined).split('\n')[0]}.`);
    if (input.lastRun !== undefined) emit('info', `Last run returned: ${describeRun(input.lastRun)}`);
    emit('info', feedback ? `Your note: ${feedback}` : 'No note given — comparing your marked selections with what the run returned.');
  } else {
    emit('info', `Deterministic analysis refused: ${a.notes.join(' ') || 'no parameterised outcome call identified.'}`);
  }
  if (params.length) emit('info', `Parameters: ${params.map((p) => `${p.name}="${p.value}"`).join(', ')}`);
  if (marks.length) emit('info', `Marked while recording (${marks.length}): ${marks.map(shortMark).join(', ')}`);
  if (!params.length && !marks.length) {
    emit('advice', 'Nothing was typed and nothing was marked, so there is no input to parameterise and no result to verify against. Re-record: type the search value, and highlight the data you want returned, then click "Mark data".');
    emit('done', 'No automation is possible from this recording.');
    return;
  }

  const firstPage = events.find((e) => e.kind === 'page' && typeof e.url === 'string')?.url as string | undefined;
  const tokenStep = existing?.steps.find((s) => s.type === 'browser-token');
  const pack = [
    ...(existing ? [
      'MODE: REFINE. The session already has an automation, but its result did not match what the operator wanted.',
      `Current automation: ${describeSpec(existing, existingScript ? getScript(id, existingScript.file) : undefined)}`,
      ...(existingScript ? [] : ['The saved automation is a deterministic spec that works: if the operator wants fewer or different fields, use set_columns and keep it. Write a script only if the outcome itself must change.']),
      ...(tokenStep ? [`The saved automation obtains the site's anonymous bearer by loading ${tokenStep.loadUrl} (browser-token step). A script reaches the same API with: const token = await ctx.site.token(${JSON.stringify(tokenStep.loadUrl)}); then headers: { authorization: 'Bearer ' + token }. A probe reaches it with bearerFrom: ${JSON.stringify(tokenStep.loadUrl)}.`] : []),
      `Last run (what the operator received): ${input.lastRun === undefined ? 'not reported' : describeRun(input.lastRun)}`,
      `Operator feedback: ${feedback ? `"${feedback}"` : 'none — compare the marked selections with the last run yourself'}`,
      '',
    ] : ['MODE: REPAIR. The deterministic analyser could not derive an automation from this recording.', '']),
    `Session "${id}". Site: ${meta.hosts.join(', ')}. First page: ${firstPage ?? 'unknown'}. Language: ${a.language}.`,
    `Analyser notes: ${a.notes.join(' ') || 'none'}`,
    `Parameters (ctx.inputs) and their recorded values: ${params.map((p) => `${p.name}="${p.value}" (typed into ${p.field})`).join(', ') || 'NONE — this is a zero-parameter automation: the script takes no input and must return the marked data'}`,
    `Marked text (each must appear as a field value in the rows): ${marks.map((m) => `"${m.slice(0, 400)}"`).join(' | ') || 'none'}`,
    `Results the operator clicked (normalised): ${evidence.filter((e) => !marks.some((m) => markKey(m).startsWith(e))).map((e) => `"${e}"`).join(', ') || 'none'}`,
    '',
    `Recording (${events.length} events, ordered; bodies previewed — read_body for the full text):`,
    overview(events, a),
  ].join('\n');

  let client: Anthropic;
  try {
    // Identity-linked API keys refuse requests without the workspace id they
    // are scoped to; ANTHROPIC_WORKSPACE_ID in .env supplies it.
    const workspace = process.env.ANTHROPIC_WORKSPACE_ID;
    client = new Anthropic(workspace ? { defaultHeaders: { 'anthropic-workspace-id': workspace } } : {});
  } catch (e) {
    emit('error', `no API credentials: ${(e as Error).message}. Put ANTHROPIC_API_KEY=… in the project's .env and restart the backend.`);
    return;
  }

  const readToken = input.readToken ?? (async (loadUrl: string) => (await import('../../runner/src/browser-token.js')).readBearerViaBrowser(loadUrl));
  const ctx: ToolCtx = { events, probes: [], signal, emit, readToken };
  const seen = new Map<string, number>();
  const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  let toolCalls = 0;
  let scriptTries = 0;
  let partial: { source: string; title: string; summary: string; run: ScriptOk; missing: string[]; columns: string[] } | undefined;

  const save = (source: string, title: string, summary: string, run: ScriptOk, note: string) => {
    const columns = [...new Set(run.rows.flatMap((r) => Object.keys(r)))];
    saveScript(id, SCRIPT_FILE, source);
    const spec: Spec = {
      version: SPEC_VERSION,
      name: id,
      origin: firstPage ? new URL(firstPage).origin : `https://${meta.hosts[0]}`,
      language: a.language,
      parameters: params.map((p) => ({ name: p.name, example: p.value, required: true })),
      steps: [{ id: 'automation', type: 'script', file: SCRIPT_FILE, reason: summary, hosts: run.hosts }],
      outcome: { fromStep: 'automation', expect: { path: '__http_ok', equals: 'true' }, extract: { records: 'rows' } },
      repaired: { at: new Date().toISOString(), model: MODEL, diagnosis: summary, summary, mode, ...(feedback ? { feedback } : {}) },
    };
    saveSpec(id, spec);
    if (!meta.name && title) { meta.name = title.slice(0, 80); saveMeta(meta); }
    emit('saved', `Automation ${existing ? 'updated' : 'saved'}${!existing && title ? ` as "${title}"` : ''} — ${note}; ${run.rows.length} row(s) with columns ${columns.join(', ')}; hosts ${run.hosts.join(', ') || 'none'}. Run it with any new input — no re-recording needed.`);
  };
  const finish = (kind: string, text: string) => {
    emit(kind, text);
    emit('info', `Spend this repair: ${estimateSpend(MODEL, usage)}`);
  };
  // The operator pressed Stop (or left the page). Nothing unverified is
  // saved, but a partially verified attempt is kept as it would be at the
  // budget limit.
  const stopped = () => {
    if (partial) { save(partial.source, partial.title, partial.summary, partial.run, `stopped by the operator; kept the best verified attempt (${marks.length - partial.missing.length} of ${marks.length} marked selections)`); finish('done', 'Stopped by the operator; saved the partial automation.'); return; }
    finish('done', existing ? 'Stopped by the operator; the saved automation is unchanged.' : 'Stopped by the operator.');
  };

  const messages: Anthropic.Beta.BetaMessageParam[] = [{
    role: 'user',
    content: [{ type: 'text', text: pack, cache_control: { type: 'ephemeral' } }],
  }];
  const betas: string[] = [];
  const fallbackable = /opus|fable/.test(MODEL);
  if (fallbackable) betas.push('server-side-fallback-2026-07-01');

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    if (signal.aborted) { stopped(); return; }
    if (usage.input + usage.cacheRead + usage.cacheWrite > MAX_INPUT_TOKENS) {
      if (partial) { save(partial.source, partial.title, partial.summary, partial.run, `token budget reached; kept the best verified attempt (${marks.length - partial.missing.length} of ${marks.length} marked selections)`); finish('done', 'Budget reached.'); return; }
      finish('done', 'Token budget for this repair reached without a verified automation.');
      return;
    }
    emit('llm', `Turn ${turn}: ${MODEL} is thinking…`);
    let msg: Anthropic.Beta.BetaMessage;
    try {
      const stream = client.beta.messages.stream({
        model: MODEL,
        max_tokens: 12_000,
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        tools: TOOLS,
        messages,
        ...(betas.length ? { betas } : {}),
        ...(fallbackable ? { fallbacks: 'default' as const } : {}),
      } as Parameters<typeof client.beta.messages.stream>[0], { signal });
      msg = await stream.finalMessage();
    } catch (e) {
      if (signal.aborted) { stopped(); return; }
      finish('error', `model call failed: ${(e as Error).message}`);
      return;
    }
    usage.input += msg.usage.input_tokens;
    usage.output += msg.usage.output_tokens;
    usage.cacheRead += msg.usage.cache_read_input_tokens ?? 0;
    usage.cacheWrite += msg.usage.cache_creation_input_tokens ?? 0;
    if (msg.stop_reason === 'refusal') { finish('error', 'the model declined to work on this recording'); return; }

    for (const b of msg.content) if (b.type === 'text' && b.text.trim()) emit('llm', b.text.trim());
    const uses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    messages.push({ role: 'assistant', content: msg.content });
    if (!uses.length) {
      if (msg.stop_reason === 'max_tokens') {
        messages.push({ role: 'user', content: 'Your reply was cut off. Continue, and keep prose short: the script goes in write_script.' });
        continue;
      }
      messages.push({ role: 'user', content: 'Continue with a tool call: investigate with read_body/probe/open_page, submit with write_script, or give_up with re-recording advice.' });
      continue;
    }

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const use of uses) {
      const args = (use.input ?? {}) as Record<string, unknown>;
      toolCalls++;
      if (use.name === 'give_up') {
        emit('llm', String(args.reason ?? ''));
        emit('advice', String(args.advice ?? 'the model sees no automatable path in this recording'));
        if (partial) { save(partial.source, partial.title, partial.summary, partial.run, `kept the best verified attempt (${marks.length - partial.missing.length} of ${marks.length} marked selections)`); finish('done', 'Saved the partial automation.'); return; }
        finish('done', existing
          ? 'No better automation was verified; the saved one is unchanged. Add a note describing the problem and try again, or re-record following the advice above.'
          : 'No automation is possible from this recording. Re-record following the advice above.');
        return;
      }
      if (use.name === 'write_script') {
        scriptTries++;
        const source = String(args.source ?? '');
        const title = String(args.title ?? '').slice(0, 80);
        const summary = String(args.summary ?? '').slice(0, 600);
        emit('try', `Script attempt ${scriptTries}: executing with the recorded input(s)… (${source.length} chars)`);
        const v = await accept(source, params, marks, evidence, readToken);
        if (v.ok) {
          emit('ok', `verified: ${v.note}; ${v.run.rows.length} row(s), columns ${v.columns.join(', ')}, hosts ${v.run.hosts.join(', ') || 'none'}, ${(v.run.ms / 1000).toFixed(1)}s`);
          save(source, title, summary, v.run, v.note);
          finish('done', 'Done.');
          return;
        }
        emit('fail', v.reason);
        if (v.partial && (!partial || partial.missing.length > v.partial.missing.length)) {
          partial = { source, title, summary, run: v.partial.run, missing: v.partial.missing, columns: v.partial.columns };
        }
        if (scriptTries >= MAX_SCRIPT_TRIES) {
          if (partial) { save(partial.source, partial.title, partial.summary, partial.run, `attempt limit reached; kept the best verified attempt (${marks.length - partial.missing.length} of ${marks.length} marked selections)`); finish('done', 'Saved the partial automation.'); return; }
          finish('done', `No working automation after ${MAX_SCRIPT_TRIES} script attempts. The recording may need to be redone.`);
          return;
        }
        results.push({ type: 'tool_result', tool_use_id: use.id, content: `REJECTED: ${v.reason}`, is_error: true });
        continue;
      }
      if (use.name === 'set_columns') {
        const out = await setColumns(args, existing, existingScript !== undefined, params, marks, input.runSpec, emit);
        if ('saved' in out) {
          saveSpec(id, out.saved);
          emit('saved', `Automation updated — ${out.note}. Run it with any new input.`);
          finish('done', 'Done.');
          return;
        }
        results.push({ type: 'tool_result', tool_use_id: use.id, content: `REJECTED: ${out.reason}`, is_error: true });
        continue;
      }
      if (toolCalls > MAX_TOOL_CALLS) {
        results.push({ type: 'tool_result', tool_use_id: use.id, content: 'Tool budget exhausted: submit write_script now with your best script, or give_up.', is_error: true });
        continue;
      }
      // The same call with the same arguments returns the same answer; the
      // third repetition is refused so a stuck loop cannot spend the budget.
      const key = `${use.name}:${JSON.stringify(args)}`;
      const times = (seen.get(key) ?? 0) + 1;
      seen.set(key, times);
      if (times >= 3) {
        results.push({ type: 'tool_result', tool_use_id: use.id, content: `You have already made this exact call ${times - 1} times; the result will not change. Take a different approach (the API in the recording, ctx.site.token for a 401, set_columns for fewer fields) or give_up.`, is_error: true });
        continue;
      }
      if (use.name === 'read_body') emit('tool', `read_body ${typeof args.probe === 'number' ? `probe #${args.probe}` : `#${args.seq}`}${args.offset ? ` from ${args.offset}` : ''}`);
      const out = await runTool(use.name, args, ctx).catch((e) => `tool failed: ${(e as Error).message}`);
      results.push({ type: 'tool_result', tool_use_id: use.id, content: out });
      if (signal.aborted) { stopped(); return; }
    }
    messages.push({ role: 'user', content: results });
  }
  if (partial) { save(partial.source, partial.title, partial.summary, partial.run, `turn limit reached; kept the best verified attempt (${marks.length - partial.missing.length} of ${marks.length} marked selections)`); finish('done', 'Saved the partial automation.'); return; }
  finish('done', existing
    ? `No better automation was verified after ${MAX_TURNS} turns; the saved one is unchanged.`
    : `No working automation found after ${MAX_TURNS} turns. The recording may need to be redone.`);
}
