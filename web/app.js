import { api, conn, ApiError } from './api.js';
import { barChart, lineChart, onResize } from './charts.js';

/* ------------------------------ state ------------------------------ */

const state = {
  products: [],
  forecast: null,
  orders: null,
  settings: null,
  preview: null,
  csvText: '',
  csvName: '',
  selectedSku: null,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const money = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const money2 = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const num = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

const fmtMoney = (v) => money.format(v || 0);
const fmtUnits = (v) => num.format(v || 0);
const shortWeek = (w) => {
  const d = new Date(w + 'T00:00:00Z');
  return `${d.getUTCDate()} ${d.toLocaleString('en', { month: 'short', timeZone: 'UTC' })}`;
};
const shortMonth = (m) => {
  const d = new Date(m + '-01T00:00:00Z');
  return d.toLocaleString('en', { month: 'short', year: '2-digit', timeZone: 'UTC' });
};

/* ---------------------------- navigation --------------------------- */

function show(view) {
  $$('main > section').forEach((s) => { s.hidden = s.id !== `view-${view}`; });
  $$('nav.tabs button').forEach((b) => {
    if (b.dataset.view === view) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  location.hash = view;
  if (view === 'dashboard') refreshForecast();
  if (view === 'orders') refreshOrders();
  if (view === 'products' || view === 'sales') refreshProducts();
  if (view === 'sales') refreshSales();
}

$$('nav.tabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));

/* ------------------------------ errors ----------------------------- */

function fail(err) {
  console.error(err);
  const box = $('#global-error');
  box.textContent = err instanceof ApiError ? err.message : (err?.message || String(err));
  box.hidden = false;
  setTimeout(() => { box.hidden = true; }, 12000);
}
function note(el, text, ok = true) {
  el.textContent = text;
  el.style.color = ok ? 'var(--good)' : 'var(--critical)';
  setTimeout(() => { el.textContent = ''; }, 5000);
}

/* ---------------------------- connection --------------------------- */

async function testConnection() {
  const label = $('#conn-state');
  if (!conn.configured) { label.textContent = 'not connected'; return false; }
  try {
    const h = await api.health();
    label.textContent = `${h.products} products`;
    return true;
  } catch (e) {
    label.textContent = 'connection failed';
    return false;
  }
}

$('#cfg-save').addEventListener('click', async () => {
  conn.set($('#cfg-url').value.trim(), $('#cfg-token').value.trim());
  const ok = await testConnection();
  note($('#cfg-msg'), ok ? 'Connected.' : 'Could not reach the API — check the URL, the token, and ALLOWED_ORIGINS.', ok);
  if (ok) { await loadSettings(); await refreshProducts(); }
});

$('#cfg-clear').addEventListener('click', () => {
  conn.clear();
  $('#cfg-url').value = ''; $('#cfg-token').value = '';
  $('#conn-state').textContent = 'not connected';
  note($('#cfg-msg'), 'Cleared.');
});

/* ------------------------------ settings --------------------------- */

async function loadSettings() {
  try {
    state.settings = await api.getSettings();
    $('#cfg-lookback').value = state.settings.lookbackWeeks;
    $('#cfg-halflife').value = state.settings.halfLifeWeeks;
    $('#cfg-damping').value = state.settings.damping;
    $('#cfg-service').value = String(state.settings.serviceLevel);
    $('#cfg-review').value = state.settings.reviewPeriodWeeks;
    $('#cfg-trend').value = String(state.settings.useTrend);
    $('#horizon').value = String(state.settings.horizonWeeks);
  } catch (e) { /* not connected yet */ }
}

$('#cfg-save-model').addEventListener('click', async () => {
  try {
    state.settings = await api.putSettings({
      lookbackWeeks: Number($('#cfg-lookback').value),
      halfLifeWeeks: Number($('#cfg-halflife').value),
      damping: Number($('#cfg-damping').value),
      serviceLevel: Number($('#cfg-service').value),
      reviewPeriodWeeks: Number($('#cfg-review').value),
      useTrend: $('#cfg-trend').value === 'true',
      horizonWeeks: Number($('#horizon').value),
    });
    note($('#cfg-model-msg'), 'Saved.');
    state.forecast = null;
  } catch (e) { note($('#cfg-model-msg'), e.message, false); }
});

/* ------------------------------ products --------------------------- */

async function refreshProducts() {
  if (!conn.configured) return;
  try {
    const includeInactive = $('#show-inactive').checked;
    const { products } = await api.listProducts(includeInactive);
    state.products = products;
    renderProducts();
    fillSkuSelects();
  } catch (e) { fail(e); }
}

function renderProducts() {
  const t = $('#table-products');
  if (!state.products.length) { t.innerHTML = ''; t.insertAdjacentHTML('afterend', ''); t.innerHTML = '<tbody><tr><td class="empty">No products yet. Add one above, or import a sales file and let it create them.</td></tr></tbody>'; return; }
  t.innerHTML = `
    <thead><tr>
      <th>SKU</th><th>Name</th><th>Category</th>
      <th class="num">Unit cost</th><th class="num">Lead time</th>
      <th class="num">On hand</th><th class="num">On order</th><th class="num">Case / MOQ</th>
      <th>Status</th><th></th>
    </tr></thead>
    <tbody>${state.products.map((p) => `
      <tr>
        <td class="sku">${esc(p.sku)}</td>
        <td>${esc(p.name)}</td>
        <td>${esc(p.category || '—')}</td>
        <td class="num">${money2.format(p.unit_cost || 0)}</td>
        <td class="num">${p.lead_time_days}d</td>
        <td class="num">${fmtUnits(p.on_hand)}</td>
        <td class="num">${fmtUnits(p.on_order)}</td>
        <td class="num">${p.case_pack} / ${p.moq}</td>
        <td>${p.active ? '<span class="pill good">● Active</span>' : '<span class="pill">Inactive</span>'}</td>
        <td class="num">
          <button class="toggle-view" data-edit="${p.id}">Edit</button>
          &nbsp;<button class="toggle-view" data-del="${p.id}">Remove</button>
        </td>
      </tr>`).join('')}</tbody>`;

  t.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => editProduct(Number(b.dataset.edit))));
  t.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => removeProduct(Number(b.dataset.del))));
}

