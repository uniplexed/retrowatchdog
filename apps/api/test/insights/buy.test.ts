import { describe, expect, it } from "vitest";
import type { WatchlistItemDto } from "@retrowatchdog/shared";
import { buyNow } from "../../src/insights/buy.js";
import { NOW, cfg, days, game, labels, seriesOf } from "./fixtures.js";

const watch = (over: Partial<WatchlistItemDto> = {}): WatchlistItemDto =>
  ({ id: 4, game: game(2, "Dr. Mario", "nes"), region: "PAL", condition: null, signals: [], ...over }) as WatchlistItemDto;
const gbp = (amount: number) => ({ amount, currency: "GBP" });

describe("buyNow", () => {
  it("recommends the 90-day low with a rising reference", () => {
    const s = seriesOf(2, {
      "PAL|loose": days(90, (ago) => ({
        cheapestUsd: ago === 0 ? 10 : 15,
        cheapestSource: "ebay_uk",
        cheapestOriginal: gbp(ago === 0 ? 8 : 12),
        referenceUsd: 20 + (90 - ago) * 0.1,
      })),
    });
    const [r] = buyNow([watch()], s, cfg(), labels, NOW);
    expect(r).toMatchObject({ action: "buy_now", confidence: "high", title: "Buy Dr. Mario on eBay UK for £8" });
    expect(r.reason).toBe("the lowest in 90 days");
    // the window's mean less today's price
    expect(r.gainUsd).toBeCloseTo((15 * 89 + 10) / 90 - 10, 1);
  });

  it("recommends a price far enough under the window's mean", () => {
    const s = seriesOf(2, {
      "PAL|loose": days(90, (ago) => ({
        cheapestUsd: ago === 0 ? 12 : ago % 2 === 0 ? 10 : 20,
        cheapestSource: "ebay_uk",
        cheapestOriginal: null,
        referenceUsd: 18,
      })),
    });
    const [r] = buyNow([watch()], s, cfg(), labels, NOW);
    expect(r?.reason).toMatch(/% under its 90-day average of \$15/);
  });

  it("potential when the reference is falling", () => {
    const s = seriesOf(2, {
      "PAL|loose": days(90, (ago) => ({ cheapestUsd: ago === 0 ? 10 : 15, cheapestSource: "ebay_uk", cheapestOriginal: gbp(8), referenceUsd: 10 + ago })),
    });
    const [r] = buyNow([watch()], s, cfg(), labels, NOW);
    expect(r).toMatchObject({ confidence: "potential" });
    expect(r.reason).toMatch(/falling — may get cheaper/);
  });

  it("needs at least 30 days of coverage for a 90-day low", () => {
    const s = seriesOf(2, {
      "PAL|loose": days(3, (ago) => ({ cheapestUsd: ago === 0 ? 10 : 15, cheapestSource: "ebay_uk", cheapestOriginal: gbp(8), referenceUsd: 20 })),
    });
    const [r] = buyNow([watch()], s, cfg(), labels, NOW);
    expect(r).toMatchObject({ confidence: "potential" });
    expect(r.reason).toMatch(/only 3 days of prices/);
  });

  it("a buyLowDays window under 30 days can still be high confidence", () => {
    const s = seriesOf(2, {
      "PAL|loose": days(14, (ago) => ({ cheapestUsd: ago === 0 ? 10 : 15, cheapestSource: "ebay_uk", cheapestOriginal: gbp(8), referenceUsd: 20 })),
    });
    const [r] = buyNow([watch()], s, cfg({ buyLowDays: 14 }), labels, NOW);
    expect(r).toMatchObject({ confidence: "high" });
  });

  it("skips a watch with no purchasable price", () => {
    const s = seriesOf(2, { "PAL|loose": days(90, () => ({ referenceUsd: 20 })) });
    expect(buyNow([watch()], s, cfg(), labels, NOW)).toEqual([]);
  });
});
