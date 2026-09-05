import Fastify, { type FastifyReply } from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import { appendEvents, appendLog, createSession, deleteSpec, getMeta, getScript, getSpec, listSessions, readEvents, readLog, saveBrief, saveMeta, saveSpec, status, type Meta } from './store.js';
import { repairSession } from './repair.js';
import { Inbox, maxEffort } from './effort.js';
import { buildBrief, DEFAULT_BUDGET } from './brief.js';
import { checkCandidate, loadEvidence, parseCandidate, saveCandidate, verifySpec } from './candidate.js';
import { parseEnv } from './env.js';

// Local secrets (ANTHROPIC_API_KEY for the repair assistant) live in the
// project's .env, which is gitignored. Environment always wins.
const envFile = new URL('../../.env', import.meta.url);
if (existsSync(envFile)) {
  for (const [key, value] of Object.entries(parseEnv(readFileSync(envFile, 'utf8')))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
import { sanitise } from './redact.js';
import { analyse } from './analyse.js';
import { SPEC_VERSION, toSpec, type Spec } from './generate.js';
import { probeAuth } from './probe.js';
import { renderDetail, renderList } from './views.js';
import { run, type RunDeps } from '../../runner/src/run.js';
import { readBearerViaBrowser, type Bearer } from '../../runner/src/browser-token.js';
import { extractPageViaBrowser } from '../../runner/src/browser-extract.js';
import { runScript } from '../../runner/src/script.js';

// Captured bodies travel in event batches: a large JSON response must not be
// refused at the door.
const app = Fastify({ logger: { level: 'warn' }, bodyLimit: 64 * 1024 * 1024 });

// So `curl --data-binary @answer.md -H 'content-type: text/plain'` reaches the
// import route with the model's reply, and the brief route with the goal: for
// both, a plain-text body is the whole value.
for (const type of ['text/plain', 'text/markdown']) {
  app.addContentTypeParser(type, { parseAs: 'string' }, (_req, body, done) => done(null, body));
}

app.get('/health', async () => ({ ok: true }));

app.post('/api/sessions', async (req, reply) => {
  const { session, hosts, startedAt } = req.body as { session?: string; hosts?: string[]; startedAt?: number };
  if (!session || !/^[\w-]{1,64}$/.test(session)) {
    return reply.code(400).send({ error: 'session must be 1-64 word characters' });
  }
  if (!Array.isArray(hosts) || hosts.length === 0) {
    return reply.code(400).send({ error: 'hosts required' });
  }
  if (!createSession(session, hosts, startedAt ?? Date.now())) {
    return reply.code(409).send({ error: `session "${session}" already exists` });
  }
  return { ok: true };
});

// A chatty page can produce a distinct snapshot every few seconds, each up to
// 600 KB. Past the cap only the states nothing else records are still kept: a
// page loaded, a page left, the last state at stop. What was dropped is
// counted, never silent.
const SNAPSHOT_CAP = 40;
const ALWAYS_KEPT = /^(load|leave|stop)$/;

function keepSnapshot(meta: Meta, snap: Record<string, unknown>): boolean {
  if ((meta.snapshots ?? 0) >= SNAPSHOT_CAP && !ALWAYS_KEPT.test(String(snap.reason))) {
    meta.snapshotsDropped = (meta.snapshotsDropped ?? 0) + 1;
    return false;
  }
  meta.snapshots = (meta.snapshots ?? 0) + 1;
  return true;
}

app.post('/api/sessions/:id/events', async (req, reply) => {
  const { id } = req.params as { id: string };
  const meta = getMeta(id);
  if (!meta) return reply.code(404).send({ error: 'unknown session' });
  if (meta.stoppedAt) return reply.code(409).send({ error: 'session already stopped' });

  const { items } = req.body as { items?: Record<string, unknown>[] };
  if (!Array.isArray(items)) return reply.code(400).send({ error: 'items required' });

  const kept: Record<string, unknown>[] = [];
  for (const item of items) {
    const clean = sanitise(item, meta.hosts);
    if (!clean) { meta.dropped++; continue; }
    if (clean.kind === 'snapshot' && !keepSnapshot(meta, clean)) continue;
    kept.push(clean);
  }
  if (kept.length) appendEvents(id, kept);
  meta.count += kept.length;
  meta.lastEventAt = Date.now();
  saveMeta(meta);
  return { ok: true, received: kept.length, dropped: items.length - kept.length };
});

app.post('/api/sessions/:id/stop', async (req, reply) => {
  const { id } = req.params as { id: string };
  const meta = getMeta(id);
  if (!meta) return reply.code(404).send({ error: 'unknown session' });
  const { stoppedAt } = req.body as { stoppedAt?: number };
  meta.stoppedAt = stoppedAt ?? Date.now();
  saveMeta(meta);
  // Analyse and generate immediately so the session page is ready the moment
  // the operator lands on it. A workflow with no identifiable outcome just
  // has no spec; the page explains why from the analysis notes.
  const spec = await autoSpec(id).catch(() => undefined);
  return { ok: true, spec: !!spec };
});

async function autoSpec(id: string) {
  const saved = getSpec(id) as Spec | undefined;
  if (saved?.repaired) return saved;
  const ev = loadEvidence(id);
  if ('error' in ev) return undefined;
  const a = ev.a;
  if (!a.outcome) return undefined;
  const page = readEvents(id).find((e) => e.kind === 'page' && typeof e.url === 'string');
  const loadUrl = (page?.url as string) ?? a.outcome.url;
  // The auth probe targets the call the run actually depends on: the chained
  // detail call when there is one, the search call otherwise.
  const probeStatus = await probeAuth(a.chain?.call ?? a.outcome).catch(() => undefined);
  const spec = toSpec(a, { name: id, origin: new URL(loadUrl).origin, loadUrl, probeStatus });
  const verdict = verifySpec(spec, ev);
  if (verdict.status === 'refused') {
    deleteSpec(id);
    ev.meta.refusal = { reason: verdict.reason, at: Date.now(), version: SPEC_VERSION };
    saveMeta(ev.meta);
    return undefined;
  }
  spec.verified = verdict;
  delete ev.meta.refusal;
  saveMeta(ev.meta);
  saveSpec(id, spec);
  return spec;
}

// A spec saved by an older generator is regenerated before use, so sessions
// recorded before a feature (e.g. pagination) still benefit from it. Repaired
// specs are exempt: the deterministic generator would only refuse again.
async function freshSpec(id: string) {
  const saved = getSpec(id) as { version?: number; repaired?: unknown } | undefined;
  if (saved?.repaired) return saved;
  if (getMeta(id)?.refusal?.version === SPEC_VERSION) return undefined;
  if (saved?.version === SPEC_VERSION) return saved;
  return autoSpec(id).catch(() => undefined);
}

// A finished session doubles as a reusable automation, so the operator can
// give it a working title. The directory id never changes; links stay stable.
app.post('/api/sessions/:id/name', async (req, reply) => {
  const { id } = req.params as { id: string };
  const meta = getMeta(id);
  if (!meta) return reply.code(404).send({ error: 'unknown session' });
  const { name } = (req.body ?? {}) as { name?: string };
  const clean = String(name ?? '').trim().slice(0, 80);
  if (clean) meta.name = clean;
  else delete meta.name;
  saveMeta(meta);
  return { ok: true, name: meta.name ?? null };
});

app.get('/api/sessions', async () => listSessions().map((m) => ({ ...m, status: status(m) })));

app.get('/api/sessions/:id/export', async (req, reply) => {
  const { id } = req.params as { id: string };
  const meta = getMeta(id);
  if (!meta) return reply.code(404).send({ error: 'unknown session' });
  const events = readEvents(id);
  const seqs = events.map((e) => e.seq as number).filter((s) => typeof s === 'number');
  const gaps: number[] = [];
  for (let i = 1; i < seqs.length; i++) {
    if (seqs[i] !== seqs[i - 1] + 1) gaps.push(seqs[i - 1] + 1);
  }
  return {
    meta: { ...meta, status: status(meta) },
    integrity: { events: events.length, seqGaps: gaps, dropped: meta.dropped },
    events,
  };
});

function loadAnalysis(id: string) {
  const meta = getMeta(id);
  if (!meta) return undefined;
  return analyse({ meta: { session: id, status: status(meta) }, events: readEvents(id) });
}

app.get('/api/sessions/:id/analysis', async (req, reply) => {
  const { id } = req.params as { id: string };
  const a = loadAnalysis(id);
  if (!a) return reply.code(404).send({ error: 'unknown session' });
  return a;
});

app.post('/api/sessions/:id/spec', async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!getMeta(id)) return reply.code(404).send({ error: 'unknown session' });
  try {
    const spec = await autoSpec(id);
    if (!spec) return reply.code(422).send({ error: getMeta(id)?.refusal?.reason ?? 'no parameterised outcome call identified' });
    return spec;
  } catch (e) {
    return reply.code(422).send({ error: (e as Error).message });
  }
});

