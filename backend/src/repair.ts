// LLM repair loop: when a recording refuses to generate an automation, or a
// saved automation returns something other than what the operator marked, an
// operator-triggered assistant reviews the sanitised trace, proposes one
// direct call, and the proposal is executed against the recording's own
// evidence before anything is saved. The LLM proposes; deterministic code
// validates and assembles the spec. Nothing unverified ever becomes a spec.
import Anthropic from '@anthropic-ai/sdk';
import { analyse, leaves, markKey, markMatches, norm, type Analysis } from './analyse.js';
import { SPEC_VERSION, locateColumns, missingMarks, type Column, type Spec } from './generate.js';
import { hostAllowed } from './redact.js';
import { getMeta, getSpec, readEvents, saveMeta, saveSpec, status, type Meta } from './store.js';
import { UA } from '../../runner/src/browser-token.js';

export type Emit = (kind: string, text: string) => void;

// Refining a saved automation: what the last run returned, as the session
// page saw it, and the operator's note on what was wrong with it.
export type RepairInput = { feedback?: string; lastRun?: unknown };

const MODEL = process.env.REPAIR_MODEL ?? 'claude-opus-5';
const MAX_ROUNDS = 4;
const BODY_SNIPPET = 400;

type Proposal = {
  diagnosis: string;
  action: 'propose' | 'stop';
  advice?: string;
  title?: string;
  call?: {
    method: string;
    url: string;
    body?: unknown;
    params: { name: string; recordedValue: string }[];
    rowsPath?: string | null;
  };
};

const SYSTEM = `You are the repair assistant inside a local web-workflow automation tool. An operator recorded themselves demonstrating a workflow in a browser. Either the deterministic analyser could not generate an automation from the recording, or it did and the automation's result was not what the operator wanted. Diagnose why, and when possible propose ONE direct HTTP call that reaches the same outcome, parameterised on the operator's typed input.

The runner can execute: a single HTTP GET or POST to a URL that may contain {{param}} placeholders (URL-encoded at run time), with an optional JSON object body whose string values may contain {{param}}. No custom headers, no cookies, no authentication. Your proposal is validated by actually executing it with the recorded input values; it is accepted only if the response is structured JSON carrying the evidence the operator saw.

Rules:
- The URL host MUST belong to the recording's allowlisted hosts.
- Prefer endpoints visible in the recording. Metadata-only requests (whose bodies were not captured) are prime candidates: a JSONP request (resourceType "script", callback= parameter) usually becomes plain JSON when the callback parameter is dropped.
- When the operator marked text while recording, that text is what every run must return. The proposal is accepted only if the response carries each marked selection in a plain field (columns are located by matching the marked text against field values), so ask for plain text rather than HTML where the API offers the choice, and request the fields the marks need.
- In REFINE mode the session already has an automation, but its result did not match the marked selections or the operator's note. Diagnose the mismatch and propose the corrected call; the same endpoint with different parameters is fine.
- Name where the result records live in the response (rowsPath) when you know the API: it is checked against the actual response and used only if the evidence agrees. A response that is one record, not a list, has rowsPath null.
- If no direct call can work from this evidence (nothing was typed, or the outcome exists only in server-rendered HTML with no API), use action "stop" with concrete advice on how to re-record so the deterministic pipeline succeeds.

Reply with ONLY a JSON object, no prose, no code fences:
{
  "diagnosis": "one or two plain sentences on why the recording failed",
  "action": "propose" | "stop",
  "advice": "only when stopping: how to re-record",
  "title": "short human name for the automation, e.g. 'Wikipedia Article Search'",
  "call": {
    "method": "GET" | "POST",
    "url": "https://host/path?q={{query}}",
    "body": null,
    "params": [{ "name": "query", "recordedValue": "the value the operator typed" }],
    "rowsPath": "query.results" | null
  }
}`;

