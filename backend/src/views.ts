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
.runrow { display:flex; gap:10px; align-items:flex-end; flex-wrap:wrap; }
.runrow label { display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--muted); }
.runrow input { font:inherit; font-variant-numeric:tabular-nums; border:1px solid var(--border); border-radius:8px; padding:8px 10px; min-width:200px; transition:border-color 150ms ease-out; }
.runrow input:hover { border-color:#C9CED6; }
.runrow input:focus-visible { outline:2px solid var(--accent); outline-offset:2px; border-color:var(--accent); }
textarea { font:inherit; width:100%; border:1px solid var(--border); border-radius:8px; padding:8px 10px; resize:vertical; transition:border-color 150ms ease-out; }
textarea:hover { border-color:#C9CED6; }
textarea:focus-visible { outline:2px solid var(--accent); outline-offset:2px; border-color:var(--accent); }
.btn { font:inherit; font-weight:600; border:none; border-radius:8px; padding:9px 16px; min-height:36px; cursor:pointer; background:var(--accent); color:#fff; transition:background-color 150ms ease-out, transform 100ms ease-out, opacity 150ms ease-out; }
.btn:hover:not(:disabled) { background:#1D4FD7; }
.btn:active { transform:scale(0.96); }
.btn:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.btn:disabled { opacity:0.5; cursor:default; transform:none; }
.run-steps { list-style:none; margin-top:12px; display:flex; flex-direction:column; gap:4px; font-size:12px; }
.ok-note { font-size:12px; color:var(--ok); background:#E7F3ED; border-radius:8px; padding:8px 10px; margin-top:10px; }
.fail-note { font-size:12px; color:var(--rec); background:#FBEAEA; border-radius:8px; padding:8px 10px; margin-top:10px; }
.table-wrap { overflow:auto; max-height:440px; margin-top:10px; }
.table-wrap thead th { position:sticky; top:0; background:var(--surface); }
.table-wrap table { width:max-content; min-width:100%; }
.table-wrap th, .table-wrap td { white-space:nowrap; max-width:320px; overflow:hidden; text-overflow:ellipsis; }
details.spec-json { margin-top:12px; } details.spec-json summary { font-size:12px; color:var(--muted); cursor:pointer; }
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
  if (kind === 'action' && e.action === 'mark') {
    body = `<span class="mark">“${esc(String(e.text ?? '').slice(0, 80))}”</span> <span class="sub">marked as wanted data</span>`;
  } else if (kind === 'action') {
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
  // The operator's story, not the raw stream: keep actions, navigation, the
  // outcome calls (search, and the chained detail when present) and lifecycle
  // markers; drop the dropdown-population noise.
  const keepUrls = new Set([a.outcome?.url, a.chain?.call.url].filter(Boolean));
  const shown = events.filter((e) =>
    e.kind !== 'net' && e.kind !== 'net_meta' ? true : keepUrls.has(e.url as string));
  const timeline = `<ul class="tl">${shown.map(timelineRow).join('')}</ul>`;

  const outcome = a.outcome
    ? `<p class="sub">Outcome call: <span class="mono">${esc(a.outcome.method)} ${esc(url(a.outcome.url))}</span>, carrying the typed value <span class="mark mono">${esc(a.outcome.matches[0]?.value)}</span> at <span class="mono">${esc(a.outcome.matches[0]?.path)}</span>. ${esc(a.outcome.resultShape ?? '')}.</p>`
      + (a.chain
        ? `<p class="sub" style="margin-top:4px">Chained: the value at <span class="mono">${esc(a.chain.linkPath)}</span> in its response feeds <span class="mono">${esc(a.chain.call.method)} ${esc(url(a.chain.call.url))}</span>, the true outcome — the run re-resolves that link for every new input.</p>`
        : '')
      + (a.pageChain
        ? `<p class="sub" style="margin-top:4px">Chained to a page: the value at <span class="mono">${esc(a.pageChain.linkPath)}</span> in its response feeds <span class="mono">${esc(url(a.pageChain.url))}</span>, where your marked data is rendered — a browser step reads those elements on every run.</p>`
        : '')
    : `<p class="note">${esc(a.notes.join(' ') || 'No parameterised outcome call identified.')}</p>`;

  const callRows = a.calls.map((c) => `<tr>
    <td class="mono">${esc(c.method)} ${esc(url(c.url))}</td>
    <td class="num">${esc(c.status)}</td>
    <td>${c.matches.length ? `<span class="mark mono">${esc(c.matches[0].path)}</span>` : '<span class="sub">–</span>'}</td>
    <td class="sub">${esc(c.resultShape ?? '')}</td>
  </tr>`).join('');

  const specCard = spec ? renderSpec(spec, meta.session, a.marks.length) : `<div class="card"><h2>Automation</h2>
    <p class="note">No automation could be generated from this recording${a.notes.length ? `: ${esc(a.notes.join(' '))}` : '.'}</p></div>`;

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

function renderSpec(spec: any, session: string, marksCount = 0): string {
  const flow = spec.steps.map((s: any) =>
    `<span class="step step-${s.type.startsWith('browser-') ? 'token' : 'request'}">${esc(s.id)}<span class="sub"> · ${esc(s.type)}</span></span>`
  ).join('<span class="arrow">→</span>');
  const reasoned = spec.steps.filter((s: any) => s.reason);
  const inputs = spec.parameters.map((p: any) =>
    `<label>${esc(p.name)}<input id="param-${esc(p.name)}" value="${esc(p.example)}" spellcheck="false" autocomplete="off"></label>`
  ).join('');

  return `<div class="card">
    <h2>Generated automation <span class="sub">— best way to reach the outcome</span></h2>
    <div class="flow">${flow}</div>
    ${reasoned.length
      ? reasoned.map((s: any) => `<p class="note">${esc(s.reason)}</p>`).join('')
      : '<p class="sub">Pure direct-request automation: no browser step needed.</p>'}
    <p class="sub" style="margin:10px 0 4px">Outcome gate: <span class="mono">${esc(spec.outcome.expect.path)}=${esc(spec.outcome.expect.equals)}</span>. The run stops with a reason if this check fails.</p>
    ${spec.outcome.columns?.length
      ? `<p class="sub" style="margin:4px 0">Columns from your marked selections: ${spec.outcome.columns.map((c: any) => `<span class="mono">${esc(c.name)}</span>`).join(', ')}.</p>`
      : ''}
    ${marksCount && !spec.outcome.columns?.length
      ? '<p class="note" style="margin-top:8px">Your marked text was not found in any captured API response (it may be rendered server-side), so results show all fields instead.</p>'
      : ''}
    ${marksCount && spec.outcome.columns?.length && spec.outcome.columns.length < marksCount
      ? `<p class="note" style="margin-top:8px">Only ${spec.outcome.columns.length} of ${marksCount} marked selections could be located; the rest were not found where the outcome lives.</p>`
      : ''}
    <details class="spec-json"><summary>Show the spec JSON</summary><pre>${esc(JSON.stringify(spec, null, 2))}</pre></details>
  </div>

  <div class="card">
    <h2>Run the automation</h2>
    <p class="sub" style="margin-bottom:10px">Enter a new value and run. This executes the generated steps, not your recorded clicks.</p>
    <div class="runrow">${inputs}<button id="run-btn" class="btn">Run</button></div>
    <div id="run-out"></div>
  </div>

  ${spec.parameters.length === 1 ? `<div class="card">
    <h2>Bulk run</h2>
    <p class="sub" style="margin-bottom:10px">One <span class="mono">${esc(spec.parameters[0].name)}</span> per line. Rows run one at a time with a delay between them; results aggregate into a single exportable table.</p>
    <textarea id="bulk-values" rows="4" placeholder="value one&#10;value two&#10;value three"></textarea>
    <div class="runrow" style="margin-top:10px"><button id="bulk-btn" class="btn">Run all</button><span id="bulk-status" class="sub"></span></div>
    <div id="bulk-out"></div>
  </div>` : ''}

  <script>
  (() => {
    const params = ${JSON.stringify(spec.parameters.map((p: any) => p.name))};
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

    async function runOnce(values) {
      const r = await fetch('/api/sessions/${esc(session)}/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ params: values }),
      });
      return r.json();
    }

    function download(filename, mime, content) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([content], { type: mime }));
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
    }

    // Nested rows read as [object Object] in a table and a CSV cell; flatten
    // them to dotted columns. Scalar arrays join; object arrays stay as JSON.
    function flat(row) {
      const out = {};
      const walk = (v, key) => {
        if (v && typeof v === 'object') {
          if (Array.isArray(v)) {
            if (v.every((x) => x === null || typeof x !== 'object')) out[key || 'value'] = v.join(', ');
            else out[key || 'value'] = JSON.stringify(v);
          } else {
            for (const [k, x] of Object.entries(v)) walk(x, key ? key + '.' + k : k);
          }
        } else {
          out[key || 'value'] = v;
        }
      };
      walk(row, '');
      return out;
    }

    function toCsv(rows) {
      rows = rows.map(flat);
      const cols = [];
      for (const row of rows) for (const k of Object.keys(row)) if (!cols.includes(k)) cols.push(k);
      const cell = (v) => '"' + String(v ?? '').replaceAll('"', '""') + '"';
      return [cols.map(cell).join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\\n');
    }

    function exportButtons(rows, base) {
      const wrap = document.createElement('div');
      wrap.className = 'runrow';
      wrap.style.marginTop = '10px';
      const csv = document.createElement('button');
      csv.className = 'btn'; csv.textContent = 'Download CSV';
      csv.addEventListener('click', () => download(base + '.csv', 'text/csv', toCsv(rows)));
      const json = document.createElement('button');
      json.className = 'btn'; json.textContent = 'Download JSON';
      json.addEventListener('click', () => download(base + '.json', 'application/json', JSON.stringify(rows, null, 2)));
      wrap.append(csv, json);
      return wrap;
    }

    const DISPLAY_CAP = 200;
    function rowsTable(rows, label) {
      rows = rows.map(flat);
      // Every column the export carries, scrollable sideways; cells clip via
      // CSS ellipsis so one HTML-blob field cannot swamp the table.
      const cols = [];
      for (const row of rows) for (const k of Object.keys(row)) if (!cols.includes(k)) cols.push(k);
      const caption = rows.length <= DISPLAY_CAP
        ? label + ': ' + rows.length + ' rows'
        : label + ': first ' + DISPLAY_CAP + ' of ' + rows.length + ' rows — download for the full set';
      return '<p class="sub" style="margin-top:10px">' + esc(caption) + '</p>' +
        '<div class="table-wrap"><table><thead><tr>' +
        cols.map((c) => '<th>' + esc(c) + '</th>').join('') +
        '</tr></thead><tbody>' +
        rows.slice(0, DISPLAY_CAP).map((row) => '<tr>' + cols.map((c) =>
          '<td class="sub">' + esc(String(row[c] ?? '').slice(0, 300)) + '</td>').join('') + '</tr>').join('') +
        '</tbody></table></div>';
    }

    function renderResult(res, out, base) {
      const steps = (res.steps ?? []).map((s) =>
        '<li>✓ <span class="mono">' + esc(s.id) + '</span> <span class="sub">' + esc(s.detail) + '</span></li>').join('');
      let html = '<ul class="run-steps">' + steps + '</ul>';
      let rows = [];

      if (!res.ok) {
        html += '<p class="fail-note">Stopped — ' + esc(res.stoppedReason) + '</p>';
      } else {
        html += '<p class="ok-note">Outcome verified (' + esc(res.outcome.expected) + ')</p>';
        const total = res.extracted?.total;
        for (const [name, v] of Object.entries(res.extracted ?? {})) {
          if (name === 'total') continue;
          if (v && typeof v === 'object' && Array.isArray(v.rows)) {
            rows = v.rows;
            const capped = total && Number(total) > rows.length;
            html += rowsTable(rows, capped ? name + ' (' + total + ' total, page cap reached)' : name);
          } else {
            html += '<p class="sub" style="margin-top:6px">' + esc(name) + ': <span class="mono">' + esc(v) + '</span></p>';
          }
        }
      }
      out.innerHTML = html;
      if (rows.length) out.append(exportButtons(rows, base));
    }

    const btn = document.getElementById('run-btn');
    const out = document.getElementById('run-out');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      out.innerHTML = '<p class="sub" style="margin-top:10px">Running — executing the generated steps…</p>';
      const values = Object.fromEntries(params.map((p) => [p, document.getElementById('param-' + p).value.trim()]));
      try {
        renderResult(await runOnce(values), out, 'run-' + Object.values(values)[0]);
      } catch (e) {
        out.innerHTML = '<p class="fail-note">Could not reach the local backend: ' + esc(e.message) + '</p>';
      }
      btn.disabled = false;
    });

    const bulkBtn = document.getElementById('bulk-btn');
    if (bulkBtn) bulkBtn.addEventListener('click', async () => {
      const status = document.getElementById('bulk-status');
      const bulkOut = document.getElementById('bulk-out');
      const values = document.getElementById('bulk-values').value
        .split('\\n').map((v) => v.trim()).filter(Boolean).slice(0, 50);
      if (!values.length) { status.textContent = 'Nothing to run.'; return; }
      bulkBtn.disabled = true;
      bulkOut.innerHTML = '';
      const aggregated = [];
      const perRow = [];
      let failed = 0;
      for (let i = 0; i < values.length; i++) {
        status.textContent = 'Running ' + (i + 1) + ' of ' + values.length + ': ' + values[i];
        try {
          const res = await runOnce({ [params[0]]: values[i] });
          const rows = res.ok ? (res.extracted?.records?.rows ?? []) : [];
          if (res.ok) {
            for (const row of rows) aggregated.push({ input: values[i], ...row });
            perRow.push('<li>✓ <span class="mono">' + esc(values[i]) + '</span> <span class="sub">' + rows.length + ' rows</span></li>');
          } else {
            failed++;
            perRow.push('<li>✗ <span class="mono">' + esc(values[i]) + '</span> <span class="sub">' + esc(res.stoppedReason) + '</span></li>');
          }
        } catch (e) {
          failed++;
          perRow.push('<li>✗ <span class="mono">' + esc(values[i]) + '</span> <span class="sub">' + esc(e.message) + '</span></li>');
        }
        bulkOut.innerHTML = '<ul class="run-steps">' + perRow.join('') + '</ul>';
        if (i < values.length - 1) await new Promise((r) => setTimeout(r, 500));
      }
      status.textContent = 'Done: ' + values.length + ' inputs, ' + aggregated.length + ' rows' + (failed ? ', ' + failed + ' failed' : '');
      if (aggregated.length) {
        bulkOut.innerHTML += rowsTable(aggregated, 'aggregated');
        bulkOut.append(exportButtons(aggregated, 'bulk-export'));
      }
      bulkBtn.disabled = false;
    });
  })();
  </script>`;
}
