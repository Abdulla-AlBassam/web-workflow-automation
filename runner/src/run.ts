// Execute stage: run a spec against a new input under supervision. Direct
// requests where the spec says so, a browser step only for what a request
// cannot reach. Validates the outcome and stops with a named reason on any
// mismatch — it never reports a failed run as a success.
import type { Spec, Step } from '../../backend/src/generate.js';

export type RunResult = {
  ok: boolean;
  stoppedReason?: string;
  steps: { id: string; type: string; detail: string }[];
  outcome?: { expected: string; actual: string; matched: boolean };
  extracted?: Record<string, unknown>;
};

type TokenReader = (loadUrl: string, readToken: string) => Promise<string | undefined>;

function resolvePath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((n, k) => (n && typeof n === 'object' ? (n as any)[k] : undefined), obj);
}

function setPath(obj: unknown, path: string, value: unknown) {
  const keys = path.split('.');
  const parent = keys.slice(0, -1).reduce<unknown>((n, k) => (n && typeof n === 'object' ? (n as any)[k] : undefined), obj);
  if (parent && typeof parent === 'object') (parent as any)[keys.at(-1)!] = value;
}

const PAGE_DELAY_MS = 400;
const MAX_PAGES = 50;

function substitute(template: unknown, params: Record<string, string>): unknown {
  if (Array.isArray(template)) return template.map((v) => substitute(v, params));
  if (template && typeof template === 'object') {
    return Object.fromEntries(Object.entries(template).map(([k, v]) => [k, substitute(v, params)]));
  }
  if (typeof template === 'string') {
    const m = template.match(/^\{\{(\w+)\}\}$/);
    if (m) return params[m[1]] ?? template;
    return template.replace(/\{\{(\w+)\}\}/g, (_, n) => params[n] ?? `{{${n}}}`);
  }
  return template;
}

export async function run(spec: Spec, params: Record<string, string>, deps: { readToken: TokenReader }): Promise<RunResult> {
  const steps: RunResult['steps'] = [];
  const bearers: Record<string, string> = {};

  for (const p of spec.parameters) {
    if (p.required && !params[p.name]) {
      return { ok: false, stoppedReason: `missing required parameter "${p.name}"`, steps };
    }
  }

  let finalResponse: { httpStatus: number; body: unknown } | undefined;
  let outcomeRequest: { url: string; method: string; headers: Record<string, string>; body: unknown } | undefined;

  for (const step of spec.steps) {
    if (step.type === 'browser-token') {
      const raw = await deps.readToken(step.loadUrl, step.readToken).catch((e) => {
        throw new Error(`token step: ${e.message}`);
      });
      if (!raw) {
        return { ok: false, stoppedReason: `token step "${step.id}": site issued no token at ${step.readToken}`, steps };
      }
      let bearer: string;
      try {
        bearer = String(resolvePath(JSON.parse(raw), step.bearerPath));
      } catch {
        return { ok: false, stoppedReason: `token step "${step.id}": token blob was not the expected JSON`, steps };
      }
      if (!bearer || bearer === 'undefined') {
        return { ok: false, stoppedReason: `token step "${step.id}": no "${step.bearerPath}" in token blob`, steps };
      }
      bearers[step.id] = bearer;
      steps.push({ id: step.id, type: step.type, detail: `token acquired (${bearer.length} chars)` });
    } else {
      // URL placeholders take the parameter URL-encoded; body values go raw.
      const url = step.url.replace(/\{\{(\w+)\}\}/g, (_, n) => encodeURIComponent(params[n] ?? ''));
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
      finalResponse = { httpStatus: res.status, body: parsed };
      outcomeRequest = { url, method: step.method, headers, body };
      steps.push({ id: step.id, type: step.type, detail: `${step.method} → HTTP ${res.status}` });
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
    extracted[name] = Array.isArray(v) ? { count: v.length, rows: v } : v;
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

  return { ok: true, steps, outcome: { expected: `${expect.path}=${expect.equals}`, actual, matched }, extracted };
}
