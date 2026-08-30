/**
 * forecast.js — inventory demand & spend forecasting.
 *
 * Zero dependencies, pure functions, runs identically in a Cloudflare Worker,
 * in Node, or in the browser. Everything here is deterministic: same inputs,
 * same outputs, no clock reads except the ones you pass in.
 *
 * The model, in one paragraph:
 *   Daily sales rows are rolled up into ISO weeks. A weighted least-squares
 *   line is fitted through the weekly unit history, with exponentially decaying
 *   weights so recent weeks matter more (controlled by `halfLifeWeeks`). The
 *   fitted line gives a current demand LEVEL and a TREND in units/week. Future
 *   weeks extrapolate that trend with a damping factor (Gardner & McKenzie
 *   damped-trend smoothing) so a steep short-run slope does not run away over a
 *   long horizon. Forecast error is measured as the weighted RMS of the fit
 *   residuals and converted into safety stock via a service-level z-score.
 *   Finally a week-by-week replenishment simulation turns demand into purchase
 *   orders, and purchase orders into a weekly and monthly SPEND projection.
 */

/* ------------------------------------------------------------------ */
/* Date helpers — all UTC, all ISO (Monday-start) weeks.               */
/* ------------------------------------------------------------------ */

const MS_DAY = 86400000;
const MS_WEEK = 7 * MS_DAY;