// The LLM sees a digest, never the raw trace: every event kind, but bodies
// truncated hard and asset noise dropped. The trace is already sanitised at
// capture; this pass only shrinks it.
function digest(events: Record<string, unknown>[]): string {
  const lines: string[] = [];
  for (const e of events) {
    if (lines.length >= 150) { lines.push('… (digest capped at 150 events)'); break; }
    const kind = String(e.kind);
    if (kind === 'net_meta') {
      const rt = String(e.resourceType ?? '');
      if (/image|stylesheet|font|media/.test(rt)) continue;
      lines.push(`net_meta ${e.method} ${e.url} → ${e.status} (${rt}; body NOT captured)`);
    } else if (kind === 'net') {
      const body = String(e.resBody ?? '').slice(0, BODY_SNIPPET);
      lines.push(`net ${e.method} ${e.url} → ${e.status} ${e.contentType ?? ''} body: ${body}`);
    } else if (kind === 'action') {
      const t = e.target as { selector?: string; text?: string } | undefined;
      const text = t?.text ? ` text="${String(t.text).slice(0, 80)}"` : '';
      const value = e.value !== undefined ? ` value="${e.value}"` : '';
      const mark = e.text !== undefined ? ` marked="${String(e.text).slice(0, 80)}"` : '';
      lines.push(`action ${e.action} ${t?.selector ?? ''}${value}${mark}${text}`);
    } else if (kind === 'nav' || kind === 'page') {
      lines.push(`${kind} ${e.url}`);
    } else {
      lines.push(kind);
    }
  }
  return lines.join('\n');
}

// Strings the operator demonstrably saw: typed values, marked text, the text
// of things clicked after typing. A valid outcome response must carry one.
function evidenceStrings(events: Record<string, unknown>[], a: Analysis): string[] {
  const out = new Set<string>();
  for (const m of a.marks) if (markKey(m)) out.add(markKey(m).slice(0, 60));
  for (const e of events) {
    if (e.kind !== 'action' || e.action !== 'click') continue;
    const text = (e.target as { text?: string } | undefined)?.text;
    const n = markKey(String(text ?? '').split('\n')[0]);
    if (n.length >= 4) out.add(n.slice(0, 60));
  }
  return [...out];
}

const shortMark = (m: string) => `"${markKey(m).slice(0, 60)}"`;

function describeSpec(spec: Spec): string {
  const steps = spec.steps.map((s) => s.type === 'request'
    ? `${s.method} ${s.url}${s.bodyTemplate !== undefined ? ` body ${JSON.stringify(s.bodyTemplate).slice(0, 300)}` : ''}`
    : `${s.type} step`).join(' → ');
  const cols = spec.outcome.columns?.map((c) => c.name).join(', ');
  return `${steps}; rows at ${spec.outcome.extract.records ?? 'the whole response'}; ${cols ? `columns ${cols}` : 'no marked columns'}`;
}

// The page reports the last run in its own words; only its shape is trusted.
function describeRun(r: unknown): string {
  const run = (r ?? {}) as { ok?: boolean; stoppedReason?: string; columns?: unknown; rowCount?: unknown; firstRow?: unknown };
  if (run.ok === false) return `stopped — ${String(run.stoppedReason ?? 'no reason given').slice(0, 300)}`;
  const cols = !Array.isArray(run.columns) ? 'unknown columns'
    : run.columns.length ? run.columns.map(String).join(', ').slice(0, 300) : 'no columns';
  const first = run.firstRow === undefined ? '' : `; first row: ${JSON.stringify(run.firstRow).slice(0, 400)}`;
  return `${Number(run.rowCount) || 0} row(s) with columns ${cols}${first}`;
}

