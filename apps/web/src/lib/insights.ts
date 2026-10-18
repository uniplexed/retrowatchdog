import type { GameSummary, Recommendation, RecommendationAction } from "@retrowatchdog/shared";

export const MONEY_ACTIONS: readonly RecommendationAction[] = ["sell_now", "buy_now", "raise_target", "lower_target"];
export const CLEAN_UP_ACTIONS: readonly RecommendationAction[] = ["unwatch", "review_copy"];

export const ACTION_LABELS: Record<RecommendationAction, string> = {
  sell_now: "Sell now",
  buy_now: "Buy now",
  raise_target: "Raise target",
  lower_target: "Lower target",
  unwatch: "Stop watching",
  review_copy: "Check a copy",
  prefer_source: "Best source",
  review_thresholds: "Review thresholds",
};

export interface RecommendationGroups {
  money: { high: Recommendation[]; potential: Recommendation[] };
  cleanUp: Recommendation[];
  sources: Recommendation[];
  thresholds: Recommendation[];
}

/** One grouping for every screen, in the API's order; potential money actions apart so they never lead. */
export function groupRecommendations(recs: Recommendation[]): RecommendationGroups {
  const money = recs.filter((r) => MONEY_ACTIONS.includes(r.action));
  return {
    money: { high: money.filter((r) => r.confidence === "high"), potential: money.filter((r) => r.confidence !== "high") },
    cleanUp: recs.filter((r) => CLEAN_UP_ACTIONS.includes(r.action)),
    sources: recs.filter((r) => r.action === "prefer_source"),
    thresholds: recs.filter((r) => r.action === "review_thresholds"),
  };
}

export const subjectGame = (r: Recommendation): GameSummary | null =>
  r.subject.kind === "copy" || r.subject.kind === "watch" ? r.subject.game : null;

/** Percent change from the first point to the last, whole; null without two points or a positive start. */
export function sparkChange(points: ReadonlyArray<{ usd: number }>): number | null {
  if (points.length < 2 || points[0].usd <= 0) return null;
  return Math.round((points[points.length - 1].usd / points[0].usd - 1) * 100);
}
