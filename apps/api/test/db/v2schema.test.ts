import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { setupTestDb } from "../helpers/testDb.js";
import { catalogItems, watchlist, ownedCopies, syncState, acquisitions, games } from "../../src/db/schema.js";

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null; // no local Postgres: suite self-skips below
}

describe.skipIf(ctx === null)("v2 schema", () => {
  beforeEach(async () => ctx!.truncateAll());
  afterAll(async () => ctx?.pool.end());

  it("catalog_items upserts on the composite natural key", async () => {
    const { db } = ctx!;
    const row = {
      source: "cex",
      sourceProductId: "045496830144C",
      title: "Super Mario Kart, Unboxed",
      categoryText: "Super NES Software",
      prices: { sell: "15.00", cash: "6.00", voucher: "9.00" },
      currency: "GBP",
      available: true,
      syncedAt: new Date("2026-08-31T03:00:00Z"),
      lastSeenAt: new Date("2026-08-31T03:00:00Z"),
      refreshSource: "bulk",
      syncUnit: "Super NES Software",
    };
    await db.insert(catalogItems).values(row);
    await db
      .insert(catalogItems)
      .values({ ...row, prices: { sell: "18.00", cash: "7.00", voucher: "10.00" } })
      .onConflictDoUpdate({
        target: [catalogItems.source, catalogItems.sourceProductId],
        set: { prices: { sell: "18.00", cash: "7.00", voucher: "10.00" } },
      });
    const rows = await db.select().from(catalogItems);
    expect(rows).toHaveLength(1);
    expect(rows[0].prices.sell).toBe("18.00");
  });

  it("watchlist UNIQUE treats NULLs as equal (NULLS NOT DISTINCT)", async () => {
    const { db } = ctx!;
    const [g] = await db
      .insert(games)
      .values({ title: "Chrono Trigger", platform: "snes" })
      .returning({ id: games.id });
    await db.insert(watchlist).values({ gameId: g.id });
    await expect(db.insert(watchlist).values({ gameId: g.id })).rejects.toThrow();
  });

  it("owned_copies backfills status 'owned' and stores lifecycle columns", async () => {
    const { db } = ctx!;
    const [g] = await db
      .insert(games)
      .values({ title: "Super Metroid", platform: "snes" })
      .returning({ id: games.id });
    const [copy] = await db
      .insert(ownedCopies)
      .values({ gameId: g.id, region: "PAL", condition: "loose" })
      .returning();
    expect(copy.status).toBe("owned");
    await db
      .update(ownedCopies)
      .set({
        status: "sold", soldAt: "2026-08-30",
        soldPriceOriginal: "40.00", soldFeesOriginal: "2.00", soldCurrency: "GBP",
        soldPriceUsd: "50.00", soldFeesUsd: "2.50",
      })
      .where(sql`${ownedCopies.id} = ${copy.id}`);
    const [updated] = await db.select().from(ownedCopies);
    expect(updated.status).toBe("sold");
    expect(Number(updated.soldPriceOriginal)).toBe(40);
    expect(updated.soldCurrency).toBe("GBP");
    expect(Number(updated.soldPriceUsd)).toBe(50);
  });

  it("sync_state and acquisitions round-trip", async () => {
    const { db } = ctx!;
    await db.insert(syncState).values({ key: "catalog-sync:cex:Super NES Software", ranAt: new Date() });
    const [acq] = await db
      .insert(acquisitions)
      .values({ totalPriceOriginal: "40.00", totalCurrency: "GBP", totalPriceUsd: "50.00", source: "car_boot" })
      .returning({ id: acquisitions.id });
    expect(acq.id).toBeGreaterThan(0);
  });

  it("price_points accepts observed_at", async () => {
    const { db } = ctx!;
    const [g] = await db
      .insert(games)
      .values({ title: "F-Zero", platform: "snes" })
      .returning({ id: games.id });
    const { pricePoints } = await import("../../src/db/schema.js");
    await db.insert(pricePoints).values({
      gameId: g.id, source: "cex", region: "PAL", condition: "loose", kind: "sell",
      priceUsd: "18.75", priceOriginal: "15.00", currencyOriginal: "GBP",
      fetchedAt: new Date(), observedAt: new Date("2026-08-31T03:00:00Z"),
    });
    const [row] = await db.select().from(pricePoints);
    expect(row.observedAt).toBeInstanceOf(Date);
  });

  it("price_points stores a nullable grade (v2: cosmetic grade dimension)", async () => {
    const { db } = ctx!;
    const [g] = await db
      .insert(games)
      .values({ title: "Metal Gear Solid", platform: "ps1" })
      .returning({ id: games.id });
    const { pricePoints } = await import("../../src/db/schema.js");
    await db.insert(pricePoints).values([
      {
        gameId: g.id, source: "cex", region: "PAL", condition: "cib", grade: "mint", kind: "sell",
        priceUsd: "40.00", priceOriginal: "40.00", currencyOriginal: "GBP", fetchedAt: new Date(),
      },
      {
        gameId: g.id, source: "cex", region: "PAL", condition: "loose", kind: "sell",
        priceUsd: "15.00", priceOriginal: "15.00", currencyOriginal: "GBP", fetchedAt: new Date(),
      },
    ]);
    const rows = await db.select().from(pricePoints).orderBy(pricePoints.priceUsd);
    expect(rows.find((r) => r.condition === "loose")?.grade).toBeNull();
    expect(rows.find((r) => r.condition === "cib")?.grade).toBe("mint");
  });

  it("0007 price_availability: price_points stores a nullable available flag", async () => {
    const { db } = ctx!;
    const [g] = await db
      .insert(games)
      .values({ title: "Final Fantasy Tactics Advance", platform: "gba" })
      .returning({ id: games.id });
    const { pricePoints } = await import("../../src/db/schema.js");
    const base = {
      gameId: g.id, source: "cex", region: "PAL", condition: "cib", kind: "sell",
      priceUsd: "42.00", priceOriginal: "42.00", currencyOriginal: "GBP", fetchedAt: new Date(),
    };
    await db.insert(pricePoints).values([
      { ...base, listingTitle: "in stock", available: true },
      { ...base, listingTitle: "out of stock", available: false },
      // legacy/aggregate rows carry no flag at all
      { ...base, listingTitle: "unknown" },
    ]);
    const rows = await db.select().from(pricePoints);
    expect(rows.find((r) => r.listingTitle === "in stock")?.available).toBe(true);
    expect(rows.find((r) => r.listingTitle === "out of stock")?.available).toBe(false);
    expect(rows.find((r) => r.listingTitle === "unknown")?.available).toBeNull();
  });

  // usd-core migration 0005: renamed/added money columns present, *_gbp gone,
  // fx_overrides created. The wipe itself is exercised implicitly: migrate()
  // ran against a test DB that previously carried GBP-era rows.
  it("0005 usd_base: USD columns and fx_overrides exist, *_gbp columns are gone", async () => {
    const { pool } = ctx!;
    const cols = async (table: string): Promise<string[]> => {
      const res = await pool.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = $1",
        [table],
      );
      return res.rows.map((r: { column_name: string }) => r.column_name);
    };
    expect(await cols("price_points")).toContain("price_usd");
    expect(await cols("price_points")).not.toContain("price_gbp");
    const copies = await cols("owned_copies");
    for (const c of [
      "acquired_price_original", "acquired_currency", "acquired_price_usd",
      "sold_price_original", "sold_fees_original", "sold_currency", "sold_price_usd", "sold_fees_usd",
      "refund_original", "return_costs_original", "refund_usd", "return_costs_usd",
    ]) expect(copies).toContain(c);
    expect(copies.some((c) => c.endsWith("_gbp"))).toBe(false);
    const watch = await cols("watchlist");
    expect(watch).toEqual(expect.arrayContaining(["target_price_original", "target_currency", "target_price_usd"]));
    const acq = await cols("acquisitions");
    expect(acq).toEqual(expect.arrayContaining(["total_price_original", "total_currency", "total_price_usd"]));
    expect(await cols("fx_overrides")).toEqual(
      expect.arrayContaining(["currency", "mode", "manual_rate"]),
    );
  });

  it("fx_overrides round-trips with mode defaulting to 'auto'", async () => {
    const { db } = ctx!;
    const { fxOverrides } = await import("../../src/db/schema.js");
    const [row] = await db.insert(fxOverrides).values({ currency: "GBP" }).returning();
    expect(row.mode).toBe("auto");
    expect(row.manualRate).toBeNull();
    await db
      .update(fxOverrides)
      .set({ mode: "manual", manualRate: "0.79" })
      .where(sql`${fxOverrides.currency} = 'GBP'`);
    const [updated] = await db.select().from(fxOverrides);
    expect(updated.mode).toBe("manual");
    expect(Number(updated.manualRate)).toBe(0.79);
  });
});
