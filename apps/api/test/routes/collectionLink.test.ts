import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { setupTestDb } from "../helpers/testDb.js";
import { buildApp } from "../../src/app.js";
import { games, ownedCopies } from "../../src/db/schema.js";
import { stubAdapter } from "../helpers/stubAdapter.js";
import type { CollectionResponse, OwnedCopyDto } from "@retrowatchdog/shared";

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}

describe.skipIf(ctx === null)("match-review link endpoints", () => {
  beforeEach(async () => ctx!.truncateAll());
  afterAll(async () => ctx?.pool.end());

  const app = async () => buildApp({ db: ctx!.db, registry: [stubAdapter()] });

  const seed = async (): Promise<{ sonic1Id: number; sonic2Id: number; copyId: number }> => {
    // the real-world case: Sonic 1 on Game Gear imported as Sonic 2
    const [sonic1] = await ctx!.db
      .insert(games)
      .values({ title: "Sonic the Hedgehog", platform: "game_gear" })
      .returning({ id: games.id });
    const [sonic2] = await ctx!.db
      .insert(games)
      .values({ title: "Sonic the Hedgehog 2", platform: "game_gear" })
      .returning({ id: games.id });
    const [copy] = await ctx!.db
      .insert(ownedCopies)
      .values({
        gameId: sonic2.id,
        region: "PAL",
        condition: "loose",
        matchBasis: "candidate",
        matchScore: 0.44,
      })
      .returning({ id: ownedCopies.id });
    return { sonic1Id: sonic1.id, sonic2Id: sonic2.id, copyId: copy.id };
  };

  it("PATCH :id/link re-links, sets basis 'manual', clears the score, returns the item", async () => {
    const { sonic1Id, copyId } = await seed();
    const a = await app();
    const res = await a.inject({
      method: "PATCH",
      url: `/api/collection/${copyId}/link`,
      payload: { gameId: sonic1Id },
    });
    expect(res.statusCode).toBe(200);
    const item = res.json() as OwnedCopyDto;
    expect(item.id).toBe(copyId);
    expect(item.game.id).toBe(sonic1Id);
    expect(item.game.title).toBe("Sonic the Hedgehog");
    expect(item.matchBasis).toBe("manual");
    expect(item.matchScore).toBeNull(); // the old link's score is not evidence for the new one

    const [row] = await ctx!.db.select().from(ownedCopies).where(eq(ownedCopies.id, copyId));
    expect(row.gameId).toBe(sonic1Id);
    expect(row.matchBasis).toBe("manual");
    expect(row.matchScore).toBeNull();
    await a.close();
  });

  it("PATCH :id/link accepts a cross-platform target (same ruling as import overrides)", async () => {
    const { copyId } = await seed();
    const [snesGame] = await ctx!.db
      .insert(games)
      .values({ title: "Super Metroid", platform: "snes" })
      .returning({ id: games.id });
    const a = await app();
    const res = await a.inject({
      method: "PATCH",
      url: `/api/collection/${copyId}/link`,
      payload: { gameId: snesGame.id },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as OwnedCopyDto).game.platform).toBe("snes");
    await a.close();
  });

  it("PATCH :id/link 404s on unknown copy or unknown game, 400s a bad body", async () => {
    const { sonic1Id, sonic2Id, copyId } = await seed();
    const a = await app();
    expect(
      (await a.inject({ method: "PATCH", url: "/api/collection/999999/link", payload: { gameId: sonic1Id } }))
        .statusCode,
    ).toBe(404);
    expect(
      (await a.inject({ method: "PATCH", url: `/api/collection/${copyId}/link`, payload: { gameId: 999999 } }))
        .statusCode,
    ).toBe(404);
    expect(
      (await a.inject({ method: "PATCH", url: `/api/collection/${copyId}/link`, payload: { gameId: "x" } }))
        .statusCode,
    ).toBe(400);
    // nothing changed on the failed attempts
    const [row] = await ctx!.db.select().from(ownedCopies).where(eq(ownedCopies.id, copyId));
    expect(row.gameId).toBe(sonic2Id);
    expect(row.matchBasis).toBe("candidate");
    await a.close();
  });

  it("POST :id/confirm-link sets basis 'confirmed' and keeps the score as evidence", async () => {
    const { sonic2Id, copyId } = await seed();
    const a = await app();
    const res = await a.inject({ method: "POST", url: `/api/collection/${copyId}/confirm-link` });
    expect(res.statusCode).toBe(200);
    const item = res.json() as OwnedCopyDto;
    expect(item.matchBasis).toBe("confirmed");
    expect(item.matchScore).toBe(0.44); // untouched: how the link was made stays on record
    expect(item.game.id).toBe(sonic2Id); // no other change

    expect(
      (await a.inject({ method: "POST", url: "/api/collection/999999/confirm-link" })).statusCode,
    ).toBe(404);
    await a.close();
  });

  it("GET /api/collection exposes matchBasis/matchScore; hand-added copies carry null", async () => {
    const { copyId } = await seed();
    const [handAdded] = await ctx!.db
      .insert(ownedCopies)
      .values({ gameId: (await ctx!.db.select().from(games))[0].id, region: "PAL", condition: "cib" })
      .returning({ id: ownedCopies.id });

    const a = await app();
    const body = (await (await a.inject({ method: "GET", url: "/api/collection" })).json()) as CollectionResponse;
    const byId = new Map(body.items.map((i) => [i.id, i]));
    expect(byId.get(copyId)?.matchBasis).toBe("candidate");
    expect(byId.get(copyId)?.matchScore).toBe(0.44);
    expect(byId.get(handAdded.id)?.matchBasis).toBeNull();
    expect(byId.get(handAdded.id)?.matchScore).toBeNull();
    await a.close();
  });
});
