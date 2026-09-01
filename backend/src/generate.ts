import { leaves, type Analysis, type Call, type Match } from './analyse.js';

// Bumped whenever the generator learns something new (e.g. pagination), so
// saved specs from an older generator are refreshed before use.
export const SPEC_VERSION = 3;

export type Spec = {
  version: number;
  name: string;
  origin: string;
  language: string;
  parameters: { name: string; example: string; required: boolean }[];
  steps: Step[];
  outcome: {
    fromStep: string;
    expect: { path: string; equals: string };
    extract: Record<string, string>;
    // Present when the outcome call is page-based: the runner re-issues it
    // with an incremented page value until the extracted total is reached.
    pagination?: { pagePath: string };
  };
};

export type Step =
  | { id: string; type: 'browser-token'; loadUrl: string; readToken: string; bearerPath: string; reason: string }
  // url may contain {{param}} placeholders (URL-encoded at run time); GET
  // workflows have no bodyTemplate at all.
  | { id: string; type: 'request'; method: string; url: string; headers: Record<string, string>; bearerFrom?: string; bodyTemplate?: unknown };

// Replace matched leaf values with {{name}} everywhere they appear, so nested
// DataTables payloads survive. Value-matched, not path-matched, on purpose.
function templatise(body: string, byValue: Map<string, string>): unknown {
  const parsed = JSON.parse(body);
  const walk = (n: unknown): unknown => {
    if (Array.isArray(n)) return n.map(walk);
    if (n && typeof n === 'object') {
      return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, walk(v)]));
    }
    return typeof n === 'string' && byValue.has(n) ? `{{${byValue.get(n)}}}` : n;
  };
  return walk(parsed);
}

function paramName(field: string): string {
  return /name|cr_|query|search|term/i.test(field) ? field.replace(/[^\w]/g, '_') : 'query';
}

// One parameter per distinct typed value found in the outcome call. A value
// that landed in both the body and the URL is still one parameter.
type ParamGroup = { name: string; value: string; matches: Match[] };

function paramGroups(matches: Match[]): ParamGroup[] {
  const groups: ParamGroup[] = [];
  for (const m of matches) {
    let g = groups.find((x) => x.value === m.value);
    if (!g) groups.push((g = { name: '', value: m.value, matches: [] }));
    g.matches.push(m);
  }
  const used = new Set<string>();
  for (const g of groups) {
    const base = paramName(g.matches[0].input.field);
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base}_${i}`;
    used.add(name);
    g.name = name;
  }
  return groups;
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
  for (const { path, value } of leaves(JSON.parse(call.resBody ?? '{}'))) {
    const key = path.split('.').at(-1) ?? '';
    if (/total/i.test(key) && !Number.isNaN(Number(value))) { out.total = path; break; }
  }
  return out;
}

// Page-based outcome: a numeric request field named like "page" plus a total
// in the response means the recording only saw one page of the result.
function detectPagination(call: Call, extract: Record<string, string>): { pagePath: string } | undefined {
  if (!extract.total || !extract.records) return undefined;
  for (const { path, value } of leaves(JSON.parse(call.reqBody ?? '{}'))) {
    const key = path.split('.').at(-1) ?? '';
    if (/^page(_?number)?$/i.test(key) && typeof value === 'number') return { pagePath: path };
  }
  return undefined;
}

export function toSpec(analysis: Analysis, opts: { name: string; origin: string; loadUrl: string; probeStatus?: number }): Spec {
  // An interrupted session is evidence for review, never a source of automation.
  if (analysis.status !== 'complete') {
    throw new Error(`session is ${analysis.status}; not plan-eligible`);
  }
  const outcome = analysis.outcome;
  if (!outcome) throw new Error(`cannot generate a spec: ${analysis.notes.join('; ') || 'no outcome call identified'}`);

  const groups = paramGroups(outcome.matches);
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
  let url = outcome.url;
  for (const g of groups) {
    for (const m of g.matches) {
      if (m.where === 'url') url = url.split(m.token).join(`{{${g.name}}}`);
    }
  }
  let bodyTemplate: unknown;
  if (outcome.reqBody) {
    const bodyValues = new Map(
      groups.filter((g) => g.matches.some((m) => m.where === 'body')).map((g) => [g.value, g.name]));
    if (bodyValues.size) {
      bodyTemplate = templatise(outcome.reqBody, bodyValues);
    } else {
      // Constant body alongside URL-borne parameters: keep it verbatim.
      try { bodyTemplate = JSON.parse(outcome.reqBody); } catch { bodyTemplate = outcome.reqBody; }
    }
  }
  steps.push({
    id: 'search',
    type: 'request',
    method: outcome.method,
    url,
    headers: {
      accept: '*/*',
      ...(bodyTemplate !== undefined ? { 'content-type': 'application/json; charset=utf-8' } : {}),
    },
    ...(needsAuth ? { bearerFrom: 'token' } : {}),
    ...(bodyTemplate !== undefined ? { bodyTemplate } : {}),
  });

  const extract = extractionPaths(outcome);
  const pagination = detectPagination(outcome, extract);
  return {
    version: SPEC_VERSION,
    name: opts.name,
    origin: opts.origin,
    language: analysis.language,
    parameters: groups.map((g) => ({ name: g.name, example: g.value, required: true })),
    steps,
    outcome: {
      fromStep: 'search',
      expect: outcomeExpectation(outcome),
      extract,
      ...(pagination ? { pagination } : {}),
    },
  };
}
