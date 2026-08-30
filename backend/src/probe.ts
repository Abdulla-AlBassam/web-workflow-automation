// Classifies the direct-request path: replay the outcome request with its body
// but no auth. 2xx means the direct call stands alone; 401/403 means a token
// step is needed first. Deterministic, one call, no credentials sent.
export async function probeAuth(call: { url: string; method: string; reqBody?: string }): Promise<number> {
  const res = await fetch(call.url, {
    method: call.method,
    headers: { 'content-type': 'application/json; charset=utf-8', accept: '*/*' },
    body: call.reqBody,
  });
  return res.status;
}
