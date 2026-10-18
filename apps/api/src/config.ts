import { fileURLToPath } from "node:url";
import { z } from "zod";

// Load the repo-root .env before parsing. A variable already set wins; a
// missing file is normal (the containers get theirs from compose).
try {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
}

const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .default("postgres://retrowatchdog:retrowatchdog@localhost:5432/retrowatchdog"),
  PORT: z.coerce.number().default(3001),
  PRICE_TTL_HOURS: z.coerce.number().default(6),
  /** one catalog sweep may hold the worker's single lane this long, then yields */
  CATALOG_SYNC_BUDGET_MINUTES: z.coerce.number().int().min(1).default(180),
  PRICE_MODE: z.enum(["cached_auto", "live", "cached_only"]).default("cached_auto"),
  ADAPTER_TIMEOUT_MS: z.coerce.number().default(8000),
  /** Seed for the enabled-market list; ignored once the user saves Settings -> Markets. */
  ENABLED_SOURCES: z.string().default("cex,ebay_uk"),
  /**
   * Default pace for every plugin source, kept in the app so a plugin that
   * forgets to pace itself still cannot hammer anyone. Per-plugin override:
   * `plugins.rate_limit_ms` (Settings -> Plugins).
   */
  SIDECAR_RATE_LIMIT_MS: z.coerce.number().default(3000),
  /**
   * ntfy topic for new-signal phone alerts; unset means off. On public ntfy.sh
   * the topic name is the secret, so make it long and random.
   */
  NTFY_TOPIC: z.string().optional(),
  NTFY_URL: z.string().default("https://ntfy.sh"),
  /** The names the app answers to (comma-separated); IPs, localhost and dotless names always pass. */
  PUBLIC_HOST: z.string().default("localhost"),
  /** Subnets whose requests are refused: compose sets the plugins' network here. */
  API_DENY_SUBNETS: z.string().default(""),
  /** Where the worker reaches the api (compose sets the service-name URL). */
  API_INTERNAL_URL: z.string().default("http://localhost:3001"),
  SIDECAR_BREAKER_THRESHOLD: z.coerce.number().default(5),
  SIDECAR_BREAKER_HOLD_MS: z.coerce.number().default(1_800_000),
  /**
   * Bounds on a plugin's answer: bytes bound memory (the timeout bounds only
   * duration), rows bound the matcher's work, which runs outside the timeout.
   */
  SIDECAR_MAX_BYTES: z.coerce.number().default(8 * 1024 * 1024),
  SIDECAR_MAX_LISTINGS: z.coerce.number().default(500),
  /**
   * Sample size for a median_of_listings source: the cheapest N rows that
   * survived the non-game filter. Not a page size.
   */
  // .int().positive(): an empty value coerces to 0 and silently serves nothing;
  // a negative one would keep the dearest rows.
  SIDECAR_MEDIAN_WINDOW: z.coerce.number().int().positive().default(50),
  /**
   * Bounds for a catalog sync page. A page over the row cap is refused, not
   * truncated: a partial page reported complete would delete rows.
   */
  SIDECAR_SYNC_MAX_ROWS_PER_PAGE: z.coerce.number().default(2000),
  SIDECAR_SYNC_MAX_BYTES: z.coerce.number().default(16 * 1024 * 1024),
  SIDECAR_SYNC_MAX_PAGES_PER_UNIT: z.coerce.number().default(100),
  /**
   * Plugin health/manifest poll interval. Polls are sequential and each can
   * cost two ADAPTER_TIMEOUT_MS, so keep it well above 2 x plugins x timeout.
   */
  PLUGIN_HEALTH_INTERVAL_MS: z.coerce.number().default(300_000),
  /** Each seeds a pending plugin row once per deployment (plugins/seed.ts); compose sets them. */
  VINTED_SIDECAR_PLUGIN_URL: z.string().optional(),
  WALLAPOP_SIDECAR_PLUGIN_URL: z.string().optional(),
  CEX_PLUGIN_URL: z.string().optional(),
  EBAY_PLUGIN_URL: z.string().optional(),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  MATCH_CONFIRM_THRESHOLD: z.coerce.number().default(0.6),
  MATCH_REVIEW_THRESHOLD: z.coerce.number().default(0.35),
  MIN_LOCAL_RESULTS: z.coerce.number().default(3),
  LOCAL_SCORE_FLOOR: z.coerce.number().default(0.45),
  // Shortest query (alphanumerics only) allowed to reach IGDB. 3, not 4: short
  // real titles exist (Ico, "nba").
  MIN_ENRICH_QUERY_LENGTH: z.coerce.number().default(3),
  // Env names predate the signal-rule rename: VOUCHER -> flipFactor.
  SIGNAL_VOUCHER_FACTOR: z.coerce.number().default(1.15),
  SIGNAL_OVERPRICED_FACTOR: z.coerce.number().default(1.3),
  SIGNAL_UNDERPRICED_FACTOR: z.coerce.number().default(0.7),
  SIGNAL_CROSS_STORE_FACTOR: z.coerce.number().default(0.85),
  SIGNAL_PROFIT_FACTOR: z.coerce.number().default(1.15),
  SIGNAL_MIN_SAMPLE: z.coerce.number().default(5),
  // PriceCharting collection import: a top score >= REVIEW_THRESHOLD makes a
  // review row, below it the row is unmatched.
  PC_IMPORT_MATCH_THRESHOLD: z.coerce.number().default(0.45),
  PC_IMPORT_REVIEW_THRESHOLD: z.coerce.number().default(0.25),
  IGDB_CLIENT_ID: z.string().optional(),
  IGDB_SECRET: z.string().optional(),
});

export type AppConfig = z.infer<typeof envSchema>;
export const config: AppConfig = envSchema.parse(process.env);
