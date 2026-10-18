import { defaultSignalConfig } from "../../src/settings/signals.js";
import { describe, it, expect } from "vitest";
import type { Condition, PricePointDto, SourceId, SourceInfo } from "@retrowatchdog/shared";
import { PROFIT_FEE_CAVEAT } from "@retrowatchdog/shared";
import {
  buildSignalInputs as buildSignalInputsWithSources,
  computeSignals as computeSignalsWithSources,
  type AcquiredCopy,
  type ReferencePoint,
  type RolePricePoint,
  type SignalAmount,
  type SignalConfig,
  type SignalInput,
} from "../../src/signals/computeSignals.js";
import { PLUGIN_SOURCES } from "../helpers/pluginSources.js";
import { emptyHistory } from "../../src/signals/history.js";

/**
 * Most fixtures here tag "ebay_uk" and "cex", so `buildSignalInputs` and
 * `computeSignals` are shadowed to default `sources` to `PLUGIN_SOURCES`. A
 * call that threads its own `extendedSources` is unaffected.
 */
function buildSignalInputs(
  points: PricePointDto[],
  sources: Record<string, SourceInfo> = PLUGIN_SOURCES,
  history?: Parameters<typeof buildSignalInputsWithSources>[2],
): SignalInput[] {
  return buildSignalInputsWithSources(points, sources, history);
}
function computeSignals(
  input: SignalInput,
  cfg: SignalConfig,
  sources: Record<string, SourceInfo> = PLUGIN_SOURCES,
): ReturnType<typeof computeSignalsWithSources> {
  return computeSignalsWithSources(input, cfg, sources);
}

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

// GBP amounts with usd === original: the math (which runs on .usd) keeps the
// exact legacy values, and both CeX and eBay UK are GBP so the evidence rule
// quotes £. The usd≠original case is pinned by its own dedicated tests below.
const gbp = (n: number): SignalAmount => ({ usd: n, original: n, currency: "GBP" });

const point = (over: Partial<PricePointDto>): PricePointDto => ({
  source: "cex", kind: "sell", region: "PAL", condition: "cib",
  priceUsd: 0, priceOriginal: 0, currencyOriginal: "GBP", available: null,
  ...over,
});
/** GBP point whose usd equals the original (suite-wide rate-1 convention) */
const gbpPoint = (n: number, over: Partial<PricePointDto>): PricePointDto =>
  point({ priceUsd: n, priceOriginal: n, ...over });

// Role-tagged building blocks for direct computeSignals inputs. Sources match
// the real manifest (CeX sells/bids, eBay lists/references) so parity
// scenarios read exactly like the legacy fixtures.
const store = (n: number, condition: Condition, over: Partial<RolePricePoint> = {}): RolePricePoint =>
  ({ source: "cex", kind: "sell", condition, grade: null, price: gbp(n), url: null, title: null, ...over });
const voucher = (n: number, condition: Condition, over: Partial<RolePricePoint> = {}): RolePricePoint =>
  ({ source: "cex", kind: "voucher", condition, grade: null, price: gbp(n), url: null, title: null, ...over });
const listing = (n: number, condition: Condition, title: string, url: string | null): RolePricePoint =>
  ({ source: "ebay_uk", kind: "active_listing", condition, grade: null, price: gbp(n), url, title });
const ref = (n: number, sampleSize: number, over: Partial<ReferencePoint> = {}): ReferencePoint =>
  ({ source: "ebay_uk", kind: "active_median", condition: "cib", grade: null, price: gbp(n), url: null, title: null, sampleSize, ...over });
const inputOf = (over: Partial<SignalInput>): SignalInput => ({
  region: "PAL", storeOffers: [], bids: [], listings: [], referenceByCondition: {}, ...over,
});

describe("buildSignalInputs", () => {
  it("isolates regions: PAL and NTSC_J points never mix", () => {
    const inputs = buildSignalInputs([
      gbpPoint(45, { source: "cex", kind: "sell", region: "PAL" }),
      gbpPoint(20, { source: "ebay_uk", kind: "active_median", region: "NTSC_J", sampleSize: 6 }),
    ]);
    expect(inputs).toHaveLength(2);
    const pal = inputs.find((i) => i.region === "PAL");
    expect(pal?.referenceByCondition).toEqual({});
  });

  it("keeps the LOWEST store offer when two boxes share a (source, condition)", () => {
    const inputs = buildSignalInputs([
      gbpPoint(60, { kind: "sell", condition: "cib" }),
      gbpPoint(270, { kind: "sell", condition: "cib" }), // gold cartridge box
    ]);
    expect(inputs[0].storeOffers).toHaveLength(1);
    expect(inputs[0].storeOffers[0].price.usd).toBe(60);
  });

  it("keeps the HIGHEST bid per (source, kind, condition): cash and voucher stay distinct flavors", () => {
    const inputs = buildSignalInputs([
      gbpPoint(40, { kind: "voucher", condition: "cib" }),
      gbpPoint(45, { kind: "voucher", condition: "cib" }),
      gbpPoint(20, { kind: "cash", condition: "cib" }),
      gbpPoint(30, { kind: "cash", condition: "cib" }),
    ]);
    const bids = inputs[0].bids;
    expect(bids).toHaveLength(2);
    expect(bids.find((b) => b.kind === "voucher")?.price.usd).toBe(45);
    expect(bids.find((b) => b.kind === "cash")?.price.usd).toBe(30);
  });

  it("carries the point's verbatim original amount + currency into the input", () => {
    const inputs = buildSignalInputs([
      point({ kind: "sell", condition: "cib", priceUsd: 56.25, priceOriginal: 45, currencyOriginal: "GBP" }),
    ]);
    expect(inputs[0].storeOffers[0].price).toEqual({ usd: 56.25, original: 45, currency: "GBP" });
  });

  it("keeps fair/poor graded buy listings OUT of the bargain set (damaged is not a bargain)", () => {
    const inputs = buildSignalInputs([
      gbpPoint(10, { source: "ebay_uk", kind: "active_listing", condition: "loose", grade: "poor", listingTitle: "OOT cart FAULTY spares or repairs" }),
      gbpPoint(12, { source: "ebay_uk", kind: "active_listing", condition: "loose", grade: "fair", listingTitle: "OOT cart tatty" }),
      gbpPoint(19, { source: "ebay_uk", kind: "active_listing", condition: "loose", grade: null, listingTitle: "OOT cart only" }),
      gbpPoint(55, { source: "ebay_uk", kind: "active_listing", condition: "loose", grade: "mint", listingTitle: "OOT cart mint" }),
    ]);
    // ungraded and mint stay in; fair/poor never enter the bargain candidate set
    expect(inputs[0].listings.map((l) => l.price.usd)).toEqual([19, 55]);
  });

  it("keeps a zero-priced point out of every role: nothing is evidence at 0", () => {
    // A price of 0 is storable — a genuinely free listing is a real quote, and
    // the price table can show it — but it is not comparable. Every rule here
    // is a ratio, and 0 wins all of them: a zero buy listing undercuts every
    // reference that exists, a zero store price is "below market" against any
    // median, and a zero bid is a payout nobody offered. The realistic source
    // is not generosity but a missing amount that became 0 on the way in,
    // which is exactly the kind of claim this engine must not amplify.
    const inputs = buildSignalInputs([
      // a BUILT-IN buy_listing source, deliberately: this case is about the
      // zero gate, and a source the registry does not know would be dropped a
      // line earlier for having no role, leaving the gate untested
      gbpPoint(0, { source: "ebay_uk", kind: "active_listing", condition: "cib" }),
      gbpPoint(0, { source: "cex", kind: "sell", condition: "cib" }),
      gbpPoint(0, { source: "cex", kind: "voucher", condition: "cib" }),
      gbpPoint(40, { source: "ebay_uk", kind: "active_median", condition: "cib", sampleSize: 9 }),
    ]);
    expect(inputs[0].listings).toEqual([]);
    expect(inputs[0].storeOffers).toEqual([]);
    expect(inputs[0].bids).toEqual([]);
    // and so no bargain is announced against the £40 market reading
    expect(computeSignals(inputs[0], cfg).filter((s) => s.type === "UNDERPRICED")).toEqual([]);
  });

  it("threads unknown-region references into every concrete region as the labeled fallback", () => {
    const inputs = buildSignalInputs([
      gbpPoint(45, { source: "cex", kind: "sell", region: "PAL", condition: "cib" }),
      gbpPoint(30, { source: "ebay_uk", kind: "active_median", region: "unknown", condition: "cib", sampleSize: 8 }),
    ]);
    const pal = inputs.find((i) => i.region === "PAL");
    expect(pal?.referenceUnknownRegion?.cib?.price.usd).toBe(30);
  });

  it("skips a reference point without a sample size (unusable baseline)", () => {
    const inputs = buildSignalInputs([
      gbpPoint(30, { source: "ebay_uk", kind: "active_median", condition: "cib", sampleSize: null }),
    ]);
    // the region input exists (ported behavior) but holds no usable reference
    expect(inputs).toHaveLength(1);
    expect(inputs[0].referenceByCondition).toEqual({});
  });

  it("keeps boxed_no_manual points in their own condition group, never merged into cib", () => {
    // conditions are keys: the w/o-Manual SKU and the w/ Manual SKU each keep
    // their own store offer, their own bid and their own reference slot
    const inputs = buildSignalInputs([
      gbpPoint(30, { kind: "sell", condition: "boxed_no_manual" }),
      gbpPoint(45, { kind: "sell", condition: "cib" }),
      gbpPoint(20, { kind: "voucher", condition: "boxed_no_manual" }),
      gbpPoint(34, { kind: "voucher", condition: "cib" }),
      gbpPoint(40, { source: "ebay_uk", kind: "active_median", condition: "cib", sampleSize: 9 }),
    ]);
    expect(inputs).toHaveLength(1);
    const [pal] = inputs;
    expect(pal.storeOffers.map((s) => [s.condition, s.price.usd])).toEqual([
      ["boxed_no_manual", 30],
      ["cib", 45],
    ]);
    expect(pal.bids.map((b) => [b.condition, b.price.usd])).toEqual([
      ["boxed_no_manual", 20],
      ["cib", 34],
    ]);
    expect(pal.referenceByCondition.cib?.price.usd).toBe(40);
    expect(pal.referenceByCondition.boxed_no_manual).toBeUndefined();
  });

  it("guide-role and undeclared kinds are inert: no input, no fuel", () => {
    const inputs = buildSignalInputs([
      // pricecharting guide: role 'guide' — informational only in v1
      gbpPoint(50, { source: "pricecharting", kind: "guide", condition: "cib" }),
      // a kind the source never declared a role for (cex has no active_median role)
      gbpPoint(30, { source: "cex", kind: "active_median", condition: "cib", sampleSize: 9 }),
      // an unknown source id entirely
      gbpPoint(40, { source: "someday_maybe" as SourceId, kind: "sell", condition: "cib" }),
    ]);
    expect(inputs).toHaveLength(0);
  });
});

