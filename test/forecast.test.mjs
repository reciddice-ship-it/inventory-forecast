import test from 'node:test';
import assert from 'node:assert/strict';
import {
  weekStart, addWeeks, weeksBetween, aggregateWeekly, decayWeights,
  weightedLinearFit, dampSum, zForServiceLevel, forecastDemand,
  simulateReplenishment, weeklyToMonthly, buildForecast,
} from '../api/src/forecast.js';

/* ------------------------------ dates ------------------------------ */

test('weekStart snaps to the Monday of the ISO week', () => {
  assert.equal(weekStart('2026-08-30'), '2026-08-24'); // a Sunday -> previous Monday
  assert.equal(weekStart('2026-08-24'), '2026-08-24'); // a Monday -> itself
  assert.equal(weekStart('2026-08-28'), '2026-08-24'); // a Friday
  assert.equal(weekStart('2026-01-01'), '2025-12-29'); // crosses the year boundary
});

test('addWeeks and weeksBetween are inverse', () => {
  assert.equal(addWeeks('2026-08-24', 3), '2026-09-14');
  assert.equal(addWeeks('2026-08-24', -1), '2026-08-17');
  assert.equal(weeksBetween('2026-08-24', '2026-09-14'), 3);
});

/* --------------------------- aggregation --------------------------- */

test('aggregateWeekly sums days into weeks and zero-fills interior gaps', () => {
  const rows = [
    { sale_date: '2026-08-03', units: 4 },  // week of 08-03
    { sale_date: '2026-08-05', units: 6 },  // same week -> 10
    // week of 08-10 has no sales at all -> must appear as 0
    { sale_date: '2026-08-18', units: 7 },  // week of 08-17
  ];
  const agg = aggregateWeekly(rows, { asOf: '2026-08-24', lookbackWeeks: 12 });
  assert.deepEqual(agg.weeks, ['2026-08-03', '2026-08-10', '2026-08-17']);
  assert.deepEqual(agg.units, [10, 0, 7]);
  assert.equal(agg.firstSaleWeek, '2026-08-03');
});

test('aggregateWeekly does not pad zeros before the first sale', () => {
  const rows = [{ sale_date: '2026-08-17', units: 5 }];
  const agg = aggregateWeekly(rows, { asOf: '2026-08-24', lookbackWeeks: 26 });
  assert.deepEqual(agg.weeks, ['2026-08-17']);
  assert.deepEqual(agg.units, [5]);
});

test('aggregateWeekly excludes the current (partial) week by default', () => {
  const rows = [
    { sale_date: '2026-08-17', units: 5 },
    { sale_date: '2026-08-25', units: 99 }, // week of 08-24 == asOf week, partial
  ];
  const agg = aggregateWeekly(rows, { asOf: '2026-08-26', lookbackWeeks: 26 });
  assert.deepEqual(agg.weeks, ['2026-08-17']);
  const withCurrent = aggregateWeekly(rows, { asOf: '2026-08-26', lookbackWeeks: 26, includeCurrentWeek: true });
  assert.deepEqual(withCurrent.units, [5, 99]);
});

/* ------------------------------ the fit ---------------------------- */

test('decayWeights halve every halfLife weeks, newest = 1', () => {
  const w = decayWeights(5, 2);
  assert.equal(w[4], 1);
  assert.ok(Math.abs(w[2] - 0.5) < 1e-12);
  assert.ok(Math.abs(w[0] - 0.25) < 1e-12);
});

test('weightedLinearFit recovers an exact line', () => {
  const y = [10, 12, 14, 16, 18];               // y = 10 + 2x
  const fit = weightedLinearFit(y, decayWeights(5, 4));
  assert.ok(Math.abs(fit.slope - 2) < 1e-9);
  assert.ok(Math.abs(fit.intercept - 10) < 1e-9);
  assert.ok(Math.abs(fit.level - 18) < 1e-9);   // fitted value at the last point
  assert.ok(fit.sigma < 1e-9);                  // perfect fit -> no residual
});

