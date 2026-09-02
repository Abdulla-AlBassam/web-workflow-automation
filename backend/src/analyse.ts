// Deterministic correlation: turn a recorded trace into a structured account of
// which operator input drove which request, and which request carried the
// outcome. No LLM here — the LLM only narrates what this finds.

export type Trace = { meta: { session: string; status: string }; events: Record<string, unknown>[] };

export type Input = { field: string; value: string; selector?: string };

// token is the exact substring that matched (URL and embedded matches may be
// encoded), so spec generation can splice a placeholder in its place.
// 'body-embedded' means the value sat inside a larger string field — a query
// string bundled into one JSON value, as Algolia-style APIs send.
export type Match = { path: string; value: string; input: Input; where: 'body' | 'url' | 'body-embedded'; token: string };

export type Call = {
  url: string;
  method: string;
  status: number;
  seq: number;
  reqBody?: string;
  resBody?: string;
  matches: Match[];      // input values found inside this request
  resultShape?: string;  // short description of the response payload when structured
  resTruncated?: number; // full response length when the recorder cut the body
  outcomeScore: number;
};

// A chained workflow: a value from the search response (a slug, an id) appears
// in a later request's URL, and that later response is where the operator's
// marked data lives. The later call is the true outcome; the search feeds it.
export type Chain = {
  call: Call;            // the final outcome call
  linkPath: string;      // where the link value lives in the search response (row-relative when rowsPath set)
  rowsPath?: string;     // the search response's record set, when the link came from a row
  linkToken: string;     // the exact URL substring that matched
  encoded: boolean;      // whether the URL carried it percent-encoded
};

// A chained workflow whose outcome is rendered server-side into a page rather
// than returned by an API: the search response links to the page the operator
// navigated to, and the marked elements (with their selectors) live on it.
export type PageChain = {
  url: string;           // the visited page, before templating
  linkPath: string;
  rowsPath?: string;
  linkToken: string;
  encoded: boolean;
  extracts: { name: string; selector: string; text: string }[];
};

