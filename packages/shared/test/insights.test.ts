import { describe, expect, it } from "vitest";
import { compareRecommendations, RECOMMENDATION_DEFAULTS, type Recommendation } from "../src/index.js";

const game = { id: 1, title: "Shenmue", platform: "dreamcast", year: 1999, coverUrl: null } as const;
const rec = (over: Partial<Recommendation> & Pick<Recommendation, "action">): Recommendation => ({
  subject: { kind: "watch", watchId: 1, game },
  title: "t",
  reason: "r",
  gainUsd: null,
  confidence: "high",
  since: "2026-10-18",
  ...over,
});

describe("compareRecommendations", () => {
  it("money actions first, larger gain first, null gain last, then title", () => {
    const list = [
      rec({ action: "unwatch", title: "a" }),
      rec({ action: "buy_now", gainUsd: 3, title: "b" }),
      rec({ action: "sell_now", gainUsd: 2, title: "c" }),
      rec({ action: "sell_now", gainUsd: 9, title: "d" }),
      rec({ action: "sell_now", gainUsd: null, title: "e" }),
      rec({ action: "buy_now", gainUsd: 3, title: "a" }),
    ];
    expect(list.sort(compareRecommendations).map((r) => r.title)).toEqual(["d", "c", "e", "a", "b", "a"]);
  });

  it("defaults are the spec's values", () => {
    expect(RECOMMENDATION_DEFAULTS).toMatchObject({ sellHighDays: 90, quietDays: 120, evalDays: 14, historyDays: 90, sourceDominancePct: 60 });
  });
});
