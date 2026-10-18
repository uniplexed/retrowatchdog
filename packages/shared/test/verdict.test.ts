import { describe, expect, it } from "vitest";
import {
  compareVerdicts,
  isHigh,
  verdictTitle,
  pickVerdict,
  SIGNAL_TYPES,
  VERDICT_AVOID_TITLE,
  type Signal,
} from "../src/index.js";

const gbp = (n: number) => ({ usd: n, original: n, currency: "GBP" });
const sig = (over: Partial<Signal> & Pick<Signal, "type">): Signal => ({
  reasoning: `${over.type} reasoning`,
  confidence: "high",
  ...over,
});
const label = (s: Signal) => `title for ${s.type}`;

describe("pickVerdict", () => {
  it("returns null when no signal is high", () => {
    const signals = [
      sig({ type: "UNDERPRICED", confidence: "potential", edgePct: 60 }),
      sig({ type: "FLIP", confidence: "potential", edgePct: 80 }),
    ];
    expect(pickVerdict(signals, label)).toBeNull();
  });

  it("ignores INSUFFICIENT_DATA entirely", () => {
    expect(pickVerdict([{ type: "INSUFFICIENT_DATA", reasoning: "no data" }], label)).toBeNull();
  });

  it("prefers a high TARGET_HIT over a larger-edge UNDERPRICED", () => {
    const verdict = pickVerdict(
      [sig({ type: "UNDERPRICED", edgePct: 60 }), sig({ type: "TARGET_HIT", edgePct: 5, price: gbp(20) })],
      label,
    );
    expect(verdict?.signal?.type).toBe("TARGET_HIT");
    expect(verdict?.tone).toBe("buy");
  });

  it("ranks positive signals by edgePct, ties going to the earlier one", () => {
    const under = sig({ type: "UNDERPRICED", edgePct: 30 });
    const flip = sig({ type: "FLIP", edgePct: 45 });
    expect(pickVerdict([under, flip], label)?.signal).toBe(flip);
    const first = sig({ type: "PRICE_DROP", edgePct: 20 });
    const second = sig({ type: "NEW_LOW", edgePct: 20 });
    expect(pickVerdict([first, second], label)?.signal).toBe(first);
  });

  it("treats a missing edgePct as zero", () => {
    const stock = sig({ type: "BACK_IN_STOCK" });
    const rising = sig({ type: "RISING", edgePct: 25 });
    expect(pickVerdict([stock, rising], label)?.signal).toBe(rising);
    expect(pickVerdict([stock], label)?.signal).toBe(stock);
  });

  it("falls back to OVERPRICED_STORE with the avoid tone when nothing positive is high", () => {
    const verdict = pickVerdict(
      [sig({ type: "OVERPRICED_STORE" }), sig({ type: "UNDERPRICED", confidence: "potential", edgePct: 70 })],
      label,
    );
    expect(verdict?.tone).toBe("avoid");
    expect(verdict?.title).toBe(VERDICT_AVOID_TITLE);
    expect(verdict?.reason).toBe("OVERPRICED_STORE reasoning");
  });

  it("titles a positive verdict with the caller's label and keeps the reasoning as the reason", () => {
    const verdict = pickVerdict([sig({ type: "UNDERPRICED", edgePct: 10 })], label);
    expect(verdict?.title).toBe("title for UNDERPRICED");
    expect(verdict?.reason).toBe("UNDERPRICED reasoning");
  });

  it("carries the listing url as the action, and edit-watch for a TARGET_HIT without one", () => {
    const withUrl = pickVerdict([sig({ type: "UNDERPRICED", url: "https://ebay.example/1" })], label);
    expect(withUrl?.action).toEqual({ label: "View listing →", url: "https://ebay.example/1" });
    const target = pickVerdict([sig({ type: "TARGET_HIT" })], label);
    expect(target?.action).toEqual({ label: "Edit watch", kind: "edit-watch" });
    const flip = pickVerdict([sig({ type: "FLIP" })], label);
    expect(flip?.action).toBeUndefined();
  });

  it("isHigh reads the confidence field", () => {
    expect(isHigh(sig({ type: "FLIP" }))).toBe(true);
    expect(isHigh(sig({ type: "FLIP", confidence: "potential" }))).toBe(false);
    expect(isHigh({ type: "INSUFFICIENT_DATA", reasoning: "" })).toBe(false);
  });

  it("lists every signal type, the five new ones included", () => {
    expect(SIGNAL_TYPES).toEqual([
      "UNDERPRICED", "OVERPRICED_STORE", "FLIP", "PROFIT", "INSUFFICIENT_DATA",
      "TARGET_HIT", "PRICE_DROP", "NEW_LOW", "BACK_IN_STOCK", "RISING",
    ]);
  });
});

