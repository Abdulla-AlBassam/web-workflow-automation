// Scenario-matrix fixture: one server, seven mini-sites, each mimicking a
// distinct real-world site shape the analyser must handle (or refuse). Used by
// e2e/matrix.e2e.mjs; never exposed beyond localhost.
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 4985);

const ROWS = [
  { id: 'a1', name: "O'Brien & Sons (Holdings)", city: 'Manama', active: true, tags: ['import', 'export'], notes: null },
  { id: 'a2', name: 'Smith + Jones Ltd', city: 'Riffa', active: false, tags: [], notes: 'était & öß' },
  { id: 'a3', name: 'شركة المنامة للتجارة', city: 'المنامة', active: true, tags: ['تجارة'], notes: null },
  { id: 'a4', name: 'بيت الخليج للأغذية', city: 'المحرق', active: true, tags: [], notes: null },
  { id: 'a5', name: 'Gulf Gum Trading', city: 'Hidd', active: true, tags: ['fmcg'], notes: null },
  ...Array.from({ length: 7 }, (_, i) => ({
    id: `g${i + 1}`, name: `Gum Traders ${i + 1}`, city: 'Sitra', active: true, tags: [], notes: null,
  })),
];

const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJhbm9uIjp0cnVlLCJzY29wZSI6InB1YmxpYyJ9.c2lnbmF0dXJl';

const byName = (q) => (q ? ROWS.filter((r) => r.name.toLowerCase().includes(q.toLowerCase())) : []);

const page = (title, body, attrs = '') => `<!doctype html>
<html lang="en" ${attrs}><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:14px system-ui;margin:24px}td,th{padding:4px 10px;text-align:left}</style></head>
<body><h1>${title}</h1>${body}</body></html>`;

const searchUI = (script) => `
<input id="q"><button id="go">Search</button>
<table id="results"><tbody></tbody></table>
<script>
const render = (rows) => {
  document.querySelector('#results tbody').innerHTML =
    rows.map((r) => '<tr><td>' + r.id + '</td><td>' + r.name + '</td><td>' + r.city + '</td></tr>').join('');
};
document.getElementById('go').addEventListener('click', ${script});
</script>`;

const json = (res, body) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const readBody = (req) => new Promise((resolve) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => resolve(b));
});

createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;

  // Health probe for the suite.
  if (p === '/') return json(res, { ok: true });

  // 1. Algolia shape: the query hides inside one composite string field.
  if (p === '/algolia/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(page('Bundle Search', searchUI(`async () => {
      const r = await fetch('/algolia/api/query', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ indexName: 'companies', params: 'query=' + encodeURIComponent(q.value) + '&hitsPerPage=30&page=0' }) });
      render((await r.json()).hits);
    }`)));
  }
  if (p === '/algolia/api/query' && req.method === 'POST') {
    const params = new URLSearchParams(JSON.parse(await readBody(req)).params ?? '');
    const hits = byName(params.get('query'));
    return json(res, { nbHits: hits.length, hits });
  }

  // 2. Classic form-encoded POST (legacy AJAX shape).
  if (p === '/form/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(page('Form Search', searchUI(`async () => {
      const r = await fetch('/form/api/search', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ name: q.value, lang: 'en' }).toString() });
      render((await r.json()).rows);
    }`)));
  }
  if (p === '/form/api/search' && req.method === 'POST') {
    const form = new URLSearchParams(await readBody(req));
    const rows = byName(form.get('name'));
    return json(res, { total: rows.length, rows });
  }

  // 3. Arabic UI and data: JSON body, non-ASCII values end to end.
  if (p === '/arabic/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(page('السجل التجاري', searchUI(`async () => {
      const r = await fetch('/arabic/api/search', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: q.value }) });
      render((await r.json()).rows);
    }`), 'dir="rtl"').replace('lang="en"', 'lang="ar"'));
  }
  if (p === '/arabic/api/search' && req.method === 'POST') {
    const rows = byName(JSON.parse(await readBody(req)).name);
    return json(res, { total: rows.length, rows });
  }

  // 4. Token-gated API: the page mints an anonymous bearer into localStorage;
  // the API rejects calls without it (the Sijilat shape).
  if (p === '/tokened/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(page('Gated Search', searchUI(`async () => {
      const r = await fetch('/tokened/api/search', { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + localStorage.getItem('accessToken') },
        body: JSON.stringify({ q: q.value }) });
      render((await r.json()).rows);
    }`) + `<script>localStorage.setItem('accessToken', '${FAKE_JWT}');</script>`));
  }
  if (p === '/tokened/api/search' && req.method === 'POST') {
    if (req.headers.authorization !== `Bearer ${FAKE_JWT}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end('{"error":"missing bearer"}');
    }
    const rows = byName(JSON.parse(await readBody(req)).q);
    return json(res, { total: rows.length, rows });
  }

  // 5. Server-rendered results: a full form navigation, no API anywhere.
  // The honest response is a refusal, never a hollow spec.
  if (p === '/ssr/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(page('Old-School Search',
      '<form action="/ssr/results" method="get"><input id="q" name="q"><button id="go">Search</button></form>'));
  }
  if (p === '/ssr/results') {
    const rows = byName(url.searchParams.get('q'));
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(page('Results', `<table><tbody>${
      rows.map((r) => `<tr><td>${r.id}</td><td>${r.name}</td></tr>`).join('')
    }</tbody></table>`));
  }

  // 6. Awkward data: specials in the typed value (URL-borne) and nulls,
  // booleans and nested arrays in the rows.
  if (p === '/quirks/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(page('Quirky Search', searchUI(`async () => {
      const r = await fetch('/quirks/api?term=' + encodeURIComponent(q.value));
      render((await r.json()).rows);
    }`)));
  }
  if (p === '/quirks/api') {
    const rows = byName(url.searchParams.get('term'));
    return json(res, { total: rows.length, rows });
  }

  // 7. Paged API: page field in the body, total in the response, 3 per page.
  if (p === '/paged/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(page('Paged Search', searchUI(`async () => {
      const r = await fetch('/paged/api/search', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ q: q.value, page: 1 }) });
      render((await r.json()).items);
    }`)));
  }
  if (p === '/paged/api/search' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const all = byName(body.q);
    const pg = Math.max(1, Number(body.page) || 1);
    return json(res, { total: all.length, items: all.slice((pg - 1) * 3, pg * 3) });
  }

  res.writeHead(404).end();
}).listen(PORT, () => console.log(`scenario sites on http://127.0.0.1:${PORT}`));