describe("buildSignalInputs — availability gate (a price you cannot buy at is not an offer)", () => {
  // Measured defect (Final Fantasy Tactics Advance, 2026-09-02): 11 of 17
  // CeX rows were out of stock — the £240/£260 ones included — and still fed
  // OVERPRICED_STORE. Only the BUY roles are gated: CeX keeps buying an
  // out-of-stock box, and eBay medians are aggregates of active listings.
  const reference = (n: number, condition: Condition, sampleSize = 9): PricePointDto =>
    gbpPoint(n, { source: "ebay_uk", kind: "active_median", condition, sampleSize });

  it("an out-of-stock store price never yields OVERPRICED_STORE", () => {
    const inputs = buildSignalInputs([
      gbpPoint(240, { kind: "sell", condition: "cib", available: false }),
      reference(30, "cib"),
    ]);
    expect(inputs[0].storeOffers).toEqual([]);
    expect(computeSignals(inputs[0], cfg).some((s) => s.type === "OVERPRICED_STORE")).toBe(false);
  });

  it("an out-of-stock store price never yields UNDERPRICED against the reference", () => {
    const inputs = buildSignalInputs([
      gbpPoint(10, { kind: "sell", condition: "cib", available: false }),
      reference(30, "cib"),
    ]);
    expect(computeSignals(inputs[0], cfg).some((s) => s.type === "UNDERPRICED")).toBe(false);
  });

  it("an out-of-stock store price never anchors the pairwise UNDERPRICED for a listing", () => {
    const inputs = buildSignalInputs([
      gbpPoint(60, { kind: "sell", condition: "cib", available: false }),
      gbpPoint(38, { source: "ebay_uk", kind: "active_listing", condition: "cib", available: true, listingTitle: "OOT boxed", url: "https://x/38" }),
    ]);
    expect(computeSignals(inputs[0], cfg)).toEqual([]);
  });

  it("an out-of-stock listing never yields UNDERPRICED, neither vs the reference nor pairwise", () => {
    const inputs = buildSignalInputs([
      reference(30, "cib"),
      gbpPoint(60, { kind: "sell", condition: "cib", available: true }),
      gbpPoint(19, { source: "ebay_uk", kind: "active_listing", condition: "cib", available: false, listingTitle: "OOT boxed ended", url: "https://x/19" }),
    ]);
    expect(inputs[0].listings).toEqual([]);
    const signals = computeSignals(inputs[0], cfg);
    expect(signals.some((s) => s.type === "UNDERPRICED")).toBe(false);
    // the in-stock store price is still judged on its own merits
    expect(signals.some((s) => s.type === "OVERPRICED_STORE")).toBe(true);
  });

  it("the SAME out-of-stock SKU's cash/voucher bids still yield FLIP", () => {
    // one CeX box: sell/cash/voucher all carry the box's stock flag
    const inputs = buildSignalInputs([
      gbpPoint(100, { kind: "sell", condition: "cib", available: false }),
      gbpPoint(40, { kind: "voucher", condition: "cib", available: false }),
      gbpPoint(30, { kind: "cash", condition: "cib", available: false }),
      reference(30, "cib"),
    ]);
    expect(inputs[0].storeOffers).toEqual([]);
    expect(inputs[0].bids).toHaveLength(2);
    const signals = computeSignals(inputs[0], cfg);
    const flip = signals.find((s) => s.type === "FLIP");
    expect(flip).toBeDefined();
    expect(flip?.sellSource).toBe("cex");
    expect(flip?.reasoning).toContain("voucher");
    expect(signals.some((s) => s.type === "OVERPRICED_STORE")).toBe(false);
  });

  it("picks the lowest IN-STOCK store price, not the lowest overall", () => {
    const inputs = buildSignalInputs([
      gbpPoint(20, { kind: "sell", condition: "cib", available: false }), // cheaper, but not buyable
      gbpPoint(45, { kind: "sell", condition: "cib", available: true }),
      reference(32, "cib", 12),
    ]);
    expect(inputs[0].storeOffers).toHaveLength(1);
    expect(inputs[0].storeOffers[0].price.usd).toBe(45);
    expect(computeSignals(inputs[0], cfg).some((s) => s.type === "OVERPRICED_STORE")).toBe(true);
  });

  it("treats an unknown flag (null) as available: legacy rows keep firing", () => {
    const inputs = buildSignalInputs([
      gbpPoint(45, { kind: "sell", condition: "cib", available: null }),
      gbpPoint(19, { source: "ebay_uk", kind: "active_listing", condition: "cib", available: null, listingTitle: "OOT boxed" }),
      reference(32, "cib", 12),
    ]);
    expect(inputs[0].storeOffers).toHaveLength(1);
    expect(inputs[0].listings).toHaveLength(1);
    const types = computeSignals(inputs[0], cfg).map((s) => s.type);
    expect(types).toContain("OVERPRICED_STORE");
    expect(types).toContain("UNDERPRICED");
  });
});

describe("computeSignals", () => {
  it("fires OVERPRICED_STORE with reasoning naming region, condition and both prices", () => {
    const signals = computeSignals(
      inputOf({
        storeOffers: [store(45, "cib")],
        referenceByCondition: { cib: ref(32, 12) },
      }),
      cfg,
    );
    const over = signals.find((s) => s.type === "OVERPRICED_STORE");
    expect(over).toBeDefined();
    expect(over?.reasoning).toContain("£45");
    expect(over?.reasoning).toContain("£32");
    expect(over?.reasoning).toContain("PAL");
    expect(over?.reasoning).toContain("12 listings");
    // structured source metadata: a single-source signal names its source
    expect(over?.source).toBe("cex");
    expect(over?.buySource).toBeUndefined();
    expect(over?.sellSource).toBeUndefined();
  });

  it("quotes the verbatim ORIGINALS when both sides share a currency (GBP vs GBP), never the USD twins", () => {
    // usd and original deliberately differ (rate 1.25): reasoning must quote
    // the £ originals — the currency the comparison actually happened in —
    // while the threshold math runs on the USD values (currency-invariant).
    const signals = computeSignals(
      inputOf({
        storeOffers: [store(0, "cib", { price: { usd: 56.25, original: 45, currency: "GBP" } })],
        referenceByCondition: { cib: ref(0, 12, { price: { usd: 40, original: 32, currency: "GBP" } }) },
      }),
      cfg,
    );
    const over = signals.find((s) => s.type === "OVERPRICED_STORE");
    expect(over).toBeDefined();
    expect(over?.reasoning).toContain("£45");
    expect(over?.reasoning).toContain("£32");
    expect(over?.reasoning).not.toContain("$");
  });

  it("falls back to quoting USD when the two sides carry different currencies", () => {
    const signals = computeSignals(
      inputOf({
        region: "NTSC_J",
        storeOffers: [store(0, "cib", { price: { usd: 50, original: 40, currency: "GBP" } })],
        referenceByCondition: { cib: ref(0, 8, { price: { usd: 30, original: 27, currency: "EUR" } }) },
      }),
      cfg,
    );
    const over = signals.find((s) => s.type === "OVERPRICED_STORE");
    expect(over).toBeDefined();
    expect(over?.reasoning).toContain("$50");
    expect(over?.reasoning).toContain("$30");
    expect(over?.reasoning).not.toContain("£");
  });

  it("fires FLIP when a voucher bid beats the reference * factor (legacy voucher scenario)", () => {
    const signals = computeSignals(
      inputOf({
        bids: [voucher(40, "loose")],
        referenceByCondition: { loose: ref(30, 8, { condition: "loose" }) },
      }),
      cfg,
    );
    const flip = signals.find((s) => s.type === "FLIP");
    expect(flip).toBeDefined();
    // structured flip metadata: buy on eBay, trade in at CeX UK
    expect(flip?.buySource).toBe("ebay_uk");
    expect(flip?.sellSource).toBe("cex");
    expect(flip?.source).toBeUndefined();
    // the bid flavor is named in the reasoning
    expect(flip?.reasoning).toContain("voucher");
  });

  it("does NOT fire the flip at exactly the threshold", () => {
    const signals = computeSignals(
      inputOf({
        bids: [voucher(34.5, "loose")], // 30 * 1.15 exactly
        referenceByCondition: { loose: ref(30, 8, { condition: "loose" }) },
      }),
      cfg,
    );
    expect(signals.some((s) => s.type === "FLIP")).toBe(false);
  });

  it("names the cash flavor when the bid is a cash offer", () => {
    const signals = computeSignals(
      inputOf({
        bids: [voucher(40, "loose", { kind: "cash" })],
        referenceByCondition: { loose: ref(30, 8, { condition: "loose" }) },
      }),
      cfg,
    );
    const flip = signals.find((s) => s.type === "FLIP");
    expect(flip).toBeDefined();
    expect(flip?.reasoning).toContain("cash");
  });

  it("fires UNDERPRICED per cheap listing against its condition reference", () => {
    const signals = computeSignals(
      inputOf({
        referenceByCondition: { loose: ref(30, 9, { condition: "loose" }) },
        listings: [
          listing(19, "loose", "OOT cart only bargain", "https://x"),
          listing(28, "loose", "OOT cart normal", "https://y"),
        ],
      }),
      cfg,
    );
    const under = signals.filter((s) => s.type === "UNDERPRICED");
    expect(under).toHaveLength(1);
    expect(under[0].reasoning).toContain("£19");
    expect(under[0].reasoning).toContain("PAL/loose");
    expect(under[0].source).toBe("ebay_uk");
  });

  it("never fires UNDERPRICED on a fair/poor listing; a cheap working listing still does", () => {
    // end-to-end through buildSignalInputs: the faulty £10 point is dropped
    // before computeSignals ever sees it, while the genuinely cheap working
    // £19 cart (below 30 * 0.7 = £21) still fires
    const inputs = buildSignalInputs([
      gbpPoint(30, { source: "ebay_uk", kind: "active_median", condition: "loose", sampleSize: 9 }),
      gbpPoint(10, { source: "ebay_uk", kind: "active_listing", condition: "loose", grade: "poor", listingTitle: "OOT cart FAULTY spares or repairs", url: "https://x/faulty" }),
      gbpPoint(19, { source: "ebay_uk", kind: "active_listing", condition: "loose", grade: null, listingTitle: "OOT cart only bargain", url: "https://x/bargain" }),
    ]);
    const signals = computeSignals(inputs[0], cfg);
    const under = signals.filter((s) => s.type === "UNDERPRICED");
    expect(under).toHaveLength(1);
    expect(under[0].reasoning).toContain("£19");
    expect(under[0].url).toBe("https://x/bargain");
  });

  it("carries the listing url on UNDERPRICED when the listing has one", () => {
    const signals = computeSignals(
      inputOf({
        referenceByCondition: { loose: ref(30, 9, { condition: "loose" }) },
        listings: [listing(19, "loose", "OOT cart only bargain", "https://x/listing/123")],
      }),
      cfg,
    );
    const under = signals.find((s) => s.type === "UNDERPRICED");
    expect(under?.url).toBe("https://x/listing/123");
  });

  it("leaves url undefined on UNDERPRICED when the listing has none", () => {
    const signals = computeSignals(
      inputOf({
        referenceByCondition: { loose: ref(30, 9, { condition: "loose" }) },
        listings: [listing(19, "loose", "OOT cart only bargain", null)],
      }),
      cfg,
    );
    const under = signals.find((s) => s.type === "UNDERPRICED");
    expect(under?.url).toBeUndefined();
  });

  it("never sets url on OVERPRICED_STORE or FLIP signals", () => {
    const signals = computeSignals(
      inputOf({
        storeOffers: [store(45, "cib")],
        bids: [voucher(40, "cib")],
        referenceByCondition: { cib: ref(30, 12) },
      }),
      cfg,
    );
    const overpriced = signals.find((s) => s.type === "OVERPRICED_STORE");
    const flip = signals.find((s) => s.type === "FLIP");
    expect(overpriced).toBeDefined();
    expect(flip).toBeDefined();
    expect(overpriced?.url).toBeUndefined();
    expect(flip?.url).toBeUndefined();
  });

  it("falls back to the unknown-condition reference and says so in the reasoning", () => {
    const signals = computeSignals(
      inputOf({
        storeOffers: [store(50, "cib")],
        referenceByCondition: { unknown: ref(30, 7, { condition: "unknown" }) },
      }),
      cfg,
    );
    const over = signals.find((s) => s.type === "OVERPRICED_STORE");
    expect(over).toBeDefined();
    expect(over?.reasoning.toLowerCase()).toContain("undeclared condition");
  });

  it("falls back to the unknown-REGION reference and labels it in the reasoning", () => {
    const signals = computeSignals(
      inputOf({
        storeOffers: [store(50, "cib")],
        referenceUnknownRegion: { cib: ref(30, 8) },
      }),
      cfg,
    );
    const over = signals.find((s) => s.type === "OVERPRICED_STORE");
    expect(over).toBeDefined();
    expect(over?.reasoning.toLowerCase()).toContain("undeclared region");
  });

  it("emits one INSUFFICIENT_DATA when samples are below minSample", () => {
    const signals = computeSignals(
      inputOf({
        storeOffers: [store(50, "cib"), store(25, "loose")],
        bids: [voucher(40, "cib")],
        referenceByCondition: { cib: ref(30, 3) },
      }),
      cfg,
    );
    expect(signals.filter((s) => s.type === "INSUFFICIENT_DATA")).toHaveLength(1);
    expect(signals).toHaveLength(1); // nothing else fires on thin data
    // INSUFFICIENT_DATA is not about any one source: no structured fields
    expect(signals[0].source).toBeUndefined();
    expect(signals[0].buySource).toBeUndefined();
    expect(signals[0].sellSource).toBeUndefined();
  });

  it("emits one INSUFFICIENT_DATA when a wanted comparison has a completely absent reference", () => {
    const signals = computeSignals(
      inputOf({
        storeOffers: [store(45, "cib"), store(30, "loose")],
        referenceByCondition: { cib: ref(40, 10) },
      }),
      cfg,
    );
    expect(signals.filter((s) => s.type === "INSUFFICIENT_DATA")).toHaveLength(1);
    expect(signals).toHaveLength(1); // nothing else fires when the loose reference is missing
  });

  it("a boxed_no_manual store price never borrows the cib reference, but the undeclared-condition rung still serves it", () => {
    // only a cib reference: the w/o-Manual offer is its own group with nothing
    // to compare against — INSUFFICIENT_DATA, never an OVERPRICED vs cib
    const cibOnly = computeSignals(
      inputOf({
        storeOffers: [store(60, "boxed_no_manual")],
        referenceByCondition: { cib: ref(30, 9) },
      }),
      cfg,
    );
    expect(cibOnly).toHaveLength(1);
    expect(cibOnly[0].type).toBe("INSUFFICIENT_DATA");

    // the same-region / undeclared-condition rung is unaffected by the new
    // tier: it still labels the fallback and downgrades to potential
    const viaUnknown = computeSignals(
      inputOf({
        storeOffers: [store(60, "boxed_no_manual")],
        referenceByCondition: { cib: ref(30, 9), unknown: ref(32, 8) },
      }),
      cfg,
    );
    expect(viaUnknown).toHaveLength(1);
    expect(viaUnknown[0].type).toBe("OVERPRICED_STORE");
    expect(viaUnknown[0].reasoning).toContain("PAL/boxed_no_manual");
    expect(viaUnknown[0].reasoning).toContain("£32 (8 listings, undeclared condition)");
    expect(viaUnknown[0].confidence).toBe("potential");
    expect(viaUnknown[0].caveats).toEqual(["market median from listings with undeclared condition"]);
  });
});

