import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { StoreQuoteDto } from "@retrowatchdog/shared";
import { setupTestDb } from "../helpers/testDb.js";
import { buildApp } from "../../src/app.js";
import { games, pricePoints, watchlist } from "../../src/db/schema.js";
import { stubAdapter } from "../helpers/stubAdapter.js";
import { saveEnabledSources } from "../../src/settings/markets.js";
import { seedCexPlugin } from "../helpers/seedCexPlugin.js";

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}

describe.skipIf(ctx === null)("watchlist routes", () => {
  beforeEach(async () => {
    await ctx!.truncateAll();
    // CeX's three shops reach the registry only through an approved plugin row.
    await seedCexPlugin(ctx!.db);
  });
  afterAll(async () => ctx?.pool.end());
  const app = async () => buildApp({ db: ctx!.db, registry: [stubAdapter()] });

  const seedGameWithPrices = async () => {
    const [g] = await ctx!.db.insert(games).values({ title: "Super Metroid", platform: "snes" }).returning();
    const fetchedAt = new Date();
    await ctx!.db.insert(pricePoints).values([
      { gameId: g.id, source: "cex", region: "PAL", condition: "cib", kind: "sell", priceUsd: "60.00", priceOriginal: "60.00", currencyOriginal: "GBP", fetchedAt },
      { gameId: g.id, source: "cex", region: "PAL", condition: "cib", kind: "cash", priceUsd: "30.00", priceOriginal: "30.00", currencyOriginal: "GBP", fetchedAt },
      { gameId: g.id, source: "cex", region: "PAL", condition: "loose", kind: "sell", priceUsd: "25.00", priceOriginal: "25.00", currencyOriginal: "GBP", fetchedAt },
      { gameId: g.id, source: "cex", region: "PAL", condition: "loose", kind: "cash", priceUsd: "12.00", priceOriginal: "12.00", currencyOriginal: "GBP", fetchedAt },
    ]);
    return g.id;
  };

  it("POST twice with the same NULL dimensions returns 409", async () => {
    const gid = await seedGameWithPrices();
    const a = await app();
    expect((await a.inject({ method: "POST", url: "/api/watchlist", payload: { gameId: gid } })).statusCode).toBe(201);
    expect((await a.inject({ method: "POST", url: "/api/watchlist", payload: { gameId: gid } })).statusCode).toBe(409);
    await a.close();
  });

  it("GET aggregates: NULL = any, cheapest matching sell + sibling cash", async () => {
    const gid = await seedGameWithPrices();
    const a = await app();
    await a.inject({ method: "POST", url: "/api/watchlist", payload: { gameId: gid } });
    const body = (await a.inject({ method: "GET", url: "/api/watchlist" })).json();
    expect(body.items).toHaveLength(1);
    // renamed from storeSellUsd/storeCashUsd (CeX's own kind vocabulary) to
    // storeOffer/storeBids, keyed on role: with three CeX countries the pair
    // is one SHOP's, and the shop it came from is named beside it
    expect(body.items[0].storeOffer.priceUsd).toBe(25);  // cheapest matching sell (loose)
    expect(body.items[0].storeBids.map((b: StoreQuoteDto) => b.priceUsd)).toEqual([12]);  // its sibling cash bid
    expect(body.items[0].storeSource).toBe("cex");
    await a.close();
  });

  it("GET reports the cheapest IN-STOCK sell: an out-of-stock cheaper SKU is not an offer (R4)", async () => {
    const gid = await seedGameWithPrices();
    // same batch as the seed: only the latest fetched_at batch is served
    const [{ fetchedAt }] = await ctx!.db
      .select({ fetchedAt: pricePoints.fetchedAt })
      .from(pricePoints)
      .where(eq(pricePoints.gameId, gid))
      .limit(1);
    await ctx!.db.insert(pricePoints).values([
      // cheaper than every seeded sell, but CeX has none: must not become storeSellUsd
      { gameId: gid, source: "cex", region: "PAL", condition: "loose", kind: "sell", priceUsd: "9.00", priceOriginal: "9.00", currencyOriginal: "GBP", available: false, fetchedAt },
    ]);
    const a = await app();
    await a.inject({ method: "POST", url: "/api/watchlist", payload: { gameId: gid } });
    const body = (await a.inject({ method: "GET", url: "/api/watchlist" })).json();
    expect(body.items[0].storeOffer.priceUsd).toBe(25); // the in-stock (flag unknown) loose sell, not the £9 out-of-stock one
    expect(body.items[0].storeBids.map((b: StoreQuoteDto) => b.priceUsd)).toEqual([12]); // sibling cash bid of the reported offer
    await a.close();
  });

  it("the store pair comes from ONE shop, and the row names which", async () => {
    // Two CeX countries hold the same game at different prices. The reported
    // sell and the cash beside it are a buy/sell spread the user acts on, so
    // they must be the same shop's — pairing Spain's sell with the UK's cash
    // would invent a spread neither shop quotes — and the row must say which
    // shop, since "CeX sells $45 / pays cash $30" is a different fact in each
    // country.
    const gid = await seedGameWithPrices(); // cex: loose sell 25, cash 12
    const fetchedAt = new Date();
    await ctx!.db.insert(pricePoints).values([
      { gameId: gid, source: "cex_es", region: "PAL", condition: "loose", kind: "sell", priceUsd: "18.00", priceOriginal: "16.00", currencyOriginal: "EUR", fetchedAt },
      { gameId: gid, source: "cex_es", region: "PAL", condition: "loose", kind: "cash", priceUsd: "8.00", priceOriginal: "7.00", currencyOriginal: "EUR", fetchedAt },
    ]);
    await saveEnabledSources(ctx!.db, ["cex", "cex_es"]);
    const a = await buildApp({
      db: ctx!.db,
      registry: [stubAdapter(), stubAdapter({ source: "cex_es" })],
    });
    await a.inject({ method: "POST", url: "/api/watchlist", payload: { gameId: gid } });
    const body = (await a.inject({ method: "GET", url: "/api/watchlist" })).json();
    expect(body.items[0].storeOffer.priceUsd).toBe(18); // Spain is cheapest
    expect(body.items[0].storeBids.map((b: StoreQuoteDto) => b.priceUsd)).toEqual([8]); // Spain's own cash bid, not the UK's 12
    expect(body.items[0].storeSource).toBe("cex_es");
    await a.close();
  });

  it("a condition-scoped row only matches that condition", async () => {
    const gid = await seedGameWithPrices();
    const a = await app();
    await a.inject({ method: "POST", url: "/api/watchlist", payload: { gameId: gid, condition: "cib" } });
    const body = (await a.inject({ method: "GET", url: "/api/watchlist" })).json();
    expect(body.items[0].storeOffer.priceUsd).toBe(60);
    await a.close();
  });

  it("stores a target as {original, currency, frozen usd} and echoes all three", async () => {
    const gid = await seedGameWithPrices();
    const a = await app();
    // USD target: rate 1 by definition, no FX call involved
    const res = await a.inject({
      method: "POST", url: "/api/watchlist",
      payload: { gameId: gid, condition: "loose", targetPriceOriginal: 30, targetCurrency: "USD" },
    });
    expect(res.statusCode).toBe(201);
    const body = (await a.inject({ method: "GET", url: "/api/watchlist" })).json();
    expect(body.items[0].targetPriceOriginal).toBe(30);
    expect(body.items[0].targetCurrency).toBe("USD");
    expect(body.items[0].targetPriceUsd).toBe(30);
    await a.close();
  });

  it("PATCH narrows a watch, sets and clears its target, and 409s onto an existing combination", async () => {
    const gid = await seedGameWithPrices();
    const a = await app();
    const post = (payload: object) => a.inject({ method: "POST", url: "/api/watchlist", payload });
    const { id } = (await post({ gameId: gid })).json() as { id: number };
    await post({ gameId: gid, region: "PAL", condition: "cib" });
    const patch = (payload: object) => a.inject({ method: "PATCH", url: `/api/watchlist/${id}`, payload });

    expect((await patch({ region: "PAL", condition: "loose", targetPriceOriginal: 20, targetCurrency: "USD" })).statusCode).toBe(200);
    let [row] = await ctx!.db.select().from(watchlist).where(eq(watchlist.id, id));
    expect([row.region, row.condition, row.targetPriceOriginal, row.targetCurrency, row.targetPriceUsd])
      .toEqual(["PAL", "loose", "20.00", "USD", "20.00"]);

    // null clears: the target together, a dimension back to "any"
    expect((await patch({ targetPriceOriginal: null, targetCurrency: null, condition: null })).statusCode).toBe(200);
    [row] = await ctx!.db.select().from(watchlist).where(eq(watchlist.id, id));
    expect([row.condition, row.targetPriceOriginal, row.targetCurrency, row.targetPriceUsd]).toEqual([null, null, null, null]);

    expect((await patch({ condition: "cib" })).statusCode).toBe(409);
    expect((await patch({ targetPriceOriginal: 5 })).statusCode).toBe(400);
    expect((await patch({})).statusCode).toBe(400);
    expect((await a.inject({ method: "PATCH", url: "/api/watchlist/999999", payload: { region: null } })).statusCode).toBe(404);
    await a.close();
  });

  it("400s a target amount without its currency (and vice versa)", async () => {
    const gid = await seedGameWithPrices();
    const a = await app();
    expect(
      (await a.inject({ method: "POST", url: "/api/watchlist", payload: { gameId: gid, targetPriceOriginal: 30 } }))
        .statusCode,
    ).toBe(400);
    expect(
      (await a.inject({ method: "POST", url: "/api/watchlist", payload: { gameId: gid, targetCurrency: "EUR" } }))
        .statusCode,
    ).toBe(400);
    await a.close();
  });

  it("DELETE /api/watchlist clears everything and returns the count", async () => {
    const gid = await seedGameWithPrices();
    const a = await app();
    await a.inject({ method: "POST", url: "/api/watchlist", payload: { gameId: gid } });
    await a.inject({ method: "POST", url: "/api/watchlist", payload: { gameId: gid, condition: "cib" } });
    await a.inject({ method: "POST", url: "/api/watchlist", payload: { gameId: gid, condition: "loose" } });

    const res = await a.inject({ method: "DELETE", url: "/api/watchlist" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: 3 });
    expect(await ctx!.db.select().from(watchlist)).toHaveLength(0);

    // idempotent: an empty table clears zero rows, no error
    const again = await a.inject({ method: "DELETE", url: "/api/watchlist" });
    expect(again.json()).toEqual({ deleted: 0 });
    await a.close();
  });

  it("DELETE /api/watchlist rejects any query param with 400 and deletes nothing", async () => {
    const gid = await seedGameWithPrices();
    const a = await app();
    await a.inject({ method: "POST", url: "/api/watchlist", payload: { gameId: gid } });

    // a client sending ?gameId=7 expects a scoped delete this endpoint does
    // not offer — it must fail loudly, never silently wipe everything
    const res = await a.inject({ method: "DELETE", url: "/api/watchlist?gameId=7" });
    expect(res.statusCode).toBe(400);
    expect(await ctx!.db.select().from(watchlist)).toHaveLength(1);

    // the bare wipe still clears everything
    const wipe = await a.inject({ method: "DELETE", url: "/api/watchlist" });
    expect(wipe.statusCode).toBe(200);
    expect(wipe.json()).toEqual({ deleted: 1 });
    expect(await ctx!.db.select().from(watchlist)).toHaveLength(0);
    await a.close();
  });

  it("DELETE removes the watch", async () => {
    const gid = await seedGameWithPrices();
    const a = await app();
    const { id } = (await a.inject({ method: "POST", url: "/api/watchlist", payload: { gameId: gid } })).json();
    expect((await a.inject({ method: "DELETE", url: `/api/watchlist/${id}` })).statusCode).toBe(204);
    expect((await a.inject({ method: "DELETE", url: `/api/watchlist/${id}` })).statusCode).toBe(404);
    await a.close();
  });

  it("names every payout the winning shop quotes, not just its cash one", async () => {
    // No `seedWatch`/`seedPoints` helper exists in this file — none of the
    // other tests here name one either. This mirrors the file's own idiom:
    // a fresh game, price_points inserted directly, then POST + GET.
    const [g] = await ctx!.db.insert(games).values({ title: "Chrono Trigger", platform: "snes" }).returning();
    const fetchedAt = new Date();
    await ctx!.db.insert(pricePoints).values([
      { gameId: g.id, source: "cex", region: "PAL", condition: "cib", kind: "sell", priceUsd: "45.00", priceOriginal: "36.00", currencyOriginal: "GBP", fetchedAt },
      { gameId: g.id, source: "cex", region: "PAL", condition: "cib", kind: "cash", priceUsd: "12.00", priceOriginal: "10.00", currencyOriginal: "GBP", fetchedAt },
      { gameId: g.id, source: "cex", region: "PAL", condition: "cib", kind: "voucher", priceUsd: "18.00", priceOriginal: "14.00", currencyOriginal: "GBP", fetchedAt },
    ]);
    const a = await app();
    await a.inject({ method: "POST", url: "/api/watchlist", payload: { gameId: g.id } });
    const res = await a.inject({ method: "GET", url: "/api/watchlist" });
    const item = res.json().items[0];
    expect(item.storeSource).toBe("cex");
    expect(item.storeOffer.priceUsd).toBe(45);
    expect(item.storeBids.map((b: StoreQuoteDto) => [b.kind, b.priceUsd])).toEqual([
      ["cash", 12],
      ["voucher", 18],
    ]);
    expect(item.storeBids.map((b: StoreQuoteDto) => b.label)).toEqual([
      "CeX UK pays cash",
      "CeX UK pays voucher",
    ]);
    await a.close();
  });

  it("keeps a bid even when the shop's own row is flagged out of stock (R4, one-sided)", async () => {
    // The availability gate is deliberately one-sided: an out-of-stock SKU is
    // not an OFFER, but the shop still BUYS it, so the gate must never reach
    // the bids — only the offer side.
    const [g] = await ctx!.db.insert(games).values({ title: "Super Mario Kart", platform: "snes" }).returning();
    const fetchedAt = new Date();
    await ctx!.db.insert(pricePoints).values([
      { gameId: g.id, source: "cex", region: "PAL", condition: "cib", kind: "sell", priceUsd: "40.00", priceOriginal: "32.00", currencyOriginal: "GBP", fetchedAt },
      { gameId: g.id, source: "cex", region: "PAL", condition: "cib", kind: "cash", priceUsd: "11.00", priceOriginal: "9.00", currencyOriginal: "GBP", available: false, fetchedAt },
    ]);
    const a = await app();
    await a.inject({ method: "POST", url: "/api/watchlist", payload: { gameId: g.id } });
    const res = await a.inject({ method: "GET", url: "/api/watchlist" });
    const item = res.json().items[0];
    expect(item.storeOffer.priceUsd).toBe(40);
    expect(item.storeBids.map((b: StoreQuoteDto) => b.priceUsd)).toEqual([11]);
    await a.close();
  });

  it("collapses duplicate bids of the same kind to the highest amount (a per_listing shop writes one row per box)", async () => {
    // CeX is a per_listing source: several confirmed boxes of the same game,
    // region and condition each write their own `cash` row in one batch. The
    // route must keep ONE bid per kind — the highest, the same rule
    // computeSignals.ts already applies to bids — not both, which would
    // render as two "CeX UK pays cash" lines with different amounts.
    const [g] = await ctx!.db.insert(games).values({ title: "Donkey Kong Country", platform: "snes" }).returning();
    const fetchedAt = new Date();
    await ctx!.db.insert(pricePoints).values([
      { gameId: g.id, source: "cex", region: "PAL", condition: "cib", kind: "sell", priceUsd: "40.00", priceOriginal: "32.00", currencyOriginal: "GBP", fetchedAt },
      { gameId: g.id, source: "cex", region: "PAL", condition: "cib", kind: "cash", priceUsd: "12.00", priceOriginal: "10.00", currencyOriginal: "GBP", fetchedAt },
      { gameId: g.id, source: "cex", region: "PAL", condition: "cib", kind: "cash", priceUsd: "15.00", priceOriginal: "12.00", currencyOriginal: "GBP", fetchedAt },
    ]);
    const a = await app();
    await a.inject({ method: "POST", url: "/api/watchlist", payload: { gameId: g.id } });
    const res = await a.inject({ method: "GET", url: "/api/watchlist" });
    const item = res.json().items[0];
    expect(item.storeBids.map((b: StoreQuoteDto) => [b.kind, b.priceUsd])).toEqual([["cash", 15]]);
    await a.close();
  });

  it("constrains bids to the offer's own grade, not just its shop/region/condition (grade honesty)", async () => {
    // An ungraded sell is the cheapest in-stock offer, so it wins the offer
    // slot. A graded ("mint") cash bid is HIGHER than the ungraded one — the
    // "highest per kind" dedupe would otherwise select it, pairing the
    // ungraded sell with a Mint SKU's payout: a spread the shop never quotes
    // for this copy.
    const [g] = await ctx!.db.insert(games).values({ title: "EarthBound", platform: "snes" }).returning();
    const fetchedAt = new Date();
    await ctx!.db.insert(pricePoints).values([
      { gameId: g.id, source: "cex", region: "PAL", condition: "cib", kind: "sell", priceUsd: "80.00", priceOriginal: "64.00", currencyOriginal: "GBP", grade: null, fetchedAt },
      { gameId: g.id, source: "cex", region: "PAL", condition: "cib", kind: "cash", priceUsd: "20.00", priceOriginal: "16.00", currencyOriginal: "GBP", grade: null, fetchedAt },
      { gameId: g.id, source: "cex", region: "PAL", condition: "cib", kind: "cash", priceUsd: "35.00", priceOriginal: "28.00", currencyOriginal: "GBP", grade: "mint", fetchedAt },
    ]);
    const a = await app();
    await a.inject({ method: "POST", url: "/api/watchlist", payload: { gameId: g.id } });
    const res = await a.inject({ method: "GET", url: "/api/watchlist" });
    const item = res.json().items[0];
    expect(item.storeOffer.priceUsd).toBe(80);
    // the ungraded cash bid wins, never the higher graded one
    expect(item.storeBids.map((b: StoreQuoteDto) => b.priceUsd)).toEqual([20]);
    await a.close();
  });
});
