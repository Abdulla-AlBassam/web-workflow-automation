// Session scripts: a small program the LLM repair assistant writes for ONE
// recording when the deterministic pipeline cannot derive an automation. It
// lives in that session's folder, receives the run's inputs, and returns
// rows. It runs here, in a vm context that exposes nothing of the machine:
// no files, no environment, no modules — only the two capabilities below.
//
//   http.fetch(url, { method, headers, body })  → { status, ok, contentType, text, json() }
//   browser.open(url)                          → a page handle (fill/click/press/wait/text/texts/html/attr/eval/url)
//   dom(html)                                  → the same handle over HTML the script already holds, no network
//   site.token(pageUrl)                        → the anonymous bearer the site mints for every visitor
//
// The token is the one credential a script may send: read from the site's
// own web storage after loading the page (the runner's browser-token step),
// never typed by anyone. An authorization header carrying anything else is
// dropped.
//
// Hosts: on the acceptance run (hosts undefined) any http(s) host may be
// contacted and the hosts actually used are collected; the saved spec keeps
// that list and every later run is confined to it. Credential-shaped headers
// are dropped whatever the script asks for.
//
// This is isolation against accidents, not a hardened sandbox: the code is
// written by the assistant under this tool's instructions, shown in full on
// the session page, and executed only after it reproduced the recording.
import { createContext, Script } from 'node:vm';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { UA, readBearerViaBrowser, type Bearer } from './browser-token.js';

export type ScriptOk = { rows: Record<string, unknown>[]; hosts: string[]; log: string[]; ms: number };
export type ScriptFail = { error: string; hosts: string[]; log: string[] };
export type ScriptResult = ScriptOk | ScriptFail;

export type ScriptOptions = {
  inputs: Record<string, string>;
  hosts?: string[];
  timeoutMs?: number;
  // How the anonymous bearer is obtained (the backend caches per origin).
  readToken?: (loadUrl: string) => Promise<Bearer | undefined>;
};

const FORBIDDEN_HEADER = /cookie|authorization|x-api-key|proxy-authorization/i;
const REQUEST_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 15_000;
const MAX_ROWS = 5000;
const MAX_TEXT = 200_000;

function hostOf(url: string): string {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`only http(s) URLs may be contacted (got ${u.protocol})`);
  return u.hostname;
}

class HostGuard {
  readonly used = new Set<string>();
  constructor(private readonly allowed: string[] | undefined) {}
  check(url: string) {
    const h = hostOf(url);
    if (this.allowed && !this.allowed.some((a) => h === a || h.endsWith('.' + a))) {
      throw new Error(`host ${h} is outside the hosts this automation was verified against (${this.allowed.join(', ')})`);
    }
    this.used.add(h);
  }
}

// Headers a script asked for, minus anything credential-shaped. The one
// exception is a bearer the site itself issued through site.token().
export function cleanHeaders(h: unknown, issued: Set<string> = new Set()): Record<string, string> {
  const out: Record<string, string> = {};
  if (h && typeof h === 'object') {
    for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
      const value = String(v);
      if (/^authorization$/i.test(k) && issued.has(value.replace(/^Bearer\s+/i, ''))) { out.authorization = value; continue; }
      if (FORBIDDEN_HEADER.test(k)) continue;
      out[k.toLowerCase()] = value;
    }
  }
  if (!out['user-agent']) out['user-agent'] = UA;
  if (!out.accept) out.accept = 'application/json, text/html;q=0.9, */*;q=0.8';
  return out;
}

