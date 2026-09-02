// Server-rendered pages for the operator. Tokens and rules: docs/ui.md.
import type { Analysis } from './analyse.js';
import type { Meta } from './store.js';

const CSS = `
:root {
  color-scheme: dark;
  --page:#17181a; --surface:#232427; --inset:#1f2022; --hover:#2a2b2e; --hover-2:#313236; --field:#2b2c2f;
  --ink:#f2f3f4; --ink-2:#a5a8ad; --ink-3:#6c6f75;
  --line:#2e3033; --line-strong:#3a3c40;
  --green:#3cbb72; --green-tint:rgb(60 187 114/.14);
  --red:#ee5c61; --red-tint:rgb(238 92 97/.14);
  --amber:#f68f3c; --amber-tint:rgb(246 143 60/.14);
  --violet:#a78bfa; --violet-tint:rgb(167 139 250/.14);
  --console:#111214;
  --ring:0 0 0 1px rgb(255 255 255/.09);
  --shadow-card:0 0 0 1px rgb(255 255 255/.09),0 1px 2px rgb(0 0 0/.2),0 2px 6px rgb(0 0 0/.2);
  --shadow-overlay:0 0 0 1px rgb(255 255 255/.15),0 8px 28px rgb(0 0 0/.4);
  --ease:cubic-bezier(.23,1,.32,1);
}
* { box-sizing:border-box; margin:0; scrollbar-width:thin; scrollbar-color:var(--line-strong) transparent; }
html, body { height:100%; }
body { display:flex; background:var(--page); color:var(--ink); font:13px/1.5 -apple-system,system-ui,"Segoe UI",sans-serif; }
a { color:var(--ink-2); text-decoration:none; } a:hover { color:var(--ink); text-decoration:underline; }
h1 { font-size:15px; font-weight:600; letter-spacing:-0.02em; }
h2 { font-size:13px; font-weight:600; letter-spacing:-0.01em; }
.sub { font-size:12px; color:var(--ink-2); text-wrap:pretty; }
.dim { color:var(--ink-3); }
code, .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-variant-numeric:tabular-nums; }
td.num, .num { font-variant-numeric:tabular-nums; }

/* ---- shell ---- */
.side { width:264px; flex:none; display:flex; flex-direction:column; border-right:1px solid var(--line); background:var(--page); }
.side-head { display:flex; align-items:center; gap:8px; padding:16px 16px 10px; font-size:13px; font-weight:600; letter-spacing:-0.01em; }
.side-head svg { color:var(--ink-2); }
.side-label { padding:10px 16px 6px; font-size:11px; font-weight:600; letter-spacing:.05em; text-transform:uppercase; color:var(--ink-3); }
.side-list { flex:1; overflow-y:auto; padding:0 8px 8px; display:flex; flex-direction:column; gap:1px; }
.side-item { display:grid; grid-template-columns:8px 1fr; grid-template-rows:auto auto; column-gap:9px; align-items:center; padding:7px 10px; border-radius:8px; color:var(--ink-2); }
.side-item:hover { background:var(--hover); color:var(--ink); text-decoration:none; }
.side-item.on { background:var(--hover); color:var(--ink); box-shadow:var(--ring); }
.side-item .dot { grid-row:1; }
.side-name { grid-row:1; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.side-meta { grid-column:2; grid-row:2; font-size:11px; color:var(--ink-3); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.side-empty { padding:8px 10px; font-size:12px; color:var(--ink-3); }
.side-foot { border-top:1px solid var(--line); padding:10px 16px; font-size:11px; color:var(--ink-3); }
.main { flex:1; overflow-y:auto; min-width:0; }
.wrap { max-width:860px; margin:0 auto; padding:24px 28px 48px; display:flex; flex-direction:column; gap:12px; }

/* ---- cards, folds ---- */
.card { background:var(--surface); border-radius:10px; padding:16px 18px; box-shadow:var(--shadow-card); }
.card-head { display:flex; align-items:center; gap:8px; }
.card-head .right { margin-left:auto; display:flex; gap:8px; align-items:center; }
details.fold { background:var(--surface); border-radius:10px; box-shadow:var(--shadow-card); }
.fold > summary { list-style:none; display:flex; align-items:center; gap:10px; padding:11px 16px; cursor:pointer; user-select:none; border-radius:10px; font-weight:600; font-size:13px; }
.fold > summary::-webkit-details-marker { display:none; }
.fold > summary:hover { background:var(--hover); }
details[open].fold > summary { border-radius:10px 10px 0 0; }
.chev { flex:none; color:var(--ink-3); transition:transform 200ms var(--ease); }
.t-ic { flex:none; color:var(--ink-3); }
details[open] > summary .chev { transform:rotate(90deg); }
.badges { margin-left:auto; display:flex; gap:6px; align-items:center; font-weight:400; }
.fold-body { border-top:1px solid var(--line); padding:14px 16px; }
details.fold-sub { background:var(--inset); border-radius:8px; box-shadow:var(--ring); margin-top:12px; }
.fold-sub > summary { padding:8px 12px; font-size:12px; font-weight:500; color:var(--ink-2); border-radius:8px; }
.fold-sub .fold-body { padding:10px 12px; }

/* ---- status ---- */
.dot { width:8px; height:8px; border-radius:50%; flex:none; display:inline-block; }
.dot-complete { background:var(--green); }
.dot-interrupted { background:var(--red); }
.dot-recording { background:var(--red); animation:dot-pulse 1.1s ease-in-out infinite; }
@keyframes dot-pulse { 0%,100% { opacity:.35; transform:scale(.8); } 50% { opacity:1; transform:scale(1); } }
.status { display:inline-flex; align-items:center; gap:6px; font-size:12px; font-weight:500; color:var(--ink-2); }
.chip { font-size:11px; font-weight:500; padding:2px 8px; border-radius:999px; background:var(--inset); color:var(--ink-2); box-shadow:0 0 0 1px var(--line); white-space:nowrap; }
.chip-ok { background:var(--green-tint); color:var(--green); box-shadow:none; }
.chip-warn { background:var(--amber-tint); color:var(--amber); box-shadow:none; }
.chip-fail { background:var(--red-tint); color:var(--red); box-shadow:none; }

/* ---- info / clarification pills ---- */
.pw { position:relative; display:inline-flex; }
.pill { width:18px; height:18px; border-radius:50%; border:none; padding:0; background:transparent; box-shadow:0 0 0 1px var(--line-strong); color:var(--ink-3); font:italic 600 11px/1 Georgia,serif; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; transition:color 150ms,background-color 150ms; }
.pill-q { font-style:normal; font-family:inherit; }
.pill:hover { color:var(--ink); background:var(--hover-2); }
.pill:focus-visible { outline:2px solid rgb(242 243 244/.35); outline-offset:2px; }
.pill-q.pill-live { color:var(--amber); box-shadow:0 0 0 1px rgb(246 143 60/.4); }
.pop { position:absolute; top:24px; left:50%; transform:translateX(-50%); width:max-content; max-width:min(340px,70vw); background:var(--hover); border-radius:10px; box-shadow:var(--shadow-overlay); padding:10px 12px; font:400 12px/1.5 -apple-system,system-ui,sans-serif; font-style:normal; color:var(--ink-2); z-index:50; text-align:left; white-space:normal; cursor:default; }
.pop p + p { margin-top:6px; }
.pop b { color:var(--ink); font-weight:600; }

/* ---- tables ---- */
table { width:100%; border-collapse:collapse; }
th { text-align:left; font-size:11px; font-weight:500; letter-spacing:.02em; color:var(--ink-3); padding:6px 8px; border-bottom:1px solid var(--line); }
td { padding:7px 8px; border-bottom:1px solid var(--line); vertical-align:middle; }
tr:last-child td { border-bottom:none; }
.table-wrap { overflow:auto; max-height:440px; margin-top:10px; border-radius:8px; box-shadow:var(--ring); }
.table-wrap thead th { position:sticky; top:0; background:var(--surface); z-index:1; }
.table-wrap table { width:max-content; min-width:100%; }
.table-wrap th, .table-wrap td { white-space:nowrap; max-width:320px; overflow:hidden; text-overflow:ellipsis; }
.thumb { height:44px; max-width:72px; object-fit:cover; border-radius:6px; display:block; background:var(--inset); }
.cell-link { color:var(--ink-2); } .cell-link:hover { color:var(--ink); }

/* ---- timeline ---- */
.tl { list-style:none; display:flex; flex-direction:column; max-height:420px; overflow-y:auto; padding:0; }
.tl li { display:grid; grid-template-columns:92px 1fr; gap:10px; padding:6px 0; border-bottom:1px solid var(--line); }
.tl li:last-child { border-bottom:none; }
.tag { font-size:11px; font-weight:600; padding:2px 7px; border-radius:6px; align-self:start; text-align:center; }
.tag-action { background:rgb(242 243 244/.09); color:var(--ink); }
.tag-net { background:var(--green-tint); color:var(--green); }
.tag-page, .tag-nav, .tag-net_meta { background:var(--inset); color:var(--ink-3); box-shadow:0 0 0 1px var(--line); }
.tag-session_start, .tag-session_stop { background:var(--violet-tint); color:var(--violet); }
.tag-snapshot { background:var(--amber-tint); color:var(--amber); }
.tl .body { min-width:0; word-break:break-word; }
.tl .body .mono { font-size:12px; }
.mark { background:rgb(246 197 60/.16); padding:0 3px; border-radius:3px; }

/* ---- automation flow ---- */
.flow { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin:12px 0; }
.step { box-shadow:0 0 0 1px var(--line-strong); background:var(--inset); border-radius:8px; padding:6px 11px; font-size:12px; font-weight:500; }
.arrow { color:var(--ink-3); }
.note { font-size:12px; color:var(--amber); background:var(--amber-tint); border-radius:8px; padding:8px 10px; }
.ok-note { font-size:12px; color:var(--green); background:var(--green-tint); border-radius:8px; padding:8px 10px; margin-top:10px; }
.fail-note { font-size:12px; color:var(--red); background:var(--red-tint); border-radius:8px; padding:8px 10px; margin-top:10px; }
pre { background:var(--console); border-radius:8px; padding:12px; overflow:auto; font-size:12px; line-height:1.5; color:#e6edf3; box-shadow:var(--ring); }
details.spec-json { margin-top:12px; }
details.spec-json summary { font-size:12px; color:var(--ink-3); cursor:pointer; }
details.spec-json summary:hover { color:var(--ink-2); }
details.spec-json pre { margin-top:8px; }

/* ---- controls ---- */
.btn { font:inherit; font-weight:600; border:none; border-radius:8px; padding:8px 14px; min-height:34px; cursor:pointer; background:var(--ink); color:#17181a; display:inline-flex; align-items:center; gap:7px; justify-content:center; transition:background-color 150ms,transform 100ms,opacity 150ms; }
.btn:hover:not(:disabled) { background:#dfe1e4; }
.btn:active:not(:disabled) { transform:scale(.96); }
.btn:focus-visible { outline:2px solid rgb(242 243 244/.35); outline-offset:2px; }
.btn:disabled { opacity:.4; cursor:default; }
.btn svg { flex:none; }
.btn-quiet { background:transparent; color:var(--ink); font-weight:500; box-shadow:0 0 0 1px var(--line-strong); }
.btn-quiet:hover:not(:disabled) { background:var(--hover); }
.icon-btn { width:26px; height:26px; border:none; border-radius:6px; padding:0; background:transparent; color:var(--ink-3); cursor:pointer; display:inline-flex; align-items:center; justify-content:center; transition:color 150ms,background-color 150ms; }
.icon-btn:hover { color:var(--ink); background:var(--hover-2); }
.icon-btn:focus-visible { outline:2px solid rgb(242 243 244/.35); outline-offset:2px; }
.seg { display:inline-flex; background:var(--inset); border-radius:8px; padding:2px; gap:2px; box-shadow:var(--ring); }
.seg-btn { border:none; background:transparent; color:var(--ink-3); padding:4px 12px; border-radius:6px; font:inherit; font-size:12px; font-weight:500; cursor:pointer; transition:color 150ms,background-color 150ms; }
.seg-btn:hover { color:var(--ink-2); }
.seg-btn.on { background:var(--hover-2); color:var(--ink); }
input[type=text], input:not([type]), textarea { font:inherit; color:var(--ink); background:var(--field); border:1px solid var(--line-strong); border-radius:8px; padding:8px 10px; transition:border-color 150ms; }
input:hover, textarea:hover { border-color:#4a4d52; }
input:focus-visible, textarea:focus-visible { outline:2px solid rgb(242 243 244/.3); outline-offset:1px; border-color:#5a5d63; }
input::placeholder, textarea::placeholder { color:var(--ink-3); }
textarea { width:100%; resize:vertical; }
textarea:disabled, input:disabled { opacity:.45; }
.runrow { display:flex; gap:10px; align-items:flex-end; flex-wrap:wrap; }
.runrow label { display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--ink-2); flex:1 1 200px; min-width:0; overflow-wrap:anywhere; }
.runrow input { font-variant-numeric:tabular-nums; width:100%; min-width:0; }
.lbl { display:block; font-size:12px; color:var(--ink-2); margin:12px 0 4px; }
.rename-input { font:inherit; font-size:15px; font-weight:600; min-width:280px; padding:4px 8px; }

/* ---- loading (pixel grid + shimmer, beautifului.dev language) ---- */
.ldr { display:inline-flex; align-items:center; gap:10px; }
.pxg { display:grid; grid-template-columns:repeat(3,4px); gap:1.5px; flex:none; }
.px { width:4px; height:4px; border-radius:1px; background:var(--ink); opacity:.15; animation:pixel-on 650ms ease-in-out infinite; }
@keyframes pixel-on { 0%,100% { opacity:.15; } 18%,42% { opacity:1; } 62% { opacity:.15; } }
.shimmer { font-size:12px; font-weight:500; background-image:linear-gradient(90deg,var(--ink-3) 35%,var(--ink) 50%,var(--ink-3) 65%); background-size:200% 100%; -webkit-background-clip:text; background-clip:text; color:transparent; animation:shimmer-text 1.4s linear infinite; }
@keyframes shimmer-text { 0% { background-position:150%; } 100% { background-position:-50%; } }
.ldr-t { font-family:ui-monospace,Menlo,monospace; font-size:11px; color:var(--ink-3); font-variant-numeric:tabular-nums; }
.ldr-row { margin-top:12px; }

/* ---- run results ---- */
.run-steps { list-style:none; margin-top:12px; display:flex; flex-direction:column; gap:4px; font-size:12px; padding:0; }
.run-steps .g-ok { color:var(--green); } .run-steps .g-fail { color:var(--red); }
.fix-block { margin-top:14px; padding-top:12px; border-top:1px solid var(--line); }
.repair-console { background:var(--console); color:#e6edf3; border-radius:8px; padding:12px 14px; margin-top:12px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; line-height:1.7; max-height:380px; overflow:auto; box-shadow:var(--ring); }
.repair-console div { white-space:pre-wrap; word-break:break-word; }
.rc-stop { margin-top:12px; }
.rc-info, .rc-done { color:#8a93a6; }
.rc-llm { color:#9ec1ff; }
.rc-try { color:#e6edf3; }
.rc-fail, .rc-error { color:#ff8a8a; }
.rc-ok, .rc-saved { color:#6bd49a; }
.rc-advice { color:#f2ce72; }

/* ---- conversation ---- */
.chat { margin-top:10px; display:flex; flex-direction:column; gap:8px; max-height:520px; overflow:auto; padding:12px; background:var(--inset); border-radius:8px; }
.msg { max-width:92%; padding:8px 12px; border-radius:10px; white-space:pre-wrap; word-break:break-word; font-size:13px; line-height:1.5; text-wrap:pretty; }
.msg-say { background:var(--surface); box-shadow:var(--ring); align-self:flex-start; }
.msg-you { background:rgb(242 243 244/.12); color:var(--ink); align-self:flex-end; }
details.msg-think { color:var(--ink-3); font-size:12px; align-self:flex-start; padding:4px 12px; }
details.msg-think summary { cursor:pointer; font-weight:600; font-size:11px; letter-spacing:.02em; text-transform:uppercase; }
details.msg-think div { white-space:pre-wrap; word-break:break-word; margin-top:4px; font-style:italic; }
.msg-status { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; color:var(--ink-3); align-self:stretch; max-width:100%; padding:2px 4px; }
.msg-status.rc-ok, .msg-status.rc-saved { color:var(--green); }
.msg-status.rc-fail, .msg-status.rc-error { color:var(--red); }
.msg-status.rc-advice { color:var(--amber); }
.msg-sep { font-size:11px; color:var(--ink-3); align-self:center; padding:4px 0; }

/* ---- page header, empty state ---- */
.page-head .top { display:flex; align-items:center; gap:8px; }
.page-head .meta { margin-top:6px; font-size:12px; color:var(--ink-3); display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
.page-head .meta .sep { color:var(--line-strong); }
.empty-pane { margin:auto; text-align:center; color:var(--ink-3); display:flex; flex-direction:column; align-items:center; gap:12px; padding:96px 24px; }
.empty-pane h1 { color:var(--ink-2); font-weight:600; }
.empty-pane svg { color:var(--ink-3); opacity:.7; }

@media (max-width: 760px) {
  .side { width:216px; }
  .wrap { padding:20px 16px 40px; }
}
@media (prefers-reduced-motion: reduce) {
  * { animation-duration:.01ms !important; animation-iteration-count:1 !important; transition-duration:.01ms !important; }
}
`;

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

