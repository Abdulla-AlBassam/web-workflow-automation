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

// The element the operator actually hit. Inside an open shadow root e.target
// is retargeted to the host, which describes a wrapper div instead of the
// control; the composed path starts at the real one. Its selector still stops
// at the shadow boundary, because a CSS path cannot cross one.
function hit(e: Event): Element | undefined {
  const el = e.composedPath()[0];
  if (el instanceof Element) return el;
  return e.target instanceof Element ? e.target : undefined;
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

// Key names only: a token's presence and its home are evidence, its value is
// a credential. The runner's token reader discovers the value at run time.
function storageKeys(): { local: string[]; session: string[] } {
  const names = (s: Storage | undefined) => {
    const out: string[] = [];
    try { for (let i = 0; s && i < s.length && out.length < 50; i++) { const k = s.key(i); if (k) out.push(k.slice(0, 80)); } } catch { /* storage refused */ }
    return out;
  };
  return { local: names(window.localStorage), session: names(window.sessionStorage) };
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
    storage: storageKeys(),
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
  const target = hit(e);
  if (!target || target.closest('[data-wfr]')) return;
  const el = target.closest(INTERACTIVE) ?? target;
  const evt: Evt = { kind: 'action', action: 'click', target: describe(el) };
  // The element's own markup: ids, data attributes and the link as written.
  // Form controls are left out; their values are recorded on change.
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) {
    const html = scrub(el.outerHTML.replace(/\s+/g, ' '));
    if (html) evt.html = html.slice(0, 800);
  }
  push(evt);
  snapshotSoon('change');
}, { capture: true, passive: true });

// Marking: highlighting text while recording offers a chip; clicking it records
// the selection as wanted data. Marks drive the result columns downstream.
const CHIP_CSS =
  'position:fixed;z-index:2147483647;font:12px/1 system-ui,sans-serif;font-weight:600;' +
  'color:#fff;border:none;border-radius:6px;padding:7px 12px;cursor:pointer;' +
  'box-shadow:0 2px 8px rgb(0 0 0/.25);';

let chip: HTMLButtonElement | undefined;
let marking: { text: string; anchor: Element | null } | undefined;

function removeChip() {
  chip?.remove();
  chip = undefined;
}

function buildChip(): HTMLButtonElement {
  const el = document.createElement('button');
  el.dataset.wfr = 'chip';
  el.style.cssText = CHIP_CSS;
  el.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!marking) return;
    push({ kind: 'action', action: 'mark', text: scrub(marking.text)?.slice(0, 4000), target: marking.anchor ? describe(marking.anchor) : undefined });
    el.textContent = 'Marked ✓';
    el.style.background = '#1B8A5A';
    setTimeout(removeChip, 700);
  });
  return el;
}