function makeHttp(guard: HostGuard, signal: AbortSignal, issued: Set<string>) {
  return {
    async fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown }) {
      guard.check(url);
      const method = (init?.method ?? 'GET').toUpperCase();
      const headers = cleanHeaders(init?.headers, issued);
      let body: string | undefined;
      if (init?.body !== undefined && init.body !== null) {
        body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
        if (typeof init.body !== 'string' && !headers['content-type']) headers['content-type'] = 'application/json; charset=utf-8';
      }
      const res = await fetch(url, {
        method, headers, ...(body === undefined ? {} : { body }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
      const text = (await res.text()).slice(0, 8 * 1024 * 1024);
      return {
        status: res.status,
        ok: res.ok,
        url: res.url,
        contentType: res.headers.get('content-type') ?? '',
        text,
        json() { return JSON.parse(text); },
      };
    },
  };
}

type PageHandle = {
  goto(url: string): Promise<void>;
  fill(selector: string, text: string): Promise<void>;
  click(selector: string): Promise<void>;
  press(selector: string, key: string): Promise<void>;
  waitFor(selector: string, ms?: number): Promise<boolean>;
  wait(ms: number): Promise<void>;
  text(selector?: string): Promise<string>;
  texts(selector: string): Promise<string[]>;
  html(selector?: string): Promise<string>;
  attr(selector: string, name: string): Promise<string | null>;
  eval(expression: string): Promise<unknown>;
  url(): string;
  close(): Promise<void>;
};

function makeBrowser(guard: HostGuard, signal: AbortSignal) {
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  const pages: Page[] = [];
  const opts = { timeout: ACTION_TIMEOUT_MS };
  const trim = (s: string) => s.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim().slice(0, MAX_TEXT);

  const handle = (page: Page): PageHandle => ({
    async goto(url) {
      guard.check(url);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    },
    async fill(selector, text) { await page.fill(selector, text, opts); },
    async click(selector) { await page.click(selector, opts); },
    async press(selector, key) { await page.press(selector, key, opts); },
    async waitFor(selector, ms = ACTION_TIMEOUT_MS) {
      return page.waitForSelector(selector, { timeout: ms }).then(() => true).catch(() => false);
    },
    async wait(ms) { await page.waitForTimeout(Math.min(ms, 20_000)); },
    async text(selector) {
      if (!selector) return trim(await page.locator('body').innerText(opts));
      return trim(await page.locator(selector).first().innerText(opts));
    },
    async texts(selector) {
      const all = await page.locator(selector).allInnerTexts();
      return all.map(trim).slice(0, MAX_ROWS);
    },
    async html(selector) {
      if (!selector) return (await page.content()).slice(0, MAX_TEXT);
      const el = page.locator(selector).first();
      return (await el.evaluate((n) => (n as Element).outerHTML, undefined, opts)).slice(0, MAX_TEXT);
    },
    async attr(selector, name) { return page.locator(selector).first().getAttribute(name, opts); },
    async eval(expression) {
      // Runs inside the page, against the site's own document; the result
      // must survive JSON so nothing live crosses back.
      const v = await page.evaluate((src) => {
        // eslint-disable-next-line no-new-func
        const out = new Function(`return (${src});`)();
        return JSON.parse(JSON.stringify(out ?? null));
      }, expression);
      return v;
    },
    url() { return page.url(); },
    async close() { await page.close().catch(() => {}); },
  });

  const newPage = async () => {
    if (signal.aborted) throw new Error('aborted');
    browser ??= await chromium.launch({ headless: true });
    context ??= await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    pages.push(page);
    return page;
  };

  return {
    async open(url: string): Promise<PageHandle> {
      guard.check(url);
      const page = await newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      return handle(page);
    },
    // Server-rendered HTML fetched over http, parsed by a real DOM so the
    // script can query it with selectors. Every subresource is refused: the
    // page is the string, nothing else.
    async fromHtml(html: string): Promise<PageHandle> {
      const page = await newPage();
      await page.route('**/*', (r) => r.abort());
      await page.setContent(String(html).slice(0, 8 * 1024 * 1024), { waitUntil: 'domcontentloaded' });
      return handle(page);
    },
    async dispose() {
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
    },
  };
}

// A browser for callers outside a script (the repair assistant's open_page
// tool): same handle, same host rules, disposed by the caller.
export function browserSession(hosts: string[] | undefined, signal: AbortSignal) {
  return makeBrowser(new HostGuard(hosts), signal);
}

// The script defines `async function run(ctx)`; a stray `export` before it
// is tolerated so a module-flavoured draft still loads.
export function compileScript(source: string): { run: (ctx: unknown) => unknown } {
  const src = source.replace(/^\s*export\s+(async\s+function\s+run\b)/m, '$1');
  const sandbox = {
    JSON, Math, Date, String, Number, Boolean, Array, Object, RegExp, Map, Set, Promise, Symbol,
    URL, URLSearchParams, encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
    parseInt, parseFloat, isNaN, isFinite, Error, TypeError, RangeError, SyntaxError,
    TextEncoder, TextDecoder, structuredClone,
  };
  const context = createContext(sandbox, { name: 'session-script' });
  const script = new Script(`${src}\n;(typeof run === 'function' ? run : undefined)`, { filename: 'automation.mjs' });
  const run = script.runInContext(context, { timeout: 5_000 }) as ((ctx: unknown) => unknown) | undefined;
  if (typeof run !== 'function') throw new Error('the script must define `async function run(ctx)`');
  return { run };
}

function normaliseRows(value: unknown): Record<string, unknown>[] {
  const rows = Array.isArray(value) ? value
    : value && typeof value === 'object' && Array.isArray((value as { rows?: unknown }).rows) ? (value as { rows: unknown[] }).rows
    : undefined;
  if (!rows) throw new Error('run() must return an array of row objects (or { rows: [...] })');
  return rows.slice(0, MAX_ROWS).map((r) => (r && typeof r === 'object' && !Array.isArray(r)
    ? JSON.parse(JSON.stringify(r)) as Record<string, unknown>
    : { value: r }));
}

export async function runScript(source: string, options: ScriptOptions): Promise<ScriptResult> {
  const started = Date.now();
  const log: string[] = [];
  const guard = new HostGuard(options.hosts);
  const abort = new AbortController();
  const browser = makeBrowser(guard, abort.signal);
  const issued = new Set<string>();
  const readToken = options.readToken ?? readBearerViaBrowser;
  const finish = (r: ScriptResult) => r;
  try {
    const { run } = compileScript(source);
    const ctx = {
      inputs: { ...options.inputs },
      http: makeHttp(guard, abort.signal, issued),
      browser: { open: browser.open },
      dom: browser.fromHtml,
      site: {
        async token(pageUrl: string) {
          guard.check(pageUrl);
          const tok = await readToken(pageUrl);
          if (!tok) throw new Error(`site issued no recognisable token after loading ${pageUrl}`);
          issued.add(tok.bearer);
          return tok.bearer;
        },
      },
      log: (...args: unknown[]) => { if (log.length < 200) log.push(args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ').slice(0, 500)); },
      sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(Math.max(0, ms), 20_000))),
    };
    const timeoutMs = options.timeoutMs ?? 90_000;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { abort.abort(); reject(new Error(`the script exceeded ${timeoutMs / 1000}s`)); }, timeoutMs);
    });
    try {
      const value = await Promise.race([Promise.resolve().then(() => run(ctx)), timeout]);
      const rows = normaliseRows(value);
      return finish({ rows, hosts: [...guard.used], log, ms: Date.now() - started });
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch (e) {
    const err = e as Error;
    const where = err.stack?.split('\n').find((l) => l.includes('automation.mjs'))?.trim();
    return finish({ error: `${err.message}${where ? ` (${where})` : ''}`, hosts: [...guard.used], log });
  } finally {
    await browser.dispose();
  }
}

