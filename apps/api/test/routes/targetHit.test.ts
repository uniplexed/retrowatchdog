import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { PricesResponse, WatchlistResponse } from "@retrowatchdog/shared";
import { setupTestDb } from "../helpers/testDb.js";
import { buildApp } from "../../src/app.js";
import { games, pricePoints, watchlist } from "../../src/db/schema.js";
import { stubAdapter } from "../helpers/stubAdapter.js";
import { seedEbayPlugin } from "../helpers/seedEbayPlugin.js";
import { seedCexPlugin } from "../helpers/seedCexPlugin.js";
import { clearSignalConfigCacheForTests } from "../../src/settings/signals.js";

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}

/**
 * A watch's buy target end to end: the game page and the watchlist must agree,
 * and a target set on one condition never fires for another.
 */
describe.skipIf(ctx === null)("TARGET_HIT through the routes", () => {
  let gameId: number;

  beforeEach(async () => {
    clearSignalConfigCacheForTests();
    await ctx!.truncateAll();
    await seedCexPlugin(ctx!.db);
    await seedEbayPlugin(ctx!.db);
    // cached_only: the route reads what is stored and never fetches
    const [g] = await ctx!.db
      .insert(games)
      .values({ title: "Final Fantasy Tactics Advance", platform: "gba", priceMode: "cached_only" })
      .returning();
    gameId = g.id;
    const fetchedAt = new Date();
    const listing = (usd: number, condition: string, id: string) => ({
      gameId, source: "ebay_uk", region: "PAL", condition, kind: "active_listing",
      priceUsd: String(usd), priceOriginal: String(usd), currencyOriginal: "GBP", fetchedAt,
      sourceUrl: `https://ebay.example/${id}`, listingTitle: `FFTA ${condition}`,
    });
    await ctx!.db.insert(pricePoints).values([listing(12, "loose", "cart"), listing(28, "cib", "complete")]);
    // a complete-in-box watch with a £30 target
    await ctx!.db.insert(watchlist).values({
      gameId, region: "PAL", condition: "cib", targetPriceOriginal: "30.00", targetCurrency: "GBP", targetPriceUsd: "30.00",
    });
  });
  afterAll(async () => ctx?.pool.end());

  const app = () => buildApp({ db: ctx!.db, registry: [stubAdapter(), stubAdapter({ source: "ebay_uk" })] });

  it("the game page fires for the complete copy only, never for the cheaper cart", async () => {
    const a = await app();
    const body = (await a.inject({ method: "GET", url: `/api/games/${gameId}/prices` })).json() as PricesResponse;
    const hits = body.signals.filter((s) => s.type === "TARGET_HIT");
    expect(hits.map((h) => h.url)).toEqual(["https://ebay.example/complete"]);
    await a.close();
  });

  it("the watchlist row agrees", async () => {
    const a = await app();
    const body = (await a.inject({ method: "GET", url: "/api/watchlist" })).json() as WatchlistResponse;
    const hits = body.items[0].signals.filter((s) => s.type === "TARGET_HIT");
    expect(hits.map((h) => h.url)).toEqual(["https://ebay.example/complete"]);
    await a.close();
  });
});
