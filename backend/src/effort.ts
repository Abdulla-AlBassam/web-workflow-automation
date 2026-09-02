// Maximum Effort Mode. The operator hands the whole recording to the model —
// every page they saw (snapshots), every call the site made, every action,
// the route they took — and says in their own words what the automation
// should return. The model reasons about it in the open, talks to the
// operator as it works, asks when unsure, investigates with tools, and
// writes a script for the session. Deterministic code still decides: the
// script is linted, executed with the recorded inputs and saved only when
// its rows reproduce something the operator saw. The conversation goes on
// after a save, so the operator can ask for changes in the same breath.
import Anthropic from '@anthropic-ai/sdk';
import { analyse, markKey, objectHasMark } from './analyse.js';
import { SPEC_VERSION, type Spec } from './generate.js';
import type { Bearer } from '../../runner/src/browser-token.js';
import { SCRIPT_FILE, getMeta, getScript, getSpec, readEvents, saveMeta, saveScript, saveSpec, status } from './store.js';
import { lintScript, literalCarries, runScript, stringLiterals, type ScriptOk } from '../../runner/src/script.js';
import { INVESTIGATE_TOOLS, estimateSpend, evidenceStrings, navSummary, overview, paramNames, rowText, runTool, shortMark, type Emit, type Ev, type ToolCtx, type Usage } from './llm-tools.js';

export const MODEL = process.env.EFFORT_MODEL ?? 'claude-opus-5';
const EFFORT = (process.env.EFFORT_LEVEL ?? 'xhigh') as 'low' | 'medium' | 'high' | 'xhigh' | 'max';

// Rails. Generous — this mode exists to keep going — but every one is a hard
// stop, and the operator's Stop button beats them all.
const MAX_TURNS = 60;
const MAX_TOOL_CALLS = 120;
const MAX_SCRIPT_TRIES = 12;
const MAX_INPUT_TOKENS = 8_000_000; // cumulative, cache reads included
const IDLE_MS = 15 * 60_000;         // how long the model waits for a reply
const EVIDENCE_CHARS = 3_000_000;    // snapshot text the acceptance check searches

// Operator messages typed while the loop runs. Taken at the start of the
// next turn, or awaited when the model has handed the conversation over.
export class Inbox {
  private queue: string[] = [];
  private waiter: ((text: string | undefined) => void) | undefined;
  push(text: string) {
    if (this.waiter) { const w = this.waiter; this.waiter = undefined; w(text); return; }
    this.queue.push(text);
  }
  drain(): string[] { const out = this.queue; this.queue = []; return out; }
  take(signal: AbortSignal, ms: number): Promise<string | undefined> {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (signal.aborted) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const done = (v: string | undefined) => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); this.waiter = undefined; resolve(v); };
      const onAbort = () => done(undefined);
      const timer = setTimeout(() => done(undefined), ms);
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiter = done;
    });
  }
}

export type EffortInput = {
  goal: string;
  inbox: Inbox;
  readToken?: (loadUrl: string) => Promise<Bearer | undefined>;
};

