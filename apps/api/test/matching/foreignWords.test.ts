import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDb } from "../helpers/testDb.js";
import { games, gameNames } from "../../src/db/schema.js";
import { cleanTitle } from "../../src/matching/cleanTitle.js";
import { foreignTitleWord } from "../../src/matching/foreignWords.js";
import { findGameCandidates } from "../../src/matching/matcher.js";
import { config } from "../../src/config.js";

const foreign = (listing: string, name: string) => foreignTitleWord(cleanTitle(listing), cleanTitle(name));

// Real listing titles, all of them once confirmed to the wrong game or rightly
// to their own, measured against every confirmed mapping on 2026-09-19.
describe("foreignTitleWord", () => {
  it.each([
    ["Mario Party 64 - Nintendo 64 N64 Japan", "Mario 64", "party"],
    ["Monster Hunter World 4 PS4", "Monster Hunter 4", "world"],
    ["Street Fighter II Animated Movie VHS", "Street Fighter II: Movie", "animated"],
    ["Super Mario Lego", "Super Mario Land", "lego"],
    ["The Legend of Zelda Skyward Sword", "The Legend of Zelda: Four Swords", "skyward"],
  ])("finds another title in %j against %j", (listing, name, word) => {
    expect(foreign(listing, name)).toBe(word);
  });

  it.each([
    ["Shenmue Ichishou Yokosuka", "Shenmue Isshou Yokosuka"], // a romanisation standing in its place
    ["Sim City 2000 The Ultimate City Simulation", "SimCity 2000: The Ultimate City Simulator"],
    ["Super Mario Land 2 6 Gold Coins GB", "Super Mario Land 2: 6 Golden Coins"],
    ["Chase HQ Secret Police", "Chase H.Q.: Secret Police"],
    ["Mega Man Dr Willy's Revenge", "Mega Man: Dr. Wily's Revenge"],
    ["Spiel Street Fighter II Modul", "Street Fighter II"], // seller junk at the edges
    ["Out Run 3-D", "OutRun 3-D"],
  ])("accepts %j as %j", (listing, name) => {
    expect(foreign(listing, name)).toBeNull();
  });
});

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}

describe.skipIf(ctx === null)("the matcher with a foreign title word", () => {
  beforeEach(async () => ctx!.truncateAll());
  afterAll(async () => ctx?.pool.end());

  it("no longer confirms Mario Party as Super Mario 64 through its alt name 'Mario 64'", async () => {
    const [sm64] = await ctx!.db.insert(games).values({ igdbId: 1074, title: "Super Mario 64", platform: "n64" }).returning({ id: games.id });
    await ctx!.db.insert(gameNames).values([
      { gameId: sm64.id, name: "Super Mario 64" },
      { gameId: sm64.id, name: "Mario 64" },
    ]);
    const [best] = await findGameCandidates(ctx!.db, cleanTitle("Mario Party 64 - Nintendo 64 N64 Japan"), "n64");
    expect(best.gameId).toBe(sm64.id);
    expect(best.score).toBeLessThan(config.MATCH_CONFIRM_THRESHOLD);
    const [own] = await findGameCandidates(ctx!.db, cleanTitle("Super Mario 64 N64 PAL cart"), "n64");
    expect(own.score).toBeGreaterThanOrEqual(config.MATCH_CONFIRM_THRESHOLD);
  });
});
