// Isolated-world content script: captures operator actions, receives network
// events from the MAIN-world tap, scrubs secrets, and batches everything to
// the service worker. Top frame only.

type Evt = Record<string, unknown>;

let on = false;
let hosts: string[] = [];
let buffer: Evt[] = [];
let flushTimer: number | undefined;

// Password values never leave the page: kept only to scrub outgoing payloads.
const secrets = new Set<string>();

function scrub(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  let out = s;
  for (const v of secrets) if (v.length >= 3) out = out.split(v).join('[REDACTED]');
  return out;
}

function push(evt: Evt) {
  if (!on) return;
  buffer.push({ ...evt, t: Date.now() });
  // A large captured body travels alone, so one batch never grows past what
  // the worker and the backend accept in a single message.
  const big = (typeof evt.resBody === 'string' && evt.resBody.length > 200 * 1024) || evt.kind === 'snapshot';
  if (buffer.length >= 20 || big) flush();
  else if (flushTimer === undefined) flushTimer = window.setTimeout(flush, 250);
}

function flush() {
  if (flushTimer !== undefined) { clearTimeout(flushTimer); flushTimer = undefined; }
  if (!buffer.length) return;
  const items = buffer;
  buffer = [];
  chrome.runtime.sendMessage({ type: 'events', items }).catch(() => {
    // Service worker unreachable: put the batch back so the next flush retries.
    buffer = items.concat(buffer);
  });
}

function selector(el: Element): string {
  if (el.id) return `#${el.id}`;
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== document.body && parts.length < 8) {
    if (cur.id) { parts.unshift(`#${cur.id}`); break; }
    const tag = cur.tagName.toLowerCase();
    // A stable-looking class anchors the path far better than bare divs; ids
    // are rare deep inside templated pages.
    const cls = Array.from(cur.classList).find((c) => /^[A-Za-z][\w-]{2,40}$/.test(c));
    const name = cls ? `${tag}.${cls}` : tag;
    const parent: Element | null = cur.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
      parts.unshift(same.length > 1 ? `${name}:nth-of-type(${same.indexOf(cur) + 1})` : name);
    } else {
      parts.unshift(name);
    }
    cur = parent;
  }
  return parts.join(' > ');
}

function describe(el: Element): Evt {
  const d: Evt = { tag: el.tagName.toLowerCase(), selector: selector(el) };
  const id = el.getAttribute('id'); if (id) d.id = id;
  const name = el.getAttribute('name'); if (name) d.name = name;
  const type = el.getAttribute('type'); if (type) d.type = type;
  const role = el.getAttribute('role'); if (role) d.role = role;
  const aria = el.getAttribute('aria-label'); if (aria) d.aria = aria;
  const href = el.getAttribute('href'); if (href) d.href = href;
  const text = (el as HTMLElement).innerText?.trim().slice(0, 80);
  if (text) d.text = text;
  return d;
}

// --- page snapshots ----------------------------------------------------------
// What the operator saw, kept beside what the page fetched. For a page that
// renders its results server-side the snapshot is the only record of the
// outcome. Visible text plus a pruned copy of the DOM (no scripts, styles,
// handlers or media; ids, classes, links and data attributes kept), taken
// when a page settles, after an action changed it, and when recording stops.
const TEXT_CAP = 120_000;
const HTML_CAP = 400_000;
const KEEP_ATTR = /^(id|class|href|src|alt|title|name|type|value|placeholder|role|aria-label|for|colspan|rowspan|datetime|data-[\w-]+)$/;
const DROP = 'script,style,noscript,svg,iframe,template,canvas,video,audio,link,meta,object,embed,[data-wfr]';