test('weightedLinearFit on a flat series gives zero slope and the mean level', () => {
  const y = [7, 7, 7, 7, 7, 7];
  const fit = weightedLinearFit(y, decayWeights(6, 6));
  assert.ok(Math.abs(fit.slope) < 1e-9);
  assert.ok(Math.abs(fit.level - 7) < 1e-9);
  assert.ok(fit.sigma < 1e-9);
});

test('weightedLinearFit weights recent points more heavily', () => {
  //  Flat at 10 for a long stretch, then a jump to 20 for the last 3 weeks.
  const y = [10, 10, 10, 10, 10, 10, 20, 20, 20];
  const slow = weightedLinearFit(y, decayWeights(9, 100)); // ~equal weights
  const fast = weightedLinearFit(y, decayWeights(9, 1));   // heavy recency
  assert.ok(fast.level > slow.level, 'recency-weighted level should sit closer to 20');
  assert.ok(fast.level > 15 && fast.level <= 21);
});

test('dampSum: phi=1 is undamped, phi<1 converges', () => {
  assert.equal(dampSum(5, 1), 5);
  assert.ok(Math.abs(dampSum(1, 0.85) - 0.85) < 1e-12);
  assert.ok(Math.abs(dampSum(2, 0.85) - (0.85 + 0.7225)) < 1e-12);
  assert.ok(dampSum(1000, 0.85) < 0.85 / (1 - 0.85) + 1e-6); // bounded
});

test('zForServiceLevel returns standard normal quantiles', () => {
  assert.equal(zForServiceLevel(0.95), 1.6449);
  assert.equal(zForServiceLevel(0.99), 2.3263);
  assert.equal(zForServiceLevel(0.5), 0.0);
});

/* --------------------------- demand model -------------------------- */

const flatSales = (weeks, units, startWeek = '2026-03-02') =>
  Array.from({ length: weeks }, (_, i) => ({ sale_date: addWeeks(startWeek, i), units }));

test('flat history forecasts flat demand', () => {
  const fc = forecastDemand(flatSales(12, 100), { horizonWeeks: 4 }, '2026-05-25');
  assert.equal(fc.weeks.length, 4);
  for (const d of fc.demand) assert.ok(Math.abs(d - 100) < 1e-6, `expected ~100, got ${d}`);
  assert.ok(Math.abs(fc.trend) < 1e-6);
  assert.equal(fc.basis, 'wls-damped-trend');
});

test('rising history produces a positive but damped trend', () => {
  // 50, 55, 60, ... +5/week for 12 weeks
  const rows = Array.from({ length: 12 }, (_, i) => ({ sale_date: addWeeks('2026-03-02', i), units: 50 + 5 * i }));
  const fc = forecastDemand(rows, { horizonWeeks: 8, damping: 0.85 }, '2026-05-25');
  assert.ok(Math.abs(fc.trend - 5) < 1e-6, `trend should be 5/wk, got ${fc.trend}`);
  // Undamped week 8 would be 105 + 40 = 145. Damped must be strictly less.
  const undamped = fc.level + fc.trend * 8;
  assert.ok(fc.demand[7] < undamped, 'damped forecast must fall below the straight line');
  assert.ok(fc.demand[7] > fc.demand[0], 'but must still be rising');
});

test('demand forecasts never go negative', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ sale_date: addWeeks('2026-03-02', i), units: Math.max(0, 100 - 12 * i) }));
  const fc = forecastDemand(rows, { horizonWeeks: 26 }, '2026-05-11');
  for (const d of fc.demand) assert.ok(d >= 0, `negative demand: ${d}`);
});

test('too little history falls back to a weighted mean with no trend', () => {
  const rows = [
    { sale_date: '2026-08-03', units: 10 },
    { sale_date: '2026-08-10', units: 30 },
  ];
  // asOf 2026-08-17 -> last complete week is 2026-08-10, so the series is 2 weeks.
  const fc = forecastDemand(rows, { horizonWeeks: 3, minHistoryWeeks: 3 }, '2026-08-17');
  assert.equal(fc.history.units.length, 2);
  assert.equal(fc.basis, 'weighted-mean');
  assert.equal(fc.trend, 0);
  assert.ok(fc.demand.every((d) => d === fc.demand[0]), 'flat forecast expected');
});

