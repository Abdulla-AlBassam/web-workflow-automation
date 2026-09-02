// Defence in depth: the extension already scrubs at capture. The backend
// enforces the same promises on whatever actually arrives: no header-shaped
// secrets, bodies within the cap. Every host is kept; the recording's own
// hosts (meta.hosts) name the site, not a filter.

const REQ_CAP = 256 * 1024;
const RES_CAP = 2 * 1024 * 1024;
const FORBIDDEN_KEYS = /cookie|authorization|x-api-key|bearer/i;

// Headers the browser manages on its own (or that node's fetch sets from the
// body): never worth carrying into a replay, and some cannot be set at all.
const BROWSER_MANAGED = /^(host|origin|referer|user-agent|connection|content-length|accept-encoding|te|upgrade|via|sec-.*|proxy-.*)$/i;

// The recorded request headers a replay should send: what the page's own
// code set, minus anything credential-shaped or browser-managed. Keys are
// lowercased so a spec, the probe and the runner agree on them.
export function replayableHeaders(h: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h || typeof h !== 'object') return out;
  for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
    const key = k.toLowerCase();
    if (FORBIDDEN_KEYS.test(key) || BROWSER_MANAGED.test(key)) continue;
    if (typeof v !== 'string') continue;
    out[key] = v;
  }
  return out;
}

export function hostAllowed(url: unknown, hosts: string[]): boolean {
  if (typeof url !== 'string') return false;
  try {
    const h = new URL(url).hostname;
    return hosts.some((a) => h === a || h.endsWith('.' + a));
  } catch {
    return false;
  }
}

// A body over the cap is cut and the cut declared (the full length kept
// alongside), never silently shortened.
function capBody(out: Record<string, unknown>, key: 'reqBody' | 'resBody', limit: number) {
  const v = out[key];
  if (typeof v !== 'string' || v.length <= limit) return;
  const flag = key === 'reqBody' ? 'reqTruncated' : 'resTruncated';
  out[flag] = Math.max(Number(out[flag]) || 0, v.length);
  out[key] = v.slice(0, limit);
}

// Returns the sanitised event, or undefined when the event must be dropped.
export function sanitise(evt: Record<string, unknown>, _hosts: string[]): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(evt)) {
    if (FORBIDDEN_KEYS.test(k)) continue;
    out[k] = v;
  }
  // Captured request headers are kept only by name and value the runner may
  // send back; a credential that slipped past the extension is dropped here.
  if (out.reqHeaders !== undefined) {
    const clean = replayableHeaders(out.reqHeaders);
    if (Object.keys(clean).length) out.reqHeaders = clean; else delete out.reqHeaders;
  }
  if (out.kind === 'net' || out.kind === 'net_meta') {
    if (typeof out.url !== 'string' || !/^https?:\/\//.test(out.url)) return undefined;
    capBody(out, 'reqBody', REQ_CAP);
    capBody(out, 'resBody', RES_CAP);
  }
  return out;
}