// Locate the result set in a live response: every array of objects (or
// strings) and every id-keyed map of records is a candidate. The one carrying
// the most marked selections and evidence wins, then the longest — never the
// first, or a bookkeeping array listed before the records would take it. The
// model may name the path; its hint breaks ties but never overrules evidence.
type Rows = { path: string; rows: unknown[]; note?: string };
function chooseRows(body: unknown, marks: string[], evidence: string[], hint: string | null | undefined): Rows | undefined {
  const candidates: { path: string; rows: unknown[] }[] = [];
  const isRecord = (x: unknown) => !!x && typeof x === 'object' && !Array.isArray(x)
    && Object.values(x).some((f) => f === null || typeof f !== 'object');
  const walk = (n: unknown, path: string) => {
    if (Array.isArray(n)) {
      if (n.length && n.every((x) => x !== null && (typeof x === 'object' || typeof x === 'string'))) candidates.push({ path, rows: n });
      return;
    }
    if (n && typeof n === 'object') {
      const values = Object.values(n);
      if (path && values.length && values.every(isRecord)) candidates.push({ path, rows: values });
      for (const [k, v] of Object.entries(n)) walk(v, path ? `${path}.${k}` : k);
    }
  };
  walk(body, '');
  const scored = candidates.map((c) => {
    const text = markKey(JSON.stringify(c.rows));
    let score = evidence.filter((ev) => text.includes(ev)).length;
    for (const m of marks) {
      if (c.rows.some((r) => [...leaves(r)].some(({ value }) => markMatches(value, m)))) score++;
    }
    return { ...c, score };
  });
  let best: (typeof scored)[number] | undefined;
  for (const c of scored) {
    if (!best || c.score > best.score || (c.score === best.score && c.rows.length > best.rows.length)) best = c;
  }
  // Evidence present but inside no candidate: the response is one record
  // (a summary, a detail) and a stray map of URLs must not pose as its rows.
  if (best && best.score === 0 && (marks.length || evidence.length)) best = undefined;
  if (!hint) return best && { path: best.path, rows: best.rows };
  const hinted = scored.find((c) => c.path === hint);
  if (hinted && hinted.score >= 1 && hinted.score === best?.score) return { path: hinted.path, rows: hinted.rows };
  const note = `the proposed rows path "${hint}" ${hinted ? 'carries less of the evidence than' : 'is not a list of records; using'} ${best ? `"${best.path}"` : 'the whole response as one record'}`;
  return best ? { path: best.path, rows: best.rows, note } : { path: '', rows: [], note };
}

function substituteUrl(url: string, values: Record<string, string>): string {
  return url.replace(/\{\{(\w+)\}\}/g, (_, n) => encodeURIComponent(values[n] ?? ''));
}

function substituteBody(node: unknown, values: Record<string, string>): unknown {
  if (Array.isArray(node)) return node.map((v) => substituteBody(v, values));
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, substituteBody(v, values)]));
  }
  if (typeof node === 'string') {
    const m = node.match(/^\{\{(\w+)\}\}$/);
    if (m) return values[m[1]] ?? node;
    return node.replace(/\{\{(\w+)\}\}/g, (_, n) => values[n] ?? `{{${n}}}`);
  }
  return node;
}

type Verified = { rowsPath?: string; rowsNote?: string; rowCount: number; evidenceHit?: string; columns?: Column[]; missing: string[] };
type TryResult = ({ ok: true } & Verified) | { ok: false; reason: string; snippet?: string };

