import { describe, expect, it } from "vitest";
import { unsampledReferenceKinds } from "../../src/pricing/service.js";

const roles = { guide: "reference", sell: "buy_store" } as const;

describe("unsampledReferenceKinds", () => {
  it("names a reference kind priced without a sample", () => {
    const listings = [{ prices: [{ kind: "guide" as const, amount: 30, currency: "GBP" }] }];
    expect(unsampledReferenceKinds(listings, roles, "per_listing")).toEqual(["guide"]);
  });

  it("names it once however many rows repeat it", () => {
    const price = { kind: "guide" as const, amount: 30, currency: "GBP" };
    expect(unsampledReferenceKinds([{ prices: [price] }, { prices: [price] }], roles, "per_listing")).toEqual(["guide"]);
  });

  it("is silent when the sample is there, and for kinds with another role", () => {
    const listings = [
      { prices: [{ kind: "guide" as const, amount: 30, currency: "GBP", sampleSize: 8 }] },
      { prices: [{ kind: "sell" as const, amount: 45, currency: "GBP" }] },
    ];
    expect(unsampledReferenceKinds(listings, roles, "per_listing")).toEqual([]);
  });

  it("is silent for a median_of_listings source, whose reference the app derives itself", () => {
    const medianRoles = { active_median: "reference", active_listing: "buy_listing" } as const;
    const listings = [{ prices: [{ kind: "active_median" as const, amount: 30, currency: "GBP" }] }];
    expect(unsampledReferenceKinds(listings, medianRoles, "median_of_listings")).toEqual([]);
  });
});
