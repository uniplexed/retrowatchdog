import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDb } from "../helpers/testDb.js";
import { catalogItems } from "../../src/db/schema.js";
import {
  makeBulkSink, makeDetailSink, deleteUnseen, sweepStale, markRan, loadRanAt,
} from "../../src/worker/catalogSink.js";

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}

const item = (id: string) => ({
  sourceProductId: id, title: `Box ${id}`, categoryText: "Super NES Software",
  prices: { sell: "10.00", cash: "4.00", voucher: "6.00" }, currency: "GBP",
});

describe.skipIf(ctx === null)("catalog sink", () => {
  beforeEach(async () => ctx!.truncateAll());
  afterAll(async () => ctx?.pool.end());

  it("bulk sink stamps synced/lastSeen/syncUnit; detail sink preserves them", async () => {
    const { db } = ctx!;
    const run1 = new Date("2026-08-31T03:00:00Z");
    await makeBulkSink(db, "cex", "Super NES Software", run1).upsert([item("a")]);
    const [afterBulk] = await db.select().from(catalogItems);
    expect(afterBulk.syncUnit).toBe("Super NES Software");
    expect(afterBulk.lastSeenAt).toEqual(run1);
    expect(afterBulk.refreshSource).toBe("bulk");

    await makeDetailSink(db, "cex").upsert([{ ...item("a"), prices: { sell: "12.00", cash: "5.00", voucher: "7.00" } }]);
    const [afterDetail] = await db.select().from(catalogItems);
    expect(afterDetail.prices.sell).toBe("12.00");
    expect(afterDetail.refreshSource).toBe("detail");
    expect(afterDetail.lastSeenAt).toEqual(run1); // untouched by detail
    expect(afterDetail.syncUnit).toBe("Super NES Software"); // untouched by detail
    expect(afterDetail.syncedAt.getTime()).toBeGreaterThan(run1.getTime());
  });

  it("deleteUnseen removes only this unit's rows missing from the run", async () => {
    const { db } = ctx!;
    const run1 = new Date("2026-08-31T03:00:00Z");
    await makeBulkSink(db, "cex", "Super NES Software", run1).upsert([item("keep"), item("gone")]);
    await makeBulkSink(db, "cex", "Mega Drive Software", run1).upsert([item("md")]);
    const run2 = new Date("2026-09-01T03:00:00Z");
    await makeBulkSink(db, "cex", "Super NES Software", run2).upsert([item("keep")]);
    const deleted = await deleteUnseen(db, "cex", "Super NES Software", run2);
    expect(deleted).toBe(1);
    const remaining = await db.select().from(catalogItems);
    expect(remaining.map((r) => r.sourceProductId).sort()).toEqual(["keep", "md"]);
  });

  it("sweepStale removes rows not synced for 30 days", async () => {
    const { db } = ctx!;
    const old = new Date(Date.now() - 40 * 86_400_000);
    await makeBulkSink(db, "cex", "Ghost Category", old).upsert([item("ghost")]);
    await makeBulkSink(db, "cex", "Super NES Software", new Date()).upsert([item("fresh")]);
    const swept = await sweepStale(db, "cex");
    expect(swept).toBe(1);
  });

  it("markRan/loadRanAt round-trip and upsert", async () => {
    const { db } = ctx!;
    expect(await loadRanAt(db, "tracked-refresh:cex")).toBeNull();
    await markRan(db, "tracked-refresh:cex", new Date("2026-08-31T07:00:00Z"));
    await markRan(db, "tracked-refresh:cex", new Date("2026-08-31T11:00:00Z"));
    expect((await loadRanAt(db, "tracked-refresh:cex"))?.toISOString()).toBe("2026-08-31T11:00:00.000Z");
  });

  it("upsert([]) is a no-op that never throws", async () => {
    const { db } = ctx!;
    await expect(
      makeBulkSink(db, "cex", "Super NES Software", new Date()).upsert([]),
    ).resolves.toBeUndefined();
    const remaining = await db.select().from(catalogItems);
    expect(remaining).toEqual([]);
  });

  it("stores observedAt, conditionText and sampleSizes, and a later upsert replaces them", async () => {
    const { db } = ctx!;
    const run = new Date("2026-09-17T03:00:00Z");
    const seen = new Date("2026-09-16T21:30:00Z");
    await makeBulkSink(db, "cex", "Unit", run).upsert([
      { ...item("a"), observedAt: seen, conditionText: "Very good", sampleSizes: { sell: 12 } },
    ]);
    const [first] = await db.select().from(catalogItems);
    expect(first.observedAt).toEqual(seen);
    expect(first.conditionText).toBe("Very good");
    expect(first.sampleSizes).toEqual({ sell: 12 });

    // a row that stops sending them must not keep yesterday's values
    await makeBulkSink(db, "cex", "Unit", run).upsert([item("a")]);
    const [second] = await db.select().from(catalogItems);
    expect(second.observedAt).toBeNull();
    expect(second.conditionText).toBeNull();
    expect(second.sampleSizes).toBeNull();

    await makeDetailSink(db, "cex").upsert([{ ...item("a"), conditionText: "Boxed" }]);
    const [third] = await db.select().from(catalogItems);
    expect(third.conditionText).toBe("Boxed");
  });
});