// JSON inside a <script>: a literal "</script>" in a value would end it.
const jsonForScript = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

const CHEV = '<svg class="chev" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 1l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const IC_CLOCK = '<svg class="t-ic" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.8V8l2.2 1.4"/></svg>';
const IC_SCOPE = '<svg class="t-ic" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.6"/><path d="M10.4 10.4L14 14"/></svg>';
const IC_BOLT = '<svg class="t-ic" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M9 1L3.8 9h3L6 15l5.8-8.5h-3z" fill="currentColor"/></svg>';
const IC_PLAYC = '<svg class="t-ic" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M6.7 5.5l4 2.5-4 2.5z" fill="currentColor"/></svg>';
const IC_SPARK = '<svg class="t-ic" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.6l1.5 4.1 4.1 1.5-4.1 1.5L8 12.8 6.5 8.7 2.4 7.2l4.1-1.5z" fill="currentColor"/></svg>';
const PLAY = '<svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 1.5l8 4.5-8 4.5z" fill="currentColor"/></svg>';
const DOWNLOAD = '<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 1.5v7M4 6l3 3 3-3M1.5 11.5h11"/></svg>';
const LOGO = '<svg width="15" height="15" viewBox="0 0 15 15" aria-hidden="true"><rect x="0" y="0" width="4" height="4" rx="1" fill="currentColor"/><rect x="5.5" y="0" width="4" height="4" rx="1" fill="currentColor" opacity=".45"/><rect x="11" y="0" width="4" height="4" rx="1" fill="currentColor" opacity=".2"/><rect x="0" y="5.5" width="4" height="4" rx="1" fill="currentColor" opacity=".45"/><rect x="5.5" y="5.5" width="4" height="4" rx="1" fill="currentColor"/><rect x="11" y="5.5" width="4" height="4" rx="1" fill="currentColor" opacity=".45"/><rect x="0" y="11" width="4" height="4" rx="1" fill="currentColor" opacity=".2"/><rect x="5.5" y="11" width="4" height="4" rx="1" fill="currentColor" opacity=".45"/><rect x="11" y="11" width="4" height="4" rx="1" fill="currentColor"/></svg>';

