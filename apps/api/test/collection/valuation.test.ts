import { describe, it, expect } from "vitest";
import type { PriceKind, PricePointDto, SourceId, ValuationBasis, ValuationMarkets, ValueBasis } from "@retrowatchdog/shared";
import { DEFAULT_VALUATION_MARKETS } from "@retrowatchdog/shared";
import { estimateCopyValue, type CopyForValuation } from "../../src/collection/valuation.js";
import { PLUGIN_SOURCES } from "../helpers/pluginSources.js";

/** the expected basis of a reading; rung flags default to the exact rung */
const reading = (
  source: SourceId,
  priceKind: PriceKind,
  rungs: { viaUnknownCondition?: boolean; viaUnknownRegion?: boolean } = {},
): ValueBasis => ({
  readAs: "reading",
  source,
  priceKind,
  viaUnknownCondition: rungs.viaUnknownCondition ?? false,
  viaUnknownRegion: rungs.viaUnknownRegion ?? false,
});

const p = (over: Partial<PricePointDto>): PricePointDto => ({
  source: "cex", kind: "sell", region: "PAL", condition: "cib",
  priceUsd: 0, priceOriginal: 0, currencyOriginal: "GBP", available: null,
  ...over,
});
/** eBay active median: the only reference-role point today */
const median = (priceUsd: number, sampleSize: number, over: Partial<PricePointDto> = {}): PricePointDto =>
  p({ source: "ebay_uk", kind: "active_median", priceUsd, sampleSize, ...over });

const MIN_SAMPLE = 5;
const palCib: CopyForValuation = { region: "PAL", condition: "cib", itemGrade: null };
const value = (points: PricePointDto[], basis: ValuationBasis, copy: Partial<CopyForValuation> = {}) =>
  estimateCopyValue(points, { ...palCib, ...copy }, basis, {
    minSample: MIN_SAMPLE,
    // these cases are all UK sources; the markets gate has its own describe below
    markets: DEFAULT_VALUATION_MARKETS,
    // resolves the role of the "ebay_uk" points the `median` fixture tags
    sources: PLUGIN_SOURCES,
  });

/**
 * The measured scenario (Blades of Steel, PAL, 2026-09-02) scaled to cib:
 * CeX sells for 38 (in stock) and 240 (an out-of-stock SKU), pays 20 voucher
 * / 12 cash, and eBay's active median sits at 30 over 9 listings. Three
 * honest readings of the same copy: 30 market, 20 trade-in, 38 replacement.
 */
const seeded: PricePointDto[] = [
  p({ kind: "sell", priceUsd: 38, available: true }),
  p({ kind: "sell", priceUsd: 240, available: false }),
  p({ kind: "voucher", priceUsd: 20 }),
  p({ kind: "cash", priceUsd: 12 }),
  median(30, 9),
];

describe("estimateCopyValue — each basis picks its documented reading", () => {
  it("market: the eBay active median for the copy's exact region+condition", () => {
    expect(value(seeded, "market")).toEqual({ value: 30, basis: reading("ebay_uk", "active_median"), source: "ebay_uk" });
  });

  it("trade_in: the best bid, voucher over cash", () => {
    expect(value(seeded, "trade_in")).toEqual({ value: 20, basis: reading("cex", "voucher"), source: "cex" });
    // "best" means highest payout, whichever flavor carries it
    const cashRich = [p({ kind: "voucher", priceUsd: 10 }), p({ kind: "cash", priceUsd: 14 })];
    expect(value(cashRich, "trade_in")).toEqual({ value: 14, basis: reading("cex", "cash"), source: "cex" });
  });

  it("replacement: the cheapest IN-STOCK sell (today's behavior)", () => {
    expect(value(seeded, "replacement")).toEqual({ value: 38, basis: reading("cex", "sell"), source: "cex" });
  });

  it("returns null on an empty point set for every basis", () => {
    for (const basis of ["market", "trade_in", "replacement"] as const) {
      expect(value([], basis)).toBeNull();
    }
  });
});

