import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type pg from "pg";
import type { Platform } from "@retrowatchdog/shared";
import { setupTestDb } from "../helpers/testDb.js";
import type { Db } from "../../src/db/index.js";
import { games, gameNames } from "../../src/db/schema.js";
import { getPricesForGame } from "../../src/pricing/service.js";
import type { PriceSourceAdapter, RawListing } from "../../src/adapters/types.js";
import type { NormalizedListing } from "../../src/adapters/types.js";
import { classifyCatalogListing } from "../../src/adapters/classifyListing.js";
import { stubAdapter } from "../helpers/stubAdapter.js";

/**
 * What the deleted `normalizeCexListing` was: the shared catalogue reading with
 * CeX's own declared region. The CeX shops declare PAL in the plugin manifest.
 */
const normalizeCexListing = (raw: RawListing): NormalizedListing =>
  classifyCatalogListing(raw, "PAL");


const zeldaCexListing: RawListing = {
  sourceProductId: "box-oot-boxed",
  title: "Legend Of Zelda Ocarina Of Time, Boxed",
  categoryText: "Nintendo N64 Games",
  url: null,
  prices: [{ kind: "sell", amount: 60, currency: "GBP" }],
};

function fakeCex(): PriceSourceAdapter & { searchSpy: ReturnType<typeof vi.fn> } {
  const searchSpy = vi.fn(async () => [zeldaCexListing]);
  return { ...stubAdapter({ source: "cex", search: searchSpy, normalize: normalizeCexListing }), searchSpy };
}

describe("refresh modes", () => {
  let db: Db;
  let pool: pg.Pool;
  let truncateAll: () => Promise<void>;
  let zelda: { id: number; title: string; platform: Platform };

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
    zelda = { id: g.id, title: "The Legend of Zelda: Ocarina of Time", platform: "n64" };
  });
  afterAll(async () => await pool.end());

  it("live mode refetches even when stored data is fresh", async () => {
    const cex = fakeCex();
    await getPricesForGame(db, [cex], zelda);
    await getPricesForGame(db, [cex], zelda, { mode: "live" });
    expect(cex.searchSpy).toHaveBeenCalledTimes(2);
  });

  it("cached_only never calls the adapter and serves what is stored", async () => {
    const warm = fakeCex();
    await getPricesForGame(db, [warm], zelda);
    const cold = fakeCex();
    const blocks = await getPricesForGame(db, [cold], zelda, { mode: "cached_only", ttlHours: 0 });
    expect(cold.searchSpy).not.toHaveBeenCalled();
    expect(blocks[0].status).toBe("ok");
    expect(blocks[0].points).toHaveLength(1);
    expect(blocks[0].fetchedAt).toBeDefined();
  });

  it("cached_only with nothing stored returns an honest empty ok block", async () => {
    const cold = fakeCex();
    const blocks = await getPricesForGame(db, [cold], zelda, { mode: "cached_only" });
    expect(cold.searchSpy).not.toHaveBeenCalled();
    expect(blocks[0]).toMatchObject({ source: "cex", status: "ok", points: [] });
  });
});