/** Parse 'YYYY-MM-DD' (or an ISO datetime) to a UTC-midnight Date. */
export function parseDate(value) {
  if (value instanceof Date) return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  const m = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) throw new Error(`Unparseable date: ${value}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

/** 'YYYY-MM-DD' for a Date. */
export function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

/** Monday of the ISO week containing `value`, as 'YYYY-MM-DD'. */
export function weekStart(value) {
  const d = parseDate(value);
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0 ... Sun=6
  return fmtDate(new Date(d.getTime() - dow * MS_DAY));
}

export function addWeeks(weekStr, n) {
  return fmtDate(new Date(parseDate(weekStr).getTime() + n * MS_WEEK));
}

export function weeksBetween(aStr, bStr) {
  return Math.round((parseDate(bStr) - parseDate(aStr)) / MS_WEEK);
}

/* ------------------------------------------------------------------ */
/* Aggregation                                                         */
/* ------------------------------------------------------------------ */

/**
 * Roll daily sales rows into a contiguous, zero-filled weekly series.
 *
 * Zero-filling matters: a week with no sales is real demand information (zero),
 * but weeks BEFORE the product's first ever sale are not — they're pre-launch
 * absence, and padding them with zeros would bias the level down. So the series
 * starts at the later of (asOfWeek - lookbackWeeks + 1) and the product's first
 * observed sale week.
 *
 * Also reports coverage, so callers can tell the difference between "demand is
 * genuinely zero" and "your data never reached this window" — the two look
 * identical in the numbers and mean completely different things.
 *
 * @param {{sale_date:string, units:number}[]} rows
 * @param {{asOf?:string, lookbackWeeks?:number}} opts
 * @returns {{weeks:string[], units:number[], revenue:number[], firstSaleWeek:string|null,
 *            lastSaleWeek:string|null, rowCount:number, unitsInWindow:number,
 *            weeksWithSales:number, staleWeeks:number, windowStart:string, windowEnd:string}}
 */
export function aggregateWeekly(rows, opts = {}) {
  const lookbackWeeks = opts.lookbackWeeks ?? 26;
  const byWeek = new Map();
  let firstSaleWeek = null;
  let lastSaleWeek = null;

  for (const r of rows) {
    const w = weekStart(r.sale_date);
    const units = Number(r.units) || 0;
    const revenue = Number(r.revenue ?? (r.unit_price != null ? r.unit_price * units : 0)) || 0;
    const cur = byWeek.get(w) || { units: 0, revenue: 0 };
    cur.units += units;
    cur.revenue += revenue;
    byWeek.set(w, cur);
    if (units !== 0) {
      if (!firstSaleWeek || w < firstSaleWeek) firstSaleWeek = w;
      if (!lastSaleWeek || w > lastSaleWeek) lastSaleWeek = w;
    }
  }

  // The series ends on the last COMPLETE week (asOf's week is usually partial).
  const asOfWeek = weekStart(opts.asOf ?? new Date());
  const endWeek = opts.includeCurrentWeek ? asOfWeek : addWeeks(asOfWeek, -1);

  let windowStart = addWeeks(endWeek, -(lookbackWeeks - 1));

  const base = {
    weeks: [], units: [], revenue: [],
    firstSaleWeek, lastSaleWeek,
    rowCount: rows.length,
    unitsInWindow: 0,
    weeksWithSales: 0,
    staleWeeks: lastSaleWeek ? Math.max(0, weeksBetween(lastSaleWeek, endWeek)) : 0,
    windowStart, windowEnd: endWeek,
  };

  if (!firstSaleWeek) return base;

  // Every sale predates the window: the series would be all zeros, which the
  // model cannot distinguish from "sells nothing". Report it instead.
  if (lastSaleWeek < windowStart) return base;

  let startWeek = windowStart;
  if (firstSaleWeek > startWeek) startWeek = firstSaleWeek;
  if (startWeek > endWeek) return base;

  const weeks = [];
  const units = [];
  const revenue = [];
  let unitsInWindow = 0;
  let weeksWithSales = 0;
  for (let w = startWeek; w <= endWeek; w = addWeeks(w, 1)) {
    const cell = byWeek.get(w) || { units: 0, revenue: 0 };
    weeks.push(w);
    units.push(cell.units);
    revenue.push(cell.revenue);
    unitsInWindow += cell.units;
    if (cell.units !== 0) weeksWithSales++;
  }
  return { ...base, weeks, units, revenue, unitsInWindow, weeksWithSales };
}

/* ------------------------------------------------------------------ */
/* The model                                                           */
/* ------------------------------------------------------------------ */

/** Exponential-decay weights, newest observation weight 1. */
export function decayWeights(n, halfLifeWeeks) {
  if (!(halfLifeWeeks > 0)) return new Array(n).fill(1);
  const w = new Array(n);
  for (let i = 0; i < n; i++) w[i] = Math.pow(0.5, (n - 1 - i) / halfLifeWeeks);
  return w;
}

/**
 * Weighted least-squares fit of y = a + b*x over x = 0..n-1.
 * Returns the fitted value at the LAST point (the current level) and the slope.
 */
export function weightedLinearFit(y, w) {
  const n = y.length;
  if (n === 0) return { level: 0, slope: 0, intercept: 0, sigma: 0, fitted: [] };
  if (n === 1) return { level: y[0], slope: 0, intercept: y[0], sigma: 0, fitted: [y[0]] };

  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const wi = w[i];
    sw += wi; sx += wi * i; sy += wi * y[i];
    sxx += wi * i * i; sxy += wi * i * y[i];
  }
  const denom = sw * sxx - sx * sx;
  let slope = 0, intercept = sy / sw;
  if (Math.abs(denom) > 1e-12) {
    slope = (sw * sxy - sx * sy) / denom;
    intercept = (sy - slope * sx) / sw;
  }

  const fitted = new Array(n);
  let ss = 0;
  for (let i = 0; i < n; i++) {
    fitted[i] = intercept + slope * i;
    ss += w[i] * Math.pow(y[i] - fitted[i], 2);
  }
  // Weighted RMS residual, small-sample corrected for the 2 fitted parameters.
  const dof = Math.max(1, n - 2);
  const sigma = Math.sqrt((ss / sw) * (n / dof));

  return { level: intercept + slope * (n - 1), slope, intercept, sigma, fitted };
}

/** Normal quantile for common service levels (Acklam-free, table lookup). */
export function zForServiceLevel(p) {
  const table = [
    [0.50, 0.0], [0.75, 0.6745], [0.80, 0.8416], [0.85, 1.0364], [0.90, 1.2816],
    [0.925, 1.4395], [0.95, 1.6449], [0.975, 1.9600], [0.98, 2.0537], [0.99, 2.3263],
    [0.995, 2.5758], [0.999, 3.0902],
  ];
  const target = Math.min(0.999, Math.max(0.5, Number(p) || 0.95));
  let best = table[0];
  for (const row of table) if (Math.abs(row[0] - target) < Math.abs(best[0] - target)) best = row;
  return best[1];
}

/** Sum of phi^1 .. phi^h — the damped-trend accumulation factor. */
export function dampSum(h, phi) {
  if (phi === 1) return h;
  return (phi * (1 - Math.pow(phi, h))) / (1 - phi);
}

export const DEFAULT_SETTINGS = {
  lookbackWeeks: 26,       // history window fed to the fit
  halfLifeWeeks: 6,        // recency: a week 6 weeks old counts half as much
  horizonWeeks: 13,        // how far forward to project
  damping: 0.85,           // trend damping, 1 = undamped straight line, 0 = flat
  serviceLevel: 0.95,      // target in-stock probability -> safety stock z
  reviewPeriodWeeks: 1,    // how often you place orders
  useTrend: true,
  minHistoryWeeks: 3,      // below this, fall back to a flat mean, no trend
};

/**
 * Forecast weekly demand for one product.
 * @returns {{weeks:string[], demand:number[], level:number, trend:number,
 *            sigma:number, history:{weeks:string[],units:number[]}, basis:string}}
 */
export function forecastDemand(salesRows, settings = {}, asOf) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const hist = aggregateWeekly(salesRows, { asOf, lookbackWeeks: s.lookbackWeeks });
  const n = hist.units.length;

  const startWeek = n ? addWeeks(hist.weeks[n - 1], 1) : addWeeks(weekStart(asOf ?? new Date()), 1);
  const weeks = [];
  for (let h = 0; h < s.horizonWeeks; h++) weeks.push(addWeeks(startWeek, h));

  if (n === 0) {
    // Distinguish "never sold anything" from "sold, but all of it predates the
    // history window" — identical zeros, completely different fixes.
    const basis = hist.rowCount > 0 ? 'stale-history' : 'no-history';
    return {
      weeks, demand: weeks.map(() => 0), level: 0, trend: 0, sigma: 0,
      history: hist, basis,
    };
  }

  const w = decayWeights(n, s.halfLifeWeeks);
  const fit = weightedLinearFit(hist.units, w);

  const trendAllowed = s.useTrend && n >= s.minHistoryWeeks;
  const trend = trendAllowed ? fit.slope : 0;
  let level = trendAllowed ? fit.level : weightedMean(hist.units, w);
  if (level < 0) level = 0;

  const demand = weeks.map((_, i) => {
    const h = i + 1;
    const v = level + trend * dampSum(h, s.damping);
    return Math.max(0, v);
  });

  return {
    weeks,
    demand,
    level,
    trend,
    sigma: fit.sigma,
    history: hist,
    basis: trendAllowed ? 'wls-damped-trend' : (n >= 1 ? 'weighted-mean' : 'no-history'),
  };
}

export function weightedMean(y, w) {
  let sw = 0, sy = 0;
  for (let i = 0; i < y.length; i++) { sw += w[i]; sy += w[i] * y[i]; }
  return sw ? sy / sw : 0;
}

/* ------------------------------------------------------------------ */
/* Replenishment simulation -> spend                                   */
/* ------------------------------------------------------------------ */

/**
 * Walk the horizon week by week, depleting stock by forecast demand and placing
 * purchase orders under a periodic order-up-to (R,S) policy.
 *
 *   coverage  = lead time + review period            (weeks of exposure)
 *   S         = expected demand over coverage + safety stock
 *   safety    = z * sigma * sqrt(coverage)
 *   order     = S - inventory position, rounded up to case pack, floored at MOQ
 *
 * @returns {{weeks:string[], demand:number[], onHand:number[], orderUnits:number[],
 *            orderCost:number[], receipts:number[], safetyStock:number,
 *            orderUpTo:number, stockoutWeeks:string[]}}
 */
export function simulateReplenishment(product, fc, settings = {}) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const leadWeeks = Math.max(0, (Number(product.lead_time_days) || 0) / 7);
  const review = Math.max(1, Number(s.reviewPeriodWeeks) || 1);
  const coverage = leadWeeks + review;
  const z = zForServiceLevel(s.serviceLevel);
  const unitCost = Number(product.unit_cost) || 0;
  const moq = Math.max(0, Number(product.moq) || 0);
  const casePack = Math.max(1, Number(product.case_pack) || 1);

  const safetyStock = Math.round(z * fc.sigma * Math.sqrt(coverage));

  const H = fc.weeks.length;
  const demand = fc.demand;
  const onHand = new Array(H).fill(0);
  const orderUnits = new Array(H).fill(0);
  const orderCost = new Array(H).fill(0);
  const receipts = new Array(H).fill(0);
  const stockoutWeeks = [];

  // Orders arrive `leadWeeks` after they're placed (rounded up to whole weeks).
  const leadIdx = Math.ceil(leadWeeks);
  const pipeline = new Array(H + leadIdx + 1).fill(0);

  let stock = Number(product.on_hand) || 0;
  let onOrder = Number(product.on_order) || 0;
  let orderUpTo = 0;

  for (let i = 0; i < H; i++) {
    // 1. Receive anything arriving this week.
    const arriving = pipeline[i];
    if (arriving > 0) { stock += arriving; onOrder -= arriving; receipts[i] = arriving; }

    // 2. Consume this week's forecast demand.
    stock -= demand[i];
    if (stock < 0) { stockoutWeeks.push(fc.weeks[i]); stock = 0; }

    // 3. Review: is inventory position below the order-up-to level?
    if (i % review === 0) {
      // Expected demand across the coverage window starting next week.
      let coverDemand = 0;
      for (let k = 0; k < Math.ceil(coverage); k++) {
        const idx = i + 1 + k;
        const d = idx < H ? demand[idx] : (demand[H - 1] ?? 0);
        const share = Math.min(1, coverage - k);
        coverDemand += d * share;
      }
      orderUpTo = coverDemand + safetyStock;
      const position = stock + onOrder;
      let qty = orderUpTo - position;
      if (qty > 0) {
        qty = Math.ceil(qty / casePack) * casePack;
        if (moq > 0 && qty < moq) qty = moq;
        orderUnits[i] = qty;
        orderCost[i] = qty * unitCost;
        onOrder += qty;
        if (i + leadIdx < pipeline.length) pipeline[i + leadIdx] += qty;
      }
    }

    onHand[i] = Math.round(stock * 100) / 100;
  }

  return {
    weeks: fc.weeks, demand, onHand, orderUnits, orderCost, receipts,
    safetyStock, orderUpTo: Math.round(orderUpTo), stockoutWeeks,
    coverageWeeks: coverage,
  };
}

/* ------------------------------------------------------------------ */
/* Monthly rollup                                                      */
/* ------------------------------------------------------------------ */

/**
 * Distribute weekly values into calendar months, splitting each week's value
 * across months proportionally by the number of days falling in each.
 * @param {string[]} weeks  Monday dates
 * @param {number[]} values
 * @returns {{month:string, value:number}[]}
 */
export function weeklyToMonthly(weeks, values) {
  const acc = new Map();
  for (let i = 0; i < weeks.length; i++) {
    const start = parseDate(weeks[i]);
    const v = values[i] || 0;
    for (let d = 0; d < 7; d++) {
      const day = new Date(start.getTime() + d * MS_DAY);
      const key = `${day.getUTCFullYear()}-${String(day.getUTCMonth() + 1).padStart(2, '0')}`;
      acc.set(key, (acc.get(key) || 0) + v / 7);
    }
  }
  return [...acc.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([month, value]) => ({ month, value: Math.round(value * 100) / 100 }));
}

/* ------------------------------------------------------------------ */
/* Top-level orchestration                                             */
/* ------------------------------------------------------------------ */

/**
 * Full forecast across a catalog.
 * @param {Array} products  rows from the products table
 * @param {Array} sales     rows from the sales table ({product_id, sale_date, units, unit_price})
 * @param {Object} settings overrides for DEFAULT_SETTINGS
 * @param {string} [asOf]   'YYYY-MM-DD'; defaults to today
 */
export function buildForecast(products, sales, settings = {}, asOf) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const byProduct = new Map();
  for (const row of sales) {
    const k = row.product_id;
    if (!byProduct.has(k)) byProduct.set(k, []);
    byProduct.get(k).push(row);
  }

  const items = [];
  let weeksAxis = [];

  for (const p of products) {
    if (p.active === 0 || p.active === false) continue;
    const rows = byProduct.get(p.id) || [];
    const fc = forecastDemand(rows, s, asOf);
    const sim = simulateReplenishment(p, fc, s);
    if (fc.weeks.length > weeksAxis.length) weeksAxis = fc.weeks;

    const histUnits = fc.history.units;
    const last4 = histUnits.slice(-4).reduce((a, b) => a + b, 0);
    const prev4 = histUnits.slice(-8, -4).reduce((a, b) => a + b, 0);

    // Why a SKU might be producing nothing useful. Silence here is the failure
    // mode that matters: zeros with no explanation look like a broken tool.
    const h = fc.history;
    const issues = [];
    if (fc.basis === 'no-history') {
      issues.push({ code: 'no-sales', message: 'No sales recorded for this SKU.' });
    } else if (fc.basis === 'stale-history') {
      issues.push({
        code: 'stale-sales',
        message: `Last sale was the week of ${h.lastSaleWeek}, ${h.staleWeeks} weeks before the ${s.lookbackWeeks}-week history window starting ${h.windowStart}. Widen the history window in Settings, or check that the import dates are what you expect.`,
      });
    } else {
      if (h.weeks.length < s.minHistoryWeeks) {
        issues.push({ code: 'thin-history', message: `Only ${h.weeks.length} week(s) of history — using a flat average, no trend.` });
      }
      if (h.staleWeeks >= 2) {
        issues.push({
          code: 'trailing-gap',
          message: `No sales recorded since the week of ${h.lastSaleWeek} — ${h.staleWeeks} empty weeks at the end of the history. Those are being read as zero demand and are pulling the forecast down. If it is a data gap rather than a genuine stop, load the missing weeks.`,
        });
      }
      if (h.weeks.length >= 4 && h.weeksWithSales / h.weeks.length < 0.5) {
        issues.push({
          code: 'sparse-history',
          message: `Sales land in only ${h.weeksWithSales} of ${h.weeks.length} weeks. If your file holds weekly or monthly totals rather than one row per day, the empty weeks between them are being read as zero demand and the forecast will run low.`,
        });
      }
    }
    if (!(Number(p.unit_cost) > 0)) {
      issues.push({ code: 'zero-cost', message: 'Unit cost is 0, so this SKU contributes nothing to the spend forecast. Set it on the Products tab.' });
    }

    items.push({
      issues,
      coverage: {
        history_weeks: h.weeks.length,
        weeks_with_sales: h.weeksWithSales,
        units_in_window: round2(h.unitsInWindow),
        first_sale_week: h.firstSaleWeek,
        last_sale_week: h.lastSaleWeek,
        stale_weeks: h.staleWeeks,
        window_start: h.windowStart,
        window_end: h.windowEnd,
        sales_rows: h.rowCount,
      },
      product_id: p.id,
      sku: p.sku,
      name: p.name,
      unit_cost: Number(p.unit_cost) || 0,
      on_hand: Number(p.on_hand) || 0,
      lead_time_days: Number(p.lead_time_days) || 0,
      basis: fc.basis,
      history: { weeks: fc.history.weeks, units: histUnits },
      weeks: fc.weeks,
      demand: fc.demand.map((v) => Math.round(v * 100) / 100),
      forecast_units_total: round2(fc.demand.reduce((a, b) => a + b, 0)),
      level_units_per_week: round2(fc.level),
      trend_units_per_week: round2(fc.trend),
      sigma: round2(fc.sigma),
      wow_change_pct: prev4 > 0 ? round2(((last4 - prev4) / prev4) * 100) : null,
      weeks_of_cover: fc.level > 0 ? round2((Number(p.on_hand) || 0) / fc.level) : null,
      safety_stock: sim.safetyStock,
      order_up_to: sim.orderUpTo,
      order_units: sim.orderUnits,
      order_cost: sim.orderCost.map(round2),
      on_hand_projection: sim.onHand,
      spend_total: round2(sim.orderCost.reduce((a, b) => a + b, 0)),
      first_order_week: sim.orderUnits.findIndex((q) => q > 0) >= 0
        ? fc.weeks[sim.orderUnits.findIndex((q) => q > 0)] : null,
      stockout_weeks: sim.stockoutWeeks,
    });
  }

  // Portfolio rollup, aligned on the longest week axis.
  const weeklySpend = weeksAxis.map((wk) =>
    round2(items.reduce((sum, it) => {
      const idx = it.weeks.indexOf(wk);
      return sum + (idx >= 0 ? it.order_cost[idx] : 0);
    }, 0)));
  const weeklyUnits = weeksAxis.map((wk) =>
    round2(items.reduce((sum, it) => {
      const idx = it.weeks.indexOf(wk);
      return sum + (idx >= 0 ? it.demand[idx] : 0);
    }, 0)));

  // Portfolio-level diagnostics: if the dashboard is going to show zeros, it
  // should say why rather than leaving the user to guess.
  const codeOf = (c) => items.filter((i) => i.issues.some((x) => x.code === c));
  const diagnostics = {
    active_products: items.length,
    products_with_usable_history: items.filter((i) => i.basis !== 'no-history' && i.basis !== 'stale-history').length,
    no_sales: codeOf('no-sales').map((i) => i.sku),
    stale_sales: codeOf('stale-sales').map((i) => ({ sku: i.sku, last_sale_week: i.coverage.last_sale_week })),
    sparse_history: codeOf('sparse-history').map((i) => i.sku),
    trailing_gap: codeOf('trailing-gap').map((i) => ({ sku: i.sku, last_sale_week: i.coverage.last_sale_week, weeks: i.coverage.stale_weeks })),
    thin_history: codeOf('thin-history').map((i) => i.sku),
    zero_cost: codeOf('zero-cost').map((i) => i.sku),
    window_start: items[0]?.coverage.window_start ?? null,
    window_end: items[0]?.coverage.window_end ?? null,
  };

  return {
    generated_at: new Date().toISOString(),
    as_of_week: weeksAxis[0] ? addWeeks(weeksAxis[0], -1) : null,
    settings: s,
    diagnostics,
    weeks: weeksAxis,
    weekly_spend: weeklySpend,
    weekly_demand_units: weeklyUnits,
    monthly_spend: weeklyToMonthly(weeksAxis, weeklySpend),
    monthly_demand_units: weeklyToMonthly(weeksAxis, weeklyUnits),
    total_spend: round2(weeklySpend.reduce((a, b) => a + b, 0)),
    items,
  };
}

function round2(v) { return Math.round((Number(v) || 0) * 100) / 100; }