function prunedHtml(): { html: string; truncated: boolean } {
  const clone = document.body.cloneNode(true) as HTMLElement;
  for (const el of Array.from(clone.querySelectorAll(DROP))) el.remove();
  const walker = document.createTreeWalker(clone, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  const blank: Node[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) {
      const t = (n.textContent ?? '').replace(/\s+/g, ' ');
      if (!t.trim()) blank.push(n); else n.textContent = t;
      continue;
    }
    const el = n as Element;
    for (const a of Array.from(el.attributes)) {
      if (!KEEP_ATTR.test(a.name)) el.removeAttribute(a.name);
      else if (a.value.length > 300) el.setAttribute(a.name, a.value.slice(0, 300));
    }
    // A hidden or password field's value is a token or a secret, never data.
    if (el instanceof HTMLInputElement && (el.type === 'hidden' || el.type === 'password')) el.removeAttribute('value');
  }
  for (const b of blank) b.parentNode?.removeChild(b);
  const html = clone.innerHTML;
  return html.length > HTML_CAP ? { html: html.slice(0, HTML_CAP), truncated: true } : { html, truncated: false };
}

let lastSnapshot = '';
let snapshotTimers: number[] = [];

function takeSnapshot(reason: string) {
  if (!on || !document.body) return;
  try {
    snapshot(reason);
  } catch (e) {
    // A page the pruner cannot walk must say so in the console, not vanish.
    console.error('[wfr] snapshot failed:', (e as Error).message);
  }
}

