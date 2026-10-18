import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { CollectionResponse } from "@retrowatchdog/shared";
import { setupTestDb } from "../helpers/testDb.js";
import { buildApp } from "../../src/app.js";
import { games, ownedCopies, pricePoints } from "../../src/db/schema.js";
import { stubAdapter } from "../helpers/stubAdapter.js";
import { saveEnabledSources } from "../../src/settings/markets.js";
import { seedCexPlugin } from "../helpers/seedCexPlugin.js";

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}

describe.skipIf(ctx === null)("GET /api/collection reads only the enabled markets", () => {
  beforeEach(async () => {
    await ctx!.truncateAll();
    // CeX's three shops reach the registry only through an approved plugin row.
    await seedCexPlugin(ctx!.db);
  });
  afterAll(async () => ctx?.pool.end());

  const app = async () =>
    buildApp({
      db: ctx!.db,
      registry: [stubAdapter({ source: "cex" }), stubAdapter({ source: "cex_es" })],
    });

  const fetchedAt = new Date("2026-09-03T10:00:00Z");

  /** One PAL cib copy with an in-stock shelf price in the UK and in Spain. */
  const seed = async (): Promise<void> => {
    const [g] = await ctx!.db
      .insert(games)
      .values({ title: "Super Metroid", platform: "snes" })
      .returning({ id: games.id });
    const shelf = (source: string, price: string, currency: string) => ({
      gameId: g.id, source, region: "PAL", condition: "cib", kind: "sell",
      priceUsd: price, priceOriginal: price, currencyOriginal: currency,
      available: true, fetchedAt,
    });
    await ctx!.db.insert(pricePoints).values([
      shelf("cex", "60.00", "GBP"),
      shelf("cex_es", "45.00", "EUR"),
    ]);
    await ctx!.db.insert(ownedCopies).values({ gameId: g.id, region: "PAL", condition: "cib" });
  };

  const get = async (url: string): Promise<CollectionResponse> => {
    const a = await app();
    const res = await a.inject({ method: "GET", url });
    await a.close();
    expect(res.statusCode).toBe(200);
    return res.json() as CollectionResponse;
  };

  it("ignores a disabled market's stored points, even when the valuation asks for its country", async () => {
    await seed();
    // cex_es is off (env seed = UK only), so a Spain-only valuation has
    // nothing left to read — the stored Spanish shelf price is not consulted.
    const spain = await get("/api/collection?valuation=replacement&country=ES");
    expect(spain.items[0].estimatedValueUsd).toBeNull();
    // ...and it says WHY. A null with a null basis means "nothing was ever
    // fetched for this game", which the screen answers with "open the game
    // once to fetch prices" — useless advice here: the prices are stored and
    // fresh, and no refetch can put them in a country the setting excludes.
    expect(spain.items[0].valueBasis).toEqual({
      readAs: "excluded",
      reason: "outside_valuation_markets",
    });
    // the enabled UK shop still values the same copy
    const uk = await get("/api/collection?valuation=replacement&country=GB");
    expect(uk.items[0]).toMatchObject({
      estimatedValueUsd: 60,
      valueBasis: { readAs: "reading", source: "cex", priceKind: "sell" },
    });
  });

  it("reads the same stored points the moment the market is enabled", async () => {
    await seed();
    await saveEnabledSources(ctx!.db, ["cex", "cex_es"]);
    const spain = await get("/api/collection?valuation=replacement&country=ES");
    expect(spain.items[0]).toMatchObject({
      estimatedValueUsd: 45,
      valueBasis: { readAs: "reading", source: "cex_es", priceKind: "sell" },
    });
  });
});