function editProduct(id) {
  const p = state.products.find((x) => x.id === id);
  if (!p) return;
  $('#p-id').value = p.id;
  for (const f of ['sku', 'name', 'category', 'supplier', 'unit_cost', 'unit_price', 'lead_time_days', 'on_hand', 'on_order', 'case_pack', 'moq']) {
    $(`#p-${f}`).value = p[f] ?? '';
  }
  $('#p-active').value = String(p.active);
  $('#product-form-title').textContent = `Edit ${p.sku}`;
  $('#product-form-reset').hidden = false;
  $('#product-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

$('#product-form-reset').addEventListener('click', resetProductForm);
function resetProductForm() {
  $('#product-form').reset();
  $('#p-id').value = '';
  $('#p-unit_cost').value = '0'; $('#p-lead_time_days').value = '14';
  $('#p-on_hand').value = '0'; $('#p-on_order').value = '0';
  $('#p-case_pack').value = '1'; $('#p-moq').value = '0';
  $('#product-form-title').textContent = 'Add a product';
  $('#product-form-reset').hidden = true;
}

$('#product-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    sku: $('#p-sku').value.trim(), name: $('#p-name').value.trim(),
    category: $('#p-category').value.trim(), supplier: $('#p-supplier').value.trim(),
    unit_cost: Number($('#p-unit_cost').value) || 0,
    unit_price: $('#p-unit_price').value === '' ? null : Number($('#p-unit_price').value),
    lead_time_days: Number($('#p-lead_time_days').value) || 0,
    on_hand: Number($('#p-on_hand').value) || 0,
    on_order: Number($('#p-on_order').value) || 0,
    case_pack: Number($('#p-case_pack').value) || 1,
    moq: Number($('#p-moq').value) || 0,
    active: Number($('#p-active').value),
  };
  try {
    const id = $('#p-id').value;
    if (id) await api.updateProduct(id, body);
    else await api.createProduct(body);
    note($('#product-msg'), 'Saved.');
    resetProductForm();
    state.forecast = null;
    await refreshProducts();
  } catch (e2) { note($('#product-msg'), e2.message, false); }
});

