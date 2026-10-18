import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDb } from "../helpers/testDb.js";
import { buildApp } from "../../src/app.js";
import { games, ownedCopies, pricePoints } from "../../src/db/schema.js";
import { stubAdapter } from "../helpers/stubAdapter.js";
import { seedEbayPlugin } from "../helpers/seedEbayPlugin.js";
import type { CollectionResponse } from "@retrowatchdog/shared";
import { seedCexPlugin } from "../helpers/seedCexPlugin.js";

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}

describe.skipIf(ctx === null)("GET /api/collection per-copy signals", () => {
  beforeEach(async () => {
    await ctx!.truncateAll();
    // CeX's three shops reach the registry only through an approved plugin row.
    await seedCexPlugin(ctx!.db);
    // The stub adapter answers under "ebay_uk", whose role the signal engine
    // reads from app.deps.sources: that needs an approved plugin row.
    await seedEbayPlugin(ctx!.db);
  });
  afterAll(async () => ctx?.pool.end());

  const app = async () =>
    buildApp({
      db: ctx!.db,
      registry: [stubAdapter({ source: "cex" }), stubAdapter({ source: "ebay_uk" })],
    });

  const seedGame = async (): Promise<number> => {
    const [g] = await ctx!.db
      .insert(games)
      .values({ title: "Super Metroid", platform: "snes" })
      .returning({ id: games.id });
    return g.id;
  };

  /** PAL/cib voucher $40 vs eBay median $30 (8 listings): 40 > 30*1.15 fires the flip */
  const seedVoucherOpportunity = async (gameId: number): Promise<void> => {
    const fetchedAt = new Date();
    await ctx!.db.insert(pricePoints).values([
      { gameId, source: "cex", region: "PAL", condition: "cib", kind: "voucher", priceUsd: "40.00", priceOriginal: "40.00", currencyOriginal: "GBP", fetchedAt },
      { gameId, source: "ebay_uk", region: "PAL", condition: "cib", kind: "active_median", priceUsd: "30.00", priceOriginal: "30.00", currencyOriginal: "GBP", sampleSize: 8, fetchedAt },
    ]);
  };

  it("computes the flip signal from stored points with buySource/sellSource populated", async () => {
    const gameId = await seedGame();
    await seedVoucherOpportunity(gameId);
    await ctx!.db.insert(ownedCopies).values({ gameId, region: "PAL", condition: "cib" });

    const a = await app();
    const body = (await (await a.inject({ method: "GET", url: "/api/collection" })).json()) as CollectionResponse;
    expect(body.items).toHaveLength(1);
    const flip = body.items[0].signals.find((s) => s.type === "FLIP");
    expect(flip).toBeDefined();
    expect(flip?.buySource).toBe("ebay_uk");
    expect(flip?.sellSource).toBe("cex");
    expect(flip?.reasoning).toContain("PAL/cib");
    await a.close();
  });

  it("keys signals to each copy's own region+condition: other dimensions get none", async () => {
    const gameId = await seedGame();
    await seedVoucherOpportunity(gameId);
    await ctx!.db.insert(ownedCopies).values([
      { gameId, region: "PAL", condition: "cib" },     // matches the seeded points
      { gameId, region: "PAL", condition: "loose" },   // same region, other condition
      { gameId, region: "NTSC_J", condition: "cib" },  // other region, same condition
    ]);

    const a = await app();
    const body = (await (await a.inject({ method: "GET", url: "/api/collection" })).json()) as CollectionResponse;
    const byKey = new Map(body.items.map((i) => [`${i.region}/${i.condition}`, i]));
    expect(byKey.get("PAL/cib")?.signals.some((s) => s.type === "FLIP")).toBe(true);
    expect(byKey.get("PAL/loose")?.signals).toEqual([]);
    expect(byKey.get("NTSC_J/cib")?.signals).toEqual([]);
    await a.close();
  });

  /**
   * Grade-honesty seed: ungraded voucher $80 + Mint-SKU voucher $218 vs eBay
   * median $100 (8 listings). Flip threshold at the default 1.15 factor: $115.
   */
  const seedGradedVouchers = async (gameId: number): Promise<void> => {
    const fetchedAt = new Date();
    await ctx!.db.insert(pricePoints).values([
      { gameId, source: "cex", region: "PAL", condition: "cib", kind: "voucher", priceUsd: "80.00", priceOriginal: "80.00", currencyOriginal: "GBP", fetchedAt },
      { gameId, source: "cex", region: "PAL", condition: "cib", kind: "voucher", grade: "mint", priceUsd: "218.00", priceOriginal: "218.00", currencyOriginal: "GBP", fetchedAt },
      { gameId, source: "ebay_uk", region: "PAL", condition: "cib", kind: "active_median", priceUsd: "100.00", priceOriginal: "100.00", currencyOriginal: "GBP", sampleSize: 8, fetchedAt },
    ]);
  };

  it("excludes a Mint-SKU voucher from a non-mint copy's flip: only the $80 ungraded voucher counts, no signal", async () => {
    const gameId = await seedGame();
    await seedGradedVouchers(gameId);
    // a good copy can never obtain the Mint trade-in price, so its flip must
    // be judged on the ungraded voucher alone: $80 < $115 -> nothing fires
    await ctx!.db.insert(ownedCopies).values({ gameId, region: "PAL", condition: "cib", itemGrade: "good" });

    const a = await app();
    const body = (await (await a.inject({ method: "GET", url: "/api/collection" })).json()) as CollectionResponse;
    expect(body.items).toHaveLength(1);
    expect(body.items[0].signals).toEqual([]);
    await a.close();
  });

  it("a mint copy sees the Mint SKU (plus ungraded points): $218 > $115 fires the flip", async () => {
    const gameId = await seedGame();
    await seedGradedVouchers(gameId);
    await ctx!.db.insert(ownedCopies).values({ gameId, region: "PAL", condition: "cib", itemGrade: "mint" });

    const a = await app();
    const body = (await (await a.inject({ method: "GET", url: "/api/collection" })).json()) as CollectionResponse;
    const flip = body.items[0].signals.find((s) => s.type === "FLIP");
    expect(flip).toBeDefined();
    // the max achievable voucher is the Mint one this copy actually qualifies for
    expect(flip?.reasoning).toContain("218");
    // confidence: strict PAL/cib dims, no fallback, and the grade-honest
    // slice guarantees this mint copy IS what the Mint SKU pays for — the
    // engine's grade-asymmetry downgrade must not apply here
    expect(flip?.confidence).toBe("high");
    expect(flip?.caveats).toEqual([]);
    await a.close();
  });

  it("a candidate-basis copy forces every signal to potential with the match caveat", async () => {
    const gameId = await seedGame();
    await seedVoucherOpportunity(gameId); // fires high-confidence FLIP on its own
    await ctx!.db.insert(ownedCopies).values({
      gameId, region: "PAL", condition: "cib", matchBasis: "candidate", matchScore: 0.62,
    });

    const a = await app();
    const body = (await (await a.inject({ method: "GET", url: "/api/collection" })).json()) as CollectionResponse;
    const flip = body.items[0].signals.find((s) => s.type === "FLIP");
    expect(flip).toBeDefined();
    // the optimistic link means the signal may be about a different game
    // entirely: forced potential regardless of the engine's own verdict
    expect(flip?.confidence).toBe("potential");
    expect(flip?.caveats).toContain("match not confirmed — review the link");
    await a.close();
  });

  it("a confirmed-basis copy keeps the engine's confidence untouched", async () => {
    const gameId = await seedGame();
    await seedVoucherOpportunity(gameId);
    await ctx!.db.insert(ownedCopies).values({
      gameId, region: "PAL", condition: "cib", matchBasis: "confirmed",
    });

    const a = await app();
    const body = (await (await a.inject({ method: "GET", url: "/api/collection" })).json()) as CollectionResponse;
    const flip = body.items[0].signals.find((s) => s.type === "FLIP");
    expect(flip?.confidence).toBe("high");
    expect(flip?.caveats).toEqual([]);
    await a.close();
  });

  it("an ungraded copy with only ungraded vouchers keeps its pre-grade-rule behavior", async () => {
    const gameId = await seedGame();
    await seedVoucherOpportunity(gameId); // ungraded voucher $40 vs median $30
    await ctx!.db.insert(ownedCopies).values({ gameId, region: "PAL", condition: "cib" });

    const a = await app();
    const body = (await (await a.inject({ method: "GET", url: "/api/collection" })).json()) as CollectionResponse;
    expect(body.items[0].signals.some((s) => s.type === "FLIP")).toBe(true);
    await a.close();
  });

  it("emits no signals when the stored data holds no opportunity", async () => {
    const gameId = await seedGame();
    const fetchedAt = new Date();
    // voucher $30 vs median $30: below the 1.15 factor, nothing fires
    await ctx!.db.insert(pricePoints).values([
      { gameId, source: "cex", region: "PAL", condition: "cib", kind: "voucher", priceUsd: "30.00", priceOriginal: "30.00", currencyOriginal: "GBP", fetchedAt },
      { gameId, source: "ebay_uk", region: "PAL", condition: "cib", kind: "active_median", priceUsd: "30.00", priceOriginal: "30.00", currencyOriginal: "GBP", sampleSize: 8, fetchedAt },
    ]);
    await ctx!.db.insert(ownedCopies).values({ gameId, region: "PAL", condition: "cib" });

    const a = await app();
    const body = (await (await a.inject({ method: "GET", url: "/api/collection" })).json()) as CollectionResponse;
    expect(body.items[0].signals).toEqual([]);
    await a.close();
  });

  // Rule 5 PROFIT rides on the acquisition context only this route supplies:
  // the seeded PAL/cib copy paid £18 (rate-1 USD twin). Against
  // seedVoucherOpportunity the £40 voucher clears 18 * 1.15 = £20.70 by
  // £22, and the £30 median nets ≈£26.10 after eBay's estimated 13% fee.
  const paidCopy = (gameId: number) => ({
    gameId,
    region: "PAL",
    condition: "cib",
    acquiredPriceOriginal: "18.00",
    acquiredCurrency: "GBP",
    acquiredPriceUsd: "18.00",
  });

  it("a copy with a paid price and a stored voucher above it carries PROFIT per source, quoting £ vs £", async () => {
    const gameId = await seedGame();
    await seedVoucherOpportunity(gameId);
    await ctx!.db.insert(ownedCopies).values(paidCopy(gameId));

    const a = await app();
    const body = (await (await a.inject({ method: "GET", url: "/api/collection" })).json()) as CollectionResponse;
    const profits = body.items[0].signals.filter((s) => s.type === "PROFIT");
    expect(profits.map((p) => p.sellSource)).toEqual(["cex", "ebay_uk"]);
    // the instrument behind each gain reaches the DTO: store credit vs a netted listing median
    expect(profits.map((p) => p.sellKind)).toEqual(["voucher", "active_median"]);
    // the trade-in reading: strict dims, ungraded bid on an ungraded copy — high
    expect(profits[0].reasoning).toBe("PAL/cib: CeX UK pays voucher £40 vs paid £18 — trade in at CeX UK");
    expect(profits[0].gainUsd).toBe(22);
    expect(profits[0].confidence).toBe("high");
    expect(profits[0].caveats).toEqual([]);
    expect(profits[0].url).toBeUndefined();
    // the market reading: a listing price, netted, never more than potential
    expect(profits[1].reasoning).toBe(
      "PAL/cib: eBay UK median (active) £30 (8 listings) → ≈£26.10 after fees vs paid £18 — sell on eBay UK",
    );
    expect(profits[1].gainUsd).toBe(8.1);
    expect(profits[1].confidence).toBe("potential");
    expect(profits[1].caveats).toEqual(["listing price, not a sale; fees estimated"]);
    // the flip the same data carries is untouched
    expect(body.items[0].signals.some((s) => s.type === "FLIP")).toBe(true);
    await a.close();
  });

  it("R4: a copy whose voucher AND cash bids both beat the paid price carries one PROFIT per instrument, then the market one", async () => {
    const gameId = await seedGame();
    const fetchedAt = new Date();
    await ctx!.db.insert(pricePoints).values([
      { gameId, source: "cex", region: "PAL", condition: "cib", kind: "voucher", priceUsd: "48.00", priceOriginal: "48.00", currencyOriginal: "GBP", fetchedAt },
      { gameId, source: "cex", region: "PAL", condition: "cib", kind: "cash", priceUsd: "34.00", priceOriginal: "34.00", currencyOriginal: "GBP", fetchedAt },
      { gameId, source: "ebay_uk", region: "PAL", condition: "cib", kind: "active_median", priceUsd: "30.00", priceOriginal: "30.00", currencyOriginal: "GBP", sampleSize: 8, fetchedAt },
    ]);
    await ctx!.db.insert(ownedCopies).values(paidCopy(gameId));

    const a = await app();
    const body = (await (await a.inject({ method: "GET", url: "/api/collection" })).json()) as CollectionResponse;
    const profits = body.items[0].signals.filter((s) => s.type === "PROFIT");
    expect(profits.map((p) => [p.sellSource, p.sellKind, p.gainUsd, p.confidence])).toEqual([
      ["cex", "voucher", 30, "high"],
      ["cex", "cash", 16, "high"],
      ["ebay_uk", "active_median", 8.1, "potential"],
    ]);
    await a.close();
  });

  it("a copy without a paid price never carries PROFIT — nothing to compare, nothing invented", async () => {
    const gameId = await seedGame();
    await seedVoucherOpportunity(gameId);
    await ctx!.db.insert(ownedCopies).values({ gameId, region: "PAL", condition: "cib" });

    const a = await app();
    const body = (await (await a.inject({ method: "GET", url: "/api/collection" })).json()) as CollectionResponse;
    expect(body.items[0].signals.some((s) => s.type === "FLIP")).toBe(true);
    expect(body.items[0].signals.some((s) => s.type === "PROFIT")).toBe(false);
    await a.close();
  });

  // Ruling R2 (connector reach, 2026-09-02): the per-copy slice admits a
  // LOCAL source's points only at the copy's exact region+condition (CeX
  // prices the shelf it lists), while a GLOBAL marketplace's undeclared-
  // region/condition readings may stand in through the labelled ladder.
  it("R2: a CeX bid stored with region 'unknown' is never admitted for a PAL copy — a local store is held to exactness", async () => {
    // synthetic row: the CeX adapter always declares a region, but the
    // slice must hold a local source to exactness whatever the data says
    const gameId = await seedGame();
    const fetchedAt = new Date();
    await ctx!.db.insert(pricePoints).values([
      { gameId, source: "cex", region: "unknown", condition: "cib", kind: "voucher", priceUsd: "40.00", priceOriginal: "40.00", currencyOriginal: "GBP", fetchedAt },
      { gameId, source: "ebay_uk", region: "PAL", condition: "cib", kind: "active_median", priceUsd: "30.00", priceOriginal: "30.00", currencyOriginal: "GBP", sampleSize: 8, fetchedAt },
    ]);
    await ctx!.db.insert(ownedCopies).values(paidCopy(gameId));

    const a = await app();
    const body = (await (await a.inject({ method: "GET", url: "/api/collection" })).json()) as CollectionResponse;
    const signals = body.items[0].signals;
    // the voucher never entered the slice: no flip, no CeX profit, no CeX anywhere
    expect(signals.some((s) => s.type === "FLIP")).toBe(false);
    expect(signals.filter((s) => s.type === "PROFIT").map((s) => s.sellSource)).toEqual(["ebay_uk"]);
    expect(signals.every((s) => s.sellSource !== "cex" && !s.reasoning.includes("CeX"))).toBe(true);
    await a.close();
  });

  it("R2: an owned copy's FLIP may resolve through the eBay undeclared-region rung, as potential with the rung caveat", async () => {
    const gameId = await seedGame();
    const fetchedAt = new Date();
    await ctx!.db.insert(pricePoints).values([
      { gameId, source: "cex", region: "PAL", condition: "cib", kind: "voucher", priceUsd: "40.00", priceOriginal: "40.00", currencyOriginal: "GBP", fetchedAt },
      { gameId, source: "ebay_uk", region: "unknown", condition: "cib", kind: "active_median", priceUsd: "30.00", priceOriginal: "30.00", currencyOriginal: "GBP", sampleSize: 8, fetchedAt },
    ]);
    await ctx!.db.insert(ownedCopies).values({ gameId, region: "PAL", condition: "cib" });

    const a = await app();
    const body = (await (await a.inject({ method: "GET", url: "/api/collection" })).json()) as CollectionResponse;
    const flip = body.items[0].signals.find((s) => s.type === "FLIP");
    expect(flip).toMatchObject({ buySource: "ebay_uk", sellSource: "cex", confidence: "potential" });
    expect(flip?.caveats).toEqual(["market median from listings with undeclared region"]);
    expect(flip?.reasoning).toBe(
      "PAL/cib: CeX UK pays voucher £40 vs eBay UK median (active) £30 (8 listings, undeclared region) — buy at eBay UK, sell to CeX UK",
    );
    // judged in the copy's own region input, never inside the unknown-region one
    expect(body.items[0].signals.every((s) => s.reasoning.startsWith("PAL/"))).toBe(true);
    await a.close();
  });

  it("R2: the undeclared-CONDITION rung serves an owned copy the same way, labelled", async () => {
    const gameId = await seedGame();
    const fetchedAt = new Date();
    await ctx!.db.insert(pricePoints).values([
      { gameId, source: "cex", region: "PAL", condition: "cib", kind: "voucher", priceUsd: "40.00", priceOriginal: "40.00", currencyOriginal: "GBP", fetchedAt },
      { gameId, source: "ebay_uk", region: "PAL", condition: "unknown", kind: "active_median", priceUsd: "30.00", priceOriginal: "30.00", currencyOriginal: "GBP", sampleSize: 8, fetchedAt },
    ]);
    await ctx!.db.insert(ownedCopies).values(paidCopy(gameId));

    const a = await app();
    const body = (await (await a.inject({ method: "GET", url: "/api/collection" })).json()) as CollectionResponse;
    const flip = body.items[0].signals.find((s) => s.type === "FLIP");
    expect(flip).toMatchObject({ buySource: "ebay_uk", sellSource: "cex", confidence: "potential" });
    expect(flip?.caveats).toEqual(["market median from listings with undeclared condition"]);
    const profits = body.items[0].signals.filter((s) => s.type === "PROFIT");
    expect(profits.map((p) => [p.sellSource, p.confidence])).toEqual([["cex", "high"], ["ebay_uk", "potential"]]);
    expect(profits[1].caveats).toEqual(["listing price, not a sale; fees estimated", "market median from listings with undeclared condition"]);
    await a.close();
  });

  it("R2: an eBay listing of undeclared condition may raise a caveated UNDERPRICED on an owned copy, and is never its FLIP proxy", async () => {
    // Pins an accepted consequence of ruling R2 (review round, 2026-09-02):
    // admitsCopyPoint applies the global rule to EVERY kind, so an eBay
    // active_listing of the copy's region with condition "unknown" enters the
    // owned copy's slice as a listing and rule 1 judges it against the
    // same-region undeclared-condition median. The DTO carries that
    // UNDERPRICED honestly — potential, "listing condition not declared" —
    // and the collection surface hides 🛒 on owned copies (a web choice, not
    // the API's). The FLIP acquisition proxy stays condition-STRICT: the
    // unknown-condition listing never stands in for the cib copy, so a bid
    // that would flip against the £10 listing is judged against the median.
    const gameId = await seedGame();
    const fetchedAt = new Date();
    await ctx!.db.insert(pricePoints).values([
      // £10 listing vs £30 undeclared-condition median: 10 < 30 * 0.7 fires rule 1
      { gameId, source: "ebay_uk", region: "PAL", condition: "unknown", kind: "active_listing", priceUsd: "10.00", priceOriginal: "10.00", currencyOriginal: "GBP", sourceUrl: "https://ebay.example/item/1", listingTitle: "Super Metroid SNES", fetchedAt },
      { gameId, source: "ebay_uk", region: "PAL", condition: "unknown", kind: "active_median", priceUsd: "30.00", priceOriginal: "30.00", currencyOriginal: "GBP", sampleSize: 8, fetchedAt },
      // £20 voucher: > 10 * 1.15 (would flip on the listing) but < 30 * 1.15 (no flip on the median)
      { gameId, source: "cex", region: "PAL", condition: "cib", kind: "voucher", priceUsd: "20.00", priceOriginal: "20.00", currencyOriginal: "GBP", fetchedAt },
    ]);
    await ctx!.db.insert(ownedCopies).values({ gameId, region: "PAL", condition: "cib" });

    const a = await app();
    const body = (await (await a.inject({ method: "GET", url: "/api/collection" })).json()) as CollectionResponse;
    const signals = body.items[0].signals;
    expect(signals.map((s) => s.type)).toEqual(["UNDERPRICED"]);
    expect(signals[0]).toMatchObject({ source: "ebay_uk", url: "https://ebay.example/item/1", confidence: "potential" });
    expect(signals[0].caveats).toEqual(["listing condition not declared"]);
    expect(signals[0].reasoning).toBe(
      'PAL/unknown: "Super Metroid SNES" at £10 vs eBay UK median (active) £30 (8 listings) — bargain candidate',
    );
    await a.close();
  });

  it("a candidate-linked copy's PROFIT is forced potential with the match caveat, like every other signal", async () => {
    const gameId = await seedGame();
    await seedVoucherOpportunity(gameId);
    await ctx!.db.insert(ownedCopies).values({ ...paidCopy(gameId), matchBasis: "candidate", matchScore: 0.62 });

    const a = await app();
    const body = (await (await a.inject({ method: "GET", url: "/api/collection" })).json()) as CollectionResponse;
    const profit = body.items[0].signals.find((s) => s.type === "PROFIT" && s.sellSource === "cex");
    expect(profit).toBeDefined();
    expect(profit?.confidence).toBe("potential");
    expect(profit?.caveats).toEqual(["match not confirmed — review the link"]);
    await a.close();
  });
});
