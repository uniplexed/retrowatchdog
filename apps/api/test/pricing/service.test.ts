import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type pg from "pg";
import { eq } from "drizzle-orm";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import type { Platform } from "@retrowatchdog/shared";
import { setupTestDb } from "../helpers/testDb.js";
import type { Db } from "../../src/db/index.js";
import { games, gameNames, pricePoints, sourceMappings } from "../../src/db/schema.js";
import { getPricesForGame, loadStoredBlock } from "../../src/pricing/service.js";
import type { PriceSourceAdapter, RawListing } from "../../src/adapters/types.js";
import type { NormalizedListing } from "../../src/adapters/types.js";
import { classifyCatalogListing } from "../../src/adapters/classifyListing.js";
import { classifyListing } from "../../src/adapters/classifyListing.js";
import { median, trimOutliers } from "../../src/pricing/median.js";
import { stubAdapter } from "../helpers/stubAdapter.js";
import { resetFxCacheForTests } from "../../src/pricing/fx.js";
import { saveEnabledSources } from "../../src/settings/markets.js";
import { config } from "../../src/config.js";
import { buildSourceRuntime } from "../../src/sources/registry.js";

/**
 * What the deleted `normalizeCexListing` was: the shared catalogue reading with
 * CeX's own declared region. The CeX shops declare PAL in the plugin manifest.
 */
const normalizeCexListing = (raw: RawListing): NormalizedListing =>
  classifyCatalogListing(raw, "PAL");


async function seedGameWithMapping(
  db: Db, title: string, platform: string, source: string, sourceProductId: string,
): Promise<number> {
  const [g] = await db.insert(games).values({ title, platform }).returning({ id: games.id });
  await db.insert(gameNames).values({ gameId: g.id, name: title });
  await db.insert(sourceMappings).values({
    gameId: g.id, source, sourceProductId, sourceTitle: title, matchScore: 1, status: "confirmed",
  });
  return g.id;
}

function fakeCex(listings: RawListing[] | Error): PriceSourceAdapter & { searchSpy: ReturnType<typeof vi.fn> } {
  const searchSpy = vi.fn(async () => {
    if (listings instanceof Error) throw listings;
    return listings;
  });
  return { ...stubAdapter({ source: "cex", search: searchSpy, normalize: normalizeCexListing }), searchSpy };
}

/**
 * The shared classifier plus one eBay-specific fact, "a Browse item summary is
 * a live listing, so it is buyable by definition" — which the eBay plugin's own
 * mapping.ts stamps on the wire as `available: true`, before this ever runs.
 */
function fakeEbay(listings: RawListing[]): PriceSourceAdapter {
  return stubAdapter({
    source: "ebay_uk",
    snapshotStrategy: "median_of_listings",
    // eBay's own roles, matching `ebayListing()`'s "active_listing" price --
    // medianPointsFrom reads this to find the buy_listing-role price and the
    // kind to write both aggregate halves under (task 4).
    kindRoles: { active_median: "reference", active_listing: "buy_listing" },
    search: async () => listings,
    normalize: (raw) => ({ ...classifyListing(raw), available: true }),
  });
}

const notConfigured: PriceSourceAdapter = stubAdapter({
  source: "pricecharting",
  isConfigured: () => false,
  search: async () => [],
  normalize: (raw) => ({ ...raw, cleanTitle: raw.title, platformGuess: null, regionGuess: "unknown", conditionGuess: "unknown" }),
});

const zeldaCexListing: RawListing = {
  sourceProductId: "box-oot-boxed",
  title: "Legend Of Zelda Ocarina Of Time, Boxed",
  categoryText: "Nintendo N64 Games",
  url: "https://uk.webuy.com/product-detail?id=box-oot-boxed",
  prices: [
    { kind: "sell", amount: 60, currency: "GBP" },
    { kind: "cash", amount: 38, currency: "GBP" },
    { kind: "voucher", amount: 48, currency: "GBP" },
  ],
};

const ebayListing = (id: string, title: string, amount: number): RawListing => ({
  sourceProductId: id,
  title,
  url: `https://www.ebay.co.uk/itm/${id}`,
  prices: [{ kind: "active_listing", amount, currency: "GBP" }],
});

