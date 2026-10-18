import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type pg from "pg";
import { eq } from "drizzle-orm";
import { setupTestDb } from "../helpers/testDb.js";
import type { Db } from "../../src/db/index.js";
import { games, gameNames } from "../../src/db/schema.js";
import { buildApp } from "../../src/app.js";
import type { PriceSourceAdapter, RawListing } from "../../src/adapters/types.js";
import type { NormalizedListing } from "../../src/adapters/types.js";
import { classifyCatalogListing } from "../../src/adapters/classifyListing.js";
import type { IgdbClient } from "../../src/catalog/igdb.js";
import { stubAdapter } from "../helpers/stubAdapter.js";

/**
 * What the deleted `normalizeCexListing` was: the shared catalogue reading with
 * CeX's own declared region. The CeX shops declare PAL in the plugin manifest.
 */
const normalizeCexListing = (raw: RawListing): NormalizedListing =>
  classifyCatalogListing(raw, "PAL");


const igdbStub = { isConfigured: () => false, searchGames: async () => [] } as unknown as IgdbClient;
const listing: RawListing = {
  sourceProductId: "box-1",
  title: "Legend Of Zelda Ocarina Of Time, Boxed",
  categoryText: "Nintendo N64 Games",
  url: null,
  prices: [{ kind: "sell", amount: 60, currency: "GBP" }],
};

function spyCex(): PriceSourceAdapter & { searchSpy: ReturnType<typeof vi.fn> } {
  const searchSpy = vi.fn(async () => [listing]);
  return { ...stubAdapter({ source: "cex", search: searchSpy, normalize: normalizeCexListing }), searchSpy };
}

describe("per-title price mode", () => {
  let db: Db;
  let pool: pg.Pool;
  let truncateAll: () => Promise<void>;
  let zeldaId: number;

  beforeAll(async () => {
    ({ db, pool, truncateAll } = await setupTestDb());
  });
  beforeEach(async () => {
    await truncateAll();
    const [g] = await db
      .insert(games)
      .values({ igdbId: 1029, title: "The Legend of Zelda: Ocarina of Time", platform: "n64", year: 1998 })
      .returning({ id: games.id });
    await db.insert(gameNames).values({ gameId: g.id, name: "The Legend of Zelda: Ocarina of Time" });
    zeldaId = g.id;
  });
  afterAll(async () => await pool.end());

  it("PATCH stores the override, prices respect it, refresh param beats it", async () => {
    const cex = spyCex();
    const app = await buildApp({ db, igdb: igdbStub, registry: [cex] });

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/games/${zeldaId}/settings`,
      payload: { priceMode: "cached_only" },
    });
    expect(patch.statusCode).toBe(204);
    const [row] = await db.select().from(games).where(eq(games.id, zeldaId));
    expect(row.priceMode).toBe("cached_only");

    await app.inject({ method: "GET", url: `/api/games/${zeldaId}/prices` });
    expect(cex.searchSpy).not.toHaveBeenCalled(); // cached_only wins over default

    await app.inject({ method: "GET", url: `/api/games/${zeldaId}/prices?refresh=true` });
    expect(cex.searchSpy).toHaveBeenCalledTimes(1); // refresh beats the override

    const reset = await app.inject({
      method: "PATCH",
      url: `/api/games/${zeldaId}/settings`,
      payload: { priceMode: null },
    });
    expect(reset.statusCode).toBe(204);
    const [after] = await db.select().from(games).where(eq(games.id, zeldaId));
    expect(after.priceMode).toBeNull();
    await app.close();
  });

  it("404s for unknown games and 400s for invalid modes", async () => {
    const app = await buildApp({ db, igdb: igdbStub, registry: [] });
    expect((await app.inject({ method: "PATCH", url: "/api/games/9999/settings", payload: { priceMode: "live" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "PATCH", url: `/api/games/${zeldaId}/settings`, payload: { priceMode: "sometimes" } })).statusCode).toBe(400);
    await app.close();
  });
});
