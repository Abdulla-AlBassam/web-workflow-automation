import Fastify from 'fastify';
import { appendEvents, createSession, getMeta, listSessions, readEvents, saveMeta, status } from './store.js';
import { sanitise } from './redact.js';

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

// Human-readable session list; tokens and rules in docs/ui.md.
app.get('/', async (_req, reply) => {
  const rows = listSessions().map((m) => {
    const st = status(m);
    return `<tr>
      <td><a href="/api/sessions/${m.session}/export">${m.session}</a></td>
      <td><span class="pill pill-${st}">${st}</span></td>
      <td class="num">${m.count}</td>
      <td class="num">${m.dropped}</td>
      <td class="num">${new Date(m.startedAt).toLocaleString('en-GB')}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="5" class="empty">No sessions recorded yet.</td></tr>';

  reply.type('text/html');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Recorder sessions</title><style>
    :root { --bg:#F6F7F9; --surface:#fff; --border:#E3E6EA; --text:#1A202C; --muted:#5B6472; --accent:#2563EB; --rec:#D64545; --ok:#1B8A5A; }
    * { box-sizing:border-box; margin:0; }
    body { background:var(--bg); color:var(--text); font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif; padding:24px; }
    main { max-width:720px; margin:0 auto; background:var(--surface); border-radius:12px; padding:20px; box-shadow:0 0 0 1px rgb(20 24 32/.06),0 2px 6px rgb(20 24 32/.05); }
    h1 { font-size:15px; font-weight:600; margin-bottom:12px; letter-spacing:-0.01em; }
    table { width:100%; border-collapse:collapse; }
    th { text-align:left; font-size:12px; font-weight:500; color:var(--muted); padding:6px 8px; border-bottom:1px solid var(--border); }
    td { padding:8px; border-bottom:1px solid var(--border); }
    tr:last-child td { border-bottom:none; }
    td.num { font-variant-numeric:tabular-nums; }
    a { color:var(--accent); text-decoration:none; } a:hover { text-decoration:underline; }
    .pill { font-size:12px; padding:2px 8px; border-radius:999px; }
    .pill-complete { background:#E7F3ED; color:var(--ok); }
    .pill-recording { background:#FBEAEA; color:var(--rec); }
    .pill-interrupted { background:#FDF3E3; color:#9A6700; }
    .empty { color:var(--muted); text-align:center; padding:24px; }
  </style></head><body><main>
    <h1>Recorder sessions</h1>
    <table><thead><tr><th>Session</th><th>Status</th><th>Events</th><th>Dropped</th><th>Started</th></tr></thead>
    <tbody>${rows}</tbody></table>
  </main></body></html>`;
});

const port = Number(process.env.PORT ?? 4823);
app.listen({ port, host: '127.0.0.1' }).then(() => {
  console.log(`recorder backend on http://127.0.0.1:${port}`);
});