async function removeProduct(id) {
  const p = state.products.find((x) => x.id === id);
  if (!p) return;
  try {
    await api.deleteProduct(id);
    note($('#product-msg'), `${p.sku} deactivated. Its sales history is kept.`);
    state.forecast = null;
    await refreshProducts();
  } catch (e) { fail(e); }
}

$('#show-inactive').addEventListener('change', refreshProducts);

function fillSkuSelects() {
  const opts = state.products.map((p) => `<option value="${esc(p.sku)}">${esc(p.sku)} — ${esc(p.name)}</option>`).join('');
  $('#s-sku').innerHTML = opts;
  $('#s-filter-sku').innerHTML = '<option value="">All SKUs</option>' + opts;
}

/* -------------------------------- sales ---------------------------- */

async function refreshSales() {
  if (!conn.configured) return;
  try {
    const params = { limit: 200 };
    const sku = $('#s-filter-sku').value;
    if (sku) params.sku = sku;
    const { sales } = await api.listSales(params);
    const t = $('#table-sales');
    if (!sales.length) { t.innerHTML = '<tbody><tr><td class="empty">No sales recorded yet.</td></tr></tbody>'; return; }
    t.innerHTML = `
      <thead><tr><th>Date</th><th>SKU</th><th>Product</th><th class="num">Units</th><th class="num">Unit price</th><th>Source</th><th></th></tr></thead>
      <tbody>${sales.map((s) => `
        <tr>
          <td>${s.sale_date}</td>
          <td class="sku">${esc(s.sku)}</td>
          <td>${esc(s.name)}</td>
          <td class="num">${fmtUnits(s.units)}</td>
          <td class="num">${s.unit_price == null ? '—' : money2.format(s.unit_price)}</td>
          <td>${esc(s.source)}</td>
          <td class="num"><button class="toggle-view" data-delsale="${s.id}">Delete</button></td>
        </tr>`).join('')}</tbody>`;
    t.querySelectorAll('[data-delsale]').forEach((b) => b.addEventListener('click', async () => {
      try { await api.deleteSale(b.dataset.delsale); state.forecast = null; refreshSales(); } catch (e) { fail(e); }
    }));
  } catch (e) { fail(e); }
}

$('#s-filter-sku').addEventListener('change', refreshSales);

async function submitSale(keepDate) {
  const row = {
    sku: $('#s-sku').value,
    sale_date: $('#s-date').value,
    units: Number($('#s-units').value),
    unit_price: $('#s-price').value === '' ? null : Number($('#s-price').value),
  };
  if (!row.sku || !row.sale_date || Number.isNaN(row.units)) {
    note($('#sales-msg'), 'SKU, date and units are all required.', false);
    return;
  }
  try {
    await api.addSales(row);
    note($('#sales-msg'), `Recorded ${row.units} × ${row.sku} on ${row.sale_date}.`);
    $('#s-units').value = ''; $('#s-price').value = '';
    if (!keepDate) $('#s-date').value = '';
    $('#s-units').focus();
    state.forecast = null;
    refreshSales();
  } catch (e) { note($('#sales-msg'), e.message, false); }
}

$('#sales-form').addEventListener('submit', (e) => { e.preventDefault(); submitSale(false); });
$('#s-add-row').addEventListener('click', () => submitSale(true));

$('#export-sales').addEventListener('click', async () => {
  try { download(await api.exportSales(), `sales-${today()}.csv`, 'text/csv'); }
  catch (e) { fail(e); }
});

/* ------------------------------- import ---------------------------- */