describe("estimateCopyValue — fallbacks label what was actually used", () => {
  const noMedian = seeded.filter((x) => x.kind !== "active_median");
  const noBids = seeded.filter((x) => x.kind !== "voucher" && x.kind !== "cash");
  const sellsOnly = noMedian.filter((x) => x.kind === "sell");
  const bidsOnly = noMedian.filter((x) => x.kind !== "sell");

  it("market -> trade-in -> replacement", () => {
    expect(value(noMedian, "market")).toEqual({ value: 20, basis: reading("cex", "voucher"), source: "cex" });
    expect(value(sellsOnly, "market")).toEqual({ value: 38, basis: reading("cex", "sell"), source: "cex" });
  });

  it("trade_in -> market -> replacement", () => {
    expect(value(noBids, "trade_in")).toEqual({ value: 30, basis: reading("ebay_uk", "active_median"), source: "ebay_uk" });
    expect(value(sellsOnly, "trade_in")).toEqual({ value: 38, basis: reading("cex", "sell"), source: "cex" });
  });

  it("replacement -> market, and never a bid: a payout is not a rebuy cost", () => {
    expect(value(noBids.filter((x) => x.kind !== "sell"), "replacement")).toEqual({
      value: 30, basis: reading("ebay_uk", "active_median"), source: "ebay_uk",
    });
    expect(value(bidsOnly, "replacement")).toBeNull();
  });
});

describe("estimateCopyValue — undeclared-dimension rungs are labelled, never silent", () => {
  it("market descends the engine's ladder: unknown condition, unknown region, both", () => {
    expect(value([median(22, 6, { condition: "unknown" })], "market")).toEqual({
      value: 22, basis: reading("ebay_uk", "active_median", { viaUnknownCondition: true }), source: "ebay_uk",
    });
    expect(value([median(18, 8, { region: "unknown" })], "market")).toEqual({
      value: 18, basis: reading("ebay_uk", "active_median", { viaUnknownRegion: true }), source: "ebay_uk",
    });
    expect(value([median(4.19, 18, { region: "unknown", condition: "unknown" })], "market")).toEqual({
      value: 4.19, basis: reading("ebay_uk", "active_median", { viaUnknownRegion: true, viaUnknownCondition: true }), source: "ebay_uk",
    });
  });

  it("the exact rung wins over fatter fallback rungs", () => {
    const points = [
      median(32, 12),
      median(10, 40, { condition: "unknown" }),
      median(8, 50, { region: "unknown" }),
    ];
    expect(value(points, "market")).toEqual({ value: 32, basis: reading("ebay_uk", "active_median"), source: "ebay_uk" });
  });

  it("trade-in and replacement take the unknown-condition rung of the same region", () => {
    expect(value([p({ kind: "voucher", condition: "unknown", priceUsd: 15 })], "trade_in")).toEqual({
      value: 15, basis: reading("cex", "voucher", { viaUnknownCondition: true }), source: "cex",
    });
    expect(value([p({ kind: "cash", condition: "unknown", priceUsd: 9 })], "trade_in")).toEqual({
      value: 9, basis: reading("cex", "cash", { viaUnknownCondition: true }), source: "cex",
    });
    expect(value([p({ kind: "sell", condition: "unknown", priceUsd: 25 })], "replacement")).toEqual({
      value: 25, basis: reading("cex", "sell", { viaUnknownCondition: true }), source: "cex",
    });
  });

  it("a copy of unknown condition reads the unknown-condition points as its own (no suffix)", () => {
    const unknownCopy = { condition: "unknown" as const };
    expect(value([p({ kind: "sell", condition: "unknown", priceUsd: 25 })], "replacement", unknownCopy)).toEqual({
      value: 25, basis: reading("cex", "sell"), source: "cex",
    });
    expect(value([median(22, 6, { condition: "unknown" })], "market", unknownCopy)).toEqual({
      value: 22, basis: reading("ebay_uk", "active_median"), source: "ebay_uk",
    });
  });
});

describe("estimateCopyValue — the market reading respects the sample floor", () => {
  it("a 3-listing median is not a market value: falls through to trade-in", () => {
    const thin = [median(30, 3), p({ kind: "voucher", priceUsd: 20 })];
    expect(value(thin, "market")).toEqual({ value: 20, basis: reading("cex", "voucher"), source: "cex" });
    // and to null when nothing else can speak for the copy
    expect(value([median(30, 3)], "market")).toBeNull();
  });

  it("a thin exact rung does not bury a usable deeper rung (the engine's regression)", () => {
    const points = [median(40, 2), median(30, 9, { region: "unknown" })];
    expect(value(points, "market")).toEqual({ value: 30, basis: reading("ebay_uk", "active_median", { viaUnknownRegion: true }), source: "ebay_uk" });
  });

  it("the floor is the caller's (the route passes SIGNAL_MIN_SAMPLE)", () => {
    expect(
      estimateCopyValue([median(30, 3)], palCib, "market", {
        minSample: 3,
        markets: DEFAULT_VALUATION_MARKETS,
        sources: PLUGIN_SOURCES,
      }),
    ).toEqual({
      value: 30, basis: reading("ebay_uk", "active_median"), source: "ebay_uk",
    });
  });
});

