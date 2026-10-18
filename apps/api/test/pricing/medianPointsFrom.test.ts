import { describe, expect, it } from "vitest";
import type { NormalizedListing } from "../../src/adapters/types.js";
import { medianPointsFrom } from "../../src/pricing/service.js";

const GAME_ID = 42;
const FETCHED_AT = new Date("2026-09-09T12:00:00Z");
/** No conversion, so a stored amount is the raw one -- this file is about
 * grouping, sample size and kind selection, not FX (fx.test.ts owns that). */
const FLAT_RATES = new Map<string, number>([["GBP", 1]]);
/** eBay's own roles, under eBay's own kind names -- see the describe block. */
const EBAY_KIND_ROLES = { active_median: "reference", active_listing: "buy_listing" } as const;

function ebayListing(
  id: string,
  amount: number,
  region: NormalizedListing["regionGuess"],
  condition: NormalizedListing["conditionGuess"],
  grade?: NormalizedListing["gradeGuess"],
): NormalizedListing {
  return {
    sourceProductId: id,
    title: `Some Game (${id})`,
    prices: [{ kind: "active_listing", amount, currency: "GBP" }],
    url: `https://www.ebay.co.uk/itm/${id}`,
    cleanTitle: `some game (${id})`,
    platformGuess: null,
    regionGuess: region,
    conditionGuess: condition,
    ...(grade === undefined ? {} : { gradeGuess: grade }),
  };
}

describe("medianPointsFrom -- pinned against today's eBay-shaped output (task 4, step 1)", () => {
  /**
   * Written BEFORE task 4 touches anything, over eBay's own two kind names
   * and roles, and asserting the FULL result: every kind, every amount, every
   * sample size, the grouping, and the cheapest-N selection. This is the
   * regression net for the whole task -- eBay is the only source with
   * `median_of_listings` on this deployment, its rows are single-priced, and
   * its declared kinds ARE `active_median`/`active_listing`, so this exact
   * test must still pass, unchanged, once the builder is re-keyed onto roles.
   */
  it("groups by region/condition, medians each group with outlier trimming, and keeps the cheapest 10 listings across all groups", () => {
    // PAL/cib: 10 listings, sorted 1..17 plus one outlier at 100 -- big enough
    // to exercise trimOutliers' real trim (n=10: drops the lowest and the
    // highest), not just the n<5 no-op.
    const palCib = [1, 10, 11, 12, 13, 14, 15, 16, 17, 100].map((amount, i) =>
      ebayListing(`pal-cib-${i}`, amount, "PAL", "cib"),
    );
    // NTSC_U/loose: 3 listings, under trimOutliers' n<5 floor -- no trim.
    const ntscLoose = [30, 40, 50].map((amount, i) => ebayListing(`ntsc-loose-${i}`, amount, "NTSC_U", "loose"));
    // Excluded before grouping even starts: a poor-graded listing is not a
    // market comparable, however cheap. Priced below every other row so its
    // absence from the cheapest strip is unambiguous.
    const poor = ebayListing("poor-1", 0.5, "PAL", "cib", "poor");

    const points = medianPointsFrom(
      "ebay_uk",
      EBAY_KIND_ROLES,
      [...palCib, ...ntscLoose, poor],
      GAME_ID,
      FETCHED_AT,
      FLAT_RATES,
    );

    const medians = points.filter((p) => p.kind === "active_median");
    const listingPoints = points.filter((p) => p.kind === "active_listing");
    // nothing else escapes these two kinds, and nothing carries the poor
    // listing's amount anywhere in the result
    expect(points).toHaveLength(medians.length + listingPoints.length);
    expect(points.some((p) => p.priceOriginal === "0.5")).toBe(false);

    expect(medians).toHaveLength(2);
    const palMedian = medians.find((p) => p.region === "PAL" && p.condition === "cib");
    expect(palMedian).toMatchObject({
      gameId: GAME_ID,
      source: "ebay_uk",
      region: "PAL",
      condition: "cib",
      kind: "active_median",
      priceUsd: "13.5",
      priceOriginal: "13.5",
      currencyOriginal: "GBP",
      sampleSize: 10,
      available: null,
      fetchedAt: FETCHED_AT,
    });
    // an aggregate carries no listing identity
    expect(palMedian?.sourceUrl).toBeUndefined();
    expect(palMedian?.listingTitle).toBeUndefined();
    expect(palMedian?.observedAt).toBeUndefined();

    const ntscMedian = medians.find((p) => p.region === "NTSC_U" && p.condition === "loose");
    expect(ntscMedian).toMatchObject({
      gameId: GAME_ID,
      source: "ebay_uk",
      region: "NTSC_U",
      condition: "loose",
      kind: "active_median",
      priceUsd: "40",
      priceOriginal: "40",
      currencyOriginal: "GBP",
      sampleSize: 3,
      available: null,
    });

    // cheapest 10 of the 13 comparables (poor excluded), by raw amount
    // ascending -- note "1" survives here even though the median above
    // trimmed it out of its OWN group's aggregate: the cheapest strip reads
    // from every comparable, never from the trimmed sample.
    expect(listingPoints).toHaveLength(10);
    expect(listingPoints.map((p) => p.priceOriginal)).toEqual([
      "1", "10", "11", "12", "13", "14", "15", "16", "17", "30",
    ]);
    for (const p of listingPoints) {
      expect(p.kind).toBe("active_listing");
      expect(p.source).toBe("ebay_uk");
      expect(p.gameId).toBe(GAME_ID);
      expect(p.currencyOriginal).toBe("GBP");
      expect(p.fetchedAt).toBe(FETCHED_AT);
    }
    // the group's own trimmed-out outlier (100) and NTSC's two most
    // expensive rows (40, 50) all rank outside the top 10
    expect(listingPoints.some((p) => p.priceOriginal === "100")).toBe(false);
    expect(listingPoints.some((p) => p.priceOriginal === "40")).toBe(false);
    expect(listingPoints.some((p) => p.priceOriginal === "50")).toBe(false);

    const cheapest = listingPoints.find((p) => p.priceOriginal === "1");
    expect(cheapest).toMatchObject({
      region: "PAL", condition: "cib", grade: null,
      sourceUrl: "https://www.ebay.co.uk/itm/pal-cib-0",
      listingTitle: "Some Game (pal-cib-0)",
    });
  });
});