export type Analysis = {
  session: string;
  status: string;
  language: string;
  inputs: Input[];
  marks: string[];       // text the operator highlighted as wanted data
  calls: Call[];
  outcome?: Call;
  chain?: Chain;
  pageChain?: PageChain;
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

// Bounded occurrence of a token inside a composite string: the neighbouring
// characters must not be alphanumeric, so partial words ("art" in "smart")
// and digit runs never correlate.
export function embeddedTokenRegex(token: string): RegExp {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9])${esc}(?![A-Za-z0-9])`, 'g');
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
    const forms = [input.value, encodeURIComponent(input.value), input.value.replace(/ /g, '+')];
    // Chromium's URL serialiser also percent-encodes apostrophes in query
    // strings (the "special-query" set), which encodeURIComponent does not.
    for (const f of [...forms]) if (f.includes("'")) forms.push(f.replace(/'/g, '%27'));
    for (const token of new Set(forms)) {
      if (url.includes(token)) {
        matches.push({ path: 'url', value: input.value, input, where: 'url', token });
        break;
      }
    }
  }
  // Fallback: the value bundled inside a composite string field. Exact
  // evidence wins — this runs only for inputs the call carried nowhere else.
  if (parsed !== undefined) {
    for (const input of inputs) {
      if (!input.value || matches.some((m) => m.input.value === input.value)) continue;
      for (const token of new Set([input.value, encodeURIComponent(input.value), input.value.replace(/ /g, '+')])) {
        let found = false;
        for (const { path, value } of leaves(parsed)) {
          if (typeof value !== 'string' || !embeddedTokenRegex(token).test(value)) continue;
          matches.push({ path, value: input.value, input, where: 'body-embedded', token });
          found = true;
        }
        if (found) break;
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
  // A recording of an empty search still names its record set when a
  // result-shaped field is present, so a replay with a richer input extracts.
  if (!best) {
    const resulty = /^(records|rows|hits|items|results|list|data|entries)$/i;
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(v) && resulty.test(k)) return { shape: `0 records at ${k}`, records: 0 };
      if (v && typeof v === 'object') {
        for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
          if (Array.isArray(v2) && resulty.test(k2)) return { shape: `0 records at ${k}.${k2}`, records: 0 };
        }
      }
    }
  }
  return best ? { shape: `${best} records at ${where}`, records: best } : { records: 0 };
}

export function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

// Marked text is compared to response fields on letters and digits only:
// page text carries reference markers ([4], [a]), pronunciation glyphs and
// typographic punctuation that API fields do not, and any one of them would
// defeat a whole-paragraph match. Underscores stay, so a URL slug or a
// canonical key ("German_language") never passes for the text itself.
export function markKey(mark: string): string {
  return norm(mark.replace(/\[[^\]]{1,20}\]/g, ' ').replace(/[^\p{L}\p{N}\s_]/gu, ' '));
}

// Does a field carry a marked selection? Exactly, or as a substring, or, for
// a long selection, by sharing an 80-character stretch with it: a summary
// endpoint that drops a parenthetical clause still carries the paragraph.
export function markMatches(value: unknown, mark: string): boolean {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  const v = markKey(String(value));
  const m = markKey(mark);
  if (!v || !m) return false;
  if (v === m || (m.length >= 8 && v.includes(m))) return true;
  for (let i = 0; i + 80 <= m.length; i += 40) if (v.includes(m.slice(i, i + 80))) return true;
  return false;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A selection dragged across several cells of one record carries several
// field values at once ("185693 KEOPS W.L.L With Limited Liability
// Company"). Split it: every field whose value sits in the marked text as a
// whole token (3+ letters or digits) is one column, in the order the operator
// saw them, provided at least two are found and together they cover half the
// selection. A header row marked by mistake covers nothing and is ignored.
export function compositeMatches(mark: string, fields: { path: string; value: unknown }[]): { path: string; at: number }[] {
  const m = markKey(mark);
  if (m.length < 8) return [];
  const hits: { path: string; at: number; len: number }[] = [];
  for (const { path, value } of fields) {
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const v = markKey(String(value));
    if (v.length < 3) continue;
    const found = new RegExp(`(^|\\s)${escapeRe(v)}(?=\\s|$)`).exec(m);
    if (!found) continue;
    hits.push({ path, at: found.index + found[1].length, len: v.length });
  }
  // Longest first; a value nested inside another's span (or the same value
  // held by two fields) is not a second column.
  hits.sort((a, b) => b.len - a.len || a.at - b.at);
  const kept: typeof hits = [];
  for (const h of hits) {
    if (kept.some((k) => h.at < k.at + k.len && k.at < h.at + h.len)) continue;
    kept.push(h);
  }
  if (kept.length < 2) return [];
  const covered = kept.reduce((n, h) => n + h.len, 0);
  if (covered < m.length * 0.5) return [];
  return kept.sort((a, b) => a.at - b.at).map(({ path, at }) => ({ path, at }));
}

// Does a record (or a whole response) carry a marked selection, as one field
// or split across several?
export function objectHasMark(obj: unknown, mark: string): boolean {
  const fields = [...leaves(obj)];
  if (fields.some(({ value }) => markMatches(value, mark))) return true;
  return compositeMatches(mark, fields).length > 0;
}

export function responseHasMark(resBody: string | undefined, mark: string): boolean {
  const parsed = parseBody(resBody);
  if (parsed === undefined || parsed === null || typeof parsed !== 'object') return false;
  return objectHasMark(parsed, mark);
}

// The same trick as input correlation, one level deeper: a value from call A's
// response appearing in a later URL (an API call's or a visited page's) is the
// click that connected them.
function findLink(a: Call, targetUrl: string): Omit<Chain, 'call'> | undefined {
  const parsed = parseBody(a.resBody);
  if (parsed === undefined || parsed === null || typeof parsed !== 'object') return undefined;
  let u: URL;
  try { u = new URL(targetUrl); } catch { return undefined; }

  // Candidate tokens come from the URL itself, and a response value must equal
  // one exactly. Substring matching invites false links ("superstar" hiding
  // inside "/superstars/cmpunk"); whole segments cannot. Most specific first:
  // single path segments right to left, then path suffixes, then query values.
  const segs = u.pathname.split('/').filter(Boolean);
  const candidates: string[] = [];
  for (let i = segs.length - 1; i >= 0; i--) candidates.push(segs[i]);
  for (let i = segs.length - 2; i >= 0; i--) {
    candidates.push(segs.slice(i).join('/'), '/' + segs.slice(i).join('/'));
  }
  for (const v of u.searchParams.values()) if (v) candidates.push(v);

  // A link inside any list becomes row-relative at the innermost index, so
  // the runner picks the matching row per input instead of replaying the
  // recorded position.
  const relativise = (path: string) => {
    let linkPath = path;
    let rowsPath: string | undefined;
    const parts = path.split('.');
    for (let i = parts.length - 2; i > 0; i--) {
      if (/^\d+$/.test(parts[i])) {
        rowsPath = parts.slice(0, i).join('.');
        linkPath = parts.slice(i + 1).join('.');
        break;
      }
    }
    return { linkPath, rowsPath };
  };

  for (const token of candidates) {
    if (token.length < 4) continue;
    if (a.url.includes(token)) continue; // shared constants (hosts, base paths) are not links
    const decoded = decodeURIComponent(token);
    for (const { path, value } of leaves(parsed)) {
      if (typeof value !== 'string' && typeof value !== 'number') continue;
      const s = String(value);
      if (s !== token && s !== decoded) continue;
      return { ...relativise(path), linkToken: token, encoded: s === decoded && decoded !== token };
    }
  }

  // Whole-link leaves: many APIs return the destination URL itself, often
  // messy (double slashes, absolute vs path-only) — compare normalised host
  // and path. The whole recorded value then substitutes into the URL.
  const normPath = (p: string) => p.replace(/\/{2,}/g, '/');
  const targetKey = u.host + normPath(u.pathname);
  for (const { path, value } of leaves(parsed)) {
    if (typeof value !== 'string') continue;
    const s = value.trim();
    let key: string;
    let token: string;
    if (/^https?:\/\//i.test(s)) {
      try { const lu = new URL(s); key = lu.host + normPath(lu.pathname); } catch { continue; }
      token = targetUrl; // splicing the whole URL leaves a bare {{link}}
    } else if (s.startsWith('/')) {
      key = u.host + normPath(s);
      token = u.pathname; // keeps the origin as the template's prefix
    } else {
      continue;
    }
    if (key !== targetKey) continue;
    return { ...relativise(path), linkToken: token, encoded: false };
  }
  return undefined;
}

function isStructured(resBody: string | undefined): boolean {
  const parsed = parseBody(resBody);
  return parsed !== undefined && parsed !== null && typeof parsed === 'object';
}

export function analyse(trace: Trace): Analysis {
  const notes: string[] = [];
  const events = trace.events;

  const language = (events.find((e) => e.kind === 'page')?.lang as string)?.slice(0, 2).toUpperCase() || 'EN';

  const inputs: Input[] = events
    .filter((e) => e.kind === 'action' && e.action === 'input' && typeof e.value === 'string' && e.value && e.value !== '[REDACTED]')
    .map((e) => ({ field: (e.target as any)?.id ?? (e.target as any)?.name ?? 'field', value: e.value as string, selector: (e.target as any)?.selector }));

  const marks = [...new Set(events
    .filter((e) => e.kind === 'action' && e.action === 'mark' && typeof e.text === 'string' && (e.text as string).trim())
    .map((e) => e.text as string))];

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
        seq: (e.seq as number) ?? 0,
        reqBody: e.reqBody as string, resBody: e.resBody as string,
        ...(typeof e.resTruncated === 'number' ? { resTruncated: e.resTruncated } : {}),
        matches, resultShape: shape, outcomeScore,
      };
    });

  // Only a structured response qualifies as an outcome: a navigation that
  // merely carries the value in its URL (a server-rendered results page) is
  // not a call the runner could re-issue for data.
  const ranked = calls.filter((c) => isStructured(c.resBody)).sort((a, b) => b.outcomeScore - a.outcomeScore);
  const outcome = ranked[0]?.matches.length ? ranked[0] : undefined;
  if (!outcome && calls.some((c) => c.matches.length)) {
    // A cut body parses as nothing: say so, rather than blaming the site.
    const cut = calls.find((c) => c.matches.length && c.resTruncated);
    notes.push(cut
      ? `the response carrying the typed value was cut by the recorder at ${cut.resBody?.length ?? 0} of ${cut.resTruncated} characters, so it could not be read as structured data — the LLM repair can fetch it in full`
      : 'the request(s) carrying the typed value returned no structured data (a server-rendered results page?) — there is no direct call to promote');
  }

  // Chain detection needs positive evidence, never a guess: a marked value
  // found in the later response, or a recorded click leading to it.
  let chain: Chain | undefined;
  if (outcome) {
    const clickSeqs = events
      .filter((e) => e.kind === 'action' && e.action === 'click' && typeof e.seq === 'number')
      .map((e) => e.seq as number);
    let bestScore = 0;
    for (const b of calls) {
      if (b === outcome || b.seq <= outcome.seq) continue;
      if (b.status < 200 || b.status >= 300 || !isStructured(b.resBody)) continue;
      const link = findLink(outcome, b.url);
      if (!link) continue;
      const markHit = marks.some((m) => responseHasMark(b.resBody, m));
      const clickBetween = clickSeqs.some((s) => s > outcome.seq && s < b.seq);
      if (!markHit && !clickBetween) continue;
      const score = (markHit ? 100 : 0) + (clickBetween ? 10 : 0);
      if (score > bestScore) {
        bestScore = score;
        chain = { call: b, ...link };
      }
    }
  }

  // Marked data that no API response carries must be rendered server-side.
  // When the operator navigated to a page the search response links to and
  // marked text there, that page is the demonstrated outcome: extract the
  // marked elements from it, and drop any click-only API chain in its favour.
  let pageChain: PageChain | undefined;
  const markEvts = events.filter((e) =>
    e.kind === 'action' && e.action === 'mark' && typeof e.text === 'string' && (e.text as string).trim());
  if (outcome && markEvts.length) {
    const unmatched = marks.some((m) => !calls.some((c) => responseHasMark(c.resBody, m)));
    if (unmatched) {
      const navs = events.filter((e) =>
        e.kind === 'nav' && typeof e.url === 'string' && typeof e.seq === 'number' && (e.seq as number) > outcome.seq);
      for (const nav of navs) {
        const link = findLink(outcome, nav.url as string);
        if (!link) continue;
        const after = markEvts.filter((m) => (m.seq as number) > (nav.seq as number) && (m.target as any)?.selector);
        if (!after.length) continue;
        const used = new Set<string>();
        const extracts = after.map((m) => {
          const t = (m.target ?? {}) as Record<string, unknown>;
          const base = String(t.id ?? t.tag ?? 'text').replace(/[^\w]/g, '_') || 'text';
          let name = base;
          for (let i = 2; used.has(name); i++) name = `${base}_${i}`;
          used.add(name);
          return { name, selector: String(t.selector), text: m.text as string };
        });
        // Later qualifying navs win: the page closest to the marks is the one
        // the operator actually read.
        pageChain = { url: nav.url as string, ...link, extracts };
      }
      if (pageChain) chain = undefined;
    }
  }

  if (!inputs.length) notes.push('No operator input values captured — nothing to parameterise.');
  if (!calls.length) notes.push('No network calls with bodies captured — outcome may be pure DOM, browser steps required.');
  if (calls.length && !outcome && !calls.some((c) => c.matches.length)) notes.push('No request carried an input value; cannot identify a parameterised outcome call from requests alone.');

  let authHint: string | undefined;
  if (outcome && (outcome.status === 401 || outcome.status === 403)) {
    authHint = `outcome call returned ${outcome.status}; a token/auth step is required before it`;
    notes.push(authHint);
  }

  return { session: trace.meta.session, status: trace.meta.status, language, inputs, marks, calls, outcome, chain, pageChain, authHint, notes };
}