describe("estimateCopyValue — trade-in is grade-honest", () => {
  // the collection-signals seed: ungraded voucher 80 + Mint-SKU voucher 218
  const vouchers = [
    p({ kind: "voucher", priceUsd: 80 }),
    p({ kind: "voucher", priceUsd: 218, grade: "mint" }),
  ];

  it("a mint voucher never values a non-mint copy; an ungraded voucher values every copy", () => {
    expect(value(vouchers, "trade_in", { itemGrade: "good" })).toEqual({ value: 80, basis: reading("cex", "voucher"), source: "cex" });
    expect(value(vouchers, "trade_in", { itemGrade: null })).toEqual({ value: 80, basis: reading("cex", "voucher"), source: "cex" });
    expect(value(vouchers, "trade_in", { itemGrade: "mint" })).toEqual({ value: 218, basis: reading("cex", "voucher"), source: "cex" });
  });

  it("with only a graded bid the non-mint copy has no trade-in reading at all", () => {
    const mintOnly = [p({ kind: "voucher", priceUsd: 218, grade: "mint" })];
    expect(value(mintOnly, "trade_in", { itemGrade: "good" })).toBeNull();
    // ...so the chain moves on to whatever else can honestly speak
    expect(value([...mintOnly, median(30, 9)], "trade_in", { itemGrade: "good" })).toEqual({
      value: 30, basis: reading("ebay_uk", "active_median"), source: "ebay_uk",
    });
  });
});

describe("estimateCopyValue — every reading is grade-honest (R1: only value mints with mints)", () => {
  // The user's ruling: a graded point (a CeX Mint SKU, sell or bid) values
  // only a copy of that same grade, and a graded copy prefers its own grade's
  // pool for a reading whenever that pool can speak — never the cheapest
  // thing on the shelf whatever its grade.
  const mintSell = p({ kind: "sell", priceUsd: 240, grade: "mint", available: true });

  it("replacement: an in-stock Mint sell never values a good or ungraded copy — with only an out-of-stock ungraded sell it falls through to market, or null", () => {
    const points = [mintSell, p({ kind: "sell", priceUsd: 38, available: false })];
    expect(value(points, "replacement", { itemGrade: "good" })).toBeNull();
    expect(value(points, "replacement", { itemGrade: null })).toBeNull();
    expect(value([...points, median(30, 9)], "replacement", { itemGrade: "good" })).toEqual({
      value: 30, basis: reading("ebay_uk", "active_median"), source: "ebay_uk",
    });
  });

  it("replacement: a mint copy is priced by the Mint SKU even when a cheaper ungraded SKU is in stock", () => {
    const points = [mintSell, p({ kind: "sell", priceUsd: 42, available: true })];
    expect(value(points, "replacement", { itemGrade: "mint" })).toEqual({ value: 240, basis: reading("cex", "sell"), source: "cex" });
    // the good and ungraded copies ignore the Mint SKU entirely
    expect(value(points, "replacement", { itemGrade: "good" })).toEqual({ value: 42, basis: reading("cex", "sell"), source: "cex" });
    expect(value(points, "replacement", { itemGrade: null })).toEqual({ value: 42, basis: reading("cex", "sell"), source: "cex" });
  });

  it("a mint copy whose Mint SKU is out of stock reads the ungraded shelf: the grade pool has no offer to speak with", () => {
    const points = [p({ kind: "sell", priceUsd: 240, grade: "mint", available: false }), p({ kind: "sell", priceUsd: 42, available: true })];
    expect(value(points, "replacement", { itemGrade: "mint" })).toEqual({ value: 42, basis: reading("cex", "sell"), source: "cex" });
  });

  it("trade-in is unchanged: mint voucher 218 vs ungraded 80 → mint copy 218, null-grade copy 80", () => {
    const vouchers = [p({ kind: "voucher", priceUsd: 80 }), p({ kind: "voucher", priceUsd: 218, grade: "mint" })];
    expect(value(vouchers, "trade_in", { itemGrade: "mint" })).toEqual({ value: 218, basis: reading("cex", "voucher"), source: "cex" });
    expect(value(vouchers, "trade_in", { itemGrade: null })).toEqual({ value: 80, basis: reading("cex", "voucher"), source: "cex" });
    // the grade pool wins even when the ungraded bid pays more: a mint copy is valued with mints
    const richerUngraded = [p({ kind: "voucher", priceUsd: 300 }), p({ kind: "voucher", priceUsd: 218, grade: "mint" })];
    expect(value(richerUngraded, "trade_in", { itemGrade: "mint" })).toEqual({ value: 218, basis: reading("cex", "voucher"), source: "cex" });
  });

  it("a point of another grade never values a copy, under any reading", () => {
    const mintOnly = [mintSell, p({ kind: "voucher", priceUsd: 218, grade: "mint" })];
    for (const basis of ["market", "trade_in", "replacement"] as const) {
      expect(value(mintOnly, basis, { itemGrade: "near_mint" })).toBeNull();
      expect(value(mintOnly, basis, { itemGrade: "good" })).toBeNull();
    }
  });

  it("the grade preference is decided per reading: a mint copy reads trade-in from the ungraded pool and replacement from the Mint pool", () => {
    const points = [mintSell, p({ kind: "voucher", priceUsd: 80 }), p({ kind: "sell", priceUsd: 42, available: true })];
    expect(value(points, "trade_in", { itemGrade: "mint" })).toEqual({ value: 80, basis: reading("cex", "voucher"), source: "cex" });
    expect(value(points, "replacement", { itemGrade: "mint" })).toEqual({ value: 240, basis: reading("cex", "sell"), source: "cex" });
  });
});

