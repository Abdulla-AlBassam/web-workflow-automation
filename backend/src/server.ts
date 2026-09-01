import Fastify from 'fastify';
import { appendEvents, createSession, getMeta, getSpec, listSessions, readEvents, saveMeta, saveSpec, status } from './store.js';
import { sanitise } from './redact.js';
import { analyse } from './analyse.js';
import { SPEC_VERSION, toSpec } from './generate.js';
import { probeAuth } from './probe.js';
import { renderDetail, renderList } from './views.js';
import { run } from '../../runner/src/run.js';
import { readBearerViaBrowser, type Bearer } from '../../runner/src/browser-token.js';

const app = Fastify({ logger: { level: 'warn' } });

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
    if (clean) kept.push(clean);
    else meta.dropped++;
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
  const a = loadAnalysis(id);
  if (!a?.outcome) return undefined;
  const page = readEvents(id).find((e) => e.kind === 'page' && typeof e.url === 'string');
  const loadUrl = (page?.url as string) ?? a.outcome.url;
  // The auth probe targets the call the run actually depends on: the chained
  // detail call when there is one, the search call otherwise.
  const probeStatus = await probeAuth(a.chain?.call ?? a.outcome).catch(() => undefined);
  const spec = toSpec(a, { name: id, origin: new URL(loadUrl).origin, loadUrl, probeStatus });
  saveSpec(id, spec);
  return spec;
}

// A spec saved by an older generator is regenerated before use, so sessions
// recorded before a feature (e.g. pagination) still benefit from it.
async function freshSpec(id: string) {
  const saved = getSpec(id) as { version?: number } | undefined;
  if (saved?.version === SPEC_VERSION) return saved;
  const regenerated = await autoSpec(id).catch(() => undefined);
  return regenerated ?? saved;
}

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
    if (!spec) return reply.code(422).send({ error: 'no parameterised outcome call identified' });
    return spec;
  } catch (e) {
    return reply.code(422).send({ error: (e as Error).message });
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

app.post('/api/sessions/:id/run', async (req, reply) => {
  const { id } = req.params as { id: string };
  const spec = (await freshSpec(id)) as Parameters<typeof run>[0] | undefined;
  if (!spec) return reply.code(404).send({ error: 'no spec for this session' });
  const { params } = (req.body ?? {}) as { params?: Record<string, string> };
  return run(spec, params ?? {}, { readToken: cachedReadToken });
});

app.get('/', async (_req, reply) => {
  reply.type('text/html');
  return renderList(listSessions().map((m) => ({ ...m, st: status(m) })));
});

app.get('/session/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const meta = getMeta(id);
  if (!meta) return reply.code(404).type('text/html').send('<p>unknown session — <a href="/">back</a></p>');
  const events = readEvents(id);
  const a = analyse({ meta: { session: id, status: status(meta) }, events });
  reply.type('text/html');
  return renderDetail(meta, status(meta), a, events, await freshSpec(id));
});

const port = Number(process.env.PORT ?? 4823);
app.listen({ port, host: '127.0.0.1' }).then(() => {
  console.log(`recorder backend on http://127.0.0.1:${port}`);
});
