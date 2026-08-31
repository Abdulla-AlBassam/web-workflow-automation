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
      const body = substitute(step.bodyTemplate, params);
      const headers: Record<string, string> = { ...step.headers };
      if (step.bearerFrom) {
        const b = bearers[step.bearerFrom];
        if (!b) return { ok: false, stoppedReason: `request "${step.id}" needs bearer from "${step.bearerFrom}", which did not run`, steps };
        headers.authorization = `Bearer ${b}`;
      }
      let res: Response;
      try {
        res = await fetch(step.url, { method: step.method, headers, body: JSON.stringify(body) });
      } catch (e) {
        return { ok: false, stoppedReason: `request "${step.id}" failed to reach ${step.url}: ${(e as Error).message}`, steps };
      }
      const text = await res.text();
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { parsed = text; }
      finalResponse = { httpStatus: res.status, body: parsed };
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
    // Arrays are summarised with a small sample so the UI can show real rows
    // without shipping the whole record set around.
    extracted[name] = Array.isArray(v) ? { count: v.length, sample: v.slice(0, 10) } : v;
  }

  return { ok: true, steps, outcome: { expected: `${expect.path}=${expect.equals}`, actual, matched }, extracted };
}