const IMPORT_RUNNING = 'an answer is already being verified for this session — wait for it to finish';

// Operator-triggered LLM repair. The response is a live NDJSON stream: one
// {kind, text} line per step, so the session page can show the loop as it
// runs. Closing the page aborts the loop.
app.post('/api/sessions/:id/repair', async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!getMeta(id)) return reply.code(404).send({ error: 'unknown session' });
  // Refining a saved automation: the page sends what the last run returned
  // and, optionally, the operator's note on what was wrong with it.
  const { feedback, lastRun } = (req.body ?? {}) as { feedback?: string; lastRun?: unknown };
  if (repairs.has(id)) return reply.code(409).send({ error: 'a repair is already running for this session' });
  if (imports.has(id)) return reply.code(409).send({ error: IMPORT_RUNNING });
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
  const emit = (kind: string, text: string) => raw.write(JSON.stringify({ kind, text }) + '\n');
  // The response's close fires when the operator leaves the page mid-loop.
  // (The request's close fires as soon as its JSON body is consumed.)
  const abort = new AbortController();
  raw.on('close', () => abort.abort());
  repairs.set(id, abort);
  try {
    await repairSession(id, emit, abort.signal, {
      feedback: String(feedback ?? '').slice(0, 2000), lastRun,
      readToken: cachedReadToken,
      runSpec: (spec, params) => run(spec, params, runDeps(id)),
    });
  } catch (e) {
    emit('error', (e as Error).message);
  } finally {
    repairs.delete(id);
  }
  raw.end();
});

