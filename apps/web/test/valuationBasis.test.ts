import { afterEach, describe, expect, it, vi } from "vitest";
import type { PriceKind, SourceId, SourceInfo, ValueBasis } from "@retrowatchdog/shared";
import { PRICE_KINDS, VALUATION_BASES } from "@retrowatchdog/shared";
import {
  loadValuationBasis,
  saveValuationBasis,
  VALUATION_BASIS_EXPLANATION,
  VALUATION_BASIS_LABEL,
  valueBasisTag,
} from "../src/lib/valuationBasis.js";
import { SOURCES_FIXTURE } from "./fixtures/sources.js";

const reading = (
  source: SourceId,
  priceKind: PriceKind,
  rungs: { viaUnknownCondition?: boolean; viaUnknownRegion?: boolean } = {},
): ValueBasis => ({
  readAs: "reading",
  source,
  priceKind,
  viaUnknownCondition: rungs.viaUnknownCondition ?? false,
  viaUnknownRegion: rungs.viaUnknownRegion ?? false,
});

// One reading per price kind, from every source in the manifest: a kind or a
// source added upstream without a tag shows up here as a raw identifier or an
// "undefined" stem, which the exhaustiveness test below rejects.
const VALUE_BASES: readonly ValueBasis[] = [
  ...SOURCES_FIXTURE.flatMap((source) =>
    PRICE_KINDS.map((kind) => reading(source.id, kind)),
  ),
  reading("cex", "sell", { viaUnknownCondition: true }),
  reading("ebay_uk", "active_median", { viaUnknownRegion: true }),
  reading("ebay_uk", "active_median", { viaUnknownRegion: true, viaUnknownCondition: true }),
  { readAs: "excluded", reason: "faulty" },
  { readAs: "excluded", reason: "counterfeit" },
];

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("valuation basis preference", () => {
  it("defaults to market on first load", () => {
    expect(loadValuationBasis()).toBe("market");
  });

  it("round-trips a saved choice through localStorage under the 'valuationBasis' key", () => {
    saveValuationBasis("trade_in");
    expect(window.localStorage.getItem("valuationBasis")).toBe("trade_in");
    expect(loadValuationBasis()).toBe("trade_in");
    saveValuationBasis("replacement");
    expect(loadValuationBasis()).toBe("replacement");
  });

  it("falls back to market for an unknown stored value", () => {
    window.localStorage.setItem("valuationBasis", "cex_sell");
    expect(loadValuationBasis()).toBe("market");
  });

  it("falls back to market when storage throws, and a throwing save is swallowed", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    expect(() => saveValuationBasis("trade_in")).not.toThrow();
    expect(loadValuationBasis()).toBe("market");
  });
});

describe("valuation basis labels", () => {
  it("labels and explains every selectable basis", () => {
    expect(VALUATION_BASIS_LABEL).toEqual({
      market: "market",
      trade_in: "trade-in",
      replacement: "replacement",
    });
    // "a shop", not "CeX": the reading is role-based (any source declaring a
    // bid or buy_store role), and with CeX UK, ES and IE all selectable an
    // unqualified "CeX" names none of them. The concrete market is on the
    // per-copy tag below.
    expect(VALUATION_BASIS_EXPLANATION).toEqual({
      market: "what similar copies are listed for",
      trade_in: "what a shop would pay you",
      replacement: "what it costs to rebuy in a shop",
    });
    for (const basis of VALUATION_BASES) {
      expect(VALUATION_BASIS_LABEL[basis]).not.toMatch(/_/);
    }
  });
});

/**
 * The registry a screen would hand valueBasisTag, a REQUIRED argument: these
 * cases pass this deployment's whole registry (SOURCES_FIXTURE) explicitly.
 * The "a source the registry does not have" case at the end covers the other
 * side.
 */
const REGISTRY: Record<SourceId, SourceInfo> = Object.fromEntries(
  SOURCES_FIXTURE.map((s) => [s.id, s]),
);

describe("value basis tags", () => {
  it("tags every reading of every source and kind: non-empty, underscore-free, never 'undefined'", () => {
    for (const basis of VALUE_BASES) {
      const tag = valueBasisTag(basis, REGISTRY);
      expect(tag, JSON.stringify(basis)).not.toBeNull();
      expect(tag!.length).toBeGreaterThan(0);
      // a raw id or a missing stem would leak an identifier onto the screen
      expect(tag, JSON.stringify(basis)).not.toMatch(/_|undefined/);
    }
  });

  it("names the market a reading came from, so two countries never read alike", () => {
    expect(valueBasisTag(reading("cex", "sell"), REGISTRY)).toBe("sell · CeX UK");
    expect(valueBasisTag(reading("cex_es", "sell"), REGISTRY)).toBe("sell · CeX ES");
    expect(valueBasisTag(reading("ebay_de", "active_median"), REGISTRY)).toBe("market · eBay DE");
  });

  it("spells the fallback rung a reading was reached through", () => {
    expect(valueBasisTag(reading("cex", "sell", { viaUnknownCondition: true }), REGISTRY)).toBe(
      "sell · CeX UK (undeclared condition)",
    );
    expect(
      valueBasisTag(
        reading("ebay_uk", "active_median", { viaUnknownRegion: true, viaUnknownCondition: true }),
        REGISTRY,
      ),
    ).toBe("market · eBay UK (undeclared region, undeclared condition)");
  });

  it("renders an exclusion as itself, and no basis at all as null", () => {
    expect(valueBasisTag({ readAs: "excluded", reason: "counterfeit" }, REGISTRY)).toBe(
      "excluded (counterfeit)",
    );
    expect(valueBasisTag(null, REGISTRY)).toBeNull();
    expect(valueBasisTag(undefined, REGISTRY)).toBeNull();
  });

  it("names a source the registry does not have by its id, rather than 'undefined'", () => {
    // A reading stored while a plugin was approved, read back after it was
    // disabled — or any source at all in the moment before the registry
    // lands. The kind stem is still known; only the market name is not.
    expect(valueBasisTag(reading("kleinanzeigen_de", "active_listing"), {})).toBe(
      "listing · kleinanzeigen_de",
    );
  });

  // The two cases that used to live here — one asserting the old string tags
  // ("market", "voucher", "sell") and one asserting null for no basis — are
  // covered above by "names the market a reading came from", "spells the
  // fallback rung" and "renders an exclusion as itself". They asserted the
  // pre-multi-market wording, where a tag could not name its country.
});
