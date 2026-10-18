import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { InsightsResponse } from "@retrowatchdog/shared";
import { setupTestDb } from "../helpers/testDb.js";
import { buildApp } from "../../src/app.js";
import { games, ownedCopies, pricePoints, watchlist } from "../../src/db/schema.js";
import { stubAdapter } from "../helpers/stubAdapter.js";
import { seedEbayPlugin } from "../helpers/seedEbayPlugin.js";
import { seedCexPlugin } from "../helpers/seedCexPlugin.js";
import { clearSignalConfigCacheForTests, defaultSignalConfig, saveSignalConfig } from "../../src/settings/signals.js";
import { clearInsightsCache } from "../../src/routes/insights.js";

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}
afterAll(async () => ctx?.pool.end());

const DAY = 86_400_000;
const ago = (n: number) => new Date(Date.now() - n * DAY - 60_000);

describe.skipIf(ctx === null)("GET /api/insights", () => {
  let shenmue: number;
  let mario: number;
  beforeEach(async () => {
    await ctx!.truncateAll();
    clearSignalConfigCacheForTests();
    clearInsightsCache();
    await seedCexPlugin(ctx!.db);
    await seedEbayPlugin(ctx!.db);
    [{ id: shenmue }, { id: mario }] = await ctx!.db
      .insert(games)
      .values([
        { title: "Shenmue", platform: "dreamcast" },
        { title: "Mario Kart", platform: "gba" },
      ])
      .returning({ id: games.id });
    const points = [];
    for (let i = 0; i < 60; i += 1) {
      // CeX pays £24 for 59 days and £38 today: the 60-day high
      const bid = i === 0 ? 38 : 24;
      points.push({ gameId: shenmue, source: "cex", region: "PAL", condition: "cib", kind: "cash", priceUsd: String(bid * 1.25), priceOriginal: String(bid), currencyOriginal: "GBP", fetchedAt: ago(i) });
      // eBay asks £32 for 59 days and £16 today: the low
      const ask = i === 0 ? 16 : 32;
      points.push({ gameId: mario, source: "ebay_uk", region: "PAL", condition: "loose", kind: "active_listing", priceUsd: String(ask * 1.25), priceOriginal: String(ask), currencyOriginal: "GBP", fetchedAt: ago(i) });
    }
    await ctx!.db.insert(pricePoints).values(points);
    await ctx!.db.insert(ownedCopies).values({ gameId: shenmue, region: "PAL", condition: "cib", acquiredPriceOriginal: "18", acquiredCurrency: "GBP", acquiredPriceUsd: "22.50" });
  });

  const app = () => buildApp({ db: ctx!.db, registry: [stubAdapter({ source: "cex" }), stubAdapter({ source: "ebay_uk" })] });
  const get = async (a: Awaited<ReturnType<typeof app>>) => (await a.inject({ method: "GET", url: "/api/insights" })).json() as InsightsResponse;

  it("composes recommendations from stored prices end to end", async () => {
    await ctx!.db.insert(watchlist).values({ gameId: mario, region: "PAL", condition: "loose" });
    const a = await app();
    const body = await get(a);
    await a.close();
    expect(body.recommendations.map((r) => r.action).slice(0, 2)).toEqual(["sell_now", "buy_now"]);
    expect(body.recommendations[0]).toMatchObject({ title: "Sell Shenmue to CeX UK for £38", gainUsd: 25 });
    expect(body.recommendations[1].title).toBe("Buy Mario Kart on eBay UK for £16");
    expect(body.recommendations[1].gainUsd).toBeGreaterThan(0);
    expect(body.measuredSince).toBeNull();
    expect(Array.isArray(body.reliability)).toBe(true);
  });

  it("one recommendation per subject", async () => {
    // a £50 target sits over every price: lower_target fires too, buy_now wins
    await ctx!.db.insert(watchlist).values({ gameId: mario, region: "PAL", condition: "loose", targetPriceOriginal: "50", targetCurrency: "GBP", targetPriceUsd: "62.50" });
    const a = await app();
    const body = await get(a);
    await a.close();
    const watchRows = body.recommendations.filter((r) => r.subject.kind === "watch");
    expect(watchRows.map((r) => r.action)).toEqual(["buy_now"]);
  });

  it("one series load per game, not per rule", async () => {
    await ctx!.db.insert(watchlist).values({ gameId: mario, region: "PAL", condition: "loose" });
    const a = await app();
    const spy = vi.spyOn(ctx!.pool, "query");
    await get(a);
    const texts = spy.mock.calls.map(([q]) => (typeof q === "string" ? q : (q as { text: string }).text));
    spy.mockRestore();
    await a.close();
    expect(texts.filter((t) => t.includes("at time zone 'UTC')::date")).length).toBe(1);
  });

  it("cache answers the same body for 60 s and a config save clears it", async () => {
    const a = await app();
    const first = await get(a);
    await ctx!.db.insert(watchlist).values({ gameId: mario, region: "PAL", condition: "loose" });
    expect(await get(a)).toEqual(first);
    await saveSignalConfig(ctx!.db, defaultSignalConfig());
    const after = await get(a);
    await a.close();
    expect(after.recommendations.some((r) => r.action === "buy_now")).toBe(true);
  });

  it("a write through the API clears the cache", async () => {
    const a = await app();
    expect((await get(a)).recommendations.some((r) => r.action === "buy_now")).toBe(false);
    const res = await a.inject({ method: "POST", url: "/api/watchlist", payload: { gameId: mario, region: "PAL", condition: "loose" } });
    expect(res.statusCode).toBeLessThan(300);
    const after = await get(a);
    await a.close();
    expect(after.recommendations.some((r) => r.action === "buy_now")).toBe(true);
  });
});
