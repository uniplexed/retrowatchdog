// Also imported as a type: `export *` does not bring names into this file's scope.
import type { Platform } from "./platforms.js";
export * from "./platforms.js";

// Type-only import so PriceRole derives from PRICE_ROLES. pluginManifest.ts
// imports back from this file (an ESM cycle): read its header before adding a
// module-level constant there.
import type { PRICE_ROLES } from "./pluginManifest.js";
export * from "./pluginManifest.js";

/**
 * USD is the single internal base currency: every stored/computed price
 * (points, medians, signals, totals, estimated values) is USD, frozen at
 * write time with that day's rate. Source originals are always preserved
 * verbatim alongside and never silently re-converted; the UI converts USD to
 * the viewer's display currency at render time.
 */
export const SUPPORTED_CURRENCIES = [
  // the common ones first, then the rest of the provider's set
  "USD", "GBP", "EUR", "JPY", "CHF", "CAD", "AUD",
  "BRL", "CNY", "CZK", "DKK", "HKD", "HUF", "IDR", "ILS", "INR", "ISK", "KRW", "MXN",
  "MYR", "NOK", "NZD", "PHP", "PLN", "RON", "SEK", "SGD", "THB", "TRY", "ZAR",
] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

/** the currencies a new deployment offers in its menus; more are added from SUPPORTED_CURRENCIES in Settings */
export const DEFAULT_ENABLED_CURRENCIES: readonly SupportedCurrency[] = ["USD", "GBP", "EUR", "JPY", "CHF", "CAD", "AUD"];

/** GET/PUT /api/settings/currencies: the currencies the menus offer; USD is always one */
export interface CurrencySettingsResponse {
  enabled: SupportedCurrency[];
}

/**
 * Every currency the rate provider (Frankfurter, ECB set) quotes; a source's
 * `expectedCurrencies` is validated against it, because an unquotable code
 * makes the write-time FX lookup throw and costs the source its whole block.
 * Checked against the live list on 2026-09-18 (BGN dropped: Bulgaria joined
 * the euro); keep it in step with the provider in both directions.
 *
 * Distinct from SUPPORTED_CURRENCIES (what a person may DISPLAY): every
 * displayable currency must be convertible (test/currencies.test.ts), not the
 * reverse.
 */
export const CONVERTIBLE_CURRENCIES = [
  "AUD", "BRL", "CAD", "CHF", "CNY", "CZK", "DKK", "EUR", "GBP",
  "HKD", "HUF", "IDR", "ILS", "INR", "ISK", "JPY", "KRW", "MXN", "MYR",
  "NOK", "NZD", "PHP", "PLN", "RON", "SEK", "SGD", "THB", "TRY", "USD",
  "ZAR",
] as const;

/** fx_overrides row mode: 'auto' = Frankfurter daily rate, 'manual' = user-set rate */
export type FxMode = "auto" | "manual";

/** GET /api/fx?to=X — the USD->X display rate from the fx layer */
export interface FxRateResponse {
  base: "USD";
  to: SupportedCurrency;
  rate: number;
  /** null when the rate is a manual override (nothing was fetched) */
  fetchedAt: string | null;
  mode: FxMode;
}

/** one row of GET /api/settings/fx (every supported currency except the USD base) */
export interface FxSettingDto {
  currency: SupportedCurrency;
  mode: FxMode;
  /** user-set USD->currency rate; authoritative everywhere while mode='manual' */
  manualRate: number | null;
  /** the Frankfurter USD->currency rate, shown greyed for reference; null when FX is down */
  autoRate: number | null;
  /** when autoRate was fetched; null when FX is down */
  fetchedAt: string | null;
}

export interface FxSettingsResponse {
  currencies: FxSettingDto[];
}

/** PUT /api/settings/fx/:currency — mode 'manual' requires manualRate > 0 */
export interface UpdateFxSettingInput {
  mode: FxMode;
  manualRate?: number;
}

// Runtime lists so CSV import/export and route schemas can validate raw values.
export const REGIONS = ["PAL", "NTSC_U", "NTSC_J", "unknown"] as const;
export type Region = (typeof REGIONS)[number];
/**
 * Completeness tiers, least to most complete (loose < boxed_no_manual < cib <
 * new), then accessory-only tiers, then unknown; they match how sources price
 * completeness (CeX "Unboxed" / "w/o Manual, Boxed" / "w/ Manual, Boxed"). A
 * boxed copy without its manual is never valued as cib. No manual-without-box
 * tier: no source prices it.
 */
export const CONDITIONS = ["loose", "boxed_no_manual", "cib", "new", "box_only", "manual_only", "unknown"] as const;
export type Condition = (typeof CONDITIONS)[number];
export const PRICE_KINDS = [
  "sell", "cash", "voucher", "active_median", "active_listing", "guide",
] as const;
export type PriceKind = (typeof PRICE_KINDS)[number];
/**
 * A price source id: one per (service, country), since each country is its own
 * shop, currency and inventory. A free string, not a union, because plugin ids
 * arrive at runtime (apps/api/src/sources/registry.ts). The UK ids keep their
 * historic spelling (`cex`, `ebay_uk`) so no stored row needs migrating.
 */
export type SourceId = string;
export type SourceStatus = "ok" | "not_configured" | "error";

/**
 * Which service a source belongs to: the key the app selects a source's own
 * reading table by. The signal engine never keys on it, so shops of one family
 * still compare against each other. Human name: `SourceInfo.familyLabel`.
 */
export type SourceFamily = string;

/**
 * Whether a source is read live per game view, or synced into `catalog_items`
 * and searched locally.
 */
export type SourceKind = "live" | "sync";

/** How often a catalog-sync source is swept, and how often tracked items are refreshed. */
export interface SourceSchedule {
  /** 5-field cron the app's parser accepts */
  catalogCron: string;
  /** 1..168 */
  trackedRefreshHours: number;
}

/**
 * The countries RetroWatchdog has a market in. Runtime list so a route can
 * validate a query parameter against it instead of re-typing the values.
 */
export const COUNTRY_CODES = ["GB", "ES", "IE", "DE", "FR", "IT", "PT", "US"] as const;
export type CountryCode = (typeof COUNTRY_CODES)[number];

