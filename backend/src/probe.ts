import { replayableHeaders } from './redact.js';

// Classifies the direct-request path: replay the outcome request with its body
// and the headers the page itself set, but no auth. 2xx means the direct call
// stands alone; 401/403 means a token step is needed first. Deterministic,
// one call, no credentials sent. Sending the recorded headers matters: a 403
// caused by a missing app id would otherwise be misread as a missing bearer.
export async function probeAuth(call: { url: string; method: string; reqBody?: string; reqHeaders?: Record<string, string> }): Promise<number> {
  const res = await fetch(call.url, {
    method: call.method,
    headers: requestHeaders(call.reqHeaders, call.reqBody),
    body: call.reqBody,
  });
  return res.status;
}

// The header set a replay sends: the recorded ones (already filtered of
// credentials and browser-managed names), an accept if the page set none,
// and a content type for a body if the page set none. Shared with the
// generator so the probe classifies exactly the request the spec will make.
export function requestHeaders(recorded: Record<string, string> | undefined, reqBody: string | undefined, formBody = false): Record<string, string> {
  const out: Record<string, string> = { accept: '*/*', ...replayableHeaders(recorded) };
  if (reqBody !== undefined && !out['content-type']) {
    out['content-type'] = formBody ? 'application/x-www-form-urlencoded' : 'application/json; charset=utf-8';
  }
  if (reqBody === undefined) delete out['content-type'];
  return out;
}
