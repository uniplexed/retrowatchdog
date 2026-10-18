import { describe, expect, it } from "vitest";
import type { Signal } from "@retrowatchdog/shared";
import { withinTarget } from "../../src/routes/watchlist.js";

const signal = (type: Signal["type"], usd: number, original: number, currency: string): Signal => ({
  type, reasoning: "r", price: { usd, original, currency },
});
const target = (original: number | null, currency: string | null, usd: number | null) => ({ original, currency, usd });

describe("withinTarget", () => {
  it("gates buy signals on the quoted amount when the currencies match", () => {
    // USD twins disagree with the originals on purpose: the quote decides
    expect(withinTarget(signal("UNDERPRICED", 99, 20, "GBP"), target(20, "GBP", 1))).toBe(true);
    expect(withinTarget(signal("FLIP", 1, 20.01, "GBP"), target(20, "GBP", 99))).toBe(false);
  });

  it("falls back to frozen USD across currencies, or for a USD-only target", () => {
    expect(withinTarget(signal("UNDERPRICED", 25, 20, "GBP"), target(24, "EUR", 26))).toBe(true);
    expect(withinTarget(signal("UNDERPRICED", 27, 20, "GBP"), target(24, "EUR", 26))).toBe(false);
    expect(withinTarget(signal("UNDERPRICED", 27, 20, "GBP"), target(null, null, 26))).toBe(false);
  });

  it("never gates without a target, or a signal that is not a price to pay", () => {
    expect(withinTarget(signal("UNDERPRICED", 500, 500, "GBP"), target(null, null, null))).toBe(true);
    expect(withinTarget(signal("OVERPRICED_STORE", 500, 500, "GBP"), target(1, "GBP", 1))).toBe(true);
    expect(withinTarget(signal("PROFIT", 500, 500, "GBP"), target(1, "GBP", 1))).toBe(true);
    expect(withinTarget({ type: "INSUFFICIENT_DATA", reasoning: "r" }, target(1, "GBP", 1))).toBe(true);
  });
});

describe("withinTarget and the new buy-type signals", () => {
  it.each(["PRICE_DROP", "NEW_LOW", "BACK_IN_STOCK"] as const)("gates %s by the watch's target like UNDERPRICED", (type) => {
    expect(withinTarget(signal(type, 60, 60, "GBP"), target(30, "GBP", 30))).toBe(false);
    expect(withinTarget(signal(type, 25, 25, "GBP"), target(30, "GBP", 30))).toBe(true);
  });

  it("lets a TARGET_HIT through, since it is at or under the target by construction", () => {
    expect(withinTarget(signal("TARGET_HIT", 30, 30, "GBP"), target(30, "GBP", 30))).toBe(true);
  });
});