/** English names for the country picker; the ids stay ISO codes. */
export const COUNTRY_LABEL: Record<CountryCode, string> = {
  GB: "United Kingdom",
  ES: "Spain",
  IE: "Ireland",
  DE: "Germany",
  FR: "France",
  IT: "Italy",
  PT: "Portugal",
  US: "United States",
};

/**
 * How the signal engine interprets a price kind, declared per source via
 * kindRoles. Signals are computed from roles only:
 * - buy_listing: a concrete purchasable offer with url/title
 * - buy_store:   a store's posted buy-now price
 * - bid:         what the source PAYS you
 * - reference:   market baseline with a sample size
 * - guide:       informational only; never fires signals
 * Kinds with no declared role are inert.
 */
export type PriceRole = (typeof PRICE_ROLES)[number];

/**
 * How far a source's prices carry for a physical copy:
 * - local:  a shop whose prices apply only to the exact region and condition
 *           it lists;
 * - global: a marketplace that can sell to any geography, so readings with an
 *           undeclared region or condition may stand in for a copy through the
 *           labelled reference ladder (confidence drops to `potential`).
 * Reach is a fact about the MARKET, not data quality: a private-seller
 * marketplace is `global` even when its listings declare little. It cannot
 * leak into a copy's VALUE either, since valuation reads only `reference`,
 * `bid` and `buy_store`.
 */
export type SourceReach = "local" | "global";

export interface SourceInfo {
  label: string;
  /** see SourceFamily */
  family: SourceFamily;
  /** Human name of the family, e.g. "CeX"; travels with the source because families are open strings. */
  familyLabel: string;
  /** see SourceKind — live sources are searched per game view, sync sources from the local catalog */
  kind: SourceKind;
  /**
   * ISO 3166-1 alpha-2 of the market this source quotes in. Decides which
   * markets may value an owned copy; never used by the signal engine.
   */
  country: CountryCode;
  /** see SourceReach — required so a new source must decide how far its prices carry */
  reach: SourceReach;
  /**
   * The region assumed for listings that declare none (`null` = do not guess).
   * Applied on both transports by `applyDefaultRegion`
   * (apps/api/src/adapters/defaultRegion.ts).
   */
  defaultRegion: Region | null;
  /**
   * The currencies this source's site quotes; a row in any other currency is
   * dropped. Worth declaring: an unquotable code costs the whole block, and a
   * wrong-but-quotable one freezes a USD twin at the wrong rate permanently.
   */
  expectedCurrencies: string[];
  /** per-source wording for price kinds; missing kinds fall back to KIND_LABEL_FALLBACK */
  kindLabels?: Partial<Record<PriceKind, string>>;
  /** `kindLabels` without the source's name ("asks"), for places that already print the name. */
  kindLabelsShort?: Partial<Record<PriceKind, string>>;
  /** signal-engine roles for this source's price kinds; undeclared kinds are inert */
  kindRoles: Partial<Record<PriceKind, PriceRole>>;
  /** honesty caveat shown under the source header */
  caveat?: string;
  /**
   * Product page template, e.g. `https://uk.webuy.com/product-detail?id={id}`.
   * `{id}` appears once, past the origin, so a plugin-supplied id cannot change
   * the host. Live rows carry their own `url` instead.
   */
  productUrl?: string;
  /** Sync only: this source's category text mapped to an app platform, e.g. `{"Nintendo NES Software": "nes"}`. */
  categoryPlatforms?: Partial<Record<string, Platform>>;
  /**
   * Fraction of the listed price lost to fees when YOU sell there; an
   * estimate. PROFIT nets a `reference` reading by it. Bids are already net, so
   * a source with no `reference` role omits it. Absent = 0.
   */
  sellFeeRate?: number;
  /** Catalog-sync cadence; declared by a sync plugin. */
  schedule?: SourceSchedule;
}

/**
 * One row of the Markets screen. `configured` false means the source cannot
 * answer: it may be shown, never enabled.
 */
export interface MarketDto {
  source: SourceId;
  label: string;
  family: SourceFamily;
  country: CountryCode;
  configured: boolean;
}

/**
 * A source as the running deployment knows it: the manifest entry plus
 * whether it can answer and which plugin row owns it. Produced by
 * apps/api/src/sources/registry.ts; the web loads it at boot and takes every
 * label, caveat, role and heading from it.
 */
export interface SourceInfoDto extends SourceInfo {
  id: SourceId;
  configured: boolean;
  origin: "plugin";
  pluginId: number;
}

/** GET /api/sources: every source the deployment knows, in registry order. */
export interface SourcesResponse {
  sources: SourceInfoDto[];
}

/**
 * GET /api/settings/markets: which markets are queried (and synced). `enabled`
 * is seeded once from ENABLED_SOURCES; it is NOT the valuation-markets setting.
 */
export interface MarketSettingsResponse {
  enabled: SourceId[];
  available: MarketDto[];
}

/** PUT /api/settings/markets — the complete enabled list, not a delta. */
export interface UpdateMarketsInput {
  enabled: SourceId[];
}

/**
 * One source of a plugin as the Plugins panel reviews it: what the manifest
 * declares (`kindRoles`) plus what the user approved (`approvedKinds`, empty
 * while pending). Not a `SourceInfoDto`: the source may be pending, partly
 * approved, or absent from the registry.
 */
