// Runs in the page's MAIN world: the only place response bodies are readable.
// Emits captured calls to the isolated recorder via postMessage; touches no chrome APIs.
//
// Every fetch/XHR the page makes is captured, whatever host it goes to: the
// data behind a search often lives on a different domain from the page (a
// search-as-a-service host, an API subdomain nobody allowlisted). Ranking by
// the typed value, downstream, separates the outcome call from the noise.

const REQ_CAP = 256 * 1024;
const RES_CAP = 2 * 1024 * 1024;

let on = false;

window.addEventListener('message', (e: MessageEvent) => {
  if (e.source === window && e.data?.__wfr === 'state') {
    on = !!e.data.on;
  }
});

function allowed(url: string): boolean {
  try {
    const u = new URL(url, location.href);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// A body over the cap is cut, and the cut is declared: the event carries the
// full length so nothing downstream mistakes a cut body for the whole thing.
function cap(s: string | undefined, limit: number): { body: string | undefined; total?: number } {
  if (s === undefined) return { body: undefined };
  return s.length > limit ? { body: s.slice(0, limit), total: s.length } : { body: s };
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
    const rq = cap(reqBody, REQ_CAP);
    const rs = cap(resBody, RES_CAP);
    emit({
      api: 'fetch', method: req.method, url: req.url, status: res.status,
      contentType: res.headers.get('content-type'),
      reqBody: rq.body, resBody: rs.body,
      ...(rq.total ? { reqTruncated: rq.total } : {}), ...(rs.total ? { resTruncated: rs.total } : {}),
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
      const rq = cap(info.reqBody, REQ_CAP);
      const rs = cap(resBody, RES_CAP);
      emit({
        api: 'xhr', method: info.method, url: new URL(info.url, location.href).href,
        status: this.status, contentType: this.getResponseHeader('content-type'),
        reqBody: rq.body, resBody: rs.body,
        ...(rq.total ? { reqTruncated: rq.total } : {}), ...(rs.total ? { resTruncated: rs.total } : {}),
        started: info.started, ended: Date.now(),
      });
    });
  }
  return origSend.call(this, body as any);
};

export {};
