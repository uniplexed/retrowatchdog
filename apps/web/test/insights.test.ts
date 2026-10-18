import { describe, expect, it } from "vitest";
import type { Recommendation } from "@retrowatchdog/shared";
import { groupRecommendations, sparkChange, subjectGame } from "../src/lib/insights.js";

const game = { id: 1, title: "Shenmue", platform: "dreamcast" as const, year: 2000, coverUrl: null };
const rec = (action: Recommendation["action"], over: Partial<Recommendation> = {}): Recommendation => ({
  action,
  subject: { kind: "watch", watchId: 1, game },
  title: `${action} title`,
  reason: "reason",
  gainUsd: null,
  confidence: "high",
  since: "2026-10-18",
  ...over,
});

describe("groupRecommendations", () => {
  it("groups money by confidence and keeps the API order", () => {
    const g = groupRecommendations([rec("sell_now", { title: "a" }), rec("buy_now", { title: "b", confidence: "potential" }), rec("buy_now", { title: "c" })]);
    expect(g.money.high.map((r) => r.title)).toEqual(["a", "c"]);
    expect(g.money.potential.map((r) => r.title)).toEqual(["b"]);
  });

  it("clean-ups, sources and thresholds go to their own groups", () => {
    const g = groupRecommendations([
      rec("unwatch"),
      rec("review_copy"),
      rec("prefer_source", { subject: { kind: "console", platform: "gba" } }),
      rec("review_thresholds", { subject: { kind: "signal_type", type: "UNDERPRICED" } }),
    ]);
    expect(g.cleanUp.map((r) => r.action)).toEqual(["unwatch", "review_copy"]);
    expect(g.sources).toHaveLength(1);
    expect(g.thresholds).toHaveLength(1);
    expect(g.money.high).toEqual([]);
  });

  it("subjectGame is the game of a copy or watch, null otherwise", () => {
    expect(subjectGame(rec("sell_now"))).toEqual(game);
    expect(subjectGame(rec("prefer_source", { subject: { kind: "console", platform: "gba" } }))).toBeNull();
  });
});

describe("sparkChange", () => {
  it("sparkChange is null under two points", () => {
    expect(sparkChange([])).toBeNull();
    expect(sparkChange([{ usd: 10 }])).toBeNull();
    expect(sparkChange([{ usd: 0 }, { usd: 5 }])).toBeNull();
  });

  it("sparkChange rounds first to last", () => {
    expect(sparkChange([{ usd: 10 }, { usd: 11 }, { usd: 12.5 }])).toBe(25);
    expect(sparkChange([{ usd: 12 }, { usd: 11 }])).toBe(-8);
  });
});
