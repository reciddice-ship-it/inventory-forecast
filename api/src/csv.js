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

/**
 * Canonical field -> header aliases, in preference order within each field.
 *
 * The sales fields describe one row of history. The product fields describe the
 * ITEM, and are pulled out separately so an export that carries cost, price and
 * stock alongside its sales can populate the catalog in the same import —
 * without them, every dollar figure in the app is zero.
 */
const ALIASES = {
  // --- per sales row ---
  sale_date: ['date', 'sale_date', 'saledate', 'week start', 'week_start', 'week beginning', 'period start', 'order date', 'order_date', 'day', 'week', 'period', 'transaction date', 'created at', 'created_at', 'timestamp'],
  sku: ['sku', 'item', 'item id', 'item_id', 'product sku', 'product_sku', 'variant sku', 'variant_sku', 'product code', 'part number', 'part_number', 'upc', 'product'],
  units: ['units sold', 'units_sold', 'quantity sold', 'net quantity', 'net_quantity', 'units', 'qty', 'quantity', 'demand units', 'forecastable demand units', 'count', 'sold'],
  unit_price: ['avg selling price', 'average selling price', 'selling price', 'unit price', 'unit_price', 'avg price', 'net price', 'unit retail', 'list price', 'price'],
  revenue: ['sales revenue', 'net sales', 'net_sales', 'gross sales', 'gross_sales', 'revenue', 'line total', 'amount'],

  // --- per product (applied to the catalog, not the sales row) ---
  unit_cost: ['unit cost', 'unit_cost', 'cost per unit', 'item cost', 'wholesale cost', 'wholesale price', 'landed cost', 'cogs per unit', 'standard cost', 'cost'],
  product_name: ['product name', 'product_name', 'item name', 'description', 'title', 'name'],
  category: ['category', 'product category', 'department', 'product line', 'product_line', 'class'],
  on_hand: ['ending inventory units', 'ending_inventory_units', 'ending inventory', 'on hand', 'on_hand', 'stock on hand', 'closing stock', 'inventory units', 'current stock'],
  lead_time_days: ['lead time days', 'lead_time_days', 'lead time', 'lead_time', 'supplier lead time'],
};

/** Fields that describe the product rather than the individual sale. */
export const PRODUCT_FIELDS = ['unit_cost', 'product_name', 'category', 'on_hand', 'lead_time_days'];

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Score one header against one alias. Higher is better; 0 means no match.
 * Exact beats whole-word-phrase beats prefix. Plain substring matching is
 * deliberately NOT used: it maps "revenue" onto "lost_sales_units" because
 * that header happens to contain "sales".
 */
function score(header, alias) {
  const h = norm(header);
  const a = norm(alias);
  if (h === a) return 100;
  const words = h.split(' ');
  const aWords = a.split(' ');
  // All alias words present, in order, as whole words.
  let i = 0;
  for (const w of words) if (w === aWords[i]) i++;
  if (i === aWords.length) {
    // Prefer the tightest fit: fewer extra words in the header.
    return 60 - Math.min(20, words.length - aWords.length);
  }
  return 0;
}

/**
 * Best-guess mapping from CSV headers to canonical field names.
 * A header is claimed by at most one field, strongest match first, so a single
 * column never satisfies two fields at once.
 */
export function guessMapping(headers) {
  const candidates = [];
  for (const [field, aliases] of Object.entries(ALIASES)) {
    for (const header of headers) {
      aliases.forEach((alias, rank) => {
        const s = score(header, alias);
        // Earlier aliases win ties, so preference order inside a field matters.
        if (s > 0) candidates.push({ field, header, score: s * 100 - rank });
      });
    }
  }
  candidates.sort((a, b) => b.score - a.score);

  const map = {};
  const takenHeaders = new Set();
  for (const c of candidates) {
    if (map[c.field] || takenHeaders.has(c.header)) continue;
    map[c.field] = c.header;
    takenHeaders.add(c.header);
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

/**
 * Pull per-product attributes out of the same records.
 *
 * A sales export repeats the product's cost and name on every row. Take the
 * value from the LATEST dated row for each SKU, so a cost that changed over the
 * period lands on its most recent value rather than its oldest. Stock on hand
 * only makes sense from the latest row, which is why the whole thing is dated.
 *
 * @returns {Map<string, {unit_cost?:number, name?:string, category?:string,
 *                        on_hand?:number, lead_time_days?:number, as_of:string}>}
 */
export function mapProductRecords(records, mapping) {
  const out = new Map();
  if (!PRODUCT_FIELDS.some((f) => mapping[f])) return out;

  for (const rec of records) {
    const sku = String(rec[mapping.sku] ?? '').trim();
    if (!sku) continue;
    const date = normalizeDate(rec[mapping.sale_date]) || '0000-00-00';

    const prev = out.get(sku);
    if (prev && prev.as_of > date) continue;

    const attrs = { as_of: date };
    if (mapping.unit_cost) {
      const v = normalizeNumber(rec[mapping.unit_cost]);
      if (v != null && v >= 0) attrs.unit_cost = v;
    }
    if (mapping.product_name) {
      const v = String(rec[mapping.product_name] ?? '').trim();
      if (v) attrs.name = v;
    }
    if (mapping.category) {
      const v = String(rec[mapping.category] ?? '').trim();
      if (v) attrs.category = v;
    }
    if (mapping.on_hand) {
      const v = normalizeNumber(rec[mapping.on_hand]);
      if (v != null && v >= 0) attrs.on_hand = v;
    }
    if (mapping.lead_time_days) {
      const v = normalizeNumber(rec[mapping.lead_time_days]);
      if (v != null && v >= 0) attrs.lead_time_days = Math.round(v);
    }

    // Merge forward so a blank cell in the latest row doesn't wipe a value
    // that an earlier row supplied.
    out.set(sku, prev ? { ...prev, ...attrs } : attrs);
  }
  return out;
}