// "i" = fixed explainer for a card; "?" = clarifications this run produced.
function pill(kind: 'i' | 'q', body: string, label: string, live = false): string {
  return `<span class="pw"><button type="button" class="pill pill-${kind}${live ? ' pill-live' : ''}" aria-label="${esc(label)}">${kind === 'i' ? 'i' : '?'}</button><div class="pop" hidden>${body}</div></span>`;
}

function dot(st: string): string {
  return `<span class="dot dot-${esc(st)}" title="${esc(st)}"></span>`;
}

function ago(ts: number): string {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? 'yesterday' : d < 7 ? `${d}d ago` : new Date(ts).toLocaleDateString('en-GB');
}

function sidebar(sessions: (Meta & { st: string })[], active?: string): string {
  const items = [...sessions]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((m) => `<a class="side-item${m.session === active ? ' on' : ''}" href="/session/${esc(m.session)}">
      ${dot(m.st)}
      <span class="side-name">${esc(m.name ?? m.session)}</span>
      <span class="side-meta num">${m.count} events · ${esc(ago(m.startedAt))}</span>
    </a>`).join('')
    || '<div class="side-empty">No sessions yet.</div>';
  return `<aside class="side">
    <div class="side-head">${LOGO}<span>Workflow Recorder</span></div>
    <div class="side-label">Sessions</div>
    <nav class="side-list">${items}</nav>
    <div class="side-foot mono">127.0.0.1:4823</div>
  </aside>`;
}