describe("computeSignals — generic-rule capabilities", () => {
  it("a STORE selling under the reference fires UNDERPRICED with source cex", () => {
    // CeX sell £18 vs eBay median £30 (8 listings): 18 < 30 * 0.7 = 21
    const signals = computeSignals(
      inputOf({
        storeOffers: [store(18, "cib")],
        referenceByCondition: { cib: ref(30, 8) },
      }),
      cfg,
    );
    const under = signals.find((s) => s.type === "UNDERPRICED");
    expect(under).toBeDefined();
    expect(under?.source).toBe("cex");
    expect(under?.reasoning).toContain("CeX");
    expect(under?.reasoning).toContain("£18");
    expect(under?.reasoning).toContain("£30");
    // and it is not simultaneously called overpriced
    expect(signals.some((s) => s.type === "OVERPRICED_STORE")).toBe(false);
  });

  it("pairwise rule: a listing undercutting another source's store price fires even with NO reference", () => {
    // eBay listing £38 vs CeX sell £60: 38 < 60 * 0.85 = 51 — the user's
    // original listing-beats-store ask, firing while R is entirely absent
    const signals = computeSignals(
      inputOf({
        storeOffers: [store(60, "cib")],
        listings: [listing(38, "cib", "OOT boxed complete", "https://x/itm/38")],
      }),
      cfg,
    );
    const under = signals.filter((s) => s.type === "UNDERPRICED");
    expect(under).toHaveLength(1);
    expect(under[0].url).toBe("https://x/itm/38");
    expect(under[0].source).toBe("ebay_uk");
    expect(under[0].reasoning).toContain("cheaper than buying at CeX");
    expect(under[0].reasoning).toContain("£38");
    expect(under[0].reasoning).toContain("£60");
    // a fired signal means the missing reference is NOT insufficient data
    expect(signals.some((s) => s.type === "INSUFFICIENT_DATA")).toBe(false);
  });

  it("pairwise rule does NOT fire at exactly the cross-store threshold", () => {
    const signals = computeSignals(
      inputOf({
        storeOffers: [store(60, "cib")],
        listings: [listing(51, "cib", "OOT boxed", null)], // 60 * 0.85 exactly
      }),
      cfg,
    );
    expect(signals.some((s) => s.type === "UNDERPRICED")).toBe(false);
  });

  it("pairwise rule is condition-STRICT: unknown vs cib never compares", () => {
    const signals = computeSignals(
      inputOf({
        storeOffers: [store(60, "cib")],
        listings: [listing(10, "unknown", "OOT untold condition", null)],
      }),
      cfg,
    );
    expect(signals.filter((s) => s.type === "UNDERPRICED")).toHaveLength(0);
  });

  it("pairwise rule never compares a listing against its own source's store price", () => {
    const signals = computeSignals(
      inputOf({
        storeOffers: [store(60, "cib", { source: "ebay_uk" })],
        listings: [listing(38, "cib", "OOT boxed", null)],
      }),
      cfg,
    );
    expect(signals.filter((s) => s.type === "UNDERPRICED")).toHaveLength(0);
  });

  it("FLIP acquisition proxy: the cheapest same-condition listing wins when below the reference", () => {
    // voucher £30 vs reference £42 would NOT flip (needs > 48.3), but a £20
    // listing is the real acquisition cost: 30 > 20 * 1.15 = 23 fires
    const signals = computeSignals(
      inputOf({
        bids: [voucher(30, "cib")],
        referenceByCondition: { cib: ref(42, 8) },
        listings: [listing(20, "cib", "OOT boxed cheap", "https://x/itm/20")],
      }),
      cfg,
    );
    const flip = signals.find((s) => s.type === "FLIP");
    expect(flip).toBeDefined();
    expect(flip?.buySource).toBe("ebay_uk");
    expect(flip?.sellSource).toBe("cex");
    expect(flip?.reasoning).toContain("£20");
    expect(flip?.reasoning).toContain("OOT boxed cheap");
  });

  it("FLIP works from a listing alone when no reference exists at all", () => {
    const signals = computeSignals(
      inputOf({
        bids: [voucher(30, "cib")],
        listings: [listing(20, "cib", "OOT boxed cheap", null)],
      }),
      cfg,
    );
    const flip = signals.find((s) => s.type === "FLIP");
    expect(flip).toBeDefined();
    expect(flip?.buySource).toBe("ebay_uk");
    expect(flip?.sellSource).toBe("cex");
    expect(signals.some((s) => s.type === "INSUFFICIENT_DATA")).toBe(false);
  });

  it("FLIP strictly matches listing conditions for the proxy: an unknown-condition listing never stands in", () => {
    // the only listing is condition-unknown; the cib bid must fall back to the
    // reference ladder alone (cib -> unknown reference, labeled)
    const signals = computeSignals(
      inputOf({
        bids: [voucher(40, "cib")],
        referenceByCondition: { unknown: ref(30, 8, { condition: "unknown" }) },
        listings: [listing(5, "unknown", "OOT mystery bundle", null)],
      }),
      cfg,
    );
    const flip = signals.find((s) => s.type === "FLIP");
    expect(flip).toBeDefined();
    // proxy came from the unknown-condition reference (£30), not the £5 listing
    expect(flip?.reasoning).toContain("£30");
    expect(flip?.reasoning.toLowerCase()).toContain("undeclared condition");
  });
});

describe("computeSignals — dedupe and truthfulness rulings", () => {
  it("one listing never wears two UNDERPRICED badges: vs-reference suppresses the pairwise duplicate", () => {
    // reviewer scenario: median $30, store $60, listing $19 — the listing
    // qualifies under BOTH the vs-reference rule (19 < 21) and the pairwise
    // rule (19 < 51). Ruling: the vs-reference badge wins, pairwise is
    // suppressed for that same listing point; the store still gets its own
    // OVERPRICED_STORE (60 > 39).
    const signals = computeSignals(
      inputOf({
        referenceByCondition: { cib: ref(30, 9) },
        storeOffers: [store(60, "cib")],
        listings: [listing(19, "cib", "OOT boxed bargain", "https://x/itm/19")],
      }),
      cfg,
    );
    const under = signals.filter((s) => s.type === "UNDERPRICED");
    expect(under).toHaveLength(1);
    expect(under[0].reasoning).toContain("bargain candidate"); // the vs-reference badge
    expect(under[0].url).toBe("https://x/itm/19");
    expect(signals.filter((s) => s.type === "OVERPRICED_STORE")).toHaveLength(1);
    expect(signals).toHaveLength(2);
  });

  it("the pairwise rule still fires for a listing that only qualifies against a store", () => {
    // listing $40 is NOT under the reference threshold (needs < 21) but does
    // undercut the $60 store (40 < 51): the pairwise badge survives the dedupe
    const signals = computeSignals(
      inputOf({
        referenceByCondition: { cib: ref(30, 9) },
        storeOffers: [store(60, "cib")],
        listings: [listing(40, "cib", "OOT boxed fair price", null)],
      }),
      cfg,
    );
    const under = signals.filter((s) => s.type === "UNDERPRICED");
    expect(under).toHaveLength(1);
    expect(under[0].reasoning).toContain("cheaper than buying at CeX");
  });

  it("a flip comparison resolved through the listing proxy is RESOLVED: below-threshold means silence, not INSUFFICIENT_DATA", () => {
    // Truthfulness fix (sanctioned semantic correction, not a parity break —
    // the old engine had no proxy resolution to be truthful about): the bid
    // DID get compared (voucher $20 vs listing $19, under the 1.15 factor),
    // so claiming "not enough reference listings" would be a lie. No signal
    // of any kind fires.
    const signals = computeSignals(
      inputOf({
        bids: [voucher(20, "cib")],
        listings: [listing(19, "cib", "OOT boxed", null)],
      }),
      cfg,
    );
    expect(signals).toEqual([]);
  });

  it("INSUFFICIENT_DATA still fires when a bid's comparison truly cannot run (no reference, no listing)", () => {
    const signals = computeSignals(inputOf({ bids: [voucher(20, "cib")] }), cfg);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe("INSUFFICIENT_DATA");
  });
});

