// Sijilat-shaped mock: same workflow shape as the real public CR search
// (form → XHR-style POST → JSON results) so recordings and tests exercise the
// exact capture paths without touching the live site.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.env.PORT ?? 4980);

// Rich rows on purpose: wide tables exercise the horizontal-scroll display,
// and LOGO_HTML proves markup-blob fields clip instead of swamping a cell.
const logo = (name) => `<picture><source srcset="/logos/${name}.webp" type="image/webp"/><img src="/logos/${name}.png" alt="${name} logo" width="64" height="64" loading="lazy"/></picture>`;
const COMPANIES = [
  { CR_NO: '139867', NAME_EN: 'Awal Trading Co. W.L.L', NAME_AR: 'شركة أوال التجارية', STATUS: 'ACTIVE', TYPE: 'WLL', ADDRESS: 'Bldg 221, Rd 1704, Manama', ACTIVITY: 'Building materials', CAPITAL: 250000, LOGO_HTML: logo('awal') },
  { CR_NO: '84121', NAME_EN: 'Manama Foods B.S.C', NAME_AR: 'المنامة للأغذية', STATUS: 'ACTIVE', TYPE: 'BSC', ADDRESS: 'Bldg 12, Rd 383, Manama', ACTIVITY: 'Food import', CAPITAL: 1200000, LOGO_HTML: logo('manama-foods') },
  { CR_NO: '20775', NAME_EN: 'Gulf Line Logistics', NAME_AR: 'الخط الخليجي', STATUS: 'DELETED', TYPE: 'WLL', ADDRESS: 'Bldg 77, Rd 110, Hidd', ACTIVITY: 'Freight forwarding', CAPITAL: 90000, LOGO_HTML: logo('gulf-line') },
  { CR_NO: '91230', NAME_EN: 'Delmon Trading W.L.L', NAME_AR: 'دلمون التجارية', STATUS: 'ACTIVE', TYPE: 'WLL', ADDRESS: 'Bldg 9, Rd 933, Muharraq', ACTIVITY: 'Household goods', CAPITAL: 150000, LOGO_HTML: logo('delmon') },
  { CR_NO: '77012', NAME_EN: 'Muharraq Trading Est.', NAME_AR: 'المحرق التجارية', STATUS: 'ACTIVE', TYPE: 'EST', ADDRESS: 'Bldg 4, Rd 1129, Muharraq', ACTIVITY: 'Marine equipment', CAPITAL: 60000, LOGO_HTML: logo('muharraq') },
  { CR_NO: '65440', NAME_EN: 'Riffa Trading House', NAME_AR: 'بيت الرفاع التجاري', STATUS: 'ACTIVE', TYPE: 'WLL', ADDRESS: 'Shop 18, Riffa Souq', ACTIVITY: 'Textiles', CAPITAL: 45000, LOGO_HTML: logo('riffa') },
  { CR_NO: '58019', NAME_EN: 'Isa Town Trading Co.', NAME_AR: 'مدينة عيسى التجارية', STATUS: 'DELETED', TYPE: 'WLL', ADDRESS: 'Bldg 300, Isa Town', ACTIVITY: 'Office supplies', CAPITAL: 30000, LOGO_HTML: logo('isa-town') },
];

const PER_PAGE = 2;

// Detail-page data for the chained workflow: search → pick a company → bio.
const BIOS = {
  '139867': 'Awal Trading opened its first Manama storefront in 1978 and now supplies building materials across the Northern Governorate.',
  '84121': 'Manama Foods runs three cold-storage facilities and imports produce for restaurants across the capital.',
  '20775': 'Gulf Line Logistics operated freight forwarding between Bahrain and the Eastern Province until its deletion.',
  '91230': 'Delmon Trading distributes household goods to independent retailers in Muharraq and Riffa.',
  '77012': 'Muharraq Trading Est. is a family-run supplier of marine equipment near the old dhow harbour.',
  '65440': 'Riffa Trading House wholesales textiles and has traded from the same souq address since 1985.',
  '58019': 'Isa Town Trading Co. sold school and office supplies before winding down operations.',
};

const page = readFileSync(join(import.meta.dirname, 'mock-search.html'), 'utf8');

createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page);
  } else if (req.method === 'POST' && req.url === '/api/CRdetails/AdvanceSearchCR_Paging') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const q = JSON.parse(body || '{}');
      const hits = COMPANIES.filter(
        (c) => (!q.CR_NO || c.CR_NO === String(q.CR_NO)) &&
               (!q.CR_NAME_EN || c.NAME_EN.toLowerCase().includes(String(q.CR_NAME_EN).toLowerCase())),
      );
      // Paginated like the real Sijilat API, so fetch-all replay is testable.
      const page = Math.max(1, Number(q.PAGE) || 1);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ TOTAL: hits.length, RECORDS: hits.slice((page - 1) * PER_PAGE, page * PER_PAGE) }));
    });
  } else if (req.method === 'GET' && req.url.startsWith('/api/urlsearch')) {
    // GET-style search: the term arrives in the query string, like wwe.com.
    const q = new URL(req.url, `http://127.0.0.1:${PORT}`).searchParams.get('q') ?? '';
    const hits = COMPANIES.filter((c) => c.NAME_EN.toLowerCase().includes(q.toLowerCase()));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ TOTAL: hits.length, RECORDS: hits }));
  } else if (req.method === 'GET' && /^\/api\/company\/\d+$/.test(req.url)) {
    // Chained detail call: the id arrives in the URL path, like a profile page.
    const id = req.url.split('/').at(-1);
    const c = COMPANIES.find((x) => x.CR_NO === id);
    if (!c) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ CR_NO: c.CR_NO, NAME_EN: c.NAME_EN, STATUS: c.STATUS, BIO: BIOS[c.CR_NO] ?? '' }));
  } else if (req.method === 'GET' && req.url === '/noise') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end('{"noise":true}');
  } else {
    res.writeHead(404).end();
  }
}).listen(PORT, () => console.log(`mock sijilat on http://127.0.0.1:${PORT}`));
