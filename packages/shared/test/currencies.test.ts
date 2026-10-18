import { describe, expect, it } from "vitest";
import { CONVERTIBLE_CURRENCIES, SUPPORTED_CURRENCIES } from "../src/index.js";

describe("the two currency lists", () => {
  it("can display nothing it cannot convert", () => {
    for (const currency of SUPPORTED_CURRENCIES) {
      expect(CONVERTIBLE_CURRENCIES, currency).toContain(currency);
    }
  });

  it("offers every currency the provider can convert", () => {
    expect([...SUPPORTED_CURRENCIES].sort()).toEqual([...CONVERTIBLE_CURRENCIES].sort());
  });

  it("names each code once, in the provider's shape", () => {
    expect(new Set(CONVERTIBLE_CURRENCIES).size).toBe(CONVERTIBLE_CURRENCIES.length);
    for (const code of CONVERTIBLE_CURRENCIES) expect(code).toMatch(/^[A-Z]{3}$/);
  });
});
