import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCSV, parseCSVObjects, sniffDelimiter, guessMapping,
  normalizeDate, normalizeNumber, mapSalesRecords,
} from '../api/src/csv.js';

test('parseCSV handles quotes, embedded commas and newlines', () => {
  const text = 'a,b,c\n1,"hello, world",3\n2,"line\nbreak",4\n3,"say ""hi""",5';
  const rows = parseCSV(text);
  assert.deepEqual(rows[1], ['1', 'hello, world', '3']);
  assert.deepEqual(rows[2], ['2', 'line\nbreak', '4']);
  assert.deepEqual(rows[3], ['3', 'say "hi"', '5']);
});

test('parseCSV strips a BOM and tolerates CRLF', () => {
  const rows = parseCSV('﻿a,b\r\n1,2\r\n');
  assert.deepEqual(rows, [['a', 'b'], ['1', '2']]);
});

test('sniffDelimiter detects tabs and semicolons', () => {
  assert.equal(sniffDelimiter('a\tb\tc\n1\t2\t3'), '\t');
  assert.equal(sniffDelimiter('a;b;c\n1;2;3'), ';');
  assert.equal(sniffDelimiter('a,b,c\n1,2,3'), ',');
});

test('parseCSVObjects keys rows by header', () => {
  const { headers, records } = parseCSVObjects('sku,units\nA-1,5\nA-2,7');
  assert.deepEqual(headers, ['sku', 'units']);
  assert.deepEqual(records[0], { sku: 'A-1', units: '5' });
});

test('guessMapping recognises common export headers', () => {
  assert.deepEqual(
    guessMapping(['Order Date', 'Variant SKU', 'Net Quantity', 'Gross Sales']),
    { sale_date: 'Order Date', sku: 'Variant SKU', units: 'Net Quantity', revenue: 'Gross Sales' }
  );
  const m = guessMapping(['date', 'sku', 'qty', 'unit price']);
  assert.equal(m.sale_date, 'date');
  assert.equal(m.units, 'qty');
  assert.equal(m.unit_price, 'unit price');
});

test('normalizeDate handles the formats spreadsheets actually emit', () => {
  assert.equal(normalizeDate('2026-08-30'), '2026-08-30');
  assert.equal(normalizeDate('2026/8/5'), '2026-08-05');
  assert.equal(normalizeDate('08/30/2026'), '2026-08-30');
  assert.equal(normalizeDate('8/5/26'), '2026-08-05');
  assert.equal(normalizeDate('30 Aug 2026'), '2026-08-30');
  assert.equal(normalizeDate('Aug 30, 2026'), '2026-08-30');
  assert.equal(normalizeDate('46264'), '2026-08-30');   // Excel serial
  assert.equal(normalizeDate('2026-08-30T14:22:00Z'), '2026-08-30');
  assert.equal(normalizeDate(''), null);
  assert.equal(normalizeDate('not a date'), null);
});

test('normalizeNumber strips currency, separators and parenthesised negatives', () => {
  assert.equal(normalizeNumber('$1,234.50'), 1234.5);
  assert.equal(normalizeNumber('(45)'), -45);
  assert.equal(normalizeNumber('  12 '), 12);
  assert.equal(normalizeNumber('-3.5'), -3.5);
  assert.equal(normalizeNumber(''), null);
  assert.equal(normalizeNumber('n/a'), null);
});

test('mapSalesRecords validates rows and reports line numbers', () => {
  const csv = 'date,sku,qty,price\n2026-08-03,A-1,10,$4.00\nbogus,A-2,5,1\n2026-08-04,,3,1\n2026-08-05,A-3,,1';
  const { headers, records } = parseCSVObjects(csv);
  const mapping = guessMapping(headers);
  const { rows, errors } = mapSalesRecords(records, mapping);

  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { sku: 'A-1', sale_date: '2026-08-03', units: 10, unit_price: 4 });
  assert.equal(errors.length, 3);
  assert.equal(errors[0].line, 3);
  assert.match(errors[0].reason, /date/);
  assert.equal(errors[1].line, 4);
  assert.match(errors[1].reason, /SKU/);
  assert.equal(errors[2].line, 5);
  assert.match(errors[2].reason, /units/);
});

test('mapSalesRecords derives units from revenue and price when units are absent', () => {
  const csv = 'date,sku,price,revenue\n2026-08-03,A-1,5,100';
  const { headers, records } = parseCSVObjects(csv);
  const mapping = { ...guessMapping(headers), units: 'nonexistent' };
  const { rows } = mapSalesRecords(records, mapping);
  assert.equal(rows[0].units, 20);
});

