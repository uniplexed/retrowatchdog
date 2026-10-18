-- reference_usd had no writer: a signal carries no reference amount.
ALTER TABLE signal_log DROP COLUMN IF EXISTS reference_usd;
