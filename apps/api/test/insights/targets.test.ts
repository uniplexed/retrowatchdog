import { describe, expect, it } from "vitest";
import type { OwnedCopyDto, WatchlistItemDto } from "@retrowatchdog/shared";
import { targetAdvice } from "../../src/insights/targets.js";
import { quietAdvice } from "../../src/insights/quiet.js";
import { NOW, cfg, days, game, labels, seriesOf } from "./fixtures.js";

const gbp = (amount: number) => ({ amount, currency: "GBP" });
const watch = (over: Partial<WatchlistItemDto> = {}): WatchlistItemDto =>
  ({
    id: 4,
    game: game(3, "Mario Kart", "gba"),
    region: "PAL",
    condition: "loose",
    targetPriceOriginal: 25,
    targetCurrency: "GBP",
    targetPriceUsd: 31,
    signals: [],
    ...over,
  }) as WatchlistItemDto;

describe("targetAdvice", () => {
  it("raise_target when never met and the low is within 20%", () => {
    const s = seriesOf(3, { "PAL|loose": days(180, (ago) => ({ cheapestUsd: ago === 10 ? 35 : 40, cheapestSource: "ebay_uk", cheapestOriginal: gbp(ago === 10 ? 28 : 32) })) });
    const [r] = targetAdvice([watch()], s, cfg(), labels, NOW);
    expect(r).toMatchObject({ action: "raise_target", confidence: "potential", gainUsd: null, title: "Raise your Mario Kart target from £25" });
    expect(r.reason).toBe("Your £25 target was never met in 180 days; the low was £28");
  });

  it("no raise when the low is far from the target", () => {
    const s = seriesOf(3, { "PAL|loose": days(180, () => ({ cheapestUsd: 60, cheapestSource: "ebay_uk", cheapestOriginal: gbp(48) })) });
    expect(targetAdvice([watch()], s, cfg(), labels, NOW)).toEqual([]);
  });

  it("lower_target when under the target on more than half the days", () => {
    const s = seriesOf(3, { "PAL|loose": days(100, (ago) => ({ cheapestUsd: ago % 3 === 0 ? 40 : 25, cheapestSource: "ebay_uk", cheapestOriginal: gbp(ago % 3 === 0 ? 32 : 20) })) });
    const [r] = targetAdvice([watch()], s, cfg(), labels, NOW);
    expect(r).toMatchObject({ action: "lower_target", confidence: "potential", gainUsd: null });
    expect(r.reason).toBe("The price was under your £25 target on 66% of 100 days");
  });

  it("skips watches without a target", () => {
    const s = seriesOf(3, { "PAL|loose": days(180, () => ({ cheapestUsd: 40, cheapestSource: "ebay_uk", cheapestOriginal: gbp(32) })) });
    expect(targetAdvice([watch({ targetPriceUsd: null, targetPriceOriginal: null, targetCurrency: null })], s, cfg(), labels, NOW)).toEqual([]);
  });
});

describe("quietAdvice", () => {
  const copy = (over: Partial<OwnedCopyDto> = {}): OwnedCopyDto =>
    ({ id: 9, game: game(3, "Mario Kart", "gba"), region: "PAL", condition: "loose", status: "owned", valueFetchedAt: NOW.toISOString(), valueBasis: null, ...over }) as OwnedCopyDto;

  it("unwatch after quietDays without signal or a 5% move", () => {
    const s = seriesOf(3, { "PAL|loose": days(130, (ago) => ({ cheapestUsd: ago % 2 === 0 ? 40 : 41, cheapestSource: "ebay_uk" })) });
    const [r] = quietAdvice([watch()], [], s, new Map(), cfg(), NOW);
    expect(r).toMatchObject({ action: "unwatch", confidence: "potential", gainUsd: null, title: "Stop watching Mario Kart?" });
    expect(r.reason).toBe("No signal and no price move over 5% in 120 days");
  });

  it("no unwatch while signals were logged, or when the price moved", () => {
    const flat = seriesOf(3, { "PAL|loose": days(130, () => ({ cheapestUsd: 40, cheapestSource: "ebay_uk" })) });
    expect(quietAdvice([watch()], [], flat, new Map([[4, 2]]), cfg(), NOW)).toEqual([]);
    const moved = seriesOf(3, { "PAL|loose": days(130, (ago) => ({ cheapestUsd: ago === 60 ? 30 : 40, cheapestSource: "ebay_uk" })) });
    expect(quietAdvice([watch()], [], moved, new Map(), cfg(), NOW)).toEqual([]);
  });

  it("no unwatch before there are quietDays of history", () => {
    const short = seriesOf(3, { "PAL|loose": days(20, () => ({ cheapestUsd: 40, cheapestSource: "ebay_uk" })) });
    expect(quietAdvice([watch()], [], short, new Map(), cfg(), NOW)).toEqual([]);
  });

  it("review_copy when no source priced it for quietDays", () => {
    const old = new Date(NOW.getTime() - 200 * 86_400_000).toISOString();
    const [r] = quietAdvice([], [copy({ valueFetchedAt: old })], new Map(), new Map(), cfg(), NOW);
    expect(r).toMatchObject({ action: "review_copy", confidence: "potential", gainUsd: null });
    expect(r.reason).toBe("No price from any source in 120 days");
  });

  it("review_copy names a copy no source has ever priced", () => {
    const [r] = quietAdvice([], [copy({ valueFetchedAt: null })], new Map(), new Map(), cfg(), NOW);
    expect(r?.reason).toBe("No source has a price for this copy");
  });

  it("leaves a copy valued through a fallback alone: that is how most listings read", () => {
    const fallback = copy({ valueBasis: { readAs: "reading", source: "ebay_uk", priceKind: "active_median", viaUnknownCondition: true, viaUnknownRegion: true } });
    expect(quietAdvice([], [fallback], new Map(), new Map(), cfg(), NOW)).toEqual([]);
  });

  it("leaves a priced, exactly read copy alone", () => {
    const exact = copy({ valueBasis: { readAs: "reading", source: "ebay_uk", priceKind: "active_median", viaUnknownCondition: false, viaUnknownRegion: false } });
    expect(quietAdvice([], [exact, copy({ id: 10, status: "sold", valueFetchedAt: null })], new Map(), new Map(), cfg(), NOW)).toEqual([]);
  });
});
