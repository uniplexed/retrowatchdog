import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import type { CollectionResponse } from "@retrowatchdog/shared";
import { setupTestDb } from "../helpers/testDb.js";
import { buildApp } from "../../src/app.js";
import { games, ownedCopies } from "../../src/db/schema.js";
import { resetFxCacheForTests } from "../../src/pricing/fx.js";
import { stubAdapter } from "../helpers/stubAdapter.js";

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}

// Multi-currency write-time conversion legs (usd-core Part 3). Non-1 rates on
// purpose: EUR->USD 1.1 and GBP->USD 1.25, so a missing/inverted conversion
// cannot hide.
describe.skipIf(ctx === null)("collection multi-currency legs", () => {
  let agent: MockAgent;
  let prevDispatcher: ReturnType<typeof getGlobalDispatcher>;
  // Mutable mocked rates: the reply callbacks read these at dispatch time, so
  // a test can move "today's rate" mid-flight (undici keeps serving the FIRST
  // persisted interceptor, so re-registering an intercept would never win).
  // Pair a change with resetFxCacheForTests() to defeat the 24h fx cache.
  let eurToUsd = 1.1;
  let gbpToUsd = 1.25;

  beforeEach(async () => {
    prevDispatcher = getGlobalDispatcher();
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    resetFxCacheForTests();
    eurToUsd = 1.1;
    gbpToUsd = 1.25;
    const pool = agent.get("https://api.frankfurter.app");
    pool
      .intercept({ path: "/latest?from=EUR&to=USD", method: "GET" })
      .reply(200, () => ({ rates: { USD: eurToUsd } }))
      .persist();
    pool
      .intercept({ path: "/latest?from=GBP&to=USD", method: "GET" })
      .reply(200, () => ({ rates: { USD: gbpToUsd } }))
      .persist();
    await ctx!.truncateAll();
  });
  afterEach(async () => {
    setGlobalDispatcher(prevDispatcher);
    await agent.close();
    resetFxCacheForTests();
  });
  afterAll(async () => ctx?.pool.end());

  const app = async () => buildApp({ db: ctx!.db, registry: [stubAdapter()] });
  const seedGame = async (): Promise<number> => {
    const [g] = await ctx!.db.insert(games).values({ title: "Super Metroid", platform: "snes" }).returning();
    return g.id;
  };

  it("EUR acquisition stores the verbatim original and a frozen USD twin", async () => {
    const gid = await seedGame();
    const a = await app();
    const res = await a.inject({
      method: "POST",
      url: "/api/collection",
      payload: { gameId: gid, region: "PAL", condition: "cib", acquiredPriceOriginal: 25, acquiredCurrency: "EUR" },
    });
    expect(res.statusCode).toBe(201);
    const [row] = await ctx!.db.select().from(ownedCopies);
    expect(Number(row.acquiredPriceOriginal)).toBe(25); // verbatim
    expect(row.acquiredCurrency).toBe("EUR");
    expect(Number(row.acquiredPriceUsd)).toBe(27.5); // 25 * 1.1, frozen

    // FROZEN means frozen: even after the cached rate changes, reads serve
    // the stored USD twin — nothing is ever re-derived from originals.
    eurToUsd = 2;
    resetFxCacheForTests();
    const body = (await a.inject({ method: "GET", url: "/api/collection" })).json() as CollectionResponse;
    expect(body.items[0].acquiredPriceOriginal).toBe(25);
    expect(body.items[0].acquiredCurrency).toBe("EUR");
    expect(body.items[0].acquiredPriceUsd).toBe(27.5);
    await a.close();
  });

  it("400s an acquisition amount without its currency", async () => {
    const gid = await seedGame();
    const a = await app();
    const res = await a.inject({
      method: "POST",
      url: "/api/collection",
      payload: { gameId: gid, region: "PAL", condition: "cib", acquiredPriceOriginal: 25 },
    });
    expect(res.statusCode).toBe(400);
    await a.close();
  });

  it("sale in a third currency: realized P&L nets the two frozen USD legs (buy EUR, sell GBP)", async () => {
    const gid = await seedGame();
    const a = await app();
    const created = await a.inject({
      method: "POST",
      url: "/api/collection",
      payload: { gameId: gid, region: "PAL", condition: "cib", acquiredPriceOriginal: 25, acquiredCurrency: "EUR" },
    });
    const { id } = created.json() as { id: number };
    const patched = await a.inject({
      method: "PATCH",
      url: `/api/collection/${id}`,
      payload: { status: "sold", soldAt: "2026-09-01", soldPriceOriginal: 40, soldFeesOriginal: 2, soldCurrency: "GBP" },
    });
    expect(patched.statusCode).toBe(204);
    const body = (await a.inject({ method: "GET", url: "/api/collection" })).json() as CollectionResponse;
    const item = body.items[0];
    expect(item.soldPriceOriginal).toBe(40);
    expect(item.soldCurrency).toBe("GBP");
    expect(item.soldPriceUsd).toBe(50); // 40 * 1.25
    expect(item.soldFeesUsd).toBe(2.5); // one currency covers price+fees
    // realized = 50 - 2.5 - 27.5, each leg frozen at its own write
    expect(body.totalRealizedUsd).toBe(20);
    await a.close();
  });

  it("FX down at write time is a 503 and stores NOTHING (never a guessed rate)", async () => {
    const gid = await seedGame();
    const a = await app();
    // CHF has no intercept and net connect is disabled: the FX fetch fails hard
    const res = await a.inject({
      method: "POST",
      url: "/api/collection",
      payload: { gameId: gid, region: "PAL", condition: "cib", acquiredPriceOriginal: 30, acquiredCurrency: "CHF" },
    });
    expect(res.statusCode).toBe(503);
    expect(await ctx!.db.select().from(ownedCopies)).toHaveLength(0);
    await a.close();
  });

  it("FX down fails a sale PATCH with 503 and leaves the copy untouched", async () => {
    const gid = await seedGame();
    const a = await app();
    const { id } = (
      await a.inject({ method: "POST", url: "/api/collection", payload: { gameId: gid, region: "PAL", condition: "cib" } })
    ).json() as { id: number };
    const res = await a.inject({
      method: "PATCH",
      url: `/api/collection/${id}`,
      payload: { status: "sold", soldAt: "2026-09-01", soldPriceOriginal: 40, soldCurrency: "CHF" },
    });
    expect(res.statusCode).toBe(503);
    const [row] = await ctx!.db.select().from(ownedCopies);
    expect(row.status).toBe("owned");
    expect(row.soldPriceOriginal).toBeNull();
    await a.close();
  });

  // Frozen-leg PATCH semantics (controller ruling): a component's USD twin is
  // recomputed only when its own original is in the patch or its denominating
  // currency changes in the patch — never because a sibling was corrected.
  it("patching only soldFees does NOT re-freeze soldPriceUsd at today's rate", async () => {
    const gid = await seedGame();
    const a = await app();
    const { id } = (
      await a.inject({ method: "POST", url: "/api/collection", payload: { gameId: gid, region: "PAL", condition: "cib" } })
    ).json() as { id: number };
    await a.inject({
      method: "PATCH",
      url: `/api/collection/${id}`,
      payload: { status: "sold", soldAt: "2026-09-01", soldPriceOriginal: 40, soldCurrency: "GBP" },
    });
    // the rate moves after the sale was frozen at 1.25 (£40 -> $50)
    gbpToUsd = 1.3;
    resetFxCacheForTests();
    const res = await a.inject({
      method: "PATCH",
      url: `/api/collection/${id}`,
      payload: { soldFeesOriginal: 3 },
    });
    expect(res.statusCode).toBe(204);
    const item = ((await a.inject({ method: "GET", url: "/api/collection" })).json() as CollectionResponse).items[0];
    expect(item.soldPriceOriginal).toBe(40);
    expect(item.soldPriceUsd).toBe(50); // STILL the freeze from the sale write
    expect(item.soldFeesUsd).toBe(3.9); // only the patched component uses 1.3
    await a.close();
  });

  it("changing soldCurrency re-freezes all four components it denominates from stored originals", async () => {
    const gid = await seedGame();
    const a = await app();
    const { id } = (
      await a.inject({
        method: "POST",
        url: "/api/collection",
        payload: { gameId: gid, region: "PAL", condition: "cib", acquiredPriceOriginal: 25, acquiredCurrency: "EUR" },
      })
    ).json() as { id: number };
    await a.inject({
      method: "PATCH",
      url: `/api/collection/${id}`,
      payload: { status: "sold", soldAt: "2026-09-01", soldPriceOriginal: 40, soldFeesOriginal: 2, soldCurrency: "GBP" },
    });
    // Return amounts frozen under GBP, seeded directly: the route only accepts
    // returned_* fields while status is 'returned', and soldCurrency patches
    // only while 'sold' — this simulates the stored aftermath of both.
    await ctx!.db
      .update(ownedCopies)
      .set({ refundOriginal: "40", returnCostsOriginal: "5", refundUsd: "50", returnCostsUsd: "6.25" })
      .where(eq(ownedCopies.id, id));
    const res = await a.inject({
      method: "PATCH",
      url: `/api/collection/${id}`,
      payload: { soldCurrency: "EUR" },
    });
    expect(res.statusCode).toBe(204);
    const item = ((await a.inject({ method: "GET", url: "/api/collection" })).json() as CollectionResponse).items[0];
    // the currency correction reinterprets the stored originals: all four
    // twins re-freeze at the EUR rate (1.1); originals stay verbatim
    expect(item.soldCurrency).toBe("EUR");
    expect(item.soldPriceUsd).toBe(44); // 40 * 1.1
    expect(item.soldFeesUsd).toBe(2.2);
    expect(item.refundUsd).toBe(44);
    expect(item.returnCostsUsd).toBe(5.5);
    // acquiredCurrency denominates the acquisition leg only: untouched
    expect(item.acquiredPriceUsd).toBe(27.5);
    await a.close();
  });

  it("sale patches never touch the acquisition leg's frozen USD", async () => {
    const gid = await seedGame();
    const a = await app();
    const { id } = (
      await a.inject({
        method: "POST",
        url: "/api/collection",
        payload: { gameId: gid, region: "PAL", condition: "cib", acquiredPriceOriginal: 25, acquiredCurrency: "EUR" },
      })
    ).json() as { id: number };
    // EUR doubles after the buy was frozen at 1.1 (25 EUR -> $27.50)
    eurToUsd = 2;
    resetFxCacheForTests();
    const res = await a.inject({
      method: "PATCH",
      url: `/api/collection/${id}`,
      payload: { status: "sold", soldAt: "2026-09-01", soldPriceOriginal: 40, soldFeesOriginal: 2, soldCurrency: "GBP" },
    });
    expect(res.statusCode).toBe(204);
    const item = ((await a.inject({ method: "GET", url: "/api/collection" })).json() as CollectionResponse).items[0];
    expect(item.acquiredPriceOriginal).toBe(25);
    expect(item.acquiredPriceUsd).toBe(27.5); // not re-derived at rate 2
    expect(item.soldPriceUsd).toBe(50); // the sale leg froze normally
    await a.close();
  });

  it("EUR lot acquisition freezes totalPriceUsd and totals use it", async () => {
    const gid = await seedGame();
    const a = await app();
    const acq = (
      await a.inject({
        method: "POST",
        url: "/api/acquisitions",
        payload: { totalPriceOriginal: 100, totalCurrency: "EUR", source: "marketplace" },
      })
    ).json() as { id: number };
    await ctx!.db.insert(ownedCopies).values([
      { gameId: gid, region: "PAL", condition: "loose", acquisitionId: acq.id },
    ]);
    const body = (await a.inject({ method: "GET", url: "/api/collection" })).json() as CollectionResponse;
    expect(body.totalPaidUsd).toBe(110); // 100 EUR * 1.1, frozen at the lot write
    await a.close();
  });
});
