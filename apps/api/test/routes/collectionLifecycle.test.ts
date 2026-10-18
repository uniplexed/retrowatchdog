import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDb } from "../helpers/testDb.js";
import { buildApp } from "../../src/app.js";
import { games, ownedCopies } from "../../src/db/schema.js";
import { stubAdapter } from "../helpers/stubAdapter.js";

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}

describe.skipIf(ctx === null)("collection lifecycle", () => {
  beforeEach(async () => ctx!.truncateAll());
  afterAll(async () => ctx?.pool.end());

  const seedCopy = async (): Promise<number> => {
    const [g] = await ctx!.db.insert(games).values({ title: "Super Metroid", platform: "snes" }).returning();
    const [c] = await ctx!.db
      .insert(ownedCopies)
      // USD acquisition leg: rate 1 by definition, and it doubles as the
      // return-leg currency fallback for the incoming -> returned jump below
      .values({
        gameId: g.id, region: "PAL", condition: "cib",
        acquiredPriceOriginal: "20.00", acquiredCurrency: "USD", acquiredPriceUsd: "20.00",
      })
      .returning();
    return c.id;
  };
  const app = async () => buildApp({ db: ctx!.db, registry: [stubAdapter()] });

  it("records a sale via PATCH, freezing the USD twin at write time", async () => {
    const id = await seedCopy();
    const a = await app();
    const res = await a.inject({
      method: "PATCH", url: `/api/collection/${id}`,
      payload: { status: "sold", soldAt: "2026-08-30", soldPriceOriginal: 40, soldFeesOriginal: 2, soldCurrency: "USD", soldVenue: "cex" },
    });
    expect(res.statusCode).toBe(204);
    const [row] = await ctx!.db.select().from(ownedCopies);
    expect(row.status).toBe("sold");
    expect(Number(row.soldPriceOriginal)).toBe(40);
    expect(row.soldCurrency).toBe("USD");
    expect(Number(row.soldPriceUsd)).toBe(40);
    expect(Number(row.soldFeesUsd)).toBe(2);
    await a.close();
  });

  it("rejects sold without price/date, sold_* fields on a non-sold copy, and sold amounts without a currency", async () => {
    const id = await seedCopy();
    const a = await app();
    expect((await a.inject({ method: "PATCH", url: `/api/collection/${id}`, payload: { status: "sold" } })).statusCode).toBe(400);
    expect((await a.inject({ method: "PATCH", url: `/api/collection/${id}`, payload: { soldPriceOriginal: 40 } })).statusCode).toBe(400);
    // amounts travel with a currency: sold without soldCurrency (none stored either) is a 400
    expect(
      (await a.inject({
        method: "PATCH", url: `/api/collection/${id}`,
        payload: { status: "sold", soldAt: "2026-08-30", soldPriceOriginal: 40 },
      })).statusCode,
    ).toBe(400);
    await a.close();
  });

  it("allows the non-linear incoming -> returned jump (refund converts via the acquisition currency)", async () => {
    const id = await seedCopy();
    const a = await app();
    await a.inject({ method: "PATCH", url: `/api/collection/${id}`, payload: { status: "incoming" } });
    const res = await a.inject({
      method: "PATCH", url: `/api/collection/${id}`,
      payload: { status: "returned", returnedAt: "2026-08-30", refundOriginal: 20 },
    });
    expect(res.statusCode).toBe(204);
    const [row] = await ctx!.db.select().from(ownedCopies);
    // no soldCurrency on a never-sold copy: the acquisition currency (USD) applies
    expect(Number(row.refundUsd)).toBe(20);
    await a.close();
  });

  it("updates physical dimensions and clears with null", async () => {
    const id = await seedCopy();
    const a = await app();
    await a.inject({
      method: "PATCH", url: `/api/collection/${id}`,
      payload: { itemGrade: "near_mint", workingState: "partial", authenticity: "genuine" },
    });
    const res = await a.inject({ method: "PATCH", url: `/api/collection/${id}`, payload: { workingState: null } });
    expect(res.statusCode).toBe(204);
    const [row] = await ctx!.db.select().from(ownedCopies);
    expect(row.itemGrade).toBe("near_mint");
    expect(row.workingState).toBeNull();
    await a.close();
  });

  it("rejects an empty PATCH body and leaves the row unchanged", async () => {
    const id = await seedCopy();
    const a = await app();
    const res = await a.inject({ method: "PATCH", url: `/api/collection/${id}`, payload: {} });
    expect(res.statusCode).toBe(400);
    const [row] = await ctx!.db.select().from(ownedCopies);
    expect(row.status).toBe("owned");
    expect(Number(row.acquiredPriceOriginal)).toBe(20);
    await a.close();
  });

  it("rejects a PATCH with a nonexistent acquisitionId with 400 instead of erroring", async () => {
    const id = await seedCopy();
    const a = await app();
    const res = await a.inject({
      method: "PATCH", url: `/api/collection/${id}`,
      payload: { acquisitionId: 99999 },
    });
    expect(res.statusCode).toBe(400);
    await a.close();
  });

  it("DELETE returns 409 for sold and returned copies", async () => {
    const id = await seedCopy();
    const a = await app();
    await a.inject({
      method: "PATCH", url: `/api/collection/${id}`,
      payload: { status: "sold", soldAt: "2026-08-30", soldPriceOriginal: 40, soldCurrency: "USD" },
    });
    expect((await a.inject({ method: "DELETE", url: `/api/collection/${id}` })).statusCode).toBe(409);
    await a.close();
  });
});