$('#csv-file').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  state.csvText = await f.text();
  state.csvName = f.name;
  $('#csv-text').value = state.csvText.split('\n').slice(0, 12).join('\n') + (state.csvText.split('\n').length > 12 ? '\n…' : '');
});

$('#btn-preview').addEventListener('click', doPreview);
$('#btn-remap').addEventListener('click', doPreview);

async function doPreview() {
  const pasted = $('#csv-text').value.trim();
  const csv = state.csvText || pasted;
  if (!csv) { fail(new Error('Choose a file or paste some rows first.')); return; }
  if (!state.csvText) { state.csvText = pasted; state.csvName = 'pasted'; }

  const mapping = readMapping();

  try {
    const p = await api.previewImport({ csv: state.csvText, filename: state.csvName, mapping });
    state.preview = p;
    renderPreview(p);
  } catch (e) { fail(e); }
}

/** The mapping selects, keyed by canonical field name. */
const MAP_FIELDS = {
  sale_date: '#map-date', sku: '#map-sku', units: '#map-units', unit_price: '#map-price',
  unit_cost: '#map-cost', product_name: '#map-name', category: '#map-category', on_hand: '#map-onhand',
};

function readMapping() {
  const m = {};
  for (const [field, sel] of Object.entries(MAP_FIELDS)) {
    const v = $(sel)?.value;
    if (v) m[field] = v;
  }
  return m;
}

function renderPreview(p) {
  $('#mapping-panel').hidden = false;
  const opts = (sel) => '<option value=""></option>' + p.headers.map((h) =>
    `<option value="${esc(h)}"${p.mapping[sel] === h ? ' selected' : ''}>${esc(h)}</option>`).join('');
  for (const [field, sel] of Object.entries(MAP_FIELDS)) $(sel).innerHTML = opts(field);

  $('#preview-summary').textContent =
    `${p.total_rows} rows read · ${p.valid_rows} importable` +
    (p.date_range ? ` · ${p.date_range.from} to ${p.date_range.to}` : '');

  const warnings = [];
  if (p.missing_required.length) warnings.push(`Pick a column for: ${p.missing_required.join(', ')}, then re-analyze.`);
  if (!p.mapping.unit_cost) {
    warnings.push('No unit cost column detected. Units will forecast, but every dollar figure will be zero until you either map a cost column above or set costs on the Products tab.');
  } else if (p.product_attribute_count) {
    const s = p.product_attributes_sample[0];
    warnings.push(`Product details will be applied to ${p.product_attribute_count} SKU(s) — e.g. ${s.sku}: cost ${s.unit_cost ?? '—'}${s.on_hand != null ? `, on hand ${s.on_hand}` : ''}${s.name ? `, "${s.name}"` : ''}.`);
  }
  if (p.error_count) warnings.push(`${p.error_count} row(s) could not be read — e.g. line ${p.errors[0].line}: ${p.errors[0].reason}.`);
  if (p.unknown_skus.length) warnings.push(`${p.unknown_skus.length} SKU(s) not in the catalog: ${p.unknown_skus.slice(0, 8).join(', ')}${p.unknown_skus.length > 8 ? '…' : ''}. Tick the box below to create them, or add them on the Products tab first.`);
  const box = $('#preview-warnings');
  box.hidden = !warnings.length;
  box.innerHTML = warnings.map((w) => `<div>${esc(w)}</div>`).join('');
  box.className = 'msg' + (p.missing_required.length ? ' error' : '');

  const t = $('#table-preview');
  t.innerHTML = p.sample.length
    ? `<thead><tr><th>Date</th><th>SKU</th><th class="num">Units</th><th class="num">Unit price</th></tr></thead>
       <tbody>${p.sample.map((r) => `<tr><td>${r.sale_date}</td><td class="sku">${esc(r.sku)}</td>
         <td class="num">${fmtUnits(r.units)}</td><td class="num">${r.unit_price == null ? '—' : money2.format(r.unit_price)}</td></tr>`).join('')}</tbody>`
    : '<tbody><tr><td class="empty">Nothing importable with the current mapping.</td></tr></tbody>';

  $('#btn-commit').disabled = p.missing_required.length > 0 || p.valid_rows === 0;
}