test('no history yields a zero forecast rather than a crash', () => {
  const fc = forecastDemand([], { horizonWeeks: 4 }, '2026-08-24');
  assert.equal(fc.basis, 'no-history');
  assert.deepEqual(fc.demand, [0, 0, 0, 0]);
});

/* ------------------------ replenishment sim ------------------------ */

test('replenishment covers demand and never lets projected stock go negative', () => {
  const product = { id: 1, sku: 'A', unit_cost: 4, lead_time_days: 14, on_hand: 0, on_order: 0, case_pack: 1, moq: 0 };
  const fc = forecastDemand(flatSales(16, 100), { horizonWeeks: 13 }, '2026-06-22');
  const sim = simulateReplenishment(product, fc, { serviceLevel: 0.95, reviewPeriodWeeks: 1 });

  assert.ok(sim.orderUnits.some((q) => q > 0), 'should place at least one order');
  assert.ok(sim.onHand.every((v) => v >= 0));
  // Perfectly flat history -> no residual variance -> no safety stock needed.
  assert.equal(sim.safetyStock, 0);
  // Coverage = 2 weeks lead + 1 week review = 3 weeks of 100 units.
  assert.equal(sim.coverageWeeks, 3);
  assert.equal(sim.orderUpTo, 300);
});

test('case pack and MOQ round order quantities up', () => {
  const product = { id: 1, sku: 'A', unit_cost: 1, lead_time_days: 7, on_hand: 0, case_pack: 12, moq: 100 };
  const fc = forecastDemand(flatSales(10, 10), { horizonWeeks: 6 }, '2026-05-11');
  const sim = simulateReplenishment(product, fc, {});
  const first = sim.orderUnits.find((q) => q > 0);
  assert.ok(first >= 100, `MOQ not respected: ${first}`);
  const nonMoq = sim.orderUnits.filter((q) => q > 0 && q !== 100);
  for (const q of nonMoq) assert.equal(q % 12, 0, `order ${q} is not a multiple of the case pack`);
});

test('existing stock defers the first order', () => {
  const fc = forecastDemand(flatSales(12, 50), { horizonWeeks: 12 }, '2026-05-25');
  const empty = simulateReplenishment({ id: 1, unit_cost: 1, lead_time_days: 7, on_hand: 0 }, fc, {});
  const stocked = simulateReplenishment({ id: 1, unit_cost: 1, lead_time_days: 7, on_hand: 400 }, fc, {});
  const firstEmpty = empty.orderUnits.findIndex((q) => q > 0);
  const firstStocked = stocked.orderUnits.findIndex((q) => q > 0);
  assert.ok(firstStocked > firstEmpty, `stocked first order (${firstStocked}) should come after empty (${firstEmpty})`);
});

test('noisier history produces more safety stock', () => {
  const steady = flatSales(16, 100);
  const noisy = flatSales(16, 100).map((r, i) => ({ ...r, units: i % 2 ? 40 : 160 }));
  const p = { id: 1, unit_cost: 1, lead_time_days: 14, on_hand: 0 };
  const a = simulateReplenishment(p, forecastDemand(steady, { horizonWeeks: 8 }, '2026-06-22'), {});
  const b = simulateReplenishment(p, forecastDemand(noisy, { horizonWeeks: 8 }, '2026-06-22'), {});
  assert.ok(b.safetyStock > a.safetyStock, 'volatile demand should carry more buffer');
});

/* --------------------------- monthly rollup ------------------------ */

