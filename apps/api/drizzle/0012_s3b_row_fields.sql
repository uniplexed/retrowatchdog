ALTER TABLE "catalog_items" ADD COLUMN "observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN "condition_text" text;--> statement-breakpoint
ALTER TABLE "catalog_items" ADD COLUMN "sample_sizes" jsonb;