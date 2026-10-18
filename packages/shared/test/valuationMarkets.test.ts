import { describe, it, expect } from "vitest";
import {
  COUNTRY_CODES,
  COUNTRY_LABEL,
  DEFAULT_VALUATION_MARKETS,
  valuesCopies,
  type SourceId,
} from "../src/index.js";

/**
 * One high-street shop with a branch in three countries, as CeX is. Declared
 * here because `valuesCopies` takes the registry it resolves against.
 */
const SHOPS = {
  shop_gb: {
    label: "Shop GB", family: "shop", familyLabel: "Shop", kind: "sync" as const,
    country: "GB" as const, reach: "local" as const, defaultRegion: "PAL" as const,
    expectedCurrencies: ["GBP"], kindRoles: { sell: "buy_store" as const },
    kindLabels: { sell: "Shop GB sells for" },
  },
  shop_es: {
    label: "Shop ES", family: "shop", familyLabel: "Shop", kind: "sync" as const,
    country: "ES" as const, reach: "local" as const, defaultRegion: "PAL" as const,
    expectedCurrencies: ["EUR"], kindRoles: { sell: "buy_store" as const },
    kindLabels: { sell: "Shop ES sells for" },
  },
  shop_ie: {
    label: "Shop IE", family: "shop", familyLabel: "Shop", kind: "sync" as const,
    country: "IE" as const, reach: "local" as const, defaultRegion: "PAL" as const,
    expectedCurrencies: ["EUR"], kindRoles: { sell: "buy_store" as const },
    kindLabels: { sell: "Shop IE sells for" },
  },
};

describe("the countries this build has a market in", () => {
  it("names every one of them, with no placeholder left over", () => {
    for (const code of COUNTRY_CODES) {
      expect(COUNTRY_LABEL[code], code).toBeTruthy();
      expect(COUNTRY_LABEL[code], code).not.toBe(code);
    }
    expect(Object.keys(COUNTRY_LABEL).sort()).toEqual([...COUNTRY_CODES].sort());
  });
});

describe("valuesCopies", () => {
  // `sources` is required, not defaulted. A real deployment passes the
  // runtime registry (apps/api/src/collection/valuation.ts); that seam is
  // exercised in apps/api's own tests (test/collection/valuation.test.ts).
  it("admits the home country's markets and nothing else by default", () => {
    // "A collection lives somewhere": the default reading is the home
    // country's shops and marketplaces only.
    expect(DEFAULT_VALUATION_MARKETS).toEqual({ country: "GB", includeForeign: false });
    const home = { country: "GB", includeForeign: false } as const;
    // A THREE-COUNTRY SHOP: the shape matters, not whose shop it is.
    expect(valuesCopies("shop_gb", home, SHOPS)).toBe(true);
    expect(valuesCopies("shop_es", home, SHOPS)).toBe(false);
    expect(valuesCopies("shop_ie", home, SHOPS)).toBe(false);
  });

  it("moves with the home country rather than favouring the UK", () => {
    const spain = { country: "ES", includeForeign: false } as const;
    expect(valuesCopies("shop_es", spain, SHOPS)).toBe(true);
    expect(valuesCopies("shop_gb", spain, SHOPS)).toBe(false);
  });

  it("refuses a source the manifest does not know, rather than defaulting it in", () => {
    // An id from an older build in a stored row must not silently value a
    // copy; only the explicit foreign opt-in admits anything unconditionally.
    const unknown = "cex_pt" as SourceId;
    expect(valuesCopies(unknown, { country: "GB", includeForeign: false }, SHOPS)).toBe(false);
    expect(valuesCopies(unknown, { country: "GB", includeForeign: true }, SHOPS)).toBe(true);
  });

  it("cannot be asked about a source without being told what the deployment knows", () => {
    // The guarantee this test pins is a COMPILE-TIME one: the parameter is
    // required, so no caller can resolve a source against anything but the
    // registry it was handed. At runtime
    // the omission is invisible on this branch — `includeForeign` returns
    // before `sources` is read — which is exactly why the type has to carry it.
    const registry = { retro_es: { ...SHOPS.shop_gb, country: "ES" as const } };
    expect(valuesCopies("retro_es" as SourceId, { country: "ES", includeForeign: false }, registry)).toBe(true);
    expect(valuesCopies("retro_es" as SourceId, { country: "GB", includeForeign: false }, registry)).toBe(false);
  });
});