// One delegated handler runs every "i"/"?" popover on the page. A pill click
// inside a <summary> must not also toggle the fold, hence preventDefault.
const SHELL_SCRIPT = `<script>
document.addEventListener('click', (e) => {
  if (e.target.closest('.pop')) return;
  const pillBtn = e.target.closest('.pill');
  for (const p of document.querySelectorAll('.pop')) {
    if (!pillBtn || p !== pillBtn.nextElementSibling) p.hidden = true;
  }
  if (pillBtn) {
    e.preventDefault();
    const p = pillBtn.nextElementSibling;
    p.hidden = !p.hidden;
    if (!p.hidden) {
      // Fixed positioning escapes the scroll container's clipping; centre
      // under the pill, clamped to the viewport.
      p.style.position = 'fixed';
      p.style.transform = 'none'; p.style.right = 'auto'; p.style.left = '0px';
      const b = pillBtn.getBoundingClientRect();
      p.style.top = (b.bottom + 6) + 'px';
      const w = p.getBoundingClientRect().width;
      p.style.left = Math.max(8, Math.min(b.left + b.width / 2 - w / 2, window.innerWidth - w - 8)) + 'px';
    }
  }
});
document.addEventListener('scroll', () => {
  for (const p of document.querySelectorAll('.pop')) p.hidden = true;
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') for (const p of document.querySelectorAll('.pop')) p.hidden = true;
});
</script>`;

function shell(title: string, side: string, main: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body>${side}<div class="main"><main class="wrap">${main}</main></div>${SHELL_SCRIPT}</body></html>`;
}

export function renderList(sessions: (Meta & { st: string })[]): string {
  const hint = sessions.length
    ? 'Pick a recording from the sidebar.'
    : 'None recorded yet. Open the Workflow Recorder extension on the target site and start recording.';
  return shell('Workflow Recorder', sidebar(sessions), `
    <div class="empty-pane">
      <svg width="40" height="40" viewBox="0 0 15 15" aria-hidden="true"><rect x="0" y="0" width="4" height="4" rx="1" fill="currentColor"/><rect x="5.5" y="0" width="4" height="4" rx="1" fill="currentColor" opacity=".45"/><rect x="11" y="0" width="4" height="4" rx="1" fill="currentColor" opacity=".2"/><rect x="0" y="5.5" width="4" height="4" rx="1" fill="currentColor" opacity=".45"/><rect x="5.5" y="5.5" width="4" height="4" rx="1" fill="currentColor"/><rect x="11" y="5.5" width="4" height="4" rx="1" fill="currentColor" opacity=".45"/><rect x="0" y="11" width="4" height="4" rx="1" fill="currentColor" opacity=".2"/><rect x="5.5" y="11" width="4" height="4" rx="1" fill="currentColor" opacity=".45"/><rect x="11" y="11" width="4" height="4" rx="1" fill="currentColor"/></svg>
      <h1>Select a session</h1>
      <p class="sub">${esc(hint)}</p>
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
  } else if (kind === 'snapshot') {
    body = `<span class="sub">page snapshot (${esc(e.reason ?? 'page state')})</span>`;
  } else {
    body = `<span class="sub">${kind.replace('_', ' ')}</span>`;
  }
  return `<li><span>${tag}</span><span class="body">${body}</span></li>`;
}

