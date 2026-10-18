import { describe, it, expect } from "vitest";
import type { Condition } from "@retrowatchdog/shared";
import {
  lookupReference,
  type ReferencePoint,
  type SignalAmount,
  type SignalInput,
} from "../../src/signals/computeSignals.js";

// Direct contract of the EXPORTED spec-9 ladder. The behavioral coverage
// (which rung wins inside a full computeSignals run) lives untouched in
// computeSignals.test.ts; this file pins the shape other modules (the
// collection valuation) build on: the chosen point plus the two via-flags.

const gbp = (n: number): SignalAmount => ({ usd: n, original: n, currency: "GBP" });
const ref = (n: number, sampleSize: number, condition: Condition = "cib"): ReferencePoint => ({
  source: "ebay_uk", kind: "active_median", condition, grade: null, price: gbp(n), url: null, title: null, sampleSize,
});
const inputOf = (over: Partial<SignalInput>): SignalInput => ({
  region: "PAL", storeOffers: [], bids: [], listings: [], referenceByCondition: {}, ...over,
});

describe("lookupReference (exported ladder)", () => {
  it("returns the exact rung with both flags false", () => {
    const m = lookupReference(inputOf({ referenceByCondition: { cib: ref(32, 12) } }), "cib", 5);
    expect(m).toMatchObject({ price: gbp(32), sampleSize: 12, viaUnknownCondition: false, viaUnknownRegion: false });
  });

  it("descends exact -> unknown condition -> unknown region -> both, flagging the rung taken", () => {
    const input = inputOf({
      referenceByCondition: { unknown: ref(25, 6, "unknown") },
      referenceUnknownRegion: { cib: ref(30, 9), unknown: ref(4.19, 18, "unknown") },
    });
    expect(lookupReference(input, "cib", 5)).toMatchObject({
      price: gbp(25), viaUnknownCondition: true, viaUnknownRegion: false,
    });
    const regionOnly = inputOf({ referenceUnknownRegion: { cib: ref(30, 9) } });
    expect(lookupReference(regionOnly, "cib", 5)).toMatchObject({
      price: gbp(30), viaUnknownCondition: false, viaUnknownRegion: true,
    });
    const bothOnly = inputOf({ referenceUnknownRegion: { unknown: ref(4.19, 18, "unknown") } });
    expect(lookupReference(bothOnly, "cib", 5)).toMatchObject({
      price: gbp(4.19), viaUnknownCondition: true, viaUnknownRegion: true,
    });
  });

  it("skips a rung under minSample instead of stopping on it", () => {
    const input = inputOf({
      referenceByCondition: { cib: ref(40, 2) },
      referenceUnknownRegion: { cib: ref(30, 9) },
    });
    expect(lookupReference(input, "cib", 5)).toMatchObject({ price: gbp(30), viaUnknownRegion: true });
    // the same rung IS usable once the floor allows it
    expect(lookupReference(input, "cib", 2)).toMatchObject({ price: gbp(40), viaUnknownRegion: false });
  });

  it("returns null when no rung reaches minSample or none exists", () => {
    expect(lookupReference(inputOf({ referenceByCondition: { cib: ref(40, 4) } }), "cib", 5)).toBeNull();
    expect(lookupReference(inputOf({}), "cib", 5)).toBeNull();
  });

  it("is pure: the same input answers the same way twice", () => {
    const input = inputOf({ referenceByCondition: { cib: ref(32, 12) } });
    expect(lookupReference(input, "cib", 5)).toEqual(lookupReference(input, "cib", 5));
  });
});
