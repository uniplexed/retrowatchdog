CREATE TABLE "source_fetches" (
	"id" serial PRIMARY KEY NOT NULL,
	"game_id" integer NOT NULL,
	"source" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "source_fetches_game_source" UNIQUE("game_id","source")
);
--> statement-breakpoint
ALTER TABLE "source_fetches" ADD CONSTRAINT "source_fetches_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;