// Execute a proposal with the recorded values. Guard rails: allowlisted hosts
// only, GET/POST only, no custom headers, one request, no pagination.
async function tryProposal(call: NonNullable<Proposal['call']>, hosts: string[], evidence: string[], marks: string[], signal: AbortSignal): Promise<TryResult> {
  if (call.method !== 'GET' && call.method !== 'POST') {
    return { ok: false, reason: `method ${call.method} is not allowed (GET or POST only)` };
  }
  if (!Array.isArray(call.params) || call.params.length === 0) {
    return { ok: false, reason: 'the proposal names no parameters — the automation must be parameterised on the typed input' };
  }
  const values = Object.fromEntries(call.params.map((p) => [p.name, p.recordedValue]));
  const url = substituteUrl(call.url, values);
  if (!hostAllowed(url, hosts)) {
    return { ok: false, reason: `URL host is outside the recording's allowlist (${hosts.join(', ')})` };
  }
  const body = call.body == null ? undefined : substituteBody(call.body, values);
  let res: Response;
  try {
    res = await fetch(url, {
      method: call.method,
      headers: {
        accept: 'application/json, */*',
        'user-agent': UA,
        ...(body !== undefined ? { 'content-type': 'application/json; charset=utf-8' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal,
    });
  } catch (e) {
    return { ok: false, reason: `request failed to reach ${url}: ${(e as Error).message}` };
  }
  const text = await res.text();
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, reason: `HTTP ${res.status}`, snippet: text.slice(0, 300) };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch {
    return { ok: false, reason: 'response is not JSON — the outcome must be structured data', snippet: text.slice(0, 300) };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { ok: false, reason: 'response parsed to a bare value, not structured data', snippet: text.slice(0, 300) };
  }
  const hay = markKey(text);
  const evidenceHit = evidence.find((ev) => hay.includes(ev));
  if (evidence.length && !evidenceHit) {
    return {
      ok: false,
      reason: 'response is structured but carries none of the evidence the operator saw while recording',
      snippet: text.slice(0, 300),
    };
  }
  // What the operator marked is what a run must return: the marks are located
  // in this very response and become the spec's columns.
  const missing = missingMarks(parsed, marks);
  if (marks.length && missing.length === marks.length) {
    return {
      ok: false,
      reason: `response is structured but carries none of the marked selections as a field (${marks.map(shortMark).join(', ')}) — the automation must return what the operator marked`,
      snippet: text.slice(0, 300),
    };
  }
  const rows = chooseRows(parsed, marks, evidence, call.rowsPath);
  const columns = locateColumns(parsed, rows?.path || undefined, marks);
  return { ok: true, rowsPath: rows?.path || undefined, rowsNote: rows?.note, rowCount: rows?.path ? rows.rows.length : 1, evidenceHit, columns, missing };
}

function assembleSpec(call: NonNullable<Proposal['call']>, meta: Meta, a: Analysis, p: Proposal, v: Verified, mode: 'repair' | 'refine', feedback: string): Spec {
  return {
    version: SPEC_VERSION,
    name: meta.session,
    origin: new URL(substituteUrl(call.url, {})).origin,
    language: a.language,
    parameters: call.params.map((x) => ({ name: x.name, example: x.recordedValue, required: true })),
    steps: [{
      id: 'search',
      type: 'request',
      method: call.method,
      url: call.url,
      headers: {
        accept: 'application/json, */*',
        'user-agent': UA,
        ...(call.body != null ? { 'content-type': 'application/json; charset=utf-8' } : {}),
      },
      ...(call.body != null ? { bodyTemplate: call.body } : {}),
    }],
    outcome: {
      fromStep: 'search',
      expect: { path: '__http_ok', equals: 'true' },
      extract: v.rowsPath ? { records: v.rowsPath } : {},
      ...(v.columns ? { columns: v.columns } : {}),
    },
    repaired: { at: new Date().toISOString(), model: MODEL, diagnosis: p.diagnosis, mode, ...(feedback ? { feedback } : {}) },
  };
}

function parseProposal(text: string): Proposal | { parseError: string } {
  const raw = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    const p = JSON.parse(raw) as Proposal;
    if (!p.diagnosis || (p.action !== 'propose' && p.action !== 'stop')) {
      return { parseError: 'JSON parsed but is missing "diagnosis" or a valid "action"' };
    }
    if (p.action === 'propose' && !p.call?.url) {
      return { parseError: 'action is "propose" but "call.url" is missing' };
    }
    return p;
  } catch (e) {
    return { parseError: `reply was not valid JSON: ${(e as Error).message}` };
  }
}

export async function repairSession(id: string, emit: Emit, signal: AbortSignal, input: RepairInput = {}): Promise<void> {
  const meta = getMeta(id);
  if (!meta) { emit('error', 'unknown session'); return; }
  if (status(meta) !== 'complete') { emit('error', `session is ${status(meta)} — only complete recordings can be repaired`); return; }
  const existing = getSpec(id) as Spec | undefined;
  const mode = existing ? 'refine' : 'repair';
  const feedback = (input.feedback ?? '').trim();

  emit('info', 'Reading the recording…');
  const events = readEvents(id);
  const a = analyse({ meta: { session: id, status: 'complete' }, events });
  const marks = a.marks;
  const evidence = evidenceStrings(events, a);

  if (existing) {
    emit('info', `Refining the saved automation: ${describeSpec(existing)}.`);
    if (input.lastRun !== undefined) emit('info', `Last run returned: ${describeRun(input.lastRun)}`);
    emit('info', feedback ? `Your note: ${feedback}` : 'No note given — comparing your marked selections with what the run returned.');
  } else {
    emit('info', `Deterministic analysis refused: ${a.notes.join(' ') || 'no parameterised outcome call identified.'}`);
  }
  if (marks.length) emit('info', `Marked while recording (${marks.length}): ${marks.map(shortMark).join(', ')}`);

  const pack = [
    ...(existing ? [
      'Mode: REFINE. The session already has an automation, but its result did not match what the operator wanted.',
      `Current automation: ${describeSpec(existing)}`,
      `Last run (what the operator received): ${input.lastRun === undefined ? 'not reported' : describeRun(input.lastRun)}`,
      `Operator feedback: ${feedback ? `"${feedback}"` : 'none — compare the marked selections with the last run yourself'}`,
      '',
    ] : []),
    `Session "${id}". Allowlisted hosts: ${meta.hosts.join(', ')}.`,
    `Analyser notes: ${a.notes.join(' ') || 'none'}`,
    `Typed inputs: ${a.inputs.map((i) => `${i.field}="${i.value}"`).join(', ') || 'NONE'}`,
    `Marked text (what every run must return, as plain fields): ${marks.map((m) => `"${markKey(m).slice(0, 200)}"`).join(', ') || 'none'}`,
    `Evidence a correct outcome response should carry (normalised): ${evidence.map((e) => `"${e}"`).join(', ') || 'none available'}`,
    '',
    'Recording digest (ordered):',
    digest(events),
  ].join('\n');

  let client: Anthropic;
  try {
    // Identity-linked API keys refuse requests without the workspace id they
    // are scoped to; ANTHROPIC_WORKSPACE_ID in .env supplies it.
    const workspace = process.env.ANTHROPIC_WORKSPACE_ID;
    client = new Anthropic(workspace ? { defaultHeaders: { 'anthropic-workspace-id': workspace } } : {});
  } catch (e) {
    emit('error', `no API credentials: ${(e as Error).message}. Put ANTHROPIC_API_KEY=… in the project's .env and restart the backend.`);
    return;
  }

  type Attempt = { call: NonNullable<Proposal['call']>; p: Proposal; v: Verified; note?: string };
  const save = (best: Attempt) => {
    saveSpec(id, assembleSpec(best.call, meta, a, best.p, best.v, mode, feedback));
    if (!meta.name && best.p.title) {
      meta.name = best.p.title.slice(0, 80);
      saveMeta(meta);
    }
    const title = !existing && best.p.title ? ` as "${best.p.title}"` : '';
    emit('saved', `Automation ${existing ? 'updated' : 'saved'}${title}${best.note ? ` — ${best.note}` : ''}. Run it with any new input — no re-recording needed.`);
  };
  // A response carrying some of the marks is worth keeping if nothing better
  // turns up: the loop asks for the rest first and falls back to it honestly.
  let partial: Attempt | undefined;

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: pack }];
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    if (signal.aborted) { emit('info', 'stopped by the operator'); return; }
    emit('llm', `Round ${round}: asking ${MODEL}…`);
    let reply: string;
    try {
      const res = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 4000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: SYSTEM,
        messages,
      });
      if (res.stop_reason === 'refusal') {
        emit('error', 'the model declined to work on this recording');
        return;
      }
      reply = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    } catch (e) {
      emit('error', `model call failed: ${(e as Error).message}`);
      return;
    }

    const p = parseProposal(reply);
    if ('parseError' in p) {
      emit('fail', `model reply unusable (${p.parseError}) — asking again`);
      messages.push({ role: 'assistant', content: reply });
      messages.push({ role: 'user', content: `Your reply could not be used: ${p.parseError}. Reply with ONLY the JSON object described in your instructions.` });
      continue;
    }

    emit('llm', p.diagnosis);
    if (p.action === 'stop') {
      emit('advice', p.advice ?? 'the model sees no automatable path in this recording');
      if (partial) { save({ ...partial, note: `kept the best verified attempt: ${partial.note}` }); return; }
      emit('done', existing
        ? 'No better automation was verified; the saved one is unchanged. Add a note describing the problem and try again, or re-record following the advice above.'
        : 'No automation is possible from this recording. Re-record following the advice above.');
      return;
    }

    const call = p.call!;
    emit('try', `${call.method} ${call.url} — executing with the recorded value(s)…`);
    const result = await tryProposal(call, meta.hosts, evidence, marks, signal);
    if (!result.ok) {
      emit('fail', result.reason + (result.snippet ? ` — response starts: ${result.snippet}` : ''));
      messages.push({ role: 'assistant', content: reply });
      messages.push({
        role: 'user',
        content: `The proposal was executed with the recorded values and failed: ${result.reason}.` +
          (result.snippet ? ` The response starts with: ${result.snippet}` : '') +
          ' Propose a different call, or stop with re-record advice.',
      });
      continue;
    }

    if (result.rowsNote) emit('info', result.rowsNote);
    emit('ok', `verified: structured response, ${result.rowCount} row(s)${result.rowsPath ? ` at ${result.rowsPath}` : ''}` +
      (result.evidenceHit ? `, carrying the recorded evidence ("${result.evidenceHit}")` : '') +
      (result.columns ? `; columns from your marked selections: ${result.columns.map((c) => c.name).join(', ')}` : ''));
    if (result.missing.length) {
      const note = `${marks.length - result.missing.length} of ${marks.length} marked selections located; missing: ${result.missing.map(shortMark).join(', ')}`;
      if (!partial || partial.v.missing.length > result.missing.length) partial = { call, p, v: result, note };
      if (round < MAX_ROUNDS) {
        emit('fail', `${note} — asking for a call whose response also carries the missing selection(s)`);
        messages.push({ role: 'assistant', content: reply });
        messages.push({
          role: 'user',
          content: `The proposal was executed with the recorded values. The response is structured and carries some of the operator's marked selections (rows read at ${result.rowsPath ?? 'the whole response'}), but not: ${result.missing.map(shortMark).join(', ')}. Propose a call whose response also returns the missing marked text as plain field values, or stop with advice if no API can return it.`,
        });
        continue;
      }
    }
    save({ call, p, v: result, note: result.missing.length ? `${marks.length - result.missing.length} of ${marks.length} marked selections located` : undefined });
    return;
  }
  if (partial) { save({ ...partial, note: `kept the best verified attempt: ${partial.note}` }); return; }
  emit('done', existing
    ? `No better automation was verified after ${MAX_ROUNDS} rounds; the saved one is unchanged.`
    : `No working automation found after ${MAX_ROUNDS} rounds. The recording may need to be redone.`);
}
