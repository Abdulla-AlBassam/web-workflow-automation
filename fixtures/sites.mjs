// Scenario-matrix fixture: one server, twelve mini-sites, each mimicking a
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

// Priced rows for the autosuggest site, where a numeric filter has to mean
// something: the recorded bound keeps one row, a lower bound keeps two.
const PRICED = [
  { id: 'p1', name: 'Gulf Gum Trading', price: 250 },
  { id: 'p2', name: 'Gulf Gum Wholesale', price: 120 },
  { id: 'p3', name: 'Smith + Jones Ltd', price: 900 },
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

  // 8. Header-gated API: the page sends a public app id in a custom header
  // and the API answers 403 without it. Not a credential (it sits in the
  // page's own script), but a replay that drops it would be misread as a
  // missing bearer.
  if (p === '/headered/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(page('App-Id Search', searchUI(`async () => {
      const r = await fetch('/headered/api/search', { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-app-id': 'demo-app', 'accept': 'application/vnd.demo+json' },
        body: JSON.stringify({ q: q.value }) });
      render((await r.json()).rows);
    }`)));
  }
  if (p === '/headered/api/search' && req.method === 'POST') {
    if (req.headers['x-app-id'] !== 'demo-app' || req.headers.accept !== 'application/vnd.demo+json') {
      res.writeHead(403, { 'content-type': 'application/json' });
      return res.end('{"error":"missing app id"}');
    }
    const rows = byName(JSON.parse(await readBody(req)).q);
    return json(res, { total: rows.length, rows });
  }

  // 9. Custom combobox: a contenteditable div, the shape a framework search
  // box takes. It fires no change event at all, so the typed value exists only
  // while it is being typed; Enter sends it.
  if (p === '/combo/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(page('Combobox Search', `
<div id="cb_name" role="combobox" contenteditable="true" aria-label="Company name" style="border:1px solid #999;padding:6px;width:320px"></div>
<table id="results"><tbody></tbody></table>
<script>
document.getElementById('cb_name').addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const r = await fetch('/combo/api/search', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: e.target.innerText.trim() }) });
  document.querySelector('#results tbody').innerHTML =
    (await r.json()).rows.map((x) => '<tr><td>' + x.id + '</td><td>' + x.name + '</td></tr>').join('');
});
</script>`));
  }
  if (p === '/combo/api/search' && req.method === 'POST') {
    const rows = byName(JSON.parse(await readBody(req)).name);
    return json(res, { total: rows.length, rows });
  }

  // 10. Search control inside an open shadow root: every event is retargeted
  // to the host, so only the composed path names the control the operator
  // actually used.
  if (p === '/shadow/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(page('Shadow Search', `
<div id="host"></div>
<script>
const root = document.getElementById('host').attachShadow({ mode: 'open' });
root.innerHTML = '<input id="sd_name"><button id="sd_go">Search</button><table id="results"><tbody></tbody></table>';
root.getElementById('sd_go').addEventListener('click', async () => {
  const r = await fetch('/shadow/api?name=' + encodeURIComponent(root.getElementById('sd_name').value));
  root.querySelector('#results tbody').innerHTML =
    (await r.json()).rows.map((x) => '<tr><td>' + x.id + '</td><td>' + x.name + '</td></tr>').join('');
});
</script>`));
  }
  if (p === '/shadow/api') {
    const rows = byName(url.searchParams.get('name'));
    return json(res, { total: rows.length, rows });
  }

  // 11. A form submitted from script: form.submit() fires no submit event, so
  // without the tap's hook the recording would show a POST navigation and no
  // record of what was sent. The hidden field is named, never kept.
  if (p === '/scripted/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(page('Scripted Submit', `
<form id="lookup" method="post" action="/scripted/results">
  <input id="q" name="name"><input type="hidden" name="csrf" value="tok-93b17f">
</form>
<button id="go">Search</button>
<script>
document.getElementById('go').addEventListener('click', () => document.getElementById('lookup').submit());
</script>`));
  }
  if (p === '/scripted/results' && req.method === 'POST') {
    const rows = byName(new URLSearchParams(await readBody(req)).get('name'));
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(page('Results', `<table><tbody>${
      rows.map((r) => `<tr><td>${r.id}</td><td>${r.name}</td></tr>`).join('')
    }</tbody></table>`));
  }

  // 12. Autosuggest: the suggestion list fills the search box by assignment
  // and dispatches nothing, so no input event ever carries the value the site
  // is given — only the operator's first few keystrokes. The filter box
  // beside it has a generated id and nothing but its label to name it by.
  if (p === '/autosuggest/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(page('Suggested Search', `
<input id="s0-1-2-3[0]-4-textbox" aria-label="Company name">
<button id="as_pick">Gulf Gum Trading</button>
<input id="s0-1-2-9[0]-7-textbox" aria-label="Minimum Value in $">
<button id="as_go">Search</button>
<table id="results"><tbody></tbody></table>
<script>
const box = document.querySelector('[aria-label="Company name"]');
const min = document.querySelector('[aria-label="Minimum Value in $"]');
document.getElementById('as_pick').addEventListener('click', (e) => { box.value = e.target.textContent; });
document.getElementById('as_go').addEventListener('click', async () => {
  const qs = 'name=' + encodeURIComponent(box.value) + '&min=' + encodeURIComponent(min.value);
  history.pushState({}, '', '/autosuggest/?' + qs);
  const r = await fetch('/autosuggest/api?' + qs);
  document.querySelector('#results tbody').innerHTML =
    (await r.json()).rows.map((x) => '<tr><td>' + x.id + '</td><td>' + x.name + '</td><td>' + x.price + '</td></tr>').join('');
});
</script>`));
  }
  if (p === '/autosuggest/api') {
    const name = (url.searchParams.get('name') ?? '').toLowerCase();
    const min = Number(url.searchParams.get('min') ?? 0);
    const rows = PRICED.filter((r) => name && r.name.toLowerCase().includes(name) && r.price >= min);
    return json(res, { total: rows.length, rows });
  }

  res.writeHead(404).end();
}).listen(PORT, () => console.log(`scenario sites on http://127.0.0.1:${PORT}`));
