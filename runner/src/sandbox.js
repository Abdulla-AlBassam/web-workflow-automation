// Everything a session script can see. This file is never imported: it is read
// as text and evaluated INSIDE the vm context, so ctx, the page handles, URL
// and every error thrown here belong to the context's own realm. Script code
// can reach nothing of the host. The two host functions below are held in
// this closure, take strings and hand back strings, and are the only way out:
//
//   invoke(target, method, argsJson) → promise of JSON text, {"v":…} or {"e":…}
//   parseUrl(href, base)             → JSON text, the host URL parser's answer
//
// A bare context has JavaScript's own intrinsics and nothing else: no timers,
// no fetch, no URL. What a script legitimately needs beyond them is built here.
(function build(invoke, parseUrl, inputsJson) {
  // Captured before the session script is compiled into this context, so a
  // script that overwrites a global cannot redirect the bridge.
  const { parse, stringify } = JSON;
  const CtxError = Error;
  const CtxTypeError = TypeError;

  const text = (v) => { try { return typeof v === 'string' ? v : String(v); } catch { return ''; } };
  const note = (v) => { if (typeof v === 'string') return v; try { return stringify(v) ?? text(v); } catch { return text(v); } };
  // A trailing undefined would arrive as null and defeat the host's defaults.
  const pack = (args) => { while (args.length && args[args.length - 1] === undefined) args.pop(); return args; };

  async function call(target, method, args) {
    const reply = parse(await invoke(target, method, stringify(args)));
    if (reply.e !== undefined) throw new CtxError(reply.e);
    return reply.v;
  }

  const decode = (s) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; } };
  const encode = (s) => encodeURIComponent(s)
    .replace(/[!'()~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%20/g, '+');

  class URLSearchParams {
    constructor(init) {
      this.p = [];
      if (init === undefined || init === null || typeof init === 'string') {
        for (const part of text(init === undefined || init === null ? '' : init).replace(/^\?/, '').split('&')) {
          if (!part) continue;
          const i = part.indexOf('=');
          this.p.push(i < 0 ? [decode(part), ''] : [decode(part.slice(0, i)), decode(part.slice(i + 1))]);
        }
      } else if (Array.isArray(init)) {
        for (const [k, v] of init) this.p.push([text(k), text(v)]);
      } else {
        for (const k of Object.keys(init)) this.p.push([k, text(init[k])]);
      }
    }
    append(key, value) { this.p.push([text(key), text(value)]); }
    delete(key) { const k = text(key); this.p = this.p.filter((e) => e[0] !== k); }
    set(key, value) { this.delete(key); this.append(key, value); }
    get(key) { const e = this.p.find((x) => x[0] === text(key)); return e ? e[1] : null; }
    getAll(key) { return this.p.filter((x) => x[0] === text(key)).map((x) => x[1]); }
    has(key) { return this.p.some((x) => x[0] === text(key)); }
    forEach(fn) { for (const [k, v] of this.p) fn(v, k, this); }
    entries() { return this.p.map((e) => [e[0], e[1]])[Symbol.iterator](); }
    keys() { return this.p.map((e) => e[0])[Symbol.iterator](); }
    values() { return this.p.map((e) => e[1])[Symbol.iterator](); }
    [Symbol.iterator]() { return this.entries(); }
    get size() { return this.p.length; }
    toString() { return this.p.map(([k, v]) => encode(k) + '=' + encode(v)).join('&'); }
  }

  // http(s) only, like everything else the sandbox contacts. The parse is the
  // host's real one, so what comes back is exact; anything else throws rather
  // than being approximated.
  class URL {
    constructor(href, base) {
      const r = parse(parseUrl(text(href), base === undefined || base === null ? undefined : text(base)));
      if (r.e !== undefined) throw new CtxTypeError(r.e);
      this.protocol = r.v.protocol;
      this.username = r.v.username;
      this.password = r.v.password;
      this.hostname = r.v.hostname;
      this.port = r.v.port;
      this.pathname = r.v.pathname;
      this.hash = r.v.hash;
      this.query = new URLSearchParams(r.v.search);
    }
    get host() { return this.port ? this.hostname + ':' + this.port : this.hostname; }
    get origin() { return this.protocol + '//' + this.host; }
    get searchParams() { return this.query; }
    get search() { const s = this.query.toString(); return s ? '?' + s : ''; }
    set search(v) { this.query = new URLSearchParams(text(v)); }
    get href() {
      const auth = this.username ? this.username + (this.password ? ':' + this.password : '') + '@' : '';
      return this.protocol + '//' + auth + this.host + this.pathname + this.search + this.hash;
    }
    toString() { return this.href; }
    toJSON() { return this.href; }
  }

  // One page, addressed by the id the host gave it. Every reply carries the
  // page's current URL so url() can stay synchronous, as it was.
  function page(id, at) {
    let here = at;
    const act = async (method, ...args) => {
      const r = await call('page', method, pack([id, ...args]));
      here = r.u;
      return r.r;
    };
    return {
      goto: (url) => act('goto', url),
      fill: (selector, value) => act('fill', selector, value),
      click: (selector) => act('click', selector),
      press: (selector, key) => act('press', selector, key),
      waitFor: (selector, ms) => act('waitFor', selector, ms),
      wait: (ms) => act('wait', ms),
      text: (selector) => act('text', selector),
      texts: (selector) => act('texts', selector),
      html: (selector) => act('html', selector),
      attr: (selector, name) => act('attr', selector, name),
      eval: (expression) => act('eval', expression),
      url: () => here,
      close: () => act('close'),
    };
  }

  const ctx = {
    inputs: parse(inputsJson),
    http: {
      async fetch(url, init) {
        const r = await call('http', 'fetch', pack([url, init]));
        const body = r.text;
        r.json = () => parse(body);
        return r;
      },
    },
    browser: {
      async open(url) { const r = await call('browser', 'open', [url]); return page(r.id, r.u); },
    },
    async dom(html) { const r = await call('browser', 'dom', [html]); return page(r.id, r.u); },
    site: {
      token(pageUrl) { return call('site', 'token', [pageUrl]); },
    },
    log(...args) { call('ctx', 'log', [args.map(note)]).catch(() => {}); },
    sleep(ms) { return call('ctx', 'sleep', [ms]); },
  };

  globalThis.URL = URL;
  globalThis.URLSearchParams = URLSearchParams;

  // The script's rows and its failures leave as JSON text, so not even an
  // error object crosses the boundary.
  return {
    async start(run) {
      try {
        const rows = await run(ctx);
        return stringify({ v: rows === undefined ? null : rows });
      } catch (e) {
        const message = e && e.message !== undefined ? text(e.message) : text(e);
        return stringify({ e: message || 'the script threw', stack: e ? text(e.stack) : '' });
      }
    },
  };
});