// One repair per session at a time; the Stop button aborts it. The loop
// finishes on its own stream (spend line, best partial kept), so the page
// keeps reading rather than tearing the connection down.
const repairs = new Map<string, AbortController>();
app.post('/api/sessions/:id/repair/stop', async (req) => {
  const { id } = req.params as { id: string };
  const running = repairs.get(id);
  running?.abort();
  return { stopped: running !== undefined };
});

// Maximum Effort Mode: the same live NDJSON stream, plus a conversation. The
// operator's messages arrive on a second route and are handed to the loop
// through its inbox; the stream stays open while the model waits for them.
// Every line is also kept in the session folder so the page can show the
// conversation again after a reload (streamed deltas are joined per block).
const efforts = new Map<string, { abort: AbortController; inbox: Inbox }>();
app.post('/api/sessions/:id/effort', async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!getMeta(id)) return reply.code(404).send({ error: 'unknown session' });
  const { goal } = (req.body ?? {}) as { goal?: string };
  if (efforts.has(id)) return reply.code(409).send({ error: 'Maximum Effort Mode is already running for this session' });
  if (imports.has(id)) return reply.code(409).send({ error: IMPORT_RUNNING });
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
  let block: { kind: string; text: string } | undefined;
  const flush = () => { if (block && block.text.trim()) appendLog(id, { ...block, t: Date.now() }); block = undefined; };
  const emit = (kind: string, text: string, extra?: Record<string, unknown>) => {
    raw.write(JSON.stringify({ kind, text, ...extra }) + '\n');
    if (extra?.delta) {
      if (!block || block.kind !== kind) { flush(); block = { kind, text: '' }; }
      block.text += text;
      return;
    }
    flush();
    if (kind !== 'block' && kind !== 'llm') appendLog(id, { kind, text, t: Date.now() });
  };
  const abort = new AbortController();
  raw.on('close', () => abort.abort());
  const inbox = new Inbox();
  efforts.set(id, { abort, inbox });
  appendLog(id, { kind: 'start', text: new Date().toISOString(), t: Date.now() });
  try {
    await maxEffort(id, emit, abort.signal, { goal: String(goal ?? '').slice(0, 4000), inbox, readToken: cachedReadToken });
  } catch (e) {
    emit('error', (e as Error).message);
  } finally {
    flush();
    efforts.delete(id);
  }
  raw.end();
});

