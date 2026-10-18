import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_VALUATION_MARKETS } from "@retrowatchdog/shared";
import { loadValuationMarkets, saveValuationMarkets } from "../src/lib/valuationMarkets.js";

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("valuation markets preference", () => {
  it("defaults to the home country only (GB, no foreign markets)", () => {
    expect(loadValuationMarkets()).toEqual({ country: "GB", includeForeign: false });
    // the default is the shared one, not a second copy of it drifting apart
    expect(loadValuationMarkets()).toEqual(DEFAULT_VALUATION_MARKETS);
  });

  it("round-trips a choice through the 'valuationCountry'/'valuationIncludeForeign' keys", () => {
    saveValuationMarkets({ country: "ES", includeForeign: true });
    expect(window.localStorage.getItem("valuationCountry")).toBe("ES");
    expect(window.localStorage.getItem("valuationIncludeForeign")).toBe("true");
    expect(loadValuationMarkets()).toEqual({ country: "ES", includeForeign: true });

    saveValuationMarkets({ country: "IE", includeForeign: false });
    expect(loadValuationMarkets()).toEqual({ country: "IE", includeForeign: false });
  });

  it("falls back to the default for a country this build does not know", () => {
    window.localStorage.setItem("valuationCountry", "RU");
    window.localStorage.setItem("valuationIncludeForeign", "true");
    // only the unknown half falls back: the checkbox the user did set stands
    expect(loadValuationMarkets()).toEqual({ country: "GB", includeForeign: true });
  });

  it("treats any stored flag other than the two booleans as unset", () => {
    window.localStorage.setItem("valuationCountry", "DE");
    window.localStorage.setItem("valuationIncludeForeign", "yes please");
    expect(loadValuationMarkets()).toEqual({ country: "DE", includeForeign: false });
  });

  it("defaults when storage throws, and swallows a throwing save", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    expect(() => saveValuationMarkets({ country: "US", includeForeign: true })).not.toThrow();
    expect(loadValuationMarkets()).toEqual(DEFAULT_VALUATION_MARKETS);
  });
});
