import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Platform } from "@retrowatchdog/shared";
import { setupTestDb } from "../helpers/testDb.js";
import { stubAdapter } from "../helpers/stubAdapter.js";
import { games, gameNames } from "../../src/db/schema.js";
import { getPricesForGame } from "../../src/pricing/service.js";
import { saveEnabledSources } from "../../src/settings/markets.js";
import type { PriceSourceAdapter, RawListing } from "../../src/adapters/types.js";

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}

function spyAdapter(source: PriceSourceAdapter["source"]): {
  adapter: PriceSourceAdapter;
  searchSpy: ReturnType<typeof vi.fn>;
} {
  const searchSpy = vi.fn(async (): Promise<RawListing[]> => []);
  return { adapter: stubAdapter({ source, search: searchSpy }), searchSpy };
}

describe.skipIf(ctx === null)("getPricesForGame honors the enabled markets", () => {
  let game: { id: number; title: string; platform: Platform };

  beforeEach(async () => {
    await ctx!.truncateAll();
    const [g] = await ctx!.db
      .insert(games)
      .values({ igdbId: 1029, title: "Super Metroid", platform: "snes" })
      .returning({ id: games.id });
    await ctx!.db.insert(gameNames).values({ gameId: g.id, name: "Super Metroid" });
    game = { id: g.id, title: "Super Metroid", platform: "snes" };
  });
  afterAll(async () => ctx?.pool.end());

  it("makes no adapter call for a disabled market and leaves its block out entirely", async () => {
    const uk = spyAdapter("cex");
    const de = spyAdapter("ebay_de");
    // nothing stored yet -> the env seed applies: UK markets only
    const blocks = await getPricesForGame(ctx!.db, [uk.adapter, de.adapter], game, { mode: "live" });
    expect(uk.searchSpy).toHaveBeenCalledTimes(1);
    expect(de.searchSpy).not.toHaveBeenCalled();
    // absent, not a block with an invented status: a market nobody enabled
    // has nothing honest to say about this game
    expect(blocks.map((b) => b.source)).toEqual(["cex"]);
  });

  it("queries a market the moment it is enabled, with no restart", async () => {
    const uk = spyAdapter("cex");
    const de = spyAdapter("ebay_de");
    const registry = [uk.adapter, de.adapter];
    await getPricesForGame(ctx!.db, registry, game, { mode: "live" });
    expect(de.searchSpy).not.toHaveBeenCalled();

    await saveEnabledSources(ctx!.db, ["cex", "ebay_de"]);
    const blocks = await getPricesForGame(ctx!.db, registry, game, { mode: "live" });
    expect(de.searchSpy).toHaveBeenCalledTimes(1);
    expect(blocks.map((b) => b.source)).toEqual(["cex", "ebay_de"]);
  });

  it("keeps blocks in registry order for the enabled subset", async () => {
    await saveEnabledSources(ctx!.db, ["cex", "cex_es", "ebay_uk"]);
    const registry = [
      spyAdapter("cex").adapter,
      spyAdapter("cex_es").adapter,
      spyAdapter("cex_ie").adapter,
      spyAdapter("ebay_uk").adapter,
    ];
    const blocks = await getPricesForGame(ctx!.db, registry, game, { mode: "live" });
    expect(blocks.map((b) => b.source)).toEqual(["cex", "cex_es", "ebay_uk"]);
  });

  it("does not even read stored points of a disabled market in cached_only mode", async () => {
    const de = spyAdapter("ebay_de");
    const blocks = await getPricesForGame(ctx!.db, [de.adapter], game, { mode: "cached_only" });
    expect(blocks).toEqual([]);
  });
});
