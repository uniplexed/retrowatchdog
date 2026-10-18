import { describe, it, expect } from "vitest";
import type { Condition, PricePointDto, SourceId, SourceInfo, SourceReach } from "@retrowatchdog/shared";
import {
  admitsCopyPoint as admitsCopyPointWithSources,
  copyRegionInput,
  type CopyDimensions,
} from "../../src/collection/copySlice.js";
import type { ReferencePoint, SignalAmount, SignalInput } from "../../src/signals/computeSignals.js";
import { PLUGIN_SOURCES } from "../helpers/pluginSources.js";

/**
 * Defaults `sources` to the shipped plugins' declarations, so the `ebay()`
 * fixture has a real `reach` for the global-reach half of the rule.
 */
function admitsCopyPoint(
  copy: CopyDimensions,
  point: PricePointDto,
  sources: Record<string, SourceInfo> = PLUGIN_SOURCES,
): boolean {
  return admitsCopyPointWithSources(copy, point, sources);
}

const gbp = (n: number): SignalAmount => ({ usd: n, original: n, currency: "GBP" });
const point = (over: Partial<PricePointDto>): PricePointDto => ({
  source: "cex", kind: "voucher", region: "PAL", condition: "cib",
  priceUsd: 10, priceOriginal: 10, currencyOriginal: "GBP", available: null,
  ...over,
});
/** a CeX point: local reach */
const cex = (over: Partial<PricePointDto> = {}): PricePointDto => point({ source: "cex", kind: "voucher", ...over });
/** an eBay UK median: global reach */
const ebay = (over: Partial<PricePointDto> = {}): PricePointDto =>
  point({ source: "ebay_uk", kind: "active_median", sampleSize: 8, ...over });
const ref = (n: number, sampleSize: number, condition: Condition = "cib"): ReferencePoint => ({
  source: "ebay_uk", kind: "active_median", condition, grade: null, price: gbp(n), url: null, title: null, sampleSize,
});
const inputOf = (over: Partial<SignalInput>): SignalInput => ({
  region: "PAL", storeOffers: [], bids: [], listings: [], referenceByCondition: {}, ...over,
});

describe("every source declares its connector's reach (R2)", () => {
  it("CeX is a local store and eBay UK is a global marketplace", () => {
    // a physical/regional store prices only the exact copy it lists; on a
    // marketplace the owner can sell to any geography, so its undeclared rungs
    // may stand in for a copy (labelled, potential). Both readings come from
    // what the plugins declare.
    expect(PLUGIN_SOURCES.cex.reach).toBe("local");
    expect(PLUGIN_SOURCES.ebay_uk.reach).toBe("global");
  });
});

