import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDb } from "../helpers/testDb.js";
import { games, pricePoints } from "../../src/db/schema.js";
import { loadSignalHistory } from "../../src/signals/history.js";
import { defaultSignalConfig } from "../../src/settings/signals.js";
import { PLUGIN_SOURCES } from "../helpers/pluginSources.js";
import type { SignalConfig } from "../../src/signals/computeSignals.js";

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}

const cfg: SignalConfig = { ...defaultSignalConfig(), minGainUsd: null, priceDropDays: 7, risingDays: 30, newLowDays: 90 };
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

describe.skipIf(ctx === null)("loadSignalHistory", () => {
  let gameId: number;

  beforeEach(async () => {
    await ctx!.truncateAll();
    const [g] = await ctx!.db.insert(games).values({ title: "Zelda: Ocarina of Time", platform: "n64" }).returning();
    gameId = g.id;
    const point = (source: string, kind: string, usd: number, at: Date, extra: Record<string, unknown> = {}) => ({
      gameId, source, region: "PAL", condition: "cib", kind,
      priceUsd: String(usd), priceOriginal: String(usd), currencyOriginal: "GBP", fetchedAt: at, ...extra,
    });
    await ctx!.db.insert(pricePoints).values([
      // CeX sells the cib box: four batches
      point("cex", "sell", 50, daysAgo(40), { available: true }),
      point("cex", "sell", 42, daysAgo(8), { available: true }),
      point("cex", "sell", 41, daysAgo(1), { available: false }),
      point("cex", "sell", 40, daysAgo(0), { available: true }),
      // a kind CeX declares no role for: never history
      point("cex", "active_listing", 1, daysAgo(8)),
      // eBay UK: a median and a cheapest listing, three batches
      point("ebay_uk", "active_median", 30, daysAgo(40), { sampleSize: 8 }),
      point("ebay_uk", "active_listing", 25, daysAgo(40)),
      point("ebay_uk", "active_median", 33, daysAgo(8), { sampleSize: 8 }),
      point("ebay_uk", "active_listing", 22, daysAgo(8)),
      point("ebay_uk", "active_median", 36, daysAgo(0), { sampleSize: 8 }),
      point("ebay_uk", "active_listing", 28, daysAgo(0)),
      // older than every window: ignored
      point("ebay_uk", "active_listing", 5, daysAgo(200)),
    ]);
  });
  afterAll(async () => ctx?.pool.end());

  it("serves the slice as of priceDropDays ago from each source's batch at or before then", async () => {
    const pal = (await loadSignalHistory(ctx!.db, gameId, ["cex", "ebay_uk"], PLUGIN_SOURCES, cfg)).get("PAL")!;
    expect(pal.dropAgo.storeOffers.map((o) => [o.source, o.price.usd])).toEqual([["cex", 42]]);
    expect(pal.dropAgo.referenceByCondition.cib?.price.usd).toBe(33);
  });

  it("records how old each source's compared batch really is", async () => {
    const pal = (await loadSignalHistory(ctx!.db, gameId, ["cex", "ebay_uk"], PLUGIN_SOURCES, cfg)).get("PAL")!;
    expect(pal.dropAgeDays).toEqual({ cex: 8, ebay_uk: 8 });
  });

  it("finds the right batches among many refreshes without reading them all", async () => {
    // 60 extra eBay batches, one a day: the drop batch is the newest at or before 7 days ago
    const rows = Array.from({ length: 60 }, (_, i) => ({
      gameId, source: "ebay_uk", region: "PAL", condition: "cib", kind: "active_listing",
      priceUsd: String(50 + i), priceOriginal: String(50 + i), currencyOriginal: "GBP", fetchedAt: daysAgo(i + 2),
    }));
    await ctx!.db.insert(pricePoints).values(rows);
    const pal = (await loadSignalHistory(ctx!.db, gameId, ["cex", "ebay_uk"], PLUGIN_SOURCES, cfg)).get("PAL")!;
    expect(pal.dropAgeDays.ebay_uk).toBe(7);
    // the 22 from 8 days ago is still the lowest listing outside today's batch
    expect(pal.lowest["ebay_uk|cib"].usd).toBe(22);
  });

  it("serves the references as of risingDays ago", async () => {
    const pal = (await loadSignalHistory(ctx!.db, gameId, ["cex", "ebay_uk"], PLUGIN_SOURCES, cfg)).get("PAL")!;
    expect(pal.risingAgo.referenceByCondition.cib?.price.usd).toBe(30);
  });

  it("keeps the lowest purchasable price per source and condition, excluding today's batch and unavailable boxes", async () => {
    const pal = (await loadSignalHistory(ctx!.db, gameId, ["cex", "ebay_uk"], PLUGIN_SOURCES, cfg)).get("PAL")!;
    expect(pal.lowest["ebay_uk|cib"]).toMatchObject({ usd: 22, original: 22, currency: "GBP" });
    expect(pal.lowest["ebay_uk|cib"].daysCovered).toBeGreaterThanOrEqual(39);
    expect(pal.lowest["cex|cib"].usd).toBe(42);
    expect(pal.lowest["cex|cib"]).toBeDefined();
  });

  it("marks a lowest whose history mixes currencies as USD-only", async () => {
    await ctx!.db.insert(pricePoints).values({
      gameId, source: "ebay_uk", region: "PAL", condition: "cib", kind: "active_listing",
      priceUsd: "21", priceOriginal: "19", currencyOriginal: "EUR", fetchedAt: daysAgo(20),
    });
    const pal = (await loadSignalHistory(ctx!.db, gameId, ["cex", "ebay_uk"], PLUGIN_SOURCES, cfg)).get("PAL")!;
    expect(pal.lowest["ebay_uk|cib"]).toMatchObject({ usd: 21, original: null });
  });

  it("records each store box's availability in the batch before the current one", async () => {
    const pal = (await loadSignalHistory(ctx!.db, gameId, ["cex", "ebay_uk"], PLUGIN_SOURCES, cfg)).get("PAL")!;
    expect(pal.previousAvailability["cex|cib|"]).toBe(false);
  });

  it("reads only the sources it is given and only kinds with a role", async () => {
    const pal = (await loadSignalHistory(ctx!.db, gameId, ["ebay_uk"], PLUGIN_SOURCES, cfg)).get("PAL")!;
    expect(pal.dropAgo.storeOffers).toEqual([]);
    expect(Object.keys(pal.lowest)).toEqual(["ebay_uk|cib"]);
  });
});
