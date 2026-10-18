import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { COLLECTION_CSV_COLUMNS, WATCHLIST_CSV_COLUMNS } from "@retrowatchdog/shared";
import { setupTestDb } from "../helpers/testDb.js";
import { buildApp } from "../../src/app.js";
import { games, ownedCopies, watchlist } from "../../src/db/schema.js";
import { parseCsv } from "../../src/lib/csv.js";
import type { IgdbClient } from "../../src/catalog/igdb.js";
import { stubAdapter } from "../helpers/stubAdapter.js";

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}

const igdbStub = { isConfigured: () => false, searchGames: async () => [] } as unknown as IgdbClient;

describe.skipIf(ctx === null)("CSV export endpoints", () => {
  let gameId: number;

  beforeEach(async () => {
    await ctx!.truncateAll();
    const [g] = await ctx!.db
      .insert(games)
      .values({ title: "Pokemon Red", platform: "gb" })
      .returning({ id: games.id });
    gameId = g.id;
  });
  afterAll(async () => ctx?.pool.end());

  const app = () => buildApp({ db: ctx!.db, igdb: igdbStub, registry: [stubAdapter()] });

  it("exports the collection in canonical column order with filename + content-type headers", async () => {
    await ctx!.db.insert(ownedCopies).values({
      gameId,
      region: "PAL",
      condition: "cib",
      itemGrade: "very_good",
      status: "owned",
      acquiredPriceOriginal: "12.50",
      acquiredCurrency: "GBP",
      acquiredPriceUsd: "15.90",
      notes: "boxed, minor shelf wear",
      acquiredAt: "2026-03-14",
      acquiredSource: "car_boot",
      acquiredUrl: "https://example.com/listing/1",
      matchBasis: "confirmed",
      matchScore: 1,
    });
    const a = await app();
    const res = await a.inject({ method: "GET", url: "/api/collection/export" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(res.headers["content-disposition"]).toMatch(
      /^attachment; filename="retrowatchdog-collection-\d{8}\.csv"$/,
    );

    const { header, rows } = parseCsv(res.body);
    expect(header).toEqual([...COLLECTION_CSV_COLUMNS]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual([
      String(gameId), "Pokemon Red", "gb", "PAL", "cib", "very_good", "owned",
      // numeric strings emitted verbatim from the DB (never Number()-mangled)
      "12.50", "GBP", "15.90",
      "boxed, minor shelf wear", "2026-03-14", "car_boot", "https://example.com/listing/1", "confirmed",
      // an owned copy has no sale or return: twelve empty fields
      ...Array(12).fill(""),
    ]);
    await a.close();
  });

  it("quotes notes containing comma+quote+newline and round-trips through parseCsv", async () => {
    const evilNotes = 'CIB, says "MINT"\nsecond line';
    await ctx!.db.insert(ownedCopies).values({
      gameId,
      region: "unknown",
      condition: "unknown",
      notes: evilNotes,
    });
    const a = await app();
    const res = await a.inject({ method: "GET", url: "/api/collection/export" });
    expect(res.statusCode).toBe(200);
    // the raw body carries the RFC-4180 escaping...
    expect(res.body).toContain('"CIB, says ""MINT""\nsecond line"');
    // ...and parsing our own output restores the exact original value
    const { rows } = parseCsv(res.body);
    expect(rows[0][COLLECTION_CSV_COLUMNS.indexOf("notes")]).toBe(evilNotes);
    await a.close();
  });

  it("exports EVERY row including sold/returned, with empty strings for nulls", async () => {
    await ctx!.db.insert(ownedCopies).values([
      { gameId, region: "PAL", condition: "loose", status: "owned" },
      {
        gameId, region: "PAL", condition: "cib", status: "sold",
        soldAt: "2026-05-01", soldPriceOriginal: "40.00", soldCurrency: "GBP", soldPriceUsd: "50.80",
      },
      { gameId, region: "NTSC_J", condition: "loose", status: "returned" },
    ]);
    const a = await app();
    const res = await a.inject({ method: "GET", url: "/api/collection/export" });
    const { rows } = parseCsv(res.body);
    expect(rows).toHaveLength(3);
    const statusCol = COLLECTION_CSV_COLUMNS.indexOf("status");
    expect(rows.map((r) => r[statusCol])).toEqual(["owned", "sold", "returned"]);
    // nulls export as empty fields (grade here), never the string "null"
    const gradeCol = COLLECTION_CSV_COLUMNS.indexOf("grade");
    expect(rows.every((r) => r[gradeCol] === "")).toBe(true);
    expect(res.body).not.toContain("null");
    await a.close();
  });

  it("exports the watchlist with null region/condition as empty (= any)", async () => {
    await ctx!.db.insert(watchlist).values([
      { gameId, region: null, condition: null },
      {
        gameId, region: "PAL", condition: "cib",
        targetPriceOriginal: "20.00", targetCurrency: "GBP", targetPriceUsd: "25.40",
      },
    ]);
    const a = await app();
    const res = await a.inject({ method: "GET", url: "/api/watchlist/export" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(
      /^attachment; filename="retrowatchdog-watchlist-\d{8}\.csv"$/,
    );
    const { header, rows } = parseCsv(res.body);
    expect(header).toEqual([...WATCHLIST_CSV_COLUMNS]);
    expect(rows).toEqual([
      [String(gameId), "Pokemon Red", "gb", "", "", "", "", ""],
      [String(gameId), "Pokemon Red", "gb", "PAL", "cib", "20.00", "GBP", "25.40"],
    ]);
    await a.close();
  });

  it("exports just the header for an empty collection and watchlist", async () => {
    const a = await app();
    const col = await a.inject({ method: "GET", url: "/api/collection/export" });
    expect(parseCsv(col.body)).toEqual({ header: [...COLLECTION_CSV_COLUMNS], rows: [] });
    const watch = await a.inject({ method: "GET", url: "/api/watchlist/export" });
    expect(parseCsv(watch.body)).toEqual({ header: [...WATCHLIST_CSV_COLUMNS], rows: [] });
    await a.close();
  });
});