/**
 * Kind names invented for these tests, never
 * eBay's `active_median`/`active_listing`: a test of this fix that reused
 * eBay's own vocabulary could not tell a role test from a name test, which
 * is exactly the bug this task removes.
 */
describe("medianPointsFrom -- aggregates by ROLE, under the source's own declared kinds", () => {
  it("writes the aggregate under the source's reference kind and the cheapest rows under its buy_listing kind", () => {
    // A source that calls its asking price "sell" and its own baseline
    // "guide" -- neither name is one eBay uses for either role.
    const kindRoles = { sell: "buy_listing", guide: "reference" } as const;
    const listings: NormalizedListing[] = [10, 12, 14].map((amount, i) => ({
      sourceProductId: `s${i}`,
      title: `Listing ${i}`,
      prices: [{ kind: "sell", amount, currency: "GBP" }],
      url: `https://shop.test/${i}`,
      cleanTitle: `listing ${i}`,
      platformGuess: null,
      regionGuess: "PAL",
      conditionGuess: "cib",
    }));

    const points = medianPointsFrom("shop_gb", kindRoles, listings, GAME_ID, FETCHED_AT, FLAT_RATES);

    // exactly one aggregate, under "guide" -- never the old hardcoded
    // "active_median", and never "sell" either
    const aggregates = points.filter((p) => p.sampleSize !== undefined && p.sampleSize !== null);
    expect(aggregates).toHaveLength(1);
    expect(aggregates[0]).toMatchObject({ kind: "guide", priceUsd: "12", sampleSize: 3 });

    // the per-listing rows sit under "sell" -- never the old hardcoded
    // "active_listing"
    const rows = points.filter((p) => p.kind !== "guide");
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.kind).toBe("sell");
    expect(rows.map((r) => r.priceOriginal).sort()).toEqual(["10", "12", "14"]);

    // no row anywhere still carries either of eBay's own kind names
    expect(points.some((p) => p.kind === "active_median" || p.kind === "active_listing")).toBe(false);
  });

  it("aggregates over the buy_listing-role price, never the first price in a listing's own array", () => {
    // Each row carries a decoy price FIRST (a trade-in offer, role "bid")
    // and the real buy_listing price SECOND. Position would pick the decoy;
    // role must pick "sell". The decoy is deliberately far off (999) so a
    // regression shows up as an obviously wrong number, not a rounding slip.
    const kindRoles = { sell: "buy_listing", cash: "bid", guide: "reference" } as const;
    const listings: NormalizedListing[] = [10, 12, 14, 16, 18, 20].map((amount, i) => ({
      sourceProductId: `m${i}`,
      title: `Listing ${i}`,
      prices: [
        { kind: "cash", amount: 999, currency: "GBP" },
        { kind: "sell", amount, currency: "GBP" },
      ],
      url: `https://shop.test/m${i}`,
      cleanTitle: `listing ${i}`,
      platformGuess: null,
      regionGuess: "PAL",
      conditionGuess: "cib",
    }));

    const points = medianPointsFrom("shop_gb", kindRoles, listings, GAME_ID, FETCHED_AT, FLAT_RATES);

    const aggregate = points.find((p) => p.kind === "guide");
    // median of [10,12,14,16,18,20] (n=6, no trim) = (14+16)/2 = 15 -- if the
    // decoy had been picked instead this would read 999
    expect(aggregate).toMatchObject({ priceUsd: "15", priceOriginal: "15", sampleSize: 6 });

    const rows = points.filter((p) => p.kind === "sell");
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.priceOriginal).sort((a, b) => Number(a) - Number(b))).toEqual([
      "10", "12", "14", "16", "18", "20",
    ]);
    // the decoy carries a role neither role lookup is looking for (bid, not
    // buy_listing or reference), so item 2 now stores it in its own right --
    // on its OWN kind ("cash"), never mixed into "sell" or "guide"
    expect(points.some((p) => p.kind === "sell" && p.priceOriginal === "999")).toBe(false);
    expect(points.some((p) => p.kind === "guide" && p.priceOriginal === "999")).toBe(false);
    const bidRows = points.filter((p) => p.kind === "cash");
    expect(bidRows).toHaveLength(6);
    for (const row of bidRows) expect(row.priceOriginal).toBe("999");
  });

  /**
   * F3 (whole-branch review, 2026-09-09): a price carrying neither the
   * `buy_listing` nor the `reference` role used to be read by no branch and
   * discarded with no log line and no error -- the same silent, role-less
   * disappearance the re-keying was written to remove, relocated from the
   * write KIND to the write SET. This is the CeX-shaped manifest the finding
   * names: a `bid` price (CeX's cash offer) alongside the buy_listing/
   * reference pair must reach storage, not vanish.
   */
  it("stores a price carrying neither aggregate role, exactly as a per_listing source would", () => {
    const kindRoles = { sell: "buy_listing", guide: "reference", cash: "bid", voucher: "bid" } as const;
    const listing: NormalizedListing = {
      sourceProductId: "s1",
      title: "Some Game",
      prices: [
        { kind: "sell", amount: 20, currency: "GBP" },
        { kind: "cash", amount: 12, currency: "GBP" },
        { kind: "voucher", amount: 15, currency: "GBP" },
      ],
      url: "https://shop.test/s1",
      cleanTitle: "some game",
      platformGuess: null,
      regionGuess: "PAL",
      conditionGuess: "cib",
    };

    const points = medianPointsFrom("shop_gb", kindRoles, [listing], GAME_ID, FETCHED_AT, FLAT_RATES);

    const cash = points.find((p) => p.kind === "cash");
    expect(cash).toMatchObject({ priceOriginal: "12", currencyOriginal: "GBP", gameId: GAME_ID, source: "shop_gb" });
    const voucher = points.find((p) => p.kind === "voucher");
    expect(voucher).toMatchObject({ priceOriginal: "15", currencyOriginal: "GBP" });
    // stored exactly as perListingPointsFrom would -- carrying the listing's
    // own identity, not an aggregate's
    expect(cash?.listingTitle).toBe("Some Game");
    expect(cash?.sourceUrl).toBe("https://shop.test/s1");
    // no sample of its own -- absent from the source's RawPrice, so
    // perListingPointsFrom stores it as null rather than leaving it unset
    expect(cash?.sampleSize).toBeNull();
  });

  it("throws rather than silently mislabel a row when the invariant it depends on is broken", () => {
    // snapshotStrategyFor never derives median_of_listings without both
    // roles, so this is a defensive check against a caller reaching this
    // function anyway -- proving it fails loud, not that any real caller
    // does this today.
    expect(() =>
      medianPointsFrom("shop_gb", { sell: "buy_listing" }, [], GAME_ID, FETCHED_AT, FLAT_RATES),
    ).toThrow(/buy_listing.*reference/);
  });
});
