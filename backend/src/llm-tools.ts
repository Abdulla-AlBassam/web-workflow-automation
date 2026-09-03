// What every model-driven loop shares: how a recording is shown to the model
// (the overview, the navigation route, the parameters and evidence), the
// investigation tools (read a captured body or page snapshot, probe an
// endpoint, open a page) and the spend estimate. The loops themselves —
// repair.ts (fix a refused or wrong automation) and effort.ts (Maximum
// Effort Mode) — own their prompts, acceptance and budgets.
import type Anthropic from '@anthropic-ai/sdk';
import { markKey, leaves, type Analysis } from './analyse.js';
import { paramName } from './generate.js';
import type { Bearer } from '../../runner/src/browser-token.js';
import { browserSession, cleanHeaders } from '../../runner/src/script.js';

export type Emit = (kind: string, text: string, extra?: Record<string, unknown>) => void;

export const PAGE_CHARS = 12_000;       // one read_body / read_snapshot page
const OVERVIEW_BODY = 240;              // body preview per net event in the overview
const CANDIDATE_BODY = 1_500;           // preview for calls carrying the typed value
const SNAPSHOT_PREVIEW = 400;           // page-text preview per snapshot
const OVERVIEW_EVENTS = 600;

// Public list prices per million tokens, for the spend line at the end.
const PRICE: Record<string, { in: number; out: number }> = {
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-opus-5': { in: 5, out: 25 },
  'claude-fable-5-1': { in: 10, out: 50 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};

export type Usage = { input: number; cacheRead: number; cacheWrite: number; output: number };

export function estimateSpend(model: string, usage: Usage): string {
  const p = PRICE[model];
  if (!p) return `${usage.input + usage.cacheRead + usage.cacheWrite} input / ${usage.output} output tokens`;
  const usd = (usage.input * p.in + usage.cacheRead * p.in * 0.1 + usage.cacheWrite * p.in * 1.25 + usage.output * p.out) / 1e6;
  return `≈ $${usd.toFixed(2)} (${usage.input + usage.cacheRead + usage.cacheWrite} input / ${usage.output} output tokens)`;
}

// A compact description of a JSON value: keys with types, arrays with length
// and the shape of their first element. Cheap to read, enough to plan a call.
export function shapeOf(v: unknown, depth = 0): string {
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

export function tryJson(s: unknown): unknown {
  if (typeof s !== 'string') return undefined;
  try { return JSON.parse(s); } catch { return undefined; }
}

export type Ev = Record<string, unknown>;

export function overview(events: Ev[], a: Analysis): string {
  const candidates = new Set(a.calls.filter((c) => c.matches.length).map((c) => c.seq));
  const lines: string[] = [];
  for (const e of events) {
    if (lines.length >= OVERVIEW_EVENTS) { lines.push(`… (${events.length - OVERVIEW_EVENTS} more events not listed; read_body and read_snapshot still reach them by seq)`); break; }
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
      const rhdr = e.resHeaders && typeof e.resHeaders === 'object'
        ? ` resHeaders ${JSON.stringify(e.resHeaders).slice(0, 300)}` : '';
      lines.push(`${seq} net ${e.method} ${e.url} → ${e.status} ${e.contentType ?? ''}${flag}${cut}${hdr}${rhdr}${req}`);
      lines.push(`     resBody(${body.length} chars)${parsed !== undefined ? ` shape ${shapeOf(parsed).slice(0, 600)}` : ''}: ${body.slice(0, preview).replace(/\s+/g, ' ')}${body.length > preview ? '…' : ''}`);
    } else if (kind === 'action') {
      const t = e.target as { selector?: string; text?: string; tag?: string; href?: string; aria?: string; name?: string; placeholder?: string } | undefined;
      const text = t?.text ? ` text="${String(t.text).slice(0, 100).replace(/\n/g, ' / ')}"` : '';
      const label = t?.aria ? ` label="${String(t.aria).slice(0, 80)}"` : t?.placeholder ? ` placeholder="${String(t.placeholder).slice(0, 80)}"` : '';
      const value = e.value !== undefined ? ` value="${e.value}"` : e.checked !== undefined ? ` checked=${e.checked}` : '';
      const mark = e.action === 'mark' ? ` marked="${String(e.text ?? '').slice(0, 300)}"` : '';
      const href = t?.href ? ` href="${t.href}"` : '';
      const markup = e.html ? ` html=${JSON.stringify(String(e.html).slice(0, 300))}` : '';
      const option = e.label ? ` option="${String(e.label).slice(0, 80)}"` : '';
      const form = e.form as { method?: string; action?: string; fields?: unknown[] } | undefined;
      const submitted = form ? ` form ${form.method} ${form.action} fields ${JSON.stringify(form.fields ?? []).slice(0, 500)}` : '';
      lines.push(`${seq} action ${e.action} <${t?.tag ?? '?'}> ${t?.selector ?? ''}${label}${value}${option}${mark}${text}${href}${submitted}${markup}`);
    } else if (kind === 'nav' || kind === 'page') {
      lines.push(`${seq} ${kind} ${e.url}${e.title ? ` "${String(e.title).slice(0, 80)}"` : ''}`);
    } else if (kind === 'snapshot') {
      const text = String(e.text ?? '');
      const html = String(e.html ?? '');
      const st = e.storage as { local?: string[]; session?: string[] } | undefined;
      const storage = st && (st.local?.length || st.session?.length) ? ` web storage keys (names only): local [${(st.local ?? []).join(', ')}] session [${(st.session ?? []).join(', ')}].` : '';
      lines.push(`${seq} snapshot (${e.reason ?? 'page'}) ${e.url}${e.title ? ` "${String(e.title).slice(0, 80)}"` : ''} — what the operator saw: text ${text.length} chars, html ${html.length} chars${e.htmlTruncated ? ' (html cut)' : ''}.${storage} read_snapshot ${e.seq} for the full page.`);
      lines.push(`     text: ${text.slice(0, SNAPSHOT_PREVIEW).replace(/\s+/g, ' ')}${text.length > SNAPSHOT_PREVIEW ? '…' : ''}`);
    } else {
      lines.push(`${seq} ${kind}`);
    }
  }
  return lines.join('\n');
}

// The route the operator took, as URLs: each navigation (page loads count
// too, for recordings made before nav events existed), and for a page
// that only re-queried the same path, just the query parameters that
// changed. Filters, sorts and price bounds show up here as plain names.
export function navSummary(events: Ev[]): string {
  const lines: string[] = [];
  let prev: URL | undefined;
  for (const e of events) {
    // A POST form carries its inputs in the body, not the URL that follows.
    const form = e.kind === 'action' && e.action === 'submit' ? e.form as { method?: string; action?: string; fields?: unknown[] } | undefined : undefined;
    if (form?.method === 'POST') lines.push(`#${e.seq} form POST ${form.action} with fields ${JSON.stringify(form.fields ?? []).slice(0, 400)}`);
    if ((e.kind !== 'nav' && e.kind !== 'page') || typeof e.url !== 'string') continue;
    let u: URL;
    try { u = new URL(e.url); } catch { continue; }
    if (prev && prev.href === u.href) continue;
    if (prev && prev.origin === u.origin && prev.pathname === u.pathname) {
      const changed: string[] = [];
      for (const [k, v] of u.searchParams) if (prev.searchParams.get(k) !== v) changed.push(`${k}=${v}`);
      for (const [k] of prev.searchParams) if (!u.searchParams.has(k)) changed.push(`−${k}`);
      lines.push(`#${e.seq} same page, query changed: ${changed.join(' ') || '(no change)'}`);
    } else {
      lines.push(`#${e.seq} ${u.href}`);
    }
    prev = u;
  }
  return lines.join('\n') || 'no navigation recorded';
}

// Parameter names for the typed inputs, one per distinct value, by the
// generator's own rule (see paramName).
export function paramNames(a: Analysis): { name: string; value: string; field: string }[] {
  const out: { name: string; value: string; field: string }[] = [];
  const used = new Set<string>();
  for (const i of a.inputs) {
    if (out.some((o) => o.value === i.value)) continue;
    const base = paramName(i.field, i.label);
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
    used.add(name);
    out.push({ name, value: i.value, field: i.field });
  }
  return out;
}

// Strings the operator demonstrably saw as results: text of links clicked
// after the last typed value (never form buttons), plus the marks.
export function evidenceStrings(events: Ev[], a: Analysis): string[] {
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

export const shortMark = (m: string) => `"${markKey(m).slice(0, 60)}"`;

export function rowText(row: unknown): string {
  return markKey([...leaves(row)].map(({ value }) => (typeof value === 'string' || typeof value === 'number' ? String(value) : '')).join(' '));
}

// --- tools -------------------------------------------------------------------

export const INVESTIGATE_TOOLS: Anthropic.Beta.BetaTool[] = [
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
    name: 'read_snapshot',
    description: 'Read a page snapshot the recorder took while the operator was looking at it: the visible text, or the pruned HTML (scripts, styles and inline handlers removed; ids, classes, hrefs and data attributes kept). Pass the snapshot event\'s seq, or omit it for the last snapshot of the recording. Paged like read_body.',
    input_schema: {
      type: 'object',
      properties: {
        seq: { type: 'integer', description: 'seq of a snapshot event (default: the last snapshot)' },
        part: { type: 'string', enum: ['text', 'html'], description: 'visible text or pruned HTML (default text)' },
        offset: { type: 'integer', description: 'character offset to start from (default 0)' },
        length: { type: 'integer', description: `characters to return (max ${PAGE_CHARS})` },
      },
      additionalProperties: false,
    },
  },
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
];

export type ToolCtx = {
  events: Ev[];
  probes: { url: string; text: string }[];
  signal: AbortSignal;
  emit: Emit;
  readToken: (loadUrl: string) => Promise<Bearer | undefined>;
};

export function pageOf(text: string, offset: number | undefined, length: number | undefined, label: string): string {
  const from = Math.max(0, offset ?? 0);
  const len = Math.min(PAGE_CHARS, Math.max(1, length ?? PAGE_CHARS));
  const parsed = tryJson(text);
  const head = `${label}: ${text.length} chars${parsed !== undefined ? `; JSON shape ${shapeOf(parsed).slice(0, 800)}` : ''}; showing ${from}–${Math.min(text.length, from + len)}`;
  return `${head}\n${text.slice(from, from + len)}${from + len < text.length ? `\n…(${text.length - from - len} more chars; call again with offset ${from + len})` : ''}`;
}

export function lastSnapshot(events: Ev[]): Ev | undefined {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].kind === 'snapshot') return events[i];
  return undefined;
}