describe("getPricesForGame", () => {
  let db: Db;
  let pool: pg.Pool;
  let truncateAll: () => Promise<void>;
  let zelda: { id: number; title: string; platform: Platform };

  beforeAll(async () => {
    ({ db, pool, truncateAll } = await setupTestDb());
  });
  beforeEach(async () => {
    await truncateAll();
    const [g] = await db
      .insert(games)
      .values({ igdbId: 1029, title: "The Legend of Zelda: Ocarina of Time", platform: "n64", year: 1998 })
      .returning({ id: games.id });
    await db.insert(gameNames).values({ gameId: g.id, name: "The Legend of Zelda: Ocarina of Time" });
    zelda = { id: g.id, title: "The Legend of Zelda: Ocarina of Time", platform: "n64" };
  });
  afterAll(async () => await pool.end());

  it("reports not_configured sources honestly", async () => {
    // The enabled-markets setting decides which sources get a block at all,
    // so this case enables its stub explicitly: an ENABLED source whose
    // adapter has no credentials still gets its own honest not_configured
    // block, it is not quietly dropped.
    await saveEnabledSources(db, ["pricecharting"]);
    const blocks = await getPricesForGame(db, [notConfigured], zelda);
    expect(blocks).toEqual([{ source: "pricecharting", status: "not_configured", points: [] }]);
  });

  it("fetches live, persists matched points and serves from cache on the second call", async () => {
    const cex = fakeCex([zeldaCexListing]);
    const first = await getPricesForGame(db, [cex], zelda);
    expect(first[0].status).toBe("ok");
    expect(first[0].points.map((p) => p.kind).sort()).toEqual(["cash", "sell", "voucher"]);
    expect(first[0].points.find((p) => p.kind === "sell")?.priceUsd).toBe(60);
    expect(await db.select().from(pricePoints)).toHaveLength(3);

    const second = await getPricesForGame(db, [cex], zelda);
    expect(second[0].status).toBe("ok");
    expect(second[0].points).toHaveLength(3);
    expect(cex.searchSpy).toHaveBeenCalledTimes(1); // TTL cache hit
  });

  it("persists the CeX stock flag on every price of a listing and exposes it on the DTO", async () => {
    const outOfStock: RawListing = {
      ...zeldaCexListing,
      sourceProductId: "box-oot-unboxed",
      title: "Legend Of Zelda Ocarina Of Time, Unboxed",
      available: false,
    };
    const inStock: RawListing = { ...zeldaCexListing, available: true };
    const [block] = await getPricesForGame(db, [fakeCex([inStock, outOfStock])], zelda);
    expect(block.points).toHaveLength(6);
    const cibPoints = block.points.filter((p) => p.condition === "cib");
    const loosePoints = block.points.filter((p) => p.condition === "loose");
    expect(cibPoints.map((p) => p.available)).toEqual([true, true, true]);
    // the cash/voucher bids of an out-of-stock box carry the flag too: the
    // signal engine, not the snapshot, decides per role what it means
    expect(loosePoints.map((p) => p.available)).toEqual([false, false, false]);
    const rows = await db.select().from(pricePoints);
    expect(rows.filter((r) => r.available === false)).toHaveLength(3);
    expect(rows.filter((r) => r.available === true)).toHaveLength(3);
  });

  it("stores a null flag for listings whose source reported no stock information", async () => {
    // zeldaCexListing carries no `available` at all (legacy/unknown shape)
    const [block] = await getPricesForGame(db, [fakeCex([zeldaCexListing])], zelda);
    expect(block.points.map((p) => p.available)).toEqual([null, null, null]);
  });

  it("eBay: medians carry a null flag, cheapest active listings carry true", async () => {
    const ebay = fakeEbay([
      ebayListing("a1", "Zelda Ocarina of Time N64 PAL boxed", 40),
      ebayListing("a2", "Zelda Ocarina of Time N64 PAL boxed complete", 44),
    ]);
    const [block] = await getPricesForGame(db, [ebay], zelda);
    const median = block.points.find((p) => p.kind === "active_median");
    expect(median?.available).toBeNull();
    const listings = block.points.filter((p) => p.kind === "active_listing");
    expect(listings).toHaveLength(2);
    expect(listings.every((p) => p.available === true)).toBe(true);
  });

  it("computes per-(region,condition) eBay medians plus cheapest active listings", async () => {
    const ebay = fakeEbay([
      ebayListing("e1", "Zelda Ocarina of Time N64 PAL boxed", 40),
      ebayListing("e2", "Zelda Ocarina of Time N64 PAL boxed complete", 44),
      ebayListing("e3", "Zelda Ocarina of Time N64 PAL cib", 48),
      ebayListing("e4", "Zelda Ocarina of Time N64 japan import", 20),
      ebayListing("e5", "Zelda Ocarina of Time N64 jap", 24),
    ]);
    const blocks = await getPricesForGame(db, [ebay], zelda);
    const points = blocks[0].points;
    const medians = points.filter((p) => p.kind === "active_median");
    const palCib = medians.find((p) => p.region === "PAL" && p.condition === "cib");
    const jap = medians.find((p) => p.region === "NTSC_J");
    expect(palCib?.priceUsd).toBe(44);
    expect(palCib?.sampleSize).toBe(3);
    expect(jap?.priceUsd).toBe(22);
    expect(points.filter((p) => p.kind === "active_listing").length).toBeGreaterThan(0);
  });

  it("D5: the printed sample size is this (region, condition) sample, whatever size the adapter handed it", async () => {
    // The UI renders `(${p.sampleSize} listings)` next to the active median
    // (apps/web/src/components/PriceTable.tsx). It is the count of listings
    // in this (region, condition) sample — NOT the count the median was
    // computed over, which is that sample's [P10, P90] band.
    //
    // CORRECTED 2026-09-05: an earlier version of this test fed EXACTLY
    // config.SIDECAR_MEDIAN_WINDOW listings and asserted sampleSize equalled
    // that same constant — which cannot fail whether or not the service caps
    // anything, since input size and expected output were identical by
    // construction. Nothing in pricing/service.ts references
    // SIDECAR_MEDIAN_WINDOW (grepped 2026-09-05: zero hits) — the service
    // does not re-cap, re-derive or truncate a sample; it reports exactly
    // what its adapter handed it. Proving that requires feeding MORE than one
    // window's worth and confirming the reported size is the larger number,
    // not silently clamped down to the window. The actual one-window CAP is
    // enforced upstream, by SIDECAR_MEDIAN_WINDOW inside
    // SidecarAdapter.collect, pinned in test/adapters/sidecar/adapter.test.ts's
    // "restores a SINGLE price cutoff when a plugin answers with two merged
    // windows" — this test only pins the service's half of the boundary.
    const prices = Array.from({ length: config.SIDECAR_MEDIAN_WINDOW + 10 }, (_, i) => 20 + i);
    const ebay = fakeEbay(
      prices.map((amount, i) => ebayListing(`w${i}`, `Zelda Ocarina of Time N64 PAL boxed complete`, amount)),
    );
    const blocks = await getPricesForGame(db, [ebay], zelda);
    const palCib = blocks[0].points.find(
      (p) => p.kind === "active_median" && p.region === "PAL" && p.condition === "cib",
    );
    // one window's worth PLUS TEN survives intact: the service never clamps
    // it back down to config.SIDECAR_MEDIAN_WINDOW on its own
    expect(palCib?.sampleSize).toBe(prices.length);
    expect(palCib?.sampleSize).toBeGreaterThan(config.SIDECAR_MEDIAN_WINDOW);
    expect(palCib?.priceUsd).toBe(median(trimOutliers(prices)));
  });

  it("excludes fair/poor graded listings from the median sample AND the cheapest rows", async () => {
    const ebay = fakeEbay([
      ebayListing("g1", "Zelda Ocarina of Time N64 PAL boxed", 40),
      ebayListing("g2", "Zelda Ocarina of Time N64 PAL boxed complete", 44),
      ebayListing("g3", "Zelda Ocarina of Time N64 PAL cib", 48),
      // grades poor: not a market-price comparable, must not deflate the median
      ebayListing("g4", "Zelda Ocarina of Time N64 PAL boxed faulty", 10),
    ]);
    const blocks = await getPricesForGame(db, [ebay], zelda);
    const points = blocks[0].points;
    const palCib = points.find(
      (p) => p.kind === "active_median" && p.region === "PAL" && p.condition === "cib",
    );
    // without the exclusion this would be median([10,40,44,48]) = 42 over 4
    // listings (trimOutliers is a no-op below n=5, so the £10 would count)
    expect(palCib?.priceUsd).toBe(44);
    expect(palCib?.sampleSize).toBe(3);
    // the faulty listing also never becomes an active_listing row: it would
    // otherwise surface in cheapestListings (rendered as a bare price, no
    // room for a grade caveat) and feed UNDERPRICED as a fake bargain
    const listingPoints = points.filter((p) => p.kind === "active_listing");
    expect(listingPoints).toHaveLength(3);
    expect(listingPoints.some((p) => p.priceUsd === 10)).toBe(false);
  });

  it("keeps mint listings in the median and carries the grade on their active_listing rows", async () => {
    // full title on the mint listing: the grade word is not cleanTitle noise,
    // and only a CONFIRMED match (>= MATCH_CONFIRM_THRESHOLD) is attributed
    const ebay = fakeEbay([
      ebayListing("m1", "Legend of Zelda Ocarina of Time N64 PAL boxed mint", 60),
      ebayListing("m2", "Zelda Ocarina of Time N64 PAL boxed", 40),
    ]);
    const blocks = await getPricesForGame(db, [ebay], zelda);
    const points = blocks[0].points;
    const palCib = points.find(
      (p) => p.kind === "active_median" && p.region === "PAL" && p.condition === "cib",
    );
    // mint stays IN the shared sample (only fair/poor are excluded)
    expect(palCib?.priceUsd).toBe(50);
    expect(palCib?.sampleSize).toBe(2);
    const listingPoints = points.filter((p) => p.kind === "active_listing");
    expect(listingPoints.find((p) => p.priceUsd === 60)?.grade).toBe("mint");
    expect(listingPoints.find((p) => p.priceUsd === 40)?.grade).toBeNull();
  });

  it("caches a zero-match live fetch: second call within TTL does not hit the adapter (finding 3)", async () => {
    // Matches nothing in the catalog: trigram similarity against "The Legend
    // of Zelda: Ocarina of Time" falls well below MATCH_REVIEW_THRESHOLD, so
    // resolveListing() returns null and zero price_points get inserted.
    const unknownListing: RawListing = {
      sourceProductId: "totally-unknown-9999",
      title: "Totally Unknown Game 9999",
      categoryText: "Nintendo N64 Games",
      url: "https://uk.webuy.com/product-detail?id=totally-unknown-9999",
      prices: [
        { kind: "sell", amount: 5, currency: "GBP" },
        { kind: "cash", amount: 2, currency: "GBP" },
        { kind: "voucher", amount: 3, currency: "GBP" },
      ],
    };
    const cex = fakeCex([unknownListing]);

    const first = await getPricesForGame(db, [cex], zelda);
    expect(first[0].status).toBe("ok");
    expect(first[0].points).toHaveLength(0);
    expect(first[0].fetchedAt).toBeDefined();
    expect(await db.select().from(pricePoints)).toHaveLength(0);

    const second = await getPricesForGame(db, [cex], zelda);
    expect(second[0].status).toBe("ok");
    expect(second[0].points).toHaveLength(0);
    expect(cex.searchSpy).toHaveBeenCalledTimes(1); // TTL cache hit despite zero matches
  });

  it("attributes a listing only through a CONFIRMED mapping: needs_review listings never become price points", async () => {
    // Sonic 2 is the only Sonic in the catalog; the plain "Sonic the Hedgehog"
    // box trigram-matches it at ~0.9 but is numeral-capped to needs_review
    const [g] = await db
      .insert(games)
      .values({ igdbId: 2002, title: "Sonic the Hedgehog 2", platform: "megadrive" })
      .returning({ id: games.id });
    await db.insert(gameNames).values({ gameId: g.id, name: "Sonic the Hedgehog 2" });
    const sonic2 = { id: g.id, title: "Sonic the Hedgehog 2", platform: "megadrive" as Platform };
    const box = (id: string, title: string): RawListing => ({
      sourceProductId: id,
      title,
      categoryText: "Mega Drive Software",
      url: null,
      available: true,
      prices: [
        { kind: "sell", amount: 20, currency: "GBP" },
        { kind: "cash", amount: 8, currency: "GBP" },
        { kind: "voucher", amount: 11, currency: "GBP" },
      ],
    });
    const cex = fakeCex([box("sonic1", "Sonic the Hedgehog, Unboxed"), box("sonic2", "Sonic the Hedgehog 2, Boxed")]);
    const [block] = await getPricesForGame(db, [cex], sonic2);
    // only the confirmed box (Sonic 2 itself) contributes its 3 prices
    expect(block.points).toHaveLength(3);
    expect(block.points.every((p) => p.condition === "cib")).toBe(true);
    const mappings = await db.select().from(sourceMappings);
    expect(mappings.find((m) => m.sourceProductId === "sonic1")?.status).toBe("needs_review");
    expect(mappings.find((m) => m.sourceProductId === "sonic2")?.status).toBe("confirmed");
    const rows = await db.select().from(pricePoints);
    expect(rows.every((r) => r.listingTitle === "Sonic the Hedgehog 2, Boxed")).toBe(true);

    // once the right game exists the needs_review mapping re-resolves to it
    // and the listing surfaces on THAT game's page (live mode: fresh fetch)
    const [s1] = await db
      .insert(games)
      .values({ igdbId: 2001, title: "Sonic the Hedgehog", platform: "megadrive" })
      .returning({ id: games.id });
    await db.insert(gameNames).values({ gameId: s1.id, name: "Sonic the Hedgehog" });
    const [sonic1Block] = await getPricesForGame(
      db, [cex], { id: s1.id, title: "Sonic the Hedgehog", platform: "megadrive" }, { mode: "live" },
    );
    expect(sonic1Block.points).toHaveLength(3);
    expect(sonic1Block.points.every((p) => p.condition === "loose")).toBe(true);
    expect((await db.select().from(sourceMappings).where(eq(sourceMappings.sourceProductId, "sonic1")))[0])
      .toMatchObject({ gameId: s1.id, status: "confirmed" });
  });

  it("never prices a listing that names a console this app does not track (Xbox copies of a Dreamcast game)", async () => {
    const [g] = await db
      .insert(games)
      .values({ igdbId: 1218, title: "Shenmue II", platform: "dreamcast" })
      .returning({ id: games.id });
    await db.insert(gameNames).values({ gameId: g.id, name: "Shenmue II" });
    const marketplace = fakeEbay([
      ebayListing("dc-1", "Shenmue II Sega Dreamcast PAL", 60),
      ebayListing("xb-1", "Shenmue II - Xbox", 7),
      ebayListing("xb-2", "Xbox Shenmue II sega game boxed", 8),
    ]);
    await getPricesForGame(db, [marketplace], { id: g.id, title: "Shenmue II", platform: "dreamcast" as Platform });
    const rows = await db.select().from(pricePoints);
    expect(rows.some((r) => /xbox/i.test(r.listingTitle ?? ""))).toBe(false);
    expect(rows.some((r) => r.listingTitle === "Shenmue II Sega Dreamcast PAL")).toBe(true);
    // and no mapping is written for them, so they cannot stick to the game later
    const mapped = await db.select().from(sourceMappings);
    expect(mapped.map((m) => m.sourceProductId).filter((id) => id.startsWith("xb-"))).toEqual([]);
  });

  it("passes the game's alternative names (its game_names rows minus the title) to every live search", async () => {
    await db.insert(gameNames).values([
      { gameId: zelda.id, name: "Zelda 64" },
      { gameId: zelda.id, name: "Zelda no Densetsu: Toki no Ocarina" },
    ]);
    const cex = fakeCex([zeldaCexListing]);
    const ebay = fakeEbay([]);
    const ebaySpy = vi.spyOn(ebay, "search");
    await getPricesForGame(db, [cex, ebay], zelda, { mode: "live" });
    const expected = { alternativeNames: ["Zelda 64", "Zelda no Densetsu: Toki no Ocarina"] };
    expect(cex.searchSpy).toHaveBeenCalledWith(zelda.title, "n64", expected);
    expect(ebaySpy).toHaveBeenCalledWith(zelda.title, "n64", expected);
  });

  it("costs no game_names query when the answer is served from the cache", async () => {
    // The lazy memo in getPricesForGame exists for exactly this: the names
    // are loaded only when some adapter actually goes live, so a fully cached
    // answer keeps costing what it cost before alternative names existed.
    await db.insert(gameNames).values({ gameId: zelda.id, name: "Zelda 64" });
    const cex = fakeCex([zeldaCexListing]);
    await getPricesForGame(db, [cex], zelda); // first call goes live and fills the cache
    const querySpy = vi.spyOn(pool, "query");
    const nameQueries = (): string[] =>
      querySpy.mock.calls
        .map(([first]) => {
          const arg = first as string | { text?: string };
          return typeof arg === "string" ? arg : (arg?.text ?? "");
        })
        .filter((sql) => sql.includes("game_names"));
    try {
      await getPricesForGame(db, [cex], zelda); // TTL hit: the stored block, no adapter call
      expect(cex.searchSpy).toHaveBeenCalledTimes(1);
      expect(nameQueries()).toEqual([]);
      // positive control: the live path DOES read them, so the empty list
      // above means "never queried", not "the spy saw nothing"
      await getPricesForGame(db, [cex], zelda, { mode: "live" });
      expect(nameQueries()).toHaveLength(1);
    } finally {
      querySpy.mockRestore();
    }
  });

  it("serves stale points with status error when the live fetch fails", async () => {
    await getPricesForGame(db, [fakeCex([zeldaCexListing])], zelda);
    const failing = fakeCex(new Error("cf block"));
    const blocks = await getPricesForGame(db, [failing], zelda, { ttlHours: 0 });
    expect(blocks[0].status).toBe("error");
    expect(blocks[0].points).toHaveLength(3); // stale data, honestly labeled
    expect(blocks[0].fetchedAt).toBeDefined();
  });

  it("uses min(observed_at) as the block's display timestamp, batch time for TTL", async () => {
    const observedAt = new Date("2026-08-30T03:00:00Z");
    const adapter = stubAdapter({
      source: "cex",
      search: async () => [
        {
          sourceProductId: "b1",
          title: "Super Metroid",
          prices: [{ kind: "sell" as const, amount: 40, currency: "GBP" }],
          url: null,
          observedAt,
        },
      ],
      normalize: (raw) => ({
        ...raw, cleanTitle: "super metroid", platformGuess: "snes",
        regionGuess: "PAL", conditionGuess: "loose",
      }),
    });
    // seed a matching game + confirmed mapping so resolveListing hits this game
    const gameId = await seedGameWithMapping(db, "Super Metroid", "snes", "cex", "b1");
    const [block] = await getPricesForGame(db, [adapter], { id: gameId, title: "Super Metroid", platform: "snes" }, { mode: "live" });
    expect(block.status).toBe("ok");
    expect(block.fetchedAt).toBe(observedAt.toISOString()); // display honesty
    const stored = await loadStoredBlock(db, gameId, "cex");
    expect(stored?.observedAt?.toISOString()).toBe(observedAt.toISOString());
    expect(stored!.fetchedAt.getTime()).toBeGreaterThan(observedAt.getTime()); // batch time preserved
  });

  it("serves a stored row whole for a source id the registry has no entry for at all", async () => {
    // `servedKinds` must return null — narrow NOTHING — for a source the
    // registry does not describe, not the empty set: nothing says what an
    // undescribed source may claim, so there is nothing to narrow it against.
    // A source that only resolves while a plugin row is approved keeps its
    // stored rows readable even after that row is gone; a build that
    // collapsed the two null branches into
    // `new Set(Object.keys(info?.kindRoles ?? {}))` would silently drop every
    // one of them here.
    const fetchedAt = new Date();
    await db.insert(pricePoints).values([
      {
        gameId: zelda.id, source: "mystery_source", region: "unknown", condition: "unknown",
        kind: "sell", priceUsd: "10.00", priceOriginal: "10.00", currencyOriginal: "USD", fetchedAt,
      },
      {
        gameId: zelda.id, source: "mystery_source", region: "unknown", condition: "unknown",
        kind: "active_median", priceUsd: "12.00", priceOriginal: "12.00",
        currencyOriginal: "USD", sampleSize: 5, fetchedAt,
      },
    ]);
    // An empty adapter list is fine: a registry's kindRoles come from the
    // (here, empty) `plugins` table, never from adapters — see
    // sources/registry.ts.
    const { registry } = await buildSourceRuntime(db, [], new Map());
    expect(registry.get("mystery_source")).toBeUndefined(); // the premise of this test
    const stored = await loadStoredBlock(db, zelda.id, "mystery_source", registry);
    expect(stored?.points.map((p) => p.kind).sort()).toEqual(["active_median", "sell"]);
  });

  it("dispatches on snapshotStrategy, not source id", async () => {
    // a per_listing adapter under the ebay_uk id must NOT produce a median row
    const adapter = stubAdapter({
      source: "ebay_uk",
      snapshotStrategy: "per_listing",
      search: async () => [
        { sourceProductId: "x1", title: "F-Zero", prices: [{ kind: "sell" as const, amount: 10, currency: "GBP" }], url: null },
      ],
      normalize: (raw) => ({ ...raw, cleanTitle: "f-zero", platformGuess: "snes", regionGuess: "PAL", conditionGuess: "loose" }),
    });
    const gameId = await seedGameWithMapping(db, "F-Zero", "snes", "ebay_uk", "x1");
    const [block] = await getPricesForGame(db, [adapter], { id: gameId, title: "F-Zero", platform: "snes" }, { mode: "live" });
    expect(block.points.map((p) => p.kind)).toEqual(["sell"]);
  });

  it("converts a non-USD median_of_listings currency to USD for both the median and the cheapest active_listing rows", async () => {
    // Regression guard (originally caught pre-USD-base): the cheapest rows
    // must store the CONVERTED amount as priceUsd (and sort by it), never the
    // raw source amount. Uses a non-1 rate on purpose — the suite-wide FX
    // stub answers 1, which would hide a missing conversion.
    const prevDispatcher = getGlobalDispatcher();
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    resetFxCacheForTests();
    agent
      .get("https://api.frankfurter.app")
      .intercept({ path: "/latest?from=GBP&to=USD", method: "GET" })
      .reply(200, { rates: { USD: 1.25 } });
    try {
      const adapter = stubAdapter({
        source: "ebay_uk",
        snapshotStrategy: "median_of_listings",
        kindRoles: { active_median: "reference", active_listing: "buy_listing" },
        search: async () => [
          {
            sourceProductId: "u1",
            title: "Chrono Trigger",
            prices: [{ kind: "active_listing" as const, amount: 100, currency: "GBP" }],
            url: null,
          },
        ],
        normalize: (raw) => ({
          ...raw, cleanTitle: "chrono trigger", platformGuess: "snes",
          regionGuess: "PAL", conditionGuess: "cib",
        }),
      });
      const gameId = await seedGameWithMapping(db, "Chrono Trigger", "snes", "ebay_uk", "u1");
      const [block] = await getPricesForGame(
        db, [adapter], { id: gameId, title: "Chrono Trigger", platform: "snes" }, { mode: "live" },
      );
      const listingPoint = block.points.find((p) => p.kind === "active_listing");
      const medianPoint = block.points.find((p) => p.kind === "active_median");
      expect(listingPoint?.priceUsd).toBe(125); // 100 GBP * 1.25, not the raw 100
      expect(medianPoint?.priceUsd).toBe(125);
      // evidence stays verbatim: a single-currency median keeps its source
      // currency and the median over the ORIGINAL amounts
      expect(medianPoint?.priceOriginal).toBe(100);
      expect(medianPoint?.currencyOriginal).toBe("GBP");

      const rows = await db.select().from(pricePoints).where(eq(pricePoints.gameId, gameId));
      const listingRow = rows.find((r) => r.kind === "active_listing");
      expect(Number(listingRow?.priceUsd)).toBeCloseTo(125);
      expect(Number(listingRow?.priceOriginal)).toBeCloseTo(100); // raw amount preserved
      expect(listingRow?.currencyOriginal).toBe("GBP"); // raw currency preserved
    } finally {
      setGlobalDispatcher(prevDispatcher);
      await agent.close();
      resetFxCacheForTests();
    }
  });
});