function offerMark() {
  const sel = window.getSelection();
  const text = sel?.toString().replace(/\s+/g, ' ').trim();
  if (!on || !sel || sel.isCollapsed || !text || text.length < 2) { removeChip(); return; }
  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  // The common ancestor, not the anchor: a drag across several paragraphs
  // marks their container, whose selector generalises across pages far better
  // than "the 11th paragraph".
  const node = range.commonAncestorContainer;
  marking = { text, anchor: node instanceof Element ? node : node.parentElement };
  // Moved, never rebuilt: a chip torn down and re-created on every mouseup and
  // scroll can be gone by the time the operator's click reaches it.
  const el = chip ?? (chip = buildChip());
  el.textContent = 'Mark data';
  el.style.background = '#2563EB';
  el.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 120))}px`;
  el.style.top = `${Math.min(rect.bottom + 8, window.innerHeight - 44)}px`;
  if (!el.isConnected) document.body.appendChild(el);
}

document.addEventListener('mouseup', (e) => {
  if ((e.target as Element)?.closest?.('[data-wfr]')) return;
  // The selection is finalised after mouseup; read it on the next tick.
  setTimeout(offerMark, 0);
}, { capture: true, passive: true });

// The chip is fixed to the viewport, so a scroll leaves it pointing at the
// wrong place: follow the selection instead of vanishing. The browser scrolls
// an element into view before clicking it, and a chip that removed itself
// there could never be clicked at all.
window.addEventListener('scroll', () => { if (chip) offerMark(); }, { passive: true });

// A typed value the page never reports: a contenteditable box and a custom
// combobox fire no change event at all, and some frameworks swallow it. The
// value is read once typing pauses, in the same shape the analyser correlates
// on, and the change event below dedupes against it, so a field yields one
// event per final value whichever of the two fires.
const TYPING_PAUSE = 800;
const TEXT_TYPE = /^(text|search|email|url|tel|number)$/;
const TEXT_ROLE = /^(textbox|combobox|searchbox)$/;

const pending = new Map<Element, number>();
const typed = new WeakMap<Element, string | undefined>();

function textLike(el: Element): boolean {
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return TEXT_TYPE.test(el.type);
  return (el as HTMLElement).isContentEditable || TEXT_ROLE.test(el.getAttribute('role') ?? '');
}

function typedValue(el: Element): string | undefined {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value;
  return (el as HTMLElement).innerText?.replace(/\s+/g, ' ').trim().slice(0, 500);
}

function fresh(el: Element, value: string | undefined): boolean {
  if (typed.get(el) === value) return false;
  typed.set(el, value);
  return true;
}

function clearPending(el: Element) {
  const timer = pending.get(el);
  if (timer !== undefined) { clearTimeout(timer); pending.delete(el); }
}

function recordTyped(el: Element) {
  pending.delete(el);
  const value = scrub(typedValue(el));
  if (!value || !fresh(el, value)) return;
  push({ kind: 'action', action: 'input', value, target: describe(el) });
}

// Enter, submit and stop commit whatever is half-recorded: the value belongs
// in the trace before the request it drove, not after it or nowhere.
function flushTyped() {
  for (const el of [...pending.keys()]) { clearPending(el); recordTyped(el); }
}

function inputEvent(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): Evt | undefined {
  const evt: Evt = { kind: 'action', action: 'input', target: describe(el) };
  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
    evt.checked = el.checked;
    return evt;
  }
  if (el instanceof HTMLInputElement && el.type === 'password') {
    secrets.add(el.value);
    evt.value = '[REDACTED]';
    return evt;
  }
  const value = scrub(el.value);
  if (!fresh(el, value)) return undefined;
  evt.value = value;
  // The option's visible text is what the operator chose; the value is
  // often an opaque code.
  if (el instanceof HTMLSelectElement) {
    const label = el.selectedOptions[0]?.text?.trim();
    if (label) evt.label = label.slice(0, 120);
  }
  return evt;
}

document.addEventListener('change', (e) => {
  const el = hit(e) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | undefined;
  if (!(el instanceof Element)) return;
  clearPending(el);
  const evt = inputEvent(el);
  if (evt) push(evt);
  snapshotSoon('change');
}, { capture: true, passive: true });

document.addEventListener('input', (e) => {
  const el = hit(e);
  if (!el) return;
  if (el instanceof HTMLInputElement && el.type === 'password') {
    if (el.value) secrets.add(el.value);
    return;
  }
  if (!textLike(el)) return;
  clearPending(el);
  pending.set(el, window.setTimeout(() => recordTyped(el), TYPING_PAUSE));
}, { capture: true, passive: true });

// A form that navigates (a classic POST) never crosses the network tap and
// the webRequest listener sees no body, so what it sent is reconstructed
// from its fields here. A hidden field's value is a token by convention: it
// is named, never kept. Passwords never leave the page.
function describeForm(form: HTMLFormElement): Evt {
  const fields: Evt[] = [];
  for (const el of Array.from(form.elements).slice(0, 80)) {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) || !el.name) continue;
    if (el instanceof HTMLInputElement) {
      if (el.type === 'password') { if (el.value) secrets.add(el.value); fields.push({ name: el.name, value: '[REDACTED]' }); continue; }
      if (el.type === 'hidden') { fields.push({ name: el.name, hidden: true }); continue; }
      if (/^(file|submit|button|image|reset)$/.test(el.type)) continue;
      if ((el.type === 'checkbox' || el.type === 'radio') && !el.checked) continue;
    }
    const f: Evt = { name: el.name, value: scrub(el.value)?.slice(0, 500) };
    if (el instanceof HTMLSelectElement) {
      const label = el.selectedOptions[0]?.text?.trim();
      if (label) f.label = label.slice(0, 120);
    }
    fields.push(f);
  }
  // Attribute reads, not properties: a field named "action" or "method"
  // shadows the form's own.
  const d: Evt = {
    method: (form.getAttribute('method') || 'get').toUpperCase(),
    action: new URL(form.getAttribute('action') || '', location.href).href,
    fields,
  };
  const enctype = form.getAttribute('enctype');
  if (enctype) d.enctype = enctype;
  return d;
}

document.addEventListener('submit', (e) => {
  flushTyped();
  const form = e.target as Element;
  if (form instanceof HTMLFormElement) push({ kind: 'action', action: 'submit', target: describe(form), form: describeForm(form) });
  else if (form instanceof Element) push({ kind: 'action', action: 'submit', target: describe(form) });
  snapshotSoon('change');
}, { capture: true, passive: true });

// form.submit() from script fires no submit event, so the MAIN-world tap names
// the form and it is described here exactly as a real submit is. The tap never
// dispatches a synthetic event: the page's own listeners must not run twice.
window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window || e.data?.__wfr !== 'submit') return;
  const form = document.forms[e.data.index as number];
  if (!(form instanceof HTMLFormElement)) return;
  flushTyped();
  push({ kind: 'action', action: 'submit', target: describe(form), form: describeForm(form) });
  snapshotSoon('change');
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  flushTyped();
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
  if (net.resHeaders && typeof net.resHeaders === 'object') {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(net.resHeaders as Record<string, string>)) {
      if (/cookie|authorization|x-api-key|bearer/i.test(k)) continue;
      clean[k] = String(v).slice(0, 500);
    }
    if (Object.keys(clean).length) evt.resHeaders = clean; else delete evt.resHeaders;
  }
  push(evt);
  // Data that just arrived is about to change the page; look once it has.
  if (typeof net.status === 'number' && net.status < 400) snapshotSoon('response');
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
  if (was && !next.on) { flushTyped(); takeSnapshot('stop'); }
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

window.addEventListener('pagehide', () => { flushTyped(); takeSnapshot('leave'); flush(); });

chrome.runtime.sendMessage({ type: 'get-state' })
  .then((state) => { if (state?.on) setState(state); })
  .catch(() => { /* worker not ready; popup start will notify us */ });

export {};