export function renderDetail(meta: Meta, st: string, a: Analysis, events: Record<string, unknown>[], spec: any | undefined, script: string | undefined, log: Record<string, unknown>[], sessions: (Meta & { st: string })[]): string {
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
        ? `<p class="sub" style="margin-top:4px">Chained: the value at <span class="mono">${esc(a.chain.linkPath)}</span> in its response feeds <span class="mono">${esc(a.chain.call.method)} ${esc(url(a.chain.call.url))}</span>, the true outcome. The run re-resolves that link for every new input.</p>`
        : '')
      + (a.pageChain
        ? `<p class="sub" style="margin-top:4px">Chained to a page: the value at <span class="mono">${esc(a.pageChain.linkPath)}</span> in its response feeds <span class="mono">${esc(url(a.pageChain.url))}</span>, where your marked data is rendered. A browser step reads those elements on every run.</p>`
        : '')
    : `<p class="note">${esc(a.notes.join(' ') || 'No parameterised outcome call identified.')}</p>`;

  const callRows = a.calls.map((c) => `<tr>
    <td class="mono">${esc(c.method)} ${esc(url(c.url))}</td>
    <td class="num">${esc(c.status)}</td>
    <td>${c.matches.length ? `<span class="mark mono">${esc(c.matches[0].path)}</span>` : '<span class="sub">–</span>'}</td>
    <td class="sub">${esc(c.resultShape ?? '')}</td>
  </tr>`).join('');

  const specCards = spec ? renderSpec(spec, meta.session, a.marks.length, script) : `<div class="card">
    <div class="card-head"><h2>Automation</h2></div>
    <p class="note" style="margin-top:10px">No automation could be generated from this recording${a.notes.length ? `: ${esc(a.notes.join(' '))}` : '.'}</p>
    ${st === 'complete' ? `<p class="sub" style="margin-top:10px">The deterministic analyser found no direct call to promote. <a href="#effort">Maximum Effort Mode</a> below reads the pages you saw and works out how to reach the result you want.</p>` : ''}
  </div>`;
  const effortCard = st === 'complete' ? renderEffort(meta, log, !!spec) : '';

  return shell(`${meta.name ?? meta.session}`, sidebar(sessions, meta.session), `
    <script>
    // LLM adjust: stream the loop's NDJSON lines into a visible console so
    // the operator watches every diagnosis, proposal, and verification.
    window.streamRepair = async (id, con, after, body) => {
      con.hidden = false;
      con.innerHTML = '';
      after.innerHTML = '';
      // Stop asks the backend to abort this session's loop; the stream stays
      // open so the closing lines (what was kept, the spend) still arrive.
      const stop = document.createElement('button');
      stop.className = 'btn btn-quiet rc-stop';
      stop.textContent = 'Stop';
      stop.addEventListener('click', async () => {
        stop.disabled = true;
        stop.textContent = 'Stopping…';
        await fetch('/api/sessions/' + encodeURIComponent(id) + '/repair/stop', { method: 'POST' }).catch(() => {});
      });
      con.before(stop);
      const GLYPH = { info: '· ', llm: '∴ ', tool: '⚙ ', try: '→ ', fail: '✗ ', ok: '✓ ', saved: '✓ ', advice: '☞ ', error: '✗ ', done: '· ' };
      const line = (kind, text) => {
        const d = document.createElement('div');
        d.className = 'rc-' + kind;
        d.textContent = (GLYPH[kind] ?? '') + text;
        con.append(d);
        con.scrollTop = con.scrollHeight;
      };
      let savedOk = false;
      try {
        const r = await fetch('/api/sessions/' + encodeURIComponent(id) + '/repair', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        });
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\\n')) >= 0) {
            const l = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!l) continue;
            const e = JSON.parse(l);
            line(e.kind, e.text);
            if (e.kind === 'saved') savedOk = true;
          }
        }
      } catch (e) {
        line('error', 'stream lost: ' + e.message);
      }
      stop.remove();
      if (savedOk) {
        const view = document.createElement('button');
        view.className = 'btn';
        view.style.marginTop = '10px';
        view.textContent = 'View & run the automation';
        view.addEventListener('click', () => location.reload());
        after.append(view);
      }
      return savedOk;
    };
    // The signature loading state: pixel grid, shimmer label, elapsed timer.
    window.loaderHtml = (label) => {
      const delays = [90, 180, 270, 0, 90, 180, 90, 180, 270];
      let cells = '';
      for (const d of delays) cells += '<span class="px" style="animation-delay:' + d + 'ms"></span>';
      return '<span class="ldr"><span class="pxg" aria-hidden="true">' + cells + '</span><span class="shimmer"></span><span class="ldr-t"></span></span>';
    };
    window.showLoading = (host, label) => {
      host.innerHTML = '<p class="ldr-row">' + loaderHtml(label) + '</p>';
      host.querySelector('.shimmer').textContent = label;
      const t = host.querySelector('.ldr-t');
      const t0 = Date.now();
      const tick = () => {
        const s = (Date.now() - t0) / 1000;
        t.textContent = s < 60 ? s.toFixed(1) + 's' : Math.floor(s / 60) + 'm ' + (s % 60).toFixed(1) + 's';
      };
      tick();
      const iv = setInterval(tick, 100);
      return () => clearInterval(iv);
    };
    </script>
    <div class="card page-head">
      <div class="top">
        <h1 id="session-name">${esc(meta.name ?? meta.session)}</h1>
        <button id="rename-btn" class="icon-btn" aria-label="Rename session"><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.3 1.9l2.8 2.8L5 13.8l-3.5.7.7-3.5zM9.8 3.4l2.8 2.8"/></svg></button>
        <span class="right status" style="margin-left:auto">${dot(st)}${esc(st)}</span>
      </div>
      <div class="meta num">
        ${meta.name ? `<span class="mono">${esc(meta.session)}</span><span class="sep">·</span>` : ''}
        <span>${meta.count} events</span><span class="sep">·</span>
        <span>${esc(a.language)}</span><span class="sep">·</span>
        <span>${a.inputs.length} input${a.inputs.length === 1 ? '' : 's'}</span>
        ${meta.dropped ? `<span class="sep">·</span><span class="chip chip-warn">${meta.dropped} dropped</span>` : ''}
      </div>
      ${st === 'interrupted' ? '<p class="note" style="margin-top:12px">Interrupted session: reviewable evidence only, not eligible for automation.</p>' : ''}
    </div>

    <details class="fold">
      <summary>${CHEV}${IC_CLOCK}<span>Timeline</span><span class="badges"><span class="chip num">${shown.length} events</span></span></summary>
      <div class="fold-body">${timeline}</div>
    </details>

    <details class="fold">
      <summary>${CHEV}${IC_SCOPE}<span>Analysis</span><span class="badges">${a.outcome ? '<span class="chip chip-ok">outcome identified</span>' : '<span class="chip chip-warn">no outcome</span>'}</span></summary>
      <div class="fold-body">
        ${outcome}
        <table style="margin-top:12px"><thead><tr><th>Captured call</th><th>Status</th><th>Carries input</th><th>Response</th></tr></thead>
        <tbody>${callRows}</tbody></table>
      </div>
    </details>

    ${specCards}

    ${effortCard}

    <script>
    (() => {
      const btn = document.getElementById('rename-btn');
      const wrap = document.getElementById('session-name');
      const id = ${JSON.stringify(meta.session)};
      const CHECK = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 8.5l3.5 3.5L13.5 4"/></svg>';
      async function save(value) {
        await fetch('/api/sessions/' + encodeURIComponent(id) + '/name', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: value }),
        });
        location.reload();
      }
      btn.addEventListener('click', () => {
        const open = document.getElementById('rename-input');
        if (open) { save(open.value); return; }
        const current = wrap.textContent;
        wrap.innerHTML = '';
        const input = document.createElement('input');
        input.id = 'rename-input';
        input.className = 'rename-input';
        input.value = current;
        input.maxLength = 80;
        wrap.append(input);
        input.focus();
        input.select();
        btn.innerHTML = CHECK;
        btn.setAttribute('aria-label', 'Save name');
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') save(input.value);
          if (e.key === 'Escape') location.reload();
        });
      });

      const rbtn = document.getElementById('repair-btn');
      if (rbtn) rbtn.addEventListener('click', async () => {
        rbtn.disabled = true;
        await streamRepair(id, document.getElementById('repair-console'), document.getElementById('repair-after'), {});
        rbtn.disabled = false;
      });
    })();
    </script>`);
}

