// Server-rendered pages for the operator. Tokens and rules: docs/ui.md.
import type { Analysis } from './analyse.js';
import type { Meta } from './store.js';

const CSS = `
:root { --bg:#F6F7F9; --surface:#fff; --border:#E3E6EA; --text:#1A202C; --muted:#5B6472; --accent:#2563EB; --rec:#D64545; --ok:#1B8A5A; --warn:#9A6700; }
* { box-sizing:border-box; margin:0; }
body { background:var(--bg); color:var(--text); font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif; padding:24px; }
main { max-width:820px; margin:0 auto; display:flex; flex-direction:column; gap:16px; }
.card { background:var(--surface); border-radius:12px; padding:20px; box-shadow:0 0 0 1px rgb(20 24 32/.06),0 2px 6px rgb(20 24 32/.05); }
h1 { font-size:15px; font-weight:600; letter-spacing:-0.01em; }
h2 { font-size:13px; font-weight:600; margin-bottom:12px; color:var(--text); }
.sub { font-size:12px; color:var(--muted); }
a { color:var(--accent); text-decoration:none; } a:hover { text-decoration:underline; }
table { width:100%; border-collapse:collapse; }
th { text-align:left; font-size:12px; font-weight:500; color:var(--muted); padding:6px 8px; border-bottom:1px solid var(--border); }
td { padding:8px; border-bottom:1px solid var(--border); vertical-align:top; }
tr:last-child td { border-bottom:none; }
td.num, .num { font-variant-numeric:tabular-nums; }
code, .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-variant-numeric:tabular-nums; }
.pill { font-size:12px; padding:2px 8px; border-radius:999px; white-space:nowrap; }
.pill-complete { background:#E7F3ED; color:var(--ok); }
.pill-recording { background:#FBEAEA; color:var(--rec); }
.pill-interrupted { background:#FDF3E3; color:var(--warn); }
.empty { color:var(--muted); text-align:center; padding:24px; }
.head-row { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.kv { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin-top:12px; }
.kv .box { background:var(--bg); border-radius:8px; padding:8px 10px; }
.kv dt { font-size:12px; color:var(--muted); }
.kv dd { font-size:15px; font-weight:600; }
.tl { list-style:none; display:flex; flex-direction:column; }
.tl li { display:grid; grid-template-columns:88px 1fr; gap:10px; padding:7px 0; border-bottom:1px solid var(--border); }
.tl li:last-child { border-bottom:none; }
.tag { font-size:11px; font-weight:600; padding:2px 7px; border-radius:6px; align-self:start; text-align:center; }
.tag-action { background:#EAF0FE; color:var(--accent); }
.tag-net { background:#EAF7F0; color:var(--ok); }
.tag-page, .tag-nav { background:var(--bg); color:var(--muted); }
.tag-session_start, .tag-session_stop { background:#F2ECFB; color:#6B46C1; }
.tag-net_meta { background:var(--bg); color:var(--muted); }
.tl .body { min-width:0; word-break:break-word; }
.tl .body .mono { font-size:12px; }
.mark { background:#FEF6D8; padding:0 3px; border-radius:3px; }
.flow { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:12px; }
.step { border:1px solid var(--border); border-radius:8px; padding:8px 12px; font-size:12px; }
.step-request { border-color:#BBD1FB; background:#F5F9FF; }
.step-token { border-color:#E7DBC2; background:#FFFBF2; }
.arrow { color:var(--muted); }
.note { font-size:12px; color:var(--warn); background:#FDF3E3; border-radius:8px; padding:8px 10px; }
pre { background:#0F1420; color:#E6EDF3; border-radius:8px; padding:12px; overflow:auto; font-size:12px; line-height:1.5; }
.crumb { font-size:12px; color:var(--muted); margin-bottom:2px; }
`;

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${CSS}</style></head><body><main>${body}</main></body></html>`;
}

export function renderList(sessions: (Meta & { st: string })[]): string {
  const rows = sessions.map((m) => `<tr>
    <td><a href="/session/${esc(m.session)}">${esc(m.session)}</a></td>
    <td><span class="pill pill-${m.st}">${m.st}</span></td>
    <td class="num">${m.count}</td>
    <td class="num">${m.dropped}</td>
    <td class="num">${new Date(m.startedAt).toLocaleString('en-GB')}</td>
  </tr>`).join('') || '<tr><td colspan="5" class="empty">No sessions recorded yet.</td></tr>';
  return shell('Recorder sessions', `<div class="card">
    <h1>Recorder sessions</h1>
    <table style="margin-top:12px"><thead><tr><th>Session</th><th>Status</th><th>Events</th><th>Dropped</th><th>Started</th></tr></thead>
    <tbody>${rows}</tbody></table>
  </div>`);
}

function url(u: string): string {
  try { const x = new URL(u); return x.pathname.split('/').slice(-1)[0] || x.hostname; } catch { return u; }
}

function timelineRow(e: Record<string, unknown>): string {
  const kind = String(e.kind);
  const tag = `<span class="tag tag-${kind}">${kind === 'action' ? esc(e.action) : kind.replace('_', ' ')}</span>`;
  let body = '';
  if (kind === 'action') {
    const t = e.target as any;
    const val = e.value !== undefined ? ` = <span class="mono">${esc(e.value)}</span>` : '';
    body = `<span class="mono">${esc(t?.id ? '#' + t.id : t?.selector ?? '')}</span>${val}`;
  } else if (kind === 'net' || kind === 'net_meta') {
    body = `<span class="mono">${esc(e.method)} ${esc(url(e.url as string))}</span> <span class="sub">→ ${esc(e.status)}</span>`;
  } else if (kind === 'page' || kind === 'nav') {
    body = `<span class="mono">${esc(e.url)}</span>${e.lang ? ` <span class="sub">(${esc(e.lang)})</span>` : ''}`;
  } else {
    body = `<span class="sub">${kind.replace('_', ' ')}</span>`;
  }
  return `<li><span>${tag}</span><span class="body">${body}</span></li>`;
}

export function renderDetail(meta: Meta, st: string, a: Analysis, events: Record<string, unknown>[], spec: any | undefined): string {
  const outcomeUrl = a.outcome?.url;
  // The operator's story, not the raw stream: keep actions, navigation, the
  // outcome call and lifecycle markers; drop the dropdown-population noise.
  const shown = events.filter((e) =>
    e.kind !== 'net' && e.kind !== 'net_meta' ? true : e.url === outcomeUrl);
  const timeline = `<ul class="tl">${shown.map(timelineRow).join('')}</ul>`;

  const outcome = a.outcome
    ? `<p class="sub">Outcome call: <span class="mono">${esc(a.outcome.method)} ${esc(url(a.outcome.url))}</span>, carrying the typed value <span class="mark mono">${esc(a.outcome.matches[0]?.value)}</span> at <span class="mono">${esc(a.outcome.matches[0]?.path)}</span>. ${esc(a.outcome.resultShape ?? '')}.</p>`
    : `<p class="note">${esc(a.notes.join(' ') || 'No parameterised outcome call identified.')}</p>`;

  const callRows = a.calls.map((c) => `<tr>
    <td class="mono">${esc(c.method)} ${esc(url(c.url))}</td>
    <td class="num">${esc(c.status)}</td>
    <td>${c.matches.length ? `<span class="mark mono">${esc(c.matches[0].path)}</span>` : '<span class="sub">–</span>'}</td>
    <td class="sub">${esc(c.resultShape ?? '')}</td>
  </tr>`).join('');

  const specCard = spec ? renderSpec(spec) : `<div class="card"><h2>Generated spec</h2>
    <p class="sub">Not generated yet. Create it with:</p>
    <pre>curl -s -X POST 127.0.0.1:4823/api/sessions/${esc(meta.session)}/spec \\
  -H 'content-type: application/json' \\
  -d '{"name":"${esc(meta.session)}","origin":"https://www.sijilat.bh","loadUrl":"https://www.sijilat.bh/public-search-cr/search-cr-2.aspx","probe":true}'</pre></div>`;

  return shell(`Session ${meta.session}`, `
    <div class="card">
      <div class="crumb"><a href="/">← all sessions</a></div>
      <div class="head-row">
        <h1>${esc(meta.session)}</h1>
        <span class="pill pill-${st}">${st}</span>
      </div>
      <dl class="kv">
        <div class="box"><dt>Events</dt><dd class="num">${meta.count}</dd></div>
        <div class="box"><dt>Dropped</dt><dd class="num">${meta.dropped}</dd></div>
        <div class="box"><dt>Language</dt><dd>${esc(a.language)}</dd></div>
        <div class="box"><dt>Inputs</dt><dd class="num">${a.inputs.length}</dd></div>
      </dl>
      ${st === 'interrupted' ? '<p class="note" style="margin-top:12px">Interrupted session: reviewable evidence only, not eligible for automation.</p>' : ''}
    </div>

    <div class="card"><h2>Timeline</h2>${timeline}</div>

    <div class="card">
      <h2>Analysis</h2>
      ${outcome}
      <table style="margin-top:12px"><thead><tr><th>Same-site call</th><th>Status</th><th>Carries input</th><th>Response</th></tr></thead>
      <tbody>${callRows}</tbody></table>
    </div>

    ${specCard}`);
}

function renderSpec(spec: any): string {
  const flow = spec.steps.map((s: any) =>
    `<span class="step step-${s.type === 'browser-token' ? 'token' : 'request'}">${esc(s.id)}<span class="sub"> · ${esc(s.type)}</span></span>`
  ).join('<span class="arrow">→</span>');
  const tokenNote = spec.steps.find((s: any) => s.type === 'browser-token');
  return `<div class="card">
    <h2>Generated spec <span class="sub">— best way to automate the outcome</span></h2>
    <div class="flow">${flow}</div>
    ${tokenNote ? `<p class="note">${esc(tokenNote.reason)}</p>` : '<p class="sub">Pure direct-request automation: no browser step needed.</p>'}
    <p class="sub" style="margin:10px 0 4px">Parameter <span class="mono">${esc(spec.parameters[0]?.name)}</span> (example <span class="mono">${esc(spec.parameters[0]?.example)}</span>) → replayable with a new value. Outcome gate: <span class="mono">${esc(spec.outcome.expect.path)}=${esc(spec.outcome.expect.equals)}</span>.</p>
    <pre>${esc(JSON.stringify(spec, null, 2))}</pre>
  </div>`;
}
