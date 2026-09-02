// Service worker: session lifecycle, global event ordering, delivery to the
// local backend. State lives in chrome.storage.session because the worker is
// killed after ~30s idle; every event streams out immediately.

const BACKEND = 'http://127.0.0.1:4823';

type State = {
  on: boolean;
  session: string;
  tabId: number;
  hosts: string[];
  seq: number;
  count: number;
  error: string;
};

const IDLE: State = { on: false, session: '', tabId: -1, hosts: [], seq: 0, count: 0, error: '' };

async function getState(): Promise<State> {
  const { state } = await chrome.storage.session.get('state');
  return state ?? { ...IDLE };
}

async function setState(state: State) {
  await chrome.storage.session.set({ state });
}

function allowed(url: string, hosts: string[]): boolean {
  try {
    const h = new URL(url).hostname;
    return hosts.some((a) => h === a || h.endsWith('.' + a));
  } catch {
    return false;
  }
}

// All deliveries run through one chain: interleaved handlers would otherwise
// read the same seq from storage and double-stamp events.
let chain: Promise<void> = Promise.resolve();

function deliver(items: Record<string, unknown>[]): Promise<void> {
  chain = chain.then(async () => {
    const state = await getState();
    if (!state.on) return;
    const stamped = items.map((e) => ({ ...e, session: state.session, seq: state.seq++ }));
    state.count += stamped.length;
    try {
      const res = await fetch(`${BACKEND}/api/sessions/${encodeURIComponent(state.session)}/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: stamped }),
      });
      state.error = res.ok ? '' : `backend ${res.status}`;
    } catch {
      state.error = 'backend unreachable';
    }
    await setState(state);
    await chrome.action.setBadgeText({ text: state.error ? '!' : 'REC' });
  });
  return chain;
}

async function start(opts: { session: string; hosts: string[]; tabId: number }) {
  const startedAt = Date.now();
  const res = await fetch(`${BACKEND}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: opts.session, hosts: opts.hosts, startedAt }),
  }).catch(() => undefined);
  if (!res?.ok) {
    const body = res ? await res.json().catch(() => ({})) : {};
    return { ok: false, error: body.error ?? (res ? `backend ${res.status}` : 'backend unreachable') };
  }
  await setState({
    on: true, session: opts.session, tabId: opts.tabId, hosts: opts.hosts,
    seq: 0, count: 0, error: '',
  });
  await chrome.action.setBadgeBackgroundColor({ color: '#D64545' });
  await chrome.action.setBadgeText({ text: 'REC' });
  await deliver([{ kind: 'session_start', t: startedAt, hosts: opts.hosts }]);
  await chrome.tabs.sendMessage(opts.tabId, { type: 'set-state', on: true, hosts: opts.hosts }).catch(() => {});
  return { ok: true };
}

async function stop() {
  const state = await getState();
  if (!state.on) return { ok: false, error: 'not recording' };
  // The tab takes its final page snapshot on this message; give its batch
  // time to arrive before the stop marker seals the session.
  await chrome.tabs.sendMessage(state.tabId, { type: 'set-state', on: false, hosts: [] }).catch(() => {});
  await new Promise((r) => setTimeout(r, 600));
  await chain;
  await deliver([{ kind: 'session_stop', t: Date.now() }]);
  await fetch(`${BACKEND}/api/sessions/${encodeURIComponent(state.session)}/stop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stoppedAt: Date.now() }),
  }).catch(() => {});
  await setState({ ...IDLE });
  await chrome.action.setBadgeText({ text: '' });
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg?.type === 'start') {
      sendResponse(await start(msg));
    } else if (msg?.type === 'stop') {
      sendResponse(await stop());
    } else if (msg?.type === 'status') {
      sendResponse(await getState());
    } else if (msg?.type === 'get-state') {
      const state = await getState();
      const mine = state.on && sender.tab?.id === state.tabId;
      sendResponse({ on: mine, hosts: mine ? state.hosts : [] });
    } else if (msg?.type === 'events') {
      const state = await getState();
      if (state.on && sender.tab?.id === state.tabId) await deliver(msg.items);
      sendResponse({ ok: true });
    }
  })();
  return true;
});

chrome.webNavigation.onCommitted.addListener(async (details) => {
  const state = await getState();
  if (!state.on || details.tabId !== state.tabId || details.frameId !== 0) return;
  await deliver([{ kind: 'nav', t: Date.now(), url: details.url, transition: details.transitionType }]);
});

chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  const state = await getState();
  if (!state.on || details.tabId !== state.tabId || details.frameId !== 0) return;
  await deliver([{ kind: 'nav', t: Date.now(), url: details.url, transition: 'history' }]);
});

// Metadata-only net evidence: covers traffic the MAIN-world tap cannot see
// (main-frame form posts, redirects, script tags). Bodies come from the tap
// alone. Any host qualifies; static assets are dropped as noise.
const ASSET_TYPES = new Set(['image', 'font', 'stylesheet', 'media', 'ping', 'csp_report']);
chrome.webRequest.onCompleted.addListener(
  (details) => {
    (async () => {
      const state = await getState();
      if (!state.on || details.tabId !== state.tabId) return;
      if (ASSET_TYPES.has(details.type)) return;
      if (details.type === 'xmlhttprequest') return; // tap already captured it with bodies
      await deliver([{
        kind: 'net_meta', t: Date.now(), method: details.method, url: details.url,
        status: details.statusCode, resourceType: details.type,
      }]);
    })();
  },
  { urls: ['<all_urls>'] },
);

// Expose the popup's code paths for the e2e harness, which drives the worker
// directly instead of clicking through the popup document.
(globalThis as unknown as Record<string, unknown>).wfr = { start, stop };

export {};
