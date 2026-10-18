CREATE TABLE "acquisitions" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" text,
	"url" text,
	"total_price_gbp" numeric(10, 2) NOT NULL,
	"acquired_at" date,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_items" (
	"source" text NOT NULL,
	"source_product_id" text NOT NULL,
	"title" text NOT NULL,
	"category_text" text,
	"prices" jsonb NOT NULL,
	"currency" text DEFAULT 'GBP' NOT NULL,
	"available" boolean,
	"source_metadata" jsonb,
	"synced_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"refresh_source" text NOT NULL,
	"sync_unit" text,
	CONSTRAINT "catalog_items_source_source_product_id_pk" PRIMARY KEY("source","source_product_id")
);
--> statement-breakpoint
CREATE TABLE "sync_state" (
	"key" text PRIMARY KEY NOT NULL,
	"ran_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watchlist" (
	"id" serial PRIMARY KEY NOT NULL,
	"game_id" integer NOT NULL,
	"region" text,
	"condition" text,
	"target_price_gbp" numeric(10, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watchlist_game_region_condition" UNIQUE NULLS NOT DISTINCT("game_id","region","condition")
);
--> statement-breakpoint
ALTER TABLE "owned_copies" ADD COLUMN "status" text DEFAULT 'owned' NOT NULL;--> statement-breakpoint
ALTER TABLE "owned_copies" ADD COLUMN "item_grade" text;--> statement-breakpoint
ALTER TABLE "owned_copies" ADD COLUMN "working_state" text;--> statement-breakpoint
ALTER TABLE "owned_copies" ADD COLUMN "authenticity" text;--> statement-breakpoint
ALTER TABLE "owned_copies" ADD COLUMN "acquired_source" text;--> statement-breakpoint
ALTER TABLE "owned_copies" ADD COLUMN "acquired_url" text;--> statement-breakpoint
ALTER TABLE "owned_copies" ADD COLUMN "acquisition_id" integer;--> statement-breakpoint
ALTER TABLE "owned_copies" ADD COLUMN "sold_at" date;--> statement-breakpoint
ALTER TABLE "owned_copies" ADD COLUMN "sold_price_gbp" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "owned_copies" ADD COLUMN "sold_fees_gbp" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "owned_copies" ADD COLUMN "sold_venue" text;--> statement-breakpoint
ALTER TABLE "owned_copies" ADD COLUMN "returned_at" date;--> statement-breakpoint
ALTER TABLE "owned_copies" ADD COLUMN "refund_gbp" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "owned_copies" ADD COLUMN "return_costs_gbp" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "price_points" ADD COLUMN "observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "watchlist" ADD CONSTRAINT "watchlist_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "catalog_items_source_unit" ON "catalog_items" USING btree ("source","sync_unit");--> statement-breakpoint
ALTER TABLE "owned_copies" ADD CONSTRAINT "owned_copies_acquisition_id_acquisitions_id_fk" FOREIGN KEY ("acquisition_id") REFERENCES "public"."acquisitions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "catalog_items_title_trgm" ON "catalog_items" USING gin ("title" gin_trgm_ops);