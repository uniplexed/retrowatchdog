import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type pg from "pg";
import { setupTestDb } from "../helpers/testDb.js";
import type { Db } from "../../src/db/index.js";
import { games, ownedCopies, pricePoints } from "../../src/db/schema.js";
import { buildApp } from "../../src/app.js";
import type { CollectionResponse } from "@retrowatchdog/shared";
import type { IgdbClient } from "../../src/catalog/igdb.js";
import { stubAdapter } from "../helpers/stubAdapter.js";
import { seedCexPlugin } from "../helpers/seedCexPlugin.js";

const igdbStub = { isConfigured: () => false, searchGames: async () => [] } as unknown as IgdbClient;
// collection.ts now reads stored points per registry source (not hardcoded
// "cex"/"ebay_uk" loadStoredBlock calls), so the route needs adapters
// registered for those sources even though it never calls search/normalize.
const stubRegistry = [stubAdapter({ source: "cex" }), stubAdapter({ source: "ebay_uk" })];

describe("/api/collection", () => {
  let db: Db;
  let pool: pg.Pool;
  let truncateAll: () => Promise<void>;
  let gameId: number;

  beforeAll(async () => {
    ({ db, pool, truncateAll } = await setupTestDb());
  });
  beforeEach(async () => {
    await truncateAll();
    // CeX's three shops reach the registry only through an approved plugin row.
    await seedCexPlugin(db);
    const [g] = await db
      .insert(games)
      .values({ igdbId: 2185, title: "Jurassic Park", platform: "snes", year: 1993 })
      .returning({ id: games.id });
    gameId = g.id;
    await db.insert(pricePoints).values({
      gameId, source: "cex", region: "PAL", condition: "cib", kind: "sell",
      priceUsd: "38.00", priceOriginal: "38.00", currencyOriginal: "GBP",
      fetchedAt: new Date(),
    });
  });
  afterAll(async () => await pool.end());

  const app = () => buildApp({ db, igdb: igdbStub, registry: stubRegistry });

  it("adds a copy, lists it with estimated value and totals, deletes it", async () => {
    const a = await app();
    const created = await a.inject({
      method: "POST",
      url: "/api/collection",
      payload: { gameId, region: "PAL", condition: "cib", notes: "gold cart", acquiredPriceOriginal: 12, acquiredCurrency: "USD" },
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json() as { id: number };

    const list = await a.inject({ method: "GET", url: "/api/collection" });
    const body = list.json() as CollectionResponse;
    expect(body.items).toHaveLength(1);
    expect(body.items[0].game.title).toBe("Jurassic Park");
    // The default basis changed from replacement to market by user decision
    // on 2026-09-02. These assertions still hold because the seed carries no
    // median and no bid: market falls through to trade-in, then to the
    // replacement reading, and the basis names that reading honestly.
    expect(body.items[0].estimatedValueUsd).toBe(38);
    // toEqual, not toBe: the basis is a structured reading now, not a string
    expect(body.items[0].valueBasis).toEqual({
      readAs: "reading", source: "cex", priceKind: "sell", viaUnknownCondition: false, viaUnknownRegion: false,
    });
    expect(body.items[0].valueFetchedAt).toBeTruthy(); // freshness travels with the value
    expect(body.totalEstimatedUsd).toBe(38);
    expect(body.totalPaidUsd).toBe(12);

    const del = await a.inject({ method: "DELETE", url: `/api/collection/${id}` });
    expect(del.statusCode).toBe(204);
    const after = (await (await a.inject({ method: "GET", url: "/api/collection" })).json()) as CollectionResponse;
    expect(after.items).toHaveLength(0);
    await a.close();
  });

  it("POST accepts itemGrade; omitting it leaves the grade unset (never defaulted)", async () => {
    const a = await app();
    const graded = await a.inject({
      method: "POST", url: "/api/collection",
      payload: { gameId, region: "PAL", condition: "cib", itemGrade: "very_good" },
    });
    expect(graded.statusCode).toBe(201);
    const ungraded = await a.inject({
      method: "POST", url: "/api/collection",
      payload: { gameId, region: "PAL", condition: "loose" },
    });
    expect(ungraded.statusCode).toBe(201);

    const body = (await (await a.inject({ method: "GET", url: "/api/collection" })).json()) as CollectionResponse;
    const byId = new Map(body.items.map((i) => [i.id, i]));
    expect(byId.get((graded.json() as { id: number }).id)?.itemGrade).toBe("very_good");
    // the add form's untouched slider must not write a grade the user never chose
    expect(byId.get((ungraded.json() as { id: number }).id)?.itemGrade).toBeNull();

    const bad = await a.inject({
      method: "POST", url: "/api/collection",
      payload: { gameId, region: "PAL", condition: "cib", itemGrade: "shiny" },
    });
    expect(bad.statusCode).toBe(400);
    await a.close();
  });

  it("PATCH sets and clears itemGrade (grade slider round-trip)", async () => {
    const a = await app();
    const { id } = (
      await a.inject({ method: "POST", url: "/api/collection", payload: { gameId, region: "PAL", condition: "cib" } })
    ).json() as { id: number };

    const set = await a.inject({ method: "PATCH", url: `/api/collection/${id}`, payload: { itemGrade: "mint" } });
    expect(set.statusCode).toBe(204);
    let body = (await (await a.inject({ method: "GET", url: "/api/collection" })).json()) as CollectionResponse;
    expect(body.items[0].itemGrade).toBe("mint");

    // explicit null clears the grade back to unset
    const clear = await a.inject({ method: "PATCH", url: `/api/collection/${id}`, payload: { itemGrade: null } });
    expect(clear.statusCode).toBe(204);
    body = (await (await a.inject({ method: "GET", url: "/api/collection" })).json()) as CollectionResponse;
    expect(body.items[0].itemGrade).toBeNull();
    await a.close();
  });

  it("two identical copies are two independent items", async () => {
    const a = await app();
    for (let i = 0; i < 2; i++) {
      await a.inject({
        method: "POST", url: "/api/collection",
        payload: { gameId, region: "PAL", condition: "cib" },
      });
    }
    const body = (await (await a.inject({ method: "GET", url: "/api/collection" })).json()) as CollectionResponse;
    expect(body.items).toHaveLength(2);
    expect(body.totalEstimatedUsd).toBe(76);
    await a.close();
  });

  it("DELETE /api/collection wipes everything - sold/returned history included", async () => {
    const a = await app();
    // per-copy DELETE refuses sold/returned rows (misclick guard), so the
    // wipe seeds them straight into the table: the full wipe must take them
    await db.insert(ownedCopies).values([
      { gameId, region: "PAL", condition: "cib", status: "owned" },
      { gameId, region: "PAL", condition: "loose", status: "sold", soldAt: "2026-01-15", soldPriceOriginal: "20.00", soldCurrency: "GBP", soldPriceUsd: "20.00" },
      { gameId, region: "PAL", condition: "loose", status: "returned", returnedAt: "2026-02-01" },
      { gameId, region: "PAL", condition: "unknown", status: "owned", acquiredSource: "pricecharting_import" },
    ]);

    const res = await a.inject({ method: "DELETE", url: "/api/collection" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: 4 });
    expect(await db.select().from(ownedCopies)).toHaveLength(0);
    await a.close();
  });

  it("DELETE /api/collection?source=pricecharting_import deletes only that source", async () => {
    const a = await app();
    await db.insert(ownedCopies).values([
      { gameId, region: "PAL", condition: "cib", status: "owned", acquiredSource: "ebay" },
      { gameId, region: "PAL", condition: "loose", status: "owned", acquiredSource: "pricecharting_import" },
      { gameId, region: "PAL", condition: "unknown", status: "owned", acquiredSource: "pricecharting_import" },
      { gameId, region: "PAL", condition: "cib", status: "owned" }, // no source at all
    ]);

    const res = await a.inject({ method: "DELETE", url: "/api/collection?source=pricecharting_import" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: 2 });
    const remaining = await db.select().from(ownedCopies);
    expect(remaining).toHaveLength(2);
    expect(remaining.every((c) => c.acquiredSource !== "pricecharting_import")).toBe(true);
    await a.close();
  });

  it("DELETE /api/collection rejects an unknown source and deletes nothing", async () => {
    const a = await app();
    await db.insert(ownedCopies).values({ gameId, region: "PAL", condition: "cib", status: "owned" });
    const res = await a.inject({ method: "DELETE", url: "/api/collection?source=steam" });
    expect(res.statusCode).toBe(400);
    expect(await db.select().from(ownedCopies)).toHaveLength(1);

    // a typo'd query KEY must also 400 (strict schema) — otherwise a
    // source-scoped wipe silently widens into a full wipe
    const typo = await a.inject({ method: "DELETE", url: "/api/collection?sorce=pricecharting_import" });
    expect(typo.statusCode).toBe(400);
    expect(await db.select().from(ownedCopies)).toHaveLength(1);
    await a.close();
  });

  it("404s adding a copy of a game that does not exist, 404s deleting unknown copy", async () => {
    const a = await app();
    const bad = await a.inject({
      method: "POST", url: "/api/collection",
      payload: { gameId: 999999, region: "PAL", condition: "cib" },
    });
    expect(bad.statusCode).toBe(404);
    const badDel = await a.inject({ method: "DELETE", url: "/api/collection/999999" });
    expect(badDel.statusCode).toBe(404);
    await a.close();
  });
});
