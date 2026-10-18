import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { type PriceKind } from "@retrowatchdog/shared";
import { setupTestDb } from "../helpers/testDb.js";
import { stubAdapter } from "../helpers/stubAdapter.js";
import { catalogItems, games, gameNames, ownedCopies, sourceMappings, watchlist } from "../../src/db/schema.js";
import {
  computeCatchUp, runBootCatchUp, runCatalogSyncAll, runTrackedRefresh,
  type CatchUpQueue,
  unitJobKey,
} from "../../src/worker/jobs.js";
import { loadRanAt, markRan } from "../../src/worker/catalogSink.js";
import { saveEnabledSources } from "../../src/settings/markets.js";
import { classifyCatalogListing } from "../../src/adapters/classifyListing.js";

/**
 * A catalogue row read back as a listing, and the shared catalogue reading over
 * it, as `PluginCatalogAdapter` does from the same columns. Written out here
 * because what this suite needs from it is a fake sync adapter, not the real
 * one.
 */
const rowToRawListing = (row: {
  sourceProductId: string;
  title: string;
  categoryText: string | null;
  prices: Record<string, string>;
  available: boolean | null;
  syncedAt: Date;
}): RawListing | null => {
  const prices = Object.entries(row.prices ?? {})
    .map(([kind, amount]) => ({ kind: kind as PriceKind, amount: Number(amount), currency: "GBP" }))
    .filter((price) => Number.isFinite(price.amount) && price.amount >= 0);
  if (prices.length === 0) return null;
  return {
    sourceProductId: row.sourceProductId,
    title: row.title,
    ...(row.categoryText === null ? {} : { categoryText: row.categoryText }),
    prices,
    url: `https://uk.webuy.com/product-detail?id=${row.sourceProductId}`,
    observedAt: row.syncedAt,
    available: row.available,
  };
};

const normalizeCexListing = (raw: RawListing) => classifyCatalogListing(raw, "PAL");
import type { PriceSourceAdapter, RawListing } from "../../src/adapters/types.js";
import { PLUGIN_SOURCES } from "../helpers/pluginSources.js";

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}

function syncAdapter(overrides: Partial<PriceSourceAdapter> = {}): PriceSourceAdapter {
  return stubAdapter({
    source: "cex",
    // Honors the CatalogSyncCapability contract (adapters/types.ts: "present =
    // catalog-sync source, search reads the local catalog") the same way the
    // real CexAdapter does, so runTrackedRefresh's generic getPricesForGame()
    // live-search path has something to find in catalog_items.
    search: async (query) => {
      const rows = await ctx!.db.select().from(catalogItems).where(eq(catalogItems.source, "cex"));
      return rows
        .filter((r) => r.title.toLowerCase().includes(query.toLowerCase()))
        .map((r) => rowToRawListing({
          sourceProductId: r.sourceProductId,
          title: r.title,
          categoryText: r.categoryText,
          prices: r.prices,
          available: r.available,
          syncedAt: r.syncedAt,
        }))
        // a row with no usable price is dropped, the same rule PluginCatalogAdapter applies
        .filter((l): l is RawListing => l !== null);
    },
    normalize: normalizeCexListing,
    catalogSync: {
      schedule: { catalogCron: "0 3 * * *", trackedRefreshHours: 4 },
      listSyncUnits: async () => ["Super NES Software"],
      syncUnit: async (_unit, sink) => {
        await sink.upsert([
          {
            sourceProductId: "a", title: "Super Metroid, Boxed",
            categoryText: "Super NES Software",
            prices: { sell: "60.00", cash: "30.00", voucher: "40.00" }, currency: "GBP",
          },
        ]);
        return { itemsUpserted: 1, complete: true };
      },
    },
    ...overrides,
  });
}

