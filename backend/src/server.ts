import Fastify from 'fastify';
import { appendEvents, createSession, getMeta, getSpec, listSessions, readEvents, saveMeta, saveSpec, status } from './store.js';
import { sanitise } from './redact.js';
import { analyse } from './analyse.js';
import { toSpec } from './generate.js';
import { probeAuth } from './probe.js';
import { renderDetail, renderList } from './views.js';

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
  return { ok: true };
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
  const a = loadAnalysis(id);
  if (!a) return reply.code(404).send({ error: 'unknown session' });
  const { name, origin, loadUrl, probe } = req.body as { name?: string; origin?: string; loadUrl?: string; probe?: boolean };
  if (!name || !origin || !loadUrl) return reply.code(400).send({ error: 'name, origin and loadUrl required' });
  // Probe is opt-in: it makes one unauthenticated call to the outcome endpoint.
  const probeStatus = probe && a.outcome ? await probeAuth(a.outcome).catch(() => undefined) : undefined;
  try {
    const spec = toSpec(a, { name, origin, loadUrl, probeStatus });
    saveSpec(id, spec);
    return spec;
  } catch (e) {
    return reply.code(422).send({ error: (e as Error).message });
  }
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
  return renderDetail(meta, status(meta), a, events, getSpec(id));
});

const port = Number(process.env.PORT ?? 4823);
app.listen({ port, host: '127.0.0.1' }).then(() => {
  console.log(`recorder backend on http://127.0.0.1:${port}`);
});