$('#btn-commit').addEventListener('click', async () => {
  const mapping = readMapping();

  $('#btn-commit').disabled = true;
  try {
    const r = await api.commitImport({
      csv: state.csvText, filename: state.csvName, mapping,
      create_missing_products: $('#create-missing').checked,
      update_products: $('#overwrite-products').checked ? 'overwrite' : true,
    });
    $('#import-result').hidden = false;
    $('#import-result-body').innerHTML = `
      <div class="msg ok">Imported ${r.imported} row(s).</div>
      <ul style="color:var(--ink-2);padding-left:18px;margin:0">
        ${r.merged_duplicate_lines ? `<li>${r.merged_duplicate_lines} duplicate SKU/date line(s) were summed.</li>` : ''}
        ${r.created_products.length ? `<li>Created ${r.created_products.length} product(s): ${esc(r.created_products.slice(0, 10).join(', '))}${r.product_fields_applied?.includes('unit_cost') ? ', with unit cost taken from the file' : ' — set their unit cost and lead time on the Products tab, spend stays zero until you do'}.</li>` : ''}
        ${r.products_updated?.length ? `<li>Updated ${r.products_updated.length} existing product(s) from ${esc((r.product_fields_applied || []).join(', '))}.</li>` : ''}
        ${r.skipped_unknown_sku ? `<li>${r.skipped_unknown_sku} row(s) skipped for unknown SKUs.</li>` : ''}
        ${r.error_count ? `<li>${r.error_count} unreadable row(s) ignored.</li>` : ''}
        <li class="mono">batch ${esc(r.batch_id)}</li>
      </ul>`;
    state.forecast = null;
    await refreshProducts();
  } catch (e) { fail(e); }
  finally { $('#btn-commit').disabled = false; }
});

/* ------------------------------ forecast --------------------------- */

$('#horizon').addEventListener('change', () => { state.forecast = null; refreshForecast(); });

async function refreshForecast() {
  if (!conn.configured) { $('#tiles').innerHTML = tileHTML('Not connected', '—', 'Open Settings and enter your Worker URL and token.'); return; }
  try {
    if (!state.forecast) state.forecast = await api.forecast({ horizonWeeks: $('#horizon').value });
    renderForecast(state.forecast);
  } catch (e) { fail(e); }
}

/**
 * Say why the dashboard is empty. A forecast of all zeros and a forecast that
 * never ran look identical on a chart, so the reason has to be stated.
 */
