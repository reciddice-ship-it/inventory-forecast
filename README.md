# Inventory Forecast

A self-hosted inventory planning tool. You feed it sales data — typed in or
imported from a spreadsheet — and it projects how many units each SKU will sell,
when you need to place orders, and **how much cash that commits, by week and by
month**.

Two pieces, both on free tiers:

| Piece | What it is | Where it runs |
|---|---|---|
| `web/` | Static single-page UI, no build step, no dependencies | GitHub Pages |
| `api/` | REST API on a Cloudflare Worker with a D1 (SQLite) database | Cloudflare |

The UI holds no data of its own. It talks to your Worker, and your data lives in
your D1 database. Nothing is written to the repository.

---

## What it does

- **Products** — SKU, unit cost, lead time, case pack, minimum order quantity, stock on hand.
- **Sales entry** — type a SKU/date/units, or import a CSV with automatic column detection.
- **Demand forecast** — weekly units per SKU from a recency-weighted trend fit.
- **Spend forecast** — a week-by-week replenishment simulation converts demand into purchase orders, and orders into dollars. Weekly and monthly views.
- **Purchasing list** — every suggested order with the week to place it, the quantity, the cost, and the week it lands.
- **Safety stock** — sized from each SKU's own demand volatility and your target service level.

---

## Setup

