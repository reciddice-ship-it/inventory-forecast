-- schema.sql — Cloudflare D1 (SQLite)
-- Apply with:  npx wrangler d1 execute inventory --file=./schema.sql --remote

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS products (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  sku             TEXT    NOT NULL UNIQUE,
  name            TEXT    NOT NULL,
  category        TEXT,
  supplier        TEXT,
  unit_cost       REAL    NOT NULL DEFAULT 0,   -- what YOU pay per unit
  unit_price      REAL,                          -- what you sell it for (optional)
  lead_time_days  INTEGER NOT NULL DEFAULT 14,
  moq             INTEGER NOT NULL DEFAULT 0,    -- minimum order quantity
  case_pack       INTEGER NOT NULL DEFAULT 1,    -- order in multiples of this
  on_hand         REAL    NOT NULL DEFAULT 0,
  on_order        REAL    NOT NULL DEFAULT 0,
  active          INTEGER NOT NULL DEFAULT 1,
  notes           TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Exactly one row per product per day. Re-importing the same day overwrites it
-- rather than double-counting, which makes imports idempotent and makes a manual
-- correction beat a previously imported figure for that day. `source` records
-- where the current figure came from; it is metadata, not part of the key.
CREATE TABLE IF NOT EXISTS sales (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sale_date   TEXT    NOT NULL,                  -- 'YYYY-MM-DD'
  units       REAL    NOT NULL,
  unit_price  REAL,
  source      TEXT    NOT NULL DEFAULT 'manual', -- 'manual' | 'csv' | connector name
  batch_id    TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (product_id, sale_date)
);

CREATE INDEX IF NOT EXISTS idx_sales_product_date ON sales (product_id, sale_date);
CREATE INDEX IF NOT EXISTS idx_sales_date         ON sales (sale_date);

-- Audit trail for on-hand changes, so a stock count is never a silent overwrite.
CREATE TABLE IF NOT EXISTS inventory_adjustments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  delta       REAL    NOT NULL,
  new_on_hand REAL    NOT NULL,
  reason      TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS import_batches (
  id          TEXT PRIMARY KEY,
  filename    TEXT,
  row_count   INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  mapping     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Forecast defaults. Change these in the UI, not here.
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('lookbackWeeks',     '26'),
  ('halfLifeWeeks',     '6'),
  ('horizonWeeks',      '13'),
  ('damping',           '0.85'),
  ('serviceLevel',      '0.95'),
  ('reviewPeriodWeeks', '1'),
  ('useTrend',          'true'),
  ('currency',          'USD');
