import { compositeMatches, embeddedTokenRegex, leaves, markKey, markMatches, objectHasMark, type Analysis, type Call, type Match } from './analyse.js';
import { requestHeaders } from './probe.js';

// Bumped whenever the generator learns something new (e.g. pagination), so
// saved specs from an older generator are refreshed before use.
export const SPEC_VERSION = 14;

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
    columns?: Column[];
    // Present when the outcome call is page-based: the runner re-issues it
    // with an incremented page value until the extracted total is reached.
    pagination?: { pagePath: string };
  };
  // Present when the spec came from the LLM repair loop rather than the
  // deterministic generator. Such specs are never auto-regenerated: the
  // generator would only refuse again. Mode "refine" means the loop replaced
  // an automation whose runs the operator flagged, with their note if given.
  repaired?: { at: string; model: string; diagnosis: string; mode?: 'repair' | 'refine'; feedback?: string; summary?: string };
};

export type Column = { name: string; path: string; scope: 'row' | 'body' };

export type Step =
  // The token itself is discovered at run time from the site's web storage;
  // the spec records only where to load from and why the step exists.
  | { id: string; type: 'browser-token'; loadUrl: string; reason: string }
  // A session script written by the LLM repair assistant for this recording
  // alone (see runner/src/script.ts): `file` sits in the session folder,
  // `hosts` is the list it was verified against and is confined to.
  | { id: string; type: 'script'; file: string; reason: string; hosts: string[] }
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

// The parameter takes the field's own id when that id reads like a name a
// person chose (letters first, three characters or more, no generated
// numeric suffix such as "input-3" or "mat-input-0", not a generic word).
// Anything else becomes "query". Shared with the repair loop so a script and
// a deterministic spec name the same parameter for the same field.
export function paramName(field: string): string {
  const id = field.replace(/[^\w]/g, '_');
  const chosen = /^[A-Za-z]/.test(id) && id.length >= 3 && !/[_-]?\d+$/.test(id) && !/^(field|input|text|textbox|value)$/i.test(id);
  return chosen ? id : 'query';
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

// The response field that gates success: a top-level field named like a
// status whose recorded value looks like a code or a verdict (200, true,
// "ok"), else the HTTP status. A status word that varies per query
// ("found") would fail an empty search, so only code-shaped values qualify.
const STATUS_KEY = /^(status_?code|status|success|ok)$/i;
const STATUS_VALUE = /^(\d{3}|ok|success|true)$/i;
function outcomeExpectation(call: Call): { path: string; equals: string } {
  const parsed = JSON.parse(call.resBody ?? '{}');
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!STATUS_KEY.test(key)) continue;
      if ((typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') && STATUS_VALUE.test(String(value))) {
        return { path: key, equals: String(value) };
      }
    }
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
// field for every row — the mark generalises beyond the recorded value. An
// exact hit beats a containing field, and a hit inside the record set beats
// one elsewhere: an echo of the typed input in a bookkeeping field must not
// become the column.
export function locateColumns(body: unknown, recordsPath: string | undefined, marks: string[]): Column[] | undefined {
  const cols: Column[] = [];
  const inRows = (path: string) => !!recordsPath && path.startsWith(recordsPath + '.');
  for (const mark of marks) {
    const m = markKey(mark);
    let hit: { path: string; rank: number } | undefined;
    for (const { path, value } of leaves(body)) {
      if (!markMatches(value, mark)) continue;
      const rank = (markKey(String(value)) === m ? 2 : 0) + (inRows(path) ? 1 : 0);
      if (!hit || rank > hit.rank) hit = { path, rank };
    }
    const add = (full: string) => {
      let path = full;
      let scope: 'row' | 'body' = 'body';
      if (inRows(path)) {
        // Drop the row's own index or key: records may be keyed by id.
        path = path.slice(recordsPath!.length + 1).replace(/^[^.]+\.?/, '');
        scope = 'row';
      }
      if (cols.some((c) => c.path === path && c.scope === scope)) return;
      const base = path.split('.').at(-1) || 'value';
      let name = base;
      for (let i = 2; cols.some((c) => c.name === name); i++) name = `${base}_${i}`;
      cols.push({ name, path, scope });
    };
    if (hit) { add(hit.path); continue; }
    // No single field carries the selection: it may span several cells of
    // one record. Try each record on its own, best coverage wins.
    const groups = new Map<string, { path: string; value: unknown }[]>();
    for (const f of leaves(body)) {
      const key = inRows(f.path) ? f.path.slice(0, recordsPath!.length + 1) + f.path.slice(recordsPath!.length + 1).split('.')[0] : '';
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(f);
    }
    let best: { path: string; at: number }[] = [];
    for (const fields of groups.values()) {
      const found = compositeMatches(mark, fields);
      if (found.length > best.length) best = found;
    }
    for (const f of best) add(f.path);
  }
  return cols.length ? cols : undefined;
}

// Marked selections no field of the response carries, for honest reporting.
export function missingMarks(body: unknown, marks: string[]): string[] {
  return marks.filter((mark) => !objectHasMark(body, mark));
}

// Page-based outcome: a numeric request field named like "page" plus a total
// in the response means the recording only saw one page of the result.
function detectPagination(call: Call, extract: Record<string, string>): { pagePath: string } | undefined {
  if (!extract.total || !extract.records) return undefined;
  // Form-encoded bodies cannot express a re-issuable JSON page field.
  let body: unknown;
  try { body = JSON.parse(call.reqBody ?? '{}'); } catch { return undefined; }
  for (const { path, value } of leaves(body)) {
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
  let formBody = false;
  if (outcome.reqBody) {
    try { JSON.parse(outcome.reqBody); } catch { formBody = outcome.reqBody.includes('='); }
    const bodyValues = new Map(
      groups.filter((g) => g.matches.some((m) => m.where === 'body')).map((g) => [g.value, g.name]));
    if (bodyValues.size && !formBody) {
      bodyTemplate = templatise(outcome.reqBody, bodyValues);
    } else if (bodyValues.size) {
      // Form-encoded body: the values matched on the decoded fields, so
      // splice encoding-aware placeholders into the raw string instead.
      const formEmbeds = [...bodyValues].flatMap(([value, name]) => {
        const token = [encodeURIComponent(value), value.replace(/ /g, '+'), value]
          .find((t) => embeddedTokenRegex(t).test(outcome.reqBody!));
        return token ? [{ token, name, value }] : [];
      });
      bodyTemplate = formEmbeds.length ? embedTemplatise(outcome.reqBody, formEmbeds) : outcome.reqBody;
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
    // The headers the page itself sent, so the replay is the request the
    // recording saw (and the probe classified), not a bare one.
    headers: requestHeaders(outcome.reqHeaders, outcome.reqBody, formBody),
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
      headers: requestHeaders(chain.call.reqHeaders, chain.call.reqBody),
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
  let finalBody: unknown;
  try { finalBody = JSON.parse(final.resBody ?? ''); } catch { finalBody = undefined; }
  const columns = finalBody === undefined ? undefined : locateColumns(finalBody, extract.records, analysis.marks);
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
