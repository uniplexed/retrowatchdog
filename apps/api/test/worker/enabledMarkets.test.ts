import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb } from "../helpers/testDb.js";
import { stubAdapter } from "../helpers/stubAdapter.js";
import { catalogItems, games, ownedCopies, syncState } from "../../src/db/schema.js";
import { runCatalogSyncAll, runCatalogSyncUnit, runTrackedRefresh } from "../../src/worker/jobs.js";
import { loadRanAt } from "../../src/worker/catalogSink.js";
import { saveEnabledSources } from "../../src/settings/markets.js";
import type { CatalogSink, PriceSourceAdapter, RawListing, SyncUnitReport } from "../../src/adapters/types.js";

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}

function syncAdapter(source: PriceSourceAdapter["source"]): {
  adapter: PriceSourceAdapter;
  syncUnitSpy: ReturnType<typeof vi.fn>;
  refreshSpy: ReturnType<typeof vi.fn>;
} {
  const syncUnitSpy = vi.fn(async (unit: string, sink: CatalogSink): Promise<SyncUnitReport> => {
    await sink.upsert([
      {
        sourceProductId: "a", title: "Super Metroid, Boxed", categoryText: unit,
        prices: { sell: "60.00" }, currency: "EUR",
      },
    ]);
    return { itemsUpserted: 1, complete: true };
  });
  const refreshSpy = vi.fn(async (_ids: string[], _sink: CatalogSink): Promise<void> => {});
  const adapter = stubAdapter({
    source,
    catalogSync: {
      schedule: { catalogCron: "0 3 * * *", trackedRefreshHours: 4 },
      listSyncUnits: async () => ["Super NES Juegos"],
      syncUnit: syncUnitSpy,
      refreshItems: refreshSpy,
    },
  });
  return { adapter, syncUnitSpy, refreshSpy };
}

describe.skipIf(ctx === null)("worker jobs honor the enabled markets", () => {
  beforeEach(async () => ctx!.truncateAll());
  afterAll(async () => ctx?.pool.end());

  it("runCatalogSyncAll skips a disabled source: no sync, no sync_state row", async () => {
    // nothing stored -> the env seed applies (UK only), so cex_es is off
    const { adapter, syncUnitSpy } = syncAdapter("cex_es");
    await runCatalogSyncAll(ctx!.db, adapter);
    expect(syncUnitSpy).not.toHaveBeenCalled();
    expect(await ctx!.db.select().from(catalogItems)).toEqual([]);
    // no bookkeeping either: a unit that never ran must not be recorded as run
    expect(await ctx!.db.select().from(syncState)).toEqual([]);
  });

  it("runCatalogSyncUnit skips a disabled source", async () => {
    const { adapter, syncUnitSpy } = syncAdapter("cex_ie");
    await runCatalogSyncUnit(ctx!.db, adapter, "Super NES Software");
    expect(syncUnitSpy).not.toHaveBeenCalled();
    expect(await ctx!.db.select().from(catalogItems)).toEqual([]);
  });

  it("runTrackedRefresh skips a disabled source", async () => {
    const { adapter, refreshSpy } = syncAdapter("cex_es");
    await runTrackedRefresh(ctx!.db, [adapter], adapter, {});
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(await ctx!.db.select().from(syncState)).toEqual([]);
  });

  it("runs ONE cross-source snapshot per cycle, however many catalog markets are on", async () => {
    // The snapshot loop inside a tracked-refresh job is source-AGNOSTIC: it
    // re-fetches every enabled market for every tracked game. Running it once
    // per catalog market would multiply the eBay Browse quota (and the stored
    // price_points) by the number of enabled CeX countries, for identical
    // work. Exactly one job per cycle may run it.
    const { db } = ctx!;
    await saveEnabledSources(db, ["cex", "cex_es", "ebay_uk"]);
    const [g] = await db.insert(games).values({ title: "Super Metroid", platform: "snes" }).returning();
    await db.insert(ownedCopies).values({ gameId: g.id, region: "PAL", condition: "cib" });

    const { adapter: uk } = syncAdapter("cex");
    const { adapter: es } = syncAdapter("cex_es");
    const marketplaceSearch = vi.fn(async (): Promise<RawListing[]> => []);
    const marketplace = stubAdapter({ source: "ebay_uk", search: marketplaceSearch });
    const registry = [uk, es, marketplace];

    await runTrackedRefresh(db, registry, uk, {});
    await runTrackedRefresh(db, registry, es, {});

    // one tracked game, one cycle -> the marketplace was queried once, not
    // once per enabled CeX shop
    expect(marketplaceSearch).toHaveBeenCalledTimes(1);
    // ...and each shop still keeps its OWN bookkeeping, so its per-source
    // detail-refresh step and its catch-up are unaffected
    expect(await loadRanAt(db, "tracked-refresh:cex")).not.toBeNull();
    expect(await loadRanAt(db, "tracked-refresh:cex_es")).not.toBeNull();
  });

  it("syncs the same catalog once the market is enabled, with no restart", async () => {
    const { adapter, syncUnitSpy } = syncAdapter("cex_es");
    await runCatalogSyncAll(ctx!.db, adapter);
    expect(syncUnitSpy).not.toHaveBeenCalled();

    await saveEnabledSources(ctx!.db, ["cex", "cex_es"]);
    await runCatalogSyncAll(ctx!.db, adapter);
    expect(syncUnitSpy).toHaveBeenCalledTimes(1);
    const rows = await ctx!.db.select().from(catalogItems);
    expect(rows.map((r) => r.source)).toEqual(["cex_es"]);
  });
});
