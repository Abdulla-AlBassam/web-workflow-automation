import { embeddedTokenRegex, leaves, norm, type Analysis, type Call, type Match } from './analyse.js';

// Bumped whenever the generator learns something new (e.g. pagination), so
// saved specs from an older generator are refreshed before use.
export const SPEC_VERSION = 9;

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
    // Present when the operator marked text while recording: each column is
    // where that marked value lives in the outcome response. Row-scoped paths
    // resolve against each record; body-scoped against the whole response.
    columns?: { name: string; path: string; scope: 'row' | 'body' }[];
    // Present when the outcome call is page-based: the runner re-issues it
    // with an incremented page value until the extracted total is reached.
    pagination?: { pagePath: string };
  };
};

export type Step =
  // The token itself is discovered at run time from the site's web storage;
  // the spec records only where to load from and why the step exists.
  | { id: string; type: 'browser-token'; loadUrl: string; reason: string }
  // Server-rendered outcome: a browser loads the linked page and reads the
  // operator-marked elements. Carries a reason like every browser step.
  | { id: string; type: 'browser-extract'; url: string; reason: string;
      link?: { fromStep: string; rowsPath?: string; path: string; pick: 'best-match'; encoded: boolean };
      extracts: { name: string; selector: string }[] }
  // url may contain {{param}} placeholders (URL-encoded at run time); GET
  // workflows have no bodyTemplate at all. A step with `link` is chained: its
  // URL's {{link}} placeholder is filled from an earlier step's response — the
  // value at `path`, inside the picked record when rowsPath is set.
  | { id: string; type: 'request'; method: string; url: string; headers: Record<string, string>; bearerFrom?: string; bodyTemplate?: unknown;
      link?: { fromStep: string; rowsPath?: string; path: string; pick: 'best-match'; encoded: boolean } };

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

// Composite-string parameters: the value sits inside a larger string field,
// so the placeholder is spliced over the bounded token rather than replacing
// the leaf. The placeholder keeps the encoding the recording used ({{enc:x}},
// {{plus:x}}), and a raw token in key=value position becomes {{enc:x}} anyway:
// a no-op for the recorded value, correct for future values with spaces.
function embedTemplatise(body: unknown, embeds: { token: string; name: string; value: string }[]): unknown {
  const walk = (n: unknown): unknown => {
    if (Array.isArray(n)) return n.map(walk);
    if (n && typeof n === 'object') {
      return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, walk(v)]));
    }
    if (typeof n !== 'string') return n;
    let s = n;
    for (const e of embeds) {
      s = s.replace(embeddedTokenRegex(e.token), (_, offset: number, str: string) => {
        const mode = e.token !== e.value
          ? (e.token === encodeURIComponent(e.value) ? 'enc:' : 'plus:')
          : str[offset - 1] === '=' ? 'enc:' : '';
        return `{{${mode}${e.name}}}`;
      });
    }
    return s;
  };
  return walk(body);
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

