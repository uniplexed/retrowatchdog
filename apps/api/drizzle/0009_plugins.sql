CREATE TABLE "plugins" (
	"id" serial PRIMARY KEY NOT NULL,
	"base_url" text NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"manifest" jsonb,
	"manifest_seen" jsonb,
	"approved_kinds" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_health" jsonb,
	"last_health_at" timestamp with time zone,
	"last_error" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone,
	CONSTRAINT "plugins_base_url_unique" UNIQUE("base_url")
);