app.post('/api/sessions/:id/effort/say', async (req, reply) => {
  const { id } = req.params as { id: string };
  const running = efforts.get(id);
  if (!running) return reply.code(409).send({ error: 'Maximum Effort Mode is not running for this session' });
  const { text } = (req.body ?? {}) as { text?: string };
  const clean = String(text ?? '').trim().slice(0, 4000);
  if (!clean) return reply.code(400).send({ error: 'text required' });
  running.inbox.push(clean);
  return { ok: true };
});

app.post('/api/sessions/:id/effort/stop', async (req) => {
  const { id } = req.params as { id: string };
  const running = efforts.get(id);
  running?.abort.abort();
  return { stopped: running !== undefined };
});

// Bring your own model. The brief is the whole recording as one Markdown
// file for a model the operator already pays for; the answer comes back
// through the import route and is held to the same acceptance as the API
// loop. GET serves the brief for curl and agents; POST also stores the goal
// the operator typed. Both write BRIEF.md into the session folder.
async function sendBrief(id: string, reply: FastifyReply, goal: string | undefined, q: { budget?: unknown; probe?: unknown }) {
  const meta = getMeta(id);
  if (!meta) return reply.code(404).send({ error: 'unknown session' });
  if (goal !== undefined) {
    const clean = goal.trim().slice(0, 4000);
    if (clean) meta.goal = clean; else delete meta.goal;
    saveMeta(meta);
  }
  const ev = loadEvidence(id);
  if ('error' in ev) return reply.code(409).send({ error: ev.error });
  const budget = Number(q.budget) || DEFAULT_BUDGET;
  const probe = q.probe !== '0' && q.probe !== 'false' && q.probe !== false;
  const md = await buildBrief(ev, { budget, probe });
  saveBrief(id, md);
  ev.meta.briefAt = Date.now();
  saveMeta(ev.meta);
  return reply.type('text/markdown; charset=utf-8').header('content-disposition', `attachment; filename="${id}-brief.md"`).send(md);
}

// A GET that writes, deliberately: exporting is the act of handing the
// recording to a model, so it saves BRIEF.md beside the recording and stamps
// meta.briefAt, which is what reveals the paste box on the session page. An
// operator who exported with curl comes back to a page ready for the answer.
app.get('/api/sessions/:id/brief', async (req, reply) => {
  const { id } = req.params as { id: string };
  return sendBrief(id, reply, undefined, (req.query ?? {}) as { budget?: unknown; probe?: unknown });
});

app.post('/api/sessions/:id/brief', async (req, reply) => {
  const { id } = req.params as { id: string };
  if (typeof req.body === 'string') return sendBrief(id, reply, req.body, {});
  const { goal, budget, probe } = (req.body ?? {}) as { goal?: unknown; budget?: unknown; probe?: unknown };
  return sendBrief(id, reply, typeof goal === 'string' ? goal : undefined, { budget, probe });
});

