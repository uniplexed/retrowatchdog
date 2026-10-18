import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { setupTestDb } from "../helpers/testDb.js";
import type { Db } from "../../src/db/index.js";
import { games, gameNames, pricePoints, sourceFetches, sourceMappings } from "../../src/db/schema.js";
/**
 * The URL a CeX point carries, which is what `listingUrlMatch` keys the stale-
 * point invalidation on: the CeX manifest's `productUrl`, applied by
 * `PluginCatalogAdapter`. The shape is what this suite depends on, so it is
 * written out here.
 */
const cexProductUrl = (boxId: string): string =>
  `https://uk.webuy.com/product-detail?id=${boxId}`;
import {
  demoteNumeralMismatchedMappings,
  findNumeralMismatchedMappings,
  isNumeralMismatched,
} from "../../src/matching/reviewNumeralMismatches.js";

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null; // no local Postgres: suite self-skips below
}

/** a game whose only name is its primary title */
const only = (title: string) => ({ primaryTitle: title, names: [title] });

describe("isNumeralMismatched (pure)", () => {
  it("flags the wrong siblings measured on the dev DB", () => {
    expect(isNumeralMismatched("Sonic the Hedgehog, Unboxed", only("Sonic the Hedgehog 2"))).toBe(true);
    expect(isNumeralMismatched("Probotector, Boxed", only("Probotector 2"))).toBe(true);
    expect(isNumeralMismatched("Mega Man, Unboxed", only("Mega Man 4"))).toBe(true);
    expect(isNumeralMismatched("Sim City, Boxed", only("SimCity 2000"))).toBe(true);
    expect(isNumeralMismatched("Final Fantasy VI (6) Advance, w/ Manual, Boxed", only("Final Fantasy Tactics Advance"))).toBe(true);
  });

  it("accepts roman/arabic pairs and ignores platform words that look like numerals", () => {
    expect(isNumeralMismatched("Mega Man IV, Boxed", only("Mega Man 4"))).toBe(false);
    expect(isNumeralMismatched("Sonic the Hedgehog 2, Boxed", only("Sonic the Hedgehog 2"))).toBe(false);
    // "N64" is stripped by cleanTitle before numerals are read, so it never counts as {"64"}
    expect(isNumeralMismatched("Legend Of Zelda Ocarina Of Time (N64), Boxed", only("The Legend of Zelda: Ocarina of Time"))).toBe(false);
  });

  it("accepts a listing named after an alternative name of the game (R2)", () => {
    expect(isNumeralMismatched("Lylat Wars, Boxed", { primaryTitle: "Star Fox 64", names: ["Star Fox 64", "Lylat Wars"] })).toBe(false);
    expect(isNumeralMismatched("Super Probotector: Alien Rebels, Boxed", {
      primaryTitle: "Contra III: The Alien Wars", names: ["Contra III: The Alien Wars", "Super Probotector: Alien Rebels"],
    })).toBe(false);
  });
});

