import { describe, expect, it } from "vitest";
import type { GameSeries } from "../../src/insights/series.js";
import { suggestThresholds } from "../../src/insights/suggest.js";
import { days } from "./fixtures.js";

/** n games, one slice each, 60 days; the price steps every `step` days */
const series = (n: number, step: number): Map<number, GameSeries> =>
  new Map(
    Array.from({ length: n }, (_, i) => [
      i + 1,
      { gameId: i + 1, bySlice: new Map([["PAL|loose", days(60, (ago) => ({ cheapestUsd: 40 + Math.floor(ago / step) % 2 * 4 }))]]) } as GameSeries,
    ]),
  );

describe("suggestThresholds", () => {
  it("suggests quietDays from the p90 gap between price changes", () => {
    const r = suggestThresholds(series(10, 10), 10, new Map([["gba", 3], ["snes", 7], ["nes", 5]]), 60);
    expect(r.values.quietDays).toBe(10);
    expect(r.values.minGamesPerConsole).toBe(5);
    expect(r.values.buyBelowAvgPct).toBeGreaterThan(0);
    expect(r.values.targetNearPct).toBe(r.values.buyBelowAvgPct);
    expect(r.basis).toBe("From 10 watched slices over 60 days of prices");
    expect(r.notes.sourceDominancePct).toBe("a fixed share, not a market rhythm");
  });

  it("says not enough history under 30 days", () => {
    expect(suggestThresholds(series(10, 10), 10, new Map(), 20)).toEqual({ basis: null, values: {}, notes: { history: "not enough history yet" } });
    expect(suggestThresholds(series(9, 10), 9, new Map(), 60).basis).toBeNull();
  });
});
