import { afterEach, describe, expect, it } from "vitest";
import type { GameSummary } from "@retrowatchdog/shared";
import { forgetGame, loadRecent, rememberGame } from "../src/lib/recentGames.js";

const game = (id: number): GameSummary => ({ id, title: `Game ${id}`, platform: "snes", year: 1995, coverUrl: null });

afterEach(() => window.localStorage.clear());

describe("recentGames", () => {
  it("keeps 8, newest first, deduped", () => {
    for (let id = 1; id <= 10; id += 1) rememberGame(game(id), null);
    rememberGame(game(5), "Buy on eBay UK for £8.12");
    const recent = loadRecent();
    expect(recent.map((r) => r.game.id)).toEqual([5, 10, 9, 8, 7, 6, 4, 3]);
    expect(recent[0].verdictTitle).toBe("Buy on eBay UK for £8.12");
  });

  it("a visit without a verdict to record keeps the one it had", () => {
    rememberGame(game(1), "Buy on eBay UK for £8.12");
    rememberGame(game(2), null);
    rememberGame(game(1), undefined);
    expect(loadRecent().map((r) => [r.game.id, r.verdictTitle])).toEqual([
      [1, "Buy on eBay UK for £8.12"],
      [2, null],
    ]);
  });

  it("forgets a game that no longer exists", () => {
    rememberGame(game(1), null);
    rememberGame(game(2), null);
    forgetGame(1);
    expect(loadRecent().map((r) => r.game.id)).toEqual([2]);
  });

  it("drops malformed entries", () => {
    window.localStorage.setItem(
      "recentGames",
      JSON.stringify([{ game: { id: "x" } }, null, { game: game(2), verdictTitle: null, at: "2026-10-17" }]),
    );
    expect(loadRecent().map((r) => r.game.id)).toEqual([2]);
    window.localStorage.setItem("recentGames", "not json");
    expect(loadRecent()).toEqual([]);
  });
});