export interface PluginSourceDto {
  id: SourceId;
  label: string;
  /** see SourceFamily */
  family: SourceFamily;
  /** see SourceInfo.familyLabel */
  familyLabel: string;
  country: CountryCode;
  reach: SourceReach;
  kind: SourceKind;
  kindRoles: Partial<Record<PriceKind, PriceRole>>;
  kindLabels?: Partial<Record<PriceKind, string>>;
  kindLabelsShort?: Partial<Record<PriceKind, string>>;
  caveat?: string;
  /** passed through as declared; see SourceInfo.productUrl */
  productUrl?: string;
  /** passed through as declared; see SourceInfo.categoryPlatforms */
  categoryPlatforms?: Partial<Record<string, Platform>>;
  /**
   * A consent screen may not hide a field the app ACTS on: these four are the
   * DRIFT_FIELDS the card must render. Optional ones pass through as declared;
   * the panel says "none declared" rather than printing a zero.
   */
  defaultRegion: Region | null;
  expectedCurrencies: string[];
  sellFeeRate?: number;
  schedule?: SourceSchedule;
  approvedKinds: PriceKind[];
  /**
   * The role each approved kind was GRANTED under, from the APPROVED manifest
   * (not the possibly newer `kindRoles`). The only way to tell a re-offer of an
   * unchanged grant from a PROMOTION (e.g. `buy_store` now claiming
   * `reference`); see `defaultCheckedKinds` in apps/web/src/components/PluginsPanel.tsx.
   */
  approvedKindRoles: Partial<Record<PriceKind, PriceRole>>;
}

/**
 * The manifest a plugin publishes NOW, when it differs from the one the row
 * describes (drift). Served with its own fingerprint so the drifted card can be
 * approved: the approve route refuses any fingerprint but the current
 * `manifest_seen`'s. `sources[].approvedKinds` here is the previous grant,
 * used only to pre-tick boxes.
 */
export interface PluginProposalDto {
  name: string;
  version: string;
  requiredSecrets: string[];
  sources: PluginSourceDto[];
  /** never null: a proposal exists only when there is a document to hash */
  manifestFingerprint: string;
}

/**
 * One row of Settings → Plugins. An APPROVED row is described by the approved
 * manifest; a pending or disabled one by the last SEEN manifest. `drift` names
 * the fields where the two disagree (e.g. `shop_gb.kindRoles`, `+shop_fr`);
 * `proposed` is the other document when there is one.
 */
export interface PluginDto {
  id: number;
  baseUrl: string;
  name: string;
  version: string;
  status: "pending" | "approved" | "disabled";
  /** the plugin's last health reading, never an assumption: silence is false */
  configured: boolean;
  /** NAMES of the environment variables the plugin says it needs; never values */
  requiredSecrets: string[];
  sources: PluginSourceDto[];
  drift: string[];
  /** the published document when it differs from the one above (drifted approved rows only) */
  proposed: PluginProposalDto | null;
  /** set only when the app approved the row itself; disclosed in the panel */
  adoptedAt: string | null;
  lastError: string | null;
  /**
   * When a health reading was last STORED: null means never answered. A failed
   * poll keeps the previous reading, so this is the reading's age.
   */
  lastHealthAt: string | null;
  /**
   * Digest of the manifest THIS ROW DESCRIBES. Send it back unaltered as
   * `reviewedFingerprint`: it ties consent to the document the user read.
   */
  manifestFingerprint: string | null;
  /**
   * Digest of `manifest_seen`; null means an approval cannot succeed right now.
   * NOT for sending back: `reviewedFingerprint` must be the digest of the
   * document the user READ (`manifestFingerprint` or the proposal's).
   */
  seenFingerprint: string | null;
  /**
   * Milliseconds between calls, or null for "auto" (deployment default). Null
   * is stored rather than the resolved number so a changed default still applies.
   */
  rateLimitMs: number | null;
  /** the pace actually in force */
  effectiveRateLimitMs: number;
  /** where the pace in force came from; an operator looking at "auto" is owed this */
  rateLimitSource: "plugin" | "default";
}

/** GET /api/plugins — every imported plugin, newest import first. */
export interface PluginsResponse {
  plugins: PluginDto[];
  /**
   * How long a game view waits for one source (ADAPTER_TIMEOUT_MS). A plugin's
   * sources share one queue, so the panel checks a pace against this before saving.
   */
  adapterTimeoutMs: number;
}

/**
 * How long one call to a plugin is assumed to need once started: a pace must
 * let the LAST source finish, not merely start, inside the budget. A deliberate
 * allowance, not a measurement, shared so the panel's warning and the API's
 * refusal agree.
 */
export const PLUGIN_CALL_ALLOWANCE_MS = 2000;

export interface PaceBudget {
  /** when the last of this plugin's sources would start, in milliseconds */
  lastStartMs: number;
  /** whether that call would still have PLUGIN_CALL_ALLOWANCE_MS to finish in */
  fits: boolean;
  /** the largest pace that would fit, or null when any pace does */
  largestThatFitsMs: number | null;
}

/**
 * How many of a plugin's sources a pace must fit into a game view's budget.
 * Sync sources are not counted: they never race ADAPTER_TIMEOUT_MS (the worker
 * sweeps them), and counting them capped CeX below the 10 s its Algolia app
 * needs. Floor of 1: one source has no gap, so any pace fits.
 */
export function pacedSourceCount(sources: readonly { kind: SourceKind }[]): number {
  return Math.max(
    1,
    sources.filter((source) => source.kind !== "sync").length,
  );
}

/**
 * Whether a pace leaves every paced source time to answer: one limiter serves
 * them all, so the last starts at `(n-1) × ms` and must still have
 * PLUGIN_CALL_ALLOWANCE_MS inside the budget.
 */
export function paceBudget(sources: number, ms: number, adapterTimeoutMs: number): PaceBudget {
  const gaps = Math.max(0, sources - 1);
  const lastStartMs = gaps * ms;
  if (gaps === 0) return { lastStartMs, fits: true, largestThatFitsMs: null };
  const room = adapterTimeoutMs - PLUGIN_CALL_ALLOWANCE_MS;
  return {
    lastStartMs,
    fits: lastStartMs + PLUGIN_CALL_ALLOWANCE_MS <= adapterTimeoutMs,
    largestThatFitsMs: Math.max(0, Math.floor(room / gaps)),
  };
}

/** The reply to POST /api/plugins and to an approval. */
export interface PluginResponse {
  plugin: PluginDto;
}

/**
 * POST /api/plugins/:id/approve: the kinds approved per source id (anything
 * left out is not approved). `reviewedFingerprint` is REQUIRED and must be the
 * served `manifestFingerprint`: the API answers 409 if the manifest changed
 * since, so a plugin cannot promote its own roles between render and click.
 */
export interface ApprovePluginInput {
  approvedKinds: Record<SourceId, PriceKind[]>;
  reviewedFingerprint: string;
}

