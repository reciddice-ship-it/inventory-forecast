/**
 * Generates sample-data/EXAMPLE-synthetic-sales.csv — SYNTHETIC data used only
 * to exercise the importer and the forecast end to end. It is not real sales
 * data and should be deleted once you have loaded your own.
 *
 *   node sample-data/generate-example.mjs
 */
import { writeFileSync } from 'node:fs';

// Deterministic PRNG so the file is reproducible.
let seed = 20260830;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

const catalog = [
  { sku: 'BRW-250', base: 40, trend: 0.9,  weekend: 1.6, price: 18.00 },
  { sku: 'BRW-500', base: 18, trend: 0.25, weekend: 1.4, price: 32.00 },
  { sku: 'FLT-CONE', base: 95, trend: -0.6, weekend: 1.1, price: 6.50 },
  { sku: 'MUG-12',  base: 6,  trend: 0.15, weekend: 2.2, price: 22.00 },
];

const WEEKS = 30;
const end = new Date(Date.UTC(2026, 7, 24));           // Monday 2026-08-24
const start = new Date(end.getTime() - WEEKS * 7 * 86400000);

const rows = ['date,sku,units,unit_price'];
for (let d = 0; d < WEEKS * 7; d++) {
  const day = new Date(start.getTime() + d * 86400000);
  const dow = day.getUTCDay();
  const week = Math.floor(d / 7);
  for (const p of catalog) {
    const seasonal = 1 + 0.12 * Math.sin((2 * Math.PI * week) / 13);
    const dayFactor = (dow === 0 || dow === 6) ? p.weekend : 1;
    const mean = ((p.base + p.trend * week) / 7) * seasonal * dayFactor;
    const units = Math.max(0, Math.round(mean * (0.65 + 0.7 * rand())));
    if (units > 0) {
      rows.push(`${day.toISOString().slice(0, 10)},${p.sku},${units},${p.price.toFixed(2)}`);
    }
  }
}

writeFileSync(new URL('./EXAMPLE-synthetic-sales.csv', import.meta.url), rows.join('\n') + '\n');
console.log(`Wrote ${rows.length - 1} synthetic rows covering ${WEEKS} weeks.`);
