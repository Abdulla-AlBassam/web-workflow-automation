import type { Analysis, Call } from './analyse.js';

export type Spec = {
  version: 1;
  name: string;
  origin: string;
  language: string;
  parameters: { name: string; example: string; required: boolean }[];
  steps: Step[];
  outcome: { fromStep: string; expect: { path: string; equals: string }; extract: Record<string, string> };
};

export type Step =
  | { id: string; type: 'browser-token'; loadUrl: string; readToken: string; bearerPath: string; reason: string }
  | { id: string; type: 'request'; method: string; url: string; headers: Record<string, string>; bearerFrom?: string; bodyTemplate: unknown };

// Replace a matched leaf value with {{name}} everywhere it appears, so nested
// DataTables payloads survive. Value-matched, not path-matched, on purpose.
function templatise(body: string, value: string, name: string): unknown {
  const parsed = JSON.parse(body);
  const walk = (n: unknown): unknown => {
    if (Array.isArray(n)) return n.map(walk);
    if (n && typeof n === 'object') {
      return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, walk(v)]));
    }
    return n === value ? `{{${name}}}` : n;
  };
  return walk(parsed);
}

function paramName(field: string): string {
  return /name|cr_|query|search|term/i.test(field) ? field.replace(/[^\w]/g, '_') : 'query';
}

// The response field that gates success: prefer an explicit status field, else
// the record-count field the analysis already located.
function outcomeExpectation(call: Call): { path: string; equals: string } {
  const parsed = JSON.parse(call.resBody ?? '{}');
  if (parsed && typeof parsed === 'object' && 'Status_Code' in parsed) {
    return { path: 'Status_Code', equals: String((parsed as any).Status_Code) };
  }
  return { path: '__http_ok', equals: 'true' };
}

function extractionPaths(call: Call): Record<string, string> {
  const shape = call.resultShape ?? '';
  const at = shape.match(/at ([\w.]+)$/)?.[1];
  const out: Record<string, string> = {};
  if (at) out.records = at;
  const parsed = JSON.parse(call.resBody ?? '{}');
  if (parsed?.jsonData?.Total_Records !== undefined) out.total = 'jsonData.Total_Records';
  return out;
}

export function toSpec(analysis: Analysis, opts: { name: string; origin: string; loadUrl: string; probeStatus?: number }): Spec {
  // An interrupted session is evidence for review, never a source of automation.
  if (analysis.status !== 'complete') {
    throw new Error(`session is ${analysis.status}; not plan-eligible`);
  }
  const outcome = analysis.outcome;
  if (!outcome) throw new Error(`cannot generate a spec: ${analysis.notes.join('; ') || 'no outcome call identified'}`);

  const match = outcome.matches[0];
  const pname = paramName(match.input.field);
  const needsAuth = opts.probeStatus === 401 || opts.probeStatus === 403 || !!analysis.authHint;

  const steps: Step[] = [];
  if (needsAuth) {
    steps.push({
      id: 'token',
      type: 'browser-token',
      loadUrl: opts.loadUrl,
      readToken: 'localStorage.accessToken',
      bearerPath: 'access_token',
      reason: `direct call needs a bearer token (probe returned ${opts.probeStatus ?? analysis.authHint}); the site issues one client-side for anonymous users`,
    });
  }
  steps.push({
    id: 'search',
    type: 'request',
    method: outcome.method,
    url: outcome.url,
    headers: { 'content-type': 'application/json; charset=utf-8', accept: '*/*' },
    ...(needsAuth ? { bearerFrom: 'token' } : {}),
    bodyTemplate: templatise(outcome.reqBody!, match.value, pname),
  });

  return {
    version: 1,
    name: opts.name,
    origin: opts.origin,
    language: analysis.language,
    parameters: [{ name: pname, example: match.value, required: true }],
    steps,
    outcome: { fromStep: 'search', expect: outcomeExpectation(outcome), extract: extractionPaths(outcome) },
  };
}