/* ------------- product attributes carried on sales rows ------------- */

import { mapProductRecords, PRODUCT_FIELDS } from '../api/src/csv.js';

// The header set from a real retail weekly-sales export: sales history and
// product master data in one file, with several near-miss column names.
const RETAIL_HEADERS = [
  'week_start', 'week_end', 'year', 'week_number', 'sku', 'product_name', 'category',
  'product_line', 'list_price', 'unit_cost', 'avg_selling_price', 'promotion_flag',
  'discount_pct', 'starting_inventory_units', 'received_units', 'available_units',
  'forecastable_demand_units', 'units_sold', 'lost_sales_units', 'ending_inventory_units',
  'stockout_days', 'sell_through_pct', 'sales_revenue', 'cogs', 'gross_margin',
  'gross_margin_pct', 'store_traffic', 'conversion_rate_pct',
];

test('guessMapping handles a wide retail export without cross-wiring columns', () => {
  const m = guessMapping(RETAIL_HEADERS);
  assert.equal(m.sale_date, 'week_start');
  assert.equal(m.sku, 'sku');
  assert.equal(m.units, 'units_sold', 'must not grab starting/available/received units');
  assert.equal(m.unit_cost, 'unit_cost', 'cost is what makes the spend forecast non-zero');
  assert.equal(m.unit_price, 'avg_selling_price', 'actual selling price beats list price');
  assert.equal(m.revenue, 'sales_revenue', 'must not match lost_sales_units on the word "sales"');
  assert.equal(m.product_name, 'product_name');
  assert.equal(m.category, 'category');
  assert.equal(m.on_hand, 'ending_inventory_units');
});

test('guessMapping never assigns one header to two fields', () => {
  const m = guessMapping(RETAIL_HEADERS);
  const used = Object.values(m);
  assert.equal(used.length, new Set(used).size, `duplicate header assignment: ${JSON.stringify(m)}`);
});

test('guessMapping still handles a minimal three-column file', () => {
  const m = guessMapping(['date', 'sku', 'qty']);
  assert.deepEqual({ sale_date: m.sale_date, sku: m.sku, units: m.units },
    { sale_date: 'date', sku: 'sku', units: 'qty' });
  assert.equal(m.unit_cost, undefined);
});

test('mapProductRecords takes attributes from each SKUs most recent row', () => {
  const csv = [
    'week_start,sku,units_sold,unit_cost,product_name,category,ending_inventory_units',
    '2026-03-02,A-1,10,40,Old Name,Running,100',
    '2026-08-24,A-1,12,49,AeroStride Runner,Running,26',
    '2026-08-24,B-2,5,38,FlexFit Trainer,Training,20',
  ].join('\n');
  const { headers, records } = parseCSVObjects(csv);
  const attrs = mapProductRecords(records, guessMapping(headers));

  assert.equal(attrs.size, 2);
  const a = attrs.get('A-1');
  assert.equal(a.unit_cost, 49, 'latest cost, not the earliest');
  assert.equal(a.name, 'AeroStride Runner');
  assert.equal(a.on_hand, 26, 'stock must come from the most recent week');
  assert.equal(a.category, 'Running');
  assert.equal(attrs.get('B-2').unit_cost, 38);
});

test('mapProductRecords returns nothing when no product columns are mapped', () => {
  const { headers, records } = parseCSVObjects('date,sku,qty\n2026-08-03,A-1,5');
  assert.equal(mapProductRecords(records, guessMapping(headers)).size, 0);
});

test('mapProductRecords ignores blank cells rather than erasing known values', () => {
  const csv = [
    'week_start,sku,units_sold,unit_cost,product_name',
    '2026-03-02,A-1,10,40,Real Name',
    '2026-08-24,A-1,12,45,',
  ].join('\n');
  const { headers, records } = parseCSVObjects(csv);
  const a = mapProductRecords(records, guessMapping(headers)).get('A-1');
  assert.equal(a.unit_cost, 45);
  assert.equal(a.name, 'Real Name', 'a blank later cell must not wipe an earlier value');
});

test('PRODUCT_FIELDS lists exactly the catalog-side fields', () => {
  assert.deepEqual(PRODUCT_FIELDS, ['unit_cost', 'product_name', 'category', 'on_hand', 'lead_time_days']);
});
