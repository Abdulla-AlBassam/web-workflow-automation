// Execute stage: run a spec against a new input under supervision. Direct
// requests where the spec says so, a browser step only for what a request
// cannot reach. Validates the outcome and stops with a named reason on any
// mismatch — it never reports a failed run as a success.
import { leaves, norm } from '../../backend/src/analyse.js';
import type { Spec, Step } from '../../backend/src/generate.js';
import type { ScriptResult } from './script.js';

export type RunResult = {
  ok: boolean;
  stoppedReason?: string;
  steps: { id: string; type: string; detail: string }[];
  outcome?: { expected: string; actual: string; matched: boolean };
  extracted?: Record<string, unknown>;
};

type TokenReader = (loadUrl: string) => Promise<{ bearer: string; source: string } | undefined>;
type PageExtractor = (url: string, selectors: string[]) => Promise<{ httpStatus: number; texts: (string | undefined)[] }>;
// Session scripts are read from wherever the spec lives (the session folder,
// or next to a spec file on the CLI); the caller binds that location.
type ScriptRunner = (file: string, inputs: Record<string, string>, hosts: string[]) => Promise<ScriptResult>;
export type RunDeps = { readToken: TokenReader; extractPage: PageExtractor; runScript?: ScriptRunner };

type Link = { fromStep: string; rowsPath?: string; path: string; pick: 'best-match'; encoded: boolean };

function resolvePath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((n, k) => (n && typeof n === 'object' ? (n as any)[k] : undefined), obj);
}

function setPath(obj: unknown, path: string, value: unknown) {
  const keys = path.split('.');
  const parent = keys.slice(0, -1).reduce<unknown>((n, k) => (n && typeof n === 'object' ? (n as any)[k] : undefined), obj);
  if (parent && typeof parent === 'object') (parent as any)[keys.at(-1)!] = value;
}

// Records keyed by id rather than listed: every value is an object with at
// least one scalar field of its own (a wrapper around one such map is not).
function isRecordMap(v: unknown): v is Record<string, object> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const values = Object.values(v);
  return values.length > 0 && values.every((x) => x && typeof x === 'object' && !Array.isArray(x)
    && Object.values(x).some((f) => f === null || typeof f !== 'object'));
}

const PAGE_DELAY_MS = 400;
const MAX_PAGES = 50;

// Which record does the chain follow for a new input? The one that best
// matches the run's parameter values; ties and no-matches take the first row,
// mirroring how result lists rank the best hit on top.
function pickRow(rows: unknown[], params: Record<string, string>): unknown {
  const values = Object.values(params).map(norm).filter(Boolean);
  let best = rows[0];
  let bestScore = 0;
  for (const row of rows) {
    let score = 0;
    for (const { value } of leaves(row)) {
      if (typeof value !== 'string' && typeof value !== 'number') continue;
      const s = norm(String(value));
      for (const v of values) if (s.includes(v)) score++;
    }
    if (score > bestScore) { bestScore = score; best = row; }
  }
  return best;
}

function substitute(template: unknown, params: Record<string, string>): unknown {
  if (Array.isArray(template)) return template.map((v) => substitute(v, params));
  if (template && typeof template === 'object') {
    return Object.fromEntries(Object.entries(template).map(([k, v]) => [k, substitute(v, params)]));
  }
  if (typeof template === 'string') {
    const m = template.match(/^\{\{(\w+)\}\}$/);
    if (m) return params[m[1]] ?? template;
    // Embedded placeholders splice into composite strings; enc:/plus: keep
    // the encoding the recording used inside them.
    return template.replace(/\{\{(?:(enc|plus):)?(\w+)\}\}/g, (_, mode, n) => {
      const v = params[n];
      if (v === undefined) return `{{${mode ? `${mode}:` : ''}${n}}}`;
      // plus is full form-encoding (spaces as +), not just a space swap, so a
      // future value carrying & or = cannot break the composite string.
      return mode === 'enc' ? encodeURIComponent(v) : mode === 'plus' ? encodeURIComponent(v).replace(/%20/g, '+') : v;
    });
  }
  return template;
}

// Resolve a chained step's {{link}} from the feeding step's fresh response.
function followLink(
  stepId: string, url: string, link: Link,
  responses: Record<string, unknown>, params: Record<string, string>,
): { url: string; note: string } | { stop: string } {
  const src = responses[link.fromStep];
  if (src === undefined) {
    return { stop: `chain step "${stepId}" links from "${link.fromStep}", which did not run` };
  }
  let source: unknown = src;
  if (link.rowsPath) {
    const rows = resolvePath(src, link.rowsPath);
    if (!Array.isArray(rows) || rows.length === 0) {
      return { stop: `chain step "${stepId}": no records at ${link.rowsPath} to follow — the search returned nothing` };
    }
    source = pickRow(rows, params);
  }
  const linkVal = resolvePath(source, link.path);
  if (linkVal === undefined || linkVal === null) {
    return { stop: `chain step "${stepId}": no value at ${link.path} to follow` };
  }
  const sub = link.encoded ? encodeURIComponent(String(linkVal)) : String(linkVal);
  return { url: url.split('{{link}}').join(sub), note: ` (followed ${link.path}=${String(linkVal).slice(0, 40)})` };
}

