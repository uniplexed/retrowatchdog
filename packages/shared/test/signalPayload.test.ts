import { describe, expect, it } from "vitest";
import type { Signal, SignalAmount } from "../src/index.js";

/**
 * The signal payload's money contract, tested where it is declared.
 *
 * This file's real gate is `tsc --noEmit`: a TypeScript type has no runtime
 * presence, so the assertions below pass whatever the type says and only the
 * typecheck can go red. Step 2 runs both, and the typecheck is the one that
 * proves the move.
 */
describe("SignalAmount", () => {
  it("is the frozen USD value beside the source's verbatim original", () => {
    const amount: SignalAmount = { usd: 56.25, original: 45, currency: "GBP" };
    expect(amount.usd).toBe(56.25);
    expect(amount.original).toBe(45);
    expect(amount.currency).toBe("GBP");
  });
});

describe("Signal.price", () => {
  it("is optional: a literal without it still satisfies the type", () => {
    // The point of optionality here, not an accident to tidy later: every
    // existing payload, fixture and test literal keeps compiling, and
    // INSUFFICIENT_DATA has no price by construction.
    const noPrice: Signal = {
      type: "INSUFFICIENT_DATA",
      reasoning: "PAL: not enough reference listings to compare against (need 5+ per group)",
    };
    expect(noPrice.price).toBeUndefined();
  });

  it("carries the amount the signal is about, in both spaces", () => {
    const signal: Signal = {
      type: "UNDERPRICED",
      reasoning: '"OOT cart only" at £19 vs eBay UK active median £30 (8 listings) — bargain candidate',
      source: "ebay_uk",
      price: { usd: 23.75, original: 19, currency: "GBP" },
    };
    expect(signal.price).toEqual({ usd: 23.75, original: 19, currency: "GBP" });
  });
});
