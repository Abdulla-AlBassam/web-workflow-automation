// Defence in depth: the extension already scrubs and allowlists at capture.
// The backend enforces the same promises on whatever actually arrives.

const REQ_CAP = 64 * 1024;
const RES_CAP = 256 * 1024;
const FORBIDDEN_KEYS = /cookie|authorization|x-api-key|bearer/i;

export function hostAllowed(url: unknown, hosts: string[]): boolean {
  if (typeof url !== 'string') return false;
  try {
    const h = new URL(url).hostname;
    return hosts.some((a) => h === a || h.endsWith('.' + a));
  } catch {
    return false;
  }
}

function capStr(v: unknown, limit: number): unknown {
  return typeof v === 'string' && v.length > limit ? v.slice(0, limit) + '…[truncated]' : v;
}

// Returns the sanitised event, or undefined when the event must be dropped.
export function sanitise(evt: Record<string, unknown>, hosts: string[]): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(evt)) {
    if (FORBIDDEN_KEYS.test(k)) continue;
    out[k] = v;
  }
  if (out.kind === 'net' || out.kind === 'net_meta') {
    if (!hostAllowed(out.url, hosts)) return undefined;
    out.reqBody = capStr(out.reqBody, REQ_CAP);
    out.resBody = capStr(out.resBody, RES_CAP);
  }
  return out;
}