describe("verdictTitle", () => {
  const labelOf = (id: string) => ({ cex: "CeX UK", ebay_uk: "eBay UK" })[id] ?? id;
  const money = (a: { original: number; currency: string }) => `${a.currency === "GBP" ? "£" : a.currency + " "}${a.original}`;
  const title = (s: Signal) => verdictTitle(s, labelOf, money);

  it("words each positive type with its source and quoted price", () => {
    expect(title(sig({ type: "UNDERPRICED", source: "cex", price: gbp(40) }))).toBe("Buy on CeX UK for £40");
    expect(title(sig({ type: "TARGET_HIT", source: "ebay_uk", price: gbp(18) }))).toBe("Target hit: £18 on eBay UK");
    expect(title(sig({ type: "FLIP", buySource: "ebay_uk", sellSource: "cex" }))).toBe("Flip: buy on eBay UK, sell to CeX UK");
    expect(title(sig({ type: "PROFIT", sellSource: "cex", price: gbp(62) }))).toBe("Sell to CeX UK for £62");
    expect(title(sig({ type: "PRICE_DROP", source: "cex", price: gbp(30) }))).toBe("Price drop on CeX UK: £30");
    expect(title(sig({ type: "NEW_LOW", source: "ebay_uk", price: gbp(25) }))).toBe("90-day low on eBay UK: £25");
    expect(title(sig({ type: "BACK_IN_STOCK", source: "cex", price: gbp(42) }))).toBe("Back in stock at CeX UK: £42");
    expect(title(sig({ type: "RISING" }))).toBe("Your copy is rising");
  });

  it("drops the parts a signal does not carry", () => {
    expect(title(sig({ type: "UNDERPRICED", source: "cex" }))).toBe("Buy on CeX UK");
    expect(title(sig({ type: "PRICE_DROP", source: "cex" }))).toBe("Price drop on CeX UK");
  });
});

describe("compareVerdicts", () => {
  it("target first, then edge, avoid last", () => {
    const v = (signal: Signal) => pickVerdict([signal], label)!;
    const avoid = v(sig({ type: "OVERPRICED_STORE", edgePct: 90 }));
    const small = v(sig({ type: "UNDERPRICED", edgePct: 10 }));
    const big = v(sig({ type: "FLIP", edgePct: 40 }));
    const noEdge = v(sig({ type: "PRICE_DROP" }));
    const target = v(sig({ type: "TARGET_HIT", edgePct: 1 }));
    const sorted = [avoid, small, noEdge, big, target].sort(compareVerdicts);
    expect(sorted.map((x) => x.signal.type)).toEqual(["TARGET_HIT", "FLIP", "UNDERPRICED", "PRICE_DROP", "OVERPRICED_STORE"]);
  });
});

describe("verdictTitle for a flip without its sources", () => {
  it("says flip, never an empty 'buy on , sell to'", () => {
    const fmt = (a: { original: number; currency: string }) => `${a.original} ${a.currency}`;
    expect(verdictTitle(sig({ type: "FLIP" }), (id) => id, fmt)).toBe("Flip opportunity");
    expect(verdictTitle(sig({ type: "FLIP", buySource: "cex", sellSource: "ebay_uk" }), (id) => id.toUpperCase(), fmt)).toBe(
      "Flip: buy on CEX, sell to EBAY_UK",
    );
  });
});