// The model's answer, pasted back: the JSON block the brief asked for (or the
// whole reply around it, or a bare script). Verified exactly as the API loop
// verifies a write_script; a pass becomes the session's automation, a fail
// is a 422 carrying the same rejection text the loop would feed the model,
// so the operator pastes it straight back. Both outcomes go in the log.
// Verification runs the script for up to two minutes, so the session is held
// for the duration: the import route, Adjust and Maximum Effort Mode all
// write the same spec.json and automation.mjs, and the last writer would win.
const imports = new Set<string>();
app.post('/api/sessions/:id/import', async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!getMeta(id)) return reply.code(404).send({ error: 'unknown session' });
  const clash = imports.has(id) ? IMPORT_RUNNING
    : repairs.has(id) ? 'a repair is running for this session — wait for it to finish'
    : efforts.has(id) ? 'Maximum Effort Mode is running for this session — wait for it to finish'
    : undefined;
  if (clash) return reply.code(409).send({ error: clash });
  const ev = loadEvidence(id);
  if ('error' in ev) return reply.code(409).send({ error: ev.error });
  const body = req.body ?? {};
  const given = typeof body === 'object' ? (body as { text?: unknown }).text : undefined;
  if (given !== undefined && typeof given !== 'string') return reply.code(422).send({ error: 'REJECTED: "text" must be a string carrying the model\'s reply' });
  // A text/plain body is the reply itself; a JSON body carries it in "text",
  // or is the answer block on its own.
  const answer = typeof body === 'string' ? body : typeof given === 'string' ? given : JSON.stringify(body);
  const candidate = parseCandidate(answer, ev);
  if ('error' in candidate) return reply.code(422).send({ error: `REJECTED: ${candidate.error}` });
  const params = candidate.parameters.map((p) => `${p.name}="${p.example}"`).join(', ') || 'none';
  appendLog(id, { kind: 'info', text: `Answer from an external model imported for verification${candidate.title ? `: "${candidate.title}"` : ''}; parameters ${params}.`, t: Date.now() });
  imports.add(id);
  try {
    const v = await checkCandidate(candidate, ev, cachedReadToken);
    if (!v.ok) {
      appendLog(id, { kind: 'fail', text: v.reason, t: Date.now() });
      return reply.code(422).send({ error: `REJECTED: ${v.reason}` });
    }
    const { columns } = saveCandidate(ev, candidate, v.run, { model: 'external', mode: 'import' }, v.robots);
    for (const r of v.robots) appendLog(id, { kind: 'info', text: r, t: Date.now() });
    const text = `Automation ${candidate.title ? `saved as "${candidate.title}"` : 'saved'} — ${v.note}; ${v.run.rows.length} row(s) with columns ${columns.join(', ')}; parameters ${candidate.parameters.map((p) => p.name).join(', ') || 'none'}; hosts ${v.run.hosts.join(', ') || 'none'}.`;
    appendLog(id, { kind: 'saved', text, t: Date.now() });
    return { ok: true, text, title: candidate.title, note: v.note, rows: v.run.rows.length, columns, parameters: candidate.parameters.map((p) => p.name), hosts: v.run.hosts, robots: v.robots };
  } finally {
    imports.delete(id);
  }
});

// Tokens are cached per origin so bulk runs pay the browser-launch cost once,
// not per row. Sijilat's anonymous token lives much longer than ten minutes.
const tokenCache = new Map<string, { tok: Bearer; at: number }>();
async function cachedReadToken(loadUrl: string): Promise<Bearer | undefined> {
  const hit = tokenCache.get(loadUrl);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.tok;
  const tok = await readBearerViaBrowser(loadUrl);
  if (tok) tokenCache.set(loadUrl, { tok, at: Date.now() });
  return tok;
}

const runDeps = (id: string): RunDeps => ({
  readToken: cachedReadToken,
  extractPage: extractPageViaBrowser,
  runScript: async (file, inputs, hosts) => {
    const source = getScript(id, file);
    if (source === undefined) return { error: `session script ${file} is missing`, hosts: [], log: [] };
    return runScript(source, { inputs, hosts, readToken: cachedReadToken });
  },
});

app.post('/api/sessions/:id/run', async (req, reply) => {
  const { id } = req.params as { id: string };
  const spec = (await freshSpec(id)) as Parameters<typeof run>[0] | undefined;
  if (!spec) return reply.code(404).send({ error: 'no spec for this session' });
  const { params } = (req.body ?? {}) as { params?: Record<string, string> };
  return run(spec, params ?? {}, runDeps(id));
});

app.get('/', async (req, reply) => {
  reply.type('text/html');
  return renderList(listSessions().map((m) => ({ ...m, st: status(m) })), req.headers.host ?? '');
});

app.get('/session/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const meta = getMeta(id);
  if (!meta) return reply.code(404).type('text/html').send('<p>unknown session — <a href="/">back</a></p>');
  const events = readEvents(id);
  const a = analyse({ meta: { session: id, status: status(meta) }, events });
  reply.type('text/html');
  const spec = await freshSpec(id) as { steps?: { type: string; file?: string }[] } | undefined;
  const scriptStep = spec?.steps?.find((s) => s.type === 'script');
  const sessions = listSessions().map((m) => ({ ...m, st: status(m) }));
  return renderDetail(getMeta(id) ?? meta, status(meta), a, events, spec, scriptStep?.file ? getScript(id, scriptStep.file) : undefined, readLog(id), sessions, req.headers.host ?? '');
});

const port = Number(process.env.PORT ?? 4823);
app.listen({ port, host: '127.0.0.1' }).then(() => {
  console.log(`recorder backend on http://127.0.0.1:${port}`);
});
