// Deterministic correlation: turn a recorded trace into a structured account of
// which operator input drove which request, and which request carried the
// outcome. No LLM here — the LLM only narrates what this finds.

export type Trace = { meta: { session: string; status: string }; events: Record<string, unknown>[] };

export type Input = { field: string; value: string; selector?: string };

// token is the exact substring that matched (URL matches may be encoded), so
// spec generation can splice a placeholder in its place.
export type Match = { path: string; value: string; input: Input; where: 'body' | 'url'; token: string };

export type Call = {
  url: string;
  method: string;
  status: number;
  reqBody?: string;
  resBody?: string;
  matches: Match[];      // input values found inside this request
  resultShape?: string;  // short description of the response payload when structured
  outcomeScore: number;
};

export type Analysis = {
  session: string;
  status: string;
  language: string;
  inputs: Input[];
  calls: Call[];
  outcome?: Call;
  authHint?: string;
  notes: string[];
};

function parseBody(body: string | undefined): unknown {
  if (!body) return undefined;
  try { return JSON.parse(body); } catch { /* not JSON */ }
  if (body.includes('=')) {
    const o: Record<string, string> = {};
    for (const pair of body.split('&')) {
      const [k, v] = pair.split('=');
      o[decodeURIComponent(k)] = decodeURIComponent(v ?? '');
    }
    return o;
  }
  return body;
}

// Every leaf path in an object, so correlation reports where a value landed.
export function* leaves(node: unknown, path = ''): Generator<{ path: string; value: unknown }> {
  if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      yield* leaves(v, path ? `${path}.${k}` : k);
    }
  } else {
    yield { path, value: node };
  }
}

function findMatches(reqBody: string | undefined, url: string, inputs: Input[]): Match[] {
  const matches: Match[] = [];
  const parsed = parseBody(reqBody);
  if (parsed !== undefined) {
    for (const { path, value } of leaves(parsed)) {
      if (typeof value !== 'string' || !value) continue;
      for (const input of inputs) {
        if (value === input.value) matches.push({ path, value, input, where: 'body', token: value });
      }
    }
  }
  // GET-style workflows carry the value in the URL instead, usually encoded.
  for (const input of inputs) {
    for (const token of new Set([input.value, encodeURIComponent(input.value), input.value.replace(/ /g, '+')])) {
      if (url.includes(token)) {
        matches.push({ path: 'url', value: input.value, input, where: 'url', token });
        break;
      }
    }
  }
  return matches;
}

// A response looks like an outcome when it is structured and carries a record
// set. Reported as a short human string, and scored for outcome ranking.
function describeResult(resBody: string | undefined): { shape?: string; records: number } {
  const parsed = parseBody(resBody);
  if (parsed === null || typeof parsed !== 'object') return { records: 0 };
  let best = 0;
  let where = '';
  for (const { path, value } of leaves(parsed)) {
    if (Array.isArray(value) && value.length > best) { best = value.length; where = path; }
  }
  // leaves() descends into arrays, so re-scan the top level for array fields.
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (Array.isArray(v) && v.length > best) { best = v.length; where = k; }
    if (v && typeof v === 'object') {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        if (Array.isArray(v2) && v2.length > best) { best = v2.length; where = `${k}.${k2}`; }
      }
    }
  }
  return best ? { shape: `${best} records at ${where}`, records: best } : { records: 0 };
}

export function analyse(trace: Trace): Analysis {
  const notes: string[] = [];
  const events = trace.events;

  const language = (events.find((e) => e.kind === 'page')?.lang as string)?.slice(0, 2).toUpperCase() || 'EN';

  const inputs: Input[] = events
    .filter((e) => e.kind === 'action' && e.action === 'input' && typeof e.value === 'string' && e.value && e.value !== '[REDACTED]')
    .map((e) => ({ field: (e.target as any)?.id ?? (e.target as any)?.name ?? 'field', value: e.value as string, selector: (e.target as any)?.selector }));

  const calls: Call[] = events
    .filter((e) => e.kind === 'net' && e.url)
    .map((e) => {
      const matches = findMatches(e.reqBody as string, e.url as string, inputs);
      const { shape, records } = describeResult(e.resBody as string);
      const ok = typeof e.status === 'number' && e.status >= 200 && e.status < 300;
      // Outcome ranking: a call that both carries an input value and returns a
      // record set is the outcome; ties break on record count.
      const outcomeScore = (matches.length ? 100 : 0) + (ok ? 10 : 0) + Math.min(records, 50);
      return {
        url: e.url as string, method: (e.method as string) ?? 'GET', status: (e.status as number) ?? 0,
        reqBody: e.reqBody as string, resBody: e.resBody as string,
        matches, resultShape: shape, outcomeScore,
      };
    });

  const ranked = [...calls].sort((a, b) => b.outcomeScore - a.outcomeScore);
  const outcome = ranked[0]?.matches.length ? ranked[0] : undefined;

  if (!inputs.length) notes.push('No operator input values captured — nothing to parameterise.');
  if (!calls.length) notes.push('No same-site network calls captured — outcome may be pure DOM, browser steps required.');
  if (calls.length && !outcome) notes.push('No request carried an input value; cannot identify a parameterised outcome call from requests alone.');

  let authHint: string | undefined;
  if (outcome && (outcome.status === 401 || outcome.status === 403)) {
    authHint = `outcome call returned ${outcome.status}; a token/auth step is required before it`;
    notes.push(authHint);
  }

  return { session: trace.meta.session, status: trace.meta.status, language, inputs, calls, outcome, authHint, notes };
}