export async function run(spec: Spec, params: Record<string, string>, deps: RunDeps): Promise<RunResult> {
  const steps: RunResult['steps'] = [];
  const bearers: Record<string, string> = {};

  for (const p of spec.parameters) {
    if (p.required && !params[p.name]) {
      return { ok: false, stoppedReason: `missing required parameter "${p.name}"`, steps };
    }
  }

  let finalResponse: { httpStatus: number; body: unknown } | undefined;
  let outcomeRequest: { url: string; method: string; headers: Record<string, string>; body: unknown } | undefined;
  const responses: Record<string, unknown> = {};

  for (const step of spec.steps) {
    if (step.type === 'browser-token') {
      // A browser that fails to launch or load is a stop with a reason, like
      // every other failure here; it must never surface as a server error.
      let tok: Awaited<ReturnType<TokenReader>>;
      try {
        tok = await deps.readToken(step.loadUrl);
      } catch (e) {
        return { ok: false, stoppedReason: `token step "${step.id}": ${(e as Error).message.split('\n')[0]}`, steps };
      }
      if (!tok) {
        return { ok: false, stoppedReason: `token step "${step.id}": site issued no recognisable token after loading ${step.loadUrl}`, steps };
      }
      bearers[step.id] = tok.bearer;
      steps.push({ id: step.id, type: step.type, detail: `token from ${tok.source} (${tok.bearer.length} chars)` });
    } else if (step.type === 'script') {
      if (!deps.runScript) return { ok: false, stoppedReason: `script step "${step.id}": no script runner available`, steps };
      const r = await deps.runScript(step.file, params, step.hosts);
      if ('error' in r) {
        return { ok: false, stoppedReason: `script step "${step.id}": ${r.error}`, steps };
      }
      const body = { rows: r.rows };
      responses[step.id] = body;
      finalResponse = { httpStatus: 200, body };
      outcomeRequest = undefined;
      steps.push({ id: step.id, type: step.type, detail: `${r.rows.length} row(s) in ${(r.ms / 1000).toFixed(1)}s via ${r.hosts.join(', ') || 'no network'}` });
    } else if (step.type === 'browser-extract') {
      let linkNote = '';
      let pageUrl = step.url;
      if (step.link) {
        const followed = followLink(step.id, pageUrl, step.link, responses, params);
        if ('stop' in followed) return { ok: false, stoppedReason: followed.stop, steps };
        pageUrl = followed.url;
        linkNote = followed.note;
      }
      let got: Awaited<ReturnType<PageExtractor>>;
      try {
        got = await deps.extractPage(pageUrl, step.extracts.map((e) => e.selector));
      } catch (e) {
        return { ok: false, stoppedReason: `extract step "${step.id}": ${(e as Error).message.split('\n')[0]}`, steps };
      }
      const missing = step.extracts.find((_, i) => got.texts[i] === undefined);
      if (missing) {
        return { ok: false, stoppedReason: `extract step "${step.id}": nothing at selector "${missing.selector}" on ${pageUrl} — the page no longer matches the recording`, steps };
      }
      const body = Object.fromEntries(step.extracts.map((e, i) => [e.name, got.texts[i]]));
      responses[step.id] = body;
      finalResponse = { httpStatus: got.httpStatus, body };
      outcomeRequest = undefined; // a page read is never re-issued for pagination
      steps.push({ id: step.id, type: step.type, detail: `page loaded → HTTP ${got.httpStatus}, ${step.extracts.length} marked element(s) read${linkNote}` });
    } else {
      // Chained step: resolve the link value from the previous step's fresh
      // response before parameter substitution touches the URL.
      let linkNote = '';
      let stepUrl = step.url;
      if (step.link) {
        const followed = followLink(step.id, stepUrl, step.link, responses, params);
        if ('stop' in followed) return { ok: false, stoppedReason: followed.stop, steps };
        stepUrl = followed.url;
        linkNote = followed.note;
      }
      // URL placeholders take the parameter URL-encoded; body values go raw.
      const url = stepUrl.replace(/\{\{(\w+)\}\}/g, (_, n) => encodeURIComponent(params[n] ?? ''));
      const body = step.bodyTemplate === undefined ? undefined : substitute(step.bodyTemplate, params);
      const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
      const headers: Record<string, string> = { ...step.headers };
      if (step.bearerFrom) {
        const b = bearers[step.bearerFrom];
        if (!b) return { ok: false, stoppedReason: `request "${step.id}" needs bearer from "${step.bearerFrom}", which did not run`, steps };
        headers.authorization = `Bearer ${b}`;
      }
      let res: Response;
      try {
        res = await fetch(url, { method: step.method, headers, ...(payload === undefined ? {} : { body: payload }) });
      } catch (e) {
        return { ok: false, stoppedReason: `request "${step.id}" failed to reach ${url}: ${(e as Error).message}`, steps };
      }
      const text = await res.text();
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { parsed = text; }
      responses[step.id] = parsed;
      finalResponse = { httpStatus: res.status, body: parsed };
      outcomeRequest = { url, method: step.method, headers, body };
      steps.push({ id: step.id, type: step.type, detail: `${step.method} → HTTP ${res.status}${linkNote}` });
    }
  }

  if (!finalResponse) return { ok: false, stoppedReason: 'spec produced no outcome response', steps };

  const { expect, extract, fromStep } = spec.outcome;
  const actual = expect.path === '__http_ok'
    ? String(finalResponse.httpStatus >= 200 && finalResponse.httpStatus < 300)
    : String(resolvePath(finalResponse.body, expect.path));
  const matched = actual === expect.equals;

  if (!matched) {
    return {
      ok: false,
      stoppedReason: `outcome check failed at step "${fromStep}": expected ${expect.path}="${expect.equals}", got "${actual}" (HTTP ${finalResponse.httpStatus})`,
      steps,
      outcome: { expected: `${expect.path}=${expect.equals}`, actual, matched },
    };
  }

  const extracted: Record<string, unknown> = {};
  for (const [name, path] of Object.entries(extract)) {
    const v = resolvePath(finalResponse.body, path);
    if (name !== 'records') { extracted[name] = v; continue; }
    // The record set is usually an array; some APIs key records by id
    // instead, and a single record may sit there bare. A path that resolves
    // to nothing is an empty result, never the whole response as one record.
    const rows = Array.isArray(v) ? v : isRecordMap(v) ? Object.values(v) : v && typeof v === 'object' ? [v] : [];
    extracted.records = { count: rows.length, rows };
  }

  // Fetch the remaining pages when the spec says the outcome is page-based.
  const pg = spec.outcome.pagination;
  const records = extracted.records as { count: number; rows: unknown[] } | undefined;
  const total = Number(extracted.total);
  if (pg && outcomeRequest && records && !Number.isNaN(total) && records.rows.length > 0 && total > records.rows.length) {
    const all = [...records.rows];
    let page = Number(resolvePath(outcomeRequest.body, pg.pagePath)) || 1;
    while (all.length < total && page < MAX_PAGES) {
      page++;
      await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
      setPath(outcomeRequest.body, pg.pagePath, page);
      let res: Response;
      try {
        res = await fetch(outcomeRequest.url, {
          method: outcomeRequest.method, headers: outcomeRequest.headers, body: JSON.stringify(outcomeRequest.body),
        });
      } catch (e) {
        return { ok: false, stoppedReason: `pagination failed at page ${page}: ${(e as Error).message}`, steps };
      }
      const body = await res.json().catch(() => undefined);
      const pageOk = expect.path === '__http_ok' ? res.ok : String(resolvePath(body, expect.path)) === expect.equals;
      if (!pageOk) {
        return { ok: false, stoppedReason: `pagination failed at page ${page}: outcome check no longer matched (HTTP ${res.status})`, steps };
      }
      const rows = resolvePath(body, extract.records) as unknown[] | undefined;
      if (!Array.isArray(rows) || rows.length === 0) break;
      all.push(...rows);
    }
    extracted.records = { count: all.length, rows: all };
    steps.push({ id: 'paginate', type: 'pagination', detail: `fetched ${page} pages, ${all.length} of ${total} rows` });
  }

  // An outcome that is one object (a detail page's data) still renders and
  // exports as a table: one row, the whole response.
  if (!extracted.records && finalResponse.body && typeof finalResponse.body === 'object' && !Array.isArray(finalResponse.body)) {
    extracted.records = { count: 1, rows: [finalResponse.body] };
  }

  // Marked-column projection: the operator highlighted what they wanted, so
  // rows carry exactly those fields. Row-scoped paths resolve per record;
  // body-scoped against the outcome response (one row when no record set).
  const cols = spec.outcome.columns;
  if (cols?.length) {
    const rec = extracted.records as { count: number; rows: unknown[] } | undefined;
    const source = cols.some((c) => c.scope === 'row') && rec ? rec.rows : [undefined];
    const rows = source.map((row) => Object.fromEntries(cols.map((c) => [
      c.name,
      c.scope === 'row'
        ? (c.path === '' ? row : resolvePath(row, c.path))
        : resolvePath(finalResponse!.body, c.path),
    ])));
    extracted.records = { count: rows.length, rows };
  }

  return { ok: true, steps, outcome: { expected: `${expect.path}=${expect.equals}`, actual, matched }, extracted };
}
