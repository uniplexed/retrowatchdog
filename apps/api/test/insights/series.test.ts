import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDb } from "../helpers/testDb.js";
import { games, pricePoints } from "../../src/db/schema.js";
import { PLUGIN_SOURCES } from "../helpers/pluginSources.js";
import { loadSeries, sliceFor } from "../../src/insights/series.js";

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}
afterAll(async () => ctx?.pool.end());

const now = new Date("2026-10-18T12:00:00Z");
const day = (n: number) => new Date(now.getTime() - n * 86_400_000);

describe.skipIf(ctx === null)("loadSeries", () => {
  let gameId: number;
  beforeEach(async () => {
    await ctx!.truncateAll();
    const [g] = await ctx!.db.insert(games).values({ title: "Dr. Mario", platform: "nes" }).returning();
    gameId = g.id;
  });
  const point = (source: string, kind: string, usd: number, at: Date, extra: Record<string, unknown> = {}) => ({
    gameId, source, kind, region: "PAL", condition: "cib", priceUsd: String(usd), priceOriginal: String(usd * 0.8),
    currencyOriginal: "GBP", fetchedAt: at, ...extra,
  });
  const load = () => loadSeries(ctx!.db, [gameId], ["ebay_uk", "cex", "ebay_de"], PLUGIN_SOURCES, 90, now);

  it("one reading per game, day and slice with the figures", async () => {
    await ctx!.db.insert(pricePoints).values([
      point("ebay_uk", "active_listing", 12, day(1)),
      point("ebay_uk", "active_listing", 10, day(1)),
      point("cex", "sell", 15, day(1)),
      point("cex", "cash", 6, day(1)),
      point("cex", "voucher", 8, day(1)),
      point("ebay_uk", "active_median", 14, day(1), { sampleSize: 9 }),
      point("ebay_uk", "active_listing", 11, day(2)),
    ]);
    const readings = sliceFor((await load()).get(gameId)!, "PAL", "cib");
    expect(readings.map((r) => r.day)).toEqual(["2026-10-16", "2026-10-17"]);
    expect(readings[1]).toMatchObject({
      cheapestUsd: 10, cheapestSource: "ebay_uk", cheapestStoreUsd: 15, bestBidUsd: 8, bestBidSource: "cex", referenceUsd: 14,
    });
    expect(readings[1].cheapestOriginal).toEqual({ amount: 8, currency: "GBP" });
  });

  it("ignores out-of-stock store boxes and zero prices", async () => {
    await ctx!.db.insert(pricePoints).values([
      point("cex", "sell", 15, day(1), { available: false }),
      point("ebay_uk", "active_listing", 0, day(1)),
      point("ebay_uk", "active_listing", 20, day(1)),
    ]);
    const [r] = sliceFor((await load()).get(gameId)!, "PAL", "cib");
    expect(r).toMatchObject({ cheapestUsd: 20, cheapestStoreUsd: null });
  });

  it("sliceFor unions the any dimension", async () => {
    await ctx!.db.insert(pricePoints).values([
      point("ebay_uk", "active_listing", 30, day(1)),
      point("ebay_uk", "active_listing", 9, day(1), { condition: "loose" }),
      point("cex", "cash", 4, day(1), { condition: "loose" }),
    ]);
    const s = (await load()).get(gameId)!;
    expect(sliceFor(s, "PAL", null)[0]).toMatchObject({ cheapestUsd: 9, bestBidUsd: 4 });
    expect(sliceFor(s, "PAL", "cib")[0]).toMatchObject({ cheapestUsd: 30, bestBidUsd: null });
    expect(sliceFor(s, "NTSC_U", null)).toEqual([]);
  });

  it("original kept only when one currency", async () => {
    await ctx!.db.insert(pricePoints).values([
      point("ebay_uk", "active_listing", 10, day(1)),
      point("ebay_de", "active_listing", 11, day(1), { currencyOriginal: "EUR" }),
    ]);
    const [r] = sliceFor((await load()).get(gameId)!, "PAL", "cib");
    // the cheapest group is ebay_uk alone: one currency, original kept
    expect(r.cheapestOriginal).toEqual({ amount: 8, currency: "GBP" });
    expect(r.cheapestSource).toBe("ebay_uk");
  });
});
