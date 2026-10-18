import type { SourceId, SourceInfoDto } from "@retrowatchdog/shared";

/**
 * CeX's three shops, as the approved plugin's manifest declares them:
 * transcribed verbatim from `retrowatchdog-cex-plugin/manifest.fixture.json` (the
 * plugin's own checked-in
 * manifest, which apps/api's own contract test runs the real `validateManifest`
 * over). One step further from the source of truth than that api-side test, so
 * treat a mismatch here as this file having drifted, not the fixture it was
 * copied from.
 *
 * Almost this whole suite assumes CeX exists: PriceTable, GameDetail,
 * CexAvailability, CexPriceMode and the Settings fixtures all say "cex" and
 * expect "CeX UK" back.
 */
const CEX_SHOPS: readonly Omit<SourceInfoDto, "configured" | "origin" | "pluginId">[] = (
  [
    // id (NOT derivable from the country code — "cex" is the UK shop's
    // historic spelling, kept so no stored row had to be migrated), label,
    // country, currency
    ["cex", "CeX UK", "GB", "GBP"],
    ["cex_es", "CeX ES", "ES", "EUR"],
    ["cex_ie", "CeX IE", "IE", "EUR"],
  ] as const
).map(([id, label, country, currency]) => ({
  id: id as SourceId,
  label,
  family: "cex",
  familyLabel: "CeX",
  kind: "sync",
  country,
  reach: "local",
  defaultRegion: "PAL",
  expectedCurrencies: [currency],
  kindLabels: {
    sell: `${label} sells for`,
    cash: `${label} pays cash`,
    voucher: `${label} pays voucher`,
  },
  kindRoles: { sell: "buy_store", cash: "bid", voucher: "bid" },
  productUrl: `https://${id === "cex" ? "uk" : id.slice(4)}.webuy.com/product-detail?id={id}`,
  schedule: { catalogCron: "0 3 * * *", trackedRefreshHours: 4 },
}));

/**
 * The five eBay markets, as the approved plugin's manifest declares them:
 * transcribed verbatim from `retrowatchdog-ebay-plugin/manifest.fixture.json`, so
 * treat a mismatch as this file having drifted. PriceTable, GameDetail,
 * WatchlistScreen and the Settings fixtures all say "ebay_uk" and expect
 * "eBay UK" back.
 */
const RETIRED_EBAY_MARKETS: readonly Omit<SourceInfoDto, "configured" | "origin" | "pluginId">[] = (
  [
    // id (NOT derivable from the country code — "ebay_uk" spells the UK
    // market, not "ebay_gb"), label, country, currency
    ["ebay_uk", "eBay UK", "GB", "GBP"],
    ["ebay_de", "eBay DE", "DE", "EUR"],
    ["ebay_es", "eBay ES", "ES", "EUR"],
    ["ebay_fr", "eBay FR", "FR", "EUR"],
    ["ebay_us", "eBay US", "US", "USD"],
  ] as const
).map(([id, label, country, currency]) => ({
  id: id as SourceId,
  label,
  family: "ebay",
  familyLabel: "eBay",
  kind: "live",
  country,
  reach: "global",
  defaultRegion: null,
  expectedCurrencies: [currency],
  kindLabels: {
    active_median: `${label} median (active)`,
    active_listing: `${label} listing`,
  },
  kindRoles: { active_median: "reference", active_listing: "buy_listing" },
  caveat: `${label} prices are active FIXED-PRICE listings, not sold prices.`,
  sellFeeRate: 0.13,
}));

/**
 * The registry every web test starts with: the eight sources two approved
 * plugins declare, shaped as GET /api/sources serves them.
 *
 * The suite needs a registry because the screens read one now (lib/sources.ts)
 * instead of importing the manifest. Seeding it in test/setup.ts keeps each
 * test's fetch stub about the thing that test is testing — many of them throw
 * on an unexpected URL, so a real load at boot would break them — and a test
 * that cares about an IMPORTED source calls setSourcesForTests itself with
 * whatever registry it wants.
 *
 * `origin` is "plugin" with a stable `pluginId` per plugin row (2 for CeX's
 * three, 1 for eBay's five — one row each, as production serves them), and
 * every source is `configured`.
 */
export const SOURCES_FIXTURE: SourceInfoDto[] = [
  ...CEX_SHOPS.map((info) => ({
    ...info,
    configured: true,
    origin: "plugin" as const,
    pluginId: 2,
  })),
  ...RETIRED_EBAY_MARKETS.map((info) => ({
    ...info,
    configured: true,
    origin: "plugin" as const,
    pluginId: 1,
  })),
];
