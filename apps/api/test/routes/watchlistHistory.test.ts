import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { SparklinesResponse, WatchlistHistoryResponse } from "@retrowatchdog/shared";
import { setupTestDb } from "../helpers/testDb.js";
import { buildApp } from "../../src/app.js";
import { games, ownedCopies, pricePoints, watchlist } from "../../src/db/schema.js";
import { stubAdapter } from "../helpers/stubAdapter.js";
import { seedEbayPlugin } from "../helpers/seedEbayPlugin.js";
import { seedCexPlugin } from "../helpers/seedCexPlugin.js";
import { clearInsightsCache } from "../../src/routes/insights.js";

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}
afterAll(async () => ctx?.pool.end());

const DAY = 86_400_000;
const at = (n: number) => new Date(Date.now() - n * DAY - 60_000);
const day = (n: number) => at(n).toISOString().slice(0, 10);

describe.skipIf(ctx === null)("watchlist history and sparklines", () => {
  let a: number;
  let b: number;
  beforeEach(async () => {
    await ctx!.truncateAll();
    clearInsightsCache();
    await seedCexPlugin(ctx!.db);
    await seedEbayPlugin(ctx!.db);
    [{ id: a }, { id: b }] = await ctx!.db.insert(games).values([{ title: "A", platform: "gba" }, { title: "B", platform: "gba" }]).returning({ id: games.id });
    const p = (gameId: number, source: string, kind: string, usd: number, n: number) => ({
      gameId, source, kind, region: "PAL", condition: "cib", priceUsd: String(usd), priceOriginal: String(usd), currencyOriginal: "GBP", fetchedAt: at(n),
    });
    await ctx!.db.insert(pricePoints).values([
      p(a, "ebay_uk", "active_listing", 10, 2), p(a, "ebay_uk", "active_listing", 12, 1), p(a, "ebay_uk", "active_listing", 9, 1),
      p(b, "ebay_uk", "active_listing", 20, 1),
      p(a, "cex", "cash", 5, 1), p(a, "cex", "sell", 15, 1),
    ]);
  });
  const app = () => buildApp({ db: ctx!.db, registry: [stubAdapter({ source: "cex" }), stubAdapter({ source: "ebay_uk" })] });

  it("watchlist history sums the cheapest price per watch per day with coverage", async () => {
    await ctx!.db.insert(watchlist).values([{ gameId: a, region: "PAL", condition: "cib" }, { gameId: b }]);
    const s = await app();
    const body = (await s.inject({ method: "GET", url: "/api/watchlist/history?days=7" })).json() as WatchlistHistoryResponse;
    await s.close();
    expect(body.days).toBe(7);
    expect(body.points).toEqual([
      { day: day(2), totalUsd: 10, covered: 1, of: 2 },
      { day: day(1), totalUsd: 29, covered: 2, of: 2 },
    ]);
  });

  it("sparklines: one series per id, by basis for copies", async () => {
    const [w] = await ctx!.db.insert(watchlist).values({ gameId: a, region: "PAL", condition: "cib" }).returning();
    const [c] = await ctx!.db.insert(ownedCopies).values({ gameId: a, region: "PAL", condition: "cib" }).returning();
    const s = await app();
    const watch = (await s.inject({ method: "GET", url: "/api/watchlist/sparklines?days=7" })).json() as SparklinesResponse;
    const market = (await s.inject({ method: "GET", url: "/api/collection/sparklines?days=7" })).json() as SparklinesResponse;
    const trade = (await s.inject({ method: "GET", url: "/api/collection/sparklines?days=7&valuation=trade_in" })).json() as SparklinesResponse;
    const repl = (await s.inject({ method: "GET", url: "/api/collection/sparklines?days=7&valuation=replacement" })).json() as SparklinesResponse;
    await s.close();
    expect(watch.series[w.id]).toEqual([{ day: day(2), usd: 10 }, { day: day(1), usd: 9 }]);
    expect(market.series[c.id]).toEqual([{ day: day(2), usd: 10 }, { day: day(1), usd: 9 }]);
    expect(trade.series[c.id]).toEqual([{ day: day(1), usd: 5 }]);
    expect(repl.series[c.id]).toEqual([{ day: day(1), usd: 15 }]);
  });

  it("days out of range is a 400", async () => {
    const s = await app();
    for (const url of ["/api/watchlist/history?days=0", "/api/watchlist/sparklines?days=400", "/api/collection/sparklines?days=x"]) {
      expect((await s.inject({ method: "GET", url })).statusCode).toBe(400);
    }
    await s.close();
  });
});
