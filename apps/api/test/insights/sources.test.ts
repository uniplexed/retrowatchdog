import { describe, expect, it } from "vitest";
import type { ReliabilityRow } from "@retrowatchdog/shared";
import { preferSource } from "../../src/insights/sources.js";
import { reviewThresholds } from "../../src/insights/reliability.js";
import { cfg, days, game, labels } from "./fixtures.js";

/** n gba games; game i is cheapest on cheap(i) and best paid by bid(i) */
const games = (n: number, cheap: (i: number) => string, bid: (i: number) => string) =>
  Array.from({ length: n }, (_, i) => ({
    game: game(i + 1),
    readings: days(5, () => ({ cheapestUsd: 10, cheapestSource: cheap(i) as never, bestBidUsd: 8, bestBidSource: bid(i) as never })),
  }));

describe("preferSource", () => {
  it("one buy and one sell row per console when a source dominates", () => {
    const rows = preferSource(games(10, (i) => (i < 8 ? "ebay_uk" : "cex"), (i) => (i < 7 ? "cex" : "ebay_uk")), cfg(), labels);
    expect(rows.map((r) => r.title)).toEqual([
      "On GBA, eBay UK had the lowest price in 8 of 10 games",
      "On GBA, CeX UK paid the most in 7 of 10 games",
    ]);
    expect(rows[0]).toMatchObject({ action: "prefer_source", confidence: "high", gainUsd: null, subject: { kind: "console", platform: "gba" } });
  });

  it("nothing under minGamesPerConsole games", () => {
    expect(preferSource(games(4, () => "ebay_uk", () => "cex"), cfg(), labels)).toEqual([]);
  });

  it("nothing when no source reaches sourceDominancePct", () => {
    expect(preferSource(games(10, (i) => (i < 5 ? "ebay_uk" : "cex"), (i) => (i < 5 ? "cex" : "ebay_uk")), cfg(), labels)).toEqual([]);
  });
});

describe("reviewThresholds", () => {
  const row = (over: Partial<ReliabilityRow>): ReliabilityRow => ({
    type: "UNDERPRICED",
    source: null,
    logged: 12,
    evaluated: 10,
    held: 3,
    beaten: 7,
    unknown: 0,
    heldPct: 30,
    meanGainUsd: null,
    ...over,
  });

  it("review_thresholds for a type under reliabilityMinPct with 10 evaluated", () => {
    const rows = reviewThresholds([row({}), row({ source: "cex" }), row({ type: "PROFIT", heldPct: 60 }), row({ type: "FLIP", evaluated: 9, heldPct: null })], cfg());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "review_thresholds", confidence: "potential", gainUsd: null, subject: { kind: "signal_type", type: "UNDERPRICED" } });
    expect(rows[0].reason).toBe("Only 30% of 10 underpriced signals held their price; under 40%");
  });

  it("review_thresholds counts judged signals, not unknown ones", () => {
    expect(reviewThresholds([row({ evaluated: 14, held: 2, beaten: 7, unknown: 5, heldPct: 22.2 })], cfg())).toEqual([]);
  });
});