describe("computeSignals — the spec-9 ladder descends to the first USABLE rung", () => {
  // Regression suite for a live defect: the ladder used to stop at the first
  // rung that EXISTED and only then apply the minSample gate, so a thin rung
  // swallowed the fallback and the whole comparison returned null.

  it("game 410 'Columns' (game_gear, PAL): a 1-listing PAL rung no longer buries the 18-listing fallback", () => {
    // The measured live scenario. CeX quotes £28 cib / £18 voucher / £2 loose
    // in PAL; the PAL-labelled eBay medians are far too thin to be a market
    // (1 and 2 listings), while the undeclared-region medians are real
    // (18 and 12 listings). Before the fix every comparison stopped on a thin
    // PAL rung, failed the sample gate, and the game reported INSUFFICIENT_DATA
    // while a £28 CeX price sat against a £4.19 market.
    const signals = computeSignals(
      inputOf({
        region: "PAL",
        storeOffers: [store(28, "cib"), store(2, "loose")],
        bids: [voucher(18, "cib")],
        referenceByCondition: {
          // rung 2 for cib. Deliberately priced so that USING it would fire
          // nothing (28 < 25 * 1.3): the assertions below can only pass via
          // the deeper rung.
          unknown: ref(25, 1, { condition: "unknown" }),
          // rung 1 for loose, likewise inert if used (2 > 2.5 * 0.7)
          loose: ref(2.5, 2, { condition: "loose" }),
        },
        referenceUnknownRegion: {
          unknown: ref(4.19, 18, { condition: "unknown" }),
          loose: ref(4.35, 12, { condition: "loose" }),
        },
      }),
      cfg,
    );

    expect(signals.some((s) => s.type === "INSUFFICIENT_DATA")).toBe(false);

    // cib: rungs 1 and 3 are absent, rung 2 is too thin — rung 4 (4.19 x18) wins
    const over = signals.find((s) => s.type === "OVERPRICED_STORE");
    expect(over).toBeDefined();
    expect(over?.source).toBe("cex");
    expect(over?.reasoning).toContain("£28");
    expect(over?.reasoning).toContain("£4.19");
    expect(over?.reasoning).toContain("18 listings");
    expect(over?.reasoning).toContain("undeclared region");
    expect(over?.confidence).toBe("potential");
    expect(over?.caveats).toEqual([
      "market median from listings with undeclared condition",
      "market median from listings with undeclared region",
    ]);

    // the same descent resolves the voucher's acquisition proxy: 18 > 4.19 * 1.15
    const flip = signals.find((s) => s.type === "FLIP");
    expect(flip).toBeDefined();
    expect(flip?.buySource).toBe("ebay_uk");
    expect(flip?.sellSource).toBe("cex");

    // loose: rung 1 (2 listings) and rung 2 (1 listing) are both too thin, so
    // rung 3 (4.35 x12, same condition) wins — undeclared region only
    const under = signals.find((s) => s.type === "UNDERPRICED");
    expect(under).toBeDefined();
    expect(under?.source).toBe("cex");
    expect(under?.reasoning).toContain("12 listings");
    expect(under?.caveats).toEqual(["market median from listings with undeclared region"]);
  });

  it("a thin FIRST rung no longer blocks a usable LATER rung", () => {
    // exact cib rung exists but holds 2 listings; the undeclared-region rung
    // holds 9. Using the thin rung would fire nothing (50 < 40 * 1.3), so only
    // the descent can produce this signal.
    const signals = computeSignals(
      inputOf({
        storeOffers: [store(50, "cib")],
        referenceByCondition: { cib: ref(40, 2) },
        referenceUnknownRegion: { cib: ref(30, 9) },
      }),
      cfg,
    );
    const over = signals.find((s) => s.type === "OVERPRICED_STORE");
    expect(over).toBeDefined();
    expect(over?.reasoning).toContain("£30");
    expect(over?.reasoning).toContain("9 listings");
    expect(over?.reasoning.toLowerCase()).toContain("undeclared region");
    expect(over?.confidence).toBe("potential");
    expect(over?.caveats).toEqual(["market median from listings with undeclared region"]);
    expect(signals.some((s) => s.type === "INSUFFICIENT_DATA")).toBe(false);
  });

  it("when NO rung reaches minSample, INSUFFICIENT_DATA fires exactly as before", () => {
    // all four rungs populated, every one of them under minSample: the ladder
    // must still resolve to null and the insufficiency semantics are unchanged
    const signals = computeSignals(
      inputOf({
        storeOffers: [store(50, "cib")],
        referenceByCondition: { cib: ref(40, 2), unknown: ref(35, 1, { condition: "unknown" }) },
        referenceUnknownRegion: { cib: ref(30, 4), unknown: ref(25, 3, { condition: "unknown" }) },
      }),
      cfg,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe("INSUFFICIENT_DATA");
    expect(signals[0].confidence).toBeUndefined();
    expect(signals[0].caveats).toBeUndefined();
  });

  it("a usable EXACT rung still wins over fatter later rungs, and stays high confidence", () => {
    // no accidental preference for broader data: the deeper rungs carry far
    // more listings AND (at £8/£5) would move the evidence, yet the strict
    // rung is the right answer and keeps the signal free of caveats
    const signals = computeSignals(
      inputOf({
        storeOffers: [store(50, "cib")],
        referenceByCondition: { cib: ref(32, 12), unknown: ref(10, 40, { condition: "unknown" }) },
        referenceUnknownRegion: { cib: ref(8, 50), unknown: ref(5, 99, { condition: "unknown" }) },
      }),
      cfg,
    );
    const over = signals.find((s) => s.type === "OVERPRICED_STORE");
    expect(over).toBeDefined();
    expect(over?.reasoning).toContain("£32");
    expect(over?.reasoning).toContain("12 listings");
    expect(over?.reasoning.toLowerCase()).not.toContain("undeclared");
    expect(over?.confidence).toBe("high");
    expect(over?.caveats).toEqual([]);
  });
});

describe("computeSignals — confidence dimension", () => {
  // Confidence is ADDITIVE: none of these scenarios change whether a signal
  // fires (the parity suites above pin that), only how it is labeled.

  it("strict dims, no fallback, grade-compatible: high confidence with empty caveats", () => {
    const signals = computeSignals(
      inputOf({
        storeOffers: [store(45, "cib")],
        referenceByCondition: { cib: ref(32, 12) },
      }),
      cfg,
    );
    const over = signals.find((s) => s.type === "OVERPRICED_STORE");
    expect(over?.confidence).toBe("high");
    expect(over?.caveats).toEqual([]);
  });

  it("a reference reached via the unknown-CONDITION fallback downgrades to potential with a caveat", () => {
    const signals = computeSignals(
      inputOf({
        storeOffers: [store(50, "cib")],
        referenceByCondition: { unknown: ref(30, 7, { condition: "unknown" }) },
      }),
      cfg,
    );
    const over = signals.find((s) => s.type === "OVERPRICED_STORE");
    expect(over?.confidence).toBe("potential");
    expect(over?.caveats).toEqual(["market median from listings with undeclared condition"]);
  });

  it("a reference reached via the unknown-REGION fallback downgrades to potential with a caveat", () => {
    const signals = computeSignals(
      inputOf({
        storeOffers: [store(50, "cib")],
        referenceUnknownRegion: { cib: ref(30, 8) },
      }),
      cfg,
    );
    const over = signals.find((s) => s.type === "OVERPRICED_STORE");
    expect(over?.confidence).toBe("potential");
    expect(over?.caveats).toEqual(["market median from listings with undeclared region"]);
  });

  it("an unknown-condition compared listing downgrades to potential", () => {
    // listing and reference are both condition-unknown (ladder rung 1, no
    // fallback flag) — the downgrade comes from the compared point itself
    const signals = computeSignals(
      inputOf({
        referenceByCondition: { unknown: ref(30, 9, { condition: "unknown" }) },
        listings: [listing(19, "unknown", "OOT untold condition", "https://x")],
      }),
      cfg,
    );
    const under = signals.find((s) => s.type === "UNDERPRICED");
    expect(under?.confidence).toBe("potential");
    expect(under?.caveats).toEqual(["listing condition not declared"]);
  });

  it("signals computed inside the region-'unknown' input carry the region caveat", () => {
    const signals = computeSignals(
      inputOf({
        region: "unknown",
        referenceByCondition: { loose: ref(30, 9, { condition: "loose" }) },
        listings: [listing(19, "loose", "OOT cart no region named", null)],
      }),
      cfg,
    );
    const under = signals.find((s) => s.type === "UNDERPRICED");
    expect(under?.confidence).toBe("potential");
    expect(under?.caveats).toEqual(["listing region not declared"]);
  });

  it("a Mint-SKU voucher flip priced against ungraded market data is potential with the grade caveat", () => {
    // the user's core example: the flip assumes the copy you'd buy arrives mint
    const signals = computeSignals(
      inputOf({
        bids: [voucher(218, "cib", { grade: "mint" })],
        referenceByCondition: { cib: ref(100, 8) },
      }),
      cfg,
    );
    const flip = signals.find((s) => s.type === "FLIP");
    expect(flip?.confidence).toBe("potential");
    expect(flip?.caveats).toEqual(["requires a mint copy — listing grades unverified"]);
  });

  it("a grade-SYMMETRIC flip stays high: mint bid vs a mint-graded acquisition listing", () => {
    const mintListing = { ...listing(20, "cib", "OOT boxed mint", null), grade: "mint" as const };
    const signals = computeSignals(
      inputOf({
        bids: [voucher(40, "cib", { grade: "mint" })],
        listings: [mintListing],
      }),
      cfg,
    );
    const flip = signals.find((s) => s.type === "FLIP");
    expect(flip).toBeDefined();
    expect(flip?.confidence).toBe("high");
    expect(flip?.caveats).toEqual([]);
  });

  it("guaranteedGrade (collection context) lifts the grade-asymmetry downgrade for a grade-matched bid", () => {
    // the owned copy IS the item being traded: a mint copy flipping through
    // the Mint SKU is grade-matched by construction, so the signal stays high
    const signals = computeSignals(
      inputOf({
        guaranteedGrade: "mint",
        bids: [voucher(218, "cib", { grade: "mint" })],
        referenceByCondition: { cib: ref(100, 8) },
      }),
      cfg,
    );
    const flip = signals.find((s) => s.type === "FLIP");
    expect(flip?.confidence).toBe("high");
    expect(flip?.caveats).toEqual([]);
  });

  it("a Mint-SKU store price compared pairwise against an ungraded listing is potential", () => {
    const signals = computeSignals(
      inputOf({
        storeOffers: [store(60, "cib", { grade: "mint" })],
        listings: [listing(38, "cib", "OOT boxed complete", "https://x/itm/38")],
      }),
      cfg,
    );
    const under = signals.find((s) => s.type === "UNDERPRICED");
    expect(under?.confidence).toBe("potential");
    expect(under?.caveats).toEqual([
      "store price is for a mint copy — compared side's grade unverified",
    ]);
  });

  it("INSUFFICIENT_DATA carries neither confidence nor caveats", () => {
    const signals = computeSignals(
      inputOf({
        storeOffers: [store(50, "cib")],
        referenceByCondition: { cib: ref(30, 3) },
      }),
      cfg,
    );
    expect(signals[0].type).toBe("INSUFFICIENT_DATA");
    expect(signals[0].confidence).toBeUndefined();
    expect(signals[0].caveats).toBeUndefined();
  });
});

describe("adaptivity: a future source lights up via kindRoles alone", () => {
  // A synthetic source that does not exist anywhere in the engine: it only
  // declares what its kinds mean. All three opportunity rules must fire with
  // zero signal-code changes.
  const RETRO_ES = "retro_es" as SourceId;
  const extendedSources: Record<string, SourceInfo> = {
    // PLUGIN_SOURCES resolves this block's "ebay_uk" points alongside RETRO_ES
    ...PLUGIN_SOURCES,
    [RETRO_ES]: {
      label: "RetroMadrid",
      family: "retro_es",
      familyLabel: "RetroMadrid",
      kind: "live",
      country: "ES",
      defaultRegion: "PAL",
      expectedCurrencies: ["EUR"],
      reach: "local",
      kindRoles: { sell: "buy_store", cash: "bid", active_listing: "buy_listing" },
    },
  };

  it("fires OVERPRICED_STORE, FLIP and UNDERPRICED for the synthetic source", () => {
    const points: PricePointDto[] = [
      // cib: RetroMadrid sells 45 vs eBay reference 30x8 -> overpriced (45 > 39)
      gbpPoint(45, { source: RETRO_ES, kind: "sell", condition: "cib" }),
      gbpPoint(30, { source: "ebay_uk", kind: "active_median", condition: "cib", sampleSize: 8 }),
      // loose: RetroMadrid pays cash 40 vs eBay reference 30x8 -> flip (40 > 34.5)
      gbpPoint(40, { source: RETRO_ES, kind: "cash", condition: "loose" }),
      gbpPoint(30, { source: "ebay_uk", kind: "active_median", condition: "loose", sampleSize: 8 }),
      // new: RetroMadrid sells 12 vs eBay reference 20x8 -> underpriced (12 < 14)
      gbpPoint(12, { source: RETRO_ES, kind: "sell", condition: "new" }),
      gbpPoint(20, { source: "ebay_uk", kind: "active_median", condition: "new", sampleSize: 8 }),
    ];
    const inputs = buildSignalInputs(points, extendedSources);
    expect(inputs).toHaveLength(1);
    const signals = computeSignals(inputs[0], cfg, extendedSources);

    const over = signals.find((s) => s.type === "OVERPRICED_STORE");
    expect(over?.source).toBe(RETRO_ES);
    expect(over?.reasoning).toContain("RetroMadrid");

    const flip = signals.find((s) => s.type === "FLIP");
    expect(flip?.sellSource).toBe(RETRO_ES);
    expect(flip?.buySource).toBe("ebay_uk");
    expect(flip?.reasoning).toContain("cash");

    const under = signals.find((s) => s.type === "UNDERPRICED");
    expect(under?.source).toBe(RETRO_ES);
    expect(under?.reasoning).toContain("£12");
  });

  it("a source declaring BOTH bid and listing roles never flips into itself", () => {
    // "buy at X, sell to X" is not an opportunity: when the acquisition proxy
    // for a bid comes from the bid's own source, the flip is skipped outright
    // (mirror of the pairwise same-source guard). The comparison still counts
    // as resolved, so no INSUFFICIENT_DATA either.
    const selfPoints: PricePointDto[] = [
      gbpPoint(40, { source: RETRO_ES, kind: "cash", condition: "cib" }),
      gbpPoint(20, { source: RETRO_ES, kind: "active_listing", condition: "cib", listingTitle: "OOT completo" }),
    ];
    const selfInputs = buildSignalInputs(selfPoints, extendedSources);
    expect(computeSignals(selfInputs[0], cfg, extendedSources)).toEqual([]);

    // control: the identical bid flips fine through ANOTHER source's listing
    const crossPoints: PricePointDto[] = [
      ...selfPoints,
      gbpPoint(19, { source: "ebay_uk", kind: "active_listing", condition: "cib", listingTitle: "OOT boxed" }),
    ];
    const crossInputs = buildSignalInputs(crossPoints, extendedSources);
    const flip = computeSignals(crossInputs[0], cfg, extendedSources).find((s) => s.type === "FLIP");
    expect(flip).toBeDefined();
    expect(flip?.buySource).toBe("ebay_uk");
    expect(flip?.sellSource).toBe(RETRO_ES);
  });

  it("the synthetic source's own listings join the pairwise rule against CeX", () => {
    const points: PricePointDto[] = [
      gbpPoint(60, { source: "cex", kind: "sell", condition: "cib" }),
      gbpPoint(38, { source: RETRO_ES, kind: "active_listing", condition: "cib", listingTitle: "OOT completo", url: "https://retro.example/38" }),
    ];
    const inputs = buildSignalInputs(points, extendedSources);
    const signals = computeSignals(inputs[0], cfg, extendedSources);
    const under = signals.find((s) => s.type === "UNDERPRICED");
    expect(under).toBeDefined();
    expect(under?.source).toBe(RETRO_ES);
    expect(under?.url).toBe("https://retro.example/38");
    expect(under?.reasoning).toContain("cheaper than buying at CeX");
  });
});

describe("computeSignals — rule 5 PROFIT: an owned copy's sell-side reading beats what was paid", () => {
  // The acquisition context only the collection route supplies: the paid
  // price in both spaces (suite-wide rate-1 convention unless stated) and the
  // completeness tier the copy IS. Default factor 1.15: paid £18 needs a net
  // reading above £20.70.
  const paid = (n: number, over: Partial<AcquiredCopy> = {}): AcquiredCopy =>
    ({ usd: n, original: n, currency: "GBP", condition: "cib", ...over });
  const profits = (signals: ReturnType<typeof computeSignals>) => signals.filter((s) => s.type === "PROFIT");

  it("a bid above paid * factor fires PROFIT: sellSource, cents gain, high confidence, £ vs £ evidence", () => {
    const signals = computeSignals(
      inputOf({ bids: [voucher(44, "cib")], acquired: paid(18) }),
      cfg,
    );
    const profit = profits(signals);
    expect(profit).toHaveLength(1);
    expect(profit[0].sellSource).toBe("cex");
    // the instrument the gain is paid in travels with the signal: a voucher
    // gain is store credit, and a UI must be able to say so without parsing
    // the reasoning
    expect(profit[0].sellKind).toBe("voucher");
    expect(profit[0].gainUsd).toBe(26);
    expect(profit[0].confidence).toBe("high");
    expect(profit[0].caveats).toEqual([]);
    expect(profit[0].reasoning).toBe("PAL/cib: CeX UK pays voucher £44 vs paid £18 — trade in at CeX UK");
    // a bid is not a listing: no url; and it is not a flip: no buySource/source
    expect(profit[0].url).toBeUndefined();
    expect(profit[0].buySource).toBeUndefined();
    expect(profit[0].source).toBeUndefined();
    // Flipped under ruling R3 (2026-09-02): this used to pin "a fired
    // signal is never insufficient data". PROFIT compares the copy with its
    // paid price, not with the market, so it is no proof that the bid's own
    // market comparison could run — and here it could not (no reference,
    // no listing): INSUFFICIENT_DATA rides alongside
    expect(signals.map((s) => s.type)).toEqual(["PROFIT", "INSUFFICIENT_DATA"]);
  });

  it("R3: a bid PROFIT with no reference coexists with INSUFFICIENT_DATA — PROFIT is not a market comparison", () => {
    const signals = computeSignals(
      inputOf({ bids: [voucher(44, "cib"), voucher(20, "cib", { kind: "cash" })], acquired: paid(18) }),
      cfg,
    );
    expect(signals.map((s) => s.type)).toEqual(["PROFIT", "INSUFFICIENT_DATA"]);
    // the insufficiency is about the missing market, not about any source
    const insufficient = signals.find((s) => s.type === "INSUFFICIENT_DATA");
    expect(insufficient?.reasoning).toContain("not enough reference listings");
    expect(insufficient?.confidence).toBeUndefined();
  });

  it("R3: PROFIT next to a resolved FLIP carries no INSUFFICIENT_DATA — a market signal fired", () => {
    const viaReference = computeSignals(
      inputOf({ bids: [voucher(44, "cib")], referenceByCondition: { cib: ref(32, 11) }, acquired: paid(18) }),
      cfg,
    );
    expect(viaReference.map((s) => s.type)).toEqual(["FLIP", "PROFIT", "PROFIT"]);
    // ...and a flip resolved through the listing proxy counts just the same
    const viaListing = computeSignals(
      inputOf({ bids: [voucher(44, "cib")], listings: [listing(20, "cib", "OOT boxed cheap", null)], acquired: paid(18) }),
      cfg,
    );
    expect(viaListing.map((s) => s.type)).toEqual(["FLIP", "PROFIT"]);
  });

  it("R3: a PROFIT from the reference alone wanted no comparison — no INSUFFICIENT_DATA either", () => {
    const signals = computeSignals(
      inputOf({ referenceByCondition: { cib: ref(32, 11) }, acquired: paid(18) }),
      cfg,
    );
    expect(signals.map((s) => s.type)).toEqual(["PROFIT"]);
  });

  it("a reference above paid * factor AFTER FEES fires a potential PROFIT with the fee caveat and the netted figure", () => {
    // eBay UK sellFeeRate 0.13: £32 nets ≈£27.84, above the £20.70 bar
    const signals = computeSignals(
      inputOf({ referenceByCondition: { cib: ref(32, 11) }, acquired: paid(18) }),
      cfg,
    );
    const profit = profits(signals);
    expect(profit).toHaveLength(1);
    expect(profit[0].sellSource).toBe("ebay_uk");
    // a reference reading carries the reference kind: not a payout instrument
    expect(profit[0].sellKind).toBe("active_median");
    expect(profit[0].gainUsd).toBe(9.84);
    expect(profit[0].reasoning).toBe(
      "PAL/cib: eBay UK median (active) £32 (11 listings) → ≈£27.84 after fees vs paid £18 — sell on eBay UK",
    );
    // a listing price is never a sale: always potential, always this caveat —
    // the ONE shared constant the web reads it back through (a reword there
    // must reach both sides at once), pinned to its exact wording here
    expect(profit[0].confidence).toBe("potential");
    expect(profit[0].caveats).toEqual([PROFIT_FEE_CAVEAT]);
    expect(PROFIT_FEE_CAVEAT).toBe("listing price, not a sale; fees estimated");
    expect(profit[0].url).toBeUndefined();
  });

  it("describes a reference in the words its source declared", () => {
    // eBay declares "eBay UK median (active)". The engine printed
    // "eBay UK active median" — its own words for a kind the source had
    // already named.
    const signals = computeSignals(
      inputOf({ referenceByCondition: { cib: ref(32, 11) }, acquired: paid(18) }),
      cfg,
      PLUGIN_SOURCES,
    );
    expect(signals.find((s) => s.type === "PROFIT")?.reasoning).toContain("eBay UK median (active) £32 (11 listings)");
  });

  it("nets the fee before the threshold: a gross reading over the bar that nets under it stays silent", () => {
    // £23 gross would clear £20.70, but 23 * 0.87 = £20.01 does not
    const signals = computeSignals(
      inputOf({ referenceByCondition: { cib: ref(23, 11) }, acquired: paid(18) }),
      cfg,
    );
    expect(profits(signals)).toHaveLength(0);
  });

  it("does NOT fire at exactly paid * factor, nor below it", () => {
    const atThreshold = computeSignals(
      // voucher £20.70 = 18 * 1.15 exactly; the £23 reference nets £20.01
      inputOf({ bids: [voucher(20.7, "cib")], referenceByCondition: { cib: ref(23, 11) }, acquired: paid(18) }),
      cfg,
    );
    expect(atThreshold).toEqual([]);
    const below = computeSignals(inputOf({ bids: [voucher(15, "cib")], acquired: paid(18) }), cfg);
    expect(profits(below)).toHaveLength(0);
  });

  it("never fires without an acquisition context, and never for a paid price of zero", () => {
    // the same data flips (44 > 32 * 1.15) but nothing was paid: no PROFIT
    const noPaid = computeSignals(
      inputOf({ bids: [voucher(44, "cib")], referenceByCondition: { cib: ref(32, 11) } }),
      cfg,
    );
    expect(noPaid.some((s) => s.type === "FLIP")).toBe(true);
    expect(profits(noPaid)).toHaveLength(0);
    // a £0 acquisition (gift recorded as free) has nothing to beat: silence, not infinite profit
    const paidZero = computeSignals(inputOf({ bids: [voucher(44, "cib")], acquired: paid(0) }), cfg);
    expect(profits(paidZero)).toHaveLength(0);
  });

  it("R4: voucher and cash both qualifying emit TWO PROFITs — one per (source, kind), each with its own instrument and gain", () => {
    // Flipped under ruling R4 ("ideally separate them", 2026-09-02): this
    // used to pin ONE PROFIT per source (the best net), which let a voucher
    // gain (store credit) hide the cash gain. The instruments are separate
    // readings now, in input order (voucher/cash as stored).
    const signals = computeSignals(
      inputOf({ bids: [voucher(48, "cib"), voucher(34, "cib", { kind: "cash" })], acquired: paid(18) }),
      cfg,
    );
    const profit = profits(signals);
    expect(profit.map((p) => [p.sellSource, p.sellKind, p.gainUsd, p.confidence])).toEqual([
      ["cex", "voucher", 30, "high"],
      ["cex", "cash", 16, "high"],
    ]);
    expect(profit[0].reasoning).toBe("PAL/cib: CeX UK pays voucher £48 vs paid £18 — trade in at CeX UK");
    expect(profit[1].reasoning).toBe("PAL/cib: CeX UK pays cash £34 vs paid £18 — trade in at CeX UK");
    // stored order is honoured, not a voucher-first preference
    const cashFirst = profits(
      computeSignals(
        inputOf({ bids: [voucher(34, "cib", { kind: "cash" }), voucher(48, "cib")], acquired: paid(18) }),
        cfg,
      ),
    );
    expect(cashFirst.map((p) => p.sellKind)).toEqual(["cash", "voucher"]);
  });

  it("R4: only the instrument that clears the bar fires — one PROFIT when the cash bid stays under paid * factor", () => {
    const signals = computeSignals(
      inputOf({ bids: [voucher(44, "cib"), voucher(15, "cib", { kind: "cash" })], acquired: paid(18) }),
      cfg,
    );
    const profit = profits(signals);
    expect(profit).toHaveLength(1);
    expect(profit[0]).toMatchObject({ sellSource: "cex", sellKind: "voucher", gainUsd: 26 });
  });

  it("R4: reference readings are unchanged — one per source, after the bids", () => {
    const signals = computeSignals(
      inputOf({
        bids: [voucher(48, "cib"), voucher(34, "cib", { kind: "cash" })],
        referenceByCondition: { cib: ref(32, 11) },
        acquired: paid(18),
      }),
      cfg,
    );
    expect(profits(signals).map((p) => [p.sellSource, p.sellKind, p.gainUsd])).toEqual([
      ["cex", "voucher", 30],
      ["cex", "cash", 16],
      ["ebay_uk", "active_median", 9.84],
    ]);
  });

  it("a bid AND a reference from different sources both qualifying emit one PROFIT each", () => {
    // Title reworded after ruling R4 (2026-09-02): the old title claimed
    // "one PROFIT per source", the per-source dedupe R4 replaced with one
    // per (source, kind). The assertion was always about two instruments
    // from two sources and is unchanged.
    const signals = computeSignals(
      inputOf({ bids: [voucher(44, "cib")], referenceByCondition: { cib: ref(32, 11) }, acquired: paid(18) }),
      cfg,
    );
    const profit = profits(signals);
    expect(profit.map((p) => [p.sellSource, p.gainUsd, p.confidence])).toEqual([
      ["cex", 26, "high"],
      ["ebay_uk", 9.84, "potential"],
    ]);
    // the FLIP the same data carries is untouched
    expect(signals.some((s) => s.type === "FLIP")).toBe(true);
  });

  it("a reference reached via a fallback rung is potential with the rung caveat on top of the fee caveat", () => {
    const signals = computeSignals(
      inputOf({
        referenceByCondition: { unknown: ref(32, 11, { condition: "unknown" }) },
        acquired: paid(18),
      }),
      cfg,
    );
    const profit = profits(signals);
    expect(profit).toHaveLength(1);
    expect(profit[0].confidence).toBe("potential");
    expect(profit[0].caveats).toEqual([
      "listing price, not a sale; fees estimated",
      "market median from listings with undeclared condition",
    ]);
    expect(profit[0].reasoning).toContain("(11 listings, undeclared condition)");
  });

  it("reads the reference for the copy's OWN condition only, never a richer neighbouring tier", () => {
    const signals = computeSignals(
      inputOf({
        referenceByCondition: { cib: ref(32, 11), loose: ref(100, 20, { condition: "loose" }) },
        acquired: paid(18),
      }),
      cfg,
    );
    const profit = profits(signals);
    expect(profit).toHaveLength(1);
    expect(profit[0].reasoning).toContain("£32");
    expect(profit[0].gainUsd).toBe(9.84);
  });

  it("ignores a bid for another completeness tier: a loose payout is not this cib copy's reading", () => {
    const signals = computeSignals(inputOf({ bids: [voucher(44, "loose")], acquired: paid(18) }), cfg);
    expect(profits(signals)).toHaveLength(0);
  });

  it("quotes the verbatim originals when the reading and the paid price share a currency, never the USD twins", () => {
    // rate 1.25 on both sides: the £ originals are the evidence, the math runs on USD
    const signals = computeSignals(
      inputOf({
        bids: [voucher(0, "cib", { price: { usd: 55, original: 44, currency: "GBP" } })],
        acquired: { usd: 22.5, original: 18, currency: "GBP", condition: "cib" },
      }),
      cfg,
    );
    const profit = profits(signals);
    expect(profit).toHaveLength(1);
    expect(profit[0].reasoning).toContain("voucher £44 vs paid £18");
    expect(profit[0].reasoning).not.toContain("$");
    expect(profit[0].gainUsd).toBe(32.5);
  });

  it("quotes both sides in USD when the copy was paid in another currency (EUR paid vs GBP bid)", () => {
    const signals = computeSignals(
      inputOf({
        region: "NTSC_J",
        bids: [voucher(0, "cib", { price: { usd: 55, original: 44, currency: "GBP" } })],
        referenceByCondition: { cib: ref(0, 11, { price: { usd: 40, original: 32, currency: "GBP" } }) },
        acquired: { usd: 20, original: 18, currency: "EUR", condition: "cib" },
      }),
      cfg,
    );
    const profit = profits(signals);
    expect(profit.map((p) => p.sellSource)).toEqual(["cex", "ebay_uk"]);
    expect(profit[0].reasoning).toBe("NTSC_J/cib: CeX UK pays voucher $55 vs paid $20 — trade in at CeX UK");
    expect(profit[0].gainUsd).toBe(35);
    // the netted figure is computed in the quoted space too: 40 * 0.87 = 34.8
    expect(profit[1].reasoning).toBe(
      "NTSC_J/cib: eBay UK median (active) $40 (11 listings) → ≈$34.80 after fees vs paid $20 — sell on eBay UK",
    );
    expect(profit[1].gainUsd).toBe(14.8);
    for (const p of profit) {
      expect(p.reasoning).not.toContain("£");
      expect(p.reasoning).not.toContain("€");
    }
  });

  it("a grade-specific bid against a copy without that grade guarantee is potential; guaranteedGrade lifts it", () => {
    const mintBid = voucher(218, "cib", { grade: "mint" });
    const unguaranteed = computeSignals(inputOf({ bids: [mintBid], acquired: paid(100) }), cfg);
    expect(profits(unguaranteed)[0].confidence).toBe("potential");
    expect(profits(unguaranteed)[0].caveats).toEqual(["requires a mint copy — listing grades unverified"]);
    // the collection route's context: the owned copy IS mint
    const guaranteed = computeSignals(
      inputOf({ guaranteedGrade: "mint", bids: [mintBid], acquired: paid(100) }),
      cfg,
    );
    expect(profits(guaranteed)[0].confidence).toBe("high");
    expect(profits(guaranteed)[0].caveats).toEqual([]);
  });

  it("a bid compared inside the region-'unknown' input carries the bid's region caveat", () => {
    const signals = computeSignals(
      inputOf({ region: "unknown", bids: [voucher(44, "cib")], acquired: paid(18) }),
      cfg,
    );
    expect(profits(signals)[0].confidence).toBe("potential");
    expect(profits(signals)[0].caveats).toEqual(["bid region not declared"]);
  });

  it("a copy of undeclared condition reads its own undeclared-condition data as exact, with the dimension caveats", () => {
    const signals = computeSignals(
      inputOf({
        bids: [voucher(44, "unknown")],
        referenceByCondition: { unknown: ref(32, 11, { condition: "unknown" }) },
        acquired: paid(18, { condition: "unknown" }),
      }),
      cfg,
    );
    const profit = profits(signals);
    expect(profit.map((p) => p.sellSource)).toEqual(["cex", "ebay_uk"]);
    expect(profit[0].reasoning).toContain("PAL/unknown:");
    expect(profit[0].caveats).toEqual(["bid condition not declared"]);
    // no rung was descended (the copy's own tier IS unknown), so no rung caveat
    expect(profit[1].caveats).toEqual([
      "listing price, not a sale; fees estimated",
      "copy condition not declared",
    ]);
  });

  it("never raises the unresolved flag: a paid price with nothing usable to compare stays silent", () => {
    // a thin reference (under minSample) and no bid or store: no comparison
    // was wanted, so neither PROFIT nor INSUFFICIENT_DATA may appear
    const thin = computeSignals(inputOf({ referenceByCondition: { cib: ref(32, 2) }, acquired: paid(18) }), cfg);
    expect(thin).toEqual([]);
    const empty = computeSignals(inputOf({ acquired: paid(18) }), cfg);
    expect(empty).toEqual([]);
  });

  it("adaptivity: a future source declaring bid + reference roles and a sellFeeRate fires with zero engine changes", () => {
    const RETRO_ES = "retro_es" as SourceId;
    const extendedSources: Record<string, SourceInfo> = {
      [RETRO_ES]: {
        label: "RetroMadrid",
        family: "retro_es",
        familyLabel: "RetroMadrid",
        kind: "live",
        country: "ES",
        defaultRegion: "PAL",
        expectedCurrencies: ["EUR"],
        reach: "local",
        kindRoles: { cash: "bid", active_median: "reference" },
        sellFeeRate: 0.1,
      },
    };
    const points: PricePointDto[] = [
      gbpPoint(30, { source: RETRO_ES, kind: "cash", condition: "cib" }),
      gbpPoint(40, { source: RETRO_ES, kind: "active_median", condition: "cib", sampleSize: 8 }),
    ];
    const [input] = buildSignalInputs(points, extendedSources);
    const signals = computeSignals({ ...input, acquired: paid(18) }, cfg, extendedSources);
    const profit = profits(signals);
    // one per (source, kind) since ruling R4 (this used to pin one per
    // source): the gross cash bid (30) and the netted reference (40 * 0.9 =
    // 36) each clear the bar, bid first, then the reference
    expect(profit.map((p) => [p.sellSource, p.sellKind, p.gainUsd, p.confidence])).toEqual([
      [RETRO_ES, "cash", 12, "high"],
      [RETRO_ES, "active_median", 18, "potential"],
    ]);
    expect(profit[1].reasoning).toBe(
      "PAL/cib: RetroMadrid median (active) £40 (8 listings) → ≈£36 after fees vs paid £18 — sell on RetroMadrid",
    );
    // the bid never flips into its own source's reference (existing guard)
    expect(signals.some((s) => s.type === "FLIP")).toBe(false);
  });

  it("a reference source without a sellFeeRate is read gross: no after-fees figure, still never a sale", () => {
    const GROSS_REF = "gross_ref" as SourceId;
    const extendedSources: Record<string, SourceInfo> = {
      [GROSS_REF]: {
        label: "FeeFree",
        family: "gross_ref",
        familyLabel: "FeeFree",
        kind: "live",
        country: "US",
        defaultRegion: null,
        expectedCurrencies: ["USD"],
        reach: "global",
        kindRoles: { active_median: "reference" },
      },
    };
    const signals = computeSignals(
      inputOf({
        referenceByCondition: { cib: ref(32, 11, { source: GROSS_REF }) },
        acquired: paid(18),
      }),
      cfg,
      extendedSources,
    );
    const profit = profits(signals);
    expect(profit).toHaveLength(1);
    expect(profit[0].gainUsd).toBe(14);
    expect(profit[0].reasoning).toBe("PAL/cib: FeeFree median (active) £32 (11 listings) vs paid £18 — sell on FeeFree");
    expect(profit[0].caveats).toEqual(["listing price, not a sale; fees estimated"]);
  });
});

describe("computeSignals — every signal carries the amount it is about", () => {
  // packages/shared/src/index.ts documents one meaning per type. Each case
  // below pins it at the site that emits it, because "the price" is a
  // different quantity in every rule and a plausible wrong one is in scope at
  // each site: the reference median beside the listing, the bid beside the
  // acquisition proxy, the gross reading beside the net.
  const paid = (n: number): AcquiredCopy => ({ usd: n, original: n, currency: "GBP", condition: "cib" });

  it("OVERPRICED_STORE carries the store's posted price, not the reference it lost to", () => {
    // 45 > 30 * 1.3
    const signals = computeSignals(
      inputOf({ storeOffers: [store(45, "cib")], referenceByCondition: { cib: ref(30, 8) } }),
      cfg,
    );
    const over = signals.find((s) => s.type === "OVERPRICED_STORE");
    expect(over?.price).toEqual(gbp(45));
  });

  it("FLIP carries the ACQUISITION price — what you would spend — not the bid you would take", () => {
    // proxy = the reference (32), bid 44 > 32 * 1.15
    const viaReference = computeSignals(
      inputOf({ bids: [voucher(44, "cib")], referenceByCondition: { cib: ref(32, 11) } }),
      cfg,
    );
    expect(viaReference.find((s) => s.type === "FLIP")?.price).toEqual(gbp(32));
    // and when a cheaper listing wins the proxy, the flip's price follows it
    const viaListing = computeSignals(
      inputOf({ bids: [voucher(44, "cib")], listings: [listing(20, "cib", "OOT boxed cheap", null)] }),
      cfg,
    );
    expect(viaListing.find((s) => s.type === "FLIP")?.price).toEqual(gbp(20));
  });

  it("UNDERPRICED vs the reference carries the LISTING's price", () => {
    // 19 < 30 * 0.7
    const signals = computeSignals(
      inputOf({
        listings: [listing(19, "loose", "OOT cart only", "https://ebay/1")],
        referenceByCondition: { loose: ref(30, 8, { condition: "loose" }) },
      }),
      cfg,
    );
    const under = signals.find((s) => s.type === "UNDERPRICED");
    expect(under?.price).toEqual(gbp(19));
  });

  it("UNDERPRICED for a store below market carries the STORE's price", () => {
    // 19 < 30 * 0.7, and 19 is nowhere near 30 * 1.3, so only this rule fires
    const signals = computeSignals(
      inputOf({ storeOffers: [store(19, "cib")], referenceByCondition: { cib: ref(30, 8) } }),
      cfg,
    );
    const under = signals.find((s) => s.type === "UNDERPRICED");
    expect(under?.price).toEqual(gbp(19));
  });

  it("a store is not 'below market' while a same-condition listing is cheaper", () => {
    // Final Fantasy Tactics Advance, 2026-09-28: a 3-listing PAL/cib median of
    // £99.99 called CeX's £42 a bargain beside a £31.90 complete copy on eBay
    const ffta = { storeOffers: [store(42, "cib")], referenceByCondition: { cib: ref(99.99, 3) } };
    const loose3 = { ...cfg, minSample: 3 };
    expect(computeSignals(inputOf(ffta), loose3).some((s) => s.type === "UNDERPRICED" && s.source === "cex")).toBe(true);
    const withListing = computeSignals(
      inputOf({ ...ffta, listings: [listing(31.9, "cib", "FFTA PAL CIB Complete", "https://ebay/ffta")] }),
      loose3,
    );
    expect(withListing.some((s) => s.type === "UNDERPRICED" && s.source === "cex")).toBe(false);
    // the listing itself is still the bargain it is
    expect(withListing.some((s) => s.type === "UNDERPRICED" && s.source === "ebay_uk")).toBe(true);

    // a cheaper listing of ANOTHER condition, or an ungraded one against a mint SKU, does not count
    const other = computeSignals(
      inputOf({ ...ffta, listings: [listing(20, "loose", "cart only", null)] }),
      loose3,
    );
    expect(other.some((s) => s.type === "UNDERPRICED" && s.source === "cex")).toBe(true);
    const mint = computeSignals(
      inputOf({ ...ffta, storeOffers: [store(42, "cib", { grade: "mint" })], listings: [listing(31.9, "cib", "CIB", null)] }),
      loose3,
    );
    expect(mint.some((s) => s.type === "UNDERPRICED" && s.source === "cex")).toBe(true);
  });

  it("UNDERPRICED pairwise carries the LISTING's price, not the store price it undercut", () => {
    // no reference at all: the pairwise rule is the only one that can fire.
    // 20 < 45 * 0.85
    const signals = computeSignals(
      inputOf({
        listings: [listing(20, "cib", "OOT boxed cheap", "https://ebay/2")],
        storeOffers: [store(45, "cib")],
      }),
      cfg,
    );
    const under = signals.find((s) => s.type === "UNDERPRICED");
    expect(under?.reasoning).toContain("cheaper than buying at");
    expect(under?.price).toEqual(gbp(20));
  });

  it("PROFIT carries the NET reading, after fees — never the gross", () => {
    // eBay UK sellFeeRate is 0.13 (packages/shared/src/index.ts:391), so the
    // £32 median nets 32 * 0.87 = 27.84 exactly in IEEE-754 doubles (checked:
    // 32 * (1 - 0.13) === 27.84 is true), and the gain rounds to 9.84. This
    // distinction is the whole of the spec's Decision 4: the game view used to
    // rebuild this number by adding paid + gain.
    const signals = computeSignals(
      inputOf({ referenceByCondition: { cib: ref(32, 11) }, acquired: paid(18) }),
      cfg,
    );
    const profit = signals.find((s) => s.type === "PROFIT");
    expect(profit?.price).toEqual({ usd: 27.84, original: 27.84, currency: "GBP" });
    expect(profit?.gainUsd).toBe(9.84);
    // the gross is what a wrong implementation would emit here
    expect(profit?.price?.usd).not.toBe(32);
  });

  it("PROFIT from a bid carries the bid itself — a payout is already net", () => {
    const signals = computeSignals(
      inputOf({ bids: [voucher(44, "cib")], acquired: paid(18) }),
      cfg,
    );
    const profit = signals.find((s) => s.type === "PROFIT");
    expect(profit?.price).toEqual(gbp(44));
  });

  it("INSUFFICIENT_DATA carries no price: it has none by construction", () => {
    const signals = computeSignals(inputOf({ storeOffers: [store(45, "cib")] }), cfg);
    const insufficient = signals.find((s) => s.type === "INSUFFICIENT_DATA");
    expect(insufficient).toBeDefined();
    expect(insufficient?.price).toBeUndefined();
    // not "absent because undefined was assigned": the key is never set
    expect(Object.keys(insufficient as object)).not.toContain("price");
  });

  it("leaves no emission site behind: every signal of an input that fires four rules carries a price", () => {
    // The sweep that catches a missed site. OVERPRICED_STORE (45 > 30*1.3),
    // UNDERPRICED (19 < 30*0.7), FLIP (44 > min(30,19)*1.15) and two PROFITs
    // (the 44 voucher and the 30 median netted to 26.10) all fire at once.
    const signals = computeSignals(
      inputOf({
        storeOffers: [store(45, "cib")],
        listings: [listing(19, "cib", "OOT boxed cheap", "https://ebay/3")],
        bids: [voucher(44, "cib")],
        referenceByCondition: { cib: ref(30, 8) },
        acquired: paid(18),
      }),
      cfg,
    );
    expect(signals.length).toBeGreaterThanOrEqual(4);
    for (const s of signals) {
      expect(s.price, `${s.type}: ${s.reasoning}`).toBeDefined();
    }
  });
});

describe("configuration gates and edgePct", () => {
  // CeX voucher 62 against the cheapest eBay cib listing at 20: a FLIP, no reference involved
  const flipInput = () =>
    inputOf({ bids: [voucher(62, "cib")], listings: [listing(20, "cib", "OOT cib", "https://ebay/oot")] });

  it("a disabled type never fires, and INSUFFICIENT_DATA is not gated", () => {
    expect(computeSignals(flipInput(), cfg).some((s) => s.type === "FLIP")).toBe(true);
    const noFlip = { ...cfg, enabledTypes: cfg.enabledTypes.filter((t) => t !== "FLIP") };
    expect(computeSignals(flipInput(), noFlip).some((s) => s.type === "FLIP")).toBe(false);
    const nothing = { ...cfg, enabledTypes: [] };
    const starved = computeSignals(inputOf({ storeOffers: [store(45, "cib")] }), nothing);
    expect(starved.map((s) => s.type)).toEqual(["INSUFFICIENT_DATA"]);
  });

  it("an excluded source raises no signal but still anchors the reference", () => {
    // CeX at 19 under an eBay median of 30: UNDERPRICED @ cex
    const input = inputOf({ storeOffers: [store(19, "cib")], referenceByCondition: { cib: ref(30, 8) } });
    expect(computeSignals(input, cfg).some((s) => s.type === "UNDERPRICED" && s.source === "cex")).toBe(true);
    // excluding the reference's own source silences nothing on CeX: eBay still anchors
    const exclEbay = { ...cfg, excludedSources: ["ebay_uk"] };
    expect(computeSignals(input, exclEbay).some((s) => s.type === "UNDERPRICED" && s.source === "cex")).toBe(true);
    const exclCex = { ...cfg, excludedSources: ["cex"] };
    expect(computeSignals(input, exclCex).some((s) => s.source === "cex")).toBe(false);
    // a FLIP touching an excluded source on either side is dropped
    expect(computeSignals(flipInput(), { ...cfg, excludedSources: ["ebay_uk"] }).some((s) => s.type === "FLIP")).toBe(false);
  });

  it("minGain floors FLIP and PROFIT", () => {
    // gain 62 − 20 = 42
    expect(computeSignals(flipInput(), { ...cfg, minGainUsd: 42 }).some((s) => s.type === "FLIP")).toBe(true);
    expect(computeSignals(flipInput(), { ...cfg, minGainUsd: 43 }).some((s) => s.type === "FLIP")).toBe(false);
    // owned cib copy paid 10, CeX voucher 30: PROFIT gain 20
    const owned = inputOf({ bids: [voucher(30, "cib")], acquired: { ...gbp(10), condition: "cib" } });
    expect(computeSignals(owned, cfg).some((s) => s.type === "PROFIT")).toBe(true);
    expect(computeSignals(owned, { ...cfg, minGainUsd: 25 }).some((s) => s.type === "PROFIT")).toBe(false);
  });

  it("edgePct is the relative advantage, one decimal", () => {
    const under = computeSignals(
      inputOf({ storeOffers: [store(19, "cib")], referenceByCondition: { cib: ref(30, 8) } }),
      cfg,
    ).find((s) => s.type === "UNDERPRICED");
    expect(under?.edgePct).toBe(36.7); // 1 − 19/30
    const flip = computeSignals(flipInput(), cfg).find((s) => s.type === "FLIP");
    expect(flip?.edgePct).toBe(210); // 62/20 − 1
    const profit = computeSignals(
      inputOf({ bids: [voucher(30, "cib")], acquired: { ...gbp(10), condition: "cib" } }),
      cfg,
    ).find((s) => s.type === "PROFIT");
    expect(profit?.edgePct).toBe(200); // 30/10 − 1
    const pairwise = computeSignals(
      inputOf({ listings: [listing(20, "cib", "cheap", null)], storeOffers: [store(45, "cib")] }),
      cfg,
    ).find((s) => s.type === "UNDERPRICED" && s.source === "ebay_uk");
    expect(pairwise?.edgePct).toBe(55.6); // 1 − 20/45
  });
});

describe("buildSignalInputs with history", () => {
  it("attaches each region's history to its input, and none where there is none", () => {
    const pal = { ...emptyHistory("PAL"), lowest: { "ebay_uk|cib": { usd: 20, original: 20, currency: "GBP", daysCovered: 40 } } };
    const inputs = buildSignalInputs(
      [
        gbpPoint(45, { source: "cex", kind: "sell", region: "PAL" }),
        gbpPoint(40, { source: "cex", kind: "sell", region: "NTSC_J" }),
      ],
      PLUGIN_SOURCES,
      new Map([["PAL", pal]]),
    );
    expect(inputs.find((i) => i.region === "PAL")?.history).toBe(pal);
    expect(inputs.find((i) => i.region === "NTSC_J")?.history).toBeUndefined();
  });
});

describe("TARGET_HIT", () => {
  const target = (n: number, currency = "GBP", usd = n) => ({ usd, original: n, currency });
  // each watch's target travels with the condition it watches (null = any)
  const anyCondition = (t: SignalAmount) => [{ ...t, condition: null }];

  it("fires for a listing at or under the target, high and caveat-free, with the listing's link", () => {
    const signals = computeSignals(
      inputOf({ listings: [listing(18, "cib", "FFTA boxed", "https://ebay/ffta")], targets: anyCondition(target(18)) }),
      cfg,
    );
    const hit = signals.find((s) => s.type === "TARGET_HIT");
    expect(hit).toMatchObject({ source: "ebay_uk", url: "https://ebay/ffta", confidence: "high", caveats: [], price: gbp(18), edgePct: 0 });
    expect(hit?.reasoning).toBe('PAL/cib: "FFTA boxed" at £18 is at or under your target £18');
  });

  it("fires for a store offer too, and not above the target", () => {
    const hit = computeSignals(inputOf({ storeOffers: [store(15, "cib")], targets: anyCondition(target(20)) }), cfg).find((s) => s.type === "TARGET_HIT");
    expect(hit?.source).toBe("cex");
    expect(hit?.edgePct).toBe(25);
    expect(computeSignals(inputOf({ storeOffers: [store(21, "cib")], targets: anyCondition(target(20)) }), cfg).some((s) => s.type === "TARGET_HIT")).toBe(false);
  });

  it("TARGET_HIT compares USD when currencies differ", () => {
    // listing EUR 20 (USD 22) vs target GBP 18 (USD 23): under in USD although 20 > 18
    const eur = { ...listing(0, "cib", "EU copy", null), price: { usd: 22, original: 20, currency: "EUR" } };
    const hit = computeSignals(inputOf({ listings: [eur], targets: anyCondition(target(18, "GBP", 23)) }), cfg).find((s) => s.type === "TARGET_HIT");
    expect(hit).toBeDefined();
    expect(hit?.reasoning).toContain("$22 is at or under your target $23");
    // and the quoted amounts decide when the currency matches, whatever the USD twins say
    const drift = { ...listing(0, "cib", "same ccy", null), price: { usd: 30, original: 18, currency: "GBP" } };
    expect(computeSignals(inputOf({ listings: [drift], targets: anyCondition(target(18, "GBP", 20)) }), cfg).some((s) => s.type === "TARGET_HIT")).toBe(true);
  });

  it("only matches points of the condition the watch names", () => {
    const cibWatch = [{ ...target(30), condition: "cib" as const }];
    const signals = computeSignals(
      inputOf({ listings: [listing(12, "loose", "cart only", null), listing(28, "cib", "complete", null)], targets: cibWatch }),
      cfg,
    );
    const hits = signals.filter((s) => s.type === "TARGET_HIT");
    expect(hits.map((h) => h.price?.usd)).toEqual([28]);
  });

  it("applies the strictest target that admits a point's condition", () => {
    const targets = [{ ...target(30), condition: null }, { ...target(20), condition: "cib" as const }];
    const fires = (n: number) =>
      computeSignals(inputOf({ listings: [listing(n, "cib", "c", null)], targets }), cfg).some((s) => s.type === "TARGET_HIT");
    expect(fires(25)).toBe(false); // over the cib watch's 20, though under the any-watch's 30
    expect(fires(19)).toBe(true);
  });

  it("does not fire without a target or when switched off", () => {
    expect(computeSignals(inputOf({ listings: [listing(5, "cib", "x", null)] }), cfg).some((s) => s.type === "TARGET_HIT")).toBe(false);
    const off = { ...cfg, enabledTypes: cfg.enabledTypes.filter((t) => t !== "TARGET_HIT") };
    expect(computeSignals(inputOf({ listings: [listing(5, "cib", "x", null)], targets: anyCondition(target(10)) }), off).some((s) => s.type === "TARGET_HIT")).toBe(false);
  });
});

describe("PRICE_DROP", () => {
  const withPast = (over: Partial<SignalInput>, past: Partial<SignalInput>) =>
    inputOf({ ...over, history: { ...emptyHistory("PAL"), dropAgo: inputOf(past) } });

  it("fires when a store price fell by the threshold against the same box a week ago", () => {
    const signals = computeSignals(withPast({ storeOffers: [store(30, "cib")] }, { storeOffers: [store(42, "cib")] }), cfg);
    const drop = signals.find((s) => s.type === "PRICE_DROP");
    expect(drop).toMatchObject({ source: "cex", confidence: "high", price: gbp(30), edgePct: 28.6 });
    expect(drop?.reasoning).toBe("PAL/cib: CeX UK sells for £30, down from £42 7 days ago");
  });

  it("does not fire for a fall smaller than the threshold", () => {
    const signals = computeSignals(withPast({ storeOffers: [store(40, "cib")] }, { storeOffers: [store(42, "cib")] }), cfg);
    expect(signals.some((s) => s.type === "PRICE_DROP")).toBe(false);
  });

  it("fires for a market median only when both ends stand on enough listings", () => {
    const now = { referenceByCondition: { cib: ref(30, 8) } };
    expect(computeSignals(withPast(now, { referenceByCondition: { cib: ref(40, 8) } }), cfg).some((s) => s.type === "PRICE_DROP" && s.source === "ebay_uk")).toBe(true);
    expect(computeSignals(withPast(now, { referenceByCondition: { cib: ref(40, 2) } }), cfg).some((s) => s.type === "PRICE_DROP")).toBe(false);
  });

  it("never compares a different condition, and needs history", () => {
    expect(computeSignals(withPast({ storeOffers: [store(30, "cib")] }, { storeOffers: [store(42, "loose")] }), cfg).some((s) => s.type === "PRICE_DROP")).toBe(false);
    expect(computeSignals(inputOf({ storeOffers: [store(30, "cib")] }), cfg).some((s) => s.type === "PRICE_DROP")).toBe(false);
  });
});

describe("NEW_LOW", () => {
  type Low = { usd: number; daysCovered: number; original?: number | null; currency?: string };
  const withLowest = (over: Partial<SignalInput>, lowest: Record<string, Low>) =>
    inputOf({
      ...over,
      history: {
        ...emptyHistory("PAL"),
        lowest: Object.fromEntries(
          Object.entries(lowest).map(([k, v]) => [k, { original: v.usd, currency: "GBP", ...v }]),
        ),
      },
    });

  it("fires high when today's cheapest is under the 90-day low with a month of history", () => {
    const signals = computeSignals(
      withLowest({ listings: [listing(20, "cib", "cheap", "https://ebay/c"), listing(26, "cib", "dear", null)] }, { "ebay_uk|cib": { usd: 25, daysCovered: 45 } }),
      cfg,
    );
    const low = signals.filter((s) => s.type === "NEW_LOW");
    expect(low).toHaveLength(1);
    expect(low[0]).toMatchObject({ source: "ebay_uk", url: "https://ebay/c", confidence: "high", price: gbp(20), edgePct: 20 });
    expect(low[0].reasoning).toBe('PAL/cib: "cheap" at £20 is the lowest in 90 days (was £25)');
  });

  it("is potential with less than 30 days of history", () => {
    const low = computeSignals(withLowest({ storeOffers: [store(20, "cib")] }, { "cex|cib": { usd: 25, daysCovered: 10 } }), cfg)
      .find((s) => s.type === "NEW_LOW");
    expect(low?.confidence).toBe("potential");
    expect(low?.caveats).toEqual(["less than 30 days of history"]);
  });

  it("compares the quoted amount, so a weaker pound is not a new low", () => {
    // £25 then (USD 32) and £25 now (USD 30): the same price, cheaper in USD only
    const now = { ...store(0, "cib"), price: { usd: 30, original: 25, currency: "GBP" } };
    expect(computeSignals(withLowest({ storeOffers: [now] }, { "cex|cib": { usd: 32, original: 25, daysCovered: 60 } }), cfg).some((s) => s.type === "NEW_LOW")).toBe(false);
    // a history in mixed currencies falls back to USD
    expect(computeSignals(withLowest({ storeOffers: [now] }, { "cex|cib": { usd: 32, original: null, daysCovered: 60 } }), cfg).some((s) => s.type === "NEW_LOW")).toBe(true);
  });

  it("does not fire at an equal price or without history for that source and condition", () => {
    expect(computeSignals(withLowest({ storeOffers: [store(25, "cib")] }, { "cex|cib": { usd: 25, daysCovered: 60 } }), cfg).some((s) => s.type === "NEW_LOW")).toBe(false);
    expect(computeSignals(withLowest({ storeOffers: [store(20, "cib")] }, { "cex|loose": { usd: 25, daysCovered: 60 } }), cfg).some((s) => s.type === "NEW_LOW")).toBe(false);
  });
});

describe("PRICE_DROP in the quoted currency", () => {
  it("does not read an FX move on an unchanged £ price as a drop", () => {
    const now = { ...store(0, "cib"), price: { usd: 30, original: 40, currency: "GBP" } };
    const then = { ...store(0, "cib"), price: { usd: 40, original: 40, currency: "GBP" } };
    const input = inputOf({ storeOffers: [now], history: { ...emptyHistory("PAL"), dropAgo: inputOf({ storeOffers: [then] }) } });
    expect(computeSignals(input, cfg).some((s) => s.type === "PRICE_DROP")).toBe(false);
  });
});

describe("BACK_IN_STOCK", () => {
  const withAvailability = (over: Partial<SignalInput>, previousAvailability: Record<string, boolean>) =>
    inputOf({ ...over, history: { ...emptyHistory("PAL"), previousAvailability } });

  it("fires when a box out of stock in the previous batch is offered now", () => {
    const signals = computeSignals(withAvailability({ storeOffers: [store(42, "cib")] }, { "cex|cib|": false }), cfg);
    const back = signals.find((s) => s.type === "BACK_IN_STOCK");
    expect(back).toMatchObject({ source: "cex", confidence: "high", price: gbp(42) });
    expect(back?.edgePct).toBeUndefined();
    expect(back?.reasoning).toBe("PAL/cib: CeX UK has it back in stock at £42");
  });

  it("does not fire when it was already in stock, or with no previous batch", () => {
    expect(computeSignals(withAvailability({ storeOffers: [store(42, "cib")] }, { "cex|cib|": true }), cfg).some((s) => s.type === "BACK_IN_STOCK")).toBe(false);
    expect(computeSignals(withAvailability({ storeOffers: [store(42, "cib")] }, {}), cfg).some((s) => s.type === "BACK_IN_STOCK")).toBe(false);
  });

  it("keys the box by grade", () => {
    const mint = store(60, "cib", { grade: "mint" });
    expect(computeSignals(withAvailability({ storeOffers: [mint] }, { "cex|cib|": false }), cfg).some((s) => s.type === "BACK_IN_STOCK")).toBe(false);
    expect(computeSignals(withAvailability({ storeOffers: [mint] }, { "cex|cib|mint": false }), cfg).some((s) => s.type === "BACK_IN_STOCK")).toBe(true);
  });
});

describe("RISING", () => {
  const owned = (now: Partial<SignalInput>, then: Partial<SignalInput>, isOwned = true) =>
    inputOf({
      ...now,
      ...(isOwned ? { owned: { condition: "cib" as const } } : {}),
      history: { ...emptyHistory("PAL"), risingAgo: inputOf(then) },
    });

  it("fires when an owned copy's market reference rose by the threshold", () => {
    const signals = computeSignals(owned({ referenceByCondition: { cib: ref(40, 8) } }, { referenceByCondition: { cib: ref(30, 8) } }), cfg);
    const rising = signals.find((s) => s.type === "RISING");
    expect(rising).toMatchObject({ source: "ebay_uk", confidence: "high", price: gbp(40), edgePct: 33.3 });
    expect(rising?.reasoning).toBe("PAL/cib: eBay UK median (active) £40 (8 listings), up from £30 30 days ago");
  });

  it("does not fire under the threshold or for a copy that is not owned", () => {
    expect(computeSignals(owned({ referenceByCondition: { cib: ref(33, 8) } }, { referenceByCondition: { cib: ref(30, 8) } }), cfg).some((s) => s.type === "RISING")).toBe(false);
    expect(computeSignals(owned({ referenceByCondition: { cib: ref(40, 8) } }, { referenceByCondition: { cib: ref(30, 8) } }, false), cfg).some((s) => s.type === "RISING")).toBe(false);
  });

  it("is potential on a fallback rung, and never compares two different rungs", () => {
    // both ends only have an undeclared-condition median
    const fallback = owned(
      { referenceByCondition: { unknown: ref(40, 8, { condition: "unknown" }) } },
      { referenceByCondition: { unknown: ref(30, 8, { condition: "unknown" }) } },
    );
    expect(computeSignals(fallback, cfg).find((s) => s.type === "RISING")?.confidence).toBe("potential");
    // exact today, fallback a month ago: not the same rung
    const mixed = owned(
      { referenceByCondition: { cib: ref(40, 8) } },
      { referenceByCondition: { unknown: ref(30, 8, { condition: "unknown" }) } },
    );
    expect(computeSignals(mixed, cfg).some((s) => s.type === "RISING")).toBe(false);
  });
});

describe("INSUFFICIENT_DATA after the configuration gates", () => {
  // CeX sells at 45 with no reference at all: a comparison was wanted and could not run
  const starved = () => inputOf({ storeOffers: [store(45, "cib")], listings: [listing(10, "cib", "cheap", null)] });

  it("still says data is missing when the only market signal is switched off", () => {
    // the pairwise UNDERPRICED (10 < 45 × 0.85) is the only market signal; off, the note returns
    const off = { ...cfg, enabledTypes: cfg.enabledTypes.filter((t) => t !== "UNDERPRICED") };
    expect(computeSignals(starved(), off).map((s) => s.type)).toEqual(["INSUFFICIENT_DATA"]);
  });

  it("is not silenced by a TARGET_HIT or BACK_IN_STOCK, which prove nothing about the market", () => {
    const off = { ...cfg, enabledTypes: cfg.enabledTypes.filter((t) => t !== "UNDERPRICED") };
    const withTarget = { ...starved(), targets: [{ ...gbp(50), condition: null }] };
    const types = computeSignals(withTarget, off).map((s) => s.type);
    expect(types).toContain("TARGET_HIT");
    expect(types).toContain("INSUFFICIENT_DATA");
  });
});

describe("PRICE_DROP quotes the compared batch's real age", () => {
  it("says how many days old the earlier price is, not the setting", () => {
    const input = inputOf({
      storeOffers: [store(30, "cib")],
      history: { ...emptyHistory("PAL"), dropAgo: inputOf({ storeOffers: [store(42, "cib")] }), dropAgeDays: { cex: 23 } },
    });
    expect(computeSignals(input, cfg).find((s) => s.type === "PRICE_DROP")?.reasoning).toBe(
      "PAL/cib: CeX UK sells for £30, down from £42 23 days ago",
    );
  });
});