function renderDiagnostics(f) {
  const host = $('#diagnostics');
  const d = f.diagnostics;
  if (!d) { host.innerHTML = ''; return; }

  const blocks = [];

  if (d.active_products === 0) {
    blocks.push(['error', 'No active products.',
      'Add products on the Products tab, or import a sales file with "Create products for unknown SKUs" ticked.']);
  } else if (d.products_with_usable_history === 0) {
    blocks.push(['error', `None of your ${d.active_products} active SKUs have sales inside the history window.`,
      `The model reads sales from ${d.window_start} to ${d.window_end}. Nothing in your data falls in that range, so every forecast is zero.`]);
  }

  if (d.stale_sales.length) {
    const list = d.stale_sales.slice(0, 6).map((s) => `${s.sku} (last sale ${s.last_sale_week})`).join(', ');
    blocks.push(['error', `${d.stale_sales.length} SKU(s) have sales only from before ${d.window_start}.`,
      `${list}${d.stale_sales.length > 6 ? '…' : ''}. Either the history window is too short for this data — raise it in Settings — or the dates imported differently than you expected. Check the Sales tab.`]);
  }

  if (d.trailing_gap?.length) {
    const list = d.trailing_gap.slice(0, 6).map((s) => `${s.sku} (${s.weeks} wks since ${s.last_sale_week})`).join(', ');
    blocks.push(['error', `${d.trailing_gap.length} SKU(s) have no sales in their most recent weeks.`,
      `${list}${d.trailing_gap.length > 6 ? '…' : ''}. Empty trailing weeks count as zero demand and pull the forecast toward zero — which is right if sales genuinely stopped, and wrong if your file simply ends earlier than today. The model reads history through ${d.window_end}.`]);
  }

  if (d.sparse_history.length) {
    blocks.push(['warn', `${d.sparse_history.length} SKU(s) sell in fewer than half the weeks on record.`,
      `${d.sparse_history.slice(0, 8).join(', ')}. If your file holds weekly or monthly totals rather than one row per day, the gaps between them are being read as weeks of zero demand and the forecast will run low.`]);
  }

  if (d.zero_cost.length) {
    blocks.push(['warn', `${d.zero_cost.length} SKU(s) have a unit cost of 0.`,
      `${d.zero_cost.slice(0, 8).join(', ')}. Units are forecast normally, but these contribute nothing to any dollar figure. Set unit cost on the Products tab.`]);
  }

  if (d.no_sales.length) {
    blocks.push(['warn', `${d.no_sales.length} active SKU(s) have no sales at all.`,
      d.no_sales.slice(0, 8).join(', ') + '.']);
  }

  if (d.thin_history.length) {
    blocks.push(['warn', `${d.thin_history.length} SKU(s) have too little history for a trend.`,
      `${d.thin_history.slice(0, 8).join(', ')}. These use a flat weighted average until they have ${f.settings.minHistoryWeeks}+ weeks.`]);
  }

  host.innerHTML = blocks.map(([kind, title, body]) =>
    `<div class="msg ${kind === 'error' ? 'error' : ''}"><b>${esc(title)}</b><br>${esc(body)}</div>`).join('');
}

function renderForecast(f) {
  renderDiagnostics(f);
  const horizonWeeks = f.weeks.length;
  const first4 = f.weekly_spend.slice(0, 4).reduce((a, b) => a + b, 0);
  const atRisk = f.items.filter((i) => i.stockout_weeks.length).length;
  const thin = f.items.filter((i) => i.unit_cost === 0).length;

  $('#tiles').innerHTML = [
    tileHTML(`Spend · next ${horizonWeeks} weeks`, fmtMoney(f.total_spend), `${f.items.length} active SKU${f.items.length === 1 ? '' : 's'}`),
    tileHTML('Spend · next 4 weeks', fmtMoney(first4), 'Nearest commitments'),
    tileHTML('Units · forecast', fmtUnits(f.weekly_demand_units.reduce((a, b) => a + b, 0)), `over ${horizonWeeks} weeks`),
    tileHTML('SKUs projected to stock out', String(atRisk),
      atRisk ? 'Even after suggested orders — check lead times' : 'None on the current plan'),
  ].join('');

  if (thin) {
    $('#basis-note').textContent = `${thin} SKU(s) have a unit cost of 0 — their spend shows as zero.`;
  } else {
    $('#basis-note').textContent = 'Basis column shows which model each SKU used.';
  }

  barChart($('#chart-weekly'), {
    labels: f.weeks, values: f.weekly_spend, format: fmtMoney,
    labelFormat: shortWeek, tipTitle: (w) => `Week of ${w}`,
    ariaLabel: 'Projected purchase spend by week',
  });
  renderValueTable('#table-chart-weekly', 'Week', f.weeks, f.weekly_spend, fmtMoney);

  barChart($('#chart-monthly'), {
    labels: f.monthly_spend.map((m) => m.month), values: f.monthly_spend.map((m) => m.value),
    format: fmtMoney, labelFormat: shortMonth, height: 220,
    ariaLabel: 'Projected purchase spend by month',
  });
  renderValueTable('#table-chart-monthly', 'Month', f.monthly_spend.map((m) => m.month), f.monthly_spend.map((m) => m.value), fmtMoney);

  barChart($('#chart-units'), {
    labels: f.weeks, values: f.weekly_demand_units, format: fmtUnits,
    labelFormat: shortWeek, tipTitle: (w) => `Week of ${w}`, height: 220,
    ariaLabel: 'Projected units sold by week',
  });

  renderItems(f.items);
  renderSkuPicker(f.items);
}

