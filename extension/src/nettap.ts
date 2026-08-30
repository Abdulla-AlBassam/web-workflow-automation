// Runs in the page's MAIN world: the only place response bodies are readable.
// Emits captured calls to the isolated recorder via postMessage; touches no chrome APIs.

const REQ_CAP = 64 * 1024;
const RES_CAP = 256 * 1024;

let on = false;
let hosts: string[] = [];

window.addEventListener('message', (e: MessageEvent) => {
  if (e.source === window && e.data?.__wfr === 'state') {
    on = !!e.data.on;
    hosts = Array.isArray(e.data.hosts) ? e.data.hosts : [];
  }
});

function allowed(url: string): boolean {
  try {
    const h = new URL(url, location.href).hostname;
    return hosts.some((a) => h === a || h.endsWith('.' + a));
  } catch {
    return false;
  }
}

function cap(s: string | undefined, limit: number): string | undefined {
  if (s === undefined) return undefined;
  return s.length > limit ? s.slice(0, limit) + `…[truncated ${s.length} chars]` : s;
}

function bodyToString(body: unknown): string | undefined {
  if (body == null) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof FormData) {
    const o: Record<string, string> = {};
    body.forEach((v, k) => { o[k] = typeof v === 'string' ? v : `[file:${v.name}]`; });
    return JSON.stringify(o);
  }
  if (body instanceof Blob) return `[blob ${body.size}b ${body.type}]`;
  if (body instanceof ArrayBuffer) return `[arraybuffer ${body.byteLength}b]`;
  return String(body);
}

function emit(net: Record<string, unknown>) {
  window.postMessage({ __wfr: 'net', net }, '*');
}

const origFetch = window.fetch;
window.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
  const req = new Request(input as RequestInfo, init);
  const record = on && allowed(req.url);
  let reqBody: string | undefined;
  if (record) {
    reqBody = bodyToString(init?.body);
    if (reqBody === undefined && req.method !== 'GET' && req.method !== 'HEAD') {
      try { reqBody = await req.clone().text(); } catch { /* opaque body */ }
    }
  }
  const started = Date.now();
  const res = await origFetch.call(this, input as RequestInfo, init);
  if (record) {
    let resBody: string | undefined;
    try { resBody = await res.clone().text(); } catch { /* stream already locked */ }
    emit({
      api: 'fetch', method: req.method, url: req.url, status: res.status,
      contentType: res.headers.get('content-type'),
      reqBody: cap(reqBody, REQ_CAP), resBody: cap(resBody, RES_CAP),
      started, ended: Date.now(),
    });
  }
  return res;
};

const origOpen = XMLHttpRequest.prototype.open;
const origSend = XMLHttpRequest.prototype.send;

XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: unknown[]) {
  (this as any).__wfr = { method, url: String(url) };
  return (origOpen as any).apply(this, [method, url, ...rest]);
};

XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
  const info = (this as any).__wfr;
  if (info && on && allowed(info.url)) {
    info.started = Date.now();
    info.reqBody = bodyToString(body);
    this.addEventListener('loadend', () => {
      let resBody: string | undefined;
      try {
        if (this.responseType === '' || this.responseType === 'text') resBody = this.responseText;
      } catch { /* responseType forbids text access */ }
      emit({
        api: 'xhr', method: info.method, url: new URL(info.url, location.href).href,
        status: this.status, contentType: this.getResponseHeader('content-type'),
        reqBody: cap(info.reqBody, REQ_CAP), resBody: cap(resBody, RES_CAP),
        started: info.started, ended: Date.now(),
      });
    });
  }
  return origSend.call(this, body as any);
};

export {};