export const KIND_LABEL_FALLBACK: Record<PriceKind, string> = {
  sell: "sells for",
  cash: "pays cash",
  voucher: "pays voucher",
  active_median: "median (active)",
  active_listing: "listing",
  guide: "price guide",
};

/**
 * The one wording rule for a price kind: the source's declared label, or its
 * name plus the generic fallback ("Shop GB pays cash").
 */
export function kindDisplayLabel(
  byId: Record<SourceId, SourceInfo>,
  sourceId: SourceId,
  kind: PriceKind,
): string {
  return byId[sourceId]?.kindLabels?.[kind] ?? `${byId[sourceId]?.label ?? sourceId} ${KIND_LABEL_FALLBACK[kind]}`;
}

/**
 * A kind's word WITHOUT the source name, for rows under a heading that prints
 * it. Not interchangeable with `kindDisplayLabel` (name included) or the web's
 * `kindLabel` (long form, for aggregate rows): mixing them up doubles or drops
 * the name, and both have happened.
 */
export function kindLabelShort(
  byId: Record<string, SourceInfo>,
  sourceId: string,
  kind: PriceKind,
): string {
  return byId[sourceId]?.kindLabelsShort?.[kind] ?? KIND_LABEL_FALLBACK[kind];
}

/**
 * The PROFIT caveat for reference-based readings. Shared because the web
 * recognizes a fee-netted reading by this exact text ("(after fees)").
 */
export const PROFIT_FEE_CAVEAT = "listing price, not a sale; fees estimated";

export interface GameSummary {
  id: number;
  title: string;
  platform: Platform;
  year: number | null;
  coverUrl: string | null;
}

export interface SearchResponse {
  games: GameSummary[];
}

export interface PricePointDto {
  /** which source produced this point */
  source: SourceId;
  kind: PriceKind;
  region: Region;
  condition: Condition;
  /** cosmetic/physical grade (mint..poor), independent of condition (completeness) */
  grade?: ItemGrade | null;
  /** USD, frozen at write time from the original with that day's rate */
  priceUsd: number;
  /** the source's own verbatim amount — evidence, never re-converted */
  priceOriginal: number;
  /** the currency priceOriginal is quoted in (e.g. "GBP" for CeX/eBay UK) */
  currencyOriginal: string;
  sampleSize?: number | null;
  url?: string | null;
  listingTitle?: string | null;
  /**
   * Whether the source reported the listing buyable; `null` = unknown. The
   * signal engine skips buy-role points whose flag is `false`.
   */
  available: boolean | null;
}

export interface HistoryPointDto {
  /** YYYY-MM-DD, UTC */
  day: string;
  /** USD, frozen at write time like every stored amount */
  usd: number;
  /**
   * The source's own quote. The chart plots this, not `usd`, for a
   * single-currency series: the USD twin moves with FX for an unchanged price.
   */
  original: { amount: number; currency: string };
}

/**
 * One line on the history chart. No label field on purpose: the web labels it
 * with the same `kindLabel` the price table uses, so the two cannot disagree.
 */
export interface HistorySeriesDto {
  source: SourceId;
  kind: PriceKind;
  role: PriceRole;
  points: HistoryPointDto[];
}

export interface HistoryResponse {
  region: Region;
  condition: Condition;
  days: number;
  /** the window's own edges, not the first and last day with data */
  from: string;
  to: string;
  series: HistorySeriesDto[];
}

export interface CheapestListingDto {
  title: string;
  priceUsd: number;
  /** the verbatim amount the seller asked, beside the USD twin frozen at write time */
  priceOriginal: number;
  currencyOriginal: string;
  condition: Condition;
  /** the listing's cosmetic grade when the source reported one, so a mint copy is labelled */
  grade: ItemGrade | null;
  url: string | null;
}

export interface SourceBlock {
  source: SourceId;
  status: SourceStatus;
  fetchedAt?: string;
  points: PricePointDto[];
  cheapestListings?: CheapestListingDto[];
}

/**
 * A monetary quantity as USD (what comparisons run on) plus the verbatim
 * original. Shared because the web shows the original when the display
 * currency matches it.
 */
export interface SignalAmount {
  usd: number;
  original: number;
  currency: string;
}

/**
 * Source-agnostic signal types, computed from price ROLES:
 * - UNDERPRICED: a purchasable price sits under the reference, or a listing
 *   undercuts another source's store price
 * - OVERPRICED_STORE: a store's posted price is over the reference
 * - FLIP: a bid beats the acquisition price
 * - PROFIT: a sell-side reading (a bid, or a reference net of sellFeeRate)
 *   beats what was paid for an OWNED copy; collection only
 * - INSUFFICIENT_DATA: a wanted comparison had no usable reference
 * - TARGET_HIT: a purchasable price is at or under the watch's target
 * - PRICE_DROP: a reference or store price fell by a threshold over N days
 * - NEW_LOW: today's cheapest price is the lowest in the history window
 * - BACK_IN_STOCK: a store box went from out of stock to in stock
 * - RISING: an owned copy's market reference rose by a threshold over N days
 */
export const SIGNAL_TYPES = [
  "UNDERPRICED",
  "OVERPRICED_STORE",
  "FLIP",
  "PROFIT",
  "INSUFFICIENT_DATA",
  "TARGET_HIT",
  "PRICE_DROP",
  "NEW_LOW",
  "BACK_IN_STOCK",
  "RISING",
] as const;
export type SignalType = (typeof SIGNAL_TYPES)[number];

/**
 * How well-classified the compared items were: "high" = strict region and
 * condition, no fallbacks, grade-compatible; "potential" otherwise. Never
 * changes whether a signal fires.
 */
export type SignalConfidence = "high" | "potential";

