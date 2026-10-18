import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type pg from "pg";
import { setupTestDb } from "../helpers/testDb.js";
import type { Db } from "../../src/db/index.js";
import { games, gameNames, pricePoints } from "../../src/db/schema.js";
import { buildApp } from "../../src/app.js";
import { saveEnabledSources } from "../../src/settings/markets.js";
import { seedCexPlugin } from "../helpers/seedCexPlugin.js";

const igdbStub = { isConfigured: () => false, searchGames: async () => [] } as unknown as import("../../src/catalog/igdb.js").IgdbClient;

describe("GET /api/games/:id/history", () => {
  let db: Db;
  let pool: pg.Pool;
  let truncateAll: () => Promise<void>;
  let gameId: number;

  beforeAll(async () => {
    ({ db, pool, truncateAll } = await setupTestDb());
  });
  beforeEach(async () => {
    await truncateAll();
    // CeX's three shops reach the registry only through an approved plugin row.
    await seedCexPlugin(db);
    const [g] = await db
      .insert(games)
      .values({ igdbId: 1029, title: "The Legend of Zelda: Ocarina of Time", platform: "n64", year: 1998 })
      .returning({ id: games.id });
    await db.insert(gameNames).values({ gameId: g.id, name: "The Legend of Zelda: Ocarina of Time" });
    gameId = g.id;
  });
  afterAll(async () => await pool.end());

  it("serves one series per source and kind, a point per day, oldest first", async () => {
    // three days of a shop's sell price for one game, two fetches on the first
    // day; dated relative to today so the 30-day window always holds them
    const dayAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
    const [d1, d2, d3] = [dayAgo(3), dayAgo(2), dayAgo(1)];
    const app = await buildApp({ db, igdb: igdbStub, registry: [] });
    await db.insert(pricePoints).values([
      {
        gameId, source: "cex", region: "PAL", condition: "cib", kind: "sell",
        priceUsd: "40", priceOriginal: "40", currencyOriginal: "USD",
        available: true, fetchedAt: new Date(`${d1}T09:00:00Z`),
      },
      {
        gameId, source: "cex", region: "PAL", condition: "cib", kind: "sell",
        priceUsd: "35", priceOriginal: "35", currencyOriginal: "USD",
        available: true, fetchedAt: new Date(`${d1}T18:00:00Z`),
      },
      {
        gameId, source: "cex", region: "PAL", condition: "cib", kind: "sell",
        priceUsd: "42", priceOriginal: "42", currencyOriginal: "USD",
        available: true, fetchedAt: new Date(`${d2}T12:00:00Z`),
      },
      {
        gameId, source: "cex", region: "PAL", condition: "cib", kind: "sell",
        priceUsd: "44", priceOriginal: "44", currencyOriginal: "USD",
        available: true, fetchedAt: new Date(`${d3}T12:00:00Z`),
      },
    ]);
    const res = await app.inject({
      method: "GET",
      url: `/api/games/${gameId}/history?region=PAL&condition=cib&days=30`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.region).toBe("PAL");
    expect(body.condition).toBe("cib");
    expect(body.days).toBe(30);
    const sell = body.series.find((s: { kind: string }) => s.kind === "sell");
    expect(sell.role).toBe("buy_store");
    // Each point carries what the source actually quoted beside its frozen USD
    // twin, read from the stored row — the chart plots the quoted amount for a
    // single-currency series so FX drift is not drawn as a price change.
    expect(sell.points).toEqual([
      { day: d1, usd: 35, original: { amount: 35, currency: "USD" } },
      { day: d2, usd: 42, original: { amount: 42, currency: "USD" } },
      { day: d3, usd: 44, original: { amount: 44, currency: "USD" } },
    ]);
    await app.close();
  });

  it("refuses a missing, unknown or non-concrete region or condition", async () => {
    const app = await buildApp({ db, igdb: igdbStub, registry: [] });
    for (const query of [
      "condition=cib&days=30",
      "region=PAL&days=30",
      "region=all&condition=cib&days=30",
      "region=PAL&condition=all&days=30",
      "region=MARS&condition=cib&days=30",
      "region=PAL&condition=shiny&days=30",
    ]) {
      const res = await app.inject({ method: "GET", url: `/api/games/${gameId}/history?${query}` });
      expect(res.statusCode).toBe(400);
    }
    await app.close();
  });

  it("refuses a window outside 1..365 rather than clamping it", async () => {
    const app = await buildApp({ db, igdb: igdbStub, registry: [] });
    for (const days of ["0", "366", "-5", "1.5", "many"]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/games/${gameId}/history?region=PAL&condition=cib&days=${days}`,
      });
      expect(res.statusCode).toBe(400);
    }
    await app.close();
  });

  it("defaults the window to 30 days and reports the window's own edges", async () => {
    const app = await buildApp({ db, igdb: igdbStub, registry: [] });
    const res = await app.inject({
      method: "GET",
      url: `/api/games/${gameId}/history?region=PAL&condition=cib`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.days).toBe(30);
    // `from` is 29 days before `to`, whatever data exists
    const from = new Date(`${body.from}T00:00:00Z`).getTime();
    const to = new Date(`${body.to}T00:00:00Z`).getTime();
    expect((to - from) / 86_400_000).toBe(29);
    await app.close();
  });

  it("leaves out a point older than the window", async () => {
    const app = await buildApp({ db, igdb: igdbStub, registry: [] });
    // ...seed one point 200 days old and one from today, then ask for days=7
    const now = new Date();
    const old = new Date(now.getTime() - 200 * 86_400_000);
    await db.insert(pricePoints).values([
      {
        gameId, source: "cex", region: "PAL", condition: "cib", kind: "sell",
        priceUsd: "40", priceOriginal: "40", currencyOriginal: "USD",
        available: true, fetchedAt: old,
      },
      {
        gameId, source: "cex", region: "PAL", condition: "cib", kind: "sell",
        priceUsd: "50", priceOriginal: "50", currencyOriginal: "USD",
        available: true, fetchedAt: now,
      },
    ]);
    const res = await app.inject({
      method: "GET",
      url: `/api/games/${gameId}/history?region=PAL&condition=cib&days=7`,
    });
    const body = res.json();
    expect(body.series[0].points).toHaveLength(1);
    await app.close();
  });

  it("404s for a game that does not exist", async () => {
    const app = await buildApp({ db, igdb: igdbStub, registry: [] });
    const res = await app.inject({
      method: "GET",
      url: "/api/games/999999/history?region=PAL&condition=cib",
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("leaves out a source the deployment has disabled, the same as /prices", async () => {
    // cex is enabled, cex_ie is not — a disabled market's rows must never
    // reach the chart, even though the price table already hides them
    await saveEnabledSources(db, ["cex"]);
    const app = await buildApp({ db, igdb: igdbStub, registry: [] });
    await db.insert(pricePoints).values([
      {
        gameId, source: "cex", region: "PAL", condition: "cib", kind: "sell",
        priceUsd: "40", priceOriginal: "40", currencyOriginal: "USD",
        available: true, fetchedAt: new Date(),
      },
      {
        gameId, source: "cex_ie", region: "PAL", condition: "cib", kind: "sell",
        priceUsd: "55", priceOriginal: "50", currencyOriginal: "EUR",
        available: true, fetchedAt: new Date(),
      },
    ]);
    const res = await app.inject({
      method: "GET",
      url: `/api/games/${gameId}/history?region=PAL&condition=cib&days=30`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.series.map((s: { source: string }) => s.source)).toEqual(["cex"]);
    await app.close();
  });

  it("filters by region and condition, not just game and source", async () => {
    // same game, same source, same kind, two different (region, condition)
    // pairs on two different days — only the PAL/cib row must come back for a
    // PAL/cib request. Different days so a leaked NTSC_U/loose row would add
    // its OWN point rather than merely lose a same-day reduction, which the
    // builder cannot catch either way since it does not key by dimension.
    const app = await buildApp({ db, igdb: igdbStub, registry: [] });
    const today = new Date();
    const yesterday = new Date(today.getTime() - 86_400_000);
    await db.insert(pricePoints).values([
      {
        gameId, source: "cex", region: "PAL", condition: "cib", kind: "sell",
        priceUsd: "40", priceOriginal: "40", currencyOriginal: "USD",
        available: true, fetchedAt: today,
      },
      {
        gameId, source: "cex", region: "NTSC_U", condition: "loose", kind: "sell",
        priceUsd: "90", priceOriginal: "90", currencyOriginal: "USD",
        available: true, fetchedAt: yesterday,
      },
    ]);
    const res = await app.inject({
      method: "GET",
      url: `/api/games/${gameId}/history?region=PAL&condition=cib&days=30`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.series).toHaveLength(1);
    expect(body.series[0].points).toHaveLength(1);
    expect(body.series[0].points[0].usd).toBe(40);
    await app.close();
  });

  it("serves an empty series list, not a broken query, when no source is enabled", async () => {
    await saveEnabledSources(db, []);
    const app = await buildApp({ db, igdb: igdbStub, registry: [] });
    await db.insert(pricePoints).values({
      gameId, source: "cex", region: "PAL", condition: "cib", kind: "sell",
      priceUsd: "40", priceOriginal: "40", currencyOriginal: "USD",
      available: true, fetchedAt: new Date(),
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/games/${gameId}/history?region=PAL&condition=cib&days=30`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().series).toEqual([]);
    await app.close();
  });

  it("serves an empty series list for a game nobody has fetched", async () => {
    // ...seed a game with no price_points
    const app = await buildApp({ db, igdb: igdbStub, registry: [] });
    const res = await app.inject({
      method: "GET",
      url: `/api/games/${gameId}/history?region=PAL&condition=cib`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().series).toEqual([]);
    await app.close();
  });
});
