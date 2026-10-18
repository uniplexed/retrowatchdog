import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { setupTestDb } from "../helpers/testDb.js";
import { buildApp } from "../../src/app.js";
import { games, gameNames, ownedCopies } from "../../src/db/schema.js";
import type { IgdbClient } from "../../src/catalog/igdb.js";
import type { PcImportResponse } from "@retrowatchdog/shared";
import type { PageFetcher } from "../../src/importers/pricecharting/index.js";
import { PcFetchError, resetPcFetchCacheForTests } from "../../src/importers/pricecharting/index.js";
import { resetFxCacheForTests } from "../../src/pricing/fx.js";
import { stubAdapter } from "../helpers/stubAdapter.js";

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}

const page1 = readFileSync(
  new URL("../../src/importers/pricecharting/fixtures/collection-page1.html", import.meta.url),
  "utf8",
);
const page2 = readFileSync(
  new URL("../../src/importers/pricecharting/fixtures/collection-page2.html", import.meta.url),
  "utf8",
);
const PAGE1_CURSOR =
  "ClAKEwoGU3RhcnRzEgkIxqrA4PGSlAMSNWoLc352Z3BjLWJvdHNyJgsSBm9mZmVycyIac2k0YzZjNDVwaW9hcXRqZ3gydjJzcHB2dTQMGAAgAQ";

// serves the two real fixture pages, then an empty last page
const fixtureFetcher: PageFetcher = async (_url, cursor) => {
  if (cursor === null) return page1;
  if (cursor === PAGE1_CURSOR) return page2;
  return "<html><body>no more offers</body></html>";
};

const igdbStub = { isConfigured: () => false, searchGames: async () => [] } as unknown as IgdbClient;

const COLLECTION_URL = "https://www.pricecharting.com/offers?seller=a1b2c3d4e5f6g7h8i9j0k1l2m3&status=collection";

// fixture offers this test drives by id (values are the real page values)
const SONIC_OFFER = "3swopb7iqep63vbfmeheaw5une"; // Sonic the Hedgehog, PAL Sega Game Gear, $6.86
const SONIC2_OFFER = "gm7mny3dwdsou2codupwkx7omu"; // Sonic the Hedgehog 2, PAL Sega Game Gear, $4.24
const PROBOTECTOR_OFFER = "wdl6lbnp55i6h7asozw3jppadq"; // Probotector 2, PAL GameBoy, $45.83
const WAVE_RACE_OFFER = "3c6tt3iv4zd2md4k3lt2iahowa"; // Wave Race, PAL GameBoy
const NA_VALUE_OFFER = "a6ujolj335kqwqtbe73o674yuy"; // Puyo Puyo Tetris, JP 3DS, value N/A

