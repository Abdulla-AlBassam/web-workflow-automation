// LLM repair loop: when a recording refuses to generate an automation, an
// operator-triggered assistant reviews the sanitised trace, proposes one
// direct call, and the proposal is executed against the recording's own
// evidence before anything is saved. The LLM proposes; deterministic code
// validates and assembles the spec. Nothing unverified ever becomes a spec.
import Anthropic from '@anthropic-ai/sdk';
import { analyse, norm, type Analysis } from './analyse.js';
import { SPEC_VERSION, type Spec } from './generate.js';
import { hostAllowed } from './redact.js';
import { getMeta, getSpec, readEvents, saveMeta, saveSpec, status, type Meta } from './store.js';
import { UA } from '../../runner/src/browser-token.js';

export type Emit = (kind: string, text: string) => void;

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
  };
};

const SYSTEM = `You are the repair assistant inside a local web-workflow automation tool. An operator recorded themselves demonstrating a workflow in a browser, but the deterministic analyser could not generate an automation from the recording. Diagnose why, and when possible propose ONE direct HTTP call that reaches the same outcome, parameterised on the operator's typed input.

The runner can execute: a single HTTP GET or POST to a URL that may contain {{param}} placeholders (URL-encoded at run time), with an optional JSON object body whose string values may contain {{param}}. No custom headers, no cookies, no authentication. Your proposal is validated by actually executing it with the recorded input values; it is accepted only if the response is structured JSON carrying the evidence the operator saw.

Rules:
- The URL host MUST belong to the recording's allowlisted hosts.
- Prefer endpoints visible in the recording. Metadata-only requests (whose bodies were not captured) are prime candidates: a JSONP request (resourceType "script", callback= parameter) usually becomes plain JSON when the callback parameter is dropped.
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
    "params": [{ "name": "query", "recordedValue": "the value the operator typed" }]
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
  for (const m of a.marks) if (norm(m)) out.add(norm(m).slice(0, 60));
  for (const e of events) {
    if (e.kind !== 'action' || e.action !== 'click') continue;
    const text = (e.target as { text?: string } | undefined)?.text;
    const n = norm(String(text ?? '').split('\n')[0]);
    if (n.length >= 4) out.add(n.slice(0, 60));
  }
  return [...out];
}

// Locate the result set in a live response: the longest array of objects (or
// strings) anywhere in the body, its dotted path recorded for extraction.
function findRows(body: unknown): { path: string; rows: unknown[] } | undefined {
  let best: { path: string; rows: unknown[] } | undefined;
  const walk = (n: unknown, path: string) => {
    if (Array.isArray(n)) {
      if (n.length && n.every((x) => x !== null && (typeof x === 'object' || typeof x === 'string'))
        && (!best || n.length > best.rows.length)) best = { path, rows: n };
      return;
    }
    if (n && typeof n === 'object') {
      for (const [k, v] of Object.entries(n)) walk(v, path ? `${path}.${k}` : k);
    }
  };
  walk(body, '');
  return best;
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

type TryResult =
  | { ok: true; rowsPath?: string; rowCount: number; evidenceHit?: string }
  | { ok: false; reason: string; snippet?: string };

// Execute a proposal with the recorded values. Guard rails: allowlisted hosts
// only, GET/POST only, no custom headers, one request, no pagination.
async function tryProposal(call: NonNullable<Proposal['call']>, hosts: string[], evidence: string[], signal: AbortSignal): Promise<TryResult> {
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
  const evidenceHit = evidence.find((ev) => norm(text).includes(ev));
  if (evidence.length && !evidenceHit) {
    return {
      ok: false,
      reason: 'response is structured but carries none of the evidence the operator saw while recording',
      snippet: text.slice(0, 300),
    };
  }
  const rows = findRows(parsed);
  return { ok: true, rowsPath: rows?.path || undefined, rowCount: rows?.rows.length ?? 1, evidenceHit };
}

function assembleSpec(call: NonNullable<Proposal['call']>, meta: Meta, a: Analysis, p: Proposal, rowsPath: string | undefined): Spec {
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
      extract: rowsPath ? { records: rowsPath } : {},
    },
    repaired: { at: new Date().toISOString(), model: MODEL, diagnosis: p.diagnosis },
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

export async function repairSession(id: string, emit: Emit, signal: AbortSignal): Promise<void> {
  const meta = getMeta(id);
  if (!meta) { emit('error', 'unknown session'); return; }
  if (status(meta) !== 'complete') { emit('error', `session is ${status(meta)} — only complete recordings can be repaired`); return; }
  if (getSpec(id)) { emit('error', 'this session already has an automation'); return; }

  emit('info', 'Reading the recording…');
  const events = readEvents(id);
  const a = analyse({ meta: { session: id, status: 'complete' }, events });
  emit('info', `Deterministic analysis refused: ${a.notes.join(' ') || 'no parameterised outcome call identified.'}`);

  const evidence = evidenceStrings(events, a);
  const pack = [
    `Session "${id}". Allowlisted hosts: ${meta.hosts.join(', ')}.`,
    `Analyser notes: ${a.notes.join(' ') || 'none'}`,
    `Typed inputs: ${a.inputs.map((i) => `${i.field}="${i.value}"`).join(', ') || 'NONE'}`,
    `Marked text: ${a.marks.map((m) => `"${m.slice(0, 80)}"`).join(', ') || 'none'}`,
    `Evidence a correct outcome response should carry (normalised): ${evidence.map((e) => `"${e}"`).join(', ') || 'none available'}`,
    '',
    'Recording digest (ordered):',
    digest(events),
  ].join('\n');

  let client: Anthropic;
  try {
    client = new Anthropic();
  } catch (e) {
    emit('error', `no API credentials: ${(e as Error).message}. Put ANTHROPIC_API_KEY=… in the project's .env and restart the backend.`);
    return;
  }

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
      emit('done', 'No automation is possible from this recording. Re-record following the advice above.');
      return;
    }

    const call = p.call!;
    emit('try', `${call.method} ${call.url} — executing with the recorded value(s)…`);
    const result = await tryProposal(call, meta.hosts, evidence, signal);
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

    emit('ok', `verified: structured response, ${result.rowCount} row(s)${result.rowsPath ? ` at ${result.rowsPath}` : ''}` +
      (result.evidenceHit ? `, carrying the recorded evidence ("${result.evidenceHit}")` : ''));
    const spec = assembleSpec(call, meta, a, p, result.rowsPath);
    saveSpec(id, spec);
    if (!meta.name && p.title) {
      meta.name = p.title.slice(0, 80);
      saveMeta(meta);
    }
    emit('saved', `Automation saved${p.title ? ` as "${p.title}"` : ''}. Run it with any new input — no re-recording needed.`);
    return;
  }
  emit('done', `No working automation found after ${MAX_ROUNDS} rounds. The recording may need to be redone.`);
}
