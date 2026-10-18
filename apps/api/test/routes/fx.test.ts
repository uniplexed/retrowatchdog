import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import type { FxRateResponse, FxSettingDto, FxSettingsResponse } from "@retrowatchdog/shared";
import { SUPPORTED_CURRENCIES } from "@retrowatchdog/shared";
import { setupTestDb } from "../helpers/testDb.js";
import { buildApp } from "../../src/app.js";
import { fxOverrides, games, gameNames, ownedCopies, sourceMappings } from "../../src/db/schema.js";
import { resetFxCacheForTests } from "../../src/pricing/fx.js";
import { stubAdapter } from "../helpers/stubAdapter.js";

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}

const FRANKFURTER_RATES: Record<string, number> = {
  // the common six with realistic rates; the rest of the list at 2
  ...Object.fromEntries(SUPPORTED_CURRENCIES.filter((c) => c !== "USD").map((c) => [c, 2])),
  GBP: 0.79, EUR: 0.91, JPY: 148, CHF: 0.87, CAD: 1.36, AUD: 1.52,
};

describe.skipIf(ctx === null)("/api/fx + /api/settings/fx", () => {
  let agent: MockAgent;
  let prevDispatcher: ReturnType<typeof getGlobalDispatcher>;

  const mockDisplayRates = (): void => {
    const pool = agent.get("https://api.frankfurter.app");
    for (const [to, rate] of Object.entries(FRANKFURTER_RATES)) {
      pool
        .intercept({ path: `/latest?from=USD&to=${to}`, method: "GET" })
        .reply(200, { rates: { [to]: rate } })
        .persist();
    }
  };

  beforeEach(async () => {
    prevDispatcher = getGlobalDispatcher();
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    resetFxCacheForTests();
    await ctx!.truncateAll();
  });
  afterEach(async () => {
    setGlobalDispatcher(prevDispatcher);
    await agent.close();
    resetFxCacheForTests();
  });
  afterAll(async () => ctx?.pool.end());

  const app = async () => buildApp({ db: ctx!.db, registry: [stubAdapter()] });

  it("GET /api/fx serves the USD->X display rate with fetchedAt, mode auto", async () => {
    mockDisplayRates();
    const a = await app();
    const res = await a.inject({ method: "GET", url: "/api/fx?to=GBP" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as FxRateResponse;
    expect(body).toMatchObject({ base: "USD", to: "GBP", rate: 0.79, mode: "auto" });
    expect(body.fetchedAt).toBeTruthy();
    // cached: a second call needs no second intercept (persist aside, the fx
    // cache short-circuits — pinned indirectly by the settings tests below)
    expect((await a.inject({ method: "GET", url: "/api/fx?to=GBP" })).statusCode).toBe(200);
    await a.close();
  });

  it("GET /api/fx?to=USD is rate 1 without network", async () => {
    const a = await app();
    const body = (await a.inject({ method: "GET", url: "/api/fx?to=USD" })).json() as FxRateResponse;
    expect(body.rate).toBe(1);
    expect(body.mode).toBe("auto");
    await a.close();
  });

  it("GET /api/fx 400s an unsupported currency and a missing ?to", async () => {
    const a = await app();
    expect((await a.inject({ method: "GET", url: "/api/fx?to=XYZ" })).statusCode).toBe(400);
    expect((await a.inject({ method: "GET", url: "/api/fx" })).statusCode).toBe(400);
    await a.close();
  });

  it("GET /api/fx is 503 when FX is down (web falls back to USD display)", async () => {
    // no intercepts + disableNetConnect
    const a = await app();
    expect((await a.inject({ method: "GET", url: "/api/fx?to=EUR" })).statusCode).toBe(503);
    await a.close();
  });

  it("GET /api/fx marks a manual override: mode manual, the manual rate, no fetchedAt", async () => {
    await ctx!.db.insert(fxOverrides).values({ currency: "GBP", mode: "manual", manualRate: "0.5" });
    const a = await app();
    const body = (await a.inject({ method: "GET", url: "/api/fx?to=GBP" })).json() as FxRateResponse;
    // no frankfurter intercept exists: the manual rate must not need one
    expect(body).toMatchObject({ base: "USD", to: "GBP", rate: 0.5, mode: "manual", fetchedAt: null });
    await a.close();
  });

  it("GET /api/settings/fx lists every supported currency except USD with auto defaults", async () => {
    mockDisplayRates();
    const a = await app();
    const body = (await a.inject({ method: "GET", url: "/api/settings/fx" })).json() as FxSettingsResponse;
    expect(body.currencies.map((c) => c.currency)).toEqual(["GBP", "EUR", "JPY", "CHF", "CAD", "AUD"]);
    for (const row of body.currencies) {
      expect(row.mode).toBe("auto");
      expect(row.manualRate).toBeNull();
      expect(row.autoRate).toBe(FRANKFURTER_RATES[row.currency]);
      expect(row.fetchedAt).toBeTruthy();
    }
    await a.close();
  });

  it("GET /api/settings/fx still renders rows when FX is down (autoRate null)", async () => {
    const a = await app();
    const body = (await a.inject({ method: "GET", url: "/api/settings/fx" })).json() as FxSettingsResponse;
    expect(body.currencies).toHaveLength(6);
    expect(body.currencies.every((c) => c.autoRate === null && c.fetchedAt === null)).toBe(true);
    await a.close();
  });

  it("currencies: the original seven are on by default", async () => {
    const a = await app();
    const res = await a.inject({ method: "GET", url: "/api/settings/currencies" });
    await a.close();
    expect(res.json()).toEqual({ enabled: ["USD", "GBP", "EUR", "JPY", "CHF", "CAD", "AUD"] });
  });

  it("currencies: a saved list keeps USD, the list order, and drives the FX rows", async () => {
    mockDisplayRates();
    const a = await app();
    const put = await a.inject({ method: "PUT", url: "/api/settings/currencies", payload: { enabled: ["MXN", "GBP"] } });
    expect(put.json()).toEqual({ enabled: ["USD", "GBP", "MXN"] });
    const fx = (await a.inject({ method: "GET", url: "/api/settings/fx" })).json() as FxSettingsResponse;
    await a.close();
    expect(fx.currencies.map((c) => c.currency)).toEqual(["GBP", "MXN"]);
  });

  it("currencies: an unknown or repeated code is a 400", async () => {
    const a = await app();
    for (const enabled of [["XXX"], ["GBP", "GBP"], "GBP"]) {
      expect((await a.inject({ method: "PUT", url: "/api/settings/currencies", payload: { enabled } })).statusCode).toBe(400);
    }
    await a.close();
  });

  it("PUT round-trip: manual rate persists, shows in settings, and auto keeps it remembered", async () => {
    mockDisplayRates();
    const a = await app();
    const put = await a.inject({
      method: "PUT",
      url: "/api/settings/fx/GBP",
      payload: { mode: "manual", manualRate: 0.5 },
    });
    expect(put.statusCode).toBe(200);
    const dto = put.json() as FxSettingDto;
    expect(dto).toMatchObject({ currency: "GBP", mode: "manual", manualRate: 0.5 });
    expect(dto.autoRate).toBe(0.79); // reference rate still shown greyed

    const settings = (await a.inject({ method: "GET", url: "/api/settings/fx" })).json() as FxSettingsResponse;
    expect(settings.currencies.find((c) => c.currency === "GBP")).toMatchObject({ mode: "manual", manualRate: 0.5 });

    // switching back to auto preserves the last manual value for re-toggling
    const back = await a.inject({ method: "PUT", url: "/api/settings/fx/GBP", payload: { mode: "auto" } });
    expect(back.statusCode).toBe(200);
    expect(back.json()).toMatchObject({ mode: "auto", manualRate: 0.5 });
    // ...and the display rate is the Frankfurter one again
    const rate = (await a.inject({ method: "GET", url: "/api/fx?to=GBP" })).json() as FxRateResponse;
    expect(rate).toMatchObject({ rate: 0.79, mode: "auto" });
    await a.close();
  });

  it("PUT validation: unknown currency, USD base, manual without rate, non-positive rate, extra keys", async () => {
    const a = await app();
    const put = (url: string, payload: unknown) => a.inject({ method: "PUT", url, payload: payload as object });
    expect((await put("/api/settings/fx/XYZ", { mode: "manual", manualRate: 1 })).statusCode).toBe(400);
    expect((await put("/api/settings/fx/USD", { mode: "manual", manualRate: 1 })).statusCode).toBe(400);
    expect((await put("/api/settings/fx/GBP", { mode: "manual" })).statusCode).toBe(400);
    expect((await put("/api/settings/fx/GBP", { mode: "manual", manualRate: 0 })).statusCode).toBe(400);
    expect((await put("/api/settings/fx/GBP", { mode: "manual", manualRate: -1 })).statusCode).toBe(400);
    expect((await put("/api/settings/fx/GBP", { mode: "auto", bogus: true })).statusCode).toBe(400);
    expect(await ctx!.db.select().from(fxOverrides)).toHaveLength(0); // nothing persisted
    await a.close();
  });

  it("a manual rate is authoritative for write-time conversions (no Frankfurter involved)", async () => {
    // manual USD->EUR 0.5 => EUR->USD 2. No EUR intercept exists, so any
    // Frankfurter attempt would throw: the override MUST carry the write.
    await ctx!.db.insert(fxOverrides).values({ currency: "EUR", mode: "manual", manualRate: "0.5" });
    const [g] = await ctx!.db.insert(games).values({ title: "Super Metroid", platform: "snes" }).returning();
    const a = await app();
    const res = await a.inject({
      method: "POST",
      url: "/api/collection",
      payload: { gameId: g.id, region: "PAL", condition: "cib", acquiredPriceOriginal: 10, acquiredCurrency: "EUR" },
    });
    expect(res.statusCode).toBe(201);
    const [row] = await ctx!.db.select().from(ownedCopies);
    expect(Number(row.acquiredPriceUsd)).toBe(20); // 10 EUR / (0.5 USD->EUR)
    expect(Number(row.acquiredPriceOriginal)).toBe(10);
    await a.close();
  });

  it("a manual rate also drives live price snapshot conversions (fx honored EVERYWHERE)", async () => {
    // manual USD->GBP 0.8 => GBP->USD 1.25; no GBP->USD intercept exists
    await ctx!.db.insert(fxOverrides).values({ currency: "GBP", mode: "manual", manualRate: "0.8" });
    const [g] = await ctx!.db.insert(games).values({ title: "F-Zero", platform: "snes" }).returning();
    await ctx!.db.insert(gameNames).values({ gameId: g.id, name: "F-Zero" });
    await ctx!.db.insert(sourceMappings).values({
      gameId: g.id, source: "cex", sourceProductId: "x1", sourceTitle: "F-Zero", matchScore: 1, status: "confirmed",
    });
    const adapter = stubAdapter({
      source: "cex",
      search: async () => [
        { sourceProductId: "x1", title: "F-Zero", prices: [{ kind: "sell" as const, amount: 60, currency: "GBP" }], url: null },
      ],
      normalize: (raw) => ({ ...raw, cleanTitle: "f-zero", platformGuess: "snes", regionGuess: "PAL", conditionGuess: "loose" }),
    });
    const a = await buildApp({ db: ctx!.db, registry: [adapter] });
    const res = await a.inject({ method: "GET", url: `/api/games/${g.id}/prices?refresh=true` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { sources: Array<{ points: Array<{ priceUsd: number; priceOriginal: number }> }> };
    const sell = body.sources[0].points.find((p) => p.priceOriginal === 60)!;
    expect(sell.priceUsd).toBe(75); // 60 GBP * (1 / 0.8)
    await a.close();
  });

  it("auto fallback when no override row exists: Frankfurter serves the write-time rate", async () => {
    agent
      .get("https://api.frankfurter.app")
      .intercept({ path: "/latest?from=EUR&to=USD", method: "GET" })
      .reply(200, { rates: { USD: 1.1 } });
    const [g] = await ctx!.db.insert(games).values({ title: "Super Metroid", platform: "snes" }).returning();
    const a = await app();
    const res = await a.inject({
      method: "POST",
      url: "/api/collection",
      payload: { gameId: g.id, region: "PAL", condition: "cib", acquiredPriceOriginal: 10, acquiredCurrency: "EUR" },
    });
    expect(res.statusCode).toBe(201);
    const [row] = await ctx!.db.select().from(ownedCopies);
    expect(Number(row.acquiredPriceUsd)).toBe(11);
    await a.close();
  });
});