// The string literals of a script: the only place a hard-coded value can
// hide. Property names, identifiers and comments are not data.
export function stringLiterals(source: string): string[] {
  return [...source.matchAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g)].map((m) => m[0].slice(1, -1));
}

// Does a literal carry the recorded value as data? The value must stand as a
// whole token (so "art" never trips on "smart"), and not in key position:
// a value that happens to be an ordinary word ("name", "list") is still
// allowed as a query-string key or a JSON field name inside the literal.
export function literalCarries(literal: string, value: string): boolean {
  const esc = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}_])${esc}(?![\\p{L}\\p{N}_])(?!["']?\\s*[=:])`, 'iu').test(literal);
}

// Static rails checked before a script is ever executed: it must take its
// inputs from ctx.inputs and must not carry the recorded values as literals
// — a script that "works" by hard-coding the demonstration is not an
// automation.
export function lintScript(source: string, inputs: Record<string, string>): string[] {
  const problems: string[] = [];
  if (/\b(require|import)\s*\(/.test(source) || /^\s*import\s/m.test(source)) problems.push('the script must not import or require modules');
  // page.eval is the page handle's own method; a bare eval( is the sandbox's.
  if (/\bprocess\b|\bglobalThis\b|(^|[^.\w])eval\s*\(/.test(source)) problems.push('the script must not reference process, globalThis or eval');
  const literals = stringLiterals(source);
  for (const [name, value] of Object.entries(inputs)) {
    if (!new RegExp(`inputs(\\.${name}\\b|\\[["'\`]${name}["'\`]\\])`).test(source)) {
      problems.push(`the script never reads inputs.${name} — every run's typed value must drive the automation`);
    }
    if (value.length >= 3 && literals.some((lit) => literalCarries(lit, value))) {
      problems.push(`the recorded value "${value}" appears literally in the script — use inputs.${name} instead`);
    }
  }
  return problems;
}
