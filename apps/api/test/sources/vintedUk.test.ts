import { defaultSignalConfig } from "../../src/settings/signals.js";
import { describe, expect, it } from "vitest";
import type {
  PricePointDto,
  SourceInfo,
  ValuationBasis,
  ValuationMarkets,
} from "@retrowatchdog/shared";
import { VALUATION_BASES } from "@retrowatchdog/shared";
import { buildSignalInputs, computeSignals, type SignalConfig } from "../../src/signals/computeSignals.js";
import { admitsCopyPoint, type CopyDimensions } from "../../src/collection/copySlice.js";
import { estimateCopyValue } from "../../src/collection/valuation.js";
import { PLUGIN_SOURCES } from "../helpers/pluginSources.js";

/**
 * Vinted UK through the whole pipeline, WITHOUT one line of code that knows
 * it exists.
 *
 * That is the claim this batch makes and this file is what tests it: the
 * signal engine keys on the declared roles, the collection's per-copy slice on
 * the declared reach, and the valuation on the roles again. A source read by a
 * community scraper in another language, in another process, is judged by
 * exactly the same rules as eBay and CeX because it declared what its prices
 * MEAN and nothing else.
 *
 * WHERE THE DECLARATION COMES FROM. `vinted_uk` is a plugin: its real
 * declaration is the manifest the sidecar serves, and this app only ever sees
 * it through an approved row of the `plugins` table. The fixture
 * below is therefore a COPY of what that manifest must say, and the tests are
 * about the app's treatment of a source declaring exactly this — one
 * `buy_listing` kind, `global` reach — not about where the declaration is
 * stored. What the sidecar actually declares is pinned in two other places —
 * retrowatchdog-vinted-sidecar-plugin/tests/test_manifest.py, and
 * apps/api/test/adapters/sidecar/vintedManifest.test.ts, which runs a
 * committed copy of that manifest through this app's own validator. Neither
 * pins THIS fixture: if the two drift, that test fails and this one does not,
 * which is the right way round — these cases are about the engine's treatment
 * of such a source, not about Vinted.
 */

const cfg: SignalConfig = {
  ...defaultSignalConfig(),
  minGainUsd: null,
  flipFactor: 1.15,
  overpricedFactor: 1.3,
  underpricedFactor: 0.7,
  crossStoreFactor: 0.85,
  profitFactor: 1.15,
  minSample: 5,
};

/**
 * What the plugin's manifest declares for this source, as the registry would
 * hand it to the engine: the plugin markets the tests compare against, plus
 * this one source. Every helper below passes it explicitly.
 */
const vintedUk: SourceInfo = {
  label: "Vinted UK",
  family: "vinted",
  familyLabel: "Vinted",
  kind: "live",
  country: "GB",
  reach: "global",
  defaultRegion: null,
  expectedCurrencies: ["GBP"],
  kindLabels: { active_listing: "Vinted UK asking price" },
  kindRoles: { active_listing: "buy_listing" },
  caveat:
    "Vinted UK is read by an unofficial community scraper: asking prices from private sellers, best-effort, and it may stop working at any time.",
};

// PLUGIN_SOURCES: several cases below compare a Vinted listing against an
// "ebay_uk" reference median.
const sources: Record<string, SourceInfo> = { ...PLUGIN_SOURCES, vinted_uk: vintedUk };

/** suite-wide rate-1 convention: GBP amounts whose USD twin equals the original */
const point = (over: Partial<PricePointDto>): PricePointDto => ({
  source: "vinted_uk", kind: "active_listing", region: "PAL", condition: "cib",
  priceUsd: 0, priceOriginal: 0, currencyOriginal: "GBP", available: null,
  ...over,
});
const gbp = (n: number, over: Partial<PricePointDto>): PricePointDto =>
  point({ priceUsd: n, priceOriginal: n, ...over });

const signalsFor = (points: PricePointDto[], region = "PAL"): ReturnType<typeof computeSignals> =>
  buildSignalInputs(points, sources)
    .filter((i) => i.region === region)
    .flatMap((i) => computeSignals(i, cfg, sources));

