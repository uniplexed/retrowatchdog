-- Every distinct signal the worker saw, and how it turned out evalDays later.
-- Written only by the worker (signals/log.ts); read by GET /api/insights.
CREATE TABLE IF NOT EXISTS signal_log (
  id serial PRIMARY KEY,
  key text NOT NULL,
  game_id integer NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  watch_id integer,
  copy_id integer,
  type text NOT NULL,
  source text,
  -- the price kind a sell-side signal was read from (sellKind), so it is judged against the same kind
  kind text,
  region text NOT NULL,
  condition text NOT NULL,
  confidence text NOT NULL,
  price_usd numeric(12, 2),
  price_original numeric(12, 2),
  currency text,
  reference_usd numeric(12, 2),
  edge_pct real,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  evaluated_at timestamptz,
  outcome text,
  outcome_price_usd numeric(12, 2),
  gain_usd numeric(12, 2)
);
CREATE INDEX IF NOT EXISTS signal_log_key_first_seen ON signal_log (key, first_seen_at);
CREATE INDEX IF NOT EXISTS signal_log_evaluated_at ON signal_log (evaluated_at);