describe("admitsCopyPoint — which stored points may speak for an owned copy (R2: connector reach)", () => {
  const palCib: CopyDimensions = { region: "PAL", condition: "cib", itemGrade: null };

  it("local reach (CeX): only the copy's exact region AND condition", () => {
    expect(admitsCopyPoint(palCib, cex())).toBe(true);
    expect(admitsCopyPoint(palCib, cex({ region: "unknown" }))).toBe(false);
    expect(admitsCopyPoint(palCib, cex({ condition: "unknown" }))).toBe(false);
    expect(admitsCopyPoint(palCib, cex({ region: "unknown", condition: "unknown" }))).toBe(false);
    // every CeX kind is held to the same exactness: a sell is a shelf price too
    expect(admitsCopyPoint(palCib, cex({ kind: "sell", region: "unknown" }))).toBe(false);
  });

  it("global reach (eBay UK): the copy's own dimensions or the undeclared rungs", () => {
    expect(admitsCopyPoint(palCib, ebay())).toBe(true);
    expect(admitsCopyPoint(palCib, ebay({ region: "unknown" }))).toBe(true);
    expect(admitsCopyPoint(palCib, ebay({ condition: "unknown" }))).toBe(true);
    expect(admitsCopyPoint(palCib, ebay({ region: "unknown", condition: "unknown" }))).toBe(true);
  });

  it("never another concrete region or completeness tier, whatever the reach", () => {
    for (const build of [cex, ebay]) {
      expect(admitsCopyPoint(palCib, build({ region: "NTSC_J" }))).toBe(false);
      expect(admitsCopyPoint(palCib, build({ region: "NTSC_U" }))).toBe(false);
      expect(admitsCopyPoint(palCib, build({ condition: "loose" }))).toBe(false);
      // boxed_no_manual never borrows cib, and cib never borrows boxed_no_manual
      expect(admitsCopyPoint(palCib, build({ condition: "boxed_no_manual" }))).toBe(false);
      expect(admitsCopyPoint({ ...palCib, condition: "boxed_no_manual" }, build({ condition: "cib" }))).toBe(false);
    }
  });

  it("grade rule for every source: a graded point fits only a copy of that grade, an ungraded point fits every copy", () => {
    const mintVoucher = cex({ grade: "mint" });
    expect(admitsCopyPoint({ ...palCib, itemGrade: "mint" }, mintVoucher)).toBe(true);
    expect(admitsCopyPoint({ ...palCib, itemGrade: "good" }, mintVoucher)).toBe(false);
    expect(admitsCopyPoint({ ...palCib, itemGrade: "near_mint" }, mintVoucher)).toBe(false);
    expect(admitsCopyPoint(palCib, mintVoucher)).toBe(false);
    for (const grade of ["mint", "good", null] as const) {
      expect(admitsCopyPoint({ ...palCib, itemGrade: grade }, cex())).toBe(true);
      expect(admitsCopyPoint({ ...palCib, itemGrade: grade }, ebay())).toBe(true);
    }
    // a graded global point obeys the same rule (an eBay listing graded mint)
    const mintListing = ebay({ kind: "active_listing", grade: "mint", listingTitle: "OOT boxed mint" });
    expect(admitsCopyPoint({ ...palCib, itemGrade: "good" }, mintListing)).toBe(false);
    expect(admitsCopyPoint({ ...palCib, itemGrade: "mint" }, mintListing)).toBe(true);
  });

  it("a copy of undeclared region or condition reads the undeclared points as its own, never a concrete one", () => {
    const unknownCopy: CopyDimensions = { region: "unknown", condition: "unknown", itemGrade: null };
    expect(admitsCopyPoint(unknownCopy, cex({ region: "unknown", condition: "unknown" }))).toBe(true);
    expect(admitsCopyPoint(unknownCopy, ebay({ region: "unknown", condition: "unknown" }))).toBe(true);
    expect(admitsCopyPoint(unknownCopy, cex())).toBe(false);
    expect(admitsCopyPoint(unknownCopy, ebay())).toBe(false);
    expect(admitsCopyPoint(unknownCopy, ebay({ region: "unknown" }))).toBe(false); // cib is concrete
  });

  it("adaptivity: a synthetic source behaves by its declared reach through the sources parameter", () => {
    const RETRO_ES = "retro_es" as SourceId;
    // the manifest fields other than `reach` and `kindRoles` are inert here;
    // they are stated because a source has to
    // declare them all, and only the two below decide this test's outcome
    const withReach = (reach: SourceReach): Record<string, SourceInfo> => ({
      [RETRO_ES]: {
        label: "RetroMadrid",
        family: "retro_es",
        familyLabel: "RetroMadrid",
        kind: "live",
        country: "ES",
        defaultRegion: "PAL",
        expectedCurrencies: ["EUR"],
        reach,
        kindRoles: { cash: "bid", active_median: "reference" },
      },
    });
    const undeclaredRegion = point({ source: RETRO_ES, kind: "active_median", region: "unknown", sampleSize: 8 });
    expect(admitsCopyPoint(palCib, undeclaredRegion, withReach("local"))).toBe(false);
    expect(admitsCopyPoint(palCib, undeclaredRegion, withReach("global"))).toBe(true);
    // exact points pass under either reach; another concrete region under neither
    const exact = point({ source: RETRO_ES, kind: "cash" });
    expect(admitsCopyPoint(palCib, exact, withReach("local"))).toBe(true);
    expect(admitsCopyPoint(palCib, exact, withReach("global"))).toBe(true);
    const ntscJ = point({ source: RETRO_ES, kind: "cash", region: "NTSC_J" });
    expect(admitsCopyPoint(palCib, ntscJ, withReach("local"))).toBe(false);
    expect(admitsCopyPoint(palCib, ntscJ, withReach("global"))).toBe(false);
  });

  it("a source missing from the manifest is held to exactness — the conservative reading", () => {
    const stranger = point({ source: "someday_maybe" as SourceId, kind: "cash" });
    expect(admitsCopyPoint(palCib, stranger)).toBe(true);
    expect(admitsCopyPoint(palCib, { ...stranger, region: "unknown" })).toBe(false);
  });
});

describe("copyRegionInput — the one region input a copy is judged in", () => {
  it("returns the copy's own region input when buildSignalInputs produced one", () => {
    const pal = inputOf({ referenceByCondition: { cib: ref(30, 9) } });
    const unknown = inputOf({ region: "unknown", referenceByCondition: { cib: ref(20, 9) } });
    expect(copyRegionInput([unknown, pal], "PAL")).toBe(pal);
  });

  it("synthesizes an empty input carrying the undeclared-region references when the region has no points of its own", () => {
    // buildSignalInputs only threads unknown-region references onto regions
    // that exist, so a copy whose region has no exact points would otherwise
    // never reach the ladder's undeclared-region rungs
    const unknown = inputOf({ region: "unknown", referenceByCondition: { cib: ref(20, 9) } });
    const synthesized = copyRegionInput([unknown], "PAL");
    expect(synthesized).toEqual({
      region: "PAL",
      storeOffers: [],
      bids: [],
      listings: [],
      referenceByCondition: {},
      referenceUnknownRegion: unknown.referenceByCondition,
    });
  });

  it("synthesizes an input with no fallback references when there is no undeclared-region input either", () => {
    expect(copyRegionInput([], "NTSC_J")).toEqual({
      region: "NTSC_J",
      storeOffers: [],
      bids: [],
      listings: [],
      referenceByCondition: {},
      referenceUnknownRegion: undefined,
    });
  });

  it("a copy of undeclared region reads the undeclared-region input as its own, never a concrete one", () => {
    const pal = inputOf({ referenceByCondition: { cib: ref(30, 9) } });
    const unknown = inputOf({ region: "unknown", referenceByCondition: { cib: ref(20, 9) } });
    expect(copyRegionInput([pal, unknown], "unknown")).toBe(unknown);
    expect(copyRegionInput([pal], "unknown")).toMatchObject({ region: "unknown", referenceByCondition: {} });
  });
});