export interface Signal {
  type: SignalType;
  reasoning: string;
  /** present on every emitted signal except INSUFFICIENT_DATA */
  confidence?: SignalConfidence;
  /** short English phrases explaining each confidence downgrade; empty for high */
  caveats?: string[];
  /** direct link to the specific listing the signal refers to, when the source provides one */
  url?: string;
  /**
   * What the signal is ABOUT (USD plus verbatim original):
   *   UNDERPRICED        the price you would pay
   *   OVERPRICED_STORE   the price the store posts
   *   FLIP               the acquisition price
   *   PROFIT             the net sell-side reading, after fees
   *   INSUFFICIENT_DATA  absent
   * Not the comparison baseline: pairwise UNDERPRICED consults no reference.
   */
  price?: SignalAmount;
  /** single-source signals: the source the price came from */
  source?: SourceId;
  /** flip signals: where to buy */
  buySource?: SourceId;
  /** flip and profit signals: where to sell/trade */
  sellSource?: SourceId;
  /**
   * PROFIT only: the price kind behind the gain, i.e. the instrument (cash,
   * voucher, or a fee-netted listing median).
   */
  sellKind?: PriceKind;
  /** PROFIT only: the net sell-side reading minus the paid price, USD (cents-rounded) */
  gainUsd?: number;
  /**
   * The relative advantage in percent, one decimal: the discount under the
   * reference, the flip or profit margin, the drop or the rise. Positive
   * signal types only; ranks the verdict.
   */
  edgePct?: number;
}

/** cached_auto = TTL cache; live = always fetch; cached_only = never fetch. */
export type PriceMode = "cached_auto" | "live" | "cached_only";
export type GamePriceOverride = Exclude<PriceMode, "cached_auto">;

export interface PricesResponse {
  game: GameSummary;
  sources: SourceBlock[];
  signals: Signal[];
  /** per-title override currently stored; null/absent = inherits global mode */
  gamePriceMode?: GamePriceOverride | null;
}

/**
 * The three readings of "what is my collection worth" (GET
 * /api/collection?valuation=), each with its fallback chain:
 * - market:      what similar copies are LISTED for (reference median via the
 *                signal engine's ladder); then trade-in, then replacement
 * - trade_in:    the best bid the copy qualifies for; then market, then replacement
 * - replacement: the cheapest in-stock store price; then market
 * OwnedCopyDto.valueBasis names the reading actually used. Default: market.
 */
export const VALUATION_BASES = ["market", "trade_in", "replacement"] as const;
export type ValuationBasis = (typeof VALUATION_BASES)[number];

/**
 * Which markets may value an owned copy. By default only the home country's
 * (a foreign restock is noise to a collection total); `includeForeign` widens
 * it. Never affects the signal engine, which compares across countries.
 */
export interface ValuationMarkets {
  country: CountryCode;
  includeForeign: boolean;
}

export const DEFAULT_VALUATION_MARKETS: ValuationMarkets = {
  country: "GB",
  includeForeign: false,
};

/** May this source's prices value a copy under the given market setting? */
export function valuesCopies(
  source: SourceId,
  markets: ValuationMarkets,
  sources: Record<string, SourceInfo>,
): boolean {
  if (markets.includeForeign) return true;
  return sources[source]?.country === markets.country;
}

/**
 * The concrete reading behind an owned copy's value, named by (source, kind)
 * so any source is labelled by its own manifest. `viaUnknownCondition` /
 * `viaUnknownRegion` name the fallback rung used (only a market median can
 * cross regions). A copy is never valued against a neighbouring completeness tier.
 */
export type ValueBasis =
  | {
      readAs: "reading";
      source: SourceId;
      priceKind: PriceKind;
      /** the reading came from points whose condition is undeclared */
      viaUnknownCondition: boolean;
      /** the reading came from points whose region is undeclared (market medians only) */
      viaUnknownRegion: boolean;
    }
  /**
   * Copies no reading was allowed to speak for. `outside_valuation_markets`
   * is reported separately from a bare null, because "open the game to fetch
   * prices" cannot help when the setting is what rejects them.
   */
  | { readAs: "excluded"; reason: "faulty" | "counterfeit" | "outside_valuation_markets" };

export const COPY_STATUSES = ["incoming", "owned", "listed", "sold", "returned"] as const;
export type CopyStatus = (typeof COPY_STATUSES)[number];
export const ITEM_GRADES = ["mint", "near_mint", "very_good", "good", "fair", "poor"] as const;
export type ItemGrade = (typeof ITEM_GRADES)[number];
export type WorkingState = "working" | "partial" | "untested" | "faulty";
export type Authenticity = "genuine" | "suspect" | "counterfeit";
export const ACQUIRED_SOURCES = [
  "ebay", "cex", "car_boot", "charity_shop", "store", "trade", "marketplace", "gift", "other",
  // set only by the PriceCharting collection importer, never by manual entry
  "pricecharting_import",
] as const;
export type AcquiredSource = (typeof ACQUIRED_SOURCES)[number];

/**
 * How a copy's gameId got linked:
 *   'exact'     - import auto-match on an exact name hit (or an explicit
 *                 game_id in a CSV, with a null score)
 *   'candidate' - user picked one of a review row's fuzzy candidates
 *   'manual'    - user picked any other game
 *   'confirmed' - user verified the link in match review
 * null = hand-added copy.
 */
export type MatchBasis = "exact" | "candidate" | "manual" | "confirmed";

export interface OwnedCopyDto {
  id: number;
  game: GameSummary;
  region: Region;
  condition: Condition;
  notes: string | null;
  acquiredAt: string | null;
  // Originals are verbatim; *_usd twins are frozen at write time.
  acquiredPriceOriginal: number | null;
  acquiredCurrency: SupportedCurrency | null;
  acquiredPriceUsd: number | null;
  status: CopyStatus;
  itemGrade: ItemGrade | null;
  workingState: WorkingState | null;
  authenticity: Authenticity | null;
  acquiredSource: AcquiredSource | null;
  acquiredUrl: string | null;
  acquisitionId: number | null;
  soldAt: string | null;
  soldPriceOriginal: number | null;
  soldFeesOriginal: number | null;
  /** ONE currency covers the sale's price+fees AND the return leg's refund/costs */
  soldCurrency: SupportedCurrency | null;
  soldPriceUsd: number | null;
  soldFeesUsd: number | null;
  soldVenue: string | null;
  returnedAt: string | null;
  refundOriginal: number | null;
  returnCostsOriginal: number | null;
  refundUsd: number | null;
  returnCostsUsd: number | null;
  estimatedValueUsd: number | null;
  valueBasis: ValueBasis | null;
  /** fetched_at of the stored batch the value came from */
  valueFetchedAt: string | null;
  /**
   * Signals from STORED points for this copy's region+condition. PROFIT exists
   * only here. The UI hides UNDERPRICED for owned copies; the API returns all.
   */
  signals: Signal[];
  matchBasis: MatchBasis | null;
  /** fuzzy score behind 'exact'/'candidate' bases; null for manual picks */
  matchScore: number | null;
}