describe.skipIf(ctx === null)("POST /api/collection/import/pricecharting", () => {
  let agent: MockAgent;
  let prevDispatcher: ReturnType<typeof getGlobalDispatcher>;
  let sonicId: number;
  let probotectorId: number;

  beforeEach(async () => {
    prevDispatcher = getGlobalDispatcher();
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    resetFxCacheForTests();
    // the pricecharting fetch cache is keyed by URL, and every test here
    // reuses the same COLLECTION_URL — without a reset, a cache hit from one
    // test would silently starve the fetcher assertions in the next
    resetPcFetchCacheForTests();

    await ctx!.truncateAll();
    // seed a small catalog with known pg_trgm behavior against the fixtures:
    // - "Sonic the Hedgehog" scores 1.0 / 0.90 vs the two Game Gear rows -> matched
    // - the long Probotector name scores ~0.28 vs "Probotector 2" -> review band
    // - "Wave Race 64" scores ~0.77 vs "Wave Race" but is n64, not gb -> filtered out
    const seed = async (title: string, platform: string): Promise<number> => {
      const [g] = await ctx!.db.insert(games).values({ title, platform }).returning({ id: games.id });
      await ctx!.db.insert(gameNames).values({ gameId: g.id, name: title });
      return g.id;
    };
    sonicId = await seed("Sonic the Hedgehog", "game_gear");
    probotectorId = await seed("Probotector II: The Return of Evil Forces", "gb");
    await seed("Wave Race 64", "n64");
  });
  afterEach(async () => {
    setGlobalDispatcher(prevDispatcher);
    await agent.close();
  });
  afterAll(async () => ctx?.pool.end());

  const app = async (fetcher: PageFetcher = fixtureFetcher) =>
    buildApp({ db: ctx!.db, igdb: igdbStub, registry: [stubAdapter()], pcFetchPage: fetcher });

  const post = async (
    a: Awaited<ReturnType<typeof buildApp>>,
    payload: Record<string, unknown>,
  ): Promise<{ status: number; body: PcImportResponse }> => {
    const res = await a.inject({
      method: "POST",
      url: "/api/collection/import/pricecharting",
      payload,
    });
    return { status: res.statusCode, body: res.json() as PcImportResponse };
  };

  it("dry run classifies all 60 fixture rows and writes nothing", async () => {
    const a = await app();
    const { status, body } = await post(a, { url: COLLECTION_URL });
    expect(status).toBe(200);
    expect(body.dryRun).toBe(true);
    expect(body.rows).toHaveLength(60);
    expect(body.imported).toBe(0);
    expect(body.skippedDuplicates).toBe(0);
    // Recomputed from the fixtures for matching v2: auto-match now needs an
    // EXACT name hit, so the old {matched: 2, review: 1} shifts by exactly
    // one row. Hand-verified moved rows:
    // - "Sonic the Hedgehog 2" [PAL Sega Game Gear]: raw 0.90 vs the seeded
    //   "Sonic the Hedgehog", numeral sets {2} vs {} MISMATCH -> capped to
    //   0.44, matched -> review (the wrong-sibling bug this batch fixes).
    // - "Probotector 2" [PAL GameBoy]: numerals AGREE ("2" vs the roman "II"
    //   in "Probotector II: The Return of Evil Forces"), no cap, but its raw
    //   ~0.28 is non-exact so it STAYS review, same as before.
    // "Sonic the Hedgehog" (exact 1.0, empty numeral sets on both sides) is
    // the only remaining auto-match; the other 57 rows stay unmatched.
    expect(body.totals).toEqual({ matched: 1, review: 2, unmatched: 57, unsupported: 0 });
    // the fixture chain serves 60 of the collection's 67 items (summary table
    // on page 1) — the response must say so instead of silently truncating
    expect(body.totalCount).toBe(67);
    expect(body.truncated).toBe(true);

    const byId = new Map(body.rows.map((r) => [r.offerId, r]));
    const sonic = byId.get(SONIC_OFFER)!;
    expect(sonic.matchStatus).toBe("matched");
    expect(sonic.game?.id).toBe(sonicId);
    expect(sonic.matchScore).toBe(1); // auto-match is exact-only now
    // matched rows carry their single winner as the candidate list
    expect(sonic.candidates).toEqual([
      { game: expect.objectContaining({ id: sonicId }), score: 1, numeralMismatch: false },
    ]);
    expect(sonic.platform).toBe("game_gear");
    expect(sonic.region).toBe("PAL");
    expect(sonic.condition).toBe("loose");
    expect(sonic.valueUsd).toBe(6.86); // native PriceCharting USD, verbatim

    // the numeral-mismatch regression (Sonic GG vs Sonic 2): raw 0.90 must
    // NEVER auto-import; capped to 0.44 and offered as a review candidate
    const sonic2 = byId.get(SONIC2_OFFER)!;
    expect(sonic2.matchStatus).toBe("review");
    expect(sonic2.game?.id).toBe(sonicId);
    expect(sonic2.matchScore).toBe(0.44);
    expect(sonic2.candidates).toEqual([
      { game: expect.objectContaining({ id: sonicId }), score: 0.44, numeralMismatch: true },
    ]);

    const probotector = byId.get(PROBOTECTOR_OFFER)!;
    expect(probotector.matchStatus).toBe("review");
    expect(probotector.game?.id).toBe(probotectorId);
    expect(probotector.matchScore).toBeGreaterThanOrEqual(0.25);
    expect(probotector.matchScore).toBeLessThan(0.45);
    // "Probotector 2" vs "Probotector II: ...": roman II normalizes to 2,
    // the sets agree, so the candidate is NOT numeral-penalized
    expect(probotector.candidates[0].numeralMismatch).toBe(false);

    // "Wave Race 64" is the only fuzzy candidate but lives on n64, not gb:
    // the hard platform filter must reject it
    const waveRace = byId.get(WAVE_RACE_OFFER)!;
    expect(waveRace.matchStatus).toBe("unmatched");
    expect(waveRace.game).toBeNull();
    expect(waveRace.matchScore).toBeNull();

    // JP Nintendo 3DS is now a supported platform: the row maps to 3ds/NTSC_J
    // but stays unmatched (no 3ds titles in the seeded catalog) and its N/A
    // market value stays null
    const na = byId.get(NA_VALUE_OFFER)!;
    expect(na.matchStatus).toBe("unmatched");
    expect(na.consoleName).toBe("JP Nintendo 3DS"); // preserved for the report
    expect(na.platform).toBe("3ds");
    expect(na.region).toBe("NTSC_J");
    expect(na.condition).toBe("loose"); // "Item only" on the live page
    expect(na.game).toBeNull();
    expect(na.valueUsd).toBeNull();

    // hand-verified moved rows (previously unsupported_platform):
    // page 1 row 1 is "Legend of Zelda" on "Game & Watch" (no region prefix)
    const zelda = byId.get("u7x5vryx3fnhulbjzihj4y2xou")!;
    expect(zelda.matchStatus).toBe("unmatched");
    expect(zelda.platform).toBe("game_and_watch");
    expect(zelda.region).toBe("NTSC_U");
    // "Red Alarm" on "JP Virtual Boy" carries the JP prefix -> NTSC_J
    const redAlarm = byId.get("52lyoka5ogsuzkboplqy6mqpea")!;
    expect(redAlarm.matchStatus).toBe("unmatched");
    expect(redAlarm.platform).toBe("virtual_boy");
    expect(redAlarm.region).toBe("NTSC_J");

    // JP prefix and Famicom lines carry NTSC_J
    expect(byId.get("a3bfvswo57qfeeotqgrhhi3bvq")!.region).toBe("NTSC_J"); // JP GameBoy
    expect(byId.get("mshgigbvetjnn7lmr5wxb3kfka")!.platform).toBe("nes"); // Famicom
    expect(byId.get("mshgigbvetjnn7lmr5wxb3kfka")!.region).toBe("NTSC_J");

    const copies = await ctx!.db.select().from(ownedCopies);
    expect(copies).toHaveLength(0);
    await a.close();
  });

  it("flags duplicates in both modes and never re-imports them", async () => {
    await ctx!.db.insert(ownedCopies).values({
      gameId: sonicId,
      region: "PAL",
      condition: "loose",
      acquiredUrl: `https://www.pricecharting.com/offer/${SONIC_OFFER}`,
    });
    const a = await app();

    const dry = await post(a, { url: COLLECTION_URL });
    const dupRow = dry.body.rows.find((r) => r.offerId === SONIC_OFFER)!;
    expect(dupRow.duplicate).toBe(true);
    expect(dry.body.skippedDuplicates).toBe(1);

    const imported = await post(a, {
      url: COLLECTION_URL,
      dryRun: false,
      overrides: { [SONIC2_OFFER]: sonicId, [PROBOTECTOR_OFFER]: probotectorId },
    });
    expect(imported.status).toBe(200);
    expect(imported.body.imported).toBe(2); // Sonic 2 + Probotector, Sonic skipped
    expect(imported.body.skippedDuplicates).toBe(1);
    const copies = await ctx!.db.select().from(ownedCopies);
    expect(copies).toHaveLength(3); // 1 seeded + 2 imported
    const urls = copies.map((c) => c.acquiredUrl);
    expect(urls.filter((u) => u === `https://www.pricecharting.com/offer/${SONIC_OFFER}`)).toHaveLength(1);
    await a.close();
  });

  it("imports matched + override-chosen review rows with honest fields and NO acquisition price", async () => {
    const a = await app();
    const { body } = await post(a, {
      url: COLLECTION_URL,
      dryRun: false,
      // review rows only import through an explicit candidate choice
      overrides: { [SONIC2_OFFER]: sonicId, [PROBOTECTOR_OFFER]: probotectorId },
    });
    expect(body.dryRun).toBe(false);
    expect(body.imported).toBe(3); // Sonic (matched), Sonic 2 + Probotector (overridden)

    const copies = await ctx!.db.select().from(ownedCopies);
    expect(copies).toHaveLength(3);
    const sonic2 = copies.find(
      (c) => c.acquiredUrl === `https://www.pricecharting.com/offer/${SONIC2_OFFER}`,
    )!;
    expect(sonic2.gameId).toBe(sonicId); // the game the override chose
    expect(sonic2.region).toBe("PAL");
    expect(sonic2.condition).toBe("loose");
    expect(sonic2.status).toBe("owned");
    expect(sonic2.acquiredSource).toBe("pricecharting_import");
    expect(sonic2.notes).toBe(
      "PriceCharting import: PAL Sega Game Gear — Item only; market value $4.24 at import",
    );
    // the public page has NO purchase prices: fabricating cost data is forbidden
    expect(copies.every((c) => c.acquiredPriceOriginal === null && c.acquiredPriceUsd === null)).toBe(true);

    const probotector = copies.find(
      (c) => c.acquiredUrl === `https://www.pricecharting.com/offer/${PROBOTECTOR_OFFER}`,
    )!;
    expect(probotector.gameId).toBe(probotectorId);
    expect(probotector.region).toBe("PAL");

    // match provenance: the auto-matched row records 'exact' + its score; the
    // override-imported rows chose a listed candidate, so 'candidate' + the
    // candidate's own capped score travels onto the copy
    const sonic = copies.find(
      (c) => c.acquiredUrl === `https://www.pricecharting.com/offer/${SONIC_OFFER}`,
    )!;
    expect(sonic.matchBasis).toBe("exact");
    expect(sonic.matchScore).toBe(1);
    expect(sonic2.matchBasis).toBe("candidate");
    expect(sonic2.matchScore).toBe(0.44);
    expect(probotector.matchBasis).toBe("candidate");
    expect(probotector.matchScore).toBeGreaterThanOrEqual(0.25);
    expect(probotector.matchScore).toBeLessThan(0.45);
    await a.close();
  });

  it("respects the includeOfferIds selection for matched rows", async () => {
    const a = await app();
    const { body } = await post(a, {
      url: COLLECTION_URL,
      dryRun: false,
      includeOfferIds: [SONIC_OFFER],
    });
    expect(body.imported).toBe(1);
    const copies = await ctx!.db.select().from(ownedCopies);
    expect(copies).toHaveLength(1);
    expect(copies[0].acquiredUrl).toBe(`https://www.pricecharting.com/offer/${SONIC_OFFER}`);
    await a.close();
  });

  it("never imports a review row through includeOfferIds - an override is required", async () => {
    const a = await app();
    const { status, body } = await post(a, {
      url: COLLECTION_URL,
      dryRun: false,
      includeOfferIds: [SONIC2_OFFER, PROBOTECTOR_OFFER],
    });
    expect(status).toBe(200);
    expect(body.imported).toBe(0);
    expect(await ctx!.db.select().from(ownedCopies)).toHaveLength(0);
    await a.close();
  });

  it("imports an override-chosen review row with exactly the chosen gameId", async () => {
    // any existing game on the row's platform is a valid choice, candidate or
    // not — the user saw the row and decided what it is
    const [columns] = await ctx!.db
      .insert(games)
      .values({ title: "Columns", platform: "game_gear" })
      .returning({ id: games.id });
    const a = await app();
    const { body } = await post(a, {
      url: COLLECTION_URL,
      dryRun: false,
      includeOfferIds: [], // deselect every matched row: only the override imports
      overrides: { [SONIC2_OFFER]: columns.id },
    });
    expect(body.imported).toBe(1);
    const copies = await ctx!.db.select().from(ownedCopies);
    expect(copies).toHaveLength(1);
    expect(copies[0].gameId).toBe(columns.id);
    expect(copies[0].acquiredUrl).toBe(`https://www.pricecharting.com/offer/${SONIC2_OFFER}`);
    // Columns is NOT one of the row's candidates: an "Other" pick is 'manual'
    // provenance and no fuzzy score exists for it
    expect(copies[0].matchBasis).toBe("manual");
    expect(copies[0].matchScore).toBeNull();
    await a.close();
  });

  it("accepts a cross-platform override (existence-only validation)", async () => {
    const a = await app();
    // probotector's game lives on gb, the row is game_gear: the preview's
    // "Other" picker has a console selector precisely so the user can correct
    // a wrong platform mapping, so this must import, not 400.
    const crossPlatform = await post(a, {
      url: COLLECTION_URL,
      dryRun: false,
      overrides: { [SONIC2_OFFER]: probotectorId },
      includeOfferIds: [],
    });
    expect(crossPlatform.status).toBe(200);
    const copies = await ctx!.db.select().from(ownedCopies);
    expect(copies).toHaveLength(1);
    expect(copies[0].gameId).toBe(probotectorId);
    // a cross-platform pick can never be one of the platform-filtered
    // candidates, so it lands as 'manual' with no score
    expect(copies[0].matchBasis).toBe("manual");
    expect(copies[0].matchScore).toBeNull();
    await a.close();
  });

  it("rejects a nonexistent override game with 400 invalid_override and inserts NOTHING", async () => {
    const a = await app();
    const missingGame = await post(a, {
      url: COLLECTION_URL,
      dryRun: false,
      overrides: { [PROBOTECTOR_OFFER]: 999999 },
    });
    expect(missingGame.status).toBe(400);
    expect(missingGame.body).toMatchObject({ code: "invalid_override", offerId: PROBOTECTOR_OFFER });

    // all-or-nothing: the matched Sonic row was importable in this request,
    // but a single bad override must keep the whole import out of the DB
    expect(await ctx!.db.select().from(ownedCopies)).toHaveLength(0);
    await a.close();
  });

  it("never calls FX: PriceCharting values are native USD (works with the network fully blocked)", async () => {
    // the per-test MockAgent has disableNetConnect and NO frankfurter
    // intercept — any FX attempt would throw. The import must not care.
    const a = await app();
    const { status, body } = await post(a, { url: COLLECTION_URL });
    expect(status).toBe(200);
    const sonic = body.rows.find((r) => r.offerId === SONIC_OFFER)!;
    expect(sonic.valueUsd).toBe(6.86);
    await a.close();
  });

  it("rejects URLs that are not a pricecharting seller /offers link", async () => {
    const a = await app();
    const cases = [
      "https://evil.example.com/offers?seller=abc",
      "https://www.pricecharting.com/game/2254176",
      "https://www.pricecharting.com/offers?status=collection", // no seller
      "not a url at all",
    ];
    for (const url of cases) {
      const res = await a.inject({
        method: "POST",
        url: "/api/collection/import/pricecharting",
        payload: { url },
      });
      expect(res.statusCode).toBe(400);
    }
    await a.close();
  });

  it("maps a rate-limited fetch abort to a clean 502 with an actionable message", async () => {
    const failing: PageFetcher = async () => {
      throw new PcFetchError("PriceCharting still rate-limiting after 3 retries (statuses: 503, 503, 503, 503)", {
        statuses: [503, 503, 503, 503],
        attempts: 4,
      });
    };
    const a = await app(failing);
    const res = await a.inject({
      method: "POST",
      url: "/api/collection/import/pricecharting",
      payload: { url: COLLECTION_URL },
    });
    expect(res.statusCode).toBe(502);
    const body = res.json() as { error: string; code: string };
    // stable machine-readable code the client keys off of, plus a human
    // message the import panel can show directly instead of "fetch_failed"
    expect(body.code).toBe("fetch_failed");
    expect(body.error).toBe("PriceCharting is rate-limiting requests — wait a minute and try again");
    await a.close();
  });

  it("reuses the preview's fetch on confirm instead of re-fetching PriceCharting", async () => {
    let calls = 0;
    const countingFetcher: PageFetcher = async (url, cursor) => {
      calls++;
      return fixtureFetcher(url, cursor);
    };
    const a = await app(countingFetcher);

    const dry = await post(a, { url: COLLECTION_URL });
    expect(dry.status).toBe(200);
    const callsAfterPreview = calls;
    expect(callsAfterPreview).toBeGreaterThan(0); // sanity: the preview did fetch

    const confirmed = await post(a, { url: COLLECTION_URL, dryRun: false });
    expect(confirmed.status).toBe(200);
    // confirm hits the same cached collection: zero additional fetcher calls
    expect(calls).toBe(callsAfterPreview);
    await a.close();
  });
});
