import { json, readJSON } from '../lib/http.js';
import { buildForecast, DEFAULT_SETTINGS, addWeeks } from '../forecast.js';

const NUMERIC_SETTINGS = ['lookbackWeeks', 'halfLifeWeeks', 'horizonWeeks', 'damping', 'serviceLevel', 'reviewPeriodWeeks', 'minHistoryWeeks'];

export async function loadSettings(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  const s = { ...DEFAULT_SETTINGS };
  for (const { key, value } of results) {
    if (NUMERIC_SETTINGS.includes(key)) s[key] = Number(value);
    else if (value === 'true' || value === 'false') s[key] = value === 'true';
    else s[key] = value;
  }
  return s;
}

export async function getSettings({ env }) {
  return json(await loadSettings(env));
}

export async function putSettings({ request, env }) {
  const body = await readJSON(request);
  const stmts = Object.entries(body).map(([k, v]) => env.DB.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?,?,datetime('now')) " +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  ).bind(k, String(v)));
  if (stmts.length) await env.DB.batch(stmts);
  return json(await loadSettings(env));
}

/** GET /api/forecast — query params override stored settings for this call only. */
export async function getForecast({ env, url }) {
  const stored = await loadSettings(env);
  const q = url.searchParams;
  const overrides = {};
  for (const k of NUMERIC_SETTINGS) if (q.get(k) != null) overrides[k] = Number(q.get(k));
  if (q.get('useTrend') != null) overrides.useTrend = q.get('useTrend') !== 'false';
  const settings = { ...stored, ...overrides };
  const asOf = q.get('as_of') || undefined;

  const [{ results: products }, { results: sales }] = await Promise.all([
    env.DB.prepare('SELECT * FROM products WHERE active = 1').all(),
    env.DB.prepare('SELECT product_id, sale_date, units, unit_price FROM sales').all(),
  ]);

  const result = buildForecast(products, sales, settings, asOf);

  if (q.get('product_id')) {
    const id = Number(q.get('product_id'));
    result.items = result.items.filter((i) => i.product_id === id);
  }
  return json(result);
}

/** GET /api/forecast/purchase-orders — flattened, sorted buy list. */
export async function getPurchaseOrders({ env, url }) {
  const settings = await loadSettings(env);
  const q = url.searchParams;
  const weeksAhead = Number(q.get('weeks')) || settings.horizonWeeks;

  const [{ results: products }, { results: sales }] = await Promise.all([
    env.DB.prepare('SELECT * FROM products WHERE active = 1').all(),
    env.DB.prepare('SELECT product_id, sale_date, units, unit_price FROM sales').all(),
  ]);

  const fc = buildForecast(products, sales, { ...settings, horizonWeeks: weeksAhead }, q.get('as_of') || undefined);
  const orders = [];
  for (const it of fc.items) {
    it.order_units.forEach((qty, i) => {
      if (qty > 0) {
        const leadWeeks = Math.ceil((it.lead_time_days || 0) / 7);
        orders.push({
          week: it.weeks[i],
          sku: it.sku,
          name: it.name,
          units: qty,
          unit_cost: it.unit_cost,
          cost: it.order_cost[i],
          lead_time_days: it.lead_time_days,
          arrives_week: addWeeks(it.weeks[i], leadWeeks),
        });
      }
    });
  }
  orders.sort((a, b) => (a.week === b.week ? (a.sku < b.sku ? -1 : 1) : (a.week < b.week ? -1 : 1)));
  return json({
    generated_at: fc.generated_at,
    horizon_weeks: weeksAhead,
    total_spend: fc.total_spend,
    weekly_spend: fc.weeks.map((w, i) => ({ week: w, spend: fc.weekly_spend[i] })),
    monthly_spend: fc.monthly_spend,
    orders,
  });
}
