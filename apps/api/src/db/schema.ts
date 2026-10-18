import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
  unique,
  index,
} from "drizzle-orm/pg-core";

export const games = pgTable(
  "games",
  {
    id: serial("id").primaryKey(),
    igdbId: integer("igdb_id"),
    title: text("title").notNull(),
    platform: text("platform").notNull(),
    year: integer("year"),
    coverUrl: text("cover_url"),
    // Per-title refresh override: 'live' | 'cached_only' | null (inherit global)
    priceMode: text("price_mode"),
  },
  // One row per platform of an IGDB game. No (title, platform) unique: distinct
  // games share titles (SNES vs Mega Drive "Jurassic Park"). Region is a price
  // dimension, never part of catalog identity.
  (t) => [unique("games_igdb_platform").on(t.igdbId, t.platform)],
);

export const gameNames = pgTable(
  "game_names",
  {
    id: serial("id").primaryKey(),
    gameId: integer("game_id")
      .notNull()
      .references(() => games.id),
    name: text("name").notNull(),
  },
  (t) => [unique("game_names_game_name").on(t.gameId, t.name)],
);

export const pricePoints = pgTable(
  "price_points",
  {
    id: serial("id").primaryKey(),
    gameId: integer("game_id")
      .notNull()
      .references(() => games.id),
    source: text("source").notNull(),
    region: text("region").notNull(),
    condition: text("condition").notNull(),
    // Physical grade (mint..poor), independent of condition (completeness).
    grade: text("grade"),
    kind: text("kind").notNull(),
    // Converted at write time and frozen; the original amount+currency stay verbatim
    priceUsd: numeric("price_usd", { precision: 10, scale: 2 }).notNull(),
    priceOriginal: numeric("price_original", { precision: 10, scale: 2 }).notNull(),
    currencyOriginal: text("currency_original").notNull(),
    sampleSize: integer("sample_size"),
    sourceUrl: text("source_url"),
    // The source's own product id; the stale-point sweep matches a point back
    // to its mapping by it (`matching/reviewNumeralMismatches.ts`). NULL is a
    // real answer: the app's own median is about no single product.
    sourceProductId: text("source_product_id"),
    listingTitle: text("listing_title"),
    // Whether the source reported the listing as buyable. NULL = unknown
    // (e.g. medians); the signal engine treats NULL as available.
    available: boolean("available"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    // When the source actually reported this price; fetched_at is the batch write time
    observedAt: timestamp("observed_at", { withTimezone: true }),
  },
  (t) => [
    index("price_points_lookup").on(t.gameId, t.source, t.fetchedAt),
    // The sweep's join; price_points_lookup leads with game_id and cannot serve it.
    index("price_points_product").on(t.source, t.sourceProductId),
  ],
);

// Records a live fetch even when it matched zero listings, so the TTL
// freshness check has something to read and page views don't re-hit the source.
export const sourceFetches = pgTable(
  "source_fetches",
  {
    id: serial("id").primaryKey(),
    gameId: integer("game_id")
      .notNull()
      .references(() => games.id),
    source: text("source").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  },
  (t) => [unique("source_fetches_game_source").on(t.gameId, t.source)],
);

export const sourceMappings = pgTable(
  "source_mappings",
  {
    id: serial("id").primaryKey(),
    gameId: integer("game_id")
      .notNull()
      .references(() => games.id),
    source: text("source").notNull(),
    sourceProductId: text("source_product_id").notNull(),
    sourceTitle: text("source_title").notNull(),
    matchScore: real("match_score").notNull(),
    status: text("status").notNull(),
  },
  (t) => [unique("source_mappings_source_product").on(t.source, t.sourceProductId)],
);

// Catalog staging for sync sources (nothing FKs here: delist + relist churns
// identity). Prices keep the source's own labels, in the row's native currency.
export const catalogItems = pgTable(
  "catalog_items",
  {
    source: text("source").notNull(),
    sourceProductId: text("source_product_id").notNull(),
    title: text("title").notNull(),
    categoryText: text("category_text"),
    prices: jsonb("prices").$type<Record<string, string>>().notNull(),
    currency: text("currency").notNull().default("GBP"),
    available: boolean("available"),
    // What the SOURCE said (vs `syncedAt`, the sweep's clock); null = not said.
    observedAt: timestamp("observed_at", { withTimezone: true }),
    conditionText: text("condition_text"),
    // Observations behind each price, keyed like `prices`.
    sampleSizes: jsonb("sample_sizes").$type<Record<string, number>>(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull(),
    // set only by bulk syncs; the delisting delete compares against it
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    refreshSource: text("refresh_source").notNull(), // 'bulk' | 'detail'
    syncUnit: text("sync_unit"),
  },
  (t) => [
    primaryKey({ columns: [t.source, t.sourceProductId] }),
    index("catalog_items_source_unit").on(t.source, t.syncUnit),
  ],
);

// One purchase covering many physical items (job lots, bundles).
export const acquisitions = pgTable("acquisitions", {
  id: serial("id").primaryKey(),
  source: text("source"),
  url: text("url"),
  totalPriceOriginal: numeric("total_price_original", { precision: 10, scale: 2 }).notNull(),
  totalCurrency: text("total_currency").notNull(),
  totalPriceUsd: numeric("total_price_usd", { precision: 10, scale: 2 }).notNull(),
  acquiredAt: date("acquired_at"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// NULL region/condition means "any"; NULLS NOT DISTINCT so a duplicate insert 409s.
export const watchlist = pgTable(
  "watchlist",
  {
    id: serial("id").primaryKey(),
    gameId: integer("game_id")
      .notNull()
      .references(() => games.id),
    region: text("region"),
    condition: text("condition"),
    targetPriceOriginal: numeric("target_price_original", { precision: 10, scale: 2 }),
    targetCurrency: text("target_currency"),
    targetPriceUsd: numeric("target_price_usd", { precision: 10, scale: 2 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("watchlist_game_region_condition").on(t.gameId, t.region, t.condition).nullsNotDistinct(),
  ],
);

// Worker catch-up bookkeeping. Keys: 'catalog-sync:<source>:<unit>',
// 'tracked-refresh:<source>'.
export const syncState = pgTable("sync_state", {
  key: text("key").primaryKey(),
  ranAt: timestamp("ran_at", { withTimezone: true }).notNull(),
});

// Personal collection: one row = ONE physical copy; duplicates are distinct items.
export const ownedCopies = pgTable("owned_copies", {
  id: serial("id").primaryKey(),
  gameId: integer("game_id")
    .notNull()
    .references(() => games.id),
  region: text("region").notNull(),
  condition: text("condition").notNull(),
  notes: text("notes"),
  acquiredAt: date("acquired_at"),
  // Originals are what changed hands; *_usd twins are frozen at write time.
  acquiredPriceOriginal: numeric("acquired_price_original", { precision: 10, scale: 2 }),
  acquiredCurrency: text("acquired_currency"),
  acquiredPriceUsd: numeric("acquired_price_usd", { precision: 10, scale: 2 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // 'incoming' | 'owned' | 'listed' | 'sold' | 'returned'
  status: text("status").notNull().default("owned"),
  itemGrade: text("item_grade"),        // mint..poor (physical state)
  workingState: text("working_state"),  // working | partial | untested | faulty
  authenticity: text("authenticity"),   // genuine | suspect | counterfeit
  acquiredSource: text("acquired_source"),
  acquiredUrl: text("acquired_url"),
  acquisitionId: integer("acquisition_id").references(() => acquisitions.id),
  soldAt: date("sold_at"),
  soldPriceOriginal: numeric("sold_price_original", { precision: 10, scale: 2 }),
  soldFeesOriginal: numeric("sold_fees_original", { precision: 10, scale: 2 }),
  // ONE currency covers the sale's price+fees AND the return leg below
  soldCurrency: text("sold_currency"),
  soldPriceUsd: numeric("sold_price_usd", { precision: 10, scale: 2 }),
  soldFeesUsd: numeric("sold_fees_usd", { precision: 10, scale: 2 }),
  soldVenue: text("sold_venue"),
  returnedAt: date("returned_at"),
  refundOriginal: numeric("refund_original", { precision: 10, scale: 2 }),
  returnCostsOriginal: numeric("return_costs_original", { precision: 10, scale: 2 }),
  refundUsd: numeric("refund_usd", { precision: 10, scale: 2 }),
  returnCostsUsd: numeric("return_costs_usd", { precision: 10, scale: 2 }),
  // How game_id got linked: 'exact' (import exact-name hit, or an explicit
  // game_id with null score) | 'candidate' (picked fuzzy candidate) | 'manual'
  // (any other game) | 'confirmed' (verified in match review) | NULL (hand-added).
  matchBasis: text("match_basis"),
  matchScore: real("match_score"),
}, (t) => [
  // One copy per PriceCharting offer, so two imports racing past the preview's
  // duplicate check cannot both land it (migration 0016).
  uniqueIndex("owned_copies_pc_offer").on(t.acquiredUrl).where(sql`acquired_source = 'pricecharting_import'`),
]);

// User-owned settings, one JSON value per key. Keys: 'enabled_sources'
// (settings/markets.ts); 'plugin_seed_done' (only the row's existence means
// anything, see plugins/seed.ts).
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// mode='manual' makes manual_rate (USD->currency) authoritative for display and
// write-time conversions; frozen USD amounts never change. manual_rate survives
// a switch back to 'auto' so re-toggling remembers it.
export const fxOverrides = pgTable("fx_overrides", {
  currency: text("currency").primaryKey(),
  mode: text("mode").notNull().default("auto"), // 'auto' | 'manual'
  manualRate: numeric("manual_rate"),
});

// A source plugin (manifest shape: packages/shared/src/pluginManifest.ts).
// A row records a TRUST decision: `manifest` is what the user approved,
// `manifest_seen` what the plugin last said, so a plugin cannot promote itself.
// Sources are built from `manifest` only (sources/registry.ts). Only
// plugins/repo.ts touches this table. Both manifest columns are nullable so a
// row can exist before its first successful fetch (plugins/seed.ts).
export const plugins = pgTable("plugins", {
  id: serial("id").primaryKey(),
  baseUrl: text("base_url").notNull().unique(),
  // From the manifest, denormalized so a row is listable before it is parsed.
  name: text("name").notNull(),
  version: text("version").notNull(),
  // Read through `readStoredManifest` (shape only, not protocol): a hand-edited
  // row that no longer validates reads as having no manifest. Only an APPROVAL
  // writes `manifest`.
  manifest: jsonb("manifest"),
  manifestSeen: jsonb("manifest_seen"),
  // { "<source id>": ["sell", "cash"] }. Read via plugins/repo.ts: a bare
  // object lookup answers out of Object.prototype.
  approvedKinds: jsonb("approved_kinds").notNull().default({}),
  // 'pending' | 'approved' | 'disabled', no check constraint; `asStatus` reads
  // an unknown value as `disabled`.
  status: text("status").notNull().default("pending"),
  // { status, protocol, configured } from GET /health. Null = never answered;
  // a failed poll keeps the last reading.
  lastHealth: jsonb("last_health"),
  lastHealthAt: timestamp("last_health_at", { withTimezone: true }),
  lastError: text("last_error"),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  // Historical record: set when the app approved the row itself rather than a
  // person. Null for every ordinary approval.
  adoptedAt: timestamp("adopted_at", { withTimezone: true }),
  // Operator-set ms between calls; null falls back to SIDECAR_RATE_LIMIT_MS
  // (`paceFor`, sources/registry.ts). Never written from a manifest. A
  // non-positive value reads as null: `RateLimiter` only guards `wait > 0`.
  rateLimitMs: integer("rate_limit_ms"),
});

/**
 * Watchlist signals already notified (worker/alerts.ts). A row is deleted when
 * its signal stops standing, so a returning signal is news again.
 */
export const alertsSent = pgTable("alerts_sent", {
  key: text("key").primaryKey(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The collection totals as last served each UTC day, per valuation basis and
 * markets (GET /api/collection writes it; the worker reads it after each
 * tracked refresh). A day nobody computed has no row: the chart shows a gap.
 */
export const collectionValueDaily = pgTable(
  "collection_value_daily",
  {
    day: date("day").notNull(),
    basis: text("basis").notNull(),
    country: text("country").notNull(),
    includeForeign: boolean("include_foreign").notNull(),
    estimatedUsd: numeric("estimated_usd", { precision: 12, scale: 2 }).notNull(),
    paidUsd: numeric("paid_usd", { precision: 12, scale: 2 }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.day, t.basis, t.country, t.includeForeign] })],
);

/**
 * Every distinct signal the worker saw (one row per key per appearance) and
 * its outcome evalDays later: held, beaten or unknown. Written by the worker
 * only (signals/log.ts); read by GET /api/insights for signal reliability.
 */
export const signalLog = pgTable(
  "signal_log",
  {
    id: serial("id").primaryKey(),
    key: text("key").notNull(),
    gameId: integer("game_id").notNull().references(() => games.id, { onDelete: "cascade" }),
    watchId: integer("watch_id"),
    copyId: integer("copy_id"),
    type: text("type").notNull(),
    source: text("source"),
    kind: text("kind"),
    region: text("region").notNull(),
    condition: text("condition").notNull(),
    confidence: text("confidence").notNull(),
    priceUsd: numeric("price_usd", { precision: 12, scale: 2 }),
    priceOriginal: numeric("price_original", { precision: 12, scale: 2 }),
    currency: text("currency"),
    edgePct: real("edge_pct"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }),
    outcome: text("outcome"),
    outcomePriceUsd: numeric("outcome_price_usd", { precision: 12, scale: 2 }),
    gainUsd: numeric("gain_usd", { precision: 12, scale: 2 }),
  },
  (t) => [index("signal_log_key_first_seen").on(t.key, t.firstSeenAt), index("signal_log_evaluated_at").on(t.evaluatedAt)],
);