type PnlLegs = Pick<
  OwnedCopyDto,
  "status" | "acquisitionId" | "acquiredPriceUsd" | "soldPriceUsd" | "soldFeesUsd" | "refundUsd" | "returnCostsUsd"
>;
const usd = (n: number | null): number => n ?? 0;

/** A sold copy's realized result; a lot copy's cost is its lot's, not counted here. */
export function realizedUsd(c: PnlLegs): number {
  if (c.status !== "sold") return 0;
  const cost = c.acquisitionId === null ? usd(c.acquiredPriceUsd) : 0;
  return usd(c.soldPriceUsd) - usd(c.soldFeesUsd) - cost;
}

/** A returned copy's result: a sale sent back, or a purchase returned unsold. */
export function returnedUsd(c: PnlLegs): number {
  if (c.status !== "returned") return 0;
  return c.soldPriceUsd !== null
    ? usd(c.soldPriceUsd) - usd(c.soldFeesUsd) - usd(c.refundUsd) - usd(c.returnCostsUsd)
    : usd(c.refundUsd) - usd(c.returnCostsUsd) - usd(c.acquiredPriceUsd);
}

export interface CollectionResponse {
  items: OwnedCopyDto[];
  /** echoes ?valuation= (default market) */
  valuationBasis: ValuationBasis;
  /** echoes ?country=&includeForeign= (default DEFAULT_VALUATION_MARKETS): they change the totals */
  valuationMarkets: ValuationMarkets;
  totalEstimatedUsd: number;
  totalPaidUsd: number;
  /**
   * Σ over status='sold' of frozen USD legs: sold_usd − fees_usd − own cost
   * basis; a lot's total is subtracted once, when none of its copies is active
   * (until then it sits in totalPaidUsd).
   */
  totalRealizedUsd: number;
  /**
   * Σ over status='returned', reported apart from sales: a sale the buyer sent
   * back nets sold − fees − refund − return costs; a purchase returned unsold
   * nets refund − return costs − paid.
   */
  totalReturnedUsd: number;
}

/** GET /api/collection/history: one point per UTC day the totals were computed */
export interface CollectionHistoryResponse {
  valuationBasis: ValuationBasis;
  valuationMarkets: ValuationMarkets;
  days: number;
  from: string;
  to: string;
  points: Array<{ day: string; estimatedUsd: number; paidUsd: number }>;
}

/** GET /api/watchlist/history: the summed cheapest price of every watch, per UTC day */
export interface WatchlistHistoryResponse {
  days: number;
  from: string;
  to: string;
  /** `covered` of `of` watches had a price that day; days with none are left out */
  points: Array<{ day: string; totalUsd: number; covered: number; of: number }>;
}

/** GET /api/watchlist/sparklines and /api/collection/sparklines: row id -> daily points */
export interface SparklinesResponse {
  days: number;
  series: Record<number, Array<{ day: string; usd: number }>>;
}

export interface AddCopyInput {
  gameId: number;
  region: Region;
  condition: Condition;
  status?: CopyStatus; // default 'owned'; 'incoming' for an eBay purchase in flight
  /** omit when the user never touched the grade control - never default it */
  itemGrade?: ItemGrade;
  notes?: string;
  acquiredAt?: string;
  /** both or neither: an amount needs its currency (converted to USD at write) */
  acquiredPriceOriginal?: number;
  acquiredCurrency?: SupportedCurrency;
  acquiredSource?: AcquiredSource;
  acquiredUrl?: string;
}

/** every field optional; explicit null clears a nullable column */
export interface UpdateCopyInput {
  status?: CopyStatus;
  region?: Region;
  condition?: Condition;
  notes?: string | null;
  itemGrade?: ItemGrade | null;
  workingState?: WorkingState | null;
  authenticity?: Authenticity | null;
  acquiredAt?: string | null;
  acquiredPriceOriginal?: number | null;
  acquiredCurrency?: SupportedCurrency | null;
  acquiredSource?: AcquiredSource | null;
  acquiredUrl?: string | null;
  acquisitionId?: number | null;
  soldAt?: string | null;
  soldPriceOriginal?: number | null;
  soldFeesOriginal?: number | null;
  soldCurrency?: SupportedCurrency | null;
  soldVenue?: string | null;
  returnedAt?: string | null;
  refundOriginal?: number | null;
  returnCostsOriginal?: number | null;
}

/**
 * PriceCharting collection import (POST /api/collection/import/pricecharting).
 * The public collection page carries no purchase prices, so imported copies
 * never get an acquisition cost — only the market value at import, in notes.
 */
export type PcMatchStatus = "matched" | "review" | "unmatched" | "unsupported_platform";

export interface PcImportRequest {
  url: string;
  /** default true: preview only, nothing is written */
  dryRun?: boolean;
  /** when present, the import only inserts these offers (checkbox selection) */
  includeOfferIds?: string[];
  /**
   * offerId -> chosen gameId. A review row imports ONLY through an entry here,
   * never via includeOfferIds; the game must be on the row's platform.
   */
  overrides?: Record<string, number>;
}

/** one selectable option for a review row in the import preview */
export interface PcImportCandidate {
  game: GameSummary;
  /** effective fuzzy score (numeral-mismatch capped), rounded to 3 decimals */
  score: number;
  /** the sequel-numeral sets of row and candidate title differ ({"2"} vs {}) */
  numeralMismatch: boolean;
}

