import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb } from "../../helpers/testDb.js";
import { games, gameNames } from "../../../src/db/schema.js";
import type { IgdbClient, IgdbGame } from "../../../src/catalog/igdb.js";
import { resolveImportRows } from "../../../src/importers/pricecharting/index.js";
import type { PcRawItem } from "../../../src/importers/pricecharting/index.js";

let ctx: Awaited<ReturnType<typeof setupTestDb>> | null = null;
try {
  ctx = await setupTestDb();
} catch {
  ctx = null;
}

const unconfiguredIgdb = {
  isConfigured: () => false,
  searchGames: async () => [],
} as unknown as IgdbClient;

const rawItem = (overrides: Partial<PcRawItem> & Pick<PcRawItem, "offerId" | "title">): PcRawItem => ({
  consoleName: "PAL Sega Game Gear",
  includes: "Item only",
  valueUsd: null,
  pcGameId: null,
  ...overrides,
});

const resolve = (raw: PcRawItem[], igdb: IgdbClient = unconfiguredIgdb) =>
  resolveImportRows({ db: ctx!.db, igdb }, raw, { existingUrls: new Set() });

describe.skipIf(ctx === null)("resolveImportRows matching v2", () => {
  const seed = async (title: string, platform: string): Promise<number> => {
    const [g] = await ctx!.db.insert(games).values({ title, platform }).returning({ id: games.id });
    await ctx!.db.insert(gameNames).values({ gameId: g.id, name: title });
    return g.id;
  };

  beforeEach(async () => {
    await ctx!.truncateAll();
  });
  afterAll(async () => ctx?.pool.end());

  it("caps a 0.90 numeral-mismatched candidate below auto-match: Sonic the Hedgehog GG vs Sonic 2", async () => {
    // The real failure from the user's live import: the catalog only had the
    // sibling, and 0.90 sailed past the old 0.45 auto-match threshold.
    const sonic2Id = await seed("Sonic the Hedgehog 2", "game_gear");
    const [row] = await resolve([rawItem({ offerId: "o1", title: "Sonic the Hedgehog" })]);

    expect(row.matchStatus).toBe("review"); // NEVER auto-imported
    expect(row.game?.id).toBe(sonic2Id); // still offered as the top candidate
    // capped at PC_IMPORT_MATCH_THRESHOLD - 0.01 despite a ~0.90 raw score
    expect(row.matchScore).toBe(0.44);
    expect(row.candidates).toHaveLength(1);
    expect(row.candidates[0]).toEqual({
      game: expect.objectContaining({ id: sonic2Id }),
      score: 0.44,
      numeralMismatch: true,
    });
  });

  it("keeps an exact same-numeral hit 'matched' and never calls IGDB for it", async () => {
    const id = await seed("Sonic the Hedgehog 2", "game_gear");
    const searchGames = vi.fn(async (): Promise<IgdbGame[]> => []);
    const igdb = { isConfigured: () => true, searchGames } as unknown as IgdbClient;

    const [row] = await resolve([rawItem({ offerId: "o1", title: "Sonic the Hedgehog 2" })], igdb);
    expect(row.matchStatus).toBe("matched");
    expect(row.game?.id).toBe(id);
    expect(row.matchScore).toBe(1);
    // matched rows carry just their single winner
    expect(row.candidates).toEqual([
      { game: expect.objectContaining({ id }), score: 1, numeralMismatch: false },
    ]);
    expect(searchGames).not.toHaveBeenCalled();
  });

  it("enriches from IGDB when the best local hit is non-exact (0.72-band bug), once per title", async () => {
    // Old behavior only enriched below 0.45: a wrong sibling at ~0.7 blocked
    // enrichment and kept the real title out of the catalog for good.
    await seed("Sonic the Hedgehog Chaos", "game_gear"); // ~0.7 vs the query, non-exact
    const searchGames = vi.fn(async (): Promise<IgdbGame[]> => [
      // 35 = IGDB's Game Gear platform id; importFromIgdb upserts the real game
      { id: 90210, name: "Sonic the Hedgehog", platforms: [35] },
    ]);
    const igdb = { isConfigured: () => true, searchGames } as unknown as IgdbClient;

    const rows = await resolve(
      [
        rawItem({ offerId: "o1", title: "Sonic the Hedgehog" }),
        // same title again: enrichment must run once per distinct title
        rawItem({ offerId: "o2", title: "Sonic the Hedgehog" }),
      ],
      igdb,
    );
    expect(searchGames).toHaveBeenCalledTimes(1);
    expect(searchGames).toHaveBeenCalledWith("sonic the hedgehog");
    // after enrichment the exact title exists locally and both rows auto-match
    for (const row of rows) {
      expect(row.matchStatus).toBe("matched");
      expect(row.game?.title).toBe("Sonic the Hedgehog");
      expect(row.matchScore).toBe(1);
    }
  });

  it("returns top-5 candidates ordered by effective score, rounded to 3 decimals", async () => {
    // six same-platform candidates; the numeral-mismatched sibling has the
    // HIGHEST raw score (~0.90) but the cap ranks it below every non-capped
    // candidate scoring above 0.44 — here that pushes it out of the top 5
    await seed("Sonic the Hedgehog 2", "game_gear");
    await seed("Sonic the Hedgehog Chaos", "game_gear");
    await seed("Sonic the Hedgehog Blast", "game_gear");
    await seed("Sonic the Hedgehog Genesis", "game_gear");
    await seed("Sonic the Hedgehog Spinball", "game_gear");
    await seed("Sonic the Hedgehog Triple Trouble", "game_gear");
    // wrong platform must never appear as a candidate
    await seed("Sonic the Hedgehog Pocket", "gb");

    const [row] = await resolve([rawItem({ offerId: "o1", title: "Sonic the Hedgehog" })]);
    expect(row.matchStatus).toBe("review");
    expect(row.candidates).toHaveLength(5);
    const scores = row.candidates.map((c) => c.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores); // descending
    for (const c of row.candidates) {
      expect(c.score).toBe(Math.round(c.score * 1000) / 1000); // 3-decimal rounding
      expect(c.game.platform).toBe("game_gear");
      expect(c.score).toBeGreaterThan(0.44); // all five outrank the capped sibling
      expect(c.numeralMismatch).toBe(false);
    }
    expect(row.candidates.some((c) => c.game.title === "Sonic the Hedgehog 2")).toBe(false);
    // game/matchScore keep pointing at the top candidate
    expect(row.game?.title).toBe(row.candidates[0].game.title);
    expect(row.matchScore).toBe(row.candidates[0].score);
  });

  it("flags numeral-mismatched candidates inside a mixed candidate list", async () => {
    await seed("Sonic the Hedgehog 2", "game_gear"); // raw ~0.90 -> capped 0.44
    await seed("Sonic the Hedgehog Triple Trouble", "game_gear"); // ~0.56, no numerals

    const [row] = await resolve([rawItem({ offerId: "o1", title: "Sonic the Hedgehog" })]);
    expect(row.matchStatus).toBe("review");
    expect(row.candidates.map((c) => c.numeralMismatch)).toEqual([false, true]);
    expect(row.candidates[0].game.title).toBe("Sonic the Hedgehog Triple Trouble");
    expect(row.candidates[1].score).toBe(0.44); // demoted below despite higher raw score
  });

  it("classifies rows with no candidate above the review floor as unmatched with empty candidates", async () => {
    await seed("Columns", "game_gear"); // nothing trigram-close to the query
    const [row] = await resolve([rawItem({ offerId: "o1", title: "Sonic the Hedgehog" })]);
    expect(row.matchStatus).toBe("unmatched");
    expect(row.game).toBeNull();
    expect(row.matchScore).toBeNull();
    expect(row.candidates).toEqual([]);
  });
});
