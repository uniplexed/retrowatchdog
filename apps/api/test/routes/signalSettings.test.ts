import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { SignalConfigDto, SignalPreviewResponse } from "@retrowatchdog/shared";
import { setupTestDb } from "../helpers/testDb.js";
import { buildApp } from "../../src/app.js";
import { games, pricePoints, watchlist } from "../../src/db/schema.js";
import { stubAdapter } from "../helpers/stubAdapter.js";
import { seedCexPlugin } from "../helpers/seedCexPlugin.js";
import { seedEbayPlugin } from "../helpers/seedEbayPlugin.js";
import { clearSignalConfigCacheForTests, defaultSignalConfig } from "../../src/settings/signals.js";

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}

describe.skipIf(ctx === null)("signal settings routes", () => {
  beforeEach(async () => {
    clearSignalConfigCacheForTests();
    await ctx!.truncateAll();
    await seedCexPlugin(ctx!.db);
    await seedEbayPlugin(ctx!.db);
  });
  afterAll(async () => ctx?.pool.end());

  // both markets must be in the registry: enabledSourceIds reads only what can answer
  const app = () => buildApp({ db: ctx!.db, registry: [stubAdapter(), stubAdapter({ source: "ebay_uk" })] });

  /** one watched game: CeX sells PAL cib at 40 against an eBay UK median of 50 (8 listings) */
  const seedWatchedGame = async () => {
    const [g] = await ctx!.db.insert(games).values({ title: "Super Metroid", platform: "snes" }).returning();
    const fetchedAt = new Date();
    await ctx!.db.insert(pricePoints).values([
      { gameId: g.id, source: "cex", region: "PAL", condition: "cib", kind: "sell", priceUsd: "40.00", priceOriginal: "40.00", currencyOriginal: "GBP", fetchedAt },
      { gameId: g.id, source: "ebay_uk", region: "PAL", condition: "cib", kind: "active_median", priceUsd: "50.00", priceOriginal: "50.00", currencyOriginal: "GBP", sampleSize: 8, fetchedAt },
    ]);
    await ctx!.db.insert(watchlist).values({ gameId: g.id });
  };

  it("GET returns the defaults, without the engine-only minGainUsd", async () => {
    const a = await app();
    const res = await a.inject({ method: "GET", url: "/api/settings/signals" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(defaultSignalConfig());
    await a.close();
  });

  it("round-trips the recommendation thresholds", async () => {
    const a = await app();
    const next: SignalConfigDto = { ...defaultSignalConfig(), quietDays: 60, buyBelowAvgPct: 0, sourceDominancePct: 75 };
    expect((await a.inject({ method: "PUT", url: "/api/settings/signals", payload: next })).statusCode).toBe(200);
    clearSignalConfigCacheForTests();
    expect((await a.inject({ method: "GET", url: "/api/settings/signals" })).json()).toMatchObject({ quietDays: 60, buyBelowAvgPct: 0, sourceDominancePct: 75 });
    await a.close();
  });

  it("PUT persists the whole object and GET echoes it", async () => {
    const a = await app();
    const next: SignalConfigDto = { ...defaultSignalConfig(), underpricedFactor: 0.6, enabledTypes: ["UNDERPRICED", "TARGET_HIT"], minGain: { amount: 5, currency: "GBP" } };
    const put = await a.inject({ method: "PUT", url: "/api/settings/signals", payload: next });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual(next);
    clearSignalConfigCacheForTests();
    expect((await a.inject({ method: "GET", url: "/api/settings/signals" })).json()).toEqual(next);
    await a.close();
  });

  it.each([
    ["a zero factor", { underpricedFactor: 0 }],
    ["a fractional sample", { minSample: 2.5 }],
    ["a percent over 100", { priceDropPct: 120 }],
    ["a window of zero days", { newLowDays: 0 }],
    ["an unknown signal type", { enabledTypes: ["MOON"] }],
    ["an unsupported currency", { minGain: { amount: 5, currency: "XYZ" } }],
    ["a missing field", { alertLowConfidence: undefined }],
    ["an evaluation after zero days", { evalDays: 0 }],
    ["a quiet percent over 100", { quietPct: 101 }],
    ["a fractional minimum of games", { minGamesPerConsole: 2.5 }],
  ])("PUT refuses %s with 400 and stores nothing", async (_name, patch) => {
    const a = await app();
    const res = await a.inject({ method: "PUT", url: "/api/settings/signals", payload: { ...defaultSignalConfig(), ...patch } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBeTruthy();
    expect((await a.inject({ method: "GET", url: "/api/settings/signals" })).json()).toEqual(defaultSignalConfig());
    await a.close();
  });

  it("reset after a PUT brings back the defaults", async () => {
    const a = await app();
    await a.inject({ method: "PUT", url: "/api/settings/signals", payload: { ...defaultSignalConfig(), flipFactor: 2 } });
    const reset = await a.inject({ method: "POST", url: "/api/settings/signals/reset" });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toEqual(defaultSignalConfig());
    expect((await a.inject({ method: "GET", url: "/api/settings/signals" })).json()).toEqual(defaultSignalConfig());
    await a.close();
  });

  it("preview counts the watches a config would give a verdict, without storing it", async () => {
    await seedWatchedGame();
    const a = await app();
    const loose = await a.inject({
      method: "POST", url: "/api/settings/signals/preview",
      payload: { ...defaultSignalConfig(), underpricedFactor: 0.99 },
    });
    expect(loose.statusCode).toBe(200);
    const body = loose.json() as SignalPreviewResponse;
    expect(body).toMatchObject({ watches: 1, withSignal: 1, example: { title: "Super Metroid", verdictTitle: "Buy on CeX UK for £40" } });

    const strict = await a.inject({
      method: "POST", url: "/api/settings/signals/preview",
      payload: { ...defaultSignalConfig(), underpricedFactor: 0.01 },
    });
    expect(strict.json()).toMatchObject({ watches: 1, withSignal: 0, example: null });
    expect((await a.inject({ method: "GET", url: "/api/settings/signals" })).json()).toEqual(defaultSignalConfig());
    await a.close();
  });

  it("preview counts recommendations per group", async () => {
    const [g] = await ctx!.db.insert(games).values({ title: "Mario Kart", platform: "gba" }).returning();
    // eBay asks $40 for 59 days and $20 today: the 90-day low
    await ctx!.db.insert(pricePoints).values(
      Array.from({ length: 60 }, (_, i) => ({
        gameId: g.id, source: "ebay_uk", region: "PAL", condition: "loose", kind: "active_listing",
        priceUsd: i === 0 ? "20.00" : "40.00", priceOriginal: i === 0 ? "16.00" : "32.00", currencyOriginal: "GBP",
        fetchedAt: new Date(Date.now() - i * 86_400_000 - 60_000),
      })),
    );
    // a $100 target is under every price: lower_target on a second watch of the same game
    await ctx!.db.insert(watchlist).values([
      { gameId: g.id, region: "PAL", condition: "loose" },
      { gameId: g.id, region: "PAL", condition: null, targetPriceOriginal: "80", targetCurrency: "GBP", targetPriceUsd: "100" },
    ]);
    const a = await app();
    const res = await a.inject({ method: "POST", url: "/api/settings/signals/preview", payload: { ...defaultSignalConfig(), buyBelowAvgPct: 100 } });
    await a.close();
    // buy_now fires on both (lowest in 90 days), so the target advice is deduped away
    expect((res.json() as SignalPreviewResponse).recommendations).toEqual({ sellNow: 0, buyNow: 2, targets: 0, cleanUps: 0 });
  });

  it("GET suggested says not enough history on an empty deployment", async () => {
    const a = await app();
    const res = await a.inject({ method: "GET", url: "/api/settings/signals/suggested" });
    await a.close();
    expect(res.json()).toEqual({ basis: null, values: {}, notes: { history: "not enough history yet" } });
  });

  it("preview refuses an invalid config with 400", async () => {
    const a = await app();
    const res = await a.inject({ method: "POST", url: "/api/settings/signals/preview", payload: { ...defaultSignalConfig(), flipFactor: -1 } });
    expect(res.statusCode).toBe(400);
    await a.close();
  });
});
