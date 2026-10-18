import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type pg from "pg";
import { readFileSync } from "node:fs";
import { setupTestDb } from "../helpers/testDb.js";
import type { Db } from "../../src/db/index.js";
import { games, gameNames } from "../../src/db/schema.js";
import { importFromIgdb } from "../../src/catalog/importer.js";
import type { IgdbClient, IgdbGame } from "../../src/catalog/igdb.js";

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/igdb-panzer.json", import.meta.url), "utf8"),
) as IgdbGame[];

const fakeClient = {
  isConfigured: () => true,
  searchGames: async () => fixture,
} as unknown as IgdbClient;

describe("importFromIgdb", () => {
  let db: Db;
  let pool: pg.Pool;
  let truncateAll: () => Promise<void>;

  beforeAll(async () => {
    ({ db, pool, truncateAll } = await setupTestDb());
  });
  beforeEach(async () => await truncateAll());
  afterAll(async () => await pool.end());

  it("fans a multi-platform IGDB game out to one row per supported platform", async () => {
    const count = await importFromIgdb(db, fakeClient, "whatever");
    // Panzer (1 platform) + Sonic double (3 platforms) = 4 game rows
    expect(count).toBe(4);
    const rows = await db.select().from(games);
    expect(rows).toHaveLength(4);
    const sonicRows = rows.filter((r) => r.igdbId === 424242);
    expect(sonicRows.map((r) => r.platform).sort()).toEqual([
      "game_gear", "master_system", "megadrive",
    ]);
  });

  it("reads a game on both DOS and Windows as one PC row", async () => {
    const dosAndWindows = {
      isConfigured: () => true,
      searchGames: async () => [{ id: 777, name: "Doom", platforms: [13, 6] }],
    } as unknown as IgdbClient;
    expect(await importFromIgdb(db, dosAndWindows, "doom")).toBe(1);
    const rows = await db.select().from(games);
    expect(rows.map((r) => r.platform)).toEqual(["pc"]);
  });

  it("stores main title and trimmed alternative names in game_names", async () => {
    await importFromIgdb(db, fakeClient, "whatever");
    const names = await db.select().from(gameNames);
    const panzerNames = names.map((n) => n.name);
    expect(panzerNames).toContain("Panzer Dragoon Saga");
    expect(panzerNames).toContain("Azel Panzer Dragoon RPG"); // note: source had a leading space
  });

  it("is idempotent: re-importing does not duplicate rows", async () => {
    await importFromIgdb(db, fakeClient, "whatever");
    await importFromIgdb(db, fakeClient, "whatever");
    expect((await db.select().from(games))).toHaveLength(4);
    const names = await db.select().from(gameNames);
    expect(names.length).toBe(new Set(names.map((n) => `${n.gameId}:${n.name}`)).size);
  });

  it("sets year and cover url from IGDB fields", async () => {
    await importFromIgdb(db, fakeClient, "whatever");
    const [panzer] = (await db.select().from(games)).filter((r) => r.igdbId === 1671);
    expect(panzer.year).toBe(1998);
    expect(panzer.coverUrl).toBe(
      "https://images.igdb.com/igdb/image/upload/t_cover_big/co1abc.jpg",
    );
  });
});