describe.skipIf(ctx === null)("worker jobs", () => {
  beforeEach(async () => ctx!.truncateAll());
  afterAll(async () => ctx?.pool.end());

  it("runCatalogSyncAll upserts, deletes unseen and marks sync_state per unit", async () => {
    const { db } = ctx!;
    // pre-existing row in the same unit that the sync won't return -> deleted.
    // syncedAt is recent (not epoch): if it were old enough to also trip the
    // unrelated 30-day sweepStale() orphan sweep, this assertion would pass
    // even with deleteUnseen wiring removed — it must specifically prove
    // deleteUnseen, not the coarser sweep.
    await db.insert(catalogItems).values({
      source: "cex", sourceProductId: "stale", title: "Old Box",
      categoryText: "Super NES Software", prices: { sell: "1.00" }, currency: "GBP",
      syncedAt: new Date(), lastSeenAt: new Date(0), refreshSource: "bulk",
      syncUnit: "Super NES Software",
    });
    await runCatalogSyncAll(db, syncAdapter());
    const rows = await db.select().from(catalogItems);
    expect(rows.map((r) => r.sourceProductId)).toEqual(["a"]);
    const { staleUnits } = await computeCatchUp(db, syncAdapter(), new Date());
    expect(staleUnits).toEqual([]); // just ran -> not stale
  });

  it("does NOT delete unseen when the unit reports incomplete", async () => {
    const { db } = ctx!;
    // recent syncedAt (not epoch): this row must survive because deleteUnseen
    // is skipped on an incomplete unit, not because it dodges the unrelated
    // 30-day sweepStale() orphan sweep that also runs at the end of
    // runCatalogSyncAll.
    await db.insert(catalogItems).values({
      source: "cex", sourceProductId: "stale", title: "Old Box",
      categoryText: "Super NES Software", prices: { sell: "1.00" }, currency: "GBP",
      syncedAt: new Date(), lastSeenAt: new Date(0), refreshSource: "bulk",
      syncUnit: "Super NES Software",
    });
    const incomplete = syncAdapter();
    incomplete.catalogSync!.syncUnit = async (_u, sink) => {
      await sink.upsert([]);
      return { itemsUpserted: 0, complete: false, notes: "shortfall" };
    };
    await runCatalogSyncAll(db, incomplete);
    const rows = await db.select().from(catalogItems);
    expect(rows.map((r) => r.sourceProductId)).toEqual(["stale"]); // survived
  });

  it("computeCatchUp flags a unit whose cron firing was missed", async () => {
    const { db } = ctx!;
    const adapter = syncAdapter();
    // never ran -> stale; ran after the last 03:00 firing -> fresh
    let r = await computeCatchUp(db, adapter, new Date("2026-08-31T12:00:00Z"));
    expect(r.staleUnits).toEqual(["Super NES Software"]);
    expect(r.trackedDue).toBe(true);
    await markRan(db, "catalog-sync:cex:Super NES Software", new Date("2026-08-31T04:00:00Z"));
    await markRan(db, "tracked-refresh:cex", new Date("2026-08-31T11:00:00Z"));
    r = await computeCatchUp(db, adapter, new Date("2026-08-31T12:00:00Z"));
    expect(r.staleUnits).toEqual([]);
    expect(r.trackedDue).toBe(false);
    // ran before the last 03:00 firing -> a firing was missed -> stale
    await markRan(db, "catalog-sync:cex:Super NES Software", new Date("2026-08-30T04:00:00Z"));
    r = await computeCatchUp(db, adapter, new Date("2026-08-31T12:00:00Z"));
    expect(r.staleUnits).toEqual(["Super NES Software"]);
  });

  it("boot catch-up: a plugin that is down costs its own catch-up and nothing else", async () => {
    // `computeCatchUp` is not a database read for a plugin source: it calls
    // listSyncUnits, which for a sidecar is a GET /catalog/units to the
    // plugin's container (adapters/sidecar/sync.ts), and it parses the cron a
    // manifest declared. Both can throw at boot, and an unreachable plugin
    // must not stop another source's catch-up.
    const { db } = ctx!;
    await saveEnabledSources(db, ["cex", "shop_gb"]);
    const added: Array<[string, unknown, { jobId: string }]> = [];
    const queue: CatchUpQueue = {
      add: async (name, data, opts) => void added.push([name, data, opts]),
    };
    const down = stubAdapter({
      source: "shop_gb",
      catalogSync: {
        schedule: { catalogCron: "0 4 * * *", trackedRefreshHours: 6 },
        listSyncUnits: async () => {
          throw new Error("http://shop:8000 GET /catalog/units: connect ECONNREFUSED");
        },
        syncUnit: async () => ({ itemsUpserted: 0, complete: true }),
      },
    });

    await runBootCatchUp(db, queue, [down, syncAdapter()]);

    // nothing was enqueued for the down plugin, everything was for cex
    expect(added.map(([, data]) => (data as { source: string }).source)).toEqual(["cex", "cex"]);
    expect(added.map(([name]) => name)).toEqual(["catalog-sync-unit", "tracked-refresh"]);
    // the unit's hash, never its name: a ":" in a name would make bullmq refuse the id
    expect(added[0][2].jobId).toBe(`catalog-sync-unit.cex.${unitJobKey("Super NES Software")}`);
    expect(added[0][2].jobId).not.toContain(":");
  });

  it("boot catch-up: a disabled market costs no jobs", async () => {
    const { db } = ctx!;
    await saveEnabledSources(db, ["ebay_uk"]);
    const added: string[] = [];
    await runBootCatchUp(
      db,
      { add: async (name) => void added.push(name) },
      [syncAdapter()],
    );
    expect(added).toEqual([]);
  });

  it("runTrackedRefresh skips cached_only games and re-snapshots the rest", async () => {
    const { db } = ctx!;
    await runCatalogSyncAll(db, syncAdapter()); // catalog has box "a"
    // g2 gets its OWN catalog row + confirmed mapping so the cached_only
    // guard is load-bearing: without it, g2's mapping would be picked up by
    // the refreshItems mappings query too (refreshed -> [["a","b"]]) and its
    // search("F-Zero") would find box "b" and write a price_points row.
    await db.insert(catalogItems).values([
      {
        source: "cex", sourceProductId: "b", title: "F-Zero, Boxed",
        categoryText: "Super NES Software", prices: { sell: "20.00", cash: "10.00", voucher: "14.00" },
        currency: "GBP", syncedAt: new Date(), lastSeenAt: new Date(), refreshSource: "bulk",
        syncUnit: "Super NES Software",
      },
      // g3's box: no source_mappings row seeded for it (see below) -> covers
      // spec §6's lazy-mapping-creation path for a never-opened watchlist game.
      {
        source: "cex", sourceProductId: "c", title: "Star Fox, Boxed",
        categoryText: "Super NES Software", prices: { sell: "35.00", cash: "18.00", voucher: "22.00" },
        currency: "GBP", syncedAt: new Date(), lastSeenAt: new Date(), refreshSource: "bulk",
        syncUnit: "Super NES Software",
      },
    ]);
    const [g1] = await db.insert(games).values({ title: "Super Metroid", platform: "snes" }).returning();
    const [g2] = await db.insert(games).values({ title: "F-Zero", platform: "snes", priceMode: "cached_only" }).returning();
    const [g3] = await db.insert(games).values({ title: "Star Fox", platform: "snes" }).returning();
    await db.insert(gameNames).values([
      { gameId: g1.id, name: "Super Metroid" },
      { gameId: g2.id, name: "F-Zero" },
      { gameId: g3.id, name: "Star Fox" },
    ]);
    await db.insert(ownedCopies).values({ gameId: g1.id, region: "PAL", condition: "cib" });
    await db.insert(watchlist).values([{ gameId: g2.id }, { gameId: g3.id }]);
    await db.insert(sourceMappings).values([
      {
        gameId: g1.id, source: "cex", sourceProductId: "a", sourceTitle: "Super Metroid, Boxed",
        matchScore: 1, status: "confirmed",
      },
      {
        gameId: g2.id, source: "cex", sourceProductId: "b", sourceTitle: "F-Zero, Boxed",
        matchScore: 1, status: "confirmed",
      },
      // g3 deliberately has NO mapping yet.
    ]);
    const refreshed: string[][] = [];
    const adapter = syncAdapter();
    adapter.catalogSync!.refreshItems = async (ids) => void refreshed.push(ids);
    await runTrackedRefresh(db, [adapter], adapter, {});
    // g2 has a real mapping ("b") but is cached_only-skipped before the
    // mappings query even runs; g3 isn't in the mappings query yet either
    // (it has none). Only g1's existing mapping is ever seen by refreshItems.
    expect(refreshed).toEqual([["a"]]);
    const { pricePoints } = await import("../../src/db/schema.js");
    const points = await db.select().from(pricePoints);
    expect(points.some((p) => p.gameId === g1.id && p.kind === "sell")).toBe(true);
    expect(points.some((p) => p.gameId === g2.id)).toBe(false);
    // g3: live search matches box "c" via fuzzy title matching (no pre-seeded
    // mapping), so both a price_points snapshot AND a lazily-created
    // source_mappings row must exist afterward.
    expect(points.some((p) => p.gameId === g3.id && p.kind === "sell")).toBe(true);
    const g3Mappings = await db.select().from(sourceMappings).where(eq(sourceMappings.gameId, g3.id));
    expect(g3Mappings).toHaveLength(1);
    expect(g3Mappings[0].sourceProductId).toBe("c");
  });

  it("gives the snapshot pass to the LAST enabled catalog market, now that no built-in is one", async () => {
    // The last enabled catalog market owns the pass -- and with it the cadence
    // of every cross-source snapshot, eBay Browse quota included. CeX is the
    // only sync plugin and THIS REPOSITORY authors its manifest; approving a
    // sync plugin it does not author would put that plugin's cadence in charge
    // -- the trigger for moving the pass to a repeatable job of its own.
    const { db } = ctx!;
    await saveEnabledSources(db, ["cex", "shop_gb"]);
    await runCatalogSyncAll(db, syncAdapter()); // catalog has box "a"
    const [g1] = await db.insert(games).values({ title: "Super Metroid", platform: "snes" }).returning();
    await db.insert(gameNames).values({ gameId: g1.id, name: "Super Metroid" });
    await db.insert(ownedCopies).values({ gameId: g1.id, region: "PAL", condition: "cib" });
    await db.insert(sourceMappings).values({
      gameId: g1.id, source: "cex", sourceProductId: "a", sourceTitle: "Super Metroid, Boxed",
      matchScore: 1, status: "confirmed",
    });
    const cex = syncAdapter();
    const plugin = stubAdapter({
      source: "shop_gb",
      catalogSync: {
        schedule: { catalogCron: "0 4 * * *", trackedRefreshHours: 1 },
        listSyncUnits: async () => [],
        syncUnit: async () => ({ itemsUpserted: 0, complete: true }),
      },
    });
    const { pricePoints } = await import("../../src/db/schema.js");

    // the FIRST of the two does its detail step and stops there
    await runTrackedRefresh(db, [cex, plugin], cex, PLUGIN_SOURCES);
    expect(await db.select().from(pricePoints)).toEqual([]);

    // the last one does the cross-source snapshot
    await runTrackedRefresh(db, [cex, plugin], plugin, PLUGIN_SOURCES);
    const points = await db.select().from(pricePoints);
    expect(points.some((p) => p.gameId === g1.id && p.kind === "sell")).toBe(true);
  });

  it("continues to snapshot and mark ran when refreshItems throws (controller ruling)", async () => {
    const { db } = ctx!;
    await runCatalogSyncAll(db, syncAdapter()); // catalog has box "a"
    const [g1] = await db.insert(games).values({ title: "Super Metroid", platform: "snes" }).returning();
    await db.insert(gameNames).values({ gameId: g1.id, name: "Super Metroid" });
    await db.insert(ownedCopies).values({ gameId: g1.id, region: "PAL", condition: "cib" });
    await db.insert(sourceMappings).values({
      gameId: g1.id, source: "cex", sourceProductId: "a", sourceTitle: "Super Metroid, Boxed",
      matchScore: 1, status: "confirmed",
    });
    const adapter = syncAdapter();
    adapter.catalogSync!.refreshItems = async () => {
      throw new Error("breaker open"); // e.g. CexBlockedError
    };
    await runTrackedRefresh(db, [adapter], adapter, {});
    // the throw must not cancel the source-agnostic snapshot loop...
    const { pricePoints } = await import("../../src/db/schema.js");
    const points = await db.select().from(pricePoints);
    expect(points.some((p) => p.gameId === g1.id && p.kind === "sell")).toBe(true);
    // ...nor the markRan bookkeeping at the end.
    const ranAt = await loadRanAt(db, "tracked-refresh:cex");
    expect(ranAt).not.toBeNull();
  });
});
