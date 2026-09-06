-- Splint Tracker — D1 (SQLite) schema
-- Mirrors the Neon Postgres schema (project lively-sun-01896393, db neondb) column-for-column.

CREATE TABLE splint_masterdata (
  asset_id            TEXT PRIMARY KEY,      -- was uuid
  asset_name          TEXT NOT NULL,
  asset_category      TEXT,
  asset_subcategory   TEXT,
  asset_category_old  TEXT,
  notes               TEXT,
  release_date        TEXT,                  -- ISO date string YYYY-MM-DD
  min_horizon         INTEGER,
  max_horizon         INTEGER,
  eroi                REAL
);

CREATE TABLE splint_prices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id    TEXT NOT NULL REFERENCES splint_masterdata(asset_id),
  asset_name  TEXT,
  month       TEXT,                          -- 'YYYY-MM'
  price_date  TEXT,                          -- ISO date string
  price       REAL NOT NULL,
  currency    TEXT NOT NULL,
  UNIQUE(asset_id, month)
);
CREATE INDEX idx_prices_asset_id ON splint_prices(asset_id);

CREATE TABLE splint_transactions (
  transaction_id    INTEGER PRIMARY KEY,     -- keep Neon's numeric IDs as-is
  transaction_type  TEXT NOT NULL,
  asset_id          TEXT NOT NULL REFERENCES splint_masterdata(asset_id),
  transaction_date  TEXT,
  money_amount      REAL,
  money_currency    TEXT,
  price_per_splint  REAL,
  price_currency    TEXT,
  fees              REAL,
  fees_currency     TEXT,
  confirmation_doc  TEXT,
  day1_profit       REAL,
  fx_rate           REAL
);
CREATE INDEX idx_transactions_asset_id ON splint_transactions(asset_id);
