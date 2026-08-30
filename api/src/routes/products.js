import { json, HttpError, readJSON } from '../lib/http.js';

const FIELDS = [
  'sku', 'name', 'category', 'supplier', 'unit_cost', 'unit_price',
  'lead_time_days', 'moq', 'case_pack', 'on_hand', 'on_order', 'active', 'notes',
];

const NUMERIC = new Set(['unit_cost', 'unit_price', 'lead_time_days', 'moq', 'case_pack', 'on_hand', 'on_order', 'active']);

function clean(body, { requireSku = false } = {}) {
  const out = {};
  for (const f of FIELDS) {
    if (!(f in body)) continue;
    let v = body[f];
    if (v === '' || v === null) { out[f] = null; continue; }
    if (NUMERIC.has(f)) {
      if (f === 'active') { out[f] = v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0; continue; }
      const n = Number(v);
      if (Number.isNaN(n)) throw new HttpError(`Field "${f}" must be a number`, 422);
      out[f] = n;
    } else {
      out[f] = String(v).trim();
    }
  }
  if (requireSku && !out.sku) throw new HttpError('sku is required', 422);
  if (requireSku && !out.name) out.name = out.sku;
  return out;
}

export async function listProducts({ env, url }) {
  const includeInactive = url.searchParams.get('include_inactive') === '1';
  const sql = `SELECT * FROM products ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY sku`;
  const { results } = await env.DB.prepare(sql).all();
  return json({ products: results });
}

export async function getProduct({ env, params }) {
  const row = await env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(params.id).first();
  if (!row) throw new HttpError('Product not found', 404);
  return json(row);
}

export async function createProduct({ request, env }) {
  const body = await readJSON(request);
  const rows = Array.isArray(body) ? body : [body];
  const created = [];
  for (const raw of rows) {
    const p = clean(raw, { requireSku: true });
    const cols = Object.keys(p);
    const sql = `INSERT INTO products (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})
                 ON CONFLICT(sku) DO UPDATE SET ${cols.filter((c) => c !== 'sku').map((c) => `${c}=excluded.${c}`).join(',')},
                 updated_at = datetime('now')
                 RETURNING *`;
    const row = await env.DB.prepare(sql).bind(...cols.map((c) => p[c])).first();
    created.push(row);
  }
  return json(Array.isArray(body) ? { products: created } : created, 201);
}

export async function updateProduct({ request, env, params }) {
  const body = await readJSON(request);
  const p = clean(body);
  const cols = Object.keys(p);
  if (!cols.length) throw new HttpError('No updatable fields supplied', 422);

  // on_hand changes are logged as adjustments, not silently overwritten.
  if ('on_hand' in p) {
    const cur = await env.DB.prepare('SELECT on_hand FROM products WHERE id = ?').bind(params.id).first();
    if (!cur) throw new HttpError('Product not found', 404);
    const delta = p.on_hand - (cur.on_hand ?? 0);
    if (delta !== 0) {
      await env.DB.prepare(
        'INSERT INTO inventory_adjustments (product_id, delta, new_on_hand, reason) VALUES (?,?,?,?)'
      ).bind(params.id, delta, p.on_hand, body.reason || 'manual update').run();
    }
  }

  const sql = `UPDATE products SET ${cols.map((c) => `${c}=?`).join(',')}, updated_at = datetime('now')
               WHERE id = ? RETURNING *`;
  const row = await env.DB.prepare(sql).bind(...cols.map((c) => p[c]), params.id).first();
  if (!row) throw new HttpError('Product not found', 404);
  return json(row);
}

export async function deleteProduct({ env, params, url }) {
  const hard = url.searchParams.get('hard') === '1';
  if (hard) {
    await env.DB.prepare('DELETE FROM products WHERE id = ?').bind(params.id).run();
    return json({ deleted: true, id: Number(params.id), mode: 'hard' });
  }
  const row = await env.DB.prepare(
    "UPDATE products SET active = 0, updated_at = datetime('now') WHERE id = ? RETURNING id"
  ).bind(params.id).first();
  if (!row) throw new HttpError('Product not found', 404);
  return json({ deleted: true, id: row.id, mode: 'deactivated' });
}