export interface PcImportRow {
  offerId: string;
  title: string;
  /** original PriceCharting console name, e.g. "PAL GameBoy Advance" */
  consoleName: string;
  /** original includes text, e.g. "Item, Box, and Manual" */
  includes: string;
  /** PriceCharting is natively USD: the parsed number verbatim, no FX involved */
  valueUsd: number | null;
  /** null when the console is not a supported platform */
  platform: Platform | null;
  region: Region | null;
  condition: Condition | null;
  matchStatus: PcMatchStatus;
  /** effective fuzzy score of the top candidate; only set for matched/review rows */
  matchScore: number | null;
  game: GameSummary | null;
  /** up to 5 platform-filtered candidates; matched rows carry just their winner */
  candidates: PcImportCandidate[];
  /** an owned copy with this offer's URL already exists */
  duplicate: boolean;
}

export interface PcImportResponse {
  dryRun: boolean;
  rows: PcImportRow[];
  imported: number;
  skippedDuplicates: number;
  totals: { matched: number; review: number; unmatched: number; unsupported: number };
  /** collection size from the page's own summary table; null when absent */
  totalCount: number | null;
  /** true when fewer rows were fetched than the summary reports (page cap, parse misses) */
  truncated: boolean;
}

/**
 * PATCH /api/collection/:id/link: re-link a copy (cross-platform allowed);
 * sets matchBasis 'manual'. POST /api/collection/:id/confirm-link sets
 * 'confirmed'. Both return the updated OwnedCopyDto.
 */
export interface LinkCopyInput {
  gameId: number;
}

/** PATCH /api/watchlist/:id: omitted keeps, null means "any" (or clears the target). */
export interface UpdateWatchInput {
  region?: Region | null;
  condition?: Condition | null;
  /** both or neither; null clears the target, a change re-freezes its USD twin */
  targetPriceOriginal?: number | null;
  targetCurrency?: SupportedCurrency | null;
}

export interface AddWatchInput {
  gameId: number;
  region?: Region;
  condition?: Condition;
  /** both or neither: an amount needs its currency (converted to USD at write) */
  targetPriceOriginal?: number;
  targetCurrency?: SupportedCurrency;
}

/** A shop's own quote: the amount in both spaces, and the wording that shop declared for it. */
export interface StoreQuoteDto {
  kind: PriceKind;
  /** the source's declared label for this kind, or the app's fallback */
  label: string;
  priceUsd: number;
  priceOriginal: number;
  currencyOriginal: string;
}

export interface WatchlistItemDto {
  id: number;
  game: GameSummary;
  region: Region | null;      // null = any
  condition: Condition | null; // null = any
  targetPriceOriginal: number | null;
  targetCurrency: SupportedCurrency | null;
  /** frozen at write time from the original with that day's rate */
  targetPriceUsd: number | null;
  /**
   * The cheapest matching in-stock offer of one shop, and every payout THAT
   * shop quotes for the slice. Keyed on ROLE, not kind names; a list because a
   * shop may pay both cash and store credit, and quoting credit as money is the
   * mistake this shape prevents. Null/empty together when no shop quoted.
   */
  storeOffer: StoreQuoteDto | null;
  storeBids: StoreQuoteDto[];
  storeSource: SourceId | null;
  /** batch time of the shop above, so the date belongs to the numbers beside it */
  priceDisplayAt: string | null;
  /** with a target set, buy signals (UNDERPRICED, FLIP) priced above it are left out */
  signals: Signal[];
  /** how many buy signals the target left out, so the screen can say so */
  signalsAboveTarget: number;
}

export interface WatchlistResponse {
  items: WatchlistItemDto[];
}

/**
 * Canonical CSV formats — the single definition export and import round-trip.
 *
 * Collection CSV (GET /api/collection/export, POST /api/collection/import/csv):
 *   game_id,title,platform,region,condition,grade,status,
 *   paid_original,paid_currency,paid_usd,
 *   notes,acquired_at,acquired_source,acquired_url,match_basis,
 *   sold_at,sold_venue,sold_currency,sold_original,sold_fees_original,
 *   sold_usd,sold_fees_usd,returned_at,refund_original,return_costs_original,
 *   refund_usd,return_costs_usd
 *
 * - game_id: games.id. On import, an existing game_id SKIPS matching (exact
 *   restore); empty or foreign ids take the fuzzy path.
 * - platform: Platform id, used only by the fuzzy path; unknown values make the
 *   row unsupported_platform.
 * - region/condition empty = "unknown"; grade empty = null; status empty = "owned".
 * - paid_original + paid_currency travel together; paid_usd is the frozen twin.
 *   A present paid_usd is stored verbatim (never re-derived); only an empty one
 *   is converted at import. A usd-only row synthesizes no original.
 * - acquired_at: YYYY-MM-DD or empty.
 * - match_basis: exported for information only; import re-derives it.
 * - sale/return group: sold_currency denominates all four amounts (sale, fees,
 *   refund, return costs); a purchase returned unsold has no sold_currency and
 *   its return leg is in paid_currency. Each *_usd twin follows the paid_usd
 *   rule. sold_*
 *   needs status sold or returned (a return follows a sale); returned_at,
 *   refund_* and return_costs_* need status returned; status sold needs
 *   sold_at and sold_original. The group is optional on import, so a file
 *   exported before it existed still imports.
 *
 * Watchlist CSV (GET /api/watchlist/export, POST /api/watchlist/import/csv):
 *   game_id,title,platform,region,condition,target_original,target_currency,target_usd
 *
 * - region/condition empty = "any". game_id and money columns as above.
 *
 * Import accepts any column order but requires the exact column SET (less the
 * optional group above).
 */
export const COLLECTION_CSV_COLUMNS = [
  "game_id", "title", "platform", "region", "condition", "grade", "status",
  "paid_original", "paid_currency", "paid_usd",
  "notes", "acquired_at", "acquired_source", "acquired_url", "match_basis",
  "sold_at", "sold_venue", "sold_currency", "sold_original", "sold_fees_original",
  "sold_usd", "sold_fees_usd", "returned_at", "refund_original", "return_costs_original",
  "refund_usd", "return_costs_usd",
] as const;
export type CollectionCsvColumn = (typeof COLLECTION_CSV_COLUMNS)[number];
/** the sale/return group: always exported, optional on import */
export const COLLECTION_CSV_OPTIONAL_COLUMNS: readonly CollectionCsvColumn[] = [
  "sold_at", "sold_venue", "sold_currency", "sold_original", "sold_fees_original",
  "sold_usd", "sold_fees_usd", "returned_at", "refund_original", "return_costs_original",
  "refund_usd", "return_costs_usd",
];

