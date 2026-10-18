import { describe, it, expect } from "vitest";
import fixture from "./fixtures/seller-spellings.json" with { type: "json" };
import { PLATFORMS } from "../src/index.js";

// The eBay plugin keeps its own copy of this table (its src/spellings.ts) and
// checks it against a copy of this same file. Changing a spelling here fails
// this test until the fixture is regenerated; copy the new fixture to the
// plugin's test/fixtures/app-seller-spellings.json and update its table too.
describe("seller spellings fixture", () => {
  it("matches PLATFORMS[*].sellerSpellings", () => {
    const current = Object.fromEntries(Object.entries(PLATFORMS).map(([id, p]) => [id, p.sellerSpellings]));
    expect(current).toEqual(fixture);
  });
});