// Runs one investigation tool; returns the text the model sees. Unknown
// names are the caller's (write_script, set_columns, give_up).
export async function runTool(name: string, input: Record<string, unknown>, ctx: ToolCtx): Promise<string> {
  if (name === 'read_body') {
    const part = input.part === 'request' ? 'reqBody' : 'resBody';
    if (typeof input.probe === 'number') {
      const p = ctx.probes[input.probe];
      if (!p) return `no probe #${input.probe}`;
      return pageOf(p.text, input.offset as number, input.length as number, `probe #${input.probe} ${p.url}`);
    }
    const e = ctx.events.find((x) => x.kind === 'net' && Number(x.seq) === Number(input.seq));
    if (!e) return `no net event with seq ${input.seq} (net_meta events have no captured body — probe the URL instead; a page snapshot is read with read_snapshot)`;
    const text = String(e[part] ?? '');
    const cut = part === 'resBody' && typeof e.resTruncated === 'number' ? ` (CUT by the recorder; the full response was ${e.resTruncated} chars — probe the URL to fetch it in full)` : '';
    return pageOf(text, input.offset as number, input.length as number, `#${e.seq} ${part} of ${e.method} ${e.url}${cut}`);
  }
  if (name === 'read_snapshot') {
    const e = typeof input.seq === 'number'
      ? ctx.events.find((x) => x.kind === 'snapshot' && Number(x.seq) === Number(input.seq))
      : lastSnapshot(ctx.events);
    if (!e) return typeof input.seq === 'number' ? `no snapshot event with seq ${input.seq}` : 'this recording has no page snapshots (recorded before snapshots existed, or the extension was not reloaded); open_page reaches the live page instead';
    const part = input.part === 'html' ? 'html' : 'text';
    const cut = part === 'html' && e.htmlTruncated ? ' (cut by the recorder at this length)' : '';
    return pageOf(String(e[part] ?? ''), input.offset as number, input.length as number, `#${e.seq} snapshot ${part} of ${e.url} (${e.reason ?? 'page'})${cut}`);
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