function renderItems(items) {
  const t = $('#table-items');
  if (!items.length) {
    t.innerHTML = '<tbody><tr><td class="empty">No active products with sales history yet.</td></tr></tbody>';
    return;
  }
  const sorted = [...items].sort((a, b) => b.spend_total - a.spend_total);
  t.innerHTML = `
    <thead><tr>
      <th>SKU</th><th>Product</th>
      <th class="num">Weekly demand</th><th class="num">Trend / wk</th><th class="num">4-wk change</th>
      <th class="num">On hand</th><th class="num">Cover</th><th class="num">Safety</th>
      <th class="num">First order</th><th class="num">Spend</th><th>Basis</th>
    </tr></thead>
    <tbody>${sorted.map((i) => `
      <tr>
        <td class="sku">${esc(i.sku)}</td>
        <td>${esc(i.name)}</td>
        <td class="num">${fmtUnits(i.level_units_per_week)}</td>
        <td class="num">${i.trend_units_per_week > 0 ? '+' : ''}${i.trend_units_per_week.toFixed(1)}</td>
        <td class="num">${i.wow_change_pct == null ? '—' : `${i.wow_change_pct > 0 ? '+' : ''}${i.wow_change_pct.toFixed(0)}%`}</td>
        <td class="num">${fmtUnits(i.on_hand)}</td>
        <td class="num">${coverCell(i)}</td>
        <td class="num">${fmtUnits(i.safety_stock)}</td>
        <td class="num">${i.first_order_week || '—'}</td>
        <td class="num">${fmtMoney(i.spend_total)}</td>
        <td><span class="panel-note">${basisLabel(i.basis)}</span></td>
      </tr>`).join('')}</tbody>`;
}

function coverCell(i) {
  if (i.weeks_of_cover == null) return '—';
  const w = i.weeks_of_cover;
  const leadWeeks = i.lead_time_days / 7;
  // Icon + label, never colour alone.
  if (w < leadWeeks) return `<span class="pill critical">▲ ${w.toFixed(1)} wk</span>`;
  if (w < leadWeeks + 1) return `<span class="pill serious">▲ ${w.toFixed(1)} wk</span>`;
  if (w > 16) return `<span class="pill warning">◆ ${w.toFixed(1)} wk</span>`;
  return `<span class="pill good">● ${w.toFixed(1)} wk</span>`;
}

function basisLabel(b) {
  return {
    'wls-damped-trend': 'trend',
    'weighted-mean': 'flat avg (thin history)',
    'no-history': 'no sales',
    'stale-history': 'sales predate window',
  }[b] || b;
}

function renderSkuPicker(items) {
  const sel = $('#sku-picker');
  sel.innerHTML = items.map((i) => `<option value="${esc(i.sku)}">${esc(i.sku)} — ${esc(i.name)}</option>`).join('');
  if (state.selectedSku && items.some((i) => i.sku === state.selectedSku)) sel.value = state.selectedSku;
  else state.selectedSku = items[0]?.sku || null;
  drawSkuChart();
}

$('#sku-picker').addEventListener('change', (e) => { state.selectedSku = e.target.value; drawSkuChart(); });

function drawSkuChart() {
  const host = $('#chart-sku');
  const item = state.forecast?.items.find((i) => i.sku === state.selectedSku);
  if (!item) { host.innerHTML = '<p class="empty">Pick a SKU.</p>'; return; }

  const labels = [...item.history.weeks, ...item.weeks];
  const n = item.history.weeks.length;
  const actual = [...item.history.units, ...item.weeks.map(() => null)];
  const forecast = labels.map((_, i) =>
    i < n - 1 ? null : (i === n - 1 ? item.history.units[n - 1] : item.demand[i - n]));

  lineChart(host, {
    labels,
    series: [
      { name: 'Actual', values: actual },
      { name: 'Forecast', values: forecast, dashed: true },
    ],
    format: fmtUnits, labelFormat: shortWeek, height: 260,
    ariaLabel: `Weekly units sold and forecast for ${item.sku}`,
  });
}

