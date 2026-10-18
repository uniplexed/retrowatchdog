import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSidecarListing } from "../../../src/adapters/sidecar/protocol.js";

/**
 * The ROWS layer of the conformance suite for the Vinted sidecar: a real answer
 * from its `/search` route, parsed through the app's own parser with the app's
 * bounds applied (spec §7). The eBay and CeX plugins have had theirs since they
 * shipped; Vinted's could not be recorded while its scraper answered 404, which
 * it did from about 2026-09-14 until vinted_scraper 5.0.2 followed Vinted's new
 * search endpoint.
 *
 * RECORDED, not derived: `vinted-search-2026-09-19.json` is the first six rows
 * the running sidecar answered for `q=pilotwings 64` on 2026-09-19, verbatim.
 * Recorded rather than generated because the Python mapping lives in another
 * language with no way to run it from here, and a hand-typed row would only
 * test what somebody believed Vinted sends.
 *
 * The first row is a magazine POSTER, and that is kept on purpose. The protocol
 * must accept it — a plugin fetches, it does not judge — and the app's own
 * non-game reading (`adapters/nonGameListing.ts`) is what drops it later. A
 * parser that refused it here would be doing the app's interpretation in the
 * wrong place.
 */
const rows: unknown[] = JSON.parse(
  readFileSync(new URL("../../../src/adapters/sidecar/fixtures/vinted-search-2026-09-19.json", import.meta.url), "utf8"),
) as unknown[];

/** What an approved Vinted UK grants: its one listing kind, in pounds. */
const VINTED_LIMITS = { kinds: new Set(["active_listing"]), currencies: new Set(["GBP"]) };

describe("the app's reading of a real Vinted sidecar answer", () => {
  it("accepts every recorded row, with the reason shown when it does not", () => {
    expect(rows.length).toBeGreaterThan(0);
    const failures = rows
      .map((row, index) => ({ index, parsed: parseSidecarListing(row, VINTED_LIMITS) }))
      .filter(({ parsed }) => !parsed.ok)
      .map(({ index, parsed }) => `row ${index}: ${parsed.ok ? "" : parsed.reason}`);
    expect(failures).toEqual([]);
  });

  it("reads each row as a priced listing with a link, in the currency Vinted UK quotes", () => {
    for (const row of rows) {
      const parsed = parseSidecarListing(row, VINTED_LIMITS);
      if (!parsed.ok) throw new Error(parsed.reason);
      expect(parsed.listing.sourceProductId).not.toBe("");
      expect(parsed.listing.url).toMatch(/^https:\/\/www\.vinted\.co\.uk\/items\//);
      expect(parsed.listing.prices.length).toBeGreaterThan(0);
      for (const price of parsed.listing.prices) {
        expect(price.kind).toBe("active_listing");
        expect(price.currency).toBe("GBP");
      }
    }
  });
});