describe("a Vinted asking price in the signal engine", () => {
  it("barks UNDERPRICED under the market reference, with the listing to click", () => {
    // The whole point of reading a marketplace of private sellers: somebody
    // is asking well under what similar copies are listed for.
    const signals = signalsFor([
      gbp(40, { source: "ebay_uk", kind: "active_median", sampleSize: 9 }),
      gbp(22, { url: "https://www.vinted.co.uk/items/1", listingTitle: "Pilotwings 64 PAL boxed manual" }),
    ]);
    const underpriced = signals.filter((s) => s.type === "UNDERPRICED");
    expect(underpriced).toHaveLength(1);
    expect(underpriced[0].source).toBe("vinted_uk");
    expect(underpriced[0].url).toBe("https://www.vinted.co.uk/items/1");
    // both sides declared their region and tier, so nothing was borrowed
    expect(underpriced[0].confidence).toBe("high");
  });

  it("is `potential` when the seller declared no condition, which is the norm there", () => {
    // Most Vinted listings say nothing about completeness, and the ladder
    // then judges them against the undeclared-condition median rather than
    // the cib one. The app still shows the bark - a cheap copy is news - but
    // says out loud what it does not know. This is the honest outcome of
    // reading a marketplace like this, not a defect to tune away.
    const signals = signalsFor([
      gbp(40, { source: "ebay_uk", kind: "active_median", condition: "unknown", sampleSize: 9 }),
      gbp(18, { condition: "unknown", url: "https://www.vinted.co.uk/items/2" }),
    ]);
    const underpriced = signals.filter((s) => s.type === "UNDERPRICED");
    expect(underpriced).toHaveLength(1);
    expect(underpriced[0].confidence).toBe("potential");
    expect(underpriced[0].caveats?.join(" ")).toMatch(/condition not declared/i);
  });

  it("can be the acquisition side of a FLIP without being a reference", () => {
    // Buy it on Vinted, trade it to CeX: the engine's acquisition proxy is
    // the cheapest same-condition listing whatever source published it.
    const signals = signalsFor([
      gbp(20, { url: "https://www.vinted.co.uk/items/3" }),
      gbp(40, { source: "cex", kind: "voucher" }),
    ]);
    const flips = signals.filter((s) => s.type === "FLIP");
    expect(flips).toHaveLength(1);
    expect(flips[0].buySource).toBe("vinted_uk");
    expect(flips[0].sellSource).toBe("cex");
  });

  it("never becomes the baseline another source is judged against", () => {
    // A scraped sample of asking prices is not a market reading, so the
    // manifest declares no `reference` role for this source and six of its
    // prices are still six listings, not a median.
    const asking = [10, 11, 12, 13, 14, 15].map((n) => gbp(n, {}));
    const [input] = buildSignalInputs(asking, sources);
    expect(input.listings).toHaveLength(6);
    expect(input.referenceByCondition).toEqual({});

    // The consequence, where a user would see it: a CeX shelf price far above
    // every Vinted asking price does NOT bark OVERPRICED_STORE. Were those
    // asking prices a reference, £80 against a ~£12 median would fire it
    // immediately - on a baseline this app deliberately refused to declare.
    const signals = signalsFor([gbp(80, { source: "cex", kind: "sell", available: true }), ...asking]);
    expect(signals.some((s) => s.type === "OVERPRICED_STORE")).toBe(false);
  });
});

describe("a Vinted asking price against an owned copy", () => {
  const copy: CopyDimensions = { region: "PAL", condition: "cib", itemGrade: null };

  it("is admitted with an undeclared region or tier, as any marketplace is", () => {
    // `global` reach: a collector can list on Vinted from wherever they live
    // and post the item, so an undeclared reading may stand in through the
    // labelled ladder. Same rule as eBay, read from the manifest.
    expect(admitsCopyPoint(copy, gbp(20, { condition: "unknown" }), sources)).toBe(true);
    expect(admitsCopyPoint(copy, gbp(20, { region: "unknown" }), sources)).toBe(true);
    expect(admitsCopyPoint(copy, gbp(20, {}), sources)).toBe(true);
  });

  it("is refused when it declares ANOTHER concrete region or tier", () => {
    // Reach widens to "undeclared", never to a different concrete answer: a
    // Japanese cartridge is not evidence about a PAL copy, and a loose one is
    // not evidence about a complete one.
    expect(admitsCopyPoint(copy, gbp(20, { region: "NTSC_J" }), sources)).toBe(false);
    expect(admitsCopyPoint(copy, gbp(20, { condition: "loose" }), sources)).toBe(false);
  });

  it("reaches none of the three pools a copy is valued from", () => {
    // This is the ROLE half of "asking prices bark, they do not value", read
    // one level below the valuation so the reason is visible rather than
    // inferred. (The next assertion runs the same source through
    // `estimateCopyValue` itself, with this same declaration passed in.)
    //
    // What the valuation actually reads is three collections of a SignalInput
    // — `referenceByCondition` for market, `bids` for trade-in, `storeOffers`
    // for replacement (apps/api/src/collection/valuation.ts, `readings`). A
    // source declaring only `buy_listing` lands in `listings` and in none of
    // them, so there is nothing for any basis to pick up.
    const [input] = buildSignalInputs(
      [gbp(20, {}), gbp(24, { condition: "unknown" })],
      sources,
    );
    expect(input.listings).toHaveLength(2);
    expect(input.referenceByCondition).toEqual({});
    expect(input.bids).toEqual([]);
    expect(input.storeOffers).toEqual([]);
  });

  it("sets no copy value under any basis, and it is the ROLE model that stops it", () => {
    // The end of the pipeline, with the source's own declaration passed in —
    // `estimateCopyValue` takes a `sources` registry now, so this is the
    // APPROVED plugin's treatment rather than an unknown id's. The gate is
    // opened deliberately from both sides: `includeForeign` makes the markets
    // rule say yes to anything, and the declaration below gives the id a
    // country of its own, so neither can be what returns null.
    //
    // What returns null is the role model, which is the rule that has to
    // survive approval: a source declaring only `buy_listing` lands in
    // `listings` and in none of the three pools a valuation reads. Nobody has
    // offered to buy this copy and no shop will sell you another one.
    const markets: ValuationMarkets = { country: "GB", includeForeign: true };
    const points = [gbp(20, {}), gbp(24, { condition: "unknown" })];
    for (const basis of VALUATION_BASES as readonly ValuationBasis[]) {
      expect(
        estimateCopyValue(points, copy, basis, { minSample: 1, markets, sources }),
        basis,
      ).toBeNull();
    }
    // and the same with the markets gate CLOSED, where the source's declared
    // country is what it is judged on rather than the app's ignorance of it
    const home: ValuationMarkets = { country: "GB", includeForeign: false };
    for (const basis of VALUATION_BASES as readonly ValuationBasis[]) {
      expect(
        estimateCopyValue(points, copy, basis, { minSample: 1, markets: home, sources }),
        basis,
      ).toBeNull();
    }
  });
});