const SYSTEM = `You are the worker inside a local web-workflow automation tool, running in Maximum Effort Mode. An operator recorded themselves doing something on a website: the recorder kept every page they looked at (snapshots of the visible text and the pruned DOM), every request the page made with its body, every click, every value they typed, every navigation, and anything they highlighted and marked as wanted data. Then they told you, in their own words, what they want an automation to return. Your job is to build that automation so it works for any future input, not just the recorded one — and to prove it on the recording before it is saved.

You are talking to the operator. Everything you write outside a tool call is shown to them as chat, and your reasoning is shown as you think. Write the way a sharp colleague talks: plain, direct, specific. Say what you are checking and what you found. When the goal is ambiguous, or the recording does not show what they described, ask — briefly, with the options you see. Ending your turn without a tool call hands the conversation to the operator; do that to ask a question or when you are done, never in the middle of work.

HOW TO WORK
1. Read the goal, the route and the snapshots first: the snapshots are what the operator actually saw, and the route shows how filters, sorts and pages appear in URLs. Then look at the network calls for the data behind the page.
2. Prefer the site's own API when one carries the data (read_body shows the response; probe re-issues it with your own parameters). Prefer a fetched page parsed with ctx.dom when the results are server-rendered HTML. Drive a browser (ctx.browser) only when nothing else reaches the data.
3. Every value the operator typed is a parameter of the automation unless the goal says it is fixed. Choose names a person would use (query, min_price, city), never element ids. Choices made by clicking (a sort, a filter, a checkbox) are part of how the outcome is reached: bake them in, and say so.
4. Investigate before writing: probe the endpoint you intend to call with the recorded value, read a snapshot to see the shape of the result, open the page if needed. Do not guess what a tool can tell you.
5. Submit with write_script. It is linted and executed with the recorded inputs; the rows must reproduce something the operator saw. If it is rejected you get the reason; fix and resubmit. After it is accepted, tell the operator what it returns and how to run it, and hand over. If they ask for a change, make it: another write_script replaces the saved one after the same checks.
6. Keep going. Budgets are large. Do not repeat a call with identical arguments; the answer will not change. If a route is not working after two tries, step back and try a different one.

TOOLS
- read_snapshot: the visible text or pruned HTML of a page the operator saw (by seq; omit seq for the last page of the recording).
- read_body: a captured request or response body in full, page by page.
- probe: send one HTTP request and see the full response. No cookies or credentials; pass bearerFrom for a site that gates its API behind the anonymous bearer it mints for every visitor.
- open_page: load a URL in a headless browser, act on it (fill, click, press, wait) and read text, an element's HTML, or the result of a JavaScript expression evaluated in the page.
- write_script: submit the script with its parameters.
- give_up: only when no automation is possible from this recording; say what to record differently.

THE SCRIPT
Plain JavaScript (no import, require, process, eval). Define:
  async function run(ctx) { ... return rows; }
ctx.inputs        — the run's parameters by the names you declare in write_script. Read every one from here; never hard-code a recorded value.
ctx.http.fetch(url, { method, headers, body }) → { status, ok, url, contentType, text, json() }. body may be an object (sent as JSON) or a string. Cookie/authorization headers are dropped.
ctx.dom(html) → page handle over HTML you already fetched, no network: eval(expression), text(selector?), texts(selector), html(selector?), attr(selector, name), close(). Use it to parse server-rendered results.
ctx.browser.open(url) → page handle on a live page: goto(url), fill(selector, text), click(selector), press(selector, key), waitFor(selector, ms) → boolean, wait(ms), text(selector?), texts(selector), html(selector?), attr(selector, name), eval(expression), url(), close().
  eval takes an expression, e.g. "[...document.querySelectorAll('.row')].map(r => ({ title: r.querySelector('h3')?.textContent?.trim(), link: r.querySelector('a')?.href }))"; the result must survive JSON.
ctx.site.token(pageUrl) → the anonymous bearer the site mints for every visitor, read from its web storage after loading pageUrl. Send it as headers: { authorization: 'Bearer ' + token }. This is the ONLY credential a script may send.
ctx.log(...) — notes shown to the operator on failure. ctx.sleep(ms).
Return an array of flat row objects — one per result, plain string/number fields named as a person would name columns (title, price, link). Absolute URLs for links.

ACCEPTANCE (deterministic, applied to every submission)
1. Lint: reads every declared parameter from ctx.inputs; carries no recorded typed value as a literal unless you list it in "fixed" and explain why in the summary; no imports.
2. Executed with the declared example values (the recorded ones) within 120 seconds, returning at least one row.
3. Evidence: if the operator marked text, each marked selection must appear as a field value in some row. Otherwise at least one row must carry text that appears in a page snapshot the operator saw (or the typed value, or a result they clicked). Ask for plain text rather than HTML.
Hosts the accepted script contacted are recorded; later runs are confined to them.`;

// --- acceptance ---------------------------------------------------------------

type Param = { name: string; example: string; description?: string };
type Verdict =
  | { ok: true; run: ScriptOk; missing: string[]; columns: string[]; note: string }
  | { ok: false; reason: string; partial?: { run: ScriptOk; missing: string[]; columns: string[] } };

function snapshotHaystack(events: Ev[]): string {
  let out = '';
  for (const e of events) {
    if (e.kind !== 'snapshot') continue;
    out += ' ' + markKey(String(e.text ?? '')) + ' ' + markKey(String(e.html ?? ''));
    if (out.length > EVIDENCE_CHARS) break;
  }
  return out.slice(0, EVIDENCE_CHARS);
}

