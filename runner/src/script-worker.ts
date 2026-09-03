// The thread a session script runs in. It owns the vm context and nothing
// else: every capability (a request, a page, the site's bearer) is asked of
// the parent over the message port, so this thread holds no browser, no
// sockets and no state worth reaching. Its reason for existing is the one
// thing a timer cannot do: a script that loops forever blocks only this
// thread, and the parent's deadline terminates it.
import { readFileSync } from 'node:fs';
import { createContext, constants, Script } from 'node:vm';
import { parentPort, workerData } from 'node:worker_threads';

type Build = (
  invoke: (target: string, method: string, args: string) => Promise<string>,
  parseUrl: (href: string, base?: string) => string,
  inputsJson: string,
) => { start: (run: unknown) => Promise<string> };

const COMPILE_TIMEOUT_MS = 5_000;

const port = parentPort!;
const { source, inputs } = workerData as { source: string; inputs: Record<string, string> };

let nextId = 0;
const waiting = new Map<number, (reply: string) => void>();
port.on('message', (m: { id: number; reply: string }) => {
  const resolve = waiting.get(m.id);
  waiting.delete(m.id);
  resolve?.(m.reply);
});

const invoke = (target: string, method: string, args: string) =>
  new Promise<string>((resolve) => {
    const id = ++nextId;
    waiting.set(id, resolve);
    port.postMessage({ id, target, method, args });
  });

// URL parsing is exact because it is the host's own, and only strings cross.
const parseUrl = (href: string, base?: string): string => {
  try {
    const u = new URL(String(href), base === undefined ? undefined : String(base));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return JSON.stringify({ e: `only http(s) URLs are supported here (got ${u.protocol})` });
    const { protocol, username, password, hostname, port: p, pathname, search, hash } = u;
    return JSON.stringify({ v: { protocol, username, password, hostname, port: p, pathname, search, hash } });
  } catch {
    return JSON.stringify({ e: `Invalid URL: ${String(href).slice(0, 200)}` });
  }
};

// The outcome is JSON text, {"v":rows} or {"e":message,"stack":…}, built in
// the context and passed straight through, never re-parsed here.
const done = (json: string) => port.postMessage({ done: json });

// DONT_CONTEXTIFY gives the context an ordinary global object rather than a
// proxy over a host object: with a host sandbox, globalThis.constructor is
// the HOST's Object, and its own .constructor compiles code in this realm.
const context = createContext(constants.DONT_CONTEXTIFY, { name: 'session-script' });

try {
  const build = new Script(readFileSync(new URL('./sandbox.js', import.meta.url), 'utf8'), { filename: 'sandbox.js' })
    .runInContext(context) as Build;
  // Built before the script is compiled, so the globals it adds are there for
  // the script's top level and the intrinsics it captured are still pristine.
  const sandbox = build(invoke, parseUrl, JSON.stringify(inputs));
  // A stray `export` before run() is tolerated so a module-flavoured draft loads.
  const src = source.replace(/^\s*export\s+(async\s+function\s+run\b)/m, '$1');
  const run = new Script(`${src}\n;(typeof run === 'function' ? run : undefined)`, { filename: 'automation.mjs' })
    .runInContext(context, { timeout: COMPILE_TIMEOUT_MS });
  if (typeof run !== 'function') {
    done(JSON.stringify({ e: 'the script must define `async function run(ctx)`' }));
  } else {
    done(await sandbox.start(run));
  }
} catch (e) {
  const err = e as Error;
  done(JSON.stringify({ e: err?.message || String(e), stack: err?.stack ?? '' }));
}
