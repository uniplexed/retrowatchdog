import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { COLLECTION_CSV_COLUMNS, COLLECTION_CSV_OPTIONAL_COLUMNS, type CollectionCsvColumn, type CsvCollectionImportResponse, type CsvRowError } from "@retrowatchdog/shared";
import { setupTestDb } from "../helpers/testDb.js";
import { buildApp } from "../../src/app.js";
import { games, gameNames, ownedCopies } from "../../src/db/schema.js";
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

/** builds a canonical-format CSV from sparse row objects (missing columns empty) */
const collectionCsv = (rows: Array<Partial<Record<CollectionCsvColumn, string | number>>>): string =>
  serializeCsv(
    COLLECTION_CSV_COLUMNS,
    rows.map((r) => COLLECTION_CSV_COLUMNS.map((c) => r[c] ?? "")),
  );

describe.skipIf(ctx === null)("POST /api/collection/import/csv", () => {
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
  ): Promise<{ status: number; body: CsvCollectionImportResponse }> => {
    const res = await a.inject({ method: "POST", url: "/api/collection/import/csv", payload });
    return { status: res.statusCode, body: res.json() as CsvCollectionImportResponse };
  };

  it("short-circuits matching on a valid game_id and round-trips every column on confirm", async () => {
    const csv = collectionCsv([
      {
        game_id: sonicId,
        title: "Some Renamed Title", // proves matching is skipped: title/platform ignored
        platform: "gb",
        region: "PAL",
        condition: "cib",
        grade: "very_good",
        status: "listed",
        paid_original: "12.50",
        paid_currency: "GBP",
        paid_usd: "15.90", // deliberately NOT 12.50: a present usd twin is stored verbatim
        notes: 'has, comma and "quotes"\nand a newline',
        acquired_at: "2026-03-14",
        acquired_source: "car_boot",
        acquired_url: "https://example.com/1",
        match_basis: "confirmed", // informational: NOT restored on import
      },
    ]);
    const a = await app();

    const dry = await post(a, { csv });
    expect(dry.status).toBe(200);
    expect(dry.body.dryRun).toBe(true);
    expect(dry.body.imported).toBe(0);
    expect(dry.body.totals).toEqual({ matched: 1, review: 0, unmatched: 0, unsupported: 0 });
    const row = dry.body.rows[0];
    expect(row.matchStatus).toBe("matched");
    expect(row.matchedBy).toBe("game_id");
    expect(row.matchScore).toBe(1);
    expect(row.game?.id).toBe(sonicId);
    expect(row.platform).toBe("game_gear"); // the game's real platform, not the CSV's "gb"
    expect(row.candidates).toEqual([
      { game: expect.objectContaining({ id: sonicId }), score: 1, numeralMismatch: false },
    ]);
    expect(row.grade).toBe("very_good");
    expect(row.status).toBe("listed");
    expect(row.paidOriginal).toBe(12.5);
    expect(row.paidCurrency).toBe("GBP");
    expect(row.paidUsd).toBe(15.9);
    expect(await ctx!.db.select().from(ownedCopies)).toHaveLength(0); // dry run writes nothing

    const confirmed = await post(a, { csv, dryRun: false });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.imported).toBe(1);
    const copies = await ctx!.db.select().from(ownedCopies);
    expect(copies).toHaveLength(1);
    const copy = copies[0];
    expect(copy.gameId).toBe(sonicId);
    expect(copy.region).toBe("PAL");
    expect(copy.condition).toBe("cib");
    expect(copy.itemGrade).toBe("very_good");
    expect(copy.status).toBe("listed");
    expect(copy.acquiredPriceOriginal).toBe("12.50");
    expect(copy.acquiredCurrency).toBe("GBP");
    expect(copy.acquiredPriceUsd).toBe("15.90"); // verbatim, never re-derived from FX
    expect(copy.notes).toBe('has, comma and "quotes"\nand a newline');
    expect(copy.acquiredAt).toBe("2026-03-14");
    expect(copy.acquiredSource).toBe("car_boot");
    expect(copy.acquiredUrl).toBe("https://example.com/1");
    // provenance is re-derived, not restored: explicit game_id = 'exact', no score
    expect(copy.matchBasis).toBe("exact");
    expect(copy.matchScore).toBeNull();
    await a.close();
  });

  it("applies defaults for empty region/condition/status and imports a title-exact row", async () => {
    const csv = collectionCsv([{ title: "Sonic the Hedgehog", platform: "game_gear" }]);
    const a = await app();
    const { body } = await post(a, { csv, dryRun: false });
    const row = body.rows[0];
    expect(row.matchStatus).toBe("matched");
    expect(row.matchedBy).toBe("title");
    expect(row.matchScore).toBe(1);
    expect(body.imported).toBe(1);
    const [copy] = await ctx!.db.select().from(ownedCopies);
    expect(copy.gameId).toBe(sonicId);
    expect(copy.region).toBe("unknown");
    expect(copy.condition).toBe("unknown");
    expect(copy.status).toBe("owned");
    expect(copy.itemGrade).toBeNull();
    // a title exact-hit carries its fuzzy score (unlike explicit game_id rows)
    expect(copy.matchBasis).toBe("exact");
    expect(copy.matchScore).toBe(1);
    await a.close();
  });

  it("sends a foreign game_id down the fuzzy path instead of failing", async () => {
    const csv = collectionCsv([
      { game_id: 999999, title: "Sonic the Hedgehog", platform: "game_gear" },
    ]);
    const a = await app();
    const { body } = await post(a, { csv });
    expect(body.rows[0].matchStatus).toBe("matched");
    expect(body.rows[0].matchedBy).toBe("title");
    expect(body.rows[0].game?.id).toBe(sonicId);
    await a.close();
  });

  it("drops a numeral-mismatched fuzzy row to review with candidates and imports it only via override", async () => {
    // "Sonic the Hedgehog 2" vs the seeded base title: 0.90 raw, numeral cap
    // to 0.44 (the shared matcher pipeline, same as the PriceCharting tests)
    const csv = collectionCsv([
      { title: "Sonic the Hedgehog 2", platform: "game_gear", region: "PAL", condition: "loose" },
    ]);
    const a = await app();

    const dry = await post(a, { csv });
    const row = dry.body.rows[0];
    expect(row.matchStatus).toBe("review");
    expect(row.matchScore).toBe(0.44);
    expect(row.matchedBy).toBeNull();
    expect(row.candidates).toEqual([
      { game: expect.objectContaining({ id: sonicId }), score: 0.44, numeralMismatch: true },
    ]);

    // includeRowIndexes must NEVER import a review row
    const viaInclude = await post(a, { csv, dryRun: false, includeRowIndexes: [0] });
    expect(viaInclude.body.imported).toBe(0);
    expect(await ctx!.db.select().from(ownedCopies)).toHaveLength(0);

    // a candidate pick lands as 'candidate' with the candidate's own score
    const viaOverride = await post(a, { csv, dryRun: false, overrides: { "0": sonicId } });
    expect(viaOverride.body.imported).toBe(1);
    const [candidateCopy] = await ctx!.db.select().from(ownedCopies);
    expect(candidateCopy.gameId).toBe(sonicId);
    expect(candidateCopy.matchBasis).toBe("candidate");
    expect(candidateCopy.matchScore).toBe(0.44);
    await ctx!.db.delete(ownedCopies);

    // an "Other" pick (not among the candidates) lands as 'manual', no score
    const viaOther = await post(a, { csv, dryRun: false, overrides: { "0": columnsId } });
    expect(viaOther.body.imported).toBe(1);
    const [manualCopy] = await ctx!.db.select().from(ownedCopies);
    expect(manualCopy.gameId).toBe(columnsId);
    expect(manualCopy.matchBasis).toBe("manual");
    expect(manualCopy.matchScore).toBeNull();
    await a.close();
  });

  it("flags duplicates by (game, region, condition, grade-when-present) — default-excluded but selectable", async () => {
    await ctx!.db.insert(ownedCopies).values({
      gameId: sonicId,
      region: "PAL",
      condition: "loose",
      itemGrade: null,
    });
    const rows = [
      { game_id: sonicId, title: "Sonic the Hedgehog", platform: "game_gear", region: "PAL", condition: "loose" },
      // same triple but the row carries a grade the existing copy lacks: NOT a duplicate
      { game_id: sonicId, title: "Sonic the Hedgehog", platform: "game_gear", region: "PAL", condition: "loose", grade: "mint" },
      // different condition: NOT a duplicate
      { game_id: sonicId, title: "Sonic the Hedgehog", platform: "game_gear", region: "PAL", condition: "cib" },
    ];
    const csv = collectionCsv(rows);
    const a = await app();

    const dry = await post(a, { csv });
    expect(dry.body.rows.map((r) => r.duplicate)).toEqual([true, false, false]);
    expect(dry.body.skipped).toBe(1);

    // default selection: the duplicate stays out, the other two import
    const confirmed = await post(a, { csv, dryRun: false });
    expect(confirmed.body.imported).toBe(2);
    expect(confirmed.body.skipped).toBe(1);
    expect(await ctx!.db.select().from(ownedCopies)).toHaveLength(3); // 1 seeded + 2

    // explicit selection CAN re-add the duplicate (unlike the PriceCharting
    // import's hard skip — a CSV restore may legitimately re-add)
    const reAdd = await post(a, { csv, dryRun: false, includeRowIndexes: [0] });
    expect(reAdd.body.imported).toBe(1);
    expect(reAdd.body.skipped).toBe(0);
    expect(await ctx!.db.select().from(ownedCopies)).toHaveLength(4);
    await a.close();
  });

  it("treats a gradeless CSV row as duplicating ANY grade of the same triple", async () => {
    await ctx!.db.insert(ownedCopies).values({
      gameId: sonicId, region: "PAL", condition: "loose", itemGrade: "mint",
    });
    const csv = collectionCsv([
      { game_id: sonicId, title: "x", platform: "game_gear", region: "PAL", condition: "loose" },
      { game_id: sonicId, title: "x", platform: "game_gear", region: "PAL", condition: "loose", grade: "mint" },
      { game_id: sonicId, title: "x", platform: "game_gear", region: "PAL", condition: "loose", grade: "poor" },
    ]);
    const a = await app();
    const { body } = await post(a, { csv });
    expect(body.rows.map((r) => r.duplicate)).toEqual([true, true, false]);
    await a.close();
  });

  it("finds the on-platform game even when 20+ same-title games on other consoles outrank it", async () => {
    // localSearch keeps 20 rows; filtering by platform after that LIMIT lost this one
    for (let i = 0; i < 25; i++) await seed("Tetris", `other_${i}`);
    const plus = await seed("Tetris Plus", "game_gear");
    const a = await app();
    const { body } = await post(a, { csv: collectionCsv([{ title: "Tetris", platform: "game_gear" }]) });
    expect(body.rows[0].matchStatus).toBe("review");
    expect(body.rows[0].candidates.map((c) => c.game.id)).toEqual([plus]);
    await a.close();
  });

  it("reports an unknown platform as unsupported_platform with the raw value preserved", async () => {
    const csv = collectionCsv([{ title: "Gran Turismo 7", platform: "PlayStation5" }]);
    const a = await app();
    const { body } = await post(a, { csv, dryRun: false });
    expect(body.rows[0].matchStatus).toBe("unsupported_platform");
    expect(body.rows[0].platform).toBeNull();
    expect(body.rows[0].platformValue).toBe("PlayStation5");
    expect(body.totals.unsupported).toBe(1);
    expect(body.imported).toBe(0);
    await a.close();
  });

  it("400s on a bad header listing missing and unknown columns", async () => {
    const a = await app();
    const csv = "game_id,title,platform,nonsense\n1,x,gb,y\n";
    const res = await a.inject({ method: "POST", url: "/api/collection/import/csv", payload: { csv } });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { code: string; missing: string[]; unknown: string[] };
    expect(body.code).toBe("invalid_header");
    // the sale/return group is optional, so it is never reported missing
    expect(body.missing).toEqual(
      COLLECTION_CSV_COLUMNS.filter(
        (c) => !["game_id", "title", "platform"].includes(c) && !COLLECTION_CSV_OPTIONAL_COLUMNS.includes(c),
      ),
    );
    expect(body.unknown).toEqual(["nonsense"]);
    await a.close();
  });

  it("imports a file exported before the sale/return columns existed", async () => {
    const legacy = COLLECTION_CSV_COLUMNS.filter((c) => !COLLECTION_CSV_OPTIONAL_COLUMNS.includes(c));
    const csv = serializeCsv(legacy, [legacy.map((c) => (c === "game_id" ? sonicId : ""))]);
    const a = await app();
    const res = await post(a, { csv, dryRun: false });
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    const [copy] = await ctx!.db.select().from(ownedCopies);
    expect(copy.soldAt).toBeNull();
    expect(copy.soldCurrency).toBeNull();
    await a.close();
  });

  it("400s sale/return columns that contradict the status, and converts a sale with no USD twin", async () => {
    const a = await app();
    const bad = await a.inject({
      method: "POST", url: "/api/collection/import/csv",
      payload: {
        csv: collectionCsv([
          { game_id: sonicId, status: "sold", sold_at: "2026-05-01" }, // no sold_original
          { game_id: sonicId, status: "owned", sold_at: "2026-05-01" }, // sale on an owned copy
          { game_id: sonicId, status: "sold", sold_at: "2026-05-01", sold_original: "9", sold_currency: "GBP", returned_at: "2026-05-02" },
          { game_id: sonicId, status: "returned", refund_original: "5" }, // amount without currency
        ]),
      },
    });
    expect(bad.statusCode).toBe(400);
    const errs = (bad.json() as { rowErrors: CsvRowError[] }).rowErrors;
    expect(errs.map((e) => [e.rowIndex, e.column])).toEqual([
      [0, "status"], [1, "status"], [2, "status"], [3, "sold_currency"],
    ]);

    // a hand-written sale with no sold_usd freezes one at import (rate 1 in this suite)
    const ok = await post(a, {
      csv: collectionCsv([{ game_id: sonicId, status: "sold", sold_at: "2026-05-01", sold_original: "9.50", sold_currency: "GBP" }]),
      dryRun: false,
    });
    expect(ok.status).toBe(200);
    const [copy] = await ctx!.db.select().from(ownedCopies);
    expect(copy.soldPriceOriginal).toBe("9.50");
    expect(copy.soldCurrency).toBe("GBP");
    expect(copy.soldPriceUsd).not.toBeNull();

    // a purchase returned unsold: its return leg is in paid_currency, no sold_currency stored
    const back = await post(a, {
      csv: collectionCsv([{
        game_id: columnsId, status: "returned", paid_original: "15", paid_currency: "USD",
        returned_at: "2026-05-03", refund_original: "12",
      }]),
      dryRun: false,
    });
    expect(back.status).toBe(200);
    const returned = (await ctx!.db.select().from(ownedCopies)).find((c) => c.gameId === columnsId)!;
    expect(returned.soldCurrency).toBeNull();
    expect(returned.refundOriginal).toBe("12.00");
    expect(returned.refundUsd).toBe("12.00");
    await a.close();
  });

  it("lands one copy per PriceCharting offer even when the duplicate is selected", async () => {
    const csv = collectionCsv([{
      game_id: sonicId, acquired_source: "pricecharting_import",
      acquired_url: "https://www.pricecharting.com/offer/123",
    }]);
    const a = await app();
    expect((await post(a, { csv, dryRun: false })).body.imported).toBe(1);
    // the second run picks the flagged duplicate explicitly: the index turns it into a skip
    const again = await post(a, { csv, dryRun: false, includeRowIndexes: [0] });
    expect(again.status).toBe(200);
    expect(again.body.imported).toBe(0);
    expect(await ctx!.db.select().from(ownedCopies)).toHaveLength(1);
    await a.close();
  });

  it("accepts any column order (header is a set, not a sequence)", async () => {
    const reversed = [...COLLECTION_CSV_COLUMNS].reverse();
    const values = new Map<string, string>([
      ["game_id", String(sonicId)], ["title", "Sonic the Hedgehog"], ["platform", "game_gear"],
    ]);
    const csv = serializeCsv(reversed, [reversed.map((c) => values.get(c) ?? "")]);
    const a = await app();
    const { status, body } = await post(a, { csv });
    expect(status).toBe(200);
    expect(body.rows[0].matchStatus).toBe("matched");
    expect(body.rows[0].game?.id).toBe(sonicId);
    await a.close();
  });

  it("400s invalid_rows with every row error collected, and writes nothing even with dryRun false", async () => {
    const csv =
      collectionCsv([
        { title: "Sonic the Hedgehog", platform: "game_gear", region: "EUROPE" }, // bad region
        { title: "Sonic the Hedgehog", platform: "game_gear", paid_original: "9.99" }, // currency missing
        { title: "Sonic the Hedgehog", platform: "game_gear", acquired_at: "14/03/2026" }, // bad date
        { platform: "game_gear" }, // no game_id and no title
      ]) + "just,one,field\n"; // wrong field count
    const a = await app();
    const res = await a.inject({
      method: "POST",
      url: "/api/collection/import/csv",
      payload: { csv, dryRun: false },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { code: string; rowErrors: CsvRowError[] };
    expect(body.code).toBe("invalid_rows");
    expect(body.rowErrors).toEqual([
      { rowIndex: 0, column: "region", message: expect.stringContaining("must be one of") },
      { rowIndex: 1, column: "paid_currency", message: expect.stringContaining("go together") },
      { rowIndex: 2, column: "acquired_at", message: expect.stringContaining("ISO date") },
      { rowIndex: 3, column: "title", message: expect.stringContaining("required") },
      { rowIndex: 4, column: "(row)", message: expect.stringContaining("expected 27 fields, got 3") },
    ]);
    expect(await ctx!.db.select().from(ownedCopies)).toHaveLength(0);
    await a.close();
  });

  it("400s invalid_rows on calendar-invalid dates, numeric overflow and 3+ decimals — never a clean preview that 500s on confirm", async () => {
    const csv = collectionCsv([
      // shape-valid but not a real calendar date
      { game_id: sonicId, title: "x", platform: "game_gear", acquired_at: "2026-02-30" },
      // 11 integer digits: overflows numeric(10,2) at insert
      { game_id: sonicId, title: "x", platform: "game_gear", paid_usd: "99999999999" },
      // 3 decimals: would silently round on insert, diverging from the preview
      { game_id: sonicId, title: "x", platform: "game_gear", paid_usd: "9.999" },
    ]);
    const a = await app();
    const expectInvalid = (status: number, body: { code: string; rowErrors: CsvRowError[] }) => {
      expect(status).toBe(400);
      expect(body.code).toBe("invalid_rows");
      expect(body.rowErrors).toEqual([
        { rowIndex: 0, column: "acquired_at", message: expect.stringContaining("calendar") },
        { rowIndex: 1, column: "paid_usd", message: expect.stringContaining("8 digits") },
        { rowIndex: 2, column: "paid_usd", message: expect.stringContaining("2 decimal") },
      ]);
    };
    const dry = await a.inject({ method: "POST", url: "/api/collection/import/csv", payload: { csv } });
    expectInvalid(dry.statusCode, dry.json() as { code: string; rowErrors: CsvRowError[] });
    const confirm = await a.inject({
      method: "POST",
      url: "/api/collection/import/csv",
      payload: { csv, dryRun: false },
    });
    expectInvalid(confirm.statusCode, confirm.json() as { code: string; rowErrors: CsvRowError[] });
    expect(await ctx!.db.select().from(ownedCopies)).toHaveLength(0);
    await a.close();
  });

  it("accepts an import body over Fastify's default 1 MiB limit (bodyLimit covers the CSV cap)", async () => {
    // ~2600 rows x ~500 bytes: a realistic large exported collection. Without
    // the raised bodyLimit this 413s before any route code runs.
    const notes = "n".repeat(450);
    const csv = collectionCsv(
      Array.from({ length: 2600 }, () => ({
        game_id: sonicId, title: "Sonic the Hedgehog", platform: "game_gear", notes,
      })),
    );
    expect(csv.length).toBeGreaterThan(1_200_000);
    const a = await app();
    const { status, body } = await post(a, { csv });
    expect(status).toBe(200);
    expect(body.dryRun).toBe(true);
    expect(body.totals).toEqual({ matched: 2600, review: 0, unmatched: 0, unsupported: 0 });
    await a.close();
  });

  it("400s on malformed CSV quoting with invalid_csv", async () => {
    const a = await app();
    const res = await a.inject({
      method: "POST",
      url: "/api/collection/import/csv",
      payload: { csv: `${COLLECTION_CSV_COLUMNS.join(",")}\n"unclosed,,,,,,,,,,,,,\n` },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("invalid_csv");
    await a.close();
  });

  it("rejects a nonexistent override game with 400 invalid_override and inserts NOTHING (all-or-nothing)", async () => {
    const csv = collectionCsv([
      { title: "Sonic the Hedgehog", platform: "game_gear" }, // importable matched row
      { title: "Sonic the Hedgehog 2", platform: "game_gear" }, // review row
    ]);
    const a = await app();
    const res = await a.inject({
      method: "POST",
      url: "/api/collection/import/csv",
      payload: { csv, dryRun: false, overrides: { "1": 999999 } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "invalid_override", rowIndex: 1 });
    expect(await ctx!.db.select().from(ownedCopies)).toHaveLength(0);
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

    it("freezes USD from original+currency ONLY when paid_usd is missing; usd-only stores verbatim, no synthesized original", async () => {
      agent
        .get("https://api.frankfurter.app")
        .intercept({ path: "/latest?from=GBP&to=USD", method: "GET" })
        .reply(200, { rates: { USD: 1.27 } })
        .persist();
      const csv = collectionCsv([
        { game_id: sonicId, title: "x", platform: "game_gear", paid_original: "10.00", paid_currency: "GBP" },
        { game_id: sonicId, title: "x", platform: "game_gear", region: "NTSC_U", paid_usd: "20.00" },
      ]);
      const a = await app();
      const { status, body } = await post(a, { csv, dryRun: false });
      expect(status).toBe(200);
      expect(body.imported).toBe(2);
      const copies = await ctx!.db.select().from(ownedCopies);
      const converted = copies.find((c) => c.acquiredCurrency === "GBP")!;
      expect(converted.acquiredPriceOriginal).toBe("10.00");
      expect(converted.acquiredPriceUsd).toBe("12.70"); // 10.00 * 1.27, frozen at import
      // usd-only: the USD amount stores verbatim and NO original is invented —
      // an exported usd-only leg must restore (and re-export) byte-identically
      const usdOnly = copies.find((c) => c.region === "NTSC_U")!;
      expect(usdOnly.acquiredPriceOriginal).toBeNull();
      expect(usdOnly.acquiredCurrency).toBeNull();
      expect(usdOnly.acquiredPriceUsd).toBe("20.00");
      await a.close();
    });

    it("503s cleanly when FX is down and a row needs a conversion, writing nothing", async () => {
      // no frankfurter intercept + disableNetConnect: any FX attempt fails
      const csv = collectionCsv([
        { game_id: sonicId, title: "x", platform: "game_gear", paid_original: "10.00", paid_currency: "EUR" },
      ]);
      const a = await app();
      const { status } = await post(a, { csv, dryRun: false });
      expect(status).toBe(503);
      expect(await ctx!.db.select().from(ownedCopies)).toHaveLength(0);
      await a.close();
    });

    it("never calls FX on a dry run or when every money column is present", async () => {
      // network fully blocked: a single FX call would throw through the route
      const csv = collectionCsv([
        { game_id: sonicId, title: "x", platform: "game_gear", paid_original: "10.00", paid_currency: "EUR" },
        { game_id: sonicId, title: "x", platform: "game_gear", region: "NTSC_J", paid_original: "5.00", paid_currency: "EUR", paid_usd: "5.85" },
      ]);
      const a = await app();
      const dry = await post(a, { csv });
      expect(dry.status).toBe(200);
      // confirm only the fully-specified row: still no FX needed
      const confirmed = await post(a, { csv, dryRun: false, includeRowIndexes: [1] });
      expect(confirmed.status).toBe(200);
      expect(confirmed.body.imported).toBe(1);
      const [copy] = await ctx!.db.select().from(ownedCopies);
      expect(copy.acquiredPriceUsd).toBe("5.85");
      await a.close();
    });
  });

  it("round-trips its own export end-to-end: wipe, restore field-for-field, re-export byte-identically", async () => {
    // non-ASCII title, seeded directly on games: the round-trip goes through
    // game_id, so no game_names row (fuzzy index) is needed
    const [pokemon] = await ctx!.db
      .insert(games)
      .values({ title: "Pokémon Ōkami", platform: "game_gear" })
      .returning({ id: games.id });

    // match_basis is provenance, deliberately NOT restored (a game_id restore
    // re-derives 'exact'); seeding 'exact' keeps the re-export byte-comparable.
    // Non-restoration of other basis values is covered by the first test.
    await ctx!.db.insert(ownedCopies).values([
      { // (a) EUR paid leg + (c) grade + (f) CSV-hostile notes + full acquisition trail
        gameId: sonicId, region: "PAL", condition: "cib", itemGrade: "good", status: "owned",
        acquiredPriceOriginal: "10.00", acquiredCurrency: "EUR", acquiredPriceUsd: "11.70",
        notes: 'tricky "notes", with\nnewline', acquiredAt: "2026-01-02", acquiredSource: "ebay",
        acquiredUrl: "https://ebay.example/1", matchBasis: "exact",
      },
      { // (b) USD-only leg: paid_usd without an original
        gameId: columnsId, region: "NTSC_U", condition: "loose", status: "owned",
        acquiredPriceUsd: "20.00", matchBasis: "exact",
      },
      { // (d) sold row: the sale's facts travel with it
        gameId: columnsId, region: "NTSC_J", condition: "loose", status: "sold",
        soldAt: "2026-05-01", soldPriceOriginal: "9.00", soldFeesOriginal: "1.20", soldCurrency: "GBP",
        soldPriceUsd: "11.43", soldFeesUsd: "1.52", soldVenue: "ebay", matchBasis: "exact",
      },
      { // (e) non-ASCII title game, no money leg at all, boxed_no_manual tier:
        // the union value must survive export -> import verbatim (never
        // collapse into cib or unknown)
        gameId: pokemon.id, region: "NTSC_J", condition: "boxed_no_manual", itemGrade: "near_mint",
        status: "owned", matchBasis: "exact",
      },
      { // (g) returned row: keeps its sale and adds the return leg
        gameId: sonicId, region: "PAL", condition: "loose", status: "returned",
        soldAt: "2026-06-01", soldPriceOriginal: "30.00", soldCurrency: "EUR", soldPriceUsd: "35.10",
        returnedAt: "2026-06-10", refundOriginal: "30.00", returnCostsOriginal: "4.50",
        refundUsd: "35.10", returnCostsUsd: "5.27", matchBasis: "exact",
      },
    ]);
    const a = await app();
    const exported = await a.inject({ method: "GET", url: "/api/collection/export" });
    expect(exported.statusCode).toBe(200);

    // preview over the intact collection: everything matches by game_id and
    // every row is flagged as its own duplicate
    const dry = await post(a, { csv: exported.body });
    expect(dry.status).toBe(200);
    expect(dry.body.totals).toEqual({ matched: 5, review: 0, unmatched: 0, unsupported: 0 });
    expect(dry.body.rows.every((r) => r.matchedBy === "game_id")).toBe(true);
    expect(dry.body.rows.every((r) => r.duplicate)).toBe(true);
    expect(dry.body.rows[0].notes).toBe('tricky "notes", with\nnewline');
    expect(dry.body.rows[2].status).toBe("sold");
    expect(dry.body.rows[3].condition).toBe("boxed_no_manual");

    // disaster restore: wipe the collection, import the exported file verbatim
    await ctx!.db.delete(ownedCopies);
    const restored = await post(a, {
      csv: exported.body,
      dryRun: false,
      includeRowIndexes: [0, 1, 2, 3, 4],
    });
    expect(restored.status).toBe(200);
    expect(restored.body.imported).toBe(5);

    // field-level equality on every data column, row by row (CSV order)
    const copies = (await ctx!.db.select().from(ownedCopies)).sort((x, y) => x.id - y.id);
    expect(copies).toHaveLength(5);
    expect(
      copies.slice(0, 4).map((c) => ({
        gameId: c.gameId, region: c.region, condition: c.condition, itemGrade: c.itemGrade,
        status: c.status, acquiredPriceOriginal: c.acquiredPriceOriginal,
        acquiredCurrency: c.acquiredCurrency, acquiredPriceUsd: c.acquiredPriceUsd,
        notes: c.notes, acquiredAt: c.acquiredAt, acquiredSource: c.acquiredSource,
        acquiredUrl: c.acquiredUrl,
      })),
    ).toEqual([
      {
        gameId: sonicId, region: "PAL", condition: "cib", itemGrade: "good", status: "owned",
        acquiredPriceOriginal: "10.00", acquiredCurrency: "EUR", acquiredPriceUsd: "11.70",
        notes: 'tricky "notes", with\nnewline', acquiredAt: "2026-01-02",
        acquiredSource: "ebay", acquiredUrl: "https://ebay.example/1",
      },
      { // usd-only restored verbatim: still no original, no currency
        gameId: columnsId, region: "NTSC_U", condition: "loose", itemGrade: null, status: "owned",
        acquiredPriceOriginal: null, acquiredCurrency: null, acquiredPriceUsd: "20.00",
        notes: null, acquiredAt: null, acquiredSource: null, acquiredUrl: null,
      },
      { // the sold STATUS restores (no route gate on the import insert path)
        gameId: columnsId, region: "NTSC_J", condition: "loose", itemGrade: null, status: "sold",
        acquiredPriceOriginal: null, acquiredCurrency: null, acquiredPriceUsd: null,
        notes: null, acquiredAt: null, acquiredSource: null, acquiredUrl: null,
      },
      {
        gameId: pokemon.id, region: "NTSC_J", condition: "boxed_no_manual", itemGrade: "near_mint",
        status: "owned", acquiredPriceOriginal: null, acquiredCurrency: null,
        acquiredPriceUsd: null, notes: null, acquiredAt: null, acquiredSource: null,
        acquiredUrl: null,
      },
    ]);
    // restore provenance: explicit game_id -> 'exact' with no score
    expect(copies.every((c) => c.matchBasis === "exact" && c.matchScore === null)).toBe(true);
    // sale and return facts restore verbatim, USD twins included (never re-derived)
    const disposal = (c: (typeof copies)[number]) => ({
      soldAt: c.soldAt, soldVenue: c.soldVenue, soldCurrency: c.soldCurrency,
      soldPriceOriginal: c.soldPriceOriginal, soldFeesOriginal: c.soldFeesOriginal,
      soldPriceUsd: c.soldPriceUsd, soldFeesUsd: c.soldFeesUsd, returnedAt: c.returnedAt,
      refundOriginal: c.refundOriginal, returnCostsOriginal: c.returnCostsOriginal,
      refundUsd: c.refundUsd, returnCostsUsd: c.returnCostsUsd,
    });
    expect(disposal(copies[2])).toEqual({
      soldAt: "2026-05-01", soldVenue: "ebay", soldCurrency: "GBP",
      soldPriceOriginal: "9.00", soldFeesOriginal: "1.20", soldPriceUsd: "11.43", soldFeesUsd: "1.52",
      returnedAt: null, refundOriginal: null, returnCostsOriginal: null, refundUsd: null, returnCostsUsd: null,
    });
    expect(copies[4].status).toBe("returned");
    expect(disposal(copies[4])).toEqual({
      soldAt: "2026-06-01", soldVenue: null, soldCurrency: "EUR",
      soldPriceOriginal: "30.00", soldFeesOriginal: null, soldPriceUsd: "35.10", soldFeesUsd: null,
      returnedAt: "2026-06-10", refundOriginal: "30.00", returnCostsOriginal: "4.50",
      refundUsd: "35.10", returnCostsUsd: "5.27",
    });

    // the restored collection re-exports byte-for-byte identical (the
    // date-stamped filename lives in content-disposition, not the body)
    const reExported = await a.inject({ method: "GET", url: "/api/collection/export" });
    expect(reExported.statusCode).toBe(200);
    expect(reExported.body).toBe(exported.body);
    await a.close();
  });
});