// How many rows carry a value the operator saw on some page: a string field
// of four or more letters and digits found in a snapshot.
function rowsSeen(rows: Record<string, unknown>[], hay: string): number {
  if (!hay) return 0;
  let n = 0;
  for (const row of rows.slice(0, 200)) {
    const hit = Object.values(row).some((v) => {
      if (typeof v !== 'string' && typeof v !== 'number') return false;
      const k = markKey(String(v));
      return k.length >= 4 && hay.includes(k);
    });
    if (hit) n++;
  }
  return n;
}

async function accept(
  source: string, params: Param[], fixed: string[], typed: string[], marks: string[], evidence: string[], hay: string,
  readToken: ToolCtx['readToken'],
): Promise<Verdict> {
  const inputs = Object.fromEntries(params.map((p) => [p.name, p.example]));
  const lint = lintScript(source, inputs);
  // A typed value that is not a parameter must not be baked in silently.
  const literals = stringLiterals(source);
  for (const v of typed) {
    if (v.length < 3 || params.some((p) => p.example === v) || fixed.includes(v)) continue;
    if (literals.some((l) => literalCarries(l, v))) lint.push(`the typed value "${v}" is hard-coded — declare it as a parameter, or list it under "fixed" and say why it never changes`);
  }
  if (lint.length) return { ok: false, reason: `lint: ${lint.join('; ')}` };
  const run = await runScript(source, { inputs, readToken, timeoutMs: 120_000 });
  if ('error' in run) {
    return { ok: false, reason: `the script failed: ${run.error}${run.log.length ? ` — log: ${run.log.slice(-5).join(' | ')}` : ''}` };
  }
  if (!run.rows.length) {
    return { ok: false, reason: `the script returned no rows for the recorded input(s)${run.log.length ? ` — log: ${run.log.slice(-5).join(' | ')}` : ''}` };
  }
  const columns = [...new Set(run.rows.flatMap((r) => Object.keys(r)))];
  const first = `First row: ${JSON.stringify(run.rows[0]).slice(0, 400)}`;
  if (marks.length) {
    const missing = marks.filter((m) => !run.rows.some((r) => objectHasMark(r, m)));
    if (missing.length === marks.length) {
      return { ok: false, reason: `the rows carry none of the operator's marked selections as a field value (${marks.map(shortMark).join(', ')}). ${first}` };
    }
    if (missing.length) {
      return {
        ok: false,
        reason: `${marks.length - missing.length} of ${marks.length} marked selections located; missing: ${missing.map(shortMark).join(', ')}. Add the field(s) that carry the missing text, or say why no source has it.`,
        partial: { run, missing, columns },
      };
    }
    return { ok: true, run, missing: [], columns, note: `all ${marks.length} marked selection(s) located` };
  }
  const seen = rowsSeen(run.rows, hay);
  if (seen) return { ok: true, run, missing: [], columns, note: `${seen} of ${Math.min(run.rows.length, 200)} row(s) carry text the operator saw on a recorded page` };
  const text = run.rows.slice(0, 200).map(rowText).join('\n');
  const typedHit = typed.find((v) => v.length >= 2 && text.includes(markKey(v)));
  const clicked = evidence.find((ev) => text.includes(ev));
  if (typedHit || clicked) return { ok: true, run, missing: [], columns, note: typedHit ? `rows carry the typed value "${typedHit}"` : `rows carry the clicked result "${clicked}"` };
  return {
    ok: false,
    reason: `no row carries anything the operator saw: nothing from the page snapshots${typed.length ? `, not the typed value(s) ${typed.map((v) => `"${v}"`).join(', ')}` : ''}${evidence.length ? `, not a clicked result (${evidence.map((e) => `"${e}"`).join(', ')})` : ''}. Return fields whose plain text appears on the recorded page (titles, names, prices), not only ids or links. ${first}`,
  };
}

// --- tools ----------------------------------------------------------------------