describe("estimateCopyValue — completeness tiers are strict", () => {
  it("boxed_no_manual never borrows cib prices, under any basis", () => {
    const cibOnly = seeded; // every seeded point is cib
    const copy = { condition: "boxed_no_manual" as const };
    expect(value(cibOnly, "market", copy)).toBeNull();
    expect(value(cibOnly, "trade_in", copy)).toBeNull();
    expect(value(cibOnly, "replacement", copy)).toBeNull();
    // the undeclared-condition rung is the only widening allowed, and it is labelled
    expect(value([...cibOnly, p({ kind: "voucher", condition: "unknown", priceUsd: 6 })], "trade_in", copy)).toEqual({
      value: 6, basis: reading("cex", "voucher", { viaUnknownCondition: true }), source: "cex",
    });
  });
});

describe("estimateCopyValue — stock: offers need stock, bids do not", () => {
  it("replacement ignores out-of-stock sells (the FFTA £240 SKU) and takes the cheapest in-stock one", () => {
    const points = [
      p({ kind: "sell", priceUsd: 55, available: true }),
      p({ kind: "sell", priceUsd: 42, available: true }),
      p({ kind: "sell", priceUsd: 30, available: false }),
      p({ kind: "sell", priceUsd: 240, available: false }),
    ];
    expect(value(points, "replacement")).toEqual({ value: 42, basis: reading("cex", "sell"), source: "cex" });
  });

  it("treats an unknown stock flag as in stock (legacy rows and aggregates)", () => {
    const points = [p({ kind: "sell", priceUsd: 60, available: null }), p({ kind: "sell", priceUsd: 45, available: false })];
    expect(value(points, "replacement")).toEqual({ value: 60, basis: reading("cex", "sell"), source: "cex" });
  });

  it("falls through when every sell is out of stock, exactly as when none exists", () => {
    const outOfStock = [
      p({ kind: "sell", priceUsd: 240, available: false }),
      p({ kind: "sell", condition: "unknown", priceUsd: 200, available: false }),
    ];
    const withMedian = [...outOfStock, median(30, 9)];
    expect(value(withMedian, "replacement")).toEqual(value([median(30, 9)], "replacement"));
    expect(value(withMedian, "replacement")).toEqual({ value: 30, basis: reading("ebay_uk", "active_median"), source: "ebay_uk" });
    expect(value(outOfStock, "replacement")).toBeNull();
  });

  it("keeps out-of-stock bids for trade-in: CeX still buys a box it has none of", () => {
    expect(value([p({ kind: "voucher", priceUsd: 20, available: false })], "trade_in")).toEqual({
      value: 20, basis: reading("cex", "voucher"), source: "cex",
    });
  });
});

