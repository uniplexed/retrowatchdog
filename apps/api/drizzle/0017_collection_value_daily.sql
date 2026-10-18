-- The collection's totals as last served each UTC day, per valuation basis and
-- markets, so the collection screen can chart its value over time. Written by
-- GET /api/collection (the worker requests it after each tracked refresh).
CREATE TABLE IF NOT EXISTS collection_value_daily (
  day date NOT NULL,
  basis text NOT NULL,
  country text NOT NULL,
  include_foreign boolean NOT NULL,
  estimated_usd numeric(12, 2) NOT NULL,
  paid_usd numeric(12, 2) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, basis, country, include_foreign)
);
