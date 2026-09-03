// The brief: the whole recording as one Markdown document the operator hands
// to a model they already pay for. The goal, the script contract and the
// acceptance rules the answer will be held to, the answer format, then the
// evidence in order of worth until the budget is spent. Whatever the budget
// cut is listed at the end, never dropped silently. Snapshots and bodies
// arrive here already sanitised (no cookies, credentials or passwords).
import { markKey } from './analyse.js';
import { ACCEPTANCE_RULES, scriptContract, type Evidence } from './candidate.js';
import { navSummary, overview, shapeOf, tryJson, type Ev } from './llm-tools.js';
import { sessionDir } from './store.js';
import { robotsCheck } from './robots.js';
import { cleanHeaders } from '../../runner/src/script.js';

export const DEFAULT_BUDGET = 4 * 1024 * 1024;
const MIN_BUDGET = 64 * 1024;
const MIN_CUT = 2_000;          // below this an item is left out rather than cut short
const LEFT_OUT_RESERVE = 2_000; // room kept for the list of what was left out
const FETCH_PAGES = 6;
const FETCH_BODY = 400_000;
const FETCH_TIMEOUT_MS = 15_000;
const F = '````';               // four-backtick fences: page text may contain three

export type BriefOptions = { budget?: number; probe?: boolean };

class Doc {
  private parts: string[] = [];
  size = 0;
  leftOut: string[] = [];
  constructor(private readonly budget: number) {}
  fixed(s: string) { this.parts.push(s); this.size += s.length + 2; }
  // A budgeted item: whole if it fits, cut to what fits when that is still
  // worth reading, otherwise left out. Either way the tail of the document
  // says so.
  add(label: string, body: string, render: (body: string, cut: string) => string) {
    const room = this.budget - LEFT_OUT_RESERVE - this.size;
    const whole = render(body, '');
    if (whole.length <= room) { this.fixed(whole); return; }
    const keep = room - (whole.length - body.length) - 80;
    if (keep >= MIN_CUT) {
      this.fixed(render(body.slice(0, keep), `\n[CUT HERE by the brief's budget: ${keep} of ${body.length} chars shown]`));
      this.leftOut.push(`${label}: cut at ${keep} of ${body.length} chars`);
      return;
    }
    this.leftOut.push(`${label}: left out entirely (${body.length} chars)`);
  }
  text() {
    const tail = this.leftOut.length
      ? `## Left out by the budget\n\nThe brief is capped at ${this.budget} characters (export with ?budget=<chars> for more). Not everything fit:\n${this.leftOut.map((l) => `- ${l}`).join('\n')}`
      : '## Left out by the budget\n\nNothing: the whole recording fit.';
    return [...this.parts, tail].join('\n\n') + '\n';
  }
}

const fence = (s: string, cut = '') => `${F}\n${s}${cut}\n${F}`;

// The page's own label for the field a value was typed into.
function labelFor(events: Ev[], field: string, value: string): string {
  const e = events.find((x) => x.kind === 'action' && x.action === 'input' && x.value === value);
  const t = e?.target as { aria?: string; placeholder?: string; name?: string; id?: string } | undefined;
  const label = t?.aria ?? t?.placeholder;
  return label && label !== field ? `${field} (label "${label}")` : field;
}

function hasRecords(v: unknown, depth = 0): boolean {
  if (depth > 3 || !v || typeof v !== 'object') return false;
  if (Array.isArray(v)) return v.length > 0 && v.every((x) => x && typeof x === 'object' && !Array.isArray(x));
  return Object.values(v).some((x) => hasRecords(x, depth + 1));
}