export const WATCHLIST_CSV_COLUMNS = [
  "game_id", "title", "platform", "region", "condition",
  "target_original", "target_currency", "target_usd",
] as const;
export type WatchlistCsvColumn = (typeof WATCHLIST_CSV_COLUMNS)[number];

/**
 * Shared CSV import request: the PriceCharting contract keyed by 0-based
 * data-row index. A review row imports ONLY through overrides, and every chosen
 * game must exist or the whole request 400s (all-or-nothing).
 */
export interface CsvImportRequest {
  csv: string;
  /** default true: preview only, nothing is written */
  dryRun?: boolean;
  /** when present, only these data-row indexes import (checkbox selection) */
  includeRowIndexes?: number[];
  /** review-row decisions: rowIndex (decimal string key) -> chosen gameId */
  overrides?: Record<string, number>;
}

/** row-level validation failure reported by the 400 invalid_rows response */
export interface CsvRowError {
  rowIndex: number;
  column: string;
  message: string;
}

/** Preview row shared by both CSV imports; mirrors PcImportRow for the web's components. */
export interface CsvImportRowBase {
  /** 0-based data-row index — the includeRowIndexes/overrides key */
  rowIndex: number;
  /** raw CSV title, preserved for the preview */
  title: string;
  /** raw CSV platform value, preserved for unsupported_platform reporting */
  platformValue: string;
  /** null when the platform value is not a supported platform */
  platform: Platform | null;
  matchStatus: PcMatchStatus;
  /** 1 for game_id rows; the effective fuzzy score otherwise (matched/review) */
  matchScore: number | null;
  /** how a matched row matched: explicit game_id vs exact title hit */
  matchedBy: "game_id" | "title" | null;
  game: GameSummary | null;
  /** same semantics as PcImportRow.candidates (review rows: top 5 options) */
  candidates: PcImportCandidate[];
  /**
   * Collection: same (gameId, region, condition, grade if given); still
   * selectable, only unchecked by default. Watchlist: same (gameId, region,
   * condition); always skipped (unique constraint).
   */
  duplicate: boolean;
}

export interface CsvCollectionImportRow extends CsvImportRowBase {
  region: Region;
  condition: Condition;
  grade: ItemGrade | null;
  status: CopyStatus;
  paidOriginal: number | null;
  paidCurrency: SupportedCurrency | null;
  /** as parsed from the CSV; when null with an original present, USD is frozen at confirm time */
  paidUsd: number | null;
  notes: string | null;
  acquiredAt: string | null;
  acquiredSource: AcquiredSource | null;
  acquiredUrl: string | null;
}

export interface CsvWatchlistImportRow extends CsvImportRowBase {
  region: Region | null;      // null = any
  condition: Condition | null; // null = any
  targetOriginal: number | null;
  targetCurrency: SupportedCurrency | null;
  targetUsd: number | null;
}

export interface CsvImportResponse<Row extends CsvImportRowBase> {
  dryRun: boolean;
  rows: Row[];
  imported: number;
  /** collection: duplicates excluded by the default selection; watchlist: rows hitting the unique constraint */
  skipped: number;
  totals: { matched: number; review: number; unmatched: number; unsupported: number };
}
export type CsvCollectionImportResponse = CsvImportResponse<CsvCollectionImportRow>;
export type CsvWatchlistImportResponse = CsvImportResponse<CsvWatchlistImportRow>;

export * from "./verdict.js";
export * from "./insights.js";
import type { RecommendationThresholds } from "./insights.js";

/**
 * The signal configuration, stored in app_settings under `signal_config` and
 * edited in Settings → Signals. The six factors default to the deployment's
 * SIGNAL_* env values, so an upgraded install behaves as before.
 */
export interface SignalConfigDto extends RecommendationThresholds {
  /** UNDERPRICED: a price under reference × this */
  underpricedFactor: number;
  /** OVERPRICED_STORE: a store price over reference × this */
  overpricedFactor: number;
  /** FLIP: a bid over the acquisition price × this */
  flipFactor: number;
  /** PROFIT: a net sell-side reading over the paid price × this */
  profitFactor: number;
  /** UNDERPRICED pairwise: a listing under another source's store price × this */
  crossStoreFactor: number;
  /** listings a median needs before it can serve as a reference */
  minSample: number;
  /** PRICE_DROP: a fall of at least this percent … */
  priceDropPct: number;
  /** … against the price this many days ago */
  priceDropDays: number;
  /** NEW_LOW: the history window, in days */
  newLowDays: number;
  /** RISING: a rise of at least this percent … */
  risingPct: number;
  /** … over this many days */
  risingDays: number;
  /** signal types that may fire; INSUFFICIENT_DATA is never gated */
  enabledTypes: SignalType[];
  /** sources whose prices are shown but never raise a signal */
  excludedSources: SourceId[];
  /** FLIP and PROFIT below this gain are dropped; null = no floor */
  minGain: { amount: number; currency: SupportedCurrency } | null;
  /** send low-confidence signals as phone alerts too */
  alertLowConfidence: boolean;
}

/** the defaults of the thresholds that have no env variable */
export const SIGNAL_THRESHOLD_DEFAULTS = {
  priceDropPct: 15,
  priceDropDays: 7,
  newLowDays: 90,
  risingPct: 20,
  risingDays: 30,
} as const;

/** POST /api/settings/signals/preview: what a configuration would do to the watchlist */
export interface SignalPreviewResponse {
  watches: number;
  /** watches whose signals give a verdict under the previewed configuration */
  withSignal: number;
  /** the first such watch and its verdict line */
  example: { title: string; verdictTitle: string } | null;
  /** what GET /api/insights would recommend under the previewed configuration, by group */
  recommendations: { sellNow: number; buyNow: number; targets: number; cleanUps: number };
}
