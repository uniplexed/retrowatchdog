import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSidecarListing } from "../../../src/adapters/sidecar/protocol.js";
import { classifyListing } from "../../../src/adapters/classifyListing.js";

/**
 * Proves the app's own sidecar parser accepts a real eBay plugin answer. The
 * plugin's own tests (`retrowatchdog-ebay-plugin/test/mapping.test.ts`) prove
 * `ebayItemToRawListing` builds the right wire row; this proves the app's
 * `parseSidecarListing`/`classifyListing` accept that shape — the two live in
 * different packages with no compiler between them, so a fixture is the joint
 * that has to be checked instead.
 *
 * Not recorded live (that needs real eBay credentials): the plugin's own
 * committed `mapping.ts` was run over its own committed
 * `fixtures/item-summary-mario-world.json` (10 real Browse item summaries) —
 * no network, no keys, but still a document produced by the plugin's real
 * code rather than typed by hand.
 *
 * DERIVED, not recorded — `fixtures/ebay-plugin-search-2026-09-05.json` is
 * the JSON array `ebayItemToRawListing` produces for every row of
 * `retrowatchdog-ebay-plugin/fixtures/item-summary-mario-world.json`, one row in,
 * one row out, in the source fixture's own order. Regenerate it with a
 * script physically INSIDE `retrowatchdog-ebay-plugin/` — a relative ESM import
 * resolves against the FILE's own location, never the shell's working
 * directory, and not at all inside a `tsx -e` eval'd string, so a one-off
 * script has to be a real file inside the package whose modules it imports
 * (the identical lesson `retrowatchdog-ebay-plugin/README.md`'s
 * "Regenerate manifest.fixture.json" section records):
 *
 *   // retrowatchdog-ebay-plugin/.gen-search-fixture.mts (written, run, deleted)
 *   import { readFileSync, writeFileSync } from "node:fs";
 *   import { fileURLToPath } from "node:url";
 *   import { ebayItemToRawListing, type EbayItemSummary } from "./src/mapping.js";
 *
 *   const fixturePath = fileURLToPath(
 *     new URL("./fixtures/item-summary-mario-world.json", import.meta.url),
 *   );
 *   const outPath = fileURLToPath(
 *     new URL(
 *       "../../apps/api/src/adapters/sidecar/fixtures/ebay-plugin-search-2026-09-05.json",
 *       import.meta.url,
 *     ),
 *   );
 *   const source = JSON.parse(readFileSync(fixturePath, "utf8")) as { itemSummaries: EbayItemSummary[] };
 *   const rows = source.itemSummaries.map(ebayItemToRawListing);
 *   writeFileSync(outPath, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
 *
 *   # from retrowatchdog-ebay-plugin/:
 *   #   npx tsx .gen-search-fixture.mts && rm .gen-search-fixture.mts
 *
 * What this does NOT prove: that a deployed plugin container answers this
 * exact shape over the network — the live-recorded route above is the only
 * thing that would prove that, and it is a deploy-day upgrade, not this
 * task's job. What it DOES prove: what the plugin's real source code
 * produces from a real Browse response is exactly what the app's protocol
 * parser accepts.
 */
const rows: unknown[] = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../../src/adapters/sidecar/fixtures/ebay-plugin-search-2026-09-05.json", import.meta.url),
    ),
    "utf8",
  ),
);

describe("the app's reading of a real eBay plugin answer", () => {
  const parsed = rows.map((row) =>
    parseSidecarListing(row, {
      kinds: new Set(["active_median", "active_listing"]),
      currencies: new Set(["GBP"]),
    }),
  );

  it("accepts every row eBay's mapping.ts produced, with the reason shown when it does not", () => {
    // The reason is asserted INTO the failure list rather than checked
    // separately (vintedManifest.test.ts's convention): when this breaks,
    // the useful output is which row and why, not `expected false to be true`.
    const failures = parsed
      .map((p, index) => (p.ok ? null : `row ${index}: ${p.reason}`))
      .filter((f): f is string => f !== null);
    expect(failures).toEqual([]);
  });

  it("keeps available: true across the wire — the one fact classifyListing itself disowns", () => {
    expect(parsed.every((p) => p.ok && p.listing.available === true)).toBe(true);
  });

  it("reads a plugin-supplied listing exactly as the built-in adapter did: platform from the title", () => {
    // "Super Mario World SNES PAL Boxed Complete" (v1|1001|0). Found by
    // sourceProductId, never a hardcoded array index: every one of this
    // fixture's 10 titles carries an SNES keyword (including "Super Famicom"
    // and "NTSC USA version"), so a bare `parsed[0]` would keep passing no
    // matter which row landed first if the source fixture were ever
    // reordered — silently testing a different listing than this comment
    // names, with no discriminating power tied to the row's actual content.
    const index = rows.findIndex(
      (row) => (row as { sourceProductId?: unknown }).sourceProductId === "v1|1001|0",
    );
    expect(index).toBeGreaterThanOrEqual(0);
    const target = parsed[index];
    if (!target.ok) throw new Error(target.reason);
    expect(classifyListing(target.listing).platformGuess).toBe("snes");
  });

  it("reads eBay's structured condition field off the wire when the title carries no newness vocabulary", () => {
    // "Super Mario World SNES PAL" (v1|1009|0) names no sealed/new/brand-new
    // word anywhere in its title — conditionText "New" is the only newness
    // evidence this row has. The plugin's own mapping.test.ts pins that this
    // exact row keeps that field verbatim through ebayItemToRawListing; this
    // asserts the app half reads it the same way. Found by sourceProductId,
    // never a hardcoded array index, so this does not silently drift if the
    // fixture's row order ever changes.
    const index = rows.findIndex(
      (row) => (row as { sourceProductId?: unknown }).sourceProductId === "v1|1009|0",
    );
    expect(index).toBeGreaterThanOrEqual(0);
    const target = parsed[index];
    if (!target.ok) throw new Error(target.reason);
    expect(classifyListing(target.listing).conditionGuess).toBe("new");
  });
});
