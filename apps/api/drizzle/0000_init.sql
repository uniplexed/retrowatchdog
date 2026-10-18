CREATE TABLE "game_names" (
	"id" serial PRIMARY KEY NOT NULL,
	"game_id" integer NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "game_names_game_name" UNIQUE("game_id","name")
);
--> statement-breakpoint
CREATE TABLE "games" (
	"id" serial PRIMARY KEY NOT NULL,
	"igdb_id" integer,
	"title" text NOT NULL,
	"platform" text NOT NULL,
	"year" integer,
	"cover_url" text,
	"price_mode" text,
	CONSTRAINT "games_igdb_platform" UNIQUE("igdb_id","platform")
);
--> statement-breakpoint
CREATE TABLE "owned_copies" (
	"id" serial PRIMARY KEY NOT NULL,
	"game_id" integer NOT NULL,
	"region" text NOT NULL,
	"condition" text NOT NULL,
	"notes" text,
	"acquired_at" date,
	"acquired_price_gbp" numeric(10, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_points" (
	"id" serial PRIMARY KEY NOT NULL,
	"game_id" integer NOT NULL,
	"source" text NOT NULL,
	"region" text NOT NULL,
	"condition" text NOT NULL,
	"kind" text NOT NULL,
	"price_gbp" numeric(10, 2) NOT NULL,
	"price_original" numeric(10, 2) NOT NULL,
	"currency_original" text NOT NULL,
	"sample_size" integer,
	"source_url" text,
	"listing_title" text,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_mappings" (
	"id" serial PRIMARY KEY NOT NULL,
	"game_id" integer NOT NULL,
	"source" text NOT NULL,
	"source_product_id" text NOT NULL,
	"source_title" text NOT NULL,
	"match_score" real NOT NULL,
	"status" text NOT NULL,
	CONSTRAINT "source_mappings_source_product" UNIQUE("source","source_product_id")
);
--> statement-breakpoint
ALTER TABLE "game_names" ADD CONSTRAINT "game_names_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owned_copies" ADD CONSTRAINT "owned_copies_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_points" ADD CONSTRAINT "price_points_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_mappings" ADD CONSTRAINT "source_mappings_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "price_points_lookup" ON "price_points" USING btree ("game_id","source","fetched_at");