test('weeklyToMonthly conserves the total and splits weeks across months', () => {
  const weeks = ['2026-08-24', '2026-08-31', '2026-09-07'];
  const values = [700, 700, 700];
  const monthly = weeklyToMonthly(weeks, values);
  const total = monthly.reduce((a, m) => a + m.value, 0);
  assert.ok(Math.abs(total - 2100) < 0.05, `total drifted: ${total}`);
  // Week of 08-24 is entirely August; week of 08-31 is 1 day Aug + 6 days Sept.
  const aug = monthly.find((m) => m.month === '2026-08');
  assert.ok(Math.abs(aug.value - (700 + 100)) < 0.05, `August should be 800, got ${aug.value}`);
});

/* ---------------------------- end to end --------------------------- */

test('buildForecast produces a coherent portfolio projection', () => {
  const products = [
    { id: 1, sku: 'WID-1', name: 'Widget', unit_cost: 5, lead_time_days: 14, on_hand: 0, case_pack: 1, moq: 0, active: 1 },
    { id: 2, sku: 'GAD-2', name: 'Gadget', unit_cost: 20, lead_time_days: 7, on_hand: 500, case_pack: 1, moq: 0, active: 1 },
  ];
  const sales = [
    ...flatSales(16, 100).map((r) => ({ ...r, product_id: 1 })),
    ...flatSales(16, 25).map((r) => ({ ...r, product_id: 2 })),
  ];

  const out = buildForecast(products, sales, { horizonWeeks: 13 }, '2026-06-22');

  assert.equal(out.weeks.length, 13);
  assert.equal(out.items.length, 2);
  assert.equal(out.weekly_spend.length, 13);

  // Weekly spend must sum to the reported total.
  const summed = out.weekly_spend.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(summed - out.total_spend) < 0.05);

  // Monthly spend must reconcile with weekly spend.
  const monthlyTotal = out.monthly_spend.reduce((a, m) => a + m.value, 0);
  assert.ok(Math.abs(monthlyTotal - out.total_spend) < 0.05, `monthly ${monthlyTotal} != total ${out.total_spend}`);

  // Steady 100 units/wk of a $5 item over 13 weeks of consumption is ~$6,500
  // of goods; with a 3-week coverage buffer being built from zero stock the
  // committed spend should exceed that but stay in the same order of magnitude.
  const widget = out.items.find((i) => i.sku === 'WID-1');
  assert.ok(widget.spend_total >= 6500, `expected >= 6500, got ${widget.spend_total}`);
  assert.ok(widget.spend_total <= 6500 + 5 * 300 + 1, `unexpectedly high: ${widget.spend_total}`);

  // Gadget starts with 500 units against ~25/wk, so it should not need to buy
  // anything for several weeks.
  const gadget = out.items.find((i) => i.sku === 'GAD-2');
  assert.ok(gadget.order_units.slice(0, 8).every((q) => q === 0), 'well-stocked item ordered too early');
  assert.ok(Math.abs(gadget.weeks_of_cover - 20) < 0.5, `weeks of cover: ${gadget.weeks_of_cover}`);
});

test('buildForecast skips inactive products', () => {
  const products = [{ id: 1, sku: 'X', name: 'X', unit_cost: 1, lead_time_days: 7, on_hand: 0, active: 0 }];
  const out = buildForecast(products, flatSales(8, 10).map((r) => ({ ...r, product_id: 1 })), {}, '2026-04-27');
  assert.equal(out.items.length, 0);
});

test('wow_change_pct reports the 4-week trend correctly', () => {
  // 4 weeks at 100, then 4 weeks at 150 -> +50%
  const rows = [
    ...Array.from({ length: 4 }, (_, i) => ({ sale_date: addWeeks('2026-06-01', i), units: 100, product_id: 1 })),
    ...Array.from({ length: 4 }, (_, i) => ({ sale_date: addWeeks('2026-06-29', i), units: 150, product_id: 1 })),
  ];
  const out = buildForecast(
    [{ id: 1, sku: 'X', name: 'X', unit_cost: 1, lead_time_days: 7, on_hand: 0, active: 1 }],
    rows, { horizonWeeks: 4 }, '2026-07-27'
  );
  assert.equal(out.items[0].wow_change_pct, 50);
});