describe.skipIf(ctx === null)("demoteNumeralMismatchedMappings (sweep)", () => {
  let db: Db;
  let sonic2Id: number;
  let megaMan4Id: number;
  let contraId: number;
  const fetchedAt = new Date("2026-09-01T03:00:00Z");

  const seed = async (title: string, platform: string): Promise<number> => {
    const [g] = await db.insert(games).values({ title, platform }).returning({ id: games.id });
    await db.insert(gameNames).values({ gameId: g.id, name: title });
    return g.id;
  };
  /**
   * A stored price point, keyed on the PRODUCT ID the sweep matches by since
   * migration 0014. The URL rides along because the app still stores one and
   * two cases below assert on it — but nothing MATCHES on it any more, which is
   * the point: one rule for every source, rather than one arm per family over
   * the shape of a link.
   */
  const point = (gameId: number, source: string, productId: string | null, kind = "sell") => ({
    gameId, source, region: "PAL", condition: "cib", kind,
    priceUsd: "20.00", priceOriginal: "20.00", currencyOriginal: "GBP",
    sourceProductId: productId,
    sourceUrl: productId === null ? null : cexProductUrl(productId),
    fetchedAt,
  });

  beforeEach(async () => {
    await ctx!.truncateAll();
    db = ctx!.db;
    sonic2Id = await seed("Sonic the Hedgehog 2", "megadrive");
    megaMan4Id = await seed("Mega Man 4", "nes");
    const zeldaId = await seed("The Legend of Zelda: Ocarina of Time", "n64");
    contraId = await seed("Contra III: The Alien Wars", "snes");
    await db.insert(gameNames).values({ gameId: contraId, name: "Super Probotector: Alien Rebels" });
    await db.insert(sourceMappings).values([
      // wrong siblings confirmed by trigram similarity alone: to be demoted
      { gameId: sonic2Id, source: "cex", sourceProductId: "sonic1", sourceTitle: "Sonic the Hedgehog, Unboxed", matchScore: 0.9, status: "confirmed" },
      { gameId: megaMan4Id, source: "cex", sourceProductId: "mm1", sourceTitle: "Mega Man, Unboxed", matchScore: 0.85, status: "confirmed" },
      // honest confirmations: numerals agree (arabic, roman, platform word stripped, alt name)
      { gameId: sonic2Id, source: "cex", sourceProductId: "sonic2", sourceTitle: "Sonic the Hedgehog 2, Boxed", matchScore: 1, status: "confirmed" },
      { gameId: megaMan4Id, source: "cex", sourceProductId: "mm4", sourceTitle: "Mega Man IV, Boxed", matchScore: 0.7, status: "confirmed" },
      { gameId: zeldaId, source: "cex", sourceProductId: "oot", sourceTitle: "Legend Of Zelda Ocarina Of Time (N64), Boxed", matchScore: 0.8, status: "confirmed" },
      { gameId: contraId, source: "cex", sourceProductId: "probotector", sourceTitle: "Super Probotector: Alien Rebels, Boxed", matchScore: 0.95, status: "confirmed" },
      // already under review: not confirmed, so not the sweep's business
      { gameId: sonic2Id, source: "cex", sourceProductId: "sonic1-review", sourceTitle: "Sonic the Hedgehog, Boxed", matchScore: 0.59, status: "needs_review" },
      // another source's mismatch: out of scope for a cex sweep
      { gameId: sonic2Id, source: "ebay_uk", sourceProductId: "e1", sourceTitle: "Sonic the Hedgehog Mega Drive", matchScore: 0.9, status: "confirmed" },
    ]);
  });
  afterAll(async () => ctx?.pool.end());

  const statusOf = async (sourceProductId: string): Promise<string> =>
    (await db.select().from(sourceMappings).where(eq(sourceMappings.sourceProductId, sourceProductId)))[0].status;

  it("finds exactly the confirmed cex mappings whose numerals disagree with every name of their game", async () => {
    const { scanned, mismatched } = await findNumeralMismatchedMappings(db, "cex");
    expect(scanned).toBe(6);
    expect(mismatched.map((m) => m.sourceProductId).sort()).toEqual(["mm1", "sonic1"]);
    expect(mismatched.find((m) => m.sourceProductId === "sonic1")).toMatchObject({
      gameId: sonic2Id, gameTitle: "Sonic the Hedgehog 2", platform: "megadrive", matchScore: 0.9,
    });
  });

  it("dry run reports the would-be demotions and writes nothing", async () => {
    const result = await demoteNumeralMismatchedMappings(db, { source: "cex", dryRun: true });
    expect(result.mismatched.map((m) => m.sourceProductId).sort()).toEqual(["mm1", "sonic1"]);
    expect(result.demoted).toBe(0);
    expect(await statusOf("sonic1")).toBe("confirmed");
    expect(await statusOf("mm1")).toBe("confirmed");
  });

  it("the real run demotes them to needs_review, keeps the rows, and leaves everything else alone", async () => {
    const result = await demoteNumeralMismatchedMappings(db, { source: "cex", dryRun: false });
    expect(result.scanned).toBe(6);
    expect(result.demoted).toBe(2);
    expect(await statusOf("sonic1")).toBe("needs_review");
    expect(await statusOf("mm1")).toBe("needs_review");
    for (const kept of ["sonic2", "mm4", "oot", "probotector", "e1"]) expect(await statusOf(kept)).toBe("confirmed");
    expect(await statusOf("sonic1-review")).toBe("needs_review");
    expect(await db.select().from(sourceMappings)).toHaveLength(8); // never deletes
  });

  it("is idempotent: a second run scans past the demoted rows and demotes nothing", async () => {
    await demoteNumeralMismatchedMappings(db, { source: "cex", dryRun: false });
    const second = await demoteNumeralMismatchedMappings(db, { source: "cex", dryRun: false });
    expect(second.scanned).toBe(4);
    expect(second.mismatched).toEqual([]);
    expect(second.demoted).toBe(0);
  });

  describe("stale cache invalidation (R5)", () => {
    let otherGameId: number;
    beforeEach(async () => {
      otherGameId = await seed("Sonic the Hedgehog", "megadrive");
      await db.insert(pricePoints).values([
        // stale: the wrong sibling's listing, attributed to Sonic 2 through the mapping about to be demoted (two batches)
        point(sonic2Id, "cex", "sonic1"),
        { ...point(sonic2Id, "cex", "sonic1", "cash"), fetchedAt: new Date("2026-08-30T03:00:00Z") },
        // stale: a mapping that was needs_review all along but had rows written before the status gate
        point(sonic2Id, "cex", "sonic1-review"),
        // legit: Sonic 2's own box, and Mega Man IV under Mega Man 4
        point(sonic2Id, "cex", "sonic2"),
        point(megaMan4Id, "cex", "mm4"),
        // the same wrong listing stored under ANOTHER game (a later, correct mapping): not this mapping's game, kept
        point(otherGameId, "cex", "sonic1"),
        // another source's rows are never a cex sweep's business, URL or not
        point(sonic2Id, "ebay_uk", null, "active_median"),
      ]);
      // Sonic 2 has a fresh marker; Mega Man 4 has none at all
      await db.insert(sourceFetches).values({ gameId: sonic2Id, source: "cex", fetchedAt });
    });

    const staleRows = async () =>
      db.select().from(pricePoints).where(and(eq(pricePoints.gameId, sonic2Id), eq(pricePoints.sourceUrl, cexProductUrl("sonic1"))));
    const markerOf = async (gameId: number) =>
      (await db.select().from(sourceFetches).where(and(eq(sourceFetches.gameId, gameId), eq(sourceFetches.source, "cex"))))[0] ?? null;

    it("dry run reports what it would delete, grouped by game, and deletes nothing", async () => {
      const result = await demoteNumeralMismatchedMappings(db, { source: "cex", dryRun: true });
      expect(result.invalidation).toMatchObject({ supported: true, stalePricePoints: 3, pricePointsDeleted: 0, fetchMarkersExpired: 0 });
      expect(result.invalidation.games).toEqual([
        { gameId: sonic2Id, gameTitle: "Sonic the Hedgehog 2", platform: "megadrive", pricePoints: 3 },
      ]);
      expect(await db.select().from(pricePoints)).toHaveLength(7);
      expect((await markerOf(sonic2Id))?.fetchedAt).toEqual(fetchedAt);
    });

    it("the real run deletes only the demoted mappings' rows under their wrong game and expires those games' markers", async () => {
      const result = await demoteNumeralMismatchedMappings(db, { source: "cex", dryRun: false });
      expect(result.invalidation).toMatchObject({ stalePricePoints: 3, pricePointsDeleted: 3, fetchMarkersExpired: 1 });
      expect(await staleRows()).toHaveLength(0);
      const left = await db.select().from(pricePoints);
      expect(left).toHaveLength(4);
      // kept: Sonic 2's own box, Mega Man IV, the wrong listing under the OTHER game, the eBay median
      expect(left.map((r) => `${r.gameId}:${r.source}:${r.sourceUrl ?? "-"}`).sort()).toEqual(
        [
          `${sonic2Id}:cex:${cexProductUrl("sonic2")}`,
          `${megaMan4Id}:cex:${cexProductUrl("mm4")}`,
          `${otherGameId}:cex:${cexProductUrl("sonic1")}`,
          `${sonic2Id}:ebay_uk:-`,
        ].sort(),
      );
      // Sonic 2's marker is expired (not deleted: deletion would fall back to price_points.fetched_at and still read fresh)
      expect((await markerOf(sonic2Id))?.fetchedAt).toEqual(new Date(0));
      // Mega Man 4 lost no rows: its (absent) marker stays absent
      expect(await markerOf(megaMan4Id)).toBeNull();
    });

    it("inserts an expired marker for an affected game that never had one", async () => {
      await db.insert(pricePoints).values(point(megaMan4Id, "cex", "mm1"));
      const result = await demoteNumeralMismatchedMappings(db, { source: "cex", dryRun: false });
      expect(result.invalidation.games.map((g) => g.gameId).sort()).toEqual([megaMan4Id, sonic2Id].sort());
      expect(result.invalidation.fetchMarkersExpired).toBe(2);
      expect((await markerOf(megaMan4Id))?.fetchedAt).toEqual(new Date(0));
    });

    it("is idempotent: a second run finds nothing stale and re-expires nothing", async () => {
      await demoteNumeralMismatchedMappings(db, { source: "cex", dryRun: false });
      // the game was viewed again in between: a fresh marker must survive the second run
      const refreshed = new Date("2026-09-02T09:00:00Z");
      await db.update(sourceFetches).set({ fetchedAt: refreshed }).where(eq(sourceFetches.gameId, sonic2Id));
      const second = await demoteNumeralMismatchedMappings(db, { source: "cex", dryRun: false });
      expect(second.invalidation).toMatchObject({ stalePricePoints: 0, pricePointsDeleted: 0, fetchMarkersExpired: 0, games: [] });
      expect((await markerOf(sonic2Id))?.fetchedAt).toEqual(refreshed);
      expect(await db.select().from(pricePoints)).toHaveLength(4);
    });

    it("links an eBay row by its item id, which no URL template could express", async () => {
      // eBay is why the key is the product id and not the manifest's product
      // template: its stored link is the SELLER's own, on whichever of
      // ebay.co.uk/.de/.es/.fr/.com they are on and with tracking parameters
      // after it, and the only stable part is the middle segment of the
      // `v1|<legacy>|<variation>` id. The point carries that id outright now.
      await db.insert(sourceMappings).values({
        gameId: sonic2Id, source: "ebay_uk", sourceProductId: "v1|236876365636|0",
        sourceTitle: "Sonic the Hedgehog Mega Drive PAL", matchScore: 0.9, status: "confirmed",
      });
      await db.insert(pricePoints).values([
        {
          ...point(sonic2Id, "ebay_uk", "v1|236876365636|0", "active_listing"),
          sourceUrl: "https://www.ebay.co.uk/itm/236876365636?_skw=sonic&hash=item3726ee7f44",
        },
        {
          ...point(sonic2Id, "ebay_uk", "v1|158042265250|0", "active_listing"),
          sourceUrl: "https://www.ebay.co.uk/itm/158042265250?_skw=sonic",
        },
      ]);
      const result = await demoteNumeralMismatchedMappings(db, { source: "ebay_uk", dryRun: false });
      // both eBay mappings of Sonic 2 lack the 2: demoted; only the one whose URL is stored is invalidated
      expect(result.demoted).toBe(2);
      expect(result.invalidation).toMatchObject({ supported: true, stalePricePoints: 1, pricePointsDeleted: 1 });
      const ebayLeft = await db.select().from(pricePoints).where(eq(pricePoints.source, "ebay_uk"));
      expect(ebayLeft.map((r) => r.sourceUrl).sort()).toEqual([null, "https://www.ebay.co.uk/itm/158042265250?_skw=sonic"].sort());
    });

    it("invalidates a source whose family this app has never heard of, and which stores no link at all", async () => {
      // THE DEFECT THE RE-KEYING CLOSED. The match used to be a switch over URL
      // SHAPES with one arm per family and nothing for the rest, so the first
      // source whose family was neither `cex` nor `ebay` — Vinted, or any sync
      // plugin — had its mappings demoted while nothing was invalidated: no
      // error, no log line, no stale row deleted, and a game view serving the
      // wrong listing's price for another TTL. `shop_zz` is such a source, and
      // it stores no URL either, which the old rule could not have matched even
      // with an arm of its own.
      await db.insert(sourceMappings).values({
        gameId: sonic2Id, source: "shop_zz", sourceProductId: "ZZ-1",
        sourceTitle: "Sonic the Hedgehog, Unboxed", matchScore: 0.9, status: "confirmed",
      });
      await db.insert(pricePoints).values({ ...point(sonic2Id, "shop_zz", "ZZ-1"), sourceUrl: null });
      const result = await demoteNumeralMismatchedMappings(db, { source: "shop_zz", dryRun: false });
      expect(result.demoted).toBe(1);
      expect(result.invalidation).toMatchObject({ supported: true, stalePricePoints: 1, pricePointsDeleted: 1 });
      expect(await db.select().from(pricePoints).where(eq(pricePoints.source, "shop_zz"))).toHaveLength(0);
    });
  });
});
