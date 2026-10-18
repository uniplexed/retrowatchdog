-- Which watchlist signals the user has already been told about, so a standing
-- opportunity is announced once and not every four hours. A row is deleted as
-- soon as its signal stops being there, so one that comes back is news again.
-- The key is `watch|type|source|buySource|sellSource|sellKind` (worker/alerts.ts)
-- and deliberately leaves the price out: a penny's move is not a new signal.
CREATE TABLE IF NOT EXISTS alerts_sent (
  key text PRIMARY KEY,
  sent_at timestamptz NOT NULL DEFAULT now()
);