const TOOLS: Anthropic.Beta.BetaTool[] = [
  ...INVESTIGATE_TOOLS,
  {
    name: 'write_script',
    description: 'Submit the session script with its parameters. It is linted, executed with the example values (the recorded ones) and checked against what the operator saw; the result says whether it was accepted and, if not, exactly why. An accepted script replaces any saved automation for this session.',
    input_schema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'the full script defining async function run(ctx)' },
        title: { type: 'string', description: 'short human name for the automation, e.g. "eBay Listings by Minimum Price"' },
        summary: { type: 'string', description: 'two or three sentences: what the automation returns, how it reaches the data, which recorded choices are baked in and why' },
        parameters: {
          type: 'array',
          description: 'the inputs a run takes; examples are the recorded values so the acceptance run reproduces the recording',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'identifier a person would use: query, min_price, city' },
              example: { type: 'string', description: 'the recorded value' },
              description: { type: 'string' },
            },
            required: ['name', 'example'],
            additionalProperties: false,
          },
        },
        fixed: { type: 'array', items: { type: 'string' }, description: 'typed values deliberately baked into the script rather than parameterised (explain in the summary)' },
      },
      required: ['source', 'title', 'summary', 'parameters'],
      additionalProperties: false,
    },
  },
  {
    name: 'give_up',
    description: 'Declare that no automation can be derived from this recording, with concrete advice on what to record differently.',
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string' }, advice: { type: 'string' } },
      required: ['reason', 'advice'],
      additionalProperties: false,
    },
  },
];

function describeExisting(spec: Spec, script: string | undefined): string {
  const steps = spec.steps.map((s) => s.type === 'request'
    ? `${s.method} ${s.url}${s.bodyTemplate !== undefined ? ` body ${JSON.stringify(s.bodyTemplate).slice(0, 300)}` : ''}`
    : s.type === 'script' ? `session script (${s.file}, hosts ${s.hosts.join(', ')})`
    : `${s.type} step`).join(' → ');
  const cols = spec.outcome.columns?.map((c) => c.name).join(', ');
  const base = `${steps}; parameters ${spec.parameters.map((p) => `${p.name}="${p.example}"`).join(', ') || 'none'}; rows at ${spec.outcome.extract.records ?? 'the whole response'}; ${cols ? `columns ${cols}` : 'no marked columns'}${spec.repaired?.summary ? `; built for: ${spec.repaired.summary}` : ''}`;
  return script ? `${base}\n--- current script ---\n${script.slice(0, 8000)}\n--- end script ---` : base;
}

// --- the loop --------------------------------------------------------------------

