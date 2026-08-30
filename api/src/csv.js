/**
 * csv.js — a small RFC 4180 parser (quotes, embedded commas, embedded newlines,
 * escaped double-quotes, CRLF or LF, optional BOM). No dependencies.
 */

export function parseCSV(text, delimiter = ',') {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }

    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === delimiter) { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += ch; i++;
  }
  row.push(field);
  rows.push(row);

  // Drop trailing blank line(s).
  while (rows.length && rows[rows.length - 1].every((c) => c.trim() === '')) rows.pop();
  return rows;
}

/** Guess the delimiter from the header line. */
export function sniffDelimiter(text) {
  const line = text.split(/\r?\n/, 1)[0] || '';
  const counts = { ',': 0, '\t': 0, ';': 0, '|': 0 };
  let inQ = false;
  for (const ch of line) {
    if (ch === '"') inQ = !inQ;
    else if (!inQ && ch in counts) counts[ch]++;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0
    ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]
    : ',';
}

/** Parse to array-of-objects keyed by the header row. */
export function parseCSVObjects(text, delimiter) {
  const d = delimiter || sniffDelimiter(text);
  const rows = parseCSV(text, d);
  if (!rows.length) return { headers: [], records: [] };
  const headers = rows[0].map((h) => h.trim());
  const records = rows.slice(1).map((r) => {
    const o = {};
    headers.forEach((h, idx) => { o[h] = (r[idx] ?? '').trim(); });
    return o;
  });
  return { headers, records };
}

/* ---------------------------------------------------------------- */
/* Column guessing + value coercion for the sales importer            */
/* ---------------------------------------------------------------- */

const ALIASES = {
  sale_date: ['date', 'sale_date', 'saledate', 'order date', 'order_date', 'day', 'week', 'period', 'transaction date', 'created at', 'created_at', 'timestamp'],
  sku: ['sku', 'item', 'item id', 'item_id', 'product', 'product sku', 'product_sku', 'variant sku', 'variant_sku', 'code', 'part number', 'part_number', 'upc'],
  units: ['units', 'qty', 'quantity', 'units sold', 'units_sold', 'quantity sold', 'net quantity', 'net_quantity', 'count', 'sold'],
  unit_price: ['unit price', 'unit_price', 'price', 'avg price', 'selling price', 'unit_retail', 'retail'],
  revenue: ['revenue', 'net sales', 'net_sales', 'gross sales', 'gross_sales', 'total', 'amount', 'sales', 'line total'],
};

/** Best-guess mapping from CSV headers to our canonical field names. */
export function guessMapping(headers) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const map = {};
  for (const [field, aliases] of Object.entries(ALIASES)) {
    let hit = headers.find((h) => aliases.includes(norm(h)));
    if (!hit) hit = headers.find((h) => aliases.some((a) => norm(h).includes(a) && a.length > 3));
    if (hit) map[field] = hit;
  }
  return map;
}

/** Coerce assorted spreadsheet date formats to 'YYYY-MM-DD'. */
export function normalizeDate(value) {
  const v = String(value ?? '').trim();
  if (!v) return null;

  let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);            // 2026-08-30
  if (m) return iso(m[1], m[2], m[3]);

  m = v.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);              // 2026/08/30
  if (m) return iso(m[1], m[2], m[3]);

  m = v.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);        // 08/30/2026 (US)
  if (m) return iso(m[3], m[1], m[2]);

  m = v.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2})$/);       // 08/30/26
  if (m) return iso(String(2000 + Number(m[3])), m[1], m[2]);

  m = v.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/);      // 30 Aug 2026
  if (m) { const mo = MONTHS[m[2].slice(0, 3).toLowerCase()]; if (mo) return iso(m[3], mo, m[1]); }

  m = v.match(/^([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{4})$/);    // Aug 30, 2026
  if (m) { const mo = MONTHS[m[1].slice(0, 3).toLowerCase()]; if (mo) return iso(m[3], mo, m[2]); }

  // Excel serial date (days since 1899-12-30)
  if (/^\d{5}(\.\d+)?$/.test(v)) {
    const d = new Date(Date.UTC(1899, 11, 30) + Number(v) * 86400000);
    return d.toISOString().slice(0, 10);
  }

  const parsed = new Date(v);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return null;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function iso(y, m, d) {
  return `${y}-${String(Number(m)).padStart(2, '0')}-${String(Number(d)).padStart(2, '0')}`;
}

/** Strip currency symbols, thousands separators, parenthesised negatives. */
export function normalizeNumber(value) {
  let v = String(value ?? '').trim();
  if (!v) return null;
  let neg = false;
  if (/^\(.*\)$/.test(v)) { neg = true; v = v.slice(1, -1); }
  v = v.replace(/[^0-9.\-]/g, '');
  if (v === '' || v === '-' || v === '.') return null;
  const n = Number(v);
  if (Number.isNaN(n)) return null;
  return neg ? -n : n;
}

/**
 * Turn raw CSV records into sales rows using a header mapping.
 * @returns {{rows:Array, errors:Array<{line:number, reason:string}>}}
 */
export function mapSalesRecords(records, mapping) {
  const rows = [];
  const errors = [];
  records.forEach((rec, idx) => {
    const line = idx + 2; // +1 for header, +1 for 1-indexing
    const sku = String(rec[mapping.sku] ?? '').trim();
    const date = normalizeDate(rec[mapping.sale_date]);
    let units = normalizeNumber(rec[mapping.units]);
    const price = mapping.unit_price ? normalizeNumber(rec[mapping.unit_price]) : null;
    const revenue = mapping.revenue ? normalizeNumber(rec[mapping.revenue]) : null;

    if (!sku) { errors.push({ line, reason: 'missing SKU' }); return; }
    if (!date) { errors.push({ line, reason: `unparseable date: "${rec[mapping.sale_date] ?? ''}"` }); return; }
    if (units == null) {
      if (revenue != null && price) units = revenue / price;
      else { errors.push({ line, reason: 'missing or unparseable units' }); return; }
    }

    rows.push({
      sku,
      sale_date: date,
      units,
      unit_price: price ?? (revenue != null && units ? revenue / units : null),
    });
  });
  return { rows, errors };
}
