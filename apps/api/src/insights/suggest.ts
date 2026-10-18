import type { Platform, SuggestedThresholdsResponse } from "@retrowatchdog/shared";
import type { GameSeries } from "./series.js";

const MIN_COVERAGE_DAYS = 30;
const MIN_SLICES = 10;
const DAY_MS = 86_400_000;

/** nearest-rank percentile of a non-empty list */
const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.round(x)));

/**
 * Thresholds derived from this deployment's own prices (spec §2): the rhythm
 * of price changes and the spread of prices. Never applied, only offered.
 */
export function suggestThresholds(
  series: Map<number, GameSeries>,
  watchCount: number,
  platformsCount: Map<Platform, number>,
  coverageDays: number,
): SuggestedThresholdsResponse {
  if (coverageDays < MIN_COVERAGE_DAYS || watchCount < MIN_SLICES) {
    return { basis: null, values: {}, notes: { history: "not enough history yet" } };
  }
  const gaps: number[] = [];
  const spreads: number[] = [];
  for (const s of series.values()) {
    for (const readings of s.bySlice.values()) {
      const priced = readings.filter((r) => r.cheapestUsd !== null);
      let last: { day: string; usd: number } | null = null;
      for (const r of priced) {
        if (last !== null && r.cheapestUsd !== last.usd) {
          gaps.push((Date.parse(r.day) - Date.parse(last.day)) / DAY_MS);
          last = { day: r.day, usd: r.cheapestUsd! };
        }
        last ??= { day: r.day, usd: r.cheapestUsd! };
      }
      const prices = priced.map((r) => r.cheapestUsd!);
      const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
      if (prices.length > 1 && mean > 0) spreads.push(((pct(prices, 90) - pct(prices, 10)) / mean) * 50);
    }
  }
  const values: SuggestedThresholdsResponse["values"] = {};
  const notes: Record<string, string> = {};
  if (gaps.length > 0) {
    values.quietDays = clamp(pct(gaps, 90), 1, 365);
    notes.quietDays = "9 in 10 price changes come sooner than this";
  }
  if (spreads.length > 0) {
    values.buyBelowAvgPct = values.targetNearPct = clamp(pct(spreads, 50), 0, 100);
    notes.buyBelowAvgPct = notes.targetNearPct = "half the usual spread of a watched game's prices";
  }
  if (platformsCount.size > 0) {
    values.minGamesPerConsole = clamp(pct([...platformsCount.values()], 50), 1, 1000);
    notes.minGamesPerConsole = "the median number of games per console you have";
  }
  notes.sourceDominancePct = "a fixed share, not a market rhythm";
  return { basis: `From ${watchCount} watched slices over ${coverageDays} days of prices`, values, notes };
}