function snapshot(reason: string) {
  const text = (document.body.innerText ?? '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  // The same page text twice is the same page: one snapshot per state.
  const key = `${location.href}|${text.length}|${text.slice(0, 2000)}|${text.slice(-2000)}`;
  if (key === lastSnapshot) return;
  lastSnapshot = key;
  const { html, truncated } = prunedHtml();
  push({
    kind: 'snapshot', reason, url: location.href, title: document.title,
    text: scrub(text.slice(0, TEXT_CAP)), html: scrub(html),
    ...(text.length > TEXT_CAP ? { textTruncated: text.length } : {}),
    ...(truncated ? { htmlTruncated: true } : {}),
  });
}

// After an action the page may update at once or a few seconds later; look
// twice and keep whichever states differ. The clone runs in idle time so it
// never lands in the middle of the operator's next gesture.
function snapshotSoon(reason: string) {
  for (const t of snapshotTimers) clearTimeout(t);
  const idle = (f: () => void) => (window.requestIdleCallback ? window.requestIdleCallback(f, { timeout: 1500 }) : window.setTimeout(f, 0));
  snapshotTimers = [1500, 4500].map((ms) => window.setTimeout(() => idle(() => takeSnapshot(reason)), ms));
}

const INTERACTIVE = 'a,button,input,select,textarea,label,[role="button"],[role="link"],[role="tab"],[onclick]';

document.addEventListener('click', (e) => {
  if ((e.target as Element)?.closest?.('[data-wfr]')) return;
  const el = (e.target as Element)?.closest?.(INTERACTIVE) ?? (e.target as Element);
  if (el instanceof Element) push({ kind: 'action', action: 'click', target: describe(el) });
  snapshotSoon('change');
}, { capture: true, passive: true });

// Marking: highlighting text while recording offers a chip; clicking it records
// the selection as wanted data. Marks drive the result columns downstream.
let chip: HTMLButtonElement | undefined;

function removeChip() {
  chip?.remove();
  chip = undefined;
}

function offerMark() {
  removeChip();
  const sel = window.getSelection();
  const text = sel?.toString().replace(/\s+/g, ' ').trim();
  if (!on || !sel || sel.isCollapsed || !text || text.length < 2) return;
  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  // The common ancestor, not the anchor: a drag across several paragraphs
  // marks their container, whose selector generalises across pages far better
  // than "the 11th paragraph".
  const node = range.commonAncestorContainer;
  const anchor = node instanceof Element ? node : node.parentElement;
  chip = document.createElement('button');
  chip.dataset.wfr = 'chip';
  chip.textContent = 'Mark data';
  chip.style.cssText =
    'position:fixed;z-index:2147483647;font:12px/1 system-ui,sans-serif;font-weight:600;' +
    'background:#2563EB;color:#fff;border:none;border-radius:6px;padding:7px 12px;cursor:pointer;' +
    'box-shadow:0 2px 8px rgb(0 0 0/.25);';
  chip.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 120))}px`;
  chip.style.top = `${Math.min(rect.bottom + 8, window.innerHeight - 44)}px`;
  chip.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    push({ kind: 'action', action: 'mark', text: scrub(text)?.slice(0, 4000), target: anchor ? describe(anchor) : undefined });
    chip!.textContent = 'Marked ✓';
    chip!.style.background = '#1B8A5A';
    setTimeout(removeChip, 700);
  });
  document.body.appendChild(chip);
}

document.addEventListener('mouseup', (e) => {
  if ((e.target as Element)?.closest?.('[data-wfr]')) return;
  // The selection is finalised after mouseup; read it on the next tick.
  setTimeout(offerMark, 0);
}, { capture: true, passive: true });

window.addEventListener('scroll', removeChip, { passive: true });

document.addEventListener('change', (e) => {
  const el = e.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  if (!(el instanceof Element)) return;
  const evt: Evt = { kind: 'action', action: 'input', target: describe(el) };
  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
    evt.checked = el.checked;
  } else if (el instanceof HTMLInputElement && el.type === 'password') {
    secrets.add(el.value);
    evt.value = '[REDACTED]';
  } else {
    evt.value = scrub(el.value);
  }
  push(evt);
}, { capture: true, passive: true });

document.addEventListener('input', (e) => {
  const el = e.target as HTMLInputElement;
  if (el instanceof HTMLInputElement && el.type === 'password' && el.value) secrets.add(el.value);
}, { capture: true, passive: true });

document.addEventListener('submit', (e) => {
  const form = e.target as Element;
  if (form instanceof Element) push({ kind: 'action', action: 'submit', target: describe(form) });
  snapshotSoon('change');
}, { capture: true, passive: true });

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const el = e.target as Element;
  push({ kind: 'action', action: 'enter', target: el instanceof Element ? describe(el) : undefined });
  snapshotSoon('change');
}, { capture: true, passive: true });

window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window || e.data?.__wfr !== 'net') return;
  const net = e.data.net as Record<string, unknown>;
  const evt: Evt = {
    kind: 'net', ...net,
    reqBody: scrub(net.reqBody as string | undefined),
    resBody: scrub(net.resBody as string | undefined),
  };
  if (net.reqHeaders && typeof net.reqHeaders === 'object') {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(net.reqHeaders as Record<string, string>)) {
      if (/cookie|authorization|x-api-key|bearer/i.test(k)) continue;
      clean[k] = scrub(String(v)) ?? '';
    }
    if (Object.keys(clean).length) evt.reqHeaders = clean; else delete evt.reqHeaders;
  }
  push(evt);
});

function pageEvent() {
  push({
    kind: 'page', url: location.href, title: document.title,
    lang: document.documentElement.lang || navigator.language,
  });
  snapshotSoon('load');
}

function setState(next: { on: boolean; hosts: string[] }) {
  const was = on;
  // The final state of the page is the recording's last word on the outcome.
  if (was && !next.on) takeSnapshot('stop');
  on = next.on;
  hosts = next.hosts ?? [];
  window.postMessage({ __wfr: 'state', on, hosts }, '*');
  if (on && !was) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', pageEvent, { once: true });
    } else {
      pageEvent();
    }
  }
  if (!on) { removeChip(); flush(); }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'set-state') setState(msg);
});

window.addEventListener('pagehide', () => { takeSnapshot('leave'); flush(); });

chrome.runtime.sendMessage({ type: 'get-state' })
  .then((state) => { if (state?.on) setState(state); })
  .catch(() => { /* worker not ready; popup start will notify us */ });

export {};
