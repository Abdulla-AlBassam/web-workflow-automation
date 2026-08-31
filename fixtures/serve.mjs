// Sijilat-shaped mock: same workflow shape as the real public CR search
// (form → XHR-style POST → JSON results) so recordings and tests exercise the
// exact capture paths without touching the live site.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.env.PORT ?? 4980);

const COMPANIES = [
  { CR_NO: '139867', NAME_EN: 'Awal Trading Co. W.L.L', NAME_AR: 'شركة أوال التجارية', STATUS: 'ACTIVE', TYPE: 'WLL' },
  { CR_NO: '84121', NAME_EN: 'Manama Foods B.S.C', NAME_AR: 'المنامة للأغذية', STATUS: 'ACTIVE', TYPE: 'BSC' },
  { CR_NO: '20775', NAME_EN: 'Gulf Line Logistics', NAME_AR: 'الخط الخليجي', STATUS: 'DELETED', TYPE: 'WLL' },
  { CR_NO: '91230', NAME_EN: 'Delmon Trading W.L.L', NAME_AR: 'دلمون التجارية', STATUS: 'ACTIVE', TYPE: 'WLL' },
  { CR_NO: '77012', NAME_EN: 'Muharraq Trading Est.', NAME_AR: 'المحرق التجارية', STATUS: 'ACTIVE', TYPE: 'EST' },
  { CR_NO: '65440', NAME_EN: 'Riffa Trading House', NAME_AR: 'بيت الرفاع التجاري', STATUS: 'ACTIVE', TYPE: 'WLL' },
  { CR_NO: '58019', NAME_EN: 'Isa Town Trading Co.', NAME_AR: 'مدينة عيسى التجارية', STATUS: 'DELETED', TYPE: 'WLL' },
];

const PER_PAGE = 2;

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
  } else if (req.method === 'GET' && req.url === '/noise') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end('{"noise":true}');
  } else {
    res.writeHead(404).end();
  }
}).listen(PORT, () => console.log(`mock sijilat on http://127.0.0.1:${PORT}`));