You need a [GitHub](https://github.com) account and a free
[Cloudflare](https://dash.cloudflare.com/sign-up) account. Roughly 15 minutes.

### 1. Get the code onto GitHub

```bash
git init
git add .
git commit -m "Initial commit"
gh repo create inventory-forecast --private --source=. --push
```

No `gh` CLI? Create an empty repo in the GitHub UI, then:

```bash
git remote add origin https://github.com/reciddice-ship-it/inventory-forecast.git
git branch -M main
git push -u origin main
```

### 2. Create the database

```bash
cd api
npm install
npx wrangler login          # opens a browser to authorise
npx wrangler d1 create inventory-forecast
```

The `database_id` is already filled in for this account. Create the tables:

```bash
npm run db:migrate
```

### 3. Set your API token

Any long random string. Generate one:

```bash
openssl rand -hex 32
```

Store it as a Worker secret (it never goes in the repo):

```bash
npx wrangler secret put API_TOKEN
# paste the value when prompted
```

### 4. Deploy the API

```bash
npm run deploy
```

Wrangler prints a URL like
`https://inventory-forecast-api.<your-subdomain>.workers.dev`. Save it.

Check it:

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  https://inventory-forecast-api.<your-subdomain>.workers.dev/api/health
```

### 5. Turn on GitHub Pages

In your repo: **Settings → Pages → Build and deployment → Source = GitHub
Actions**. Push to `main` and the included workflow publishes `web/` to
`https://reciddice-ship-it.github.io/inventory-forecast/`.

### 6. Origin lock

`ALLOWED_ORIGINS` in `api/wrangler.toml` is already set to the Pages origin plus
localhost for development. Change it there and redeploy if the UI ever moves.

### 7. Connect the UI

Open your Pages URL, go to **Settings**, and enter the Worker URL and the API
token. Both are stored in your browser's local storage only.

### 8. Load your data

Either add products first (Products tab) and then import sales, or import a
sales CSV with **"Create products for unknown SKUs"** ticked and fill in unit
cost and lead time afterwards. **Spend figures are zero until unit costs are
set** — the demand forecast works without them, the dollar forecast does not.

---

## Running it locally

```bash
# terminal 1 — the API against a local SQLite file
cd api
npm install
printf 'API_TOKEN=devtoken\n' > .dev.vars
npm run db:migrate:local
npx wrangler dev

# terminal 2 — the UI
cd web
python3 -m http.server 8080
```

Open <http://127.0.0.1:8080>, and in Settings use `http://127.0.0.1:8787` with
the token `devtoken`.

`sample-data/` contains a generator for synthetic sales data
(`node sample-data/generate-example.mjs`) if you want to exercise the importer
before touching real numbers. **It is fabricated data for testing only** — delete
the CSV once you've loaded your own.

Run the tests:

```bash
node --test test/*.mjs
```

---

## How the forecast works

**1 — Roll up.** Daily sales become ISO (Monday-start) weeks. Weeks with no
sales count as zero, because that is real demand information; weeks *before* a
SKU's first ever sale are excluded, because that is just pre-launch absence and
padding it with zeros would drag the average down. The current, partial week is
excluded so a Tuesday reading isn't mistaken for a slow week.

**2 — Fit.** A weighted least-squares line runs through the weekly unit history.
Weights decay exponentially with a half-life you control (default 6 weeks), so a
week six weeks old counts half as much as the latest one. The fit yields:

- **level** — the fitted value at the most recent week: current demand in units/week
- **trend** — the slope, in units/week/week

**3 — Project.** Future week *h* is `level + trend × Σφⁱ` for *i* = 1..*h*, with
φ (damping) defaulting to 0.85. Undamped extrapolation of a short-run slope over
a long horizon is how forecasts end up predicting you'll sell a million units in
May; damping bends it back toward flat. Forecasts are floored at zero.

A SKU with fewer than three weeks of history skips the trend entirely and uses a
flat weighted average — a slope fitted to two points is noise, not information.
The per-SKU table's **Basis** column tells you which one each SKU used.

**4 — Size the buffer.** Forecast error σ is the weighted RMS of the fit
residuals. Safety stock is `z × σ × √(lead time + review period)`, where z comes
from your service level (95% → 1.64). A SKU whose sales bounce around carries a
bigger buffer than a steady one at the same volume — automatically.

**5 — Simulate the buying.** Week by week: receive anything arriving, subtract
forecast demand, and at each review point compare inventory position (on hand +
on order) against an order-up-to level of *expected demand over the coverage
window + safety stock*. If it's short, order the difference, rounded up to the
case pack and floored at the MOQ. Those orders × unit cost are the spend
forecast; weekly figures split across calendar months by day count for the
monthly view.

### When the forecast comes back empty

A forecast of all zeros and a forecast that never ran look identical on a chart,
so the dashboard states the reason at the top instead of leaving you to guess.
The five it detects:

| What you see | What it means | Fix |
|---|---|---|
| *Sales only from before a date* | Every sale for that SKU predates the history window. The model reads the last N weeks only; older data is invisible to it. | Raise **History window** in Settings, or check the dates actually imported. |
| *No sales in their most recent weeks* | The history ends before today, and the empty trailing weeks read as real zero demand, dragging the level down hard. | Load the missing weeks. If sales genuinely stopped, the low forecast is correct. |
| *Sells in fewer than half the weeks on record* | Usually a file holding weekly or monthly totals rather than one row per day. The gaps between totals count as zero-demand weeks. | Import daily rows, or spread each period total across its weeks first. |
| *Unit cost of 0* | Units forecast normally, but the SKU contributes nothing to any dollar figure. | Set unit cost on the Products tab. |
| *No sales at all* | The SKU exists but no sales matched it — often a SKU mismatch between catalog and import file. | Check the SKU spelling in both places. |

The per-SKU table's **Basis** column carries the same information one row at a
time: `trend`, `flat avg (thin history)`, `sales predate window`, or `no sales`.

### Things worth knowing

- Spend is dated to the week the order is **placed**, not when it arrives — it's a cash-commitment view. The purchasing table shows both dates.
- Orders near the end of the horizon buy stock consumed after the horizon. That's correct for cash planning, but it means total spend isn't the same as cost-of-goods over the window.
- "SKUs projected to stock out" counts SKUs that run out *even with* the suggested orders. Usually it means current stock is already below what the lead time requires — the model can't order in the past.
- The model has **no seasonality term**. With a 26-week lookback it will read the front edge of a seasonal ramp as trend. If your business has strong annual seasonality, treat long horizons as directional and lean on the weekly view.
- Everything is deterministic. Same data and settings, same numbers.

---

## Model settings

Set on the Settings tab; stored server-side and applied to every forecast.

| Setting | Default | What it does |
|---|---|---|
| History window | 26 weeks | How far back the fit reads. Shorter reacts faster; longer is steadier. |
| Recency half-life | 6 weeks | Smaller = more weight on recent weeks. |
| Trend damping | 0.85 | 1.0 extrapolates the slope in a straight line; lower flattens it out. |
| Service level | 95% | Target in-stock probability. Drives the safety-stock multiplier. |
| Review period | 1 week | How often you actually place orders. |
| Trend | on | Off = flat weighted average for every SKU. |
| Horizon | 13 weeks | How far forward to project. |

---

## API reference

Every route needs `Authorization: Bearer <API_TOKEN>`.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | Liveness + product count |
| GET | `/api/products` | `?include_inactive=1` |
| POST | `/api/products` | Object or array; upserts on SKU |
| GET | `/api/products/:id` | |
| PATCH | `/api/products/:id` | On-hand changes are logged to `inventory_adjustments` |
| DELETE | `/api/products/:id` | Deactivates; `?hard=1` deletes with its sales |
| GET | `/api/sales` | `?product_id=&sku=&from=&to=&limit=` |
| POST | `/api/sales` | Object or array of `{sku\|product_id, sale_date, units, unit_price?}` |
| DELETE | `/api/sales` | `?product_id=&from=&to=&batch_id=` — refuses an unfiltered wipe |
| DELETE | `/api/sales/:id` | |
| GET | `/api/sales/weekly` | `?weeks=&product_id=` — weekly rollup per SKU |
| POST | `/api/sales/preview` | `{csv, mapping?, delimiter?}` — dry run, writes nothing |
| POST | `/api/sales/import` | `{csv, mapping, create_missing_products?, default_unit_cost?, default_lead_time_days?}` |
| GET | `/api/settings` · PUT | Model settings |
| GET | `/api/forecast` | Query params override stored settings for that call |
| GET | `/api/forecast/purchase-orders` | `?weeks=` — flattened buy list |
| GET | `/api/export/sales.csv` | Full sales history |

Example:

```bash
curl -X POST https://YOUR-WORKER/api/sales \
  -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '[{"sku":"BRW-250","sale_date":"2026-08-24","units":63,"unit_price":18.00}]'

curl -H "Authorization: Bearer $TOKEN" \
  "https://YOUR-WORKER/api/forecast?horizonWeeks=26&serviceLevel=0.99"
```

### Import behaviour

The importer guesses columns from common export headers (Shopify, Square,
Amazon, QuickBooks and plain spreadsheets), and handles quoted fields, embedded
commas and newlines, `$1,234.50`, `(45)` for negatives, `08/30/2026`,
`30 Aug 2026`, ISO timestamps and Excel serial dates. `preview` shows you the
mapping, the parsed sample, the date range, unknown SKUs and per-line errors
before anything is written.

Matching scores whole words rather than substrings, and each column is claimed
by at most one field — so `lost_sales_units` is not mistaken for revenue, and
`starting_inventory_units` is not mistaken for units sold.

**Product details come in too.** Most sales exports repeat the item's cost,
name, category and stock level on every row, so the importer maps those as well
and applies them to the catalog, taking each value from the SKU's most recent
row. Unit cost is the one that matters: without it the unit forecast still works
but every dollar figure is zero. Existing products have blank or zero fields
filled in only — a cost you typed by hand is never overwritten unless you tick
**Overwrite existing cost and stock**.

If your export separates true demand from units sold (a `forecastable_demand_units`
or similar column alongside `units_sold`), map that as the units column. Sales
are censored by stockouts; demand is not, and forecasting on censored sales
quietly under-orders the items that sold out.

**One row per SKU per day.** Re-importing a file overwrites those days rather
than double-counting, so imports are idempotent and a manual correction beats a
previously imported figure. Multiple lines for the same SKU and day within one
file are summed.

---

## Security

- One shared bearer token. It's a single-tenant tool — there are no user accounts, and anyone with the token has full read/write access.
- The token lives in a Worker secret and in your browser's local storage. It is never committed.
- `ALLOWED_ORIGINS` should name your Pages URL, not `*`.
- Rotate with `npx wrangler secret put API_TOKEN`, then re-enter it in Settings.
- `.dev.vars` and `wrangler.test.toml` are gitignored. Keep it that way.

## Cost

Cloudflare's free tier covers Workers (100k requests/day) and D1 (5 GB storage,
5 million row reads/day). A few hundred SKUs with daily sales is a rounding error
against those limits. GitHub Pages is free for public repos and included with
Pro for private ones.

## Layout

```
api/
  src/
    index.js            Worker entry: router, auth, CORS
    forecast.js         The model — pure functions, no dependencies
    csv.js              RFC 4180 parser, header guessing, value coercion
    lib/http.js         JSON/CORS/auth helpers, router
    routes/             products · sales · forecast
  schema.sql            D1 tables
  wrangler.toml         Bindings and vars
web/
  index.html            The whole UI
  app.js                Views and interactions
  charts.js             Inline SVG charts, no libraries
  api.js                Fetch client
  styles.css            Tokens, light + dark
test/                   Node test-runner suites for the model and the parser
sample-data/            Synthetic data generator (testing only)
```

## Extending it

- **Pull from a POS or e-commerce API** — the ingest path is `POST /api/sales` with `{sku, sale_date, units}`. A Cloudflare Cron Trigger that fetches and posts nightly is about 40 lines; add it as a `scheduled()` export in `api/src/index.js`.
- **Seasonality** — `forecastDemand()` in `api/src/forecast.js` is the only place the model lives. Holt-Winters or a week-of-year index would slot in behind the same return shape, and `test/forecast.test.mjs` will tell you if you've broken the contract.
- **Multiple locations** — add a `location_id` to `products` and `sales` and group by it in `buildForecast()`.

## License

MIT — see `LICENSE`.
