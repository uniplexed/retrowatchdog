import { describe, expect, it } from "vitest";
import type { PriceKind, PricePointDto, SourceInfo } from "@retrowatchdog/shared";
import {
  buildSignalInputs,
  comparableRole,
  referenceSample,
  usableRole,
  type RoleCandidate,
} from "../../src/signals/computeSignals.js";

/** a CeX-shaped shop and an eBay-shaped marketplace, the two role sets this app really serves */
const sources: Record<string, SourceInfo> = {
  shop: {
    label: "Shop",
    family: "cex",
    familyLabel: "Shop",
    country: "GB",
    reach: "local",
    transport: "sync",
    expectedCurrencies: ["GBP"],
    kindRoles: { sell: "buy_store", cash: "bid", voucher: "bid", guide: "guide" },
  } as unknown as SourceInfo,
  market: {
    label: "Market",
    family: "ebay",
    familyLabel: "Market",
    country: "GB",
    reach: "national",
    transport: "live",
    expectedCurrencies: ["GBP"],
    kindRoles: { active_listing: "buy_listing", active_median: "reference" },
  } as unknown as SourceInfo,
};

const point = (over: Partial<RoleCandidate> = {}): RoleCandidate => ({
  source: "shop" as RoleCandidate["source"],
  kind: "sell" as PriceKind,
  priceUsd: 40,
  available: true,
  sampleSize: null,
  grade: null,
  ...over,
});

describe("usableRole", () => {
  it("returns the role the source declares for the kind", () => {
    expect(usableRole(point(), sources)).toBe("buy_store");
    expect(usableRole(point({ kind: "cash" as PriceKind }), sources)).toBe("bid");
  });

  it("ignores a source the registry does not know and a kind it declares no role for", () => {
    expect(usableRole(point({ source: "nobody" as RoleCandidate["source"] }), sources)).toBeNull();
    expect(usableRole(point({ kind: "active_median" as PriceKind }), sources)).toBeNull();
  });

  it("ignores a guide price: informational, never signal fuel", () => {
    expect(usableRole(point({ kind: "guide" as PriceKind }), sources)).toBeNull();
  });

  it("ignores a zero or negative amount, which wins every ratio it should lose", () => {
    expect(usableRole(point({ priceUsd: 0 }), sources)).toBeNull();
    expect(usableRole(point({ priceUsd: -1 }), sources)).toBeNull();
  });

  it("ignores an unavailable buy price, but keeps an unavailable bid", () => {
    expect(usableRole(point({ available: false }), sources)).toBeNull();
    expect(
      usableRole({ ...point({ kind: "active_listing" as PriceKind, available: false }), source: "market" as RoleCandidate["source"] }, sources),
    ).toBeNull();
    // a shop still BUYS a box it has none of, so its bid survives
    expect(usableRole(point({ kind: "cash" as PriceKind, available: false }), sources)).toBe("bid");
  });

  it("treats unknown availability as available, so legacy rows do not go silent", () => {
    expect(usableRole(point({ available: null }), sources)).toBe("buy_store");
  });

  it("ignores a reference with no sample, and keeps one with a sample", () => {
    const ref = (sampleSize: number | null): RoleCandidate => ({
      ...point({ kind: "active_median" as PriceKind, sampleSize }),
      source: "market" as RoleCandidate["source"],
    });
    expect(usableRole(ref(null), sources)).toBeNull();
    expect(usableRole(ref(7), sources)).toBe("reference");
  });

  it("ignores a fair or poor graded buy_listing, which is not a bargain candidate", () => {
    const listing = (grade: RoleCandidate["grade"]): RoleCandidate => ({
      ...point({ kind: "active_listing" as PriceKind, grade }),
      source: "market" as RoleCandidate["source"],
    });
    expect(usableRole(listing("fair"), sources)).toBeNull();
    expect(usableRole(listing("poor"), sources)).toBeNull();
    expect(usableRole(listing("good"), sources)).toBe("buy_listing");
    expect(usableRole(listing(null), sources)).toBe("buy_listing");
  });

  it("separates the gates that suppress a region entry from the ones that do not", () => {
    // a reference with no sample IS comparable — it got past the early gates —
    // and is only refused by the sample gate. buildSignalInputs relies on that
    // difference to create the region's entry for it (computeSignals.test.ts,
    // "skips a reference point without a sample size").
    const unsampled = { ...point({ kind: "active_median" as PriceKind, sampleSize: null }), source: "market" as RoleCandidate["source"] };
    expect(comparableRole(unsampled, sources)).toBe("reference");
    expect(referenceSample(unsampled)).toBeNull();
    expect(usableRole(unsampled, sources)).toBeNull();

    // a zero is refused by an EARLY gate, so it is not comparable at all
    expect(comparableRole(point({ priceUsd: 0 }), sources)).toBeNull();
  });
});

/**
 * The extraction must not change one thing about what the engine accepts. This
 * fixture carries every role plus one point per gate, and pins the shape
 * `buildSignalInputs` returns for it.
 */
describe("buildSignalInputs after the extraction", () => {
  const dto = (over: Partial<PricePointDto>): PricePointDto => ({
    source: "shop" as PricePointDto["source"],
    kind: "sell" as PriceKind,
    region: "PAL",
    condition: "cib",
    grade: null,
    priceUsd: 40,
    priceOriginal: 30,
    currencyOriginal: "GBP",
    sampleSize: null,
    url: null,
    listingTitle: null,
    available: true,
    ...over,
  });

  it("keeps exactly the points the gates allow, reduced as before", () => {
    const [input] = buildSignalInputs(
      [
        dto({ priceUsd: 40 }),
        dto({ priceUsd: 35 }), // lower offer for the same (source, condition) wins
        dto({ kind: "cash" as PriceKind, priceUsd: 20 }),
        dto({ kind: "cash" as PriceKind, priceUsd: 25 }), // higher bid wins
        dto({ kind: "guide" as PriceKind, priceUsd: 99 }), // inert
        dto({ priceUsd: 0 }), // zero
        dto({ priceUsd: 30, available: false }), // unavailable buy price — would win the minimum if the gate stopped working
        dto({ source: "market" as PricePointDto["source"], kind: "active_median" as PriceKind, priceUsd: 60, sampleSize: null }),
        dto({ source: "market" as PricePointDto["source"], kind: "active_median" as PriceKind, priceUsd: 55, sampleSize: 9 }),
        dto({ source: "market" as PricePointDto["source"], kind: "active_listing" as PriceKind, priceUsd: 45, grade: "poor" }),
        dto({ source: "market" as PricePointDto["source"], kind: "active_listing" as PriceKind, priceUsd: 48, grade: "good" }),
      ],
      sources,
    );
    expect(input.region).toBe("PAL");
    expect(input.storeOffers.map((s) => s.price.usd)).toEqual([35]);
    expect(input.bids.map((b) => b.price.usd)).toEqual([25]);
    expect(input.listings.map((l) => l.price.usd)).toEqual([48]);
    expect(input.referenceByCondition.cib?.price.usd).toBe(55);
    expect(input.referenceByCondition.cib?.sampleSize).toBe(9);
  });
});