export async function maxEffort(id: string, emit: Emit, signal: AbortSignal, input: EffortInput): Promise<void> {
  const meta = getMeta(id);
  if (!meta) { emit('error', 'unknown session'); return; }
  if (status(meta) !== 'complete') { emit('error', `session is ${status(meta)} — only complete recordings can be worked on`); return; }
  const goal = input.goal.trim().slice(0, 4000);
  if (goal) { meta.goal = goal; saveMeta(meta); }

  const events = readEvents(id);
  const a = analyse({ meta: { session: id, status: 'complete' }, events });
  const marks = a.marks;
  const typed = paramNames(a);
  const evidence = evidenceStrings(events, a);
  const snapshots = events.filter((e) => e.kind === 'snapshot');
  const hay = snapshotHaystack(events);
  const existing = getSpec(id) as Spec | undefined;
  const existingScript = existing?.steps.find((s) => s.type === 'script');
  const firstPage = events.find((e) => e.kind === 'page' && typeof e.url === 'string')?.url as string | undefined;

  emit('info', `Reading the recording: ${events.length} events, ${snapshots.length} page snapshot(s), ${a.calls.length} captured call(s)${typed.length ? `, typed ${typed.map((p) => `"${p.value}"`).join(', ')}` : ''}${marks.length ? `, ${marks.length} marked selection(s)` : ''}.`);
  if (!snapshots.length) emit('info', 'This recording has no page snapshots (recorded before snapshots existed, or the extension was not reloaded). The model will rely on captured calls and live pages; a fresh recording gives it far more to work with.');
  if (goal) emit('you', goal);

  const pack = [
    'MAXIMUM EFFORT MODE.',
    `Operator's goal: ${goal ? `"${goal}"` : 'not stated — work out the outcome from the recording, say what you think they want, and ask if it is not clear'}`,
    ...(existing ? [`The session already has an automation (${existing.repaired ? `built by ${existing.repaired.model} in ${existing.repaired.mode ?? 'repair'} mode` : 'deterministic'}): ${describeExisting(existing, existingScript ? getScript(id, existingScript.file) : undefined)}`, 'An accepted write_script replaces it.'] : ['No automation exists for this session yet.']),
    '',
    `Session "${id}". Site: ${meta.hosts.join(', ')}. First page: ${firstPage ?? 'unknown'}. Language: ${a.language}.`,
    `Deterministic analyser's verdict: ${a.outcome ? `it chose ${a.outcome.method} ${a.outcome.url} as the outcome call (ranked by carrying the typed value and returning records — often wrong for multi-step workflows; judge for yourself)` : 'no outcome call identified'}. Notes: ${a.notes.join(' ') || 'none'}`,
    `Values the operator typed (default parameters; name them well): ${typed.map((p) => `"${p.value}" into ${p.field}`).join(', ') || 'none'}`,
    `Marked text (each must appear as a field value in the rows): ${marks.map((m) => `"${m.slice(0, 400)}"`).join(' | ') || 'none'}`,
    `Results the operator clicked (normalised): ${evidence.filter((e) => !marks.some((m) => markKey(m).startsWith(e))).map((e) => `"${e}"`).join(', ') || 'none'}`,
    '',
    `Route the operator took (navigations; query changes on the same page listed as name=value):\n${navSummary(events)}`,
    '',
    `Page snapshots (what the operator saw; read_snapshot <seq> for the full text or HTML):\n${snapshots.map((s) => `#${s.seq} (${s.reason}) ${s.url}${s.title ? ` "${String(s.title).slice(0, 80)}"` : ''} — ${String(s.text ?? '').length} chars of text`).join('\n') || 'none'}`,
    '',
    `Recording (${events.length} events, ordered; bodies and snapshots previewed — read_body / read_snapshot for the full text):`,
    overview(events, a),
  ].join('\n');

  let client: Anthropic;
  try {
    const workspace = process.env.ANTHROPIC_WORKSPACE_ID;
    client = new Anthropic(workspace ? { defaultHeaders: { 'anthropic-workspace-id': workspace } } : {});
  } catch (e) {
    emit('error', `no API credentials: ${(e as Error).message}. Put ANTHROPIC_API_KEY=… in the project's .env and restart the backend.`);
    return;
  }

  const readToken = input.readToken ?? (async (loadUrl: string) => (await import('../../runner/src/browser-token.js')).readBearerViaBrowser(loadUrl));
  const ctx: ToolCtx = { events, probes: [], signal, emit, readToken };
  const seen = new Map<string, number>();
  const usage: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  let toolCalls = 0;
  let scriptTries = 0;
  let saved = 0;
  let partial: { source: string; title: string; summary: string; params: Param[]; run: ScriptOk; missing: string[] } | undefined;

  const save = (source: string, title: string, summary: string, params: Param[], run: ScriptOk, note: string) => {
    const columns = [...new Set(run.rows.flatMap((r) => Object.keys(r)))];
    saveScript(id, SCRIPT_FILE, source);
    const spec: Spec = {
      version: SPEC_VERSION,
      name: id,
      origin: firstPage ? new URL(firstPage).origin : `https://${meta.hosts[0]}`,
      language: a.language,
      parameters: params.map((p) => ({ name: p.name, example: p.example, required: true })),
      steps: [{ id: 'automation', type: 'script', file: SCRIPT_FILE, reason: summary, hosts: run.hosts }],
      outcome: { fromStep: 'automation', expect: { path: '__http_ok', equals: 'true' }, extract: { records: 'rows' } },
      repaired: { at: new Date().toISOString(), model: MODEL, diagnosis: summary, summary, mode: 'effort', ...(goal ? { feedback: goal } : {}) },
    };
    saveSpec(id, spec);
    if (!meta.name && title) { meta.name = title.slice(0, 80); saveMeta(meta); }
    saved++;
    emit('saved', `Automation ${saved > 1 || existing ? 'updated' : 'saved'}${title ? ` as "${title}"` : ''} — ${note}; ${run.rows.length} row(s) with columns ${columns.join(', ')}; parameters ${params.map((p) => p.name).join(', ') || 'none'}; hosts ${run.hosts.join(', ') || 'none'}.`);
  };
  const finish = (kind: string, text: string) => {
    emit(kind, text);
    emit('info', `Spend: ${estimateSpend(MODEL, usage)}`);
  };
  const keepPartial = (why: string) => {
    if (!partial) return false;
    save(partial.source, partial.title, partial.summary, partial.params, partial.run, `${why}; kept the best verified attempt (${marks.length - partial.missing.length} of ${marks.length} marked selections)`);
    return true;
  };
  const stopped = () => {
    keepPartial('stopped by the operator');
    finish('done', saved ? 'Stopped by the operator. The saved automation stands.' : 'Stopped by the operator. Nothing was saved.');
  };

  const messages: Anthropic.Beta.BetaMessageParam[] = [{
    role: 'user',
    content: [{ type: 'text', text: pack, cache_control: { type: 'ephemeral' } }],
  }];
  const fallbackable = /opus|fable/.test(MODEL);
  const betas = fallbackable ? ['server-side-fallback-2026-07-01'] : [];

  // Anything the operator typed while the model worked rides along with the
  // next turn's tool results, flagged so the model knows it arrived mid-task.
  const operatorNotes = (): Anthropic.Beta.BetaTextBlockParam[] => input.inbox.drain().map((t) => {
    emit('you', t);
    return { type: 'text', text: `Operator (while you were working): ${t}` };
  });

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    if (signal.aborted) { stopped(); return; }
    if (usage.input + usage.cacheRead + usage.cacheWrite > MAX_INPUT_TOKENS) {
      keepPartial('token budget reached');
      finish('done', 'Token budget for this session reached.');
      return;
    }
    emit('llm', `Turn ${turn}`);
    let msg: Anthropic.Beta.BetaMessage;
    try {
      const stream = client.beta.messages.stream({
        model: MODEL,
        max_tokens: 32_000,
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: EFFORT },
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        tools: TOOLS,
        messages,
        ...(betas.length ? { betas } : {}),
        ...(fallbackable ? { fallbacks: 'default' as const } : {}),
      } as Parameters<typeof client.beta.messages.stream>[0], { signal });
      // Thinking and prose reach the page as they are produced: the operator
      // watches the reasoning, not a spinner.
      stream.on('streamEvent', (ev) => {
        if (ev.type === 'content_block_start' && (ev.content_block.type === 'text' || ev.content_block.type === 'thinking')) {
          emit('block', ev.content_block.type === 'text' ? 'say' : 'think');
        } else if (ev.type === 'content_block_delta') {
          if (ev.delta.type === 'text_delta') emit('say', ev.delta.text, { delta: true });
          else if (ev.delta.type === 'thinking_delta') emit('think', ev.delta.thinking, { delta: true });
        }
      });
      msg = await stream.finalMessage();
    } catch (e) {
      if (signal.aborted) { stopped(); return; }
      finish('error', `model call failed: ${(e as Error).message}`);
      return;
    }
    usage.input += msg.usage.input_tokens;
    usage.output += msg.usage.output_tokens;
    usage.cacheRead += msg.usage.cache_read_input_tokens ?? 0;
    usage.cacheWrite += msg.usage.cache_creation_input_tokens ?? 0;
    if (msg.stop_reason === 'refusal') { finish('error', 'the model declined to work on this recording'); return; }

    const uses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    messages.push({ role: 'assistant', content: msg.content });

    if (!uses.length) {
      if (msg.stop_reason === 'max_tokens') {
        messages.push({ role: 'user', content: 'Your reply was cut off. Continue; keep prose short and put the script in write_script.' });
        continue;
      }
      // The model handed the conversation over. Wait for the operator.
      emit('await', saved ? 'Your turn. Ask for a change, or press Stop to finish.' : 'Your turn. Answer, add detail, or press Stop.');
      const reply = await input.inbox.take(signal, IDLE_MS);
      if (reply === undefined) {
        if (signal.aborted) { stopped(); return; }
        finish('done', saved ? 'No reply for a while; the saved automation stands.' : 'No reply for a while; ended without an automation.');
        return;
      }
      emit('you', reply);
      messages.push({ role: 'user', content: [{ type: 'text', text: reply }, ...operatorNotes()] });
      continue;
    }

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const use of uses) {
      const args = (use.input ?? {}) as Record<string, unknown>;
      toolCalls++;
      if (use.name === 'give_up') {
        emit('advice', String(args.advice ?? 'the model sees no automatable path in this recording'));
        keepPartial('gave up');
        finish('done', saved ? 'Ended; the saved automation stands.' : `No automation is possible from this recording: ${String(args.reason ?? '').slice(0, 400)}`);
        return;
      }
      if (use.name === 'write_script') {
        scriptTries++;
        const source = String(args.source ?? '');
        const title = String(args.title ?? '').slice(0, 80);
        const summary = String(args.summary ?? '').slice(0, 1200);
        const params: Param[] = (Array.isArray(args.parameters) ? args.parameters as Param[] : [])
          .map((p) => ({ name: String(p?.name ?? '').trim(), example: String(p?.example ?? ''), ...(p?.description ? { description: String(p.description).slice(0, 200) } : {}) }))
          .filter((p) => p.name);
        const fixed = Array.isArray(args.fixed) ? (args.fixed as unknown[]).map(String) : [];
        const bad = params.find((p) => !/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(p.name));
        const dup = params.find((p, i) => params.findIndex((q) => q.name === p.name) !== i);
        emit('try', `Script attempt ${scriptTries}: ${params.length ? `parameters ${params.map((p) => `${p.name}="${p.example}"`).join(', ')}` : 'no parameters'} — executing… (${source.length} chars)`);
        const v = bad ? { ok: false as const, reason: `parameter name "${bad.name}" is not an identifier (letters, digits, underscores)` }
          : dup ? { ok: false as const, reason: `parameter "${dup.name}" is declared twice` }
          : params.some((p) => !p.example) ? { ok: false as const, reason: 'every parameter needs an example: the recorded value, so the acceptance run reproduces the recording' }
          : await accept(source, params, fixed, typed.map((p) => p.value), marks, evidence, hay, readToken);
        if (v.ok) {
          emit('ok', `verified: ${v.note}; ${v.run.rows.length} row(s), columns ${v.columns.join(', ')}, hosts ${v.run.hosts.join(', ') || 'none'}, ${(v.run.ms / 1000).toFixed(1)}s`);
          save(source, title, summary, params, v.run, v.note);
          partial = undefined;
          results.push({ type: 'tool_result', tool_use_id: use.id, content: `ACCEPTED and saved. ${v.note}; ${v.run.rows.length} row(s); columns ${v.columns.join(', ')}; first row ${JSON.stringify(v.run.rows[0]).slice(0, 600)}. Tell the operator what the automation returns, which choices are baked in, and how to run it (parameters ${params.map((p) => p.name).join(', ') || 'none'}); then end your turn so they can reply.` });
          continue;
        }
        emit('fail', v.reason);
        if (v.partial && (!partial || partial.missing.length > v.partial.missing.length)) {
          partial = { source, title, summary, params, run: v.partial.run, missing: v.partial.missing };
        }
        if (scriptTries >= MAX_SCRIPT_TRIES) {
          keepPartial('attempt limit reached');
          finish('done', `No working automation after ${MAX_SCRIPT_TRIES} script attempts.`);
          return;
        }
        results.push({ type: 'tool_result', tool_use_id: use.id, content: `REJECTED: ${v.reason}`, is_error: true });
        continue;
      }
      if (toolCalls > MAX_TOOL_CALLS) {
        results.push({ type: 'tool_result', tool_use_id: use.id, content: 'Tool budget exhausted: submit write_script now with your best script, or give_up.', is_error: true });
        continue;
      }
      const key = `${use.name}:${JSON.stringify(args)}`;
      const times = (seen.get(key) ?? 0) + 1;
      seen.set(key, times);
      if (times >= 3) {
        results.push({ type: 'tool_result', tool_use_id: use.id, content: `You have already made this exact call ${times - 1} times; the result will not change. Take a different approach, ask the operator, or give_up.`, is_error: true });
        continue;
      }
      if (use.name === 'read_body') emit('tool', `read_body ${typeof args.probe === 'number' ? `probe #${args.probe}` : `#${args.seq}`}${args.offset ? ` from ${args.offset}` : ''}`);
      if (use.name === 'read_snapshot') emit('tool', `read_snapshot ${typeof args.seq === 'number' ? `#${args.seq}` : 'last page'} ${args.part === 'html' ? 'html' : 'text'}${args.offset ? ` from ${args.offset}` : ''}`);
      const out = await runTool(use.name, args, ctx).catch((e) => `tool failed: ${(e as Error).message}`);
      results.push({ type: 'tool_result', tool_use_id: use.id, content: out });
      if (signal.aborted) { stopped(); return; }
    }
    messages.push({ role: 'user', content: [...results, ...operatorNotes()] });
  }
  keepPartial('turn limit reached');
  finish('done', saved ? `Turn limit reached; the saved automation stands.` : `No working automation after ${MAX_TURNS} turns.`);
}
