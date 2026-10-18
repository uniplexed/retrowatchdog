import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { WATCHLIST_CSV_COLUMNS, type WatchlistCsvColumn, type CsvWatchlistImportResponse, type CsvRowError } from "@retrowatchdog/shared";
import { setupTestDb } from "../helpers/testDb.js";
import { buildApp } from "../../src/app.js";
import { games, gameNames, watchlist } from "../../src/db/schema.js";
import { serializeCsv } from "../../src/lib/csv.js";
import type { IgdbClient } from "../../src/catalog/igdb.js";
import { resetFxCacheForTests } from "../../src/pricing/fx.js";
import { stubAdapter } from "../helpers/stubAdapter.js";

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}

const igdbStub = { isConfigured: () => false, searchGames: async () => [] } as unknown as IgdbClient;

const watchlistCsv = (rows: Array<Partial<Record<WatchlistCsvColumn, string | number>>>): string =>
  serializeCsv(
    WATCHLIST_CSV_COLUMNS,
    rows.map((r) => WATCHLIST_CSV_COLUMNS.map((c) => r[c] ?? "")),
  );

describe.skipIf(ctx === null)("POST /api/watchlist/import/csv", () => {
  let sonicId: number;
  let columnsId: number;

  const seed = async (title: string, platform: string): Promise<number> => {
    const [g] = await ctx!.db.insert(games).values({ title, platform }).returning({ id: games.id });
    await ctx!.db.insert(gameNames).values({ gameId: g.id, name: title });
    return g.id;
  };

  beforeEach(async () => {
    resetFxCacheForTests();
    await ctx!.truncateAll();
    sonicId = await seed("Sonic the Hedgehog", "game_gear");
    columnsId = await seed("Columns", "game_gear");
  });
  afterAll(async () => ctx?.pool.end());

  const app = () => buildApp({ db: ctx!.db, igdb: igdbStub, registry: [stubAdapter()] });

  const post = async (
    a: Awaited<ReturnType<typeof buildApp>>,
    payload: Record<string, unknown>,
  ): Promise<{ status: number; body: CsvWatchlistImportResponse }> => {
    const res = await a.inject({ method: "POST", url: "/api/watchlist/import/csv", payload });
    return { status: res.statusCode, body: res.json() as CsvWatchlistImportResponse };
  };

  it("imports via game_id short-circuit with empty region/condition meaning ANY (null prefs)", async () => {
    const csv = watchlistCsv([
      { game_id: sonicId, title: "whatever", platform: "gb" }, // matching skipped: title/platform ignored
      {
        game_id: columnsId, title: "Columns", platform: "game_gear",
        region: "PAL", condition: "cib",
        target_original: "20.00", target_currency: "GBP", target_usd: "25.40",
      },
    ]);
    const a = await app();

    const dry = await post(a, { csv });
    expect(dry.status).toBe(200);
    expect(dry.body.dryRun).toBe(true);
    expect(dry.body.totals).toEqual({ matched: 2, review: 0, unmatched: 0, unsupported: 0 });
    expect(dry.body.rows[0].matchedBy).toBe("game_id");
    expect(dry.body.rows[0].region).toBeNull();
    expect(dry.body.rows[0].condition).toBeNull();
    expect(dry.body.rows[1].targetOriginal).toBe(20);
    expect(await ctx!.db.select().from(watchlist)).toHaveLength(0);

    const confirmed = await post(a, { csv, dryRun: false });
    expect(confirmed.body.imported).toBe(2);
    expect(confirmed.body.skipped).toBe(0);
    const watches = await ctx!.db.select().from(watchlist);
    expect(watches).toHaveLength(2);
    const anyWatch = watches.find((w) => w.gameId === sonicId)!;
    expect(anyWatch.region).toBeNull();
    expect(anyWatch.condition).toBeNull();
    expect(anyWatch.targetPriceOriginal).toBeNull();
    const targeted = watches.find((w) => w.gameId === columnsId)!;
    expect(targeted.region).toBe("PAL");
    expect(targeted.condition).toBe("cib");
    expect(targeted.targetPriceOriginal).toBe("20.00");
    expect(targeted.targetCurrency).toBe("GBP");
    expect(targeted.targetPriceUsd).toBe("25.40"); // verbatim, never re-derived
    await a.close();
  });

  it("skips existing watches (nullsNotDistinct unique) and intra-CSV repeats, reporting the count", async () => {
    await ctx!.db.insert(watchlist).values({ gameId: sonicId, region: "PAL", condition: "cib" });
    const csv = watchlistCsv([
      { game_id: sonicId, title: "x", platform: "game_gear", region: "PAL", condition: "cib" }, // exists
      { game_id: sonicId, title: "x", platform: "game_gear" }, // new (null/null is a DIFFERENT watch)
      { game_id: sonicId, title: "x", platform: "game_gear" }, // intra-CSV repeat of the row above
      { game_id: columnsId, title: "x", platform: "game_gear", region: "PAL", condition: "cib" }, // new
    ]);
    const a = await app();

    const dry = await post(a, { csv });
    expect(dry.body.rows.map((r) => r.duplicate)).toEqual([true, false, false, false]);

    const confirmed = await post(a, { csv, dryRun: false });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.imported).toBe(2); // null/null sonic + PAL/cib columns
    expect(confirmed.body.skipped).toBe(2); // the existing watch + the intra-CSV repeat
    expect(await ctx!.db.select().from(watchlist)).toHaveLength(3);
    await a.close();
  });

  it("sends review rows through overrides only, all-or-nothing validated", async () => {
    const csv = watchlistCsv([
      { title: "Sonic the Hedgehog 2", platform: "game_gear", region: "PAL" }, // review (numeral cap)
    ]);
    const a = await app();

    const dry = await post(a, { csv });
    expect(dry.body.rows[0].matchStatus).toBe("review");
    expect(dry.body.rows[0].candidates).toEqual([
      { game: expect.objectContaining({ id: sonicId }), score: 0.44, numeralMismatch: true },
    ]);

    const viaInclude = await post(a, { csv, dryRun: false, includeRowIndexes: [0] });
    expect(viaInclude.body.imported).toBe(0);

    const badOverride = await a.inject({
      method: "POST",
      url: "/api/watchlist/import/csv",
      payload: { csv, dryRun: false, overrides: { "0": 999999 } },
    });
    expect(badOverride.statusCode).toBe(400);
    expect(badOverride.json()).toMatchObject({ code: "invalid_override", rowIndex: 0 });
    expect(await ctx!.db.select().from(watchlist)).toHaveLength(0);

    const viaOverride = await post(a, { csv, dryRun: false, overrides: { "0": sonicId } });
    expect(viaOverride.body.imported).toBe(1);
    const [watch] = await ctx!.db.select().from(watchlist);
    expect(watch.gameId).toBe(sonicId);
    expect(watch.region).toBe("PAL");
    expect(watch.condition).toBeNull();
    await a.close();
  });

  it("400s on a bad header and on invalid row values", async () => {
    const a = await app();
    const badHeader = await a.inject({
      method: "POST",
      url: "/api/watchlist/import/csv",
      payload: { csv: "game_id,title\n1,x\n" },
    });
    expect(badHeader.statusCode).toBe(400);
    const headerBody = badHeader.json() as { code: string; missing: string[] };
    expect(headerBody.code).toBe("invalid_header");
    expect(headerBody.missing).toEqual(
      WATCHLIST_CSV_COLUMNS.filter((c) => !["game_id", "title"].includes(c)),
    );

    const badRows = await a.inject({
      method: "POST",
      url: "/api/watchlist/import/csv",
      payload: {
        csv: watchlistCsv([
          { title: "x", platform: "game_gear", region: "EU" }, // bad region
          { title: "x", platform: "game_gear", target_original: "5.00" }, // currency missing
        ]),
        dryRun: false,
      },
    });
    expect(badRows.statusCode).toBe(400);
    const rowsBody = badRows.json() as { code: string; rowErrors: CsvRowError[] };
    expect(rowsBody.code).toBe("invalid_rows");
    expect(rowsBody.rowErrors).toEqual([
      { rowIndex: 0, column: "region", message: expect.stringContaining("must be one of") },
      { rowIndex: 1, column: "target_currency", message: expect.stringContaining("go together") },
    ]);
    expect(await ctx!.db.select().from(watchlist)).toHaveLength(0);
    await a.close();
  });

  describe("FX at import time", () => {
    let agent: MockAgent;
    let prevDispatcher: ReturnType<typeof getGlobalDispatcher>;
    beforeEach(() => {
      prevDispatcher = getGlobalDispatcher();
      agent = new MockAgent();
      agent.disableNetConnect();
      setGlobalDispatcher(agent);
      resetFxCacheForTests();
    });
    afterEach(async () => {
      setGlobalDispatcher(prevDispatcher);
      await agent.close();
    });

    it("freezes target USD only when target_usd is missing; FX down means a clean 503", async () => {
      agent
        .get("https://api.frankfurter.app")
        .intercept({ path: "/latest?from=GBP&to=USD", method: "GET" })
        .reply(200, { rates: { USD: 1.27 } })
        .persist();
      const csv = watchlistCsv([
        { game_id: sonicId, title: "x", platform: "game_gear", target_original: "10.00", target_currency: "GBP" },
      ]);
      const a = await app();
      const { status } = await post(a, { csv, dryRun: false });
      expect(status).toBe(200);
      const [watch] = await ctx!.db.select().from(watchlist);
      expect(watch.targetPriceOriginal).toBe("10.00");
      expect(watch.targetCurrency).toBe("GBP");
      expect(watch.targetPriceUsd).toBe("12.70");

      // EUR has no intercept: the conversion fails -> 503, nothing more written
      const eurCsv = watchlistCsv([
        { game_id: columnsId, title: "x", platform: "game_gear", target_original: "5.00", target_currency: "EUR" },
      ]);
      const down = await post(a, { csv: eurCsv, dryRun: false });
      expect(down.status).toBe(503);
      expect(await ctx!.db.select().from(watchlist)).toHaveLength(1);
      await a.close();
    });

    it("round-trips its own export without any FX call (network fully blocked)", async () => {
      await ctx!.db.insert(watchlist).values([
        { gameId: sonicId, region: null, condition: null },
        {
          // boxed_no_manual pref: the union value must survive export -> import
          gameId: columnsId, region: "PAL", condition: "boxed_no_manual",
          targetPriceOriginal: "20.00", targetCurrency: "GBP", targetPriceUsd: "25.40",
        },
      ]);
      const a = await app();
      const exported = await a.inject({ method: "GET", url: "/api/watchlist/export" });
      expect(exported.statusCode).toBe(200);

      const dry = await post(a, { csv: exported.body });
      expect(dry.status).toBe(200);
      expect(dry.body.totals).toEqual({ matched: 2, review: 0, unmatched: 0, unsupported: 0 });
      expect(dry.body.rows.every((r) => r.matchedBy === "game_id")).toBe(true);
      expect(dry.body.rows[1].condition).toBe("boxed_no_manual");
      // re-importing over the same watchlist: every row is its own duplicate
      expect(dry.body.rows.every((r) => r.duplicate)).toBe(true);

      // confirm: the unique constraint skips both, importing nothing new
      const confirmed = await post(a, { csv: exported.body, dryRun: false });
      expect(confirmed.status).toBe(200);
      expect(confirmed.body.imported).toBe(0);
      expect(confirmed.body.skipped).toBe(2);
      expect(await ctx!.db.select().from(watchlist)).toHaveLength(2);
      await a.close();
    });
  });
});
