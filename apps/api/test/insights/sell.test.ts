import { describe, expect, it } from "vitest";
import type { OwnedCopyDto } from "@retrowatchdog/shared";
import { sellNow } from "../../src/insights/sell.js";
import { NOW, cfg, days, game, labels, seriesOf } from "./fixtures.js";

const copy = (over: Partial<OwnedCopyDto> = {}): OwnedCopyDto =>
  ({
    id: 9,
    game: game(1, "Shenmue", "dreamcast"),
    region: "PAL",
    condition: "cib",
    status: "owned",
    acquiredPriceUsd: 23,
    acquiredPriceOriginal: 18,
    acquiredCurrency: "GBP",
    ...over,
  }) as OwnedCopyDto;
const gbp = (amount: number) => ({ amount, currency: "GBP" });

describe("sellNow", () => {
  it("recommends when the bid is the 90-day high and covers paid × profitFactor", () => {
    const s = seriesOf(1, {
      "PAL|cib": days(90, (ago) => ({ bestBidUsd: ago === 0 ? 48 : 30, bestBidSource: "cex", bestBidOriginal: gbp(ago === 0 ? 38 : 24) })),
    });
    const [r] = sellNow([copy()], s, cfg(), labels, NOW);
    expect(r).toMatchObject({ action: "sell_now", confidence: "high", gainUsd: 25, title: "Sell Shenmue to CeX UK for £38" });
    expect(r.reason).toBe("CeX UK pays £38, the most in 90 days; you paid £18");
    expect(r.subject).toEqual({ kind: "copy", copyId: 9, game: copy().game });
  });

  it("recommends when the market rose and is now falling", () => {
    const s = seriesOf(1, {
      "PAL|cib": days(90, (ago) => ({
        bestBidUsd: 40,
        bestBidSource: "cex",
        bestBidOriginal: gbp(32),
        // flat at 50, a rise to 80 a month ago, falling since
        referenceUsd: ago > 40 ? 50 : ago > 25 ? 80 : 80 - (25 - ago) * 1.2,
      })),
    });
    const [r] = sellNow([copy({ acquiredPriceUsd: 20 })], s, cfg(), labels, NOW);
    expect(r?.reason).toMatch(/rose and has been falling/);
  });

  it("nothing when the bid is under paid × profitFactor", () => {
    const s = seriesOf(1, {
      "PAL|cib": days(90, (ago) => ({ bestBidUsd: ago === 0 ? 24 : 20, bestBidSource: "cex", bestBidOriginal: gbp(19) })),
    });
    expect(sellNow([copy()], s, cfg(), labels, NOW)).toEqual([]);
  });

  it("compares in USD when the bid and the paid price differ in currency", () => {
    const s = seriesOf(1, {
      "PAL|cib": days(90, (ago) => ({ bestBidUsd: ago === 0 ? 40 : 30, bestBidSource: "cex", bestBidOriginal: gbp(ago === 0 ? 31 : 24) })),
    });
    const [r] = sellNow([copy({ acquiredPriceUsd: 33, acquiredPriceOriginal: 30, acquiredCurrency: "EUR" })], s, cfg(), labels, NOW);
    expect(r).toMatchObject({ gainUsd: 7 });
    expect(r.reason).toBe("CeX UK pays $40, the most in 90 days; you paid $33");
  });

  it("potential on a fallback rung", () => {
    const s = seriesOf(1, {
      "PAL|loose": days(90, (ago) => ({ bestBidUsd: ago === 0 ? 48 : 30, bestBidSource: "cex", bestBidOriginal: gbp(ago === 0 ? 38 : 24) })),
    });
    const [r] = sellNow([copy()], s, cfg(), labels, NOW);
    expect(r?.confidence).toBe("potential");
  });

  it("an exact-slice bid older than the window does not block the fallback", () => {
    const s = seriesOf(1, {
      "PAL|cib": days(150, (ago) => (ago === 149 ? { bestBidUsd: 30, bestBidSource: "cex", bestBidOriginal: gbp(24) } : {})),
      "PAL|loose": days(90, (ago) => ({ bestBidUsd: ago === 0 ? 48 : 30, bestBidSource: "cex", bestBidOriginal: gbp(ago === 0 ? 38 : 24) })),
    });
    expect(sellNow([copy()], s, cfg(), labels, NOW)[0]?.confidence).toBe("potential");
  });

  it("a higher bid quoted in another currency earlier in the window means today is not the high", () => {
    const s = seriesOf(1, {
      "PAL|cib": days(90, (ago) =>
        ago === 30
          ? { bestBidUsd: 60, bestBidSource: "cex_ie", bestBidOriginal: { amount: 55, currency: "EUR" } }
          : { bestBidUsd: ago === 0 ? 48 : 30, bestBidSource: "cex", bestBidOriginal: gbp(ago === 0 ? 38 : 24) },
      ),
    });
    expect(sellNow([copy()], s, cfg(), labels, NOW)).toEqual([]);
  });

  it("skips sold copies and copies with no paid price", () => {
    const s = seriesOf(1, {
      "PAL|cib": days(90, (ago) => ({ bestBidUsd: ago === 0 ? 48 : 30, bestBidSource: "cex", bestBidOriginal: gbp(38) })),
    });
    expect(sellNow([copy({ status: "sold" }), copy({ id: 10, acquiredPriceUsd: null })], s, cfg(), labels, NOW)).toEqual([]);
  });
});