// Marked text is evidence, not the extraction itself: find where each marked
// value lives in the outcome response and record its path as a column. Paths
// inside the record set become row-relative, so a future run yields the same
// field for every row — the mark generalises beyond the recorded value.
function markColumns(call: Call, recordsPath: string | undefined, marks: string[]) {
  let body: unknown;
  try { body = JSON.parse(call.resBody ?? ''); } catch { return undefined; }
  const cols: { name: string; path: string; scope: 'row' | 'body' }[] = [];
  for (const mark of marks) {
    const m = norm(mark);
    let hit: { path: string; exact: boolean } | undefined;
    for (const { path, value } of leaves(body)) {
      if (typeof value !== 'string' && typeof value !== 'number') continue;
      const v = norm(String(value));
      if (!v) continue;
      if (v === m) { hit = { path, exact: true }; break; }
      if (!hit && m.length >= 8 && v.includes(m)) hit = { path, exact: false };
    }
    if (!hit) continue;
    let path = hit.path;
    let scope: 'row' | 'body' = 'body';
    if (recordsPath && path.startsWith(recordsPath + '.')) {
      path = path.slice(recordsPath.length + 1).replace(/^\d+\.?/, '');
      scope = 'row';
    }
    if (cols.some((c) => c.path === path && c.scope === scope)) continue;
    const base = path.split('.').at(-1) || 'value';
    let name = base;
    for (let i = 2; cols.some((c) => c.name === name); i++) name = `${base}_${i}`;
    cols.push({ name, path, scope });
  }
  return cols.length ? cols : undefined;
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
      reason: `direct call needs a bearer token (probe returned ${opts.probeStatus ?? analysis.authHint}); the site issues one client-side, read back from its web storage`,
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
    const embeds = [...new Map(groups
      .flatMap((g) => g.matches
        .filter((m) => m.where === 'body-embedded')
        .map((m) => [`${g.name} ${m.token}`, { token: m.token, name: g.name, value: g.value }] as const))
    ).values()];
    if (embeds.length) bodyTemplate = embedTemplatise(bodyTemplate, embeds);
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

  // Chained workflow: the true outcome is the later call the search fed. The
  // runner re-resolves the link per run from the search step's fresh response.
  const chain = analysis.chain;
  const final = chain?.call ?? outcome;
  if (chain) {
    let detailBody: unknown;
    if (chain.call.reqBody) {
      try { detailBody = JSON.parse(chain.call.reqBody); } catch { detailBody = chain.call.reqBody; }
    }
    steps.push({
      id: 'detail',
      type: 'request',
      method: chain.call.method,
      url: chain.call.url.split(chain.linkToken).join('{{link}}'),
      headers: {
        accept: '*/*',
        ...(detailBody !== undefined ? { 'content-type': 'application/json; charset=utf-8' } : {}),
      },
      ...(needsAuth ? { bearerFrom: 'token' } : {}),
      ...(detailBody !== undefined ? { bodyTemplate: detailBody } : {}),
      link: {
        fromStep: 'search',
        ...(chain.rowsPath ? { rowsPath: chain.rowsPath } : {}),
        path: chain.linkPath,
        pick: 'best-match',
        encoded: chain.encoded,
      },
    });
  }

  // Server-rendered outcome: the marked data lives on a page the search
  // response links to, so a browser step reads the marked elements from it.
  const pageChain = analysis.pageChain;
  if (pageChain) {
    steps.push({
      id: 'extract',
      type: 'browser-extract',
      url: pageChain.url.split(pageChain.linkToken).join('{{link}}'),
      reason: 'the marked data is rendered into the page rather than returned by an API; a browser reads the operator-marked elements',
      link: {
        fromStep: 'search',
        ...(pageChain.rowsPath ? { rowsPath: pageChain.rowsPath } : {}),
        path: pageChain.linkPath,
        pick: 'best-match',
        encoded: pageChain.encoded,
      },
      extracts: pageChain.extracts.map(({ name, selector }) => ({ name, selector })),
    });
    return {
      version: SPEC_VERSION,
      name: opts.name,
      origin: opts.origin,
      language: analysis.language,
      parameters: groups.map((g) => ({ name: g.name, example: g.value, required: true })),
      steps,
      outcome: {
        fromStep: 'extract',
        expect: { path: '__http_ok', equals: 'true' },
        extract: {},
        columns: pageChain.extracts.map(({ name }) => ({ name, path: name, scope: 'body' as const })),
      },
    };
  }

  const extract = extractionPaths(final);
  const pagination = chain ? undefined : detectPagination(final, extract);
  const columns = markColumns(final, extract.records, analysis.marks);
  return {
    version: SPEC_VERSION,
    name: opts.name,
    origin: opts.origin,
    language: analysis.language,
    parameters: groups.map((g) => ({ name: g.name, example: g.value, required: true })),
    steps,
    outcome: {
      fromStep: chain ? 'detail' : 'search',
      expect: outcomeExpectation(final),
      extract,
      ...(columns ? { columns } : {}),
      ...(pagination ? { pagination } : {}),
    },
  };
}