// What a script's ctx.http.fetch gets for the pages the operator visited,
// fetched now from this machine with no cookies: a chat model cannot probe,
// so the brief says whether the visible results are in the plain response
// (parse it with ctx.dom), rendered by scripts, or replaced by a bot wall.
async function fetchCheck(ev: Evidence): Promise<{ lines: string[]; last?: { url: string; text: string } }> {
  const urls: string[] = [];
  for (const e of ev.events) {
    if ((e.kind === 'nav' || e.kind === 'page') && typeof e.url === 'string' && /^https?:\/\//.test(e.url) && !urls.includes(e.url)) urls.push(e.url);
  }
  const picked = urls.slice(-FETCH_PAGES);
  const robots = await robotsCheck(picked);
  const lines: string[] = [];
  let last: { url: string; text: string } | undefined;
  for (const url of picked) {
    let line: string;
    try {
      const res = await fetch(url, { headers: cleanHeaders({}), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
      const text = (await res.text()).slice(0, FETCH_BODY);
      const snap = [...ev.snapshots].reverse().find((s) => s.url === url);
      let verdict = 'no snapshot of this page to compare with';
      if (snap) {
        const visible = [...new Set(String(snap.text ?? '').split('\n').map((l) => l.trim()).filter((l) => l.length >= 15))].slice(0, 20);
        // Compared as text: tags between words would break every match.
        const hay = markKey(text.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '));
        const found = visible.filter((l) => hay.includes(markKey(l))).length;
        verdict = visible.length
          ? `${found} of ${visible.length} visible lines from the snapshot present → ${found * 2 >= visible.length ? 'the content is in the plain response (server-rendered; parse it with ctx.dom)' : 'the visible content is NOT in the plain response (rendered by scripts from an API call, or a different page was served — check the captured calls, or use ctx.browser)'}`
          : 'the snapshot has no lines long enough to compare';
      }
      line = `- ${url} → HTTP ${res.status} ${res.headers.get('content-type') ?? ''}, ${text.length} chars${res.url !== url ? ` (redirected to ${res.url})` : ''}; ${verdict}${robots.has(url) ? `. robots.txt disallows ${robots.get(url)} for all agents: say so in your summary` : ''}`;
      if (url === picked[picked.length - 1] && text) last = { url, text };
    } catch (e) {
      line = `- ${url} → fetch failed: ${(e as Error).message}`;
    }
    lines.push(line);
  }
  return { lines, last };
}

export async function buildBrief(ev: Evidence, opts: BriefOptions = {}): Promise<string> {
  const budget = Math.max(MIN_BUDGET, Math.floor(opts.budget ?? DEFAULT_BUDGET));
  const doc = new Doc(budget);
  const goal = ev.meta.goal?.trim();
  const title = ev.meta.name ?? ev.id;
  const nets = ev.events.filter((e) => e.kind === 'net');
  const lastSnap = ev.snapshots[ev.snapshots.length - 1];
  const probe = opts.probe !== false;
  const check = probe ? await fetchCheck(ev) : undefined;

  doc.fixed(`# Automation brief: ${title}

Generated ${new Date().toISOString()} by Workflow Recorder from session "${ev.id}" (site ${ev.meta.hosts.join(', ')}, ${ev.events.length} events, ${ev.snapshots.length} page snapshot(s), ${nets.length} captured call(s) with bodies, language ${ev.a.language}). Session folder on the operator's machine: ${sessionDir(ev.id)}

## Goal

${goal ? goal : 'Not stated. Work out the outcome from the recording, say what you think the operator wants, and ask if it is not clear.'}

## Your task

An operator recorded themselves doing something on a website. The recorder kept every page they looked at (snapshots of the visible text and the pruned DOM), every request the page made with its body, every click, every value they typed, every navigation, and anything they highlighted and marked as wanted data. Build an automation that returns what the goal asks for, for any future input, not just the recorded one. The recording is evidence, not a script to replay: find the best way to reach the same outcome.

1. Read the goal, the route and the snapshots first: the snapshots are what the operator actually saw, and the route shows how filters, sorts and pages appear in URLs. Then look at the captured calls for the data behind the page.
2. Prefer the site's own API when one carries the data (captured calls below show request and response in full). Prefer a fetched page parsed with ctx.dom when the results are server-rendered HTML (the plain-fetch check below says whether they are). Drive a browser (ctx.browser) only when nothing else reaches the data.
3. Every value the operator typed is a parameter of the automation unless the goal says it is fixed. Choose names a person would use (query, min_price, city), never element ids. Choices made by clicking (a sort, a filter, a checkbox) are part of how the outcome is reached: bake them in, and say so.
4. If your environment lets you make HTTP requests, probe the endpoint you intend to call with the recorded value before answering. If not, reason from the evidence here. If something essential is missing from this brief, say exactly what the operator should record differently rather than guessing.
5. If you are an agent with a shell in the tool's repository: write the script to automation.candidate.mjs in the session folder with a candidate.json beside it ({title, summary, parameters, fixed}), run \`npm run verify -- ${ev.id}\` until it prints PASS, then \`npm run verify -- ${ev.id} --save\`.

## The script

${scriptContract('your answer')}

## Acceptance (deterministic, applied to your answer before anything is saved)

${ACCEPTANCE_RULES}

## Answer format

Reply with ONE fenced json block; the tool reads only that block:

\`\`\`json
{
  "title": "short human name, e.g. eBay Listings by Minimum Price",
  "summary": "two or three sentences: what the automation returns, how it reaches the data, which recorded choices are baked in and why",
  "parameters": [{ "name": "query", "example": "the recorded value", "description": "what a person would type here" }],
  "fixed": [],
  "source": "async function run(ctx) { ... }"
}
\`\`\`

- parameters: the values the operator typed (listed below with suggested names), each with its recorded value as the example so the verification run reproduces the recording.
- fixed: typed values deliberately baked into the script rather than parameterised; explain why in the summary.
- source: the whole script as one JSON string (newlines and quotes escaped).
- Outside the block, in a few sentences: what the automation returns and which choices are baked in.

The operator pastes your reply into the tool, which verifies it against the recording. If it is rejected they paste the reason back to you: fix it and answer again with the whole block.

## Evidence

Everything below is the sanitised recording: no cookies, credentials or password values. Snapshots show whatever was on the operator's screen, including anything personal the page displayed.

### Route the operator took

Navigations in order; a page that only re-queried the same path shows just the query parameters that changed (filters, sorts and price bounds appear here by name).

${navSummary(ev.events)}

### Values the operator typed (default parameters)

${ev.typed.map((p) => `- "${p.value}" into ${labelFor(ev.events, p.field, p.value)} → suggested parameter name \`${p.name}\``).join('\n') || 'none'}

### Marked text (each must appear as a field value in the rows)

${ev.marks.map((m) => `- "${m.slice(0, 600)}"`).join('\n') || 'none'}

### Results the operator clicked (normalised)

${ev.clicked.filter((c) => !ev.marks.some((m) => markKey(m).startsWith(c))).map((c) => `- "${c}"`).join('\n') || 'none'}

### The deterministic analyser's verdict (a guess, often wrong for multi-step workflows)

${ev.a.outcome ? `It chose ${ev.a.outcome.method} ${ev.a.outcome.url} as the outcome call, ranked by carrying the typed value and returning records. Judge for yourself.` : 'No outcome call identified.'} Notes: ${ev.a.notes.join(' ') || 'none'}

### What a plain HTTP fetch of each visited page returns today

${check ? (check.lines.join('\n') || 'no page URLs in the recording') : 'Not checked (export with ?probe=0 skips this).'}${check ? '\n\nFetched at export time from the operator\'s machine with no cookies, the way a script\'s ctx.http.fetch would.' : ''}

### Page snapshots (what the operator saw)

${ev.snapshots.map((s) => {
    const st = s.storage as { local?: string[]; session?: string[] } | undefined;
    const storage = st && (st.local?.length || st.session?.length) ? `; web storage keys (names only): local [${(st.local ?? []).join(', ')}] session [${(st.session ?? []).join(', ')}]` : '';
    return `- #${s.seq} (${s.reason}) ${s.url}${s.title ? ` "${String(s.title).slice(0, 80)}"` : ''} — ${String(s.text ?? '').length} chars of text, ${String(s.html ?? '').length} chars of pruned HTML${s.htmlTruncated ? ' (cut by the recorder)' : ''}${storage}`;
  }).join('\n') || 'none — this recording has no page snapshots (made before snapshots existed, or the extension was not reloaded); the captured calls are the only evidence'}`);

  doc.add('the recording in order', overview(ev.events, ev.a), (b, cut) => `### The recording, in order

Every event with a preview of its body or page text; the full texts follow.

${fence(b, cut)}`);

  for (const s of ev.snapshots) {
    doc.add(`snapshot #${s.seq} text`, String(s.text ?? ''), (b, cut) => `### Snapshot #${s.seq} (${s.reason}) — visible text of ${s.url}

${fence(b, cut)}`);
  }
  if (lastSnap) {
    doc.add(`snapshot #${lastSnap.seq} HTML`, String(lastSnap.html ?? ''), (b, cut) => `### Snapshot #${lastSnap.seq} — pruned HTML of the last page, ${lastSnap.url}

Scripts, styles, handlers and media removed; ids, classes, links and data attributes kept. Selectors for ctx.dom / ctx.browser come from here.

${fence(b, cut)}`);
  }
  if (check?.last) {
    const last = check.last;
    doc.add('plain fetch of the last page', last.text, (b, cut) => `### The last page as a plain fetch returns it, ${last.url}

What ctx.http.fetch got for this URL at export time.

${fence(b, cut)}`);
  }

  const carries = new Set(ev.a.calls.filter((c) => c.matches.length).map((c) => c.seq));
  const worth = (e: Ev) => carries.has(Number(e.seq)) || hasRecords(tryJson(String(e.resBody ?? '')));
  const size = (e: Ev) => String(e.reqBody ?? '').length + String(e.resBody ?? '').length;
  const ordered = [...nets.filter(worth), ...nets.filter((e) => !worth(e)).sort((x, y) => size(x) - size(y))];
  if (ordered.length) doc.fixed('### Captured calls in full\n\nCalls that carry a typed value or return structured records first, then the rest smallest first.');
  for (const e of ordered) {
    const res = String(e.resBody ?? '');
    const req = String(e.reqBody ?? '');
    const parsed = tryJson(res);
    const head = `#### #${e.seq} ${e.method} ${e.url} → ${e.status} ${e.contentType ?? ''}${carries.has(Number(e.seq)) ? ' [carries the typed value]' : ''}${typeof e.resTruncated === 'number' ? ` [response CUT by the recorder at ${res.length} of ${e.resTruncated} chars]` : ''}`;
    const hdr = `${e.reqHeaders && typeof e.reqHeaders === 'object' ? `request headers the page sent: ${JSON.stringify(e.reqHeaders)}\n\n` : ''}${e.resHeaders && typeof e.resHeaders === 'object' ? `response headers: ${JSON.stringify(e.resHeaders)}\n\n` : ''}`;
    const body = `${req ? `request body (${req.length} chars):\n${fence(req)}\n\n` : ''}response body (${res.length} chars${parsed !== undefined ? `; JSON shape ${shapeOf(parsed).slice(0, 600)}` : ''}):\n${F}\n${res}`;
    doc.add(`call #${e.seq} ${e.method} ${e.url}`, body, (b, cut) => `${head}\n\n${hdr}${b}${cut}\n${F}`);
  }

  return doc.text();
}