function renderSpec(spec: any, session: string, marksCount = 0, script?: string): string {
  const flow = spec.steps.map((s: any) =>
    `<span class="step">${esc(s.id)}<span class="sub"> · ${esc(s.type)}</span></span>`
  ).join('<span class="arrow">→</span>');
  const scriptStep = spec.steps.find((s: any) => s.type === 'script');
  const reasoned = spec.steps.filter((s: any) => s.reason);
  const inputs = spec.parameters.map((p: any) =>
    `<label>${esc(p.name)}<input id="param-${esc(p.name)}" value="${esc(p.example)}" spellcheck="false" autocomplete="off"></label>`
  ).join('');

  // Collapsed-row badges: the shape of the automation at a glance.
  const chips: string[] = [`<span class="chip num">${spec.steps.length} step${spec.steps.length === 1 ? '' : 's'}</span>`];
  chips.push(reasoned.length
    ? `<span class="chip">${reasoned.length} browser step${reasoned.length === 1 ? '' : 's'}</span>`
    : '<span class="chip chip-ok">direct requests</span>');
  if (spec.repaired) chips.push(`<span class="chip">${spec.repaired.mode === 'effort' ? 'maximum effort' : spec.repaired.mode === 'refine' ? 'LLM refined' : 'LLM built'}</span>`);
  if (marksCount && !spec.outcome.columns?.length) chips.push('<span class="chip chip-warn">marks unmatched</span>');
  else if (marksCount && spec.outcome.columns?.length && spec.outcome.columns.length < marksCount) chips.push(`<span class="chip chip-warn num">${spec.outcome.columns.length}/${marksCount} marks</span>`);

  // "?": clarifications this particular automation generated.
  const clarifications: string[] = [];
  for (const s of reasoned) clarifications.push(`<p>${esc(s.reason)}</p>`);
  if (marksCount && !spec.outcome.columns?.length) clarifications.push('<p>Your marked text was not found in any captured API response (it may be rendered server-side), so results show all fields instead.</p>');
  if (marksCount && spec.outcome.columns?.length && spec.outcome.columns.length < marksCount) clarifications.push(`<p>Only ${spec.outcome.columns.length} of ${marksCount} marked selections could be located; the rest were not found where the outcome lives.</p>`);
  const qPill = clarifications.length ? pill('q', clarifications.join(''), 'Notes about this automation', true) : '';

  const provenance = spec.repaired?.mode === 'effort'
    ? `<p class="ok-note" style="margin:0 0 12px">Built in Maximum Effort Mode (${esc(spec.repaired.model)})${spec.repaired.feedback ? ` for: “${esc(spec.repaired.feedback)}”` : ''}. ${esc(spec.repaired.summary ?? spec.repaired.diagnosis)} Verified by running it with the recorded input against the pages and calls in the recording before saving.</p>`
    : spec.repaired?.mode === 'refine'
    ? `<p class="ok-note" style="margin:0 0 12px">Refined by the LLM repair assistant (${esc(spec.repaired.model)}) after a run was flagged${spec.repaired.feedback ? ` ("${esc(spec.repaired.feedback)}")` : ''}: ${esc(spec.repaired.diagnosis)} Verified by executing it with the recorded input against the recording's own evidence before saving.</p>`
    : spec.repaired
      ? `<p class="ok-note" style="margin:0 0 12px">Built by the LLM repair assistant (${esc(spec.repaired.model)}) after the deterministic analyser refused: ${esc(spec.repaired.diagnosis)} Verified by executing it with the recorded input against the recording's own evidence before saving.</p>`
      : '';

  return `<details class="fold">
    <summary>${CHEV}${IC_BOLT}<span>Automation</span><span class="badges">${chips.join('')}${qPill}</span></summary>
    <div class="fold-body">
    ${provenance}
    ${scriptStep
      ? `<p class="sub" style="margin:0 0 8px">This session runs its own script (<span class="mono">${esc(scriptStep.file)}</span>), confined to ${scriptStep.hosts?.length ? scriptStep.hosts.map((h: string) => `<span class="mono">${esc(h)}</span>`).join(', ') : 'no network'}. It receives the parameters below and returns the rows.</p>
    <details class="spec-json"><summary>Show the session script</summary><pre>${esc(script ?? '(script file missing)')}</pre></details>`
      : ''}
    <div class="flow">${flow}</div>
    ${spec.outcome?.expect?.path !== undefined
      ? `<p class="sub" style="margin:10px 0 4px">Outcome gate: <span class="mono">${esc(spec.outcome.expect.path)}=${esc(spec.outcome.expect.equals)}</span>. The run stops with a reason if this check fails.</p>`
      : ''}
    ${spec.outcome.columns?.length
      ? `<p class="sub" style="margin:4px 0">Columns from your marked selections: ${spec.outcome.columns.map((c: any) => `<span class="mono">${esc(c.name)}</span>`).join(', ')}.</p>`
      : ''}
    <details class="spec-json"><summary>Show the spec JSON</summary><pre>${esc(JSON.stringify(spec, null, 2))}</pre></details>
    </div>
  </details>

  <div class="card">
    <div class="card-head">
      ${IC_PLAYC}<h2>Run</h2>
      ${pill('i', `<p><b>Single</b> runs the automation once with a new value. It executes the generated steps, not your recorded clicks.</p>${spec.parameters.length === 1 ? '<p><b>Bulk</b> takes one value per line (up to 50). Rows run one at a time with a delay between them; results aggregate into a single exportable table.</p>' : ''}<p>Image and link fields render as thumbnails and links; CSV and JSON exports keep the raw values.</p>`, 'About running the automation')}
      <div class="right">
        ${spec.parameters.length === 1 ? `<div class="seg" role="tablist"><button type="button" id="seg-single" class="seg-btn on">Single</button><button type="button" id="seg-bulk" class="seg-btn">Bulk</button></div>` : ''}
      </div>
    </div>
    <div id="pane-single" style="margin-top:12px">
      <div class="runrow">${inputs}<button id="run-btn" class="btn">${PLAY}Run</button></div>
      <div id="run-out"></div>
      <div id="fix-block" class="fix-block" hidden>
        <div class="card-head"><h2 style="font-size:12px">Adjust</h2>
        ${pill('i', '<p>Not what you wanted? For a small adjustment (fewer fields, a missing column) describe it here; the assistant changes the automation and verifies it against your recording before anything is saved.</p><p>For anything bigger, use <b>Maximum Effort Mode</b> below.</p>', 'About adjusting the automation')}</div>
        <textarea id="fix-text" rows="2" style="margin-top:8px" placeholder="e.g. I only want the article text, not the other fields"></textarea>
        <div class="runrow" style="margin-top:8px"><button id="fix-btn" class="btn btn-quiet">Adjust</button></div>
        <div id="fix-console" class="repair-console" hidden></div>
        <div id="fix-after"></div>
      </div>
    </div>
    ${spec.parameters.length === 1 ? `<div id="pane-bulk" style="margin-top:12px" hidden>
      <textarea id="bulk-values" rows="4" placeholder="value one&#10;value two&#10;value three"></textarea>
      <div class="runrow" style="margin-top:10px"><button id="bulk-btn" class="btn">${PLAY}Run all</button><span id="bulk-status" class="sub"></span></div>
      <div id="bulk-out"></div>
    </div>` : ''}
  </div>

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

    const DL = '<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 1.5v7M4 6l3 3 3-3M1.5 11.5h11"></path></svg>';
    function exportButtons(rows, base) {
      const wrap = document.createElement('div');
      wrap.className = 'runrow';
      wrap.style.marginTop = '10px';
      const csv = document.createElement('button');
      csv.className = 'btn btn-quiet'; csv.innerHTML = DL + 'CSV';
      csv.addEventListener('click', () => download(base + '.csv', 'text/csv', toCsv(rows)));
      const json = document.createElement('button');
      json.className = 'btn btn-quiet'; json.innerHTML = DL + 'JSON';
      json.addEventListener('click', () => download(base + '.json', 'application/json', JSON.stringify(rows, null, 2)));
      wrap.append(csv, json);
      return wrap;
    }

    // Values that are clearly an image or a link render as one; the exports
    // keep the raw strings.
    const IMG_EXT = /\\.(jpe?g|png|webp|gif|avif)([?#]|$)/i;
    const IMG_NAME = /image|img|thumb|logo|photo|picture/i;
    function cellHtml(v, col) {
      const s = String(v ?? '');
      if (/^https?:\\/\\//i.test(s)) {
        if (IMG_EXT.test(s) || IMG_NAME.test(col)) return '<img class="thumb" loading="lazy" src="' + esc(s) + '" alt="">';
        let host = s;
        try { host = new URL(s).hostname.replace(/^www\\./, ''); } catch {}
        return '<a class="cell-link" href="' + esc(s) + '" target="_blank" rel="noreferrer">' + esc(host) + ' ↗</a>';
      }
      return esc(s.slice(0, 300));
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
        : label + ': first ' + DISPLAY_CAP + ' of ' + rows.length + ' rows, download for the full set';
      return '<p class="sub" style="margin-top:10px">' + esc(caption) + '</p>' +
        '<div class="table-wrap"><table><thead><tr>' +
        cols.map((c) => '<th>' + esc(c) + '</th>').join('') +
        '</tr></thead><tbody>' +
        rows.slice(0, DISPLAY_CAP).map((row) => '<tr>' + cols.map((c) =>
          '<td class="sub">' + cellHtml(row[c], c) + '</td>').join('') + '</tr>').join('') +
        '</tbody></table></div>';
    }

    function renderResult(res, out, base) {
      const steps = (res.steps ?? []).map((s) =>
        '<li><span class="g-ok">✓</span> <span class="mono">' + esc(s.id) + '</span> <span class="sub">' + esc(s.detail) + '</span></li>').join('');
      let html = '<ul class="run-steps">' + steps + '</ul>';
      let rows = [];

      if (!res.ok) {
        html += '<p class="fail-note">✗ Stopped: ' + esc(res.stoppedReason) + '</p>';
      } else {
        html += '<p class="ok-note">✓ Outcome verified (' + esc(res.outcome.expected) + ')</p>';
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

    const segSingle = document.getElementById('seg-single');
    const segBulk = document.getElementById('seg-bulk');
    if (segSingle) {
      const paneSingle = document.getElementById('pane-single');
      const paneBulk = document.getElementById('pane-bulk');
      const select = (bulk) => {
        segSingle.classList.toggle('on', !bulk);
        segBulk.classList.toggle('on', bulk);
        paneSingle.hidden = bulk;
        paneBulk.hidden = !bulk;
      };
      segSingle.addEventListener('click', () => select(false));
      segBulk.addEventListener('click', () => select(true));
    }

    const btn = document.getElementById('run-btn');
    const out = document.getElementById('run-out');
    let lastRun;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const stopTimer = showLoading(out, 'Running the automation');
      const values = Object.fromEntries(params.map((p) => [p, document.getElementById('param-' + p).value.trim()]));
      try {
        const res = await runOnce(values);
        stopTimer();
        renderResult(res, out, 'run-' + Object.values(values)[0]);
        // What the operator received, as the table shows it, for the assistant
        // to compare with the marked selections.
        const rows = res.ok ? (res.extracted?.records?.rows ?? []) : [];
        const first = rows.length ? flat(rows[0]) : undefined;
        lastRun = {
          params: values, ok: res.ok, stoppedReason: res.stoppedReason, rowCount: rows.length,
          columns: first ? Object.keys(first) : [],
          firstRow: first && Object.fromEntries(Object.entries(first).map(([k, v]) => [k, String(v ?? '').slice(0, 120)])),
        };
        document.getElementById('fix-block').hidden = false;
      } catch (e) {
        stopTimer();
        out.innerHTML = '<p class="fail-note">✗ Could not reach the local backend: ' + esc(e.message) + '</p>';
      }
      btn.disabled = false;
    });

    const fixBtn = document.getElementById('fix-btn');
    fixBtn.addEventListener('click', async () => {
      fixBtn.disabled = true;
      await streamRepair(${JSON.stringify(session)}, document.getElementById('fix-console'), document.getElementById('fix-after'),
        { feedback: document.getElementById('fix-text').value.trim(), lastRun });
      fixBtn.disabled = false;
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
      status.innerHTML = loaderHtml('Running');
      const shimmer = status.querySelector('.shimmer');
      const aggregated = [];
      const perRow = [];
      let failed = 0;
      for (let i = 0; i < values.length; i++) {
        shimmer.textContent = 'Running ' + (i + 1) + ' of ' + values.length + ': ' + values[i];
        try {
          const res = await runOnce({ [params[0]]: values[i] });
          const rows = res.ok ? (res.extracted?.records?.rows ?? []) : [];
          if (res.ok) {
            for (const row of rows) aggregated.push({ input: values[i], ...row });
            perRow.push('<li><span class="g-ok">✓</span> <span class="mono">' + esc(values[i]) + '</span> <span class="sub">' + rows.length + ' rows</span></li>');
          } else {
            failed++;
            perRow.push('<li><span class="g-fail">✗</span> <span class="mono">' + esc(values[i]) + '</span> <span class="sub">' + esc(res.stoppedReason) + '</span></li>');
          }
        } catch (e) {
          failed++;
          perRow.push('<li><span class="g-fail">✗</span> <span class="mono">' + esc(values[i]) + '</span> <span class="sub">' + esc(e.message) + '</span></li>');
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

// Maximum Effort Mode, bring-your-own-model shape: the operator states the
// goal, exports the whole recording as one brief for an external model, and
// pastes the answer back to be verified against the recording. The export and
// import controls land with the next build; past API-loop conversations stay
// readable.
function renderEffort(meta: Meta, log: Record<string, unknown>[], hasSpec: boolean): string {
  const msgCount = log.filter((l) => l.kind === 'say' || l.kind === 'you' || l.kind === 'think').length;
  return `<details class="fold" id="effort"${hasSpec ? '' : ' open'}>
    <summary>${CHEV}${IC_SPARK}<span>Maximum Effort Mode</span><span class="badges"><span class="chip">bring your own model</span>${pill('i', '<p>Hand the whole recording to a model you already pay for.</p><p><b>1.</b> State the goal: what should this automation return?</p><p><b>2.</b> Export the brief: one file carrying your goal, the rules and every page and call from the recording.</p><p><b>3.</b> Give it to Claude, Codex or any capable model, then paste its answer back here to be verified and saved.</p><p>Nothing is saved until the answer has been run against your recording and returned what you saw.</p>', 'About Maximum Effort Mode')}</span></summary>
    <div class="fold-body">
    <label class="lbl" for="effort-goal" style="margin-top:0">Goal</label>
    <textarea id="effort-goal" rows="3" placeholder="What should this automation return? e.g. the top 5 listings on the final page, with the title, price and a link to each">${esc(meta.goal ?? '')}</textarea>
    <div class="runrow" style="margin-top:10px">
      <button id="brief-btn" class="btn" disabled>${DOWNLOAD}Export brief</button>
      ${pill('i', '<p><b>Coming next.</b> Downloads a single Markdown brief: your goal, the script contract, the acceptance rules and the sanitised evidence, ready to drop into any LLM chat. The paste-back verification lands with it.</p>', 'About the export')}
    </div>
    ${log.length ? `<details class="fold-sub">
      <summary>Past conversation · ${msgCount} message${msgCount === 1 ? '' : 's'}</summary>
      <div class="fold-body"><div id="effort-chat" class="chat"></div></div>
    </details>` : ''}
    </div>
  </details>

  <script>
  (() => {
    const past = ${jsonForScript(log)};
    const chat = document.getElementById('effort-chat');
    if (!chat || !past.length) return;
    const GLYPH = { info: '· ', tool: '⚙ ', try: '→ ', fail: '✗ ', ok: '✓ ', saved: '✓ ', advice: '☞ ', error: '✗ ', done: '· ', await: '… ' };
    function bubble(kind, text) {
      if (kind === 'think') {
        const det = document.createElement('details');
        det.className = 'msg msg-think';
        const sum = document.createElement('summary');
        sum.textContent = 'Thinking';
        const body = document.createElement('div');
        body.textContent = text;
        det.append(sum, body);
        chat.append(det);
        return;
      }
      const d = document.createElement('div');
      d.className = 'msg msg-' + kind;
      d.textContent = text;
      chat.append(d);
    }
    for (const e of past) {
      if (e.kind === 'say' || e.kind === 'think' || e.kind === 'you') bubble(e.kind, e.text);
      else if (e.kind === 'start') {
        const d = document.createElement('div');
        d.className = 'msg-sep';
        d.textContent = 'conversation started ' + new Date(e.text).toLocaleString('en-GB');
        chat.append(d);
      } else if (e.kind === 'block' || e.kind === 'llm') {
        continue;
      } else {
        const d = document.createElement('div');
        d.className = 'msg msg-status rc-' + e.kind;
        d.textContent = (GLYPH[e.kind] ?? '') + e.text;
        chat.append(d);
      }
    }
  })();
  </script>`;
}