describe("estimateCopyValue — regions never mix", () => {
  it("a concrete other region never values the copy, under any basis", () => {
    const ntscJ = [
      p({ kind: "sell", region: "NTSC_J", priceUsd: 20 }),
      p({ kind: "voucher", region: "NTSC_J", priceUsd: 10 }),
      median(15, 9, { region: "NTSC_J" }),
    ];
    for (const basis of ["market", "trade_in", "replacement"] as const) {
      expect(value(ntscJ, basis)).toBeNull();
    }
  });

  it("undeclared-region points reach a concrete-region copy ONLY through the labelled market rung", () => {
    const unknownRegion = [
      p({ kind: "sell", region: "unknown", priceUsd: 20 }),
      p({ kind: "voucher", region: "unknown", priceUsd: 10 }),
      median(15, 9, { region: "unknown" }),
    ];
    // sells and bids of undeclared region are not this copy's sells and bids
    expect(value(unknownRegion, "trade_in")).toEqual({ value: 15, basis: reading("ebay_uk", "active_median", { viaUnknownRegion: true }), source: "ebay_uk" });
    expect(value(unknownRegion, "replacement")).toEqual({ value: 15, basis: reading("ebay_uk", "active_median", { viaUnknownRegion: true }), source: "ebay_uk" });
    expect(value(unknownRegion, "market")).toEqual({ value: 15, basis: reading("ebay_uk", "active_median", { viaUnknownRegion: true }), source: "ebay_uk" });
  });

  it("a copy of undeclared region reads undeclared-region points as its own", () => {
    const copy = { region: "unknown" as const };
    expect(value([p({ kind: "sell", region: "unknown", priceUsd: 20 })], "replacement", copy)).toEqual({
      value: 20, basis: reading("cex", "sell"), source: "cex",
    });
    expect(value([median(15, 9, { region: "unknown" })], "market", copy)).toEqual({
      value: 15, basis: reading("ebay_uk", "active_median"), source: "ebay_uk",
    });
    // and never a concrete region's points
    expect(value([p({ kind: "sell", region: "PAL", priceUsd: 20 })], "replacement", copy)).toBeNull();
  });
});

describe("estimateCopyValue — the markets gate (Settings -> Valuation markets)", () => {
  // the same copy priced in three countries: a UK shop, a Spanish shop and a
  // German marketplace. Which of them may say what the copy is worth is the
  // owner's setting, not the app's assumption.
  const abroad: PricePointDto[] = [
    p({ source: "cex", kind: "sell", priceUsd: 40, available: true }),
    p({ source: "cex_es", kind: "sell", priceUsd: 25, available: true }),
    p({ source: "cex_es", kind: "voucher", priceUsd: 30 }),
    p({ source: "ebay_de", kind: "active_median", priceUsd: 33, sampleSize: 9 }),
  ];
  const valueIn = (markets: ValuationMarkets, basis: ValuationBasis, points = abroad) =>
    estimateCopyValue(points, palCib, basis, {
      minSample: MIN_SAMPLE,
      markets,
      sources: PLUGIN_SOURCES,
    });

  it("by default only the home country's markets value a copy", () => {
    // the Spanish shop is cheaper and the German median exists, but neither is
    // where this collection is rebought or listed: every basis ends at the GB
    // shop, the only home-country reading present
    for (const basis of ["market", "trade_in", "replacement"] as const) {
      expect(valueIn(DEFAULT_VALUATION_MARKETS, basis)).toEqual({
        value: 40, basis: reading("cex", "sell"), source: "cex",
      });
    }
  });

  it("includeForeign lets any country's market value the copy, and the basis names it", () => {
    const everywhere: ValuationMarkets = { country: "GB", includeForeign: true };
    expect(valueIn(everywhere, "replacement")).toEqual({
      value: 25, basis: reading("cex_es", "sell"), source: "cex_es",
    });
    expect(valueIn(everywhere, "trade_in")).toEqual({
      value: 30, basis: reading("cex_es", "voucher"), source: "cex_es",
    });
    expect(valueIn(everywhere, "market")).toEqual({
      value: 33, basis: reading("ebay_de", "active_median"), source: "ebay_de",
    });
  });

  it("a collector in another country reads their own markets, not the UK's", () => {
    const spain: ValuationMarkets = { country: "ES", includeForeign: false };
    expect(valueIn(spain, "replacement")).toEqual({
      value: 25, basis: reading("cex_es", "sell"), source: "cex_es",
    });
    expect(valueIn(spain, "trade_in")).toEqual({
      value: 30, basis: reading("cex_es", "voucher"), source: "cex_es",
    });
  });

  it("a home country with no data at all values nothing rather than borrowing abroad", () => {
    const france: ValuationMarkets = { country: "FR", includeForeign: false };
    for (const basis of ["market", "trade_in", "replacement"] as const) {
      expect(valueIn(france, basis)).toBeNull();
    }
  });
});
