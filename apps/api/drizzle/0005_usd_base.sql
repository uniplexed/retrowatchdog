-- usd-core: USD becomes the single internal base currency.
--
-- DATA WIPE (deliberate, user ruling 2026-09-01 "reimportas y ya"): instead of
-- converting stored GBP amounts to USD, this migration TRUNCATEs the price and
-- collection data and lets it repopulate:
--   * price_points   - repopulate from the sources on demand (TTL fetch)
--   * source_fetches - the freshness markers MUST go with the points, or the
--                      TTL check would report "fresh" against an empty table
--                      and suppress refetching until the TTL expired
--   * owned_copies   - the collection is reimported from the user's
--                      PriceCharting link afterwards
--   * acquisitions   - referenced only by the truncated owned_copies; old GBP
--                      totals have no USD twin, so they go too (NOT NULL adds
--                      below rely on the table being empty)
--   * watchlist      - few rows, re-added by hand (noted in the batch report)
--
-- From here on every *_usd column is converted from its verbatim original at
-- WRITE time with that day's rate (or a manual fx_overrides rate) and frozen.
TRUNCATE "price_points", "source_fetches", "owned_copies", "acquisitions", "watchlist" RESTART IDENTITY;--> statement-breakpoint
ALTER TABLE "price_points" RENAME COLUMN "price_gbp" TO "price_usd";--> statement-breakpoint
ALTER TABLE "owned_copies" RENAME COLUMN "acquired_price_gbp" TO "acquired_price_original";--> statement-breakpoint
ALTER TABLE "owned_copies" ADD COLUMN "acquired_currency" text;--> statement-breakpoint
ALTER TABLE "owned_copies" ADD COLUMN "acquired_price_usd" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "owned_copies" RENAME COLUMN "sold_price_gbp" TO "sold_price_original";--> statement-breakpoint
ALTER TABLE "owned_copies" RENAME COLUMN "sold_fees_gbp" TO "sold_fees_original";--> statement-breakpoint
ALTER TABLE "owned_copies" ADD COLUMN "sold_currency" text;--> statement-breakpoint
ALTER TABLE "owned_copies" ADD COLUMN "sold_price_usd" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "owned_copies" ADD COLUMN "sold_fees_usd" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "owned_copies" RENAME COLUMN "refund_gbp" TO "refund_original";--> statement-breakpoint
ALTER TABLE "owned_copies" RENAME COLUMN "return_costs_gbp" TO "return_costs_original";--> statement-breakpoint
ALTER TABLE "owned_copies" ADD COLUMN "refund_usd" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "owned_copies" ADD COLUMN "return_costs_usd" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "watchlist" RENAME COLUMN "target_price_gbp" TO "target_price_original";--> statement-breakpoint
ALTER TABLE "watchlist" ADD COLUMN "target_currency" text;--> statement-breakpoint
ALTER TABLE "watchlist" ADD COLUMN "target_price_usd" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "acquisitions" RENAME COLUMN "total_price_gbp" TO "total_price_original";--> statement-breakpoint
ALTER TABLE "acquisitions" ADD COLUMN "total_currency" text NOT NULL;--> statement-breakpoint
ALTER TABLE "acquisitions" ADD COLUMN "total_price_usd" numeric(10, 2) NOT NULL;--> statement-breakpoint
CREATE TABLE "fx_overrides" (
	"currency" text PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'auto' NOT NULL,
	"manual_rate" numeric
);