/* ------------------------------- orders ---------------------------- */

async function refreshOrders() {
  if (!conn.configured) return;
  try {
    state.orders = await api.purchaseOrders({ weeks: $('#horizon').value });
    const t = $('#table-orders');
    const o = state.orders.orders;
    if (!o.length) {
      t.innerHTML = '<tbody><tr><td class="empty">No purchase orders needed over this horizon.</td></tr></tbody>';
      return;
    }
    t.innerHTML = `
      <thead><tr><th>Place in week</th><th>SKU</th><th>Product</th><th class="num">Units</th><th class="num">Unit cost</th><th class="num">Cost</th><th class="num">Lead time</th><th>Arrives</th></tr></thead>
      <tbody>${o.map((r) => `
        <tr><td>${r.week}</td><td class="sku">${esc(r.sku)}</td><td>${esc(r.name)}</td>
        <td class="num">${fmtUnits(r.units)}</td><td class="num">${money2.format(r.unit_cost)}</td>
        <td class="num">${fmtMoney(r.cost)}</td><td class="num">${r.lead_time_days}d</td><td>${r.arrives_week}</td></tr>`).join('')}
      <tr><th colspan="5">Total</th><th class="num">${fmtMoney(state.orders.total_spend)}</th><th></th><th></th></tr>
      </tbody>`;
  } catch (e) { fail(e); }
}

$('#export-orders').addEventListener('click', () => {
  if (!state.orders?.orders?.length) return;
  const head = 'order_week,sku,name,units,unit_cost,cost,lead_time_days,arrives_week';
  const body = state.orders.orders.map((r) =>
    [r.week, r.sku, r.name, r.units, r.unit_cost, r.cost, r.lead_time_days, r.arrives_week].map(csvCell).join(','));
  download([head, ...body].join('\n'), `purchase-orders-${today()}.csv`, 'text/csv');
});

/* ------------------------------- helpers --------------------------- */

function tileHTML(label, value, sub) {
  return `<div class="tile"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="sub">${esc(sub)}</div></div>`;
}

function renderValueTable(sel, header, labels, values, fmt) {
  const host = $(sel);
  host.innerHTML = `<table><thead><tr><th>${header}</th><th class="num">Value</th></tr></thead>
    <tbody>${labels.map((l, i) => `<tr><td>${l}</td><td class="num">${fmt(values[i])}</td></tr>`).join('')}</tbody></table>`;
}

$$('[data-table-for]').forEach((btn) => btn.addEventListener('click', () => {
  const chart = $(`#${btn.dataset.tableFor}`);
  const table = $(`#table-${btn.dataset.tableFor}`);
  const showTable = table.hidden;
  table.hidden = !showTable;
  chart.hidden = showTable;
  btn.textContent = showTable ? 'Show as chart' : 'Show as table';
}));

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function today() { return new Date().toISOString().slice(0, 10); }
function download(text, filename, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* -------------------------------- boot ----------------------------- */

onResize(() => {
  if (state.forecast && !$('#view-dashboard').hidden) renderForecast(state.forecast);
});

(async function boot() {
  const c = conn.get();
  $('#cfg-url').value = c.baseUrl || '';
  $('#cfg-token').value = c.token || '';
  $('#s-date').value = today();

  const view = (location.hash || '#dashboard').slice(1);
  const known = ['dashboard', 'orders', 'products', 'sales', 'import', 'settings'];

  if (!conn.configured) { show('settings'); return; }

  const ok = await testConnection();
  await loadSettings();
  await refreshProducts();
  show(known.includes(view) ? view : 'dashboard');
  if (!ok) fail(new ApiError('Connected settings are saved but the API did not respond. Check Settings.', 0));
})();
