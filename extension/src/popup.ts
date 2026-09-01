const $ = (id: string) => document.getElementById(id)!;

const sessionInput = $('session') as HTMLInputElement;
const hostsInput = $('hosts') as HTMLInputElement;
const toggle = $('toggle') as HTMLButtonElement;

function parseHosts(raw: string): string[] {
  return raw.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
}

function render(state: { on: boolean; session: string; count: number; error: string }) {
  const badge = $('badge');
  badge.textContent = state.on ? 'Recording' : 'Idle';
  badge.className = state.on ? 'badge badge-rec' : 'badge badge-idle';
  $('form').hidden = state.on;
  $('live').hidden = !state.on;
  toggle.textContent = state.on ? 'Stop recording' : 'Start recording';
  toggle.className = state.on ? 'btn btn-stop' : 'btn btn-start';
  if (state.on) {
    $('stat-session').textContent = state.session;
    $('stat-count').textContent = String(state.count);
    const err = $('error');
    err.hidden = !state.error;
    err.textContent = state.error ? `Delivery problem: ${state.error}` : '';
  }
}

async function refresh() {
  render(await chrome.runtime.sendMessage({ type: 'status' }));
}

toggle.addEventListener('click', async () => {
  const state = await chrome.runtime.sendMessage({ type: 'status' });
  if (state.on) {
    await chrome.runtime.sendMessage({ type: 'stop' });
    // Land the operator on the session page, where the analysis and the
    // generated automation are already waiting.
    await chrome.tabs.create({ url: `http://127.0.0.1:4823/session/${state.session}` });
    await refresh();
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith('http')) {
    alert('Open the target page in the active tab first.');
    return;
  }
  const session = sessionInput.value.trim() || `s-${crypto.randomUUID().slice(0, 8)}`;
  const hosts = parseHosts(hostsInput.value);
  if (!hosts.length) {
    alert('At least one allowed host is required.');
    return;
  }
  const res = await chrome.runtime.sendMessage({ type: 'start', session, hosts, tabId: tab.id });
  if (!res.ok) {
    const err = $('error');
    $('live').hidden = false;
    err.hidden = false;
    err.textContent = `Could not start: ${res.error}`;
    return;
  }
  await refresh();
});

// Prefill the allowlist from the active tab: the bare domain covers the page
// and its API subdomains (the matcher treats "x.bh" as including "api.x.bh").
async function prefillHosts() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.startsWith('http')) return;
  hostsInput.value = new URL(tab.url).hostname.replace(/^www\./, '');
}

chrome.storage.session.onChanged.addListener(refresh);
refresh();
prefillHosts();

export {};
