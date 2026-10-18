import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { setupTestDb } from "../helpers/testDb.js";
import { buildApp } from "../../src/app.js";
import { acquisitions, collectionValueDaily, games, ownedCopies } from "../../src/db/schema.js";
import { stubAdapter } from "../helpers/stubAdapter.js";

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}

describe.skipIf(ctx === null)("collection totals", () => {
  beforeEach(async () => ctx!.truncateAll());
  afterAll(async () => ctx?.pool.end());
  const app = async () => buildApp({ db: ctx!.db, registry: [stubAdapter()] });

  const seedGame = async () => {
    const [g] = await ctx!.db.insert(games).values({ title: "Super Metroid", platform: "snes" }).returning();
    return g.id;
  };

  it("excludes sold/returned from totals and sums realized P&L over the frozen USD legs", async () => {
    const gid = await seedGame();
    const usdLeg = (n: string) => ({ acquiredPriceOriginal: n, acquiredCurrency: "USD", acquiredPriceUsd: n });
    await ctx!.db.insert(ownedCopies).values([
      { gameId: gid, region: "PAL", condition: "cib", ...usdLeg("20.00") },
      {
        gameId: gid, region: "PAL", condition: "loose", ...usdLeg("10.00"), status: "sold", soldAt: "2026-08-30",
        soldPriceOriginal: "40.00", soldFeesOriginal: "2.00", soldCurrency: "USD",
        soldPriceUsd: "40.00", soldFeesUsd: "2.00",
      },
      {
        gameId: gid, region: "PAL", condition: "loose", ...usdLeg("5.00"), status: "returned",
        returnedAt: "2026-08-29", refundOriginal: "5.00", refundUsd: "5.00",
      },
    ]);
    const a = await app();
    const body = (await a.inject({ method: "GET", url: "/api/collection" })).json();
    expect(body.totalPaidUsd).toBe(20);         // active row only
    expect(body.totalRealizedUsd).toBe(28);     // 40 - 2 - 10 (all frozen USD)
    expect(body.totalReturnedUsd).toBe(0);      // refund 5 on a 5 purchase returned unsold
    expect(body.items).toHaveLength(3);         // sold/returned stay listed with status
    await a.close();
  });

  it("counts a lot once in totalPaidUsd while any member is active", async () => {
    const gid = await seedGame();
    const a = await app();
    const acq = (
      await a.inject({
        method: "POST", url: "/api/acquisitions",
        // USD lot: rate 1 by definition, no FX call involved
        payload: { totalPriceOriginal: 40, totalCurrency: "USD", source: "car_boot" },
      })
    ).json() as { id: number };
    await ctx!.db.insert(ownedCopies).values([
      { gameId: gid, region: "PAL", condition: "loose", acquisitionId: acq.id },
      { gameId: gid, region: "PAL", condition: "loose", acquisitionId: acq.id },
      { gameId: gid, region: "PAL", condition: "cib", acquiredPriceOriginal: "15.00", acquiredCurrency: "USD", acquiredPriceUsd: "15.00" },
    ]);
    const body = (await a.inject({ method: "GET", url: "/api/collection" })).json();
    expect(body.totalPaidUsd).toBe(55); // 40 (lot, once) + 15 (single)
    await a.close();
  });

  it("moves a lot's cost from paid to realized once none of its copies is active", async () => {
    const gid = await seedGame();
    const a = await app();
    const acq = (
      await a.inject({
        method: "POST", url: "/api/acquisitions",
        payload: { totalPriceOriginal: 40, totalCurrency: "USD", source: "car_boot" },
      })
    ).json() as { id: number };
    const sold = (price: string) => ({
      status: "sold", soldAt: "2026-08-30", soldPriceOriginal: price, soldCurrency: "USD", soldPriceUsd: price,
    });
    const [, second] = await ctx!.db.insert(ownedCopies).values([
      { gameId: gid, region: "PAL", condition: "loose", acquisitionId: acq.id, ...sold("30.00") },
      { gameId: gid, region: "PAL", condition: "loose", acquisitionId: acq.id },
    ]).returning();
    const totals = async () => (await a.inject({ method: "GET", url: "/api/collection" })).json();

    // lot still open: its cost is paid, the sale alone is realized
    let body = await totals();
    expect(body.totalPaidUsd).toBe(40);
    expect(body.totalRealizedUsd).toBe(30);

    // last copy sold: the lot closes and its 40 is netted once
    await ctx!.db.update(ownedCopies).set(sold("25.00")).where(eq(ownedCopies.id, second.id));
    body = await totals();
    expect(body.totalPaidUsd).toBe(0);
    expect(body.totalRealizedUsd).toBe(15); // 30 + 25 - 40
    await a.close();
  });

  it("reports returns apart from sales, for a sale sent back and a purchase returned unsold", async () => {
    const gid = await seedGame();
    await ctx!.db.insert(ownedCopies).values([
      { // buyer sent it back: 50 sale - 5 fees - 50 refund - 8 postage = -13
        gameId: gid, region: "PAL", condition: "cib", status: "returned",
        acquiredPriceOriginal: "20.00", acquiredCurrency: "USD", acquiredPriceUsd: "20.00",
        soldAt: "2026-08-01", soldPriceOriginal: "50.00", soldFeesOriginal: "5.00", soldCurrency: "USD",
        soldPriceUsd: "50.00", soldFeesUsd: "5.00",
        returnedAt: "2026-08-10", refundOriginal: "50.00", returnCostsOriginal: "8.00",
        refundUsd: "50.00", returnCostsUsd: "8.00",
      },
      { // sent back to the seller: 12 refund - 3 postage - 15 paid = -6
        gameId: gid, region: "PAL", condition: "loose", status: "returned",
        acquiredPriceOriginal: "15.00", acquiredCurrency: "USD", acquiredPriceUsd: "15.00",
        returnedAt: "2026-08-12", refundOriginal: "12.00", returnCostsOriginal: "3.00",
        refundUsd: "12.00", returnCostsUsd: "3.00",
      },
    ]);
    const a = await app();
    const body = (await a.inject({ method: "GET", url: "/api/collection" })).json();
    expect(body.totalReturnedUsd).toBe(-19);
    expect(body.totalRealizedUsd).toBe(0);
    await a.close();
  });

  it("records the day's totals per basis and markets, and serves them as history", async () => {
    const gid = await seedGame();
    await ctx!.db.insert(ownedCopies).values({
      gameId: gid, region: "PAL", condition: "cib",
      acquiredPriceOriginal: "20.00", acquiredCurrency: "USD", acquiredPriceUsd: "20.00",
    });
    // an older day, written as a past computation would have
    await ctx!.db.insert(collectionValueDaily).values({
      day: "2020-01-01", basis: "market", country: "GB", includeForeign: false, estimatedUsd: "1.00", paidUsd: "1.00",
    });
    const a = await app();
    await a.inject({ method: "GET", url: "/api/collection" });
    await a.inject({ method: "GET", url: "/api/collection" }); // same day: one row, updated
    await a.inject({ method: "GET", url: "/api/collection?valuation=trade_in" });

    const today = new Date().toISOString().slice(0, 10);
    const res = await a.inject({ method: "GET", url: "/api/collection/history?days=30" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.valuationBasis).toBe("market");
    expect(body.to).toBe(today);
    // the 2020 row is outside the window; trade_in has its own line
    expect(body.points).toEqual([{ day: today, estimatedUsd: 0, paidUsd: 20 }]);
    const tradeIn = (await a.inject({ method: "GET", url: "/api/collection/history?valuation=trade_in" })).json();
    expect(tradeIn.points).toHaveLength(1);
    expect((await a.inject({ method: "GET", url: "/api/collection/history?days=0" })).statusCode).toBe(400);
    await a.close();
  });

  it("values counterfeit and faulty copies as excluded bases", async () => {
    const gid = await seedGame();
    await ctx!.db.insert(ownedCopies).values([
      { gameId: gid, region: "PAL", condition: "cib", authenticity: "counterfeit" },
      { gameId: gid, region: "PAL", condition: "cib", workingState: "faulty" },
    ]);
    const a = await app();
    const body = (await a.inject({ method: "GET", url: "/api/collection" })).json();
    // sort by the reason: a bare .sort() over objects compares them as
    // "[object Object]" and leaves the database's row order in place
    const bases = body.items
      .map((i: { valueBasis: { readAs: string; reason?: string } | null }) => i.valueBasis)
      .sort((x: { reason?: string }, y: { reason?: string }) => (x.reason ?? "").localeCompare(y.reason ?? ""));
    expect(bases).toEqual([{ readAs: "excluded", reason: "counterfeit" }, { readAs: "excluded", reason: "faulty" }]);
    expect(body.items.every((i: { estimatedValueUsd: number | null }) => i.estimatedValueUsd === null)).toBe(true);
    await a.close();
  });
});
