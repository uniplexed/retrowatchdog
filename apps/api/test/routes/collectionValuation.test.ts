import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDb } from "../helpers/testDb.js";
import { buildApp } from "../../src/app.js";
import { games, ownedCopies, pricePoints } from "../../src/db/schema.js";
import { stubAdapter } from "../helpers/stubAdapter.js";
import { seedEbayPlugin } from "../helpers/seedEbayPlugin.js";
import type { CollectionResponse, OwnedCopyDto } from "@retrowatchdog/shared";
import { PROFIT_FEE_CAVEAT } from "@retrowatchdog/shared";
import { seedCexPlugin } from "../helpers/seedCexPlugin.js";

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}

describe.skipIf(ctx === null)("GET /api/collection?valuation=", () => {
  beforeEach(async () => {
    await ctx!.truncateAll();
    // CeX's three shops reach the registry only through an approved plugin row.
    await seedCexPlugin(ctx!.db);
    // eBay's markets reach the registry only through an approved plugin row.
    await seedEbayPlugin(ctx!.db);
  });
  afterAll(async () => ctx?.pool.end());

  const app = async () =>
    buildApp({
      db: ctx!.db,
      registry: [stubAdapter({ source: "cex" }), stubAdapter({ source: "ebay_uk" })],
    });

  // distinct batch times per source so valueFetchedAt can be traced to the point used
  const cexAt = new Date("2026-09-01T10:00:00Z");
  const ebayAt = new Date("2026-09-02T10:00:00Z");

  /**
   * Two owned copies of one game (PAL cib, PAL loose) over the measured
   * shape of the data: for cib CeX sells 60 / pays 40 voucher, 25 cash, and
   * eBay's median is 30 over 8 listings (a real market); for loose CeX sells
   * 5 / pays 1.50 voucher, 0.70 cash, and the eBay median (10) rests on 3
   * listings — under the sample floor, so NOT a market value.
   */
  const seed = async (): Promise<number> => {
    const [g] = await ctx!.db
      .insert(games)
      .values({ title: "Blades of Steel", platform: "nes" })
      .returning({ id: games.id });
    const gameId = g.id;
    const cex = (condition: string, kind: string, price: string, available: boolean | null = true) => ({
      gameId, source: "cex", region: "PAL", condition, kind,
      priceUsd: price, priceOriginal: price, currencyOriginal: "GBP", available, fetchedAt: cexAt,
    });
    const ebay = (condition: string, price: string, sampleSize: number) => ({
      gameId, source: "ebay_uk", region: "PAL", condition, kind: "active_median",
      priceUsd: price, priceOriginal: price, currencyOriginal: "GBP", sampleSize, fetchedAt: ebayAt,
    });
    await ctx!.db.insert(pricePoints).values([
      cex("cib", "sell", "60.00"),
      cex("cib", "voucher", "40.00", null),
      cex("cib", "cash", "25.00", null),
      ebay("cib", "30.00", 8),
      cex("loose", "sell", "5.00"),
      cex("loose", "voucher", "1.50", null),
      cex("loose", "cash", "0.70", null),
      ebay("loose", "10.00", 3),
    ]);
    await ctx!.db.insert(ownedCopies).values([
      { gameId, region: "PAL", condition: "cib" },
      { gameId, region: "PAL", condition: "loose" },
    ]);
    return gameId;
  };

  const get = async (url: string) => {
    const a = await app();
    const res = await a.inject({ method: "GET", url });
    await a.close();
    return res;
  };
  const byCondition = (body: CollectionResponse): Map<string, OwnedCopyDto> =>
    new Map(body.items.map((i) => [i.condition, i]));

  it("echoes the markets it valued under, so a total can be attributed to a country", async () => {
    await seed();
    // omitted -> the API's own defaults, and the response says so rather than
    // leaving a GB-only total to be read as an all-markets one
    const plain = (await get("/api/collection")).json() as CollectionResponse;
    expect(plain.valuationMarkets).toEqual({ country: "GB", includeForeign: false });
    const asked = (await get("/api/collection?country=ES&includeForeign=true")).json() as CollectionResponse;
    expect(asked.valuationMarkets).toEqual({ country: "ES", includeForeign: true });
  });

  it("defaults to market and echoes it; a thin median falls through to trade-in, labelled", async () => {
    await seed();
    const body = (await get("/api/collection")).json() as CollectionResponse;
    expect(body.valuationBasis).toBe("market");
    const items = byCondition(body);
    expect(items.get("cib")).toMatchObject({ estimatedValueUsd: 30, valueBasis: { readAs: "reading", source: "ebay_uk", priceKind: "active_median", viaUnknownCondition: false, viaUnknownRegion: false } });
    // 3 listings are not a market: the loose copy's value is honestly the voucher
    expect(items.get("loose")).toMatchObject({ estimatedValueUsd: 1.5, valueBasis: { readAs: "reading", source: "cex", priceKind: "voucher", viaUnknownCondition: false, viaUnknownRegion: false } });
    expect(body.totalEstimatedUsd).toBe(31.5);
  });

  it("?valuation=trade_in values every copy at its best bid and totals accordingly", async () => {
    await seed();
    const body = (await get("/api/collection?valuation=trade_in")).json() as CollectionResponse;
    expect(body.valuationBasis).toBe("trade_in");
    const items = byCondition(body);
    expect(items.get("cib")).toMatchObject({ estimatedValueUsd: 40, valueBasis: { readAs: "reading", source: "cex", priceKind: "voucher", viaUnknownCondition: false, viaUnknownRegion: false } });
    expect(items.get("loose")).toMatchObject({ estimatedValueUsd: 1.5, valueBasis: { readAs: "reading", source: "cex", priceKind: "voucher", viaUnknownCondition: false, viaUnknownRegion: false } });
    expect(body.totalEstimatedUsd).toBe(41.5);
  });

  it("?valuation=replacement values every copy at the cheapest in-stock sell (the old default)", async () => {
    await seed();
    const body = (await get("/api/collection?valuation=replacement")).json() as CollectionResponse;
    expect(body.valuationBasis).toBe("replacement");
    const items = byCondition(body);
    expect(items.get("cib")).toMatchObject({ estimatedValueUsd: 60, valueBasis: { readAs: "reading", source: "cex", priceKind: "sell", viaUnknownCondition: false, viaUnknownRegion: false } });
    expect(items.get("loose")).toMatchObject({ estimatedValueUsd: 5, valueBasis: { readAs: "reading", source: "cex", priceKind: "sell", viaUnknownCondition: false, viaUnknownRegion: false } });
    expect(body.totalEstimatedUsd).toBe(65);
  });

  it("?valuation=market is the explicit form of the default", async () => {
    await seed();
    const explicit = (await get("/api/collection?valuation=market")).json() as CollectionResponse;
    const implicit = (await get("/api/collection")).json() as CollectionResponse;
    expect(explicit).toEqual(implicit);
  });

  it("400s an unknown basis with an {error} body", async () => {
    await seed();
    const res = await get("/api/collection?valuation=guide");
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: expect.stringContaining("valuation") });
  });

  it("valueFetchedAt follows the source of the point actually used", async () => {
    await seed();
    const market = byCondition((await get("/api/collection?valuation=market")).json() as CollectionResponse);
    expect(market.get("cib")?.valueFetchedAt).toBe(ebayAt.toISOString());
    // the loose copy's market value came from CeX (voucher fallback), so its freshness is CeX's
    expect(market.get("loose")?.valueFetchedAt).toBe(cexAt.toISOString());
    const replacement = byCondition((await get("/api/collection?valuation=replacement")).json() as CollectionResponse);
    expect(replacement.get("cib")?.valueFetchedAt).toBe(cexAt.toISOString());
  });

  it("per-copy signals do not depend on the basis", async () => {
    await seed();
    const signalsUnder = async (suffix: string) =>
      byCondition((await get(`/api/collection${suffix}`)).json() as CollectionResponse).get("cib")?.signals;
    const market = await signalsUnder("");
    // the seed holds a real flip (40 > 30 * 1.15) and an overpriced store (60 > 30 * 1.3)
    expect(market?.map((s) => s.type).sort()).toEqual(["FLIP", "OVERPRICED_STORE"]);
    expect(await signalsUnder("?valuation=trade_in")).toEqual(market);
    expect(await signalsUnder("?valuation=replacement")).toEqual(market);
  });

  it("every reading is grade-honest end to end: a Mint SKU (bid or sell) values only the mint copy, and the mint copy prefers it", async () => {
    // one game, ungraded voucher 80 + Mint-SKU voucher 218, ungraded sell 60
    // + Mint-SKU sell 120 (both in stock); three cib copies of grade
    // null / good / mint
    const [g] = await ctx!.db
      .insert(games)
      .values({ title: "Super Metroid", platform: "snes" })
      .returning({ id: games.id });
    const gameId = g.id;
    const cexPoint = (kind: string, price: string, grade: string | null, available: boolean | null) => ({
      gameId, source: "cex", region: "PAL", condition: "cib", kind, grade,
      priceUsd: price, priceOriginal: price, currencyOriginal: "GBP", available, fetchedAt: cexAt,
    });
    await ctx!.db.insert(pricePoints).values([
      cexPoint("voucher", "80.00", null, null),
      cexPoint("voucher", "218.00", "mint", null),
      cexPoint("sell", "60.00", null, true),
      cexPoint("sell", "120.00", "mint", true),
    ]);
    await ctx!.db.insert(ownedCopies).values([
      { gameId, region: "PAL", condition: "cib" },
      { gameId, region: "PAL", condition: "cib", itemGrade: "good" },
      { gameId, region: "PAL", condition: "cib", itemGrade: "mint" },
    ]);
    const byGrade = (body: CollectionResponse): Map<string | null, OwnedCopyDto> =>
      new Map(body.items.map((i) => [i.itemGrade, i]));

    const tradeIn = byGrade((await get("/api/collection?valuation=trade_in")).json() as CollectionResponse);
    // the same rule as the per-copy signal slice: an ungraded bid fits every
    // copy, a graded bid only a copy of that grade — never the mint premium
    // on a good or ungraded copy
    expect(tradeIn.get(null)).toMatchObject({ estimatedValueUsd: 80, valueBasis: { readAs: "reading", source: "cex", priceKind: "voucher", viaUnknownCondition: false, viaUnknownRegion: false } });
    expect(tradeIn.get("good")).toMatchObject({ estimatedValueUsd: 80, valueBasis: { readAs: "reading", source: "cex", priceKind: "voucher", viaUnknownCondition: false, viaUnknownRegion: false } });
    expect(tradeIn.get("mint")).toMatchObject({ estimatedValueUsd: 218, valueBasis: { readAs: "reading", source: "cex", priceKind: "voucher", viaUnknownCondition: false, viaUnknownRegion: false } });
    // freshness rides with the CeX point through the real DTO pipeline
    for (const item of tradeIn.values()) expect(item.valueFetchedAt).toBe(cexAt.toISOString());

    // Flipped under ruling R1 ("only value mints with mints", 2026-09-02):
    // this test used to pin "the cheapest in-stock sell values every copy
    // whatever its grade". Now the grade rule covers sells too — rebuying a
    // mint copy costs the Mint SKU's in-stock price even though the
    // ungraded SKU is cheaper, and a good/ungraded copy never sees the Mint
    // SKU
    const replacement = byGrade((await get("/api/collection?valuation=replacement")).json() as CollectionResponse);
    expect(replacement.get(null)).toMatchObject({ estimatedValueUsd: 60, valueBasis: { readAs: "reading", source: "cex", priceKind: "sell", viaUnknownCondition: false, viaUnknownRegion: false } });
    expect(replacement.get("good")).toMatchObject({ estimatedValueUsd: 60, valueBasis: { readAs: "reading", source: "cex", priceKind: "sell", viaUnknownCondition: false, viaUnknownRegion: false } });
    expect(replacement.get("mint")).toMatchObject({ estimatedValueUsd: 120, valueBasis: { readAs: "reading", source: "cex", priceKind: "sell", viaUnknownCondition: false, viaUnknownRegion: false } });
  });

  it("a market value reached through a fallback rung is labelled AND the copy barks PROFIT on it, potential with the rung caveat", async () => {
    // Flipped under ruling R2 (connector reach, 2026-09-02). This test used
    // to pin the opposite: the per-copy signal slice was exact
    // region+condition for every source, so a PAL/cib copy paid £10 whose
    // only median was an undeclared-region one showed 'market (undeclared
    // region) £30' with no 💰. eBay UK is now declared `global` — the owner
    // can sell to any geography — so that median stands in for the copy
    // through the same labelled ladder the valuation walks: potential, with
    // the rung caveat on top of the fee caveat, exactly as in the
    // prices/watchlist routes. The copy's region has NO exact points here,
    // so this also pins the synthesized region input: the copy is judged in
    // a PAL input carrying the fallback references, never inside the
    // region-"unknown" input.
    const [g] = await ctx!.db
      .insert(games)
      .values({ title: "Kirby's Dream Land", platform: "gb" })
      .returning({ id: games.id });
    const gameId = g.id;
    const median = (region: string) => ({
      gameId, source: "ebay_uk", region, condition: "cib", kind: "active_median",
      priceUsd: "30.00", priceOriginal: "30.00", currencyOriginal: "GBP", sampleSize: 8, fetchedAt: ebayAt,
    });
    const paidCopy = {
      gameId, region: "PAL", condition: "cib",
      acquiredPriceOriginal: "10.00", acquiredCurrency: "GBP", acquiredPriceUsd: "10.00",
    };
    await ctx!.db.insert(pricePoints).values(median("unknown"));
    await ctx!.db.insert(ownedCopies).values(paidCopy);
    const viaRung = ((await get("/api/collection")).json() as CollectionResponse).items[0];
    expect(viaRung).toMatchObject({ estimatedValueUsd: 30, valueBasis: { readAs: "reading", source: "ebay_uk", priceKind: "active_median", viaUnknownCondition: false, viaUnknownRegion: true } });
    const viaRungProfit = viaRung.signals.find((s) => s.type === "PROFIT");
    expect(viaRungProfit).toMatchObject({ sellSource: "ebay_uk", sellKind: "active_median", gainUsd: 16.1, confidence: "potential" });
    expect(viaRungProfit?.caveats).toEqual([PROFIT_FEE_CAVEAT, "market median from listings with undeclared region"]);
    // judged in the copy's own region: the evidence names PAL and labels the rung
    expect(viaRungProfit?.reasoning).toBe(
      "PAL/cib: eBay UK median (active) £30 (8 listings, undeclared region) → ≈£26.10 after fees vs paid £10 — sell on eBay UK",
    );
    expect(viaRung.signals.every((s) => s.reasoning.startsWith("PAL/"))).toBe(true);

    // the contrast: the same median declared PAL is exact data, and the
    // fee-netted reading (30 * 0.87 = 26.10 vs paid 10) barks with the fee
    // caveat alone — potential, as every listing-based PROFIT is
    await ctx!.truncateAll();
    // truncateAll empties `plugins` too (testDb.ts) — re-seed the eBay
    // plugin so "ebay_uk" still resolves to a role for this second scenario.
    await seedEbayPlugin(ctx!.db);
    const [g2] = await ctx!.db
      .insert(games)
      .values({ title: "Kirby's Dream Land", platform: "gb" })
      .returning({ id: games.id });
    await ctx!.db.insert(pricePoints).values({ ...median("PAL"), gameId: g2.id });
    await ctx!.db.insert(ownedCopies).values({ ...paidCopy, gameId: g2.id });
    const exact = ((await get("/api/collection")).json() as CollectionResponse).items[0];
    expect(exact).toMatchObject({ estimatedValueUsd: 30, valueBasis: { readAs: "reading", source: "ebay_uk", priceKind: "active_median", viaUnknownCondition: false, viaUnknownRegion: false } });
    const profit = exact.signals.find((s) => s.type === "PROFIT");
    expect(profit).toMatchObject({ sellSource: "ebay_uk", sellKind: "active_median", gainUsd: 16.1, confidence: "potential" });
    expect(profit?.caveats).toEqual([PROFIT_FEE_CAVEAT]);
  });

  it("excluded copies stay excluded under every basis", async () => {
    const gameId = await seed();
    await ctx!.db.insert(ownedCopies).values({ gameId, region: "PAL", condition: "cib", authenticity: "counterfeit" });
    for (const basis of ["market", "trade_in", "replacement"]) {
      const body = (await get(`/api/collection?valuation=${basis}`)).json() as CollectionResponse;
      const fake = body.items.find((i) => i.authenticity === "counterfeit");
      expect(fake).toMatchObject({ estimatedValueUsd: null, valueBasis: { readAs: "excluded", reason: "counterfeit" } });
    }
  });
